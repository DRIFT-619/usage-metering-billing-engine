'use strict';

const { pool } = require('../db/pool');

/**
 * Billing-period rollover for Free-plan subscriptions. The Free plan is never
 * billed by Stripe, so nothing from Stripe will ever renew its period. That
 * includes a tenant that upgraded to Pro and later cancelled: its row falls
 * back to 'free' but keeps the old stripe_subscription_id and the cancelled
 * subscription's period. Pro subscriptions are left alone because Stripe's
 * customer.subscription.updated webhook renews those.
 *
 * Idempotent: running it twice in a row changes nothing the second time,
 * because after the first run current_period_end is in the future.
 */
async function rolloverFreePeriods(queryable = pool) {
  const result = await queryable.query(
    `UPDATE subscriptions
        SET current_period_start = date_trunc('month', now()),
            current_period_end   = date_trunc('month', now()) + interval '1 month',
            updated_at           = now()
        WHERE plan_id = 'free'
        AND current_period_end <= now()
      RETURNING tenant_id`
  );
  return result.rowCount;
}

module.exports = { rolloverFreePeriods };