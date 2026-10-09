'use strict';

const { pool } = require('../db/pool');
const { MissingTenantHeaderError, TenantNotFoundError, ValidationError } = require('../errors');

async function resolveTenant(req, res, next) {
  try {
    const tenantId = req.header('X-Tenant-Id');
    if (!tenantId) {
      throw new MissingTenantHeaderError();
    }

    const result = await pool.query(
      `SELECT
         t.id AS tenant_id,
         t.name AS tenant_name,
         t.stripe_customer_id AS stripe_customer_id,
         s.id AS subscription_id,
         s.status AS subscription_status,
         s.current_period_start,
         s.current_period_end,
         p.id AS plan_id,
         p.name AS plan_name,
         p.api_call_limit,
         p.ai_token_limit,
         p.monthly_budget_cap_micros
       FROM tenants t
       LEFT JOIN subscriptions s ON s.tenant_id = t.id
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE t.id = $1
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [tenantId]
    );

    if (result.rows.length === 0) {
      throw new TenantNotFoundError(tenantId);
    }

    const row = result.rows[0];

    // Just DATA here — no business rules decided in this middleware.
    req.billingContext = {
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      stripeCustomerId: row.stripe_customer_id,
      subscription: row.subscription_id
        ? {
            id: row.subscription_id,
            status: row.subscription_status,
            currentPeriodStart: row.current_period_start,
            currentPeriodEnd: row.current_period_end,
          }
        : null,
      plan: row.plan_id
        ? {
            id: row.plan_id,
            name: row.plan_name,
            apiCallLimit: row.api_call_limit,
            aiTokenLimit: row.ai_token_limit,
            monthlyBudgetCapMicros: Number(row.monthly_budget_cap_micros),
          }
        : null,
    };

    next();
  } catch (err) {
    // 22P02 = Postgres "invalid_text_representation": the header isn't a valid
    // UUID. Turn that into a clean 400 instead of a raw 500.
    if (err.code === '22P02') {
      return next(new ValidationError('X-Tenant-Id must be a valid UUID'));
    }
    next(err);
  }
}

module.exports = resolveTenant;