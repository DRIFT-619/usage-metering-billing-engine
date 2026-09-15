# Design — Usage Metering & Billing Engine

## 1. Problem

Every SaaS product needs to answer three questions honestly, under real-world conditions
(retries, crashes, replayed webhooks): how much has a customer used, what should they pay,
and have they hit their plan's limit? This service is the backend that answers all three —
correctly, even when the same request arrives twice.

## 2. Data model

```
tenants
  id                uuid PK
  name              text
  stripe_customer_id text NULL        -- set once Checkout has run
  created_at        timestamptz

plans
  id                text PK           -- 'free' | 'pro'
  name              text
  api_call_limit    integer           -- per billing period
  ai_token_limit    integer           -- per billing period
  monthly_budget_cap_micros bigint    -- hard $ cap regardless of quota (the budget guard)
  stripe_price_id   text NULL

subscriptions
  id                    uuid PK
  tenant_id             uuid FK -> tenants
  plan_id               text FK -> plans
  stripe_subscription_id text NULL UNIQUE
  status                text        -- active | past_due | canceled | incomplete
  current_period_start  timestamptz
  current_period_end    timestamptz
  created_at            timestamptz
  updated_at            timestamptz

usage_events
  id                uuid PK
  tenant_id         uuid FK -> tenants
  type              text        -- 'api_call' | 'ai_tokens'
  quantity          integer     -- calls: always 1. tokens: total billable tokens
  token_breakdown   jsonb NULL  -- { input, cached_input, output, reasoning }
  cost_micros       bigint      -- computed cost for this single event
  idempotency_key   text
  created_at        timestamptz
  UNIQUE (tenant_id, idempotency_key)   -- belt-and-suspenders alongside idempotency_keys

idempotency_keys
  id                uuid PK
  tenant_id         uuid FK -> tenants
  key               text
  request_hash      text        -- sha256 of the normalized request body
  status_code       integer     -- the response we actually sent (200/201/402/429/400)
  response_body     jsonb
  created_at        timestamptz
  UNIQUE (tenant_id, key)

stripe_events
  id                uuid PK
  stripe_event_id   text UNIQUE       -- Stripe's evt_... id, the real dedup key
  type              text
  payload           jsonb
  processed_at      timestamptz
```

Indexes beyond the PKs/uniques above: `usage_events(tenant_id, type, created_at)` for the
rollup query, `subscriptions(tenant_id)` for the active-plan lookup.

## 3. API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | liveness |
| POST | `/generate` | `X-Tenant-Id` header + `Idempotency-Key` header | the one dummy billable action |
| GET | `/usage` | `X-Tenant-Id` header | current-period rollup: used / limit / cost |
| POST | `/checkout` | `X-Tenant-Id` header | creates a Stripe Checkout session for the Pro plan |
| POST | `/webhooks/stripe` | Stripe signature | signature-verified, deduplicated event sync |

(A real product would use proper auth middleware issuing a tenant-scoped token. For this
capstone's bounded scope, `X-Tenant-Id` stands in for "the request is already authenticated" —
called out explicitly as a non-goal below, so the grading is not confused for a missing feature.)

### `POST /generate`

```jsonc
// api call
{ "type": "api_call" }

// ai tokens
{
  "type": "ai_tokens",
  "tokens": { "input": 1200, "cached_input": 400, "output": 300, "reasoning": 150 }
}
```

Response `201`:
```jsonc
{
  "id": "uuid",
  "type": "ai_tokens",
  "cost_micros": 1234,
  "cost_usd": "0.001234",
  "usage_after": { "used": 12345, "limit": 5000000 }
}
```

Response `429` (quota): `{ "error": "quota_exceeded", "message": "..." }`
Response `402` (budget/plan): `{ "error": "budget_exceeded" | "plan_inactive", "message": "..." }`

## 4. Idempotency strategy — the heart of the capstone

Two layers, deliberately separate:

1. **Whole-response idempotency** (`idempotency_keys` table). Every call to `POST /generate`
   is looked up by `(tenant_id, Idempotency-Key)` *before* any quota check or DB write. If a
   row exists:
   - and the request body hashes the same → return the **stored** response verbatim, same
     status code, no new work done.
   - and the request body hashes **differently** → `409 Conflict`. A key must mean "the same
     operation," not "any operation this tenant sends." This is the same rule Stripe's own
     idempotency keys enforce.
2. **Usage-event uniqueness** (`usage_events` unique constraint). Belt-and-suspenders: even if
   the idempotency-key check were somehow bypassed, the DB itself refuses a second usage row
   for the same `(tenant_id, idempotency_key)`.

Both checks and the eventual insert happen inside **one Postgres transaction**, guarded by a
`pg_advisory_xact_lock` keyed on `hash(tenant_id)`. That closes the race a pure "check-then-
insert" design leaves open: two concurrent requests hitting the exact quota boundary at the
same instant must not both be admitted. The lock is per-tenant, so tenants never block each
other.

Stripe webhook idempotency is the same idea with Stripe's own event id
(`stripe_events.stripe_event_id UNIQUE`) as the key, since Stripe explicitly documents that
webhooks can and will be delivered more than once.

## 5. The budget guard

The capstone's shared requirements ask for AI cost to be "tracked, attributed, with a budget
guard" — this is easy to satisfy as a side effect of quota enforcement, but a quota and a
budget are different failure modes and this service treats them as such:

- **Quota** = a count (calls, tokens) fixed by the plan. Exceeding it → `429`, "upgrade to get
  more."
- **Budget** = a dollar ceiling (`plans.monthly_budget_cap_micros`), independent of the quota.
  A tenant could be well under their token quota and still hit their cost cap if their mix of
  token types is expensive (heavy `output`/`reasoning` usage). Exceeding it → `402`,
  "you've spent your cap regardless of quota remaining."

This mirrors how real AI-billing platforms actually work: quota protects the platform,
budget protects the customer from surprise bills.

## 6. Non-goals

- **No real authentication.** `X-Tenant-Id` stands in for a verified session/API key. Building
  real auth (JWT/session, password hashing) is out of scope — it was covered in an earlier
  program assignment, and this capstone's grading is entirely about metering/billing
  correctness, not auth.
- No invoicing, proration, or overage billing in the core (proration is an explicit stretch).
- No real AI model calls — tokens are simulated integers, per the brief.
