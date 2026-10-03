'use strict';

class AppError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
  }
}

class ValidationError extends AppError {
  constructor(message) {
    super(message, 400, 'validation_error');
  }
}

class MissingTenantHeaderError extends AppError {
  constructor() {
    super('X-Tenant-Id header is required', 400, 'missing_tenant_header');
  }
}

class TenantNotFoundError extends AppError {
  constructor(tenantId) {
    super(`No tenant found for id ${tenantId}`, 404, 'tenant_not_found');
  }
}

class PlanInactiveError extends AppError {
  constructor(status) {
    super(`Subscription is '${status}', not active — this action requires an active plan.`, 402, 'plan_inactive');
  }
}

class QuotaExceededError extends AppError {
  constructor(message) {
    super(message, 429, 'quota_exceeded');
  }
}

class BudgetExceededError extends AppError {
  constructor(message) {
    super(message, 402, 'budget_exceeded');
  }
}

module.exports = {
  AppError,
  ValidationError,
  MissingTenantHeaderError,
  TenantNotFoundError,
  PlanInactiveError,
  QuotaExceededError,
  BudgetExceededError,
};