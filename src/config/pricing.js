'use strict';

/**
 * All money is stored and computed in MICROS (1 USD = 1,000,000 micros) so we
 * never touch a floating-point dollar amount. Per-1M-token prices are chosen
 * to be clean integers in micros; only the FINAL total is rounded once
 * (see pricingService.calculateTokenCostMicros), not each category
 * separately — rounding per-category first and summing after compounds
 * error across many small calls.
 */

const MICROS_PER_USD = 1_000_000;

// Mirrors real-world AI API pricing shape: cached input is cheap, reasoning
// tokens are billed at the (more expensive) output rate, and none of the
// categories can just be added together before pricing them individually.
const PRICE_PER_MILLION_TOKENS_MICROS = {
  input: 3_000_000, // $3.00 / 1M input tokens
  cached_input: 300_000, // $0.30 / 1M cached input tokens — 10x cheaper than fresh input
  output: 15_000_000, // $15.00 / 1M output tokens
  reasoning: 15_000_000, // reasoning tokens bill at the output rate, not a separate free category
};

// Purely for cost-tracking/demo purposes — API calls are subscription-flat in
// reality, but the capstone asks us to convert usage into a cost figure, so
// we attribute a small nominal per-call cost.
const PRICE_PER_API_CALL_MICROS = 500; // $0.0005 / call

module.exports = {
  MICROS_PER_USD,
  PRICE_PER_MILLION_TOKENS_MICROS,
  PRICE_PER_API_CALL_MICROS,
};
