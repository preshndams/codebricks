# Node Backend — Large-Scale Architecture Standard

How a CodeBricks backend grows from one team and one server to many teams, many instances, and millions of requests without a rewrite. Read this when designing a new system, adding a module that crosses boundaries, introducing async work, or preparing for production scale.

Principles: **modular monolith first · stateless instances · explicit boundaries · async for slow and unreliable work · everything observable · zero trust between components.**

---

## 1. System Shape: Modular Monolith → Services (only when earned)

Start as **one deployable with strict module boundaries**. Split a module into its own service only when you have a concrete reason: an independent scaling profile, a different availability requirement, a separate team cadence, or a regulatory isolation need. Never split for fashion.

**Module boundary rules (enforced by lint, see §13):**
1. A module owns its collections. Only its own `model.js` / `repository.js` touch them.
2. Other modules call its **public API**: the functions exported from `modules/<domain>/public.js` (or its service). Never import another module's `model.js`.
3. Cross-module reactions go through **domain events** (§5), not direct calls, when the caller doesn't need the result synchronously.
4. No circular dependencies between modules. If two modules need each other, extract the shared concept or use events.
5. Shared code lives in `utils/` (technical) or a dedicated `shared/` module (domain primitives like `Money`). Never a dumping ground.

**Module file set at scale:**

| File | Required | Role |
|---|---|---|
| `index.js` | ✅ | Router: middleware chain |
| `controller.js` | ✅ | HTTP adapter |
| `service.js` | ✅ | Use cases / business rules |
| `validation.js` | ✅ | Joi schemas (also feed the docs) |
| `model.js` | ✅ | Schema + indexes |
| `docs.js` | ✅ | OpenAPI operations (see api-docs.md) |
| `repository.js` | when queries get complex or reused | Data access; services stop building queries |
| `public.js` | when other modules depend on it | The module's contract for other modules |
| `events.js` | when it publishes/consumes events | Event names, payload schemas, handlers |
| `jobs.js` | when it has background work | Queue processors |
| `README.md` | ✅ at scale | Purpose, owners, invariants, events in/out |

---

## 2. API Design Standards

| Concern | Standard |
|---|---|
| Resources | Plural kebab-case nouns: `/v1/saving-types`, nested max one level: `/v1/customers/{id}/savings` |
| Actions that aren't CRUD | Sub-resource verbs as POST: `/v1/withdrawals/{id}/approve` |
| Methods | GET safe + idempotent · PUT/DELETE idempotent · POST not (use `Idempotency-Key`) · PATCH partial |
| Status codes | 200 read/update · 201 create (+ `Location`) · 202 accepted async · 204 no body · 400 validation · 401 unauthenticated · 403 forbidden · 404 not found/out of scope · 409 conflict/state · 422 business rule · 429 rate limit · 503 overloaded (+ `Retry-After`) |
| Envelope | `{ success, message, data }`; errors `{ success:false, message, error, requestId }` with stable `error` codes |
| Pagination | Offset (`pageNo`, `limit` ≤ 100) for admin tables; **cursor** (`cursor`, `limit`, returns `nextCursor`) for large or growing collections and feeds. Offset on large collections gets slower with every page. |
| Filtering/sorting | Allowlisted fields only: `sort: Joi.string().valid('createdAt', '-createdAt', 'name')`. Never pass a client field name into a query. |
| Concurrency | `ETag` / `If-Match` (or a `version` field) on updates to shared records → 412/409 on conflict. Mongoose `optimisticConcurrency: true`. |
| Long operations | 202 + `{ jobId }` + `GET /v1/jobs/{jobId}`; never hold a request open > 30s |
| Bulk | Explicit bulk endpoints with max batch size, per-item results, and idempotency |
| Time | ISO-8601 UTC in APIs; store UTC; convert at the edge |
| Money | Integer minor units + currency code: `{ amountKobo: 150000, currency: 'NGN' }` |
| IDs | Opaque strings; never expose sequential IDs that enable enumeration |
| Docs | Every route in OpenAPI (api-docs.md). No undocumented endpoints. |

---

## 3. Stateless, Horizontally Scalable Instances

Any instance must be killable at any moment, and any request must be servable by any instance.

