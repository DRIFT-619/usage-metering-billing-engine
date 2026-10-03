'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const healthRoute = require('./routes/health');
const generateRoute = require('./routes/generate');
const usageRoute = require('./routes/usage');
const resolveTenant = require('./middleware/resolveTenant');

function buildApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(morgan(process.env.NODE_ENV === 'test' ? 'tiny' : 'dev'));

  // NOTE: the Stripe webhook route needs the RAW request body to verify the
  // signature, so it must be mounted with express.raw() *before* the global
  // express.json() below. That route is added in Phase 3.
  app.use(express.json());

  app.use('/health', healthRoute);
  app.use('/generate', resolveTenant, generateRoute);
  app.use('/usage', resolveTenant, usageRoute);

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