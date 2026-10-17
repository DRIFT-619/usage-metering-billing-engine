# Usage Metering & Billing Engine

The backend service every SaaS needs: meters usage, enforces plan quotas, calculates real
AI-token pricing, and stays in sync with Stripe (test mode) via signature-verified,
idempotent webhooks.

> Capstone project for the FlyRank Backend Internship. See [`DESIGN.md`](./DESIGN.md) for the
> full design doc and [`EVIDENCE.md`](./EVIDENCE.md) for proof of every requirement.

## Architecture

```
  Client ── POST /generate (X-Tenant-Id, Idempotency-Key) ──►
     resolveTenant  → plan + subscription + period
     validate body (zod) → clean 400 on bad input
     BEGIN
       pg_advisory_xact_lock(tenant)        ← serialises per tenant
       idempotency_keys lookup
         same key + same body → replay stored response
         same key + diff body → 409
       rollup(usage_events) for current period
       quota check  (used + qty > limit → 429)
       budget check (spend + cost > cap → 402)
       INSERT usage_event + idempotency_keys row
     COMMIT → 201 { id, cost, usage_after }

  Client ── GET /usage ──► rollup(usage_events) → { used, limit, cost }

  Client ── POST /checkout ──► Stripe Checkout session (test mode)

  Stripe ── signed webhook ──► POST /webhooks/stripe (raw body)
     verify signature (forged → 400, no changes)
     BEGIN
       INSERT stripe_events ON CONFLICT DO NOTHING (conflict → duplicate, ignored)
       sync tenant plan / status
     COMMIT

  Background (src/jobs):  scheduler ─► runJob (retries + backoff)
                              └─► rolloverFreePeriods (hourly)
                          retries exhausted → [ALERT] log + job_failures row
```

## Plans

| Plan | API calls / month | AI tokens / month | Budget cap |
|---|---|---|---|
| Free | 1,000 | 100,000 | $5.00 |
| Pro | 50,000 | 5,000,000 | $50.00 |

## Setup

```bash
git clone <this-repo>
cd usage-metering-billing-engine
cp .env.example .env          # fill in Stripe test keys once you reach Phase 3
npm install
docker compose up -d          # starts Postgres
npm run migrate:up
npm run seed                  # creates the 2 plans + 2 demo tenants
npm run dev                   # http://localhost:3000
```

Verify it's alive:
```bash
curl http://localhost:3000/health
```

## Stripe setup (test mode)

1. Create a recurring product in the Stripe dashboard (test mode) and copy its **Price ID**.
2. Put `STRIPE_SECRET_KEY` and `STRIPE_PRO_PRICE_ID` in `.env`, then run `npm run seed` again so
   the Pro plan row picks up the price id.
3. Forward webhooks, using the key from your `.env` so the CLI uses the same Stripe account:
```bash
   stripe listen --api-key "$(grep '^STRIPE_SECRET_KEY=' .env | tail -1 | cut -d= -f2-)" \
     --events checkout.session.completed,customer.subscription.updated,customer.subscription.deleted \
     --forward-to localhost:3000/webhooks/stripe
```
4. Copy the printed `whsec_...` into `STRIPE_WEBHOOK_SECRET` and restart the server.
5. `POST /checkout` with an `X-Tenant-Id` header returns a `checkout_url`. Pay with
   `4242 4242 4242 4242`, any future expiry, any CVC.

## Tests

```bash
docker compose up -d     # Postgres must be running
npm test                 # needs Node 22+
```

`npm test` creates a separate `billing_engine_test` database on the same Postgres, runs the
migrations, and runs the whole suite (~3 s). It refuses to run against any database whose name
doesn't end in `_test`, so it can never wipe your dev data. No Stripe account is needed: the
webhook tests sign their own events with a dummy secret.

| File | What it proves |
|---|---|
| `test/pricing.test.js` | Cached-input and reasoning-token rules; the documented mix = exactly 7650 micros |
| `test/metering.test.js` | Same key twice = one event; 409 on key reuse; exact quota boundary (429); budget 402; clean 4xx on bad input |
| `test/concurrency.test.js` | 20 parallel requests at 999/1000 admit exactly one; parallel retries of one key make one event |
| `test/usage.test.js` | `GET /usage` matches the pinned prices; rejected calls leave no trace; tenant isolation |
| `test/webhook.test.js` | Forged/tampered signature = 400; replay processed once; simultaneous duplicates processed once; cancel falls back to Free |
| `test/jobs.test.js` | Retry + backoff; alert row after retries are exhausted; period rollover is idempotent |

## Background jobs

`src/jobs/` runs `rolloverFreePeriods` at boot and then hourly. Free subscriptions have no Stripe subscription to tell us when a new month starts, so without this job a Free tenant's period would freeze at the month it was created. Every job runs through `runJob()`: up to 3 attempts with exponential backoff (0.5 s, 1 s), and if all attempts fail it logs an `[ALERT]` line and writes a row to `job_failures`. Trigger it by hand with `npm run job:rollover`.

## Status

All four phases of the core brief are complete: design/schema, idempotent metering with quota and budget enforcement, Stripe Checkout with signature-verified and deduplicated webhooks, and cost rollups with a test suite. See [`EVIDENCE.md`](./EVIDENCE.md) for proof of each requirement.

## Limitations

- No real authentication — `X-Tenant-Id` header stands in for an authenticated session (see
  `DESIGN.md` non-goals).
- No real AI calls — tokens are simulated per the brief.
- No invoicing/proration in the core (proration is a stretch goal).
- Upgrading to Pro starts a fresh billing period, so usage from before the upgrade no longer
  counts toward the new period. There is no proration (a stretch goal).
- Stripe CLI gotcha: `stripe listen` uses whichever account you ran `stripe login` with. If that isn't the account your API key belongs to, events never arrive. Passing `--api-key` fixes it.
- The job alert is a log line plus a `job_failures` row, not a real page/Slack message.
- The scheduler runs inside the API process. With several server instances each would run it; the rollover query is idempotent, so that is safe, but a real deployment would use a dedicated worker.