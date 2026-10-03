# Build log — AI usage

Honest record of how AI was used, what I reviewed, and what I can explain. Updated per phase.

## Phase 1 — Design & scaffolding

**Where AI helped:**
- Proposed the data model, the idempotency strategy (whole-response cache + per-tenant advisory
  lock), and generated the first working implementation — schema migration, Express skeleton,
  docker-compose, seed script — from a spec we iterated on together.
- Flagged the budget-guard as an addition beyond the brief's core checklist, since the shared
  requirements table asks for a "cost tracked... with a budget guard" that isn't spelled out in
  Section 6.

**What I reviewed and decided:**
- Set the actual plan numbers, budget caps, repo name, and stack.
- Went through the schema and idempotency design line by line, questioning the reasoning behind
  every choice — why `idempotency_keys` is separate from `usage_events`, why the advisory lock is
  keyed on `tenant_id` alone, why pricing rounds once on the total instead of per-category — until
  I could explain each one unprompted.
- Verified independently rather than trusting the explanation: confirmed `.env` was never tracked
  in git before the first commit, and re-ran the seed script myself to confirm it's actually
  idempotent, not just documented as such.

**What I can explain if asked:**
- Every table's purpose and why it's separate from the others.
- The two-layer idempotency design (response cache + DB constraint) and why neither alone is enough.
- Why quota and budget are enforced as two independent checks, not one.
- Why money is stored as integer micros instead of floats.

## Phase 2 — Idempotent metering, quota + budget enforcement

**Where AI helped:**
- Designed and implemented the transaction flow for `POST /generate`: the per-tenant advisory lock, the idempotency-key lookup/replay/conflict logic, the quota and budget checks, and the usage-event insert, all inside one Postgres transaction.
- Made the key design call that business rejections (quota/budget/plan-inactive) are caught
  inside the transaction and recorded in `idempotency_keys` rather than thrown and rolled back, so a retried rejected request replays the cached rejection instead of re-running the checks.
- Wrote the request validation (zod discriminated union), the tenant-resolution middleware, and the cost-calculation math against the pricing constants pinned in Phase 1.
- Made an arithmetic slip in its own test script (miscounted prior usage when setting up the
  quota-boundary demo), then caught it and reran a corrected 99,999 -> 100,000 -> rejected proof.

**What I reviewed and decided:**
- Walked through why the advisory lock is acquired before the idempotency lookup, not after.
- Questioned why quota and budget are separate checks rather than one combined condition.
- Ran the proof commands myself against a live Postgres and hand-checked the cost math against the pinned pricing constants.

**What I can explain if asked:**
- Why `recordUsage()` never throws for an expected business outcome, only for a genuine bug.
- Why the lock is per-tenant and not global or per-request.
- Why quota's boundary check uses `>` and not `>=`.
- Why the budget guard can fire while token usage is well under quota.