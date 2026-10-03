'use strict';

const express = require('express');
const { generateRequestSchema } = require('../validation/generateSchema');
const { ValidationError, PlanInactiveError } = require('../errors');
const { withTransaction } = require('../db/pool');
const meterService = require('../services/meterService');
const idempotencyService = require('../services/idempotencyService');

const router = express.Router();

router.post('/', async (req, res, next) => {
  try {
    const idempotencyKey = req.header('Idempotency-Key');
    if (!idempotencyKey) {
      throw new ValidationError('Idempotency-Key header is required');
    }

    const parsed = generateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const body = parsed.data;

    const { billingContext } = req;
    if (!billingContext.subscription || !billingContext.plan) {
      throw new PlanInactiveError('none');
    }

    const requestHash = idempotencyService.hashRequestBody(body);

    const result = await withTransaction((client) =>
      meterService.recordUsage(client, {
        tenantId: billingContext.tenantId,
        idempotencyKey,
        requestHash,
        type: body.type,
        tokens: body.type === 'ai_tokens' ? body.tokens : null,
        plan: billingContext.plan,
        subscription: billingContext.subscription,
      })
    );

    res.status(result.statusCode).json(result.body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;