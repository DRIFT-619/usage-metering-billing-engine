'use strict';

const { pool } = require('../db/pool');

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The failure alert. A real deployment would page someone (Slack/PagerDuty);
 * here the alert is (1) a loud log line and (2) a durable row in job_failures
 * that a dashboard or a human can query.
 */
async function alertFailure(jobName, attempts, error) {
  // eslint-disable-next-line no-console
  console.error(`[ALERT] job "${jobName}" failed after ${attempts} attempts: ${error.message}`);
  try {
    await pool.query('INSERT INTO job_failures (job_name, attempts, error) VALUES ($1, $2, $3)', [
      jobName,
      attempts,
      error.stack || error.message,
    ]);
  } catch (alertErr) {
    // The alert path must never throw — a broken alert sink can't kill the process.
    // eslint-disable-next-line no-console
    console.error('[ALERT] could not persist job failure:', alertErr.message);
  }
}

/**
 * Runs fn with retries and exponential backoff (baseDelayMs, then x2, x4...).
 * Never throws: returns { ok, attempts } so a scheduler loop can't crash.
 * `sleep` is injectable so tests don't actually wait.
 */
async function runJob(name, fn, { maxAttempts = 3, baseDelayMs = 500, sleep = defaultSleep } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await fn();
      return { ok: true, attempts: attempt, result };
    } catch (err) {
      lastError = err;
      // eslint-disable-next-line no-console
      console.warn(`[job:${name}] attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      if (attempt < maxAttempts) {
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  await alertFailure(name, maxAttempts, lastError);
  return { ok: false, attempts: maxAttempts };
}

module.exports = { runJob };