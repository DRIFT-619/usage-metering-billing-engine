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

test('PROBE 5: GET /usage matches the pinned pricing constants exactly', async () => {
  const tenantId = await h.createTenant('free');
  const gen = (key, body) => h.call(server.baseUrl, 'POST', '/generate', { tenantId, key, body });

  const tokens = await gen('t1', { type: 'ai_tokens', tokens: { input: 1000, cached_input: 500, output: 200, reasoning: 100 } });
  assert.equal(tokens.status, 201);
  assert.equal(tokens.body.cost_micros, 7650);
  await gen('c1', { type: 'api_call' });

  const usage = await h.call(server.baseUrl, 'GET', '/usage', { tenantId });
  assert.equal(usage.status, 200);
  assert.equal(usage.body.plan, 'free');
  assert.deepEqual(usage.body.api_calls, { used: 1, limit: 1000 });
  assert.deepEqual(usage.body.ai_tokens, { used: 1800, limit: 100000 });
  assert.equal(usage.body.cost.ai_tokens_micros, 7650);
  assert.equal(usage.body.cost.api_calls_micros, 500);
  assert.equal(usage.body.cost.total_micros, 8150);
  assert.equal(usage.body.cost.total_usd, '0.008150');
});

test('a rejected request leaves no trace in /usage', async () => {
  const tenantId = await h.createTenant('free');
  await h.seedUsage(tenantId, 'api_call', 1000, 1, 500);
  const before = await h.call(server.baseUrl, 'GET', '/usage', { tenantId });

  const rejected = await h.call(server.baseUrl, 'POST', '/generate', { tenantId, key: 'r1', body: { type: 'api_call' } });
  assert.equal(rejected.status, 429);

  const after = await h.call(server.baseUrl, 'GET', '/usage', { tenantId });
  assert.deepEqual(after.body.api_calls, before.body.api_calls);
  assert.deepEqual(after.body.cost, before.body.cost);
});

test('usage is isolated per tenant', async () => {
  const a = await h.createTenant('free');
  const b = await h.createTenant('free');
  await h.call(server.baseUrl, 'POST', '/generate', { tenantId: a, key: 'k', body: { type: 'api_call' } });

  const usageB = await h.call(server.baseUrl, 'GET', '/usage', { tenantId: b });
  assert.equal(usageB.body.api_calls.used, 0);
});

test('events outside the current period are not counted', async () => {
  const tenantId = await h.createTenant('free');
  await h.pool.query(
    `INSERT INTO usage_events (tenant_id, type, quantity, cost_micros, idempotency_key, created_at)
     VALUES ($1, 'api_call', 1, 500, 'old', now() - interval '2 months')`,
    [tenantId]
  );
  const usage = await h.call(server.baseUrl, 'GET', '/usage', { tenantId });
  assert.equal(usage.body.api_calls.used, 0);
});