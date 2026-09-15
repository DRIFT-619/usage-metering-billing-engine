# Evidence

One pasted proof per requirement checkbox from the capstone brief's Section 6. Filled in as each
phase completes — nothing here is written retroactively from memory.

## Metering

- [ ] A billable action creates exactly one usage event, even under retries.
- [ ] Proof that double-counting cannot happen.

## Quotas

- [ ] Usage is checked against the tenant's plan; over-limit requests are rejected.
- [ ] Responses carry correct status codes (429/402) and an explanatory message.

## Cost calculation

- [ ] Monthly usage rolls up into a cost figure per tenant.
- [ ] AI token pricing handles cached input, reasoning, and output correctly.
- [ ] Pricing constants pinned in config, with proof of correct totals.

## Stripe integration

- [ ] Subscription checkout works end-to-end in test mode.
- [ ] Webhooks verify signatures, ignore duplicates, update tenant plan/status.

## Data model, tests & documentation

- [ ] Database includes tenants, plans, subscriptions, usage events; tenant-isolated.
- [ ] README + architecture diagram + setup instructions.

## Extras (beyond the brief)

- [ ] Budget guard: cost cap independent of quota, with a demonstrated 402.
- [ ] Idempotency-key reuse with a different payload → 409 Conflict.
- [ ] Per-tenant advisory lock proven safe under concurrent requests.