- **No in-process state that matters:** sessions, rate-limit counters, idempotency keys, locks, caches that must be consistent → Redis. In-memory LRU only for immutable or reference data with short TTLs.
- **`EventEmitter` is not a queue.** In-process events vanish on crash or deploy. Anything that must happen (SMS, ledger postings, emails, webhooks) goes to a durable queue (§5). Emitters are fine for fire-and-forget telemetry only.
- **Cron runs once, not per instance:** BullMQ repeatable jobs, or a Redis lock (`SET lock:job NX PX`) around `node-cron`.
- **Files:** never write to local disk for persistence; object storage (S3/Wasabi/GCS) via presigned URLs.
- **Scale out** with containers (one Node process per container, N replicas) or PM2 cluster mode on VMs. Use worker threads only for CPU-bound work.
- **Graceful lifecycle:** readiness probe goes red on SIGTERM, drain in-flight requests, close pools, exit (architecture.md §1).
- **Separate process types** from one codebase: `api` (HTTP), `worker` (queue consumers), `scheduler` (repeatable jobs). Each scales independently.

```
src/
  index.js          ← api entry
  worker.js         ← queue consumers entry (no HTTP server)
  scheduler.js      ← registers repeatable jobs (single replica)
```

---

## 4. Data at Scale (MongoDB focus)

- **Model for access patterns**, not entity purity. Embed what's read together and bounded; reference what's unbounded or shared. Arrays that grow without limit are a bug.
- **Every hot query has an index.** Enforce with `explain()` checks in review; turn on `notablescan` in dev/test to catch collection scans.
- **Avoid N+1:** batch lookups (`$in`), `populate` with `select`, or `$lookup` with pipelines and limits.
- **Pagination:** cursor on `(createdAt, _id)` for large collections.
- **Consistency:** `writeConcern: { w: 'majority' }` for money and auth data; transactions for multi-document invariants; `readConcern: 'majority'` where stale reads matter.
- **Read scaling:** reports and analytics read from secondaries (`readPreference: 'secondaryPreferred'`) or a dedicated analytics store/replica. Never run heavy aggregations on the primary during peak.
- **Write scaling:** choose a shard key early for collections expected to exceed ~100 GB or very high write rates (high cardinality, even distribution, matches main query filter, e.g. `{ branchId: 1, _id: 1 }`).
- **Migrations:** versioned scripts. Use **expand → migrate → contract** for zero-downtime schema changes (add new field, dual-write, backfill, switch reads, remove old).
- **Retention:** TTL indexes for ephemeral data (OTPs, sessions, idempotency records); archive cold data; documented retention per collection (compliance).
- **Soft delete** (`deletedAt`) for business records that need audit or restore; a partial index excludes deleted documents. Hard delete for privacy requests.
- **Connection pools:** size `maxPoolSize` per instance × instances < DB connection limit.
- **Ledgers are append-only.** Balances are derived or materialized with reconciliation jobs that alert on mismatch.

---

## 5. Asynchronous Work, Events & Reliability

**Queues (BullMQ on Redis):**
- One queue per workload type; concurrency set per queue (bulkheads).
- Job payloads carry IDs, not whole documents; workers re-read current state.
- Retries: exponential backoff with jitter; max attempts; then a **dead-letter queue** with alerting.
- **Every consumer is idempotent.** Store processed job/event IDs, or make the operation naturally idempotent with conditional updates.

**Transactional outbox:** the only reliable way to "update the DB *and* publish an event".
```js
await session.withTransaction(async () => {
  await Saving.updateOne(scoped({ _id }, user), { $inc: { balanceKobo: amount } }, { session });
  await Outbox.create([{ type: 'saving.deposited', aggregateId: _id, payload: { amount }, createdAt: new Date() }], { session });
});
// A relay worker polls Outbox (or tails a change stream), publishes to the queue, and marks rows sent.
```
Never `await db.save(); queue.add()` as two steps. A crash between them loses or duplicates the event.

**Domain events:** past-tense names (`customer.registered`, `withdrawal.approved`), versioned payload schemas, consumers tolerate unknown fields.

**Outbound providers (SMS, payments, KYC):** always via a queue with retries, never inline in the request when the user doesn't need the result to continue.

---

## 6. Caching

