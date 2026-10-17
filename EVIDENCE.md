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
- [x] README + architecture diagram + setup instructions (see README.md; `npm test` section added in Phase 4).

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


- [x] Per-tenant advisory lock proven safe under concurrent requests. See "Phase 4 proofs" below.

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


## Phase 4 proofs (automated)

All proofs below are produced by `npm test` (Node's built-in test runner, real Postgres, real HTTP).

```
$ npm test


> usage-metering-billing-engine@1.0.0 test
> dotenv -e .env.test -- node --test --test-concurrency=1 "test/**/*.test.js"

POST /generate 201 144 - 198.597 ms
POST /generate 429 118 - 62.483 ms
POST /generate 429 118 - 73.372 ms
POST /generate 429 118 - 79.794 ms
POST /generate 429 118 - 86.574 ms
POST /generate 429 118 - 92.568 ms
POST /generate 429 118 - 98.797 ms
POST /generate 429 118 - 104.477 ms
POST /generate 429 118 - 108.314 ms
POST /generate 429 118 - 114.115 ms
POST /generate 429 118 - 119.969 ms
POST /generate 429 118 - 131.275 ms
POST /generate 429 118 - 132.244 ms
POST /generate 429 118 - 136.973 ms
POST /generate 429 118 - 139.183 ms
POST /generate 429 118 - 145.642 ms
POST /generate 429 118 - 150.878 ms
POST /generate 429 118 - 152.428 ms
POST /generate 429 118 - 153.786 ms
POST /generate 429 118 - 158.292 ms
POST /generate 201 144 - 18.708 ms
POST /generate 429 118 - 22.487 ms
POST /generate 429 118 - 26.454 ms
POST /generate 429 118 - 30.285 ms
POST /generate 429 118 - 34.367 ms
POST /generate 429 118 - 38.536 ms
POST /generate 429 118 - 42.571 ms
POST /generate 429 118 - 46.368 ms
POST /generate 429 118 - 50.487 ms
POST /generate 429 118 - 54.364 ms
POST /generate 429 118 - 58.355 ms
POST /generate 429 118 - 62.186 ms
POST /generate 429 118 - 65.949 ms
POST /generate 429 118 - 69.393 ms
POST /generate 429 118 - 72.944 ms
POST /generate 429 118 - 77.438 ms
POST /generate 429 118 - 80.221 ms
POST /generate 429 118 - 83.659 ms
POST /generate 429 118 - 87.884 ms
POST /generate 429 118 - 92.706 ms
POST /generate 201 144 - 17.431 ms
POST /generate 429 118 - 24.167 ms
POST /generate 429 118 - 30.503 ms
POST /generate 429 118 - 35.099 ms
POST /generate 429 118 - 39.611 ms
POST /generate 429 118 - 43.246 ms
POST /generate 429 118 - 49.904 ms
POST /generate 429 118 - 58.035 ms
POST /generate 429 118 - 62.873 ms
POST /generate 429 118 - 66.428 ms
POST /generate 429 118 - 70.272 ms
POST /generate 429 118 - 74.803 ms
POST /generate 429 118 - 78.312 ms
POST /generate 429 118 - 82.193 ms
POST /generate 429 118 - 86.221 ms
POST /generate 429 118 - 89.983 ms
POST /generate 429 118 - 90.166 ms
POST /generate 429 118 - 93.373 ms
POST /generate 429 118 - 96.956 ms
POST /generate 429 118 - 100.987 ms
POST /generate 201 144 - 14.965 ms
POST /generate 429 118 - 18.768 ms
POST /generate 429 118 - 23.209 ms
POST /generate 429 118 - 24.627 ms
POST /generate 429 118 - 29.243 ms
POST /generate 429 118 - 33.190 ms
POST /generate 429 118 - 37.329 ms
POST /generate 429 118 - 41.228 ms
POST /generate 429 118 - 45.187 ms
POST /generate 429 118 - 49.447 ms
POST /generate 429 118 - 53.056 ms
POST /generate 429 118 - 56.683 ms
POST /generate 429 118 - 60.323 ms
POST /generate 429 118 - 64.717 ms
POST /generate 429 118 - 68.105 ms
POST /generate 429 118 - 72.086 ms
POST /generate 429 118 - 76.058 ms
POST /generate 429 118 - 80.641 ms
POST /generate 429 118 - 84.663 ms
POST /generate 429 118 - 88.745 ms
POST /generate 201 144 - 15.012 ms
POST /generate 429 118 - 17.388 ms
POST /generate 429 118 - 21.305 ms
POST /generate 429 118 - 23.447 ms
POST /generate 429 118 - 27.354 ms
POST /generate 429 118 - 32.037 ms
POST /generate 429 118 - 34.558 ms
POST /generate 429 118 - 37.977 ms
POST /generate 429 118 - 42.112 ms
POST /generate 429 118 - 45.768 ms
POST /generate 429 118 - 50.065 ms
POST /generate 429 118 - 52.314 ms
POST /generate 429 118 - 56.109 ms
POST /generate 429 118 - 59.385 ms
POST /generate 429 118 - 64.579 ms
POST /generate 429 118 - 67.091 ms
POST /generate 429 118 - 70.901 ms
POST /generate 429 118 - 73.962 ms
POST /generate 429 118 - 77.712 ms
POST /generate 429 118 - 81.286 ms
POST /generate 201 144 - 20.160 ms
POST /generate 429 118 - 23.971 ms
POST /generate 429 118 - 29.247 ms
POST /generate 429 118 - 31.263 ms
POST /generate 429 118 - 35.943 ms
POST /generate 429 118 - 39.147 ms
POST /generate 429 118 - 43.297 ms
POST /generate 429 118 - 47.234 ms
POST /generate 429 118 - 50.820 ms
POST /generate 429 118 - 54.622 ms
POST /generate 429 118 - 58.425 ms
POST /generate 429 118 - 61.537 ms
POST /generate 429 118 - 65.229 ms
POST /generate 429 118 - 68.692 ms
POST /generate 429 118 - 71.667 ms
POST /generate 429 118 - 75.427 ms
POST /generate 429 118 - 79.528 ms
POST /generate 429 118 - 82.560 ms
POST /generate 429 118 - 86.329 ms
POST /generate 429 118 - 89.174 ms
POST /generate 201 144 - 14.480 ms
POST /generate 429 118 - 17.833 ms
POST /generate 429 118 - 21.727 ms
POST /generate 429 118 - 24.613 ms
POST /generate 429 118 - 27.977 ms
POST /generate 429 118 - 30.714 ms
POST /generate 429 118 - 34.473 ms
POST /generate 429 118 - 38.229 ms
POST /generate 429 118 - 41.085 ms
POST /generate 429 118 - 44.381 ms
POST /generate 429 118 - 46.836 ms
POST /generate 429 118 - 50.636 ms
POST /generate 429 118 - 53.251 ms
POST /generate 429 118 - 56.606 ms
POST /generate 429 118 - 60.055 ms
POST /generate 429 118 - 63.791 ms
POST /generate 429 118 - 67.904 ms
POST /generate 429 118 - 71.274 ms
POST /generate 429 118 - 75.686 ms
POST /generate 429 118 - 79.712 ms
POST /generate 201 144 - 12.088 ms
POST /generate 429 118 - 15.837 ms
POST /generate 429 118 - 19.580 ms
POST /generate 429 118 - 22.433 ms
POST /generate 429 118 - 25.902 ms
POST /generate 429 118 - 29.052 ms
POST /generate 429 118 - 32.343 ms
POST /generate 429 118 - 34.913 ms
POST /generate 429 118 - 37.984 ms
POST /generate 429 118 - 41.725 ms
POST /generate 429 118 - 44.621 ms
POST /generate 429 118 - 47.617 ms
POST /generate 429 118 - 51.134 ms
POST /generate 429 118 - 54.474 ms
POST /generate 429 118 - 57.990 ms
POST /generate 429 118 - 61.992 ms
POST /generate 429 118 - 69.262 ms
POST /generate 429 118 - 72.862 ms
POST /generate 429 118 - 76.995 ms
POST /generate 429 118 - 79.898 ms
POST /generate 201 144 - 12.587 ms
POST /generate 429 118 - 17.901 ms
POST /generate 429 118 - 21.646 ms
POST /generate 429 118 - 24.994 ms
POST /generate 429 118 - 28.752 ms
POST /generate 429 118 - 33.291 ms
POST /generate 429 118 - 36.451 ms
POST /generate 429 118 - 40.122 ms
POST /generate 429 118 - 44.240 ms
POST /generate 429 118 - 48.441 ms
POST /generate 429 118 - 50.927 ms
POST /generate 429 118 - 54.244 ms
POST /generate 429 118 - 57.665 ms
POST /generate 429 118 - 61.070 ms
POST /generate 429 118 - 64.286 ms
POST /generate 429 118 - 67.570 ms
POST /generate 429 118 - 71.381 ms
POST /generate 429 118 - 74.843 ms
POST /generate 429 118 - 78.028 ms
POST /generate 429 118 - 81.100 ms
POST /generate 201 144 - 17.466 ms
POST /generate 429 118 - 21.395 ms
POST /generate 429 118 - 26.433 ms
POST /generate 429 118 - 27.770 ms
POST /generate 429 118 - 31.839 ms
POST /generate 429 118 - 34.404 ms
POST /generate 429 118 - 38.879 ms
POST /generate 429 118 - 42.453 ms
POST /generate 429 118 - 44.443 ms
POST /generate 429 118 - 48.018 ms
POST /generate 429 118 - 51.831 ms
POST /generate 429 118 - 55.196 ms
POST /generate 429 118 - 59.076 ms
POST /generate 429 118 - 62.476 ms
POST /generate 429 118 - 66.829 ms
POST /generate 429 118 - 70.351 ms
POST /generate 429 118 - 73.149 ms
POST /generate 429 118 - 77.468 ms
POST /generate 429 118 - 81.612 ms
POST /generate 429 118 - 85.717 ms
✔ 20 simultaneous requests at 999/1000 -> exactly ONE is admitted (10 rounds) (1934.7921ms)
POST /generate 201 141 - 12.829 ms
POST /generate 201 141 - 14.445 ms
POST /generate 201 141 - 16.993 ms
POST /generate 201 141 - 17.436 ms
POST /generate 201 141 - 18.547 ms
POST /generate 201 141 - 18.762 ms
POST /generate 201 141 - 20.775 ms
POST /generate 201 141 - 22.997 ms
POST /generate 201 141 - 23.030 ms
POST /generate 201 141 - 24.977 ms
✔ 10 simultaneous retries of ONE key -> one event, ten identical responses (103.5202ms)
POST /generate 201 149 - 16.896 ms
POST /generate 201 149 - 21.579 ms
POST /generate 201 149 - 27.271 ms
POST /generate 429 125 - 30.960 ms
POST /generate 429 125 - 35.730 ms
POST /generate 429 125 - 40.571 ms
POST /generate 429 125 - 43.390 ms
POST /generate 429 125 - 48.718 ms
POST /generate 429 125 - 49.043 ms
POST /generate 429 125 - 53.244 ms
✔ concurrent token requests can never overshoot the token quota (173.0421ms)
✔ runJob: succeeds on the first try without alerting (137.9991ms)
[job:flaky-job] attempt 1/3 failed: boom
[job:flaky-job] attempt 2/3 failed: boom
✔ runJob: retries with exponential backoff, then succeeds (79.3354ms)
[job:doomed-job] attempt 1/3 failed: always broken
[job:doomed-job] attempt 2/3 failed: always broken
[job:doomed-job] attempt 3/3 failed: always broken
[ALERT] job "doomed-job" failed after 3 attempts: always broken
✔ runJob: after exhausting retries it raises an alert row and does NOT throw (89.819ms)
✔ rollover: an expired Free period is advanced to the current month (111.6299ms)
✔ rollover: is idempotent — a second run changes nothing (124.8153ms)
✔ rollover: Stripe-managed subscriptions are left to the webhook (107.948ms)
✔ rollover: a still-valid period is not touched (101.3177ms)
✔ rollover: a Free tenant that cancelled Pro (stripe_subscription_id still set) still rolls over (94.0447ms)
POST /generate 201 141 - 25.290 ms
POST /generate 201 141 - 6.648 ms
✔ PROBE 1: same Idempotency-Key twice -> exactly one usage event, identical response (214.4475ms)
POST /generate 201 141 - 7.890 ms
POST /generate 409 113 - 6.132 ms
✔ same key + different body -> 409 and nothing is recorded (109.1517ms)
POST /generate 201 141 - 7.125 ms
POST /generate 201 141 - 7.023 ms
✔ same key is independent across tenants (128.0911ms)
POST /generate 201 144 - 8.486 ms
POST /generate 429 118 - 6.386 ms
✔ PROBE 2 (api_call): 1000th call is allowed, 1001st is 429 (137.7681ms)
POST /generate 201 147 - 7.782 ms
POST /generate 429 123 - 6.246 ms
✔ PROBE 2 (ai_tokens): exactly 100000 allowed, 100001 rejected (102.8568ms)
POST /generate 429 118 - 8.100 ms
POST /generate 429 118 - 4.918 ms
✔ a rejected request is cached: retrying its key replays the 429 (143.2168ms)
POST /generate 402 129 - 7.423 ms
✔ budget cap returns 402 even though the token quota still has room (96.1447ms)
POST /generate 402 117 - 6.814 ms
✔ non-active subscription -> 402 plan_inactive (92.887ms)
[error] ValidationError: Idempotency-Key header is required
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\routes\generate.js:16:13
    at Layer.handle [as handle_request] (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\layer.js:95:5)
    at next (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\route.js:149:13)
    at Route.dispatch (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\route.js:119:3)
    at Layer.handle [as handle_request] (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\layer.js:95:5)
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:284:15
    at router.process_params (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:346:12)
    at next (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:280:10)
    at router.handle (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:175:3)
    at router (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:47:12) {
  statusCode: 400,
  code: 'validation_error'
}
POST /generate 400 75 - 1.829 ms
[error] ValidationError: Invalid discriminator value. Expected 'api_call' | 'ai_tokens'
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\routes\generate.js:21:13
    at Layer.handle [as handle_request] (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\layer.js:95:5)
    at next (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\route.js:149:13)
    at Route.dispatch (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\route.js:119:3)
    at Layer.handle [as handle_request] (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\layer.js:95:5)
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:284:15
    at router.process_params (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:346:12)
    at next (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:280:10)
    at router.handle (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:175:3)
    at router (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:47:12) {
  statusCode: 400,
  code: 'validation_error'
}
POST /generate 400 103 - 2.075 ms
[error] ValidationError: Number must be greater than or equal to 0; tokens must include at least one non-zero category
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\routes\generate.js:21:13
    at Layer.handle [as handle_request] (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\layer.js:95:5)
    at next (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\route.js:149:13)
    at Route.dispatch (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\route.js:119:3)
    at Layer.handle [as handle_request] (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\layer.js:95:5)
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:284:15
    at router.process_params (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:346:12)
    at next (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:280:10)
    at router.handle (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:175:3)
    at router (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:47:12) {
  statusCode: 400,
  code: 'validation_error'
}
POST /generate 400 134 - 2.026 ms
[error] ValidationError: tokens must include at least one non-zero category
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\routes\generate.js:21:13
    at Layer.handle [as handle_request] (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\layer.js:95:5)
    at next (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\route.js:149:13)
    at Route.dispatch (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\route.js:119:3)
    at Layer.handle [as handle_request] (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\layer.js:95:5)
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:284:15
    at router.process_params (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:346:12)
    at next (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:280:10)
    at router.handle (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:175:3)
    at router (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:47:12) {
  statusCode: 400,
  code: 'validation_error'
}
POST /generate 400 91 - 2.003 ms
[error] MissingTenantHeaderError: X-Tenant-Id header is required
    at resolveTenant (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\middleware\resolveTenant.js:10:13)
    at Layer.handle [as handle_request] (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\layer.js:95:5)
    at trim_prefix (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:328:13)
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:286:9
    at router.process_params (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:346:12)
    at next (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:280:10)
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\body-parser\lib\read.js:137:5
    at AsyncResource.runInAsyncScope (node:async_hooks:227:14)
    at invokeCallback (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\raw-body\index.js:238:16)
    at done (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\raw-body\index.js:227:7) {
  statusCode: 400,
  code: 'missing_tenant_header'
}
POST /generate 400 76 - 0.563 ms
[error] ValidationError: X-Tenant-Id must be a valid UUID
    at resolveTenant (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\middleware\resolveTenant.js:71:19)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5) {
  statusCode: 400,
  code: 'validation_error'
}
POST /generate 400 73 - 2.190 ms
[error] TenantNotFoundError: No tenant found for id 00000000-0000-0000-0000-000000000000
    at resolveTenant (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\middleware\resolveTenant.js:37:13)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5) {
  statusCode: 404,
  code: 'tenant_not_found'
}
POST /generate 404 100 - 15.359 ms
✔ bad input is a clean 4xx, never a 500 (169.1333ms)
✔ the documented mix prices to exactly 7650 micros (1.417ms)
✔ cached input is 10x cheaper than fresh input (0.1323ms)
✔ reasoning tokens are billed at the output rate (0.1115ms)
✔ categories are priced separately, not added then priced once (0.1678ms)
✔ rounding happens once on the total, not per category (0.1374ms)
✔ an API call costs the pinned nominal amount (0.1056ms)
POST /generate 201 148 - 26.083 ms
POST /generate 201 141 - 11.314 ms
GET /usage 200 349 - 3.359 ms
✔ PROBE 5: GET /usage matches the pinned pricing constants exactly (498.4257ms)
GET /usage 200 351 - 2.769 ms
POST /generate 429 118 - 7.742 ms
GET /usage 200 351 - 2.064 ms
✔ a rejected request leaves no trace in /usage (166.6123ms)
POST /generate 201 141 - 10.631 ms
GET /usage 200 338 - 2.639 ms
✔ usage is isolated per tenant (143.4051ms)
GET /usage 200 338 - 2.532 ms
✔ events outside the current period are not counted (139.396ms)
[stripe webhook] signature verification failed: No signatures found matching the expected signature for payload. Are you passing the raw request body you received from Stripe? 
 If a webhook request is being forwarded by a third-party tool, ensure that the exact request body, including JSON formatting and new line style, is preserved.

Learn more about webhook signing and explore webhook integration examples for various frameworks at https://github.com/stripe/stripe-node#webhook-signing

POST /webhooks/stripe 400 490 - 4.122 ms
✔ PROBE 4: forged signature -> 400 and nothing changes (172.0575ms)
[stripe webhook] signature verification failed: No stripe-signature header value was provided.
POST /webhooks/stripe 400 88 - 0.563 ms
✔ a missing signature header is also a 400 (92.6166ms)
[stripe webhook] signature verification failed: No signatures found matching the expected signature for payload. Are you passing the raw request body you received from Stripe? 
 If a webhook request is being forwarded by a third-party tool, ensure that the exact request body, including JSON formatting and new line style, is preserved.

Learn more about webhook signing and explore webhook integration examples for various frameworks at https://github.com/stripe/stripe-node#webhook-signing

POST /webhooks/stripe 400 490 - 0.560 ms
✔ a valid signature on a TAMPERED body is rejected (109.9708ms)
[stripe webhook] received customer.subscription.updated (id: evt_up_1)
[stripe webhook] evt_up_1 processed
POST /webhooks/stripe 200 34 - 6.142 ms
GET /usage 200 340 - 6.697 ms
[stripe webhook] received customer.subscription.updated (id: evt_up_1)
[stripe webhook] evt_up_1 duplicate ignored
POST /webhooks/stripe 200 35 - 2.204 ms
✔ PROBE 3/4: a verified event flips Free -> Pro, and replaying it is processed once (135.1031ms)
[stripe webhook] received customer.subscription.updated (id: evt_race)
[stripe webhook] received customer.subscription.updated (id: evt_race)
[stripe webhook] received customer.subscription.updated (id: evt_race)
[stripe webhook] received customer.subscription.updated (id: evt_race)
[stripe webhook] evt_race processed
POST /webhooks/stripe 200 34 - 11.912 ms
[stripe webhook] evt_race duplicate ignored
POST /webhooks/stripe 200 35 - 18.104 ms
[stripe webhook] evt_race duplicate ignored
POST /webhooks/stripe 200 35 - 17.681 ms
[stripe webhook] evt_race duplicate ignored
POST /webhooks/stripe 200 35 - 20.675 ms
✔ two SIMULTANEOUS deliveries of the same event -> both 200, processed exactly once (103.8351ms)
[stripe webhook] received customer.subscription.deleted (id: evt_del)
[stripe webhook] evt_del processed
POST /webhooks/stripe 200 34 - 6.933 ms
POST /generate 201 141 - 23.713 ms
✔ subscription.deleted falls back to a working Free plan (128.9316ms)
[stripe webhook] received customer.subscription.updated (id: evt_pd)
[stripe webhook] evt_pd processed
POST /webhooks/stripe 200 34 - 28.451 ms
POST /generate 402 117 - 12.843 ms
✔ past_due from Stripe blocks /generate with 402 (145.8159ms)
[stripe webhook] received customer.subscription.updated (id: evt_x)
[stripe sync] no tenant found for subscription sub_unknown, skipping
[stripe webhook] evt_x processed
POST /webhooks/stripe 200 34 - 4.361 ms
✔ an event for an unknown subscription is acknowledged without touching anyone (85.2926ms)
ℹ tests 38
ℹ suites 0
ℹ pass 38
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 15124.126

```

### Concurrency: the advisory lock is what makes it safe

`test/concurrency.test.js` fires 20 simultaneous `/generate` calls (distinct keys) at a tenant
sitting at 999/1000 calls, repeated for 10 rounds on fresh tenants. Expected every round:
exactly 1 admitted (201), 19 rejected (429), and exactly 1000 rows in `usage_events`.

Mutation check: to prove the test can actually fail, comment out the
`pg_advisory_xact_lock(...)` line in `src/services/meterService.js` and re-run `npm test`:

```
$ npm test        # with the lock line commented out


> usage-metering-billing-engine@1.0.0 test
> dotenv -e .env.test -- node --test --test-concurrency=1 "test/**/*.test.js"

POST /generate 201 144 - 205.730 ms
POST /generate 429 118 - 69.323 ms
POST /generate 201 144 - 70.793 ms
POST /generate 429 118 - 71.574 ms
POST /generate 429 118 - 74.538 ms
POST /generate 429 118 - 79.703 ms
POST /generate 429 118 - 81.305 ms
POST /generate 429 118 - 89.629 ms
POST /generate 429 118 - 91.197 ms
POST /generate 429 118 - 91.905 ms
POST /generate 429 118 - 98.514 ms
POST /generate 429 118 - 96.462 ms
POST /generate 429 118 - 92.628 ms
POST /generate 429 118 - 96.505 ms
POST /generate 429 118 - 99.821 ms
POST /generate 429 118 - 103.666 ms
POST /generate 429 118 - 107.370 ms
POST /generate 429 118 - 107.761 ms
POST /generate 429 118 - 111.618 ms
POST /generate 429 118 - 109.211 ms
✖ 20 simultaneous requests at 999/1000 -> exactly ONE is admitted (10 rounds) (508.6145ms)
POST /generate 201 141 - 19.266 ms
[error] error: duplicate key value violates unique constraint "usage_events_tenant_idempotency_unique"
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\pg\lib\client.js:694:17
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async Object.recordUsage (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\services\meterService.js:118:22)
    at async withTransaction (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\db\pool.js:22:20)
    at async D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\routes\generate.js:32:20 {
  length: 312,
  severity: 'ERROR',
  code: '23505',
  detail: 'Key (tenant_id, idempotency_key)=(fba8a9d1-a424-4f2d-a6e1-d4eaab88db1b, same-key) already exists.',
  hint: undefined,
  position: undefined,
  internalPosition: undefined,
  internalQuery: undefined,
  where: undefined,
  schema: 'public',
  table: 'usage_events',
  column: undefined,
  dataType: undefined,
  constraint: 'usage_events_tenant_idempotency_unique',
  file: 'nbtinsert.c',
  line: '666',
  routine: '_bt_check_unique'
}
POST /generate 500 51 - 19.801 ms
POST /generate 500 51 - 24.776 ms
[error] error: duplicate key value violates unique constraint "usage_events_tenant_idempotency_unique"
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\pg\lib\client.js:694:17
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async Object.recordUsage (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\services\meterService.js:118:22)
    at async withTransaction (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\db\pool.js:22:20)
    at async D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\routes\generate.js:32:20 {
  length: 312,
  severity: 'ERROR',
  code: '23505',
  detail: 'Key (tenant_id, idempotency_key)=(fba8a9d1-a424-4f2d-a6e1-d4eaab88db1b, same-key) already exists.',
  hint: undefined,
  position: undefined,
  internalPosition: undefined,
  internalQuery: undefined,
  where: undefined,
  schema: 'public',
  table: 'usage_events',
  column: undefined,
  dataType: undefined,
  constraint: 'usage_events_tenant_idempotency_unique',
  file: 'nbtinsert.c',
  line: '666',
  routine: '_bt_check_unique'
}
[error] error: duplicate key value violates unique constraint "usage_events_tenant_idempotency_unique"
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\pg\lib\client.js:694:17
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async Object.recordUsage (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\services\meterService.js:118:22)
    at async withTransaction (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\db\pool.js:22:20)
    at async D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\routes\generate.js:32:20 {
  length: 312,
  severity: 'ERROR',
  code: '23505',
  detail: 'Key (tenant_id, idempotency_key)=(fba8a9d1-a424-4f2d-a6e1-d4eaab88db1b, same-key) already exists.',
  hint: undefined,
  position: undefined,
  internalPosition: undefined,
  internalQuery: undefined,
  where: undefined,
  schema: 'public',
  table: 'usage_events',
  column: undefined,
  dataType: undefined,
  constraint: 'usage_events_tenant_idempotency_unique',
  file: 'nbtinsert.c',
  line: '666',
  routine: '_bt_check_unique'
}
POST /generate 500 51 - 23.636 ms
POST /generate 500 51 - 21.877 ms
[error] error: duplicate key value violates unique constraint "usage_events_tenant_idempotency_unique"
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\pg\lib\client.js:694:17
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async Object.recordUsage (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\services\meterService.js:118:22)
    at async withTransaction (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\db\pool.js:22:20)
    at async D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\routes\generate.js:32:20 {
  length: 312,
  severity: 'ERROR',
  code: '23505',
  detail: 'Key (tenant_id, idempotency_key)=(fba8a9d1-a424-4f2d-a6e1-d4eaab88db1b, same-key) already exists.',
  hint: undefined,
  position: undefined,
  internalPosition: undefined,
  internalQuery: undefined,
  where: undefined,
  schema: 'public',
  table: 'usage_events',
  column: undefined,
  dataType: undefined,
  constraint: 'usage_events_tenant_idempotency_unique',
  file: 'nbtinsert.c',
  line: '666',
  routine: '_bt_check_unique'
}
[error] error: duplicate key value violates unique constraint "usage_events_tenant_idempotency_unique"
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\pg\lib\client.js:694:17
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async Object.recordUsage (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\services\meterService.js:118:22)
    at async withTransaction (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\db\pool.js:22:20)
    at async D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\routes\generate.js:32:20 {
  length: 312,
  severity: 'ERROR',
  code: '23505',
  detail: 'Key (tenant_id, idempotency_key)=(fba8a9d1-a424-4f2d-a6e1-d4eaab88db1b, same-key) already exists.',
  hint: undefined,
  position: undefined,
  internalPosition: undefined,
  internalQuery: undefined,
  where: undefined,
  schema: 'public',
  table: 'usage_events',
  column: undefined,
  dataType: undefined,
  constraint: 'usage_events_tenant_idempotency_unique',
  file: 'nbtinsert.c',
  line: '666',
  routine: '_bt_check_unique'
}
POST /generate 500 51 - 22.250 ms
[error] error: duplicate key value violates unique constraint "usage_events_tenant_idempotency_unique"
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\pg\lib\client.js:694:17
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async Object.recordUsage (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\services\meterService.js:118:22)
    at async withTransaction (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\db\pool.js:22:20)
    at async D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\routes\generate.js:32:20 {
  length: 312,
  severity: 'ERROR',
  code: '23505',
  detail: 'Key (tenant_id, idempotency_key)=(fba8a9d1-a424-4f2d-a6e1-d4eaab88db1b, same-key) already exists.',
  hint: undefined,
  position: undefined,
  internalPosition: undefined,
  internalQuery: undefined,
  where: undefined,
  schema: 'public',
  table: 'usage_events',
  column: undefined,
  dataType: undefined,
  constraint: 'usage_events_tenant_idempotency_unique',
  file: 'nbtinsert.c',
  line: '666',
  routine: '_bt_check_unique'
}
POST /generate 500 51 - 25.143 ms
POST /generate 500 51 - 27.393 ms
[error] error: duplicate key value violates unique constraint "usage_events_tenant_idempotency_unique"
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\pg\lib\client.js:694:17
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async Object.recordUsage (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\services\meterService.js:118:22)
    at async withTransaction (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\db\pool.js:22:20)
    at async D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\routes\generate.js:32:20 {
  length: 312,
  severity: 'ERROR',
  code: '23505',
  detail: 'Key (tenant_id, idempotency_key)=(fba8a9d1-a424-4f2d-a6e1-d4eaab88db1b, same-key) already exists.',
  hint: undefined,
  position: undefined,
  internalPosition: undefined,
  internalQuery: undefined,
  where: undefined,
  schema: 'public',
  table: 'usage_events',
  column: undefined,
  dataType: undefined,
  constraint: 'usage_events_tenant_idempotency_unique',
  file: 'nbtinsert.c',
  line: '666',
  routine: '_bt_check_unique'
}
[error] error: duplicate key value violates unique constraint "usage_events_tenant_idempotency_unique"
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\pg\lib\client.js:694:17
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async Object.recordUsage (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\services\meterService.js:118:22)
    at async withTransaction (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\db\pool.js:22:20)
    at async D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\routes\generate.js:32:20 {
  length: 312,
  severity: 'ERROR',
  code: '23505',
  detail: 'Key (tenant_id, idempotency_key)=(fba8a9d1-a424-4f2d-a6e1-d4eaab88db1b, same-key) already exists.',
  hint: undefined,
  position: undefined,
  internalPosition: undefined,
  internalQuery: undefined,
  where: undefined,
  schema: 'public',
  table: 'usage_events',
  column: undefined,
  dataType: undefined,
  constraint: 'usage_events_tenant_idempotency_unique',
  file: 'nbtinsert.c',
  line: '666',
  routine: '_bt_check_unique'
}
POST /generate 500 51 - 25.663 ms
POST /generate 500 51 - 25.309 ms
[error] error: duplicate key value violates unique constraint "usage_events_tenant_idempotency_unique"
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\pg\lib\client.js:694:17
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async Object.recordUsage (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\services\meterService.js:118:22)
    at async withTransaction (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\db\pool.js:22:20)
    at async D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\routes\generate.js:32:20 {
  length: 312,
  severity: 'ERROR',
  code: '23505',
  detail: 'Key (tenant_id, idempotency_key)=(fba8a9d1-a424-4f2d-a6e1-d4eaab88db1b, same-key) already exists.',
  hint: undefined,
  position: undefined,
  internalPosition: undefined,
  internalQuery: undefined,
  where: undefined,
  schema: 'public',
  table: 'usage_events',
  column: undefined,
  dataType: undefined,
  constraint: 'usage_events_tenant_idempotency_unique',
  file: 'nbtinsert.c',
  line: '666',
  routine: '_bt_check_unique'
}
✖ 10 simultaneous retries of ONE key -> one event, ten identical responses (129.9216ms)
POST /generate 201 149 - 15.374 ms
POST /generate 201 149 - 16.558 ms
POST /generate 201 149 - 16.521 ms
POST /generate 201 149 - 18.083 ms
POST /generate 201 149 - 16.993 ms
POST /generate 201 149 - 18.204 ms
POST /generate 201 149 - 19.996 ms
POST /generate 201 149 - 18.139 ms
POST /generate 201 149 - 18.749 ms
POST /generate 201 149 - 20.658 ms
✖ concurrent token requests can never overshoot the token quota (142.2634ms)
✔ runJob: succeeds on the first try without alerting (132.1584ms)
[job:flaky-job] attempt 1/3 failed: boom
[job:flaky-job] attempt 2/3 failed: boom
✔ runJob: retries with exponential backoff, then succeeds (74.8582ms)
[job:doomed-job] attempt 1/3 failed: always broken
[job:doomed-job] attempt 2/3 failed: always broken
[job:doomed-job] attempt 3/3 failed: always broken
[ALERT] job "doomed-job" failed after 3 attempts: always broken
✔ runJob: after exhausting retries it raises an alert row and does NOT throw (70.4475ms)
✔ rollover: an expired Free period is advanced to the current month (81.8713ms)
✔ rollover: is idempotent — a second run changes nothing (93.7382ms)
✔ rollover: Stripe-managed subscriptions are left to the webhook (100.6957ms)
✔ rollover: a still-valid period is not touched (112.9099ms)
✔ rollover: a Free tenant that cancelled Pro (stripe_subscription_id still set) still rolls over (161.7046ms)
POST /generate 201 141 - 27.818 ms
POST /generate 201 141 - 5.380 ms
✔ PROBE 1: same Idempotency-Key twice -> exactly one usage event, identical response (224.856ms)
POST /generate 201 141 - 7.729 ms
POST /generate 409 113 - 3.938 ms
✔ same key + different body -> 409 and nothing is recorded (105.8823ms)
POST /generate 201 141 - 8.585 ms
POST /generate 201 141 - 7.101 ms
✔ same key is independent across tenants (113.6472ms)
POST /generate 201 144 - 8.383 ms
POST /generate 429 118 - 6.704 ms
✔ PROBE 2 (api_call): 1000th call is allowed, 1001st is 429 (155.5081ms)
POST /generate 201 147 - 6.888 ms
POST /generate 429 123 - 6.239 ms
✔ PROBE 2 (ai_tokens): exactly 100000 allowed, 100001 rejected (107.9975ms)
POST /generate 429 118 - 8.231 ms
POST /generate 429 118 - 3.427 ms
✔ a rejected request is cached: retrying its key replays the 429 (137.577ms)
POST /generate 402 129 - 6.189 ms
✔ budget cap returns 402 even though the token quota still has room (98.5138ms)
POST /generate 402 117 - 7.275 ms
✔ non-active subscription -> 402 plan_inactive (110.7927ms)
[error] ValidationError: Idempotency-Key header is required
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\routes\generate.js:16:13
    at Layer.handle [as handle_request] (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\layer.js:95:5)
    at next (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\route.js:149:13)
    at Route.dispatch (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\route.js:119:3)
    at Layer.handle [as handle_request] (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\layer.js:95:5)
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:284:15
    at router.process_params (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:346:12)
    at next (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:280:10)
    at router.handle (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:175:3)
    at router (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:47:12) {
  statusCode: 400,
  code: 'validation_error'
}
POST /generate 400 75 - 2.247 ms
[error] ValidationError: Invalid discriminator value. Expected 'api_call' | 'ai_tokens'
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\routes\generate.js:21:13
    at Layer.handle [as handle_request] (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\layer.js:95:5)
    at next (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\route.js:149:13)
    at Route.dispatch (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\route.js:119:3)
    at Layer.handle [as handle_request] (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\layer.js:95:5)
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:284:15
    at router.process_params (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:346:12)
    at next (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:280:10)
    at router.handle (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:175:3)
    at router (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:47:12) {
  statusCode: 400,
  code: 'validation_error'
}
POST /generate 400 103 - 2.215 ms
[error] ValidationError: Number must be greater than or equal to 0; tokens must include at least one non-zero category
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\routes\generate.js:21:13
    at Layer.handle [as handle_request] (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\layer.js:95:5)
    at next (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\route.js:149:13)
    at Route.dispatch (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\route.js:119:3)
    at Layer.handle [as handle_request] (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\layer.js:95:5)
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:284:15
    at router.process_params (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:346:12)
    at next (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:280:10)
    at router.handle (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:175:3)
    at router (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:47:12) {
  statusCode: 400,
  code: 'validation_error'
}
POST /generate 400 134 - 2.220 ms
[error] ValidationError: tokens must include at least one non-zero category
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\routes\generate.js:21:13
    at Layer.handle [as handle_request] (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\layer.js:95:5)
    at next (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\route.js:149:13)
    at Route.dispatch (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\route.js:119:3)
    at Layer.handle [as handle_request] (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\layer.js:95:5)
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:284:15
    at router.process_params (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:346:12)
    at next (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:280:10)
    at router.handle (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:175:3)
    at router (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:47:12) {
  statusCode: 400,
  code: 'validation_error'
}
POST /generate 400 91 - 1.844 ms
[error] MissingTenantHeaderError: X-Tenant-Id header is required
    at resolveTenant (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\middleware\resolveTenant.js:10:13)
    at Layer.handle [as handle_request] (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\layer.js:95:5)
    at trim_prefix (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:328:13)
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:286:9
    at router.process_params (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:346:12)
    at next (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\express\lib\router\index.js:280:10)
    at D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\body-parser\lib\read.js:137:5
    at AsyncResource.runInAsyncScope (node:async_hooks:227:14)
    at invokeCallback (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\raw-body\index.js:238:16)
    at done (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\node_modules\raw-body\index.js:227:7) {
  statusCode: 400,
  code: 'missing_tenant_header'
}
POST /generate 400 76 - 0.696 ms
[error] ValidationError: X-Tenant-Id must be a valid UUID
    at resolveTenant (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\middleware\resolveTenant.js:71:19)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5) {
  statusCode: 400,
  code: 'validation_error'
}
POST /generate 400 73 - 2.978 ms
[error] TenantNotFoundError: No tenant found for id 00000000-0000-0000-0000-000000000000
    at resolveTenant (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\src\middleware\resolveTenant.js:37:13)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5) {
  statusCode: 404,
  code: 'tenant_not_found'
}
POST /generate 404 100 - 15.759 ms
✔ bad input is a clean 4xx, never a 500 (197.5142ms)
✔ the documented mix prices to exactly 7650 micros (0.8441ms)
✔ cached input is 10x cheaper than fresh input (0.1432ms)
✔ reasoning tokens are billed at the output rate (0.121ms)
✔ categories are priced separately, not added then priced once (0.1663ms)
✔ rounding happens once on the total, not per category (0.1495ms)
✔ an API call costs the pinned nominal amount (0.1142ms)
POST /generate 201 148 - 24.313 ms
POST /generate 201 141 - 9.306 ms
GET /usage 200 349 - 3.009 ms
✔ PROBE 5: GET /usage matches the pinned pricing constants exactly (246.4448ms)
GET /usage 200 351 - 2.325 ms
POST /generate 429 118 - 6.984 ms
GET /usage 200 351 - 3.295 ms
✔ a rejected request leaves no trace in /usage (168.6715ms)
POST /generate 201 141 - 8.146 ms
GET /usage 200 338 - 2.710 ms
✔ usage is isolated per tenant (124.0513ms)
GET /usage 200 338 - 2.331 ms
✔ events outside the current period are not counted (122.93ms)
[stripe webhook] signature verification failed: No signatures found matching the expected signature for payload. Are you passing the raw request body you received from Stripe? 
 If a webhook request is being forwarded by a third-party tool, ensure that the exact request body, including JSON formatting and new line style, is preserved.

Learn more about webhook signing and explore webhook integration examples for various frameworks at https://github.com/stripe/stripe-node#webhook-signing

POST /webhooks/stripe 400 490 - 4.294 ms
✔ PROBE 4: forged signature -> 400 and nothing changes (190.0436ms)
[stripe webhook] signature verification failed: No stripe-signature header value was provided.
POST /webhooks/stripe 400 88 - 0.789 ms
✔ a missing signature header is also a 400 (97.3092ms)
[stripe webhook] signature verification failed: No signatures found matching the expected signature for payload. Are you passing the raw request body you received from Stripe? 
 If a webhook request is being forwarded by a third-party tool, ensure that the exact request body, including JSON formatting and new line style, is preserved.

Learn more about webhook signing and explore webhook integration examples for various frameworks at https://github.com/stripe/stripe-node#webhook-signing

POST /webhooks/stripe 400 490 - 0.769 ms
✔ a valid signature on a TAMPERED body is rejected (93.0316ms)
[stripe webhook] received customer.subscription.updated (id: evt_up_1)
[stripe webhook] evt_up_1 processed
POST /webhooks/stripe 200 34 - 9.724 ms
GET /usage 200 340 - 6.643 ms
[stripe webhook] received customer.subscription.updated (id: evt_up_1)
[stripe webhook] evt_up_1 duplicate ignored
POST /webhooks/stripe 200 35 - 2.593 ms
✔ PROBE 3/4: a verified event flips Free -> Pro, and replaying it is processed once (138.0338ms)
[stripe webhook] received customer.subscription.updated (id: evt_race)
[stripe webhook] received customer.subscription.updated (id: evt_race)
[stripe webhook] received customer.subscription.updated (id: evt_race)
[stripe webhook] received customer.subscription.updated (id: evt_race)
[stripe webhook] evt_race processed
POST /webhooks/stripe 200 34 - 11.121 ms
[stripe webhook] evt_race duplicate ignored
POST /webhooks/stripe 200 35 - 22.968 ms
[stripe webhook] evt_race duplicate ignored
POST /webhooks/stripe 200 35 - 26.572 ms
[stripe webhook] evt_race duplicate ignored
POST /webhooks/stripe 200 35 - 29.039 ms
✔ two SIMULTANEOUS deliveries of the same event -> both 200, processed exactly once (117.6465ms)
[stripe webhook] received customer.subscription.deleted (id: evt_del)
[stripe webhook] evt_del processed
POST /webhooks/stripe 200 34 - 29.241 ms
POST /generate 201 141 - 33.145 ms
✔ subscription.deleted falls back to a working Free plan (173.0356ms)
[stripe webhook] received customer.subscription.updated (id: evt_pd)
[stripe webhook] evt_pd processed
POST /webhooks/stripe 200 34 - 6.661 ms
POST /generate 402 117 - 8.106 ms
✔ past_due from Stripe blocks /generate with 402 (106.7061ms)
[stripe webhook] received customer.subscription.updated (id: evt_x)
[stripe sync] no tenant found for subscription sub_unknown, skipping
[stripe webhook] evt_x processed
POST /webhooks/stripe 200 34 - 5.070 ms
✔ an event for an unknown subscription is acknowledged without touching anyone (89.3759ms)
ℹ tests 38
ℹ suites 0
ℹ pass 35
ℹ fail 3
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13836.338

✖ failing tests:

test at test\concurrency.test.js:20:1
✖ 20 simultaneous requests at 999/1000 -> exactly ONE is admitted (10 rounds) (508.6145ms)
  AssertionError [ERR_ASSERTION]: round 0: expected exactly 1 admitted
  
  2 !== 1
  
      at TestContext.<anonymous> (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\test\concurrency.test.js:34:12)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1332:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:385:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 2,
    expected: 1,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\concurrency.test.js:40:1
✖ 10 simultaneous retries of ONE key -> one event, ten identical responses (129.9216ms)
  AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
  
    assert.ok(results.every((r) => r.status === 201))
  
      at TestContext.<anonymous> (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\test\concurrency.test.js:45:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1332:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:911:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: '==',
    diff: 'simple'
  }

test at test\concurrency.test.js:51:1
✖ concurrent token requests can never overshoot the token quota (142.2634ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  10 !== 3
  
      at TestContext.<anonymous> (D:\1. University Modules Folder\3. Flyrank AI Internship\usage-metering-billing-engine\test\concurrency.test.js:61:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1332:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:911:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 10,
    expected: 3,
    operator: 'strictEqual',
    diff: 'simple'
  }

```

Restoring the line makes all three pass again. (With a single round, the 999/1000 test passed
even without the lock, because the race window is narrow on a fast machine. That is why it runs
10 rounds, and why the token-quota test is the stronger proof.)

### Webhook: simultaneous duplicate deliveries

`test/webhook.test.js` -> "two SIMULTANEOUS deliveries of the same event": 4 identical signed
events at once -> four 200 responses, exactly one `processed: true`, exactly one `stripe_events` row.
The earlier SELECT-then-INSERT implementation returned a 500 here (unique-constraint violation);
it was replaced with `INSERT ... ON CONFLICT DO NOTHING RETURNING id`.

### Background job

`test/jobs.test.js` -> `runJob` retries with backoff (100 ms, 200 ms), and after exhausting retries writes a row to `job_failures` and does not throw; `rolloverFreePeriods` is idempotent and only touches Free-plan subscriptions and leaves Pro ones to Stripe’s webhook.