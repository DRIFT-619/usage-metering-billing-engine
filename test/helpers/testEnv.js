'use strict';

/**
 * Shared test plumbing. Every test file calls `await setupDatabase()` once
 * (creates the _test database if missing, runs migrations) and
 * `await resetData()` before each test (wipes rows, re-seeds the two plans).
 *
 * SAFETY: resetData() TRUNCATEs tables, so it refuses to run unless the
 * database name ends in `_test`. This can never wipe your dev database.
 */

const path = require('node:path');
const { Client } = require('pg');
const { default: migrate } = require('node-pg-migrate');
const buildApp = require('../../src/app');
const { pool } = require('../../src/db/pool');

function dbName() {
  return new URL(process.env.DATABASE_URL).pathname.slice(1);
}

function assertTestDatabase() {
  if (!dbName().endsWith('_test')) {
    throw new Error(`Refusing to run tests against "${dbName()}" — database name must end in _test`);
  }
}

async function ensureTestDatabase() {
  assertTestDatabase();
  const adminUrl = new URL(process.env.DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName()]);
    if (exists.rows.length === 0) {
      await admin.query(`CREATE DATABASE "${dbName()}"`);
    }
  } finally {
    await admin.end();
  }
}

async function setupDatabase() {
  await ensureTestDatabase();
  await migrate({
    databaseUrl: process.env.DATABASE_URL,
    dir: path.join(__dirname, '..', '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  });
}

const PLANS = [
  ['free', 'Free', 1000, 100000, 5_000_000, null],
  ['pro', 'Pro', 50000, 5000000, 50_000_000, 'price_test_pro'],
];

async function resetData() {
  assertTestDatabase();
  await pool.query(
    'TRUNCATE usage_events, idempotency_keys, stripe_events, job_failures, subscriptions, tenants, plans CASCADE'
  );
  for (const p of PLANS) {
    await pool.query(
      `INSERT INTO plans (id, name, api_call_limit, ai_token_limit, monthly_budget_cap_micros, stripe_price_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      p
    );
  }
}

async function createTenant(planId = 'free', { stripeSubscriptionId = null } = {}) {
  const t = await pool.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [`test-${planId}-${Math.random()}`]);
  const tenantId = t.rows[0].id;
  await pool.query(
    `INSERT INTO subscriptions (tenant_id, plan_id, status, stripe_subscription_id)
     VALUES ($1, $2, 'active', $3)`,
    [tenantId, planId, stripeSubscriptionId]
  );
  return tenantId;
}

/** Bulk-insert fake prior usage so we can park a tenant right below a limit. */
async function seedUsage(tenantId, type, count, quantityEach = 1, costEach = 0) {
  await pool.query(
    `INSERT INTO usage_events (tenant_id, type, quantity, cost_micros, idempotency_key)
     SELECT $1, $2, $3, $4, 'seed-' || g FROM generate_series(1, $5) g`,
    [tenantId, type, quantityEach, costEach, count]
  );
}

async function startServer() {
  const server = buildApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** fetch wrapper: returns { status, body } with the JSON already parsed. */
async function call(baseUrl, method, route, { tenantId, key, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (tenantId) h['X-Tenant-Id'] = tenantId;
  if (key) h['Idempotency-Key'] = key;
  if (body !== undefined || raw !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(baseUrl + route, {
    method,
    headers: h,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function countEvents(tenantId, extraWhere = '', params = []) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM usage_events WHERE tenant_id = $1 ${extraWhere}`,
    [tenantId, ...params]
  );
  return r.rows[0].n;
}

module.exports = {
  pool,
  setupDatabase,
  resetData,
  createTenant,
  seedUsage,
  startServer,
  call,
  countEvents,
};