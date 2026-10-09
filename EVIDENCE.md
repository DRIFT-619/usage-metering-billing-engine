# Evidence

One pasted proof per requirement checkbox from the capstone brief's Section 6. Filled in as each phase completes — nothing here is written retroactively from memory.

## Metering

- [x] A billable action creates exactly one usage event, even under retries.
- [x] Proof that double-counting cannot happen.

Same Idempotency-Key ("k-<run>"), same body, sent twice.

$ curl -X POST /generate -H "X-Tenant-Id: f95d6c3f-..." -H "Idempotency-Key: k-<run>" -d '{"type":"api_call"}'
{"type":"api_call","cost_micros":500,"cost_usd":"0.000500","usage_after":{"used":1,"limit":1000},"id":"20f6204c-f338-4e59-9633-66fca5126076"}

$ curl -X POST /generate -H "X-Tenant-Id: f95d6c3f-..." -H "Idempotency-Key: k-<run>" -d '{"type":"api_call"}'
{"id":"20f6204c-f338-4e59-9633-66fca5126076","type":"api_call","cost_usd":"0.000500","cost_micros":500,"usage_after":{"used":1,"limit":1000}}

$ docker exec billing-engine-postgres psql -U billing -d billing_engine -c
"SELECT COUNT(*) FROM usage_events WHERE idempotency_key = 'k-<run>';" <br/>
count
 1

(1 row)


The second call returned the identical `id` and cost — no re-execution, no second row.

## Quotas

- [x] Usage is checked against the tenant's plan; over-limit requests are rejected.
- [x] Responses carry correct status codes (429/402) and a message explaining why. <br/>


Free tenant, ai_token_limit = 100000. Usage sat at 1,800 before this test.

$ curl -X POST /generate ... -d '{"type":"ai_tokens","tokens":{"input":98199}}'
{"cost_micros":294597,"usage_after":{"used":99999,"limit":100000},...}

$ curl -X POST /generate ... -d '{"type":"ai_tokens","tokens":{"input":1}}'
{"cost_micros":3,"usage_after":{"used":100000,"limit":100000},...}

<- landed EXACTLY on the limit, allowed (201)

$ curl -w "\nHTTP %{http_code}\n" -X POST /generate ... -d '{"type":"ai_tokens","tokens":{"input":1}}'
{"error":"quota_exceeded","message":"ai_tokens quota exceeded: 100000/100000 used this period; this request needs 1 more."} <br/>

HTTP 429

<- one token past the limit, rejected. Boundary is exact: 100000 succeeds, 100001 doesn't.

$ curl localhost:3000/usage -H "X-Tenant-Id: f95d6c3f-..."
{"ai_tokens":{"used":100000,"limit":100000}, "cost":{"total_usd":"0.302750",...}}

<- confirms the rejected call left zero trace on the rollup.

## Cost calculation

- [x] Monthly usage rolls up into a cost figure per tenant.
- [x] AI token pricing handles cached input tokens, reasoning tokens, and output pricing correctly.
- [x] Pricing constants pinned in config (`src/config/pricing.js`), with proof of correct totals.

$ curl -X POST /generate ... -d '{"type":"ai_tokens","tokens":{"input":1000,"cached_input":500,"output":200,"reasoning":100}}'
{"cost_micros":7650,"cost_usd":"0.007650","usage_after":{"used":1800,"limit":100000},...}

Hand-check against the pinned constants (src/config/pricing.js):
input: 1000 * 3,000,000 / 1,000,000 = 3000
cached_input: 500 * 300,000 / 1,000,000 = 150
output: 200 *15,000,000 / 1,000,000 = 3000
reasoning: 100 *15,000,000 / 1,000,000 = 1500
total = 3000 + 150 + 3000 + 1500 = 7650 micros — matches cost_micros exactly

## Stripe integration

- [x] Subscription checkout works end-to-end in test mode.
- [x] Webhooks verify signatures, ignore duplicates, update tenant plan/status.

