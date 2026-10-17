'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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

const post = (tenantId, key, body) => h.call(server.baseUrl, 'POST', '/generate', { tenantId, key, body });

test('PROBE 1: same Idempotency-Key twice -> exactly one usage event, identical response', async () => {
  const tenantId = await h.createTenant('free');
  const first = await post(tenantId, 'k-1', { type: 'api_call' });
  const second = await post(tenantId, 'k-1', { type: 'api_call' });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.deepEqual(second.body, first.body); // the replay mirrors the original, same id included
  assert.equal(await h.countEvents(tenantId), 1);
});

test('same key + different body -> 409 and nothing is recorded', async () => {
  const tenantId = await h.createTenant('free');
  await post(tenantId, 'k-1', { type: 'api_call' });
  const clash = await post(tenantId, 'k-1', { type: 'ai_tokens', tokens: { input: 10 } });

  assert.equal(clash.status, 409);
  assert.equal(clash.body.error, 'idempotency_conflict');
  assert.equal(await h.countEvents(tenantId), 1);
});

test('same key is independent across tenants', async () => {
  const a = await h.createTenant('free');
  const b = await h.createTenant('free');
  assert.equal((await post(a, 'shared-key', { type: 'api_call' })).status, 201);
  assert.equal((await post(b, 'shared-key', { type: 'api_call' })).status, 201);
  assert.equal(await h.countEvents(a), 1);
  assert.equal(await h.countEvents(b), 1);
});

test('PROBE 2 (api_call): 1000th call is allowed, 1001st is 429', async () => {
  const tenantId = await h.createTenant('free'); // limit 1000
  await h.seedUsage(tenantId, 'api_call', 999, 1, 500);

  const atLimit = await post(tenantId, 'k-1000', { type: 'api_call' });
  assert.equal(atLimit.status, 201);
  assert.deepEqual(atLimit.body.usage_after, { used: 1000, limit: 1000 });

  const over = await post(tenantId, 'k-1001', { type: 'api_call' });
  assert.equal(over.status, 429);
  assert.equal(over.body.error, 'quota_exceeded');
  assert.match(over.body.message, /1000\/1000/);
  assert.equal(await h.countEvents(tenantId), 1000); // the rejected call left no event
});

test('PROBE 2 (ai_tokens): exactly 100000 allowed, 100001 rejected', async () => {
  const tenantId = await h.createTenant('free'); // limit 100000
  await h.seedUsage(tenantId, 'ai_tokens', 1, 99_999);

  assert.equal((await post(tenantId, 'k-a', { type: 'ai_tokens', tokens: { input: 1 } })).status, 201);
  const over = await post(tenantId, 'k-b', { type: 'ai_tokens', tokens: { input: 1 } });
  assert.equal(over.status, 429);
});

test('a rejected request is cached: retrying its key replays the 429', async () => {
  const tenantId = await h.createTenant('free');
  await h.seedUsage(tenantId, 'api_call', 1000, 1, 500);

  const first = await post(tenantId, 'k-x', { type: 'api_call' });
  const retry = await post(tenantId, 'k-x', { type: 'api_call' });
  assert.equal(first.status, 429);
  assert.equal(retry.status, 429);
  assert.deepEqual(retry.body, first.body);
});

test('budget cap returns 402 even though the token quota still has room', async () => {
  const tenantId = await h.createTenant('pro'); // 5,000,000 tokens, $50 cap
  const res = await post(tenantId, 'k-big', { type: 'ai_tokens', tokens: { output: 3_400_000 } });
  assert.equal(res.status, 402);
  assert.equal(res.body.error, 'budget_exceeded');
  assert.equal(await h.countEvents(tenantId), 0);
});

test('non-active subscription -> 402 plan_inactive', async () => {
  const tenantId = await h.createTenant('free');
  await h.pool.query("UPDATE subscriptions SET status = 'past_due' WHERE tenant_id = $1", [tenantId]);
  const res = await post(tenantId, 'k-1', { type: 'api_call' });
  assert.equal(res.status, 402);
  assert.equal(res.body.error, 'plan_inactive');
});

test('bad input is a clean 4xx, never a 500', async () => {
  const tenantId = await h.createTenant('free');

  const noKey = await post(tenantId, undefined, { type: 'api_call' });
  assert.equal(noKey.status, 400);

  const badType = await post(tenantId, 'k-1', { type: 'nope' });
  assert.equal(badType.status, 400);

  const negative = await post(tenantId, 'k-2', { type: 'ai_tokens', tokens: { input: -5 } });
  assert.equal(negative.status, 400);

  const allZero = await post(tenantId, 'k-3', { type: 'ai_tokens', tokens: { input: 0 } });
  assert.equal(allZero.status, 400);

  const noTenant = await post(undefined, 'k-4', { type: 'api_call' });
  assert.equal(noTenant.status, 400);

  const badUuid = await post('not-a-uuid', 'k-5', { type: 'api_call' });
  assert.equal(badUuid.status, 400);

  const unknown = await post('00000000-0000-0000-0000-000000000000', 'k-6', { type: 'api_call' });
  assert.equal(unknown.status, 404);

  assert.equal(await h.countEvents(tenantId), 0);
});