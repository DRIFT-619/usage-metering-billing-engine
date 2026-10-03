'use strict';

const idempotencyService = require('./idempotencyService');
const usageService = require('./usageService');
const pricingService = require('./pricingService');
const { AppError, PlanInactiveError, QuotaExceededError, BudgetExceededError } = require('../errors');

/**
 * Decides whether a brand-new (never-seen-before) usage request is allowed
 * and what it costs. Throws an AppError subclass for every rejection reason;
 * recordUsage() below catches these locally and turns them into a cached
 * response instead of letting them roll back the transaction.
 */
function buildOutcomeForNewUsage({ type, tokens, plan, subscription, currentUsage }) {
  if (subscription.status !== 'active') {
    throw new PlanInactiveError(subscription.status);
  }

  let quantity;
  let costMicros;
  let tokenBreakdown = null;

  if (type === 'api_call') {
    quantity = 1;
    costMicros = pricingService.calculateApiCallCostMicros();
  } else {
    quantity = pricingService.totalTokenQuantity(tokens);
    costMicros = pricingService.calculateTokenCostMicros(tokens);
    tokenBreakdown = tokens;
  }

  const bucket = type === 'api_call' ? currentUsage.api_call : currentUsage.ai_tokens;
  const limit = type === 'api_call' ? plan.apiCallLimit : plan.aiTokenLimit;

  // Boundary rule: landing EXACTLY on the limit is allowed; crossing it is
  // rejected. Hence strictly greater-than, not >=.
  if (bucket.quantity + quantity > limit) {
    throw new QuotaExceededError(
      `${type} quota exceeded: ${bucket.quantity}/${limit} used this period; this request needs ${quantity} more.`
    );
  }

  const currentTotalCostMicros = currentUsage.api_call.cost_micros + currentUsage.ai_tokens.cost_micros;
  const projectedTotalCostMicros = currentTotalCostMicros + costMicros;

  // Budget guard: independent of the quota check above.
  if (projectedTotalCostMicros > plan.monthlyBudgetCapMicros) {
    throw new BudgetExceededError(
      `Monthly budget cap exceeded: this request would bring spend to $${(projectedTotalCostMicros / 1_000_000).toFixed(6)}, cap is $${(plan.monthlyBudgetCapMicros / 1_000_000).toFixed(2)}.`
    );
  }

  return {
    statusCode: 201,
    quantity,
    costMicros,
    tokenBreakdown,
    body: {
      type,
      cost_micros: costMicros,
      cost_usd: (costMicros / 1_000_000).toFixed(6),
      usage_after: { used: bucket.quantity + quantity, limit },
    },
  };
}

/**
 * Records one billable action, idempotently, inside the transaction the
 * caller already opened (withTransaction in db/pool.js).
 *
 * NEVER throws for an expected business outcome (quota, budget, inactive
 * plan, key-reuse conflict). It always returns { statusCode, body } so the
 * outcome can be saved in idempotency_keys and the transaction can COMMIT.
 * Only a genuine bug or DB failure propagates and triggers a ROLLBACK.
 */
async function recordUsage(client, ctx) {
  const { tenantId, idempotencyKey, requestHash, type, tokens, plan, subscription } = ctx;

  // Serializes every quota/budget decision for THIS tenant. Released
  // automatically at COMMIT/ROLLBACK.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [tenantId]);

  const existing = await idempotencyService.findExisting(client, tenantId, idempotencyKey);
  if (existing) {
    if (existing.request_hash !== requestHash) {
      // Same key, different body: client misuse. Don't touch anything.
      return {
        statusCode: 409,
        body: {
          error: 'idempotency_conflict',
          message: 'This Idempotency-Key was already used with a different request body.',
        },
      };
    }
    // Same key, same body: a genuine retry. Replay the stored response.
    return { statusCode: existing.status_code, body: existing.response_body };
  }

  const currentUsage = await usageService.getUsageSummary(
    client,
    tenantId,
    subscription.currentPeriodStart,
    subscription.currentPeriodEnd
  );

  let outcome;
  try {
    outcome = buildOutcomeForNewUsage({ type, tokens, plan, subscription, currentUsage });
  } catch (err) {
    if (err instanceof AppError) {
      outcome = { statusCode: err.statusCode, body: { error: err.code, message: err.message } };
    } else {
      throw err; // a real bug: roll back, surface as a 500
    }
  }

  if (outcome.statusCode < 300) {
    const inserted = await client.query(
      `INSERT INTO usage_events (tenant_id, type, quantity, token_breakdown, cost_micros, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [tenantId, type, outcome.quantity, outcome.tokenBreakdown, outcome.costMicros, idempotencyKey]
    );
    outcome.body.id = inserted.rows[0].id;
  }

  // Save the outcome (success OR rejection) so a retry with this key is
  // answered from cache, never re-executed.
  await idempotencyService.store(client, {
    tenantId,
    key: idempotencyKey,
    requestHash,
    statusCode: outcome.statusCode,
    responseBody: outcome.body,
  });

  return { statusCode: outcome.statusCode, body: outcome.body };
}

module.exports = { recordUsage };