```
# 1. Forged signature -> 400, nothing changes
$ curl -w "\nHTTP %{http_code}\n" -X POST localhost:3000/webhooks/stripe \
    -H "stripe-signature: t=1,v1=bogus" -d '{"fake":"event"}'
{"error":"invalid_signature","message":"No signatures found matching the expected signature for payload. ..."}
HTTP 400

# 2. Real test-mode Checkout (card 4242 4242 4242 4242) -> webhook flips Free -> Pro
# stripe listen output:
--> checkout.session.completed [evt_1UOVPNIZplex4bhsEDzhHR5G]
--> customer.subscription.updated [evt_1UOVPNIZplex4bhszuWLKwhB]
<-- [200] POST http://localhost:3000/webhooks/stripe [evt_1UOVPNIZplex4bhsEDzhHR5G]
<-- [200] POST http://localhost:3000/webhooks/stripe [evt_1UOVPNIZplex4bhszuWLKwhB]

$ curl localhost:3000/usage -H "X-Tenant-Id: f95d6c3f-..."
{"plan":"pro","api_calls":{"used":0,"limit":50000},"ai_tokens":{"used":0,"limit":5000000},...}

$ psql ... "SELECT plan_id, status, stripe_subscription_id FROM subscriptions WHERE tenant_id='f95d6c3f-...';"
 pro | active | sub_1UOVPJIZplex4bhslikUJeJX

# 3. Replay of the same event -> processed once
$ stripe events resend evt_1UOVPNIZplex4bhsEDzhHR5G
# server log:
[stripe webhook] received checkout.session.completed (id: evt_1UOVPNIZplex4bhsEDzhHR5G)
[stripe webhook] evt_1UOVPNIZplex4bhsEDzhHR5G duplicate ignored

$ psql ... "SELECT COUNT(*) FROM stripe_events WHERE stripe_event_id = 'evt_1UOVPNIZplex4bhsEDzhHR5G';"
 count
-------
     1

# 4. Cancelling the subscription -> tenant falls back to a working Free plan
$ stripe subscriptions cancel sub_1UOVPJIZplex4bhslikUJeJX
# stripe listen: --> customer.subscription.deleted [evt_1UOVd5IZplex4bhs7ijGMGXU]  <-- [200]
# server log:    [stripe webhook] evt_1UOVd5IZplex4bhs7ijGMGXU processed

$ curl localhost:3000/usage -H "X-Tenant-Id: f95d6c3f-..."
{"plan":"free","api_calls":{"used":0,"limit":1000},"ai_tokens":{"used":0,"limit":100000},...}

$ curl -X POST localhost:3000/generate ... -d '{"type":"api_call"}'
{"type":"api_call","cost_micros":500,"usage_after":{"used":1,"limit":1000},"id":"076c4b84-..."}
```

## Data model, tests & documentation

- [x] Database includes tenants, plans, subscriptions, usage events; tenant-isolated (every query
      is scoped by `tenant_id`, enforced via the `X-Tenant-Id` -> `resolveTenant` middleware).
- [ ] README + architecture diagram + setup instructions. (final polish, Phase 4)

## Extras (beyond the brief)

- [x] Budget guard: cost cap independent of quota, with a demonstrated 402.
Pro tenant: token quota = 5,000,000; budget cap = $50 (50,000,000 micros).

$ curl -w "\nHTTP %{http_code}\n" -X POST /generate -H "X-Tenant-Id: d40180c1-..."
-d '{"type":"ai_tokens","tokens":{"output":3400000}}'
{"error":"budget_exceeded","message":"Monthly budget cap exceeded: this request would bring spend to $51.000000, cap is $50.00."} <br/>
HTTP 402

3,400,000 tokens is well UNDER the 5,000,000 token quota — proves budget and quota
are two independent checks, not one guard wearing two names.

- [x] Idempotency-key reuse with a different payload → 409 Conflict.

$ curl -X POST /generate -H "Idempotency-Key: k-<run>" -d '{"type":"ai_tokens","tokens":{"input":10}}'

(key "k-<run>" was already used above for an api_call)

{"error":"idempotency_conflict","message":"This Idempotency-Key was already used with a different request body."}


- [ ] Per-tenant advisory lock proven safe under concurrent requests. (concurrency proof planned
      for Phase 4's test suite — a sequential retry proof isn't sufficient evidence for this one)

## Bonus: plan-inactive handling (our own non-goal substitute for real auth)

$ docker exec billing-engine-postgres psql -U billing -d billing_engine -c
"UPDATE subscriptions SET status='past_due' WHERE tenant_id='f95d6c3f-...';" <br/>
UPDATE 1

$ curl -w "\nHTTP %{http_code}\n" -X POST /generate -H "X-Tenant-Id: f95d6c3f-..." -d '{"type":"api_call"}'
{"error":"plan_inactive","message":"Subscription is 'past_due', not active — this action requires an active plan."} <br/>
HTTP 402

$ docker exec billing-engine-postgres psql -U billing -d billing_engine -c
"UPDATE subscriptions SET status='active' WHERE tenant_id='f95d6c3f-...';" <br/>
UPDATE 1