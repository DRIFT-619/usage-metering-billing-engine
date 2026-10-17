'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers/testEnv');
const { runJob } = require('../src/jobs/runJob');
const { rolloverFreePeriods } = require('../src/jobs/rolloverPeriods');

test.before(h.setupDatabase);
test.after(() => h.pool.end());
test.beforeEach(h.resetData);

const noSleep = async () => {};

test('runJob: succeeds on the first try without alerting', async () => {
  const out = await runJob('ok-job', async () => 42, { sleep: noSleep });
  assert.deepEqual(out, { ok: true, attempts: 1, result: 42 });
  const failures = await h.pool.query('SELECT COUNT(*)::int AS n FROM job_failures');
  assert.equal(failures.rows[0].n, 0);
});

test('runJob: retries with exponential backoff, then succeeds', async () => {
  let calls = 0;
  const delays = [];
  const out = await runJob(
    'flaky-job',
    async () => {
      calls += 1;
      if (calls < 3) throw new Error('boom');
      return 'finally';
    },
    { baseDelayMs: 100, sleep: async (ms) => delays.push(ms) }
  );
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 3);
  assert.deepEqual(delays, [100, 200]); // 100ms, then doubled
  const failures = await h.pool.query('SELECT COUNT(*)::int AS n FROM job_failures');
  assert.equal(failures.rows[0].n, 0); // recovered -> no alert
});

test('runJob: after exhausting retries it raises an alert row and does NOT throw', async () => {
  const out = await runJob(
    'doomed-job',
    async () => {
      throw new Error('always broken');
    },
    { maxAttempts: 3, sleep: noSleep }
  );
  assert.deepEqual(out, { ok: false, attempts: 3 });
  const failures = await h.pool.query('SELECT job_name, attempts, error FROM job_failures');
  assert.equal(failures.rows.length, 1);
  assert.equal(failures.rows[0].job_name, 'doomed-job');
  assert.equal(failures.rows[0].attempts, 3);
  assert.match(failures.rows[0].error, /always broken/);
});

test('rollover: an expired Free period is advanced to the current month', async () => {
  const tenantId = await h.createTenant('free');
  await h.pool.query(
    `UPDATE subscriptions
        SET current_period_start = now() - interval '70 days',
            current_period_end   = now() - interval '40 days'
      WHERE tenant_id = $1`,
    [tenantId]
  );

  assert.equal(await rolloverFreePeriods(), 1);

  const sub = (
    await h.pool.query(
      `SELECT current_period_start <= now() AS started, current_period_end > now() AS not_ended
         FROM subscriptions WHERE tenant_id = $1`,
      [tenantId]
    )
  ).rows[0];
  assert.deepEqual(sub, { started: true, not_ended: true });
});

test('rollover: is idempotent — a second run changes nothing', async () => {
  const tenantId = await h.createTenant('free');
  await h.pool.query(
    "UPDATE subscriptions SET current_period_end = now() - interval '1 day' WHERE tenant_id = $1",
    [tenantId]
  );
  assert.equal(await rolloverFreePeriods(), 1);
  assert.equal(await rolloverFreePeriods(), 0);
});

test('rollover: Stripe-managed subscriptions are left to the webhook', async () => {
  const tenantId = await h.createTenant('pro', { stripeSubscriptionId: 'sub_test_1' });
  await h.pool.query(
    "UPDATE subscriptions SET current_period_end = now() - interval '1 day' WHERE tenant_id = $1",
    [tenantId]
  );
  assert.equal(await rolloverFreePeriods(), 0);
});

test('rollover: a still-valid period is not touched', async () => {
  await h.createTenant('free'); // default period = this calendar month
  assert.equal(await rolloverFreePeriods(), 0);
});

test('rollover: a Free tenant that cancelled Pro (stripe_subscription_id still set) still rolls over', async () => {
  // After subscription.deleted the row is back on the free plan but keeps the old
  // stripe_subscription_id and the cancelled subscription's period. Nothing from
  // Stripe will ever renew it, so the job must.
  const tenantId = await h.createTenant('free', { stripeSubscriptionId: 'sub_cancelled_1' });
  await h.pool.query(
    "UPDATE subscriptions SET current_period_end = now() - interval '1 day' WHERE tenant_id = $1",
    [tenantId]
  );
  assert.equal(await rolloverFreePeriods(), 1);
});