'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateTokenCostMicros, totalTokenQuantity, calculateApiCallCostMicros } = require('../src/services/pricingService');

// Pinned constants (src/config/pricing.js), per 1M tokens:
//   input $3.00 · cached_input $0.30 · output $15.00 · reasoning $15.00 (= output rate)

test('the documented mix prices to exactly 7650 micros', () => {
  // 1000*3 + 500*0.3 + 200*15 + 100*15 = 3000 + 150 + 3000 + 1500 (micros)
  const micros = calculateTokenCostMicros({ input: 1000, cached_input: 500, output: 200, reasoning: 100 });
  assert.equal(micros, 7650);
});

test('cached input is 10x cheaper than fresh input', () => {
  const fresh = calculateTokenCostMicros({ input: 1_000_000 });
  const cached = calculateTokenCostMicros({ cached_input: 1_000_000 });
  assert.equal(fresh, 3_000_000);
  assert.equal(cached, 300_000);
  assert.equal(fresh / cached, 10);
});

test('reasoning tokens are billed at the output rate', () => {
  const output = calculateTokenCostMicros({ output: 12345 });
  const reasoning = calculateTokenCostMicros({ reasoning: 12345 });
  assert.equal(reasoning, output);
});

test('categories are priced separately, not added then priced once', () => {
  const total = totalTokenQuantity({ input: 1000, cached_input: 500, output: 200, reasoning: 100 });
  assert.equal(total, 1800);
  // If all 1800 were priced at the input rate it would be 5400 — not 7650.
  assert.notEqual(calculateTokenCostMicros({ input: total }), 7650);
});

test('rounding happens once on the total, not per category', () => {
  // 1 input token = 3 micros; 1 cached token = 0.3 micros. Per-category rounding
  // would turn 0.3 -> 0 and lose the value; summing first keeps it.
  assert.equal(calculateTokenCostMicros({ cached_input: 1 }), 0);
  assert.equal(calculateTokenCostMicros({ cached_input: 5 }), 2); // 1.5 -> rounds to 2
  assert.equal(calculateTokenCostMicros({ input: 1, cached_input: 5 }), 5); // 3 + 1.5 = 4.5 -> 5
});

test('an API call costs the pinned nominal amount', () => {
  assert.equal(calculateApiCallCostMicros(), 500);
});