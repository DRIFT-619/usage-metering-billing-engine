/* eslint-disable camelcase */

exports.shorthands = undefined;

// The "failure alert" sink for background jobs: when a job exhausts its
// retries, a row lands here (and a loud [ALERT] line is logged).
exports.up = (pgm) => {
  pgm.createTable('job_failures', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    job_name: { type: 'text', notNull: true },
    attempts: { type: 'integer', notNull: true },
    error: { type: 'text', notNull: true },
    failed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('job_failures');
};