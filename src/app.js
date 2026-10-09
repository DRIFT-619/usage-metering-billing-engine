'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const healthRoute = require('./routes/health');
const generateRoute = require('./routes/generate');
const usageRoute = require('./routes/usage');
const checkoutRoute = require('./routes/checkout');
const stripeWebhookRoute = require('./routes/stripeWebhook');
const resolveTenant = require('./middleware/resolveTenant');

function buildApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(morgan(process.env.NODE_ENV === 'test' ? 'tiny' : 'dev'));

  // Stripe needs the RAW request body to verify its signature, so this route
  // is mounted BEFORE the global express.json() below — it gets its own
  // raw-body parser instead of the parsed-JSON one every other route uses.
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhookRoute);

  app.use(express.json());

  app.use('/health', healthRoute);
  app.use('/generate', resolveTenant, generateRoute);
  app.use('/usage', resolveTenant, usageRoute);
  app.use('/checkout', checkoutRoute);

  // 404 fallback
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}` });
  });

  // Central error handler — every thrown/next(err) lands here.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // eslint-disable-next-line no-console
    console.error('[error]', err);
    const status = err.statusCode || 500;
    res.status(status).json({
      error: err.code || 'internal_error',
      message: status === 500 ? 'Something went wrong.' : err.message,
    });
  });

  return app;
}

module.exports = buildApp;