- Cache-aside with explicit TTL **plus jitter** (±10%) to avoid synchronized expiry.
- **Stampede protection:** a single-flight lock per key, or stale-while-revalidate.
- Invalidate on write in the same code path as the write; publish an invalidation event if other instances hold local caches.
- Namespaced, versioned keys: `v1:branch:list:<scopeHash>:<queryHash>`.
- **Never cache authorization-sensitive data without the scope in the key.** A cache keyed only by query parameters serves branch A's data to branch B.
- HTTP caching for public reference data: `Cache-Control`, `ETag`. Private data: `Cache-Control: no-store`.

---

## 7. Resilience

| Pattern | Rule |
|---|---|
| Timeouts | Every outbound call, DB query (`maxTimeMS`), and request (`server.requestTimeout`) has one. Budget: downstream timeout < upstream timeout. |
| Retries | Only idempotent operations; exponential backoff + jitter; max 3; never retry 4xx |
| Circuit breaker | Wrap each provider (`opossum`): open after error-rate threshold, half-open probes, fallback (queue for later, cached value, graceful message) |
| Bulkheads | Separate queues and connection pools per provider/workload so one slow dependency can't exhaust everything |
| Load shedding | When event-loop lag or queue depth crosses a threshold, return 503 + `Retry-After` on non-critical routes (`@fastify/under-pressure` style check middleware) |
| Graceful degradation | Core flows (login, deposit, withdrawal) never depend on non-core services (analytics, SMS delivery) being up |
| Backpressure | Stream large exports; cap concurrent exports per user and globally |

---

## 8. Observability & SLOs

- **Traces:** OpenTelemetry (`@opentelemetry/sdk-node` + auto-instrumentations for http, express, mongodb, ioredis, bullmq). Propagate W3C `traceparent` across HTTP and queue jobs.
- **Metrics (RED + USE):** request rate, error rate, duration (p50/p95/p99) per route; event-loop lag; heap; DB pool usage; queue depth, age, and failure rate; cache hit ratio; provider latency/error by provider.
- **Logs:** pino JSON with `requestId` + `traceId` + `userId`; redaction on; sampled debug logs.
- **SLOs:** e.g. 99.9% of `POST /withdrawals` succeed in < 800 ms over 30 days. Alert on **error-budget burn rate**, not on single spikes.
- **Business monitors:** ledger reconciliation mismatches, stuck pending transactions, SMS spend, failed webhook verifications.
- **Runbooks:** every alert links to a runbook (what it means, how to check, how to mitigate).

---

## 9. Security & Trust at Scale (Zero Trust)

Everything in `security.md` applies. At scale, add:

- **Identity everywhere:** users (JWT + session), services (short-lived signed service tokens or mTLS), CI/CD (OIDC to the cloud, no static keys). No component trusts the network.
- **Least privilege data access:** separate DB users per process type. The API user can't drop collections; the audit collection is insert-only for the app; reporting uses a read-only user.
- **Network:** DB and Redis never on public IPs; private networking/VPC; Redis with AUTH + TLS (`rediss://`); egress allowlist for outbound providers.
- **Edge:** TLS termination at a load balancer or CDN with WAF rules (SQLi/XSS signatures, bot management) and edge rate limiting before traffic reaches Node.
- **Secrets:** secret manager (AWS Secrets Manager / GCP Secret Manager / Vault / Doppler), injected at runtime, rotated on schedule and on staff departure. Dual-key rotation for JWT secrets (`kid` header, accept old + new during rollover).
- **Tenant isolation:** `scoped()` on every query + automated cross-tenant tests for every module; consider per-tenant encryption keys for regulated data.
- **Tamper-evident audit:** append-only audit log with a hash chain (`hash = sha256(prevHash + entry)`), periodically anchored; shipped to separate storage the app can't modify.
- **Privacy operations:** data inventory per collection (what, why, retention), export and delete flows for data-subject requests, PII minimized in analytics and logs.
- **Security in the pipeline:** supply-chain scanner, `npm audit`, Spectral OWASP lint of the API spec, secret scanning (gitleaks), SAST (CodeQL/Semgrep) on PRs; DAST (OWASP ZAP baseline against staging) on release.
- **Assurance:** threat model per major feature (security.md §0), annual penetration test, a bug-bounty or `SECURITY.md` disclosure policy, and an incident-response plan that has been rehearsed.

---

## 10. Configuration & Delivery

