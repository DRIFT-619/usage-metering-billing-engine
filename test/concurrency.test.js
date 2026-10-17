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

test('20 simultaneous requests at 999/1000 -> exactly ONE is admitted (10 rounds)', async () => {
  // One round can get lucky on a fast machine, so we repeat it on fresh tenants.
  // Without the per-tenant advisory lock, several requests read "999 used" at
  // the same instant and all get admitted, so some round would exceed 1000.
  for (let round = 0; round < 10; round += 1) {
    const tenantId = await h.createTenant('free'); // limit 1000 api calls
    await h.seedUsage(tenantId, 'api_call', 999, 1, 500);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => post(tenantId, `race-${round}-${i}`, { type: 'api_call' }))
    );

    const admitted = results.filter((r) => r.status === 201).length;
    const rejected = results.filter((r) => r.status === 429).length;
    assert.equal(admitted, 1, `round ${round}: expected exactly 1 admitted`);
    assert.equal(rejected, 19, `round ${round}: expected 19 rejected`);
    assert.equal(await h.countEvents(tenantId), 1000, `round ${round}: must never exceed the limit`);
  }
});

test('10 simultaneous retries of ONE key -> one event, ten identical responses', async () => {
  const tenantId = await h.createTenant('free');

  const results = await Promise.all(Array.from({ length: 10 }, () => post(tenantId, 'same-key', { type: 'api_call' })));

  assert.ok(results.every((r) => r.status === 201));
  const ids = new Set(results.map((r) => r.body.id));
  assert.equal(ids.size, 1); // every response carries the same usage-event id
  assert.equal(await h.countEvents(tenantId), 1);
});

test('concurrent token requests can never overshoot the token quota', async () => {
  const tenantId = await h.createTenant('free'); // 100,000 tokens
  await h.seedUsage(tenantId, 'ai_tokens', 1, 90_000);

  // 10 requests x 3,000 tokens = 30,000 asked, only 10,000 of room -> at most 3 fit.
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => post(tenantId, `tok-${i}`, { type: 'ai_tokens', tokens: { input: 3000 } }))
  );

  const admitted = results.filter((r) => r.status === 201).length;
  assert.equal(admitted, 3);
  const used = await h.pool.query(
    "SELECT SUM(quantity)::int AS total FROM usage_events WHERE tenant_id = $1 AND type = 'ai_tokens'",
    [tenantId]
  );
  assert.equal(used.rows[0].total, 99_000);
  assert.ok(used.rows[0].total <= 100_000);
});