'use strict';

const { runJob } = require('./runJob');
const { rolloverFreePeriods } = require('./rolloverPeriods');

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Starts the background jobs: once immediately at boot, then on an interval.
 * The timer is unref()'d so it never keeps the process alive on its own.
 * Returns a stop() function.
 */
function startScheduler({ intervalMs = ONE_HOUR_MS } = {}) {
  const tick = async () => {
    const outcome = await runJob('rollover-free-periods', rolloverFreePeriods);
    if (outcome.ok && outcome.result > 0) {
      // eslint-disable-next-line no-console
      console.log(`[job:rollover-free-periods] rolled over ${outcome.result} subscription(s)`);
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { startScheduler };