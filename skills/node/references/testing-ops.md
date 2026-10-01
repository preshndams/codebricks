# Node Backend — Testing, CI & Operations

## Test Stack

- Runner: `node:test` (zero-dep) or Vitest. One per project.
- HTTP: `supertest` against `createApp()` (the factory — no `listen()`).
- DB: `mongodb-memory-server` **as a replica set** (`MongoMemoryReplSet`) so transactions work.
- Redis: `ioredis-mock`, or a real Redis in CI service containers.
- Providers: inject adapters / mock with `nock` or MSW (node). Tests never hit real payment or SMS APIs.

## Minimum Cases Per Endpoint

| Case | Expect |
|---|---|
| Happy path | 2xx + envelope shape `{ success, message, data }` |
| No token | **401** |
| Valid token, missing permission | **403** |
| Valid token, record in another branch/tenant | **404** (scoped query — not 403, not data) |
| Unknown body key (`role`, `isAdmin`, `__proto__`) | **400** |
| Operator injection (`{ "email": { "$ne": null } }`) | **400** |
| Over-length string / limit > max | **400** |
| Not found ID | **404** |
| Money endpoints: same `Idempotency-Key` twice | One debit, identical response |
| Money endpoints: concurrent double-spend (`Promise.all` × 2 over balance) | Exactly one succeeds |
| Webhook with bad signature | **401**, no side effects |

```js
// tests/branch.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app/index.js';
import { loginAs, seedBranches, startDb, stopDb } from './helpers.js';

let app, tokens, branches;
before(async () => { await startDb(); app = createApp(); branches = await seedBranches(); tokens = await loginAs(['superAdmin', 'cso:A']); });
after(stopDb);

test('cso cannot view another branch', async () => {
  const res = await request(app).get(`/v1/branch/${branches.B.id}`).set('Authorization', `Bearer ${tokens['cso:A']}`);
  assert.equal(res.status, 404);
});

test('rejects mass-assignment keys', async () => {
  const res = await request(app).patch(`/v1/branch/${branches.A.id}`)
    .set('Authorization', `Bearer ${tokens.superAdmin}`).send({ name: 'X', managerUserId: '000000000000000000000000' });
  assert.equal(res.status, 400);
});
```

**Route-inventory test**: iterate registered routes and assert each non-public route's stack contains `guard` and `accessGuard`. This catches the forgotten guard before review does.

## package.json Scripts

```json
{
  "engines": { "node": ">=24" },
  "scripts": {
    "dev": "node --watch --env-file-if-exists=.env src/index.js",
    "start": "node src/index.js",
    "lint": "eslint .",
    "test": "node --test --experimental-test-coverage tests/",
    "audit": "npm audit --omit=dev --audit-level=high",
    "scan": "node scripts/scan-supply-chain.mjs ."
  }
}
```

## ESLint (flat config) — Security Rules ON

```js
import js from '@eslint/js';
import security from 'eslint-plugin-security';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'coverage/'] },
  js.configs.recommended,
  security.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules: {
      'no-console': 'error',                 // use the logger
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'eqeqeq': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      // Keep detect-object-injection as 'warn' rather than 'off' — triage, don't blanket-disable.
      'security/detect-object-injection': 'warn',
    },
  },
];
```

Pre-commit (husky + lint-staged): `eslint --max-warnings=0` + `prettier --check` + the supply-chain scanner on staged files. Add a `max-line-length`-style check (Prettier `--check` fails on 7,000-char lines) — injected payloads hide on single over-long lines.

## CI/CD

- CI workflow (all PRs + pushes): scan → lint → test → audit. Pinned action SHAs, `permissions: contents: read`.
- Deploy workflow: only from protected branches, environment approval, artifacts built in CI (not on the server), secrets from the environment, never echoed.
- Self-hosted runners: ephemeral, no persistent deploy keys, never triggered by `pull_request` from forks.
- Process manager / container: run as non-root, read-only filesystem where possible, `NODE_ENV=production`, health checks on `/v1/healthz` and `/v1/readyz`.

## Observability

- pino JSON logs → central store; `requestId` on every line; trace IDs via OpenTelemetry (`@opentelemetry/auto-instrumentations-node`) when available.
- Metrics: p50/p95/p99 latency per route, error rate, event-loop lag, Mongo pool saturation, queue depth.
- Dashboards + alerts listed in security.md §9.

## Migrations & Data

- Index builds and data migrations as versioned scripts (`migrate-mongo` or equivalent) — not `autoIndex` in prod.
- Money fields migrated from floats to integer kobo with a reconciliation report before switch-over.
- Backups: automated, encrypted, restore-tested quarterly.
