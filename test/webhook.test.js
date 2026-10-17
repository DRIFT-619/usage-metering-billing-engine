'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const h = require('./helpers/testEnv');

let server;
test.before(async () => {
  await h.setupDatabase();
  server = await h.startServer();
});
test.after(async () => {
  await server.close();
  await h.pool.end();
});
test.beforeEach(h.resetData);

const stripe = new Stripe('sk_test_dummy_for_unit_tests');
const SECRET = process.env.STRIPE_WEBHOOK_SECRET;

/** Builds a signed customer.subscription.* event exactly the way Stripe would sign it. */
function signedEvent({ id, type, subscriptionId, status = 'active', priceId = 'price_test_pro' }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    id,
    object: 'event',
    type,
    data: {
      object: {
        id: subscriptionId,
        object: 'subscription',
        customer: 'cus_test_1',
        status,
        current_period_start: now,
        current_period_end: now + 30 * 24 * 3600,
        items: { data: [{ price: { id: priceId } }] },
      },
    },
  });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return { payload, header };
}

const send = ({ payload, header }) =>
  h.call(server.baseUrl, 'POST', '/webhooks/stripe', { raw: payload, headers: { 'stripe-signature': header } });

const planOf = async (tenantId) =>
  (await h.pool.query('SELECT plan_id, status FROM subscriptions WHERE tenant_id = $1', [tenantId])).rows[0];

test('PROBE 4: forged signature -> 400 and nothing changes', async () => {
  const tenantId = await h.createTenant('free', { stripeSubscriptionId: 'sub_test_1' });
  const { payload } = signedEvent({ id: 'evt_forged', type: 'customer.subscription.updated', subscriptionId: 'sub_test_1' });

  const res = await h.call(server.baseUrl, 'POST', '/webhooks/stripe', {
    raw: payload,
    headers: { 'stripe-signature': 't=1,v1=bogus' },
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_signature');
  assert.deepEqual(await planOf(tenantId), { plan_id: 'free', status: 'active' });
  const stored = await h.pool.query('SELECT COUNT(*)::int AS n FROM stripe_events');
  assert.equal(stored.rows[0].n, 0);
});

test('a missing signature header is also a 400', async () => {
  const res = await h.call(server.baseUrl, 'POST', '/webhooks/stripe', { raw: '{"fake":"event"}' });
  assert.equal(res.status, 400);
});

test('a valid signature on a TAMPERED body is rejected', async () => {
  await h.createTenant('free', { stripeSubscriptionId: 'sub_test_1' });
  const ev = signedEvent({ id: 'evt_t', type: 'customer.subscription.updated', subscriptionId: 'sub_test_1' });
  const res = await send({ payload: ev.payload.replace('active', 'canceled'), header: ev.header });
  assert.equal(res.status, 400);
});

test('PROBE 3/4: a verified event flips Free -> Pro, and replaying it is processed once', async () => {
  const tenantId = await h.createTenant('free', { stripeSubscriptionId: 'sub_test_1' });
  const ev = signedEvent({ id: 'evt_up_1', type: 'customer.subscription.updated', subscriptionId: 'sub_test_1' });

  const first = await send(ev);
  assert.equal(first.status, 200);
  assert.equal(first.body.processed, true);
  assert.deepEqual(await planOf(tenantId), { plan_id: 'pro', status: 'active' });

  const usage = await h.call(server.baseUrl, 'GET', '/usage', { tenantId });
  assert.equal(usage.body.plan, 'pro');
  assert.equal(usage.body.api_calls.limit, 50000);

  const replay = await send(ev);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.processed, false);
  const stored = await h.pool.query('SELECT COUNT(*)::int AS n FROM stripe_events WHERE stripe_event_id = $1', ['evt_up_1']);
  assert.equal(stored.rows[0].n, 1);
});

test('two SIMULTANEOUS deliveries of the same event -> both 200, processed exactly once', async () => {
  await h.createTenant('free', { stripeSubscriptionId: 'sub_test_1' });
  const ev = signedEvent({ id: 'evt_race', type: 'customer.subscription.updated', subscriptionId: 'sub_test_1' });

  const results = await Promise.all([send(ev), send(ev), send(ev), send(ev)]);

  assert.ok(results.every((r) => r.status === 200)); // never a 500 from a unique-violation
  assert.equal(results.filter((r) => r.body.processed === true).length, 1);
  const stored = await h.pool.query('SELECT COUNT(*)::int AS n FROM stripe_events WHERE stripe_event_id = $1', ['evt_race']);
  assert.equal(stored.rows[0].n, 1);
});

test('subscription.deleted falls back to a working Free plan', async () => {
  const tenantId = await h.createTenant('pro', { stripeSubscriptionId: 'sub_test_1' });
  const ev = signedEvent({ id: 'evt_del', type: 'customer.subscription.deleted', subscriptionId: 'sub_test_1', status: 'canceled' });

  const res = await send(ev);
  assert.equal(res.status, 200);
  assert.deepEqual(await planOf(tenantId), { plan_id: 'free', status: 'active' });

  const gen = await h.call(server.baseUrl, 'POST', '/generate', { tenantId, key: 'after-cancel', body: { type: 'api_call' } });
  assert.equal(gen.status, 201);
});

test('past_due from Stripe blocks /generate with 402', async () => {
  const tenantId = await h.createTenant('pro', { stripeSubscriptionId: 'sub_test_1' });
  await send(signedEvent({ id: 'evt_pd', type: 'customer.subscription.updated', subscriptionId: 'sub_test_1', status: 'past_due' }));

  const gen = await h.call(server.baseUrl, 'POST', '/generate', { tenantId, key: 'k', body: { type: 'api_call' } });
  assert.equal(gen.status, 402);
  assert.equal(gen.body.error, 'plan_inactive');
});

test('an event for an unknown subscription is acknowledged without touching anyone', async () => {
  const tenantId = await h.createTenant('free');
  const res = await send(signedEvent({ id: 'evt_x', type: 'customer.subscription.updated', subscriptionId: 'sub_unknown' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await planOf(tenantId), { plan_id: 'free', status: 'active' });
});