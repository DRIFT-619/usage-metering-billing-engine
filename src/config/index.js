'use strict';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: required('DATABASE_URL'),
  stripe: {
    // Stripe config is only required once you actually hit /checkout or the
    // webhook route — we don't want `npm run dev` to crash before you've
    // set up Stripe at all, so these are read lazily where used, not here.
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    proPriceId: process.env.STRIPE_PRO_PRICE_ID || '',
    checkoutSuccessUrl: process.env.CHECKOUT_SUCCESS_URL || 'http://localhost:3000/checkout/success',
    checkoutCancelUrl: process.env.CHECKOUT_CANCEL_URL || 'http://localhost:3000/checkout/cancel',
  },
};

module.exports = config;
