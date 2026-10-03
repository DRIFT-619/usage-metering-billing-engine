'use strict';

// Accepts either the pool or a transaction client — both expose .query().
async function getUsageSummary(queryable, tenantId, periodStart, periodEnd) {
  const result = await queryable.query(
    `SELECT type, SUM(quantity) AS quantity, SUM(cost_micros) AS cost_micros
     FROM usage_events
     WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
     GROUP BY type`,
    [tenantId, periodStart, periodEnd]
  );

  const summary = {
    api_call: { quantity: 0, cost_micros: 0 },
    ai_tokens: { quantity: 0, cost_micros: 0 },
  };

  for (const row of result.rows) {
    // node-pg returns SUM() results as strings (to avoid silently losing
    // precision on huge numbers). Our values are small, so Number() is safe.
    summary[row.type] = {
      quantity: Number(row.quantity),
      cost_micros: Number(row.cost_micros),
    };
  }

  return summary;
}

module.exports = { getUsageSummary };