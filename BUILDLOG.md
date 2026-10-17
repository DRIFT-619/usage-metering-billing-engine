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

## Phase 3 — Stripe Checkout + signature-verified, deduplicated webhooks

**Where AI helped:**
- Designed and wrote the Checkout session creation, the webhook route (raw-body signature
  verification, event dedup via `stripe_events`, handlers for checkout completed / subscription
  updated / subscription deleted), and the subscription sync service.
- Wrote this code without being able to run it (Stripe's API wasn't reachable from its
  environment), so all debugging happened live against my real Stripe account.
- Misdiagnosed the "plan never updated" bug twice: first as a Stripe "thin event" format issue,
  then as a listener start-order problem. Both guesses were wrong. The real cause was that the
  Stripe CLI was logged into a different Stripe account than the API key in my `.env`, so
  `stripe listen` never saw my checkout events.
- Missed two Stripe account-default changes newer than its knowledge (Managed Payments required a
  tax code or an explicit opt-out), and a route-mounting mistake where the success redirect page
  was wrongly behind the tenant-header middleware.

**What I reviewed and decided:**
- Diagnosed the account mismatch from the evidence myself: the CLI printed a different account id
  than the Stripe error links, and `stripe listen --api-key` fixed it.
- Spotted that a cancelled Pro subscription would leave the tenant stuck on a "canceled" status,
  rejected by `/generate`. Decided cancellation should fall back to a working Free plan, and
  proved it end to end (Free -> Pro -> cancel -> Free -> successful billable call).
- Ran every proof myself: forged signature, real Checkout, event replay, cancellation.

**What I can explain if asked:**
- Why the webhook route uses `express.raw()` and is mounted before `express.json()`.
- Why dedup happens inside the same transaction as the plan update.
- Why the tenant is found via `client_reference_id` on checkout, but via the stored
  `stripe_subscription_id` for later events.
- Why the success/cancel redirect pages can't sit behind the tenant-header middleware.


## Phase 4 — Tests, concurrency proof, background job, finalization

**Where AI helped:**
- Wrote the test suite (pricing, metering, concurrency, usage, webhook, jobs), the test helpers
  (separate `_test` database with a safety check, auto-migration), the `runJob` retry/alert wrapper,
  the free-period rollover job, and the README/EVIDENCE updates.
- Audited the Phase 1–3 repo against the brief and found gaps: `npm test` pointed at a folder that
  did not exist; the concurrency proof was unticked; no background job (shared requirement #3);
  Free tenants' billing period was never advanced after their first month; stray empty files in the
  repo root.
- Its first version of the 999/1000 concurrency test passed even with the advisory lock removed
  (the race window was too narrow). A mutation check caught this, and the test was rewritten to run
  10 rounds.
- Replaced the webhook's SELECT-then-INSERT dedup with `INSERT ... ON CONFLICT DO NOTHING`.
  A new simultaneous-delivery test reproduced the 500 in the old code before the fix.

**What I reviewed and decided:**
- Let the AI choose the order of work and decided that closing the core brief (tests, the
  concurrency proof, the background job) came before any stretch goal.
- Applied every change to my own repo by hand, file by file, rather than pasting a bundle in, and read each new file as I added it.
- Ran `npm test` on my own machine against my own Docker Postgres and pasted the real output into EVIDENCE.md, not the AI's output.
- Ran the mutation check myself: commented out the `pg_advisory_xact_lock` line in
  `meterService.js`, watched the concurrency tests fail, then restored the line and confirmed `git diff` showed no change. This is what convinced me the lock is doing the work, and that the tests can actually fail.
- Checked that no secret is tracked: `git ls-files` shows only `.env.example` and `.env.test` (dummy values), never `.env`.
- Cloned my pushed repo into a fresh folder with no `.env` and followed the README to confirm a stranger can boot it.
- Decided to keep the job alert as a log line plus a `job_failures` row instead of wiring up a real Slack/email alert, and documented that in the README's limitations.

**What I can explain if asked:**
- Why parallel requests for the same tenant can both read "999 used" without the lock.
- Why the webhook claims the event id with ON CONFLICT before running the handler, and why a handler failure rolls the claim back.
- Why the rollover job only touches Free-plan rows, and why it is safe to run twice.