- **12-factor:** config from env (validated, `config/env.js`), one build artifact promoted dev → staging → prod, environment parity.
- **Feature flags** for risky changes and gradual rollouts (OpenFeature-compatible provider); flags have owners and expiry dates.
- **Containers:** multi-stage Dockerfile, `node:24-slim` (or distroless), `npm ci --omit=dev --ignore-scripts`, non-root `USER node`, read-only root filesystem, `HEALTHCHECK` on `/v1/healthz`, no secrets in image layers.
- **Pipeline:** scan → lint → unit → integration (real Mongo replica set + Redis) → contract (OpenAPI) → docs lint → build image → image scan (Trivy/Grype) → deploy staging → smoke + DAST → manual approval → production.
- **Deploys:** rolling or blue/green with readiness gates; canary for high-risk changes; automated rollback on SLO burn.
- **Migrations** run as a separate pipeline step before the new version receives traffic, and must be backward compatible with the old version (expand/contract).

---

## 11. Performance Budgets

| Metric | Default budget |
|---|---|
| p95 latency, simple reads | < 200 ms |
| p95 latency, writes / money ops | < 800 ms |
| Payload size, list responses | < 500 KB (paginate / project fields) |
| Event-loop lag p99 | < 50 ms |
| DB query time | < 100 ms for hot paths (`maxTimeMS` guards worst case) |
| Cold start to ready | < 10 s |

Load-test before launch and before peak seasons (k6 / Artillery) with production-like data volumes; record results in the repo.

---

## 12. Testing Strategy (pyramid)

1. **Unit:** services and pure functions (fast, many).
2. **Integration:** routes + real Mongo replica set + Redis (testing-ops.md), including authZ matrix tests (role × endpoint × scope).
3. **Contract:** OpenAPI drift and auth-metadata tests (api-docs.md); consumer types generated from the spec.
4. **Security:** injection, IDOR, mass assignment, rate-limit, and webhook-signature tests; DAST on staging.
5. **Load/soak:** before launch and major releases.
6. **Chaos-lite:** kill a worker mid-job, drop Redis, slow a provider. The system must recover without data loss.

Coverage gate: ≥ 80% lines on `service.js` files, 100% of routes covered by at least one integration test.

---

## 13. Team-Scale Engineering

- **TypeScript** for codebases with > 3 engineers or > 20 modules (Node runs `.ts` natively with type stripping; `tsc --noEmit` in CI).
- **Boundary lint:** `eslint-plugin-boundaries` or `import/no-restricted-paths` so `modules/a/**` cannot import `modules/b/model.js` or `modules/b/repository.js`.
- **CODEOWNERS** per module directory and for `utils/authGuard.js`, `config/`, `docs/`, `.github/`, `package.json`.
- **ADRs** (`docs/adr/NNNN-title.md`) for decisions with long-term cost: datastore choice, service split, auth model, event schema changes.
- **PR template** with checklist: tests, docs (OpenAPI), migration plan, security impact, rollout/rollback, observability.
- **Conventional Commits** + automated changelog/semver.
- **Definition of Done:** code + tests + OpenAPI docs + dashboards/alerts for new critical paths + runbook updates + security checklist.

---

## Production-Readiness Checklist (gate before launch)

- [ ] Every route documented (contract test green) and Spectral OWASP lint at 0 errors
- [ ] AuthN/AuthZ on every non-public route; cross-tenant tests pass for every module
- [ ] All inputs bounded; pagination capped; exports bounded/async
- [ ] Money flows: transactions, idempotency, outbox, ledger reconciliation job
- [ ] Stateless API: no in-memory sessions/limits/locks; cron single-run; files in object storage
- [ ] Queues with retries, DLQ, idempotent consumers; providers behind circuit breakers
- [ ] Timeouts on every outbound call and query; graceful shutdown verified
- [ ] Indexes for hot queries; no collection scans in load test; pool sizes computed
- [ ] OTel traces + RED metrics + SLOs + alerts with runbooks
- [ ] Secrets in a manager, rotated; DB/Redis private with TLS; least-privilege DB users
- [ ] Supply-chain scan, `npm audit`, secret scan, SAST in CI; DAST on staging; image scan
- [ ] Backups automated and restore-tested; migration + rollback plan documented
- [ ] Load test at 2× expected peak passes the performance budgets
