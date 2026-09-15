'use strict';

/**
 * Idempotent seed: safe to run more than once. It clears and re-inserts
 * plans (small reference table) but only inserts demo tenants if they don't
 * already exist by name, so re-running doesn't spam your usage rollups with
 * duplicate tenants.
 */

const { pool } = require('../src/db/pool');

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    api_call_limit: 1000,
    ai_token_limit: 100000,
    monthly_budget_cap_micros: 5_000_000, // $5.00 — generous, meant to never trip in normal free-tier use
    stripe_price_id: null,
  },
  {
    id: 'pro',
    name: 'Pro',
    api_call_limit: 50000,
    ai_token_limit: 5000000,
    monthly_budget_cap_micros: 50_000_000, // $50.00 — can realistically be hit under heavy reasoning/output usage
    stripe_price_id: process.env.STRIPE_PRO_PRICE_ID || null,
  },
];

const DEMO_TENANTS = [
  { name: 'Acme Inc (free tier demo)', plan_id: 'free' },
  { name: 'Globex Corp (pro tier demo)', plan_id: 'pro' },
];

async function seedPlans(client) {
  for (const plan of PLANS) {
    await client.query(
      `INSERT INTO plans (id, name, api_call_limit, ai_token_limit, monthly_budget_cap_micros, stripe_price_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         api_call_limit = EXCLUDED.api_call_limit,
         ai_token_limit = EXCLUDED.ai_token_limit,
         monthly_budget_cap_micros = EXCLUDED.monthly_budget_cap_micros,
         stripe_price_id = EXCLUDED.stripe_price_id`,
      [plan.id, plan.name, plan.api_call_limit, plan.ai_token_limit, plan.monthly_budget_cap_micros, plan.stripe_price_id]
    );
    console.log(`  plan: ${plan.id} (${plan.api_call_limit} calls / ${plan.ai_token_limit} tokens / $${plan.monthly_budget_cap_micros / 1_000_000} cap)`);
  }
}

async function seedTenants(client) {
  for (const tenant of DEMO_TENANTS) {
    const existing = await client.query('SELECT id FROM tenants WHERE name = $1', [tenant.name]);
    let tenantId;
    if (existing.rows.length > 0) {
      tenantId = existing.rows[0].id;
      console.log(`  tenant: ${tenant.name} already exists (${tenantId})`);
    } else {
      const inserted = await client.query(
        'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
        [tenant.name]
      );
      tenantId = inserted.rows[0].id;
      console.log(`  tenant: ${tenant.name} created (${tenantId})`);
    }

    const existingSub = await client.query('SELECT id FROM subscriptions WHERE tenant_id = $1', [tenantId]);
    if (existingSub.rows.length === 0) {
      await client.query(
        `INSERT INTO subscriptions (tenant_id, plan_id, status)
         VALUES ($1, $2, 'active')`,
        [tenantId, tenant.plan_id]
      );
      console.log(`    subscribed to plan: ${tenant.plan_id}`);
    }
  }
}

async function main() {
  const client = await pool.connect();
  try {
    console.log('Seeding plans...');
    await seedPlans(client);
    console.log('Seeding demo tenants...');
    await seedTenants(client);

    const tenants = await client.query('SELECT id, name FROM tenants ORDER BY created_at');
    console.log('\nDemo tenant IDs (use these as X-Tenant-Id):');
    for (const row of tenants.rows) {
      console.log(`  ${row.id}  ->  ${row.name}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
