'use strict';

const { PRICE_PER_MILLION_TOKENS_MICROS, PRICE_PER_API_CALL_MICROS } = require('../config/pricing');

function calculateApiCallCostMicros() {
  return PRICE_PER_API_CALL_MICROS;
}

// Sums all four categories as one fractional total and rounds ONCE at the
// end, instead of rounding each category separately and adding the pieces.
function calculateTokenCostMicros(tokens) {
  const { input = 0, cached_input = 0, output = 0, reasoning = 0 } = tokens;

  const totalMicros =
    (input * PRICE_PER_MILLION_TOKENS_MICROS.input) / 1_000_000 +
    (cached_input * PRICE_PER_MILLION_TOKENS_MICROS.cached_input) / 1_000_000 +
    (output * PRICE_PER_MILLION_TOKENS_MICROS.output) / 1_000_000 +
    (reasoning * PRICE_PER_MILLION_TOKENS_MICROS.reasoning) / 1_000_000;

  return Math.round(totalMicros);
}

// The token QUOTA counts every category together; PRICE differs per category.
function totalTokenQuantity(tokens) {
  const { input = 0, cached_input = 0, output = 0, reasoning = 0 } = tokens;
  return input + cached_input + output + reasoning;
}

module.exports = { calculateApiCallCostMicros, calculateTokenCostMicros, totalTokenQuantity };