'use strict';

// Manual trigger for the rollover job:  npm run job:rollover
const { pool } = require('../src/db/pool');
const { runJob } = require('../src/jobs/runJob');
const { rolloverFreePeriods } = require('../src/jobs/rolloverPeriods');

runJob('rollover-free-periods', rolloverFreePeriods)
  .then((outcome) => {
    console.log(outcome.ok ? `Rolled over ${outcome.result} subscription(s)` : 'Job failed — see job_failures table');
  })
  .finally(() => pool.end());