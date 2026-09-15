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