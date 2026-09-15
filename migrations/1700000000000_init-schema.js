/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true }); // for gen_random_uuid()

  pgm.createTable('tenants', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    stripe_customer_id: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('plans', {
    id: { type: 'text', primaryKey: true }, // 'free' | 'pro'
    name: { type: 'text', notNull: true },
    api_call_limit: { type: 'integer', notNull: true },
    ai_token_limit: { type: 'integer', notNull: true },
    monthly_budget_cap_micros: { type: 'bigint', notNull: true },
    stripe_price_id: { type: 'text' },
  });

  pgm.createTable('subscriptions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: {
      type: 'uuid',
      notNull: true,
      references: 'tenants',
      onDelete: 'cascade',
    },
    plan_id: {
      type: 'text',
      notNull: true,
      references: 'plans',
    },
    stripe_subscription_id: { type: 'text', unique: true },
    status: { type: 'text', notNull: true, default: 'active' },
    current_period_start: { type: 'timestamptz', notNull: true, default: pgm.func('date_trunc(\'month\', now())') },
    current_period_end: { type: 'timestamptz', notNull: true, default: pgm.func('date_trunc(\'month\', now()) + interval \'1 month\'') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('subscriptions', 'tenant_id');

  pgm.createTable('usage_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: {
      type: 'uuid',
      notNull: true,
      references: 'tenants',
      onDelete: 'cascade',
    },
    type: { type: 'text', notNull: true }, // 'api_call' | 'ai_tokens'
    quantity: { type: 'integer', notNull: true },
    token_breakdown: { type: 'jsonb' },
    cost_micros: { type: 'bigint', notNull: true },
    idempotency_key: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('usage_events', 'usage_events_tenant_idempotency_unique', {
    unique: ['tenant_id', 'idempotency_key'],
  });
  pgm.createIndex('usage_events', ['tenant_id', 'type', 'created_at']);

  pgm.createTable('idempotency_keys', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: {
      type: 'uuid',
      notNull: true,
      references: 'tenants',
      onDelete: 'cascade',
    },
    key: { type: 'text', notNull: true },
    request_hash: { type: 'text', notNull: true },
    status_code: { type: 'integer', notNull: true },
    response_body: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('idempotency_keys', 'idempotency_keys_tenant_key_unique', {
    unique: ['tenant_id', 'key'],
  });

  pgm.createTable('stripe_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    stripe_event_id: { type: 'text', notNull: true, unique: true },
    type: { type: 'text', notNull: true },
    payload: { type: 'jsonb', notNull: true },
    processed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('stripe_events');
  pgm.dropTable('idempotency_keys');
  pgm.dropTable('usage_events');
  pgm.dropTable('subscriptions');
  pgm.dropTable('plans');
  pgm.dropTable('tenants');
};
