'use strict';

const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({ connectionString: config.databaseUrl });

pool.on('error', (err) => {
  // A background/idle client error should never crash the process silently.
  // eslint-disable-next-line no-console
  console.error('[db] unexpected error on idle client', err);
});

/**
 * Run a callback inside a single transaction on one client.
 * Rolls back automatically if the callback throws.
 */
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction };
