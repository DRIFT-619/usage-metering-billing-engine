'use strict';

const express = require('express');
const stripeService = require('../services/stripeService');
const { withTransaction } = require('../db/pool');
const subscriptionSyncService = require('../services/subscriptionSyncService');

const router = express.Router();

// Mounted with express.raw() in app.js, NOT express.json() — signature
// verification needs the exact original bytes Stripe signed.
router.post('/', async (req, res) => {
  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = stripeService.constructWebhookEvent(req.body, signature);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stripe webhook] signature verification failed:', err.message);
    return res.status(400).json({ error: 'invalid_signature', message: err.message });
  }

  // eslint-disable-next-line no-console
  console.log(`[stripe webhook] received ${event.type} (id: ${event.id})`);

  try {
    const processed = await withTransaction(async (client) => {
      // Dedup: claim this event id atomically. ON CONFLICT DO NOTHING means two
      // simultaneous deliveries of the same event can't both pass a
      // "SELECT then INSERT" gap — the second INSERT waits on the unique index
      // until the first transaction finishes, then inserts nothing.
      // If the handler below throws, the whole transaction (including this
      // claim) rolls back, so Stripe's retry is processed normally.
      const claimed = await client.query(
        `INSERT INTO stripe_events (stripe_event_id, type, payload)
         VALUES ($1, $2, $3)
         ON CONFLICT (stripe_event_id) DO NOTHING
         RETURNING id`,
        [event.id, event.type, event.data.object]
      );
      if (claimed.rows.length === 0) {
        return false;
      }

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const tenantId = session.client_reference_id;
          if (tenantId && session.subscription) {
            const stripe = stripeService.getStripeClient();
            const sub = await stripe.subscriptions.retrieve(session.subscription);
            await subscriptionSyncService.syncSubscription(client, {
              tenantId,
              stripeCustomerId: session.customer,
              stripeSubscription: sub,
            });
          }
          break;
        }
        case 'customer.subscription.updated': {
          await subscriptionSyncService.syncSubscriptionBySubscriptionId(client, event.data.object);
          break;
        }
        case 'customer.subscription.deleted': {
          await subscriptionSyncService.syncSubscriptionBySubscriptionId(client, event.data.object, {
            forceDowngradeToFree: true,
          });
          break;
        }
        default:
          break; // Stripe sends many event types we don't act on — that's fine.
      }
      
      return true;
    });

    // eslint-disable-next-line no-console
    console.log(`[stripe webhook] ${event.id} ${processed ? 'processed' : 'duplicate ignored'}`);
    res.status(200).json({ received: true, processed });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stripe webhook] processing error:', err);
    res.status(500).json({ error: 'webhook_processing_failed' });
  }
});

module.exports = router;