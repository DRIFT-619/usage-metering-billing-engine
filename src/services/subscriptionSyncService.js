'use strict';

// Stripe's subscription period fields have moved around across API
// versions (top-level vs. per line-item). Check both so this doesn't
// silently break on a future SDK/API upgrade.
function resolvePeriod(stripeSubscription) {
  const item = stripeSubscription.items?.data?.[0];
  const startSec = stripeSubscription.current_period_start ?? item?.current_period_start;
  const endSec = stripeSubscription.current_period_end ?? item?.current_period_end;
  return {
    start: startSec ? new Date(startSec * 1000) : null,
    end: endSec ? new Date(endSec * 1000) : null,
  };
}

async function resolvePlanId(client, stripeSubscription) {
  const priceId = stripeSubscription.items?.data?.[0]?.price?.id;
  if (!priceId) return 'pro';
  const result = await client.query('SELECT id FROM plans WHERE stripe_price_id = $1', [priceId]);
  return result.rows[0]?.id || 'pro';
}

async function syncSubscription(client, { tenantId, stripeCustomerId, stripeSubscription, forceDowngradeToFree = false }) {
  const { start, end } = resolvePeriod(stripeSubscription);
  const planId = forceDowngradeToFree ? 'free' : await resolvePlanId(client, stripeSubscription);
  // A cancelled Pro subscription means "fall back to Free", and Free is a
  // working plan, so the row must be 'active' or /generate would reject it.
  const status = forceDowngradeToFree ? 'active' : stripeSubscription.status;

  if (stripeCustomerId) {
    await client.query('UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2', [stripeCustomerId, tenantId]);
  }

  await client.query(
    `UPDATE subscriptions
     SET plan_id = $1, stripe_subscription_id = $2, status = $3,
         current_period_start = COALESCE($4, current_period_start),
         current_period_end = COALESCE($5, current_period_end),
         updated_at = now()
     WHERE tenant_id = $6`,
    [planId, stripeSubscription.id, status, start, end, tenantId]
  );
}

// Used by events that don't carry client_reference_id (updated/deleted) —
// we instead look up which tenant we already attached this subscription to.
async function syncSubscriptionBySubscriptionId(client, stripeSubscription, { forceDowngradeToFree = false } = {}) {
  const existing = await client.query(
    'SELECT tenant_id FROM subscriptions WHERE stripe_subscription_id = $1',
    [stripeSubscription.id]
  );
  if (existing.rows.length === 0) {
    // No tenant on file for this subscription id — e.g. a synthetic
    // `stripe trigger` fixture event not tied to a real checkout here.
    // eslint-disable-next-line no-console
    console.warn(`[stripe sync] no tenant found for subscription ${stripeSubscription.id}, skipping`);
    return;
  }
  const tenantId = existing.rows[0].tenant_id;
  await syncSubscription(client, {
    tenantId,
    stripeCustomerId: stripeSubscription.customer,
    stripeSubscription,
    forceDowngradeToFree,
  });
}

module.exports = { syncSubscription, syncSubscriptionBySubscriptionId };