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

## Status

Phases 1-3 complete (design/schema, idempotent metering with quota + budget enforcement,Stripe Checkout with signature-verified, deduplicated webhooks). <br/>

Phase 4 (tests, polish) in progress.

## Limitations

- No real authentication — `X-Tenant-Id` header stands in for an authenticated session (see
  `DESIGN.md` non-goals).
- No real AI calls — tokens are simulated per the brief.
- No invoicing/proration in the core (proration is a stretch goal).
- Upgrading to Pro starts a fresh billing period, so usage from before the upgrade no longer
  counts toward the new period. There is no proration (a stretch goal).
- Stripe CLI gotcha: `stripe listen` uses whichever account you ran `stripe login` with. If that isn't the account your API key belongs to, events never arrive. Passing `--api-key` fixes it.
