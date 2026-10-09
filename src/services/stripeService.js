'use strict';

const Stripe = require('stripe');
const config = require('../config');

// Lazy client — don't crash app startup just because Stripe isn't
// configured yet. The error only surfaces when a Stripe route is actually hit.
let _stripe = null;
function getStripeClient() {
  if (!_stripe) {
    if (!config.stripe.secretKey) {
      throw new Error('STRIPE_SECRET_KEY is not set');
    }
    _stripe = new Stripe(config.stripe.secretKey);
  }
  return _stripe;
}

async function createCheckoutSession({ tenantId, stripeCustomerId }) {
  if (!config.stripe.proPriceId) {
    throw new Error('STRIPE_PRO_PRICE_ID is not set');
  }
  const stripe = getStripeClient();

  return stripe.checkout.sessions.create({
    mode: 'subscription',
    // client_reference_id is how we find our way back to the tenant when
    // the webhook fires later — Stripe echoes it back on the session object.
    client_reference_id: tenantId,
    customer: stripeCustomerId || undefined,
    line_items: [{ price: config.stripe.proPriceId, quantity: 1 }],
    success_url: `${config.stripe.checkoutSuccessUrl}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: config.stripe.checkoutCancelUrl,
    // Newer Stripe accounts default to "Managed Payments," which requires a
    // tax code on every product. Not relevant to this capstone's scope
    // (billing correctness, not tax compliance) — explicitly disabled here.
    managed_payments: { enabled: false },
  });
}

function constructWebhookEvent(rawBody, signature) {
  const stripe = getStripeClient();
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}

module.exports = { getStripeClient, createCheckoutSession, constructWebhookEvent };