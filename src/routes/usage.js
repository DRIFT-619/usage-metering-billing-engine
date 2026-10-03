'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { PlanInactiveError } = require('../errors');
const usageService = require('../services/usageService');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const { billingContext } = req;
    if (!billingContext.subscription || !billingContext.plan) {
      throw new PlanInactiveError('none');
    }
    const { plan, subscription } = billingContext;

    const summary = await usageService.getUsageSummary(
      pool,
      billingContext.tenantId,
      subscription.currentPeriodStart,
      subscription.currentPeriodEnd
    );

    const totalCostMicros = summary.api_call.cost_micros + summary.ai_tokens.cost_micros;

    res.status(200).json({
      tenant_id: billingContext.tenantId,
      plan: plan.id,
      period: {
        start: subscription.currentPeriodStart,
        end: subscription.currentPeriodEnd,
      },
      api_calls: { used: summary.api_call.quantity, limit: plan.apiCallLimit },
      ai_tokens: { used: summary.ai_tokens.quantity, limit: plan.aiTokenLimit },
      cost: {
        api_calls_micros: summary.api_call.cost_micros,
        ai_tokens_micros: summary.ai_tokens.cost_micros,
        total_micros: totalCostMicros,
        total_usd: (totalCostMicros / 1_000_000).toFixed(6),
        budget_cap_micros: plan.monthlyBudgetCapMicros,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;