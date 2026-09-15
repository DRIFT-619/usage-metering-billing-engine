# Usage Metering & Billing Engine

The backend service every SaaS needs: meters usage, enforces plan quotas, calculates real
AI-token pricing, and stays in sync with Stripe (test mode) via signature-verified,
idempotent webhooks.

> Capstone project for the FlyRank Backend Internship. See [`DESIGN.md`](./DESIGN.md) for the
> full design doc and [`EVIDENCE.md`](./EVIDENCE.md) for proof of every requirement.

## Architecture

```
Client → POST /generate (Idempotency-Key header)
  → idempotency_keys lookup (same key+body → replay stored response)
  → pg_advisory_xact_lock(tenant_id)
  → quota check (429 if over) → budget check (402 if over)
  → insert usage_event, insert idempotency_keys row, commit
  → 201 { cost, usage_after }

GET /usage → rollup(usage_events) for the tenant's current period

POST /checkout → Stripe Checkout session (test mode) for the Pro plan

Stripe → signed webhook → POST /webhooks/stripe
  → verify signature (bad sig → 400)
  → dedupe by stripe_events.stripe_event_id (replay → no-op)
  → sync tenant's subscription/plan
```

*(diagram will be expanded with an image/ASCII art once the full pipeline is built — Phase 3/4)*

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

## Status

Phase 1 complete (design + schema + skeleton). <br/>
Phases 2–4 in progress.

## Limitations

- No real authentication — `X-Tenant-Id` header stands in for an authenticated session (see
  `DESIGN.md` non-goals).
- No real AI calls — tokens are simulated per the brief.
- No invoicing/proration in the core (proration is a stretch goal).
