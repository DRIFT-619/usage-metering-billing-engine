'use strict';

const crypto = require('crypto');

// Recursively sorts object keys so the same data with keys in a different
// order hashes identically (JSON.stringify alone is order-sensitive).
function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function hashRequestBody(body) {
  const canonical = JSON.stringify(canonicalize(body));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function findExisting(client, tenantId, key) {
  const result = await client.query(
    'SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE tenant_id = $1 AND key = $2',
    [tenantId, key]
  );
  return result.rows[0] || null;
}

async function store(client, { tenantId, key, requestHash, statusCode, responseBody }) {
  await client.query(
    `INSERT INTO idempotency_keys (tenant_id, key, request_hash, status_code, response_body)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, key, requestHash, statusCode, responseBody]
  );
}

module.exports = { hashRequestBody, findExisting, store };