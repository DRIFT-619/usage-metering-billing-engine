'use strict';

const express = require('express');
const resolveTenant = require('../middleware/resolveTenant');
const stripeService = require('../services/stripeService');

const router = express.Router();

router.post('/', resolveTenant, async (req, res, next) => {
  try {
    const { billingContext } = req;

    const session = await stripeService.createCheckoutSession({
      tenantId: billingContext.tenantId,
      stripeCustomerId: billingContext.stripeCustomerId,
    });

    res.status(200).json({ checkout_url: session.url, session_id: session.id });
  } catch (err) {
    next(err);
  }
});

// Stripe redirects the BROWSER here after Checkout — a browser navigation
// can't carry a custom X-Tenant-Id header, so these are deliberately NOT
// behind resolveTenant. They're plain landing pages, not API calls.
router.get('/success', (req, res) => {
  res.status(200).send('Checkout complete. Close this tab and check GET /usage for your updated plan.');
});

router.get('/cancel', (req, res) => {
  res.status(200).send('Checkout cancelled.');
});

module.exports = router;