# Node Backend — API Documentation Standard (OpenAPI 3.1 + Swagger UI)

**API docs are ON by default and generated, not hand-written.** Every route ships with its documentation in the same PR, enforced by tests and linted for security in CI.

Why generated: a hand-maintained `swagger.js` grows to thousands of lines and drifts from the code within weeks. Here request schemas come **directly from the Joi validation** that guards the route, so docs and validation cannot disagree.

---

## 1. Files

| File | Source | Purpose |
|---|---|---|
| `src/app/docs/openapi.js` | copy `${CLAUDE_SKILL_DIR}/assets/openapi.js` verbatim | Joi→OpenAPI converter, `op()` builder, `buildSpec()`, `mountDocs()`, `listRoutes()` |
| `src/app/docs/spec.js` | write (≈15 lines) | Assembles the spec from the module registry + config |
| `src/app/modules/index.js` | write | **Module registry**: the single list used by routing *and* docs |
| `src/app/modules/<domain>/docs.js` | one per module | Operations, tag, response schemas |
| `tests/openapi.test.js` | copy `${CLAUDE_SKILL_DIR}/assets/openapi.test.js` | Drift + auth-metadata contract tests |
| `.spectral.yaml` | copy `${CLAUDE_SKILL_DIR}/assets/.spectral.yaml` | OAS + OWASP API Security lint rules |

Dependencies: `swagger-ui-express` (runtime), `@stoplight/spectral-cli` + `@stoplight/spectral-owasp-ruleset` (dev). **No `swagger-jsdoc`**. JSDoc comment specs aren't validated, aren't composable, and drift.

The toolkit is verified against Joi 18, Express 5, swagger-ui-express 5, and Spectral (`spectral:oas` + OWASP ruleset → 0 errors).

---

## 2. Module Registry — one list, two consumers

```js
// src/app/modules/index.js
import branchRouter from './branch/index.js';
import branchDocs from './branch/docs.js';
import customerRouter from './customer/index.js';
import customerDocs from './customer/docs.js';

/** Single source of truth. routes/index.js mounts these; docs/spec.js documents these. */
export const modules = [
  { name: 'branch', path: '/branch', router: branchRouter, docs: branchDocs },
  { name: 'customer', path: '/customer', router: customerRouter, docs: customerDocs },
];
```

```js
// src/app/routes/index.js (excerpt)
import { modules } from '../modules/index.js';
import { spec } from '../docs/spec.js';
import { mountDocs } from '../docs/openapi.js';
import { config } from '../config/env.js';

const v1 = Router();
for (const m of modules) v1.use(m.path, m.router);
mountDocs(v1, spec, { mode: config.docs.mode, basicAuth: config.docs.basicAuth, persistAuthorization: !config.isProd });
app.use('/v1', v1);
```

Docs live at **`/v1/docs`** (Swagger UI) and **`/v1/openapi.json`** (machine-readable spec).

---

## 3. `docs/spec.js`

```js
import { buildSpec } from './openapi.js';
import { modules } from '../modules/index.js';
import { config } from '../config/env.js';
import pkg from '../../../package.json' with { type: 'json' };

export const spec = buildSpec({
  modules,
  info: {
    title: `${config.appName} API`,
    version: pkg.version,
    description: 'All responses use the `{ success, message, data }` envelope. Errors carry a stable `error` code and a `requestId` to quote to support.',
    contact: { name: 'API team', email: config.docs.contactEmail },
    license: { name: 'Proprietary', identifier: 'LicenseRef-Proprietary' },
  },
  servers: [{ url: `${config.publicBaseUrl}/v1`, description: config.env }],
});
```

---

## 4. Per-module `docs.js`

```js
// src/app/modules/branch/docs.js
import validation from './validation.js';
import { op } from '../../docs/openapi.js';

const tag = 'Branch';

const Branch = {
  type: 'object',
  required: ['id', 'name'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'objectid', maxLength: 24, examples: ['665f1c2e8b3c4a0012345678'] },
    name: { type: 'string', maxLength: 120, examples: ['Ikeja Branch'] },
    state: { type: 'string', maxLength: 60, examples: ['lagos'] },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

export default {
  tag: { name: tag, description: 'Branch management. Results are scoped to the caller’s branch/region.' },
  schemas: { Branch },                       // also generates PaginatedBranch automatically
  paths: {
    '/': {
      get: op({ tag, summary: 'List branches', permission: 'branch.canList', validation: validation.listBranch, data: { list: 'Branch' } }),
      post: op({ tag, summary: 'Create branch', permission: 'branch.canAdd', validation: validation.createBranch, status: 201, data: 'Branch' }),
    },
    '/{branchId}': {
      get: op({ tag, summary: 'View branch', permission: 'branch.canView', validation: validation.viewBranch, data: 'Branch' }),
      patch: op({ tag, summary: 'Update branch', permission: 'branch.canUpdate', validation: validation.updateBranch, data: 'Branch' }),
      delete: op({ tag, summary: 'Delete branch', permission: 'branch.canDelete', validation: validation.deleteBranch,
        description: 'Super admin only. Fails with 409 if users are assigned.' }),
    },
  },
};
```

`op()` options: `tag`, `summary` (required) · `validation` (the same object given to `joiValidator`) · `permission` (`module.action` → `x-permission`) · `public: true` (no auth; route must use `publicRoute`) · `status` · `data` (`'Schema'`, `{ list: 'Schema' }`, or inline) · `description` · `idempotent: true` (documents `Idempotency-Key`) · `deprecated: true` · `id` (custom `operationId`; otherwise derived, e.g. `getBranchByBranchId`).

Automatically documented on every operation: path/query params and request body (from Joi, with limits, enums, defaults, required) · bearer auth · `400/429/500` (+ `401/403` when protected, `404` when there are path params) with the standard error schema · rate-limit and CORS headers.

---

## 5. Make Joi schemas document themselves

The converter reads Joi's public `describe()` output. Write schemas that carry their own documentation:

```js
name: Joi.string().trim().min(2).max(120).required().description('Display name').example('Ikeja Branch'),
status: Joi.string().valid('active', 'inactive').default('active'),
limit: Joi.number().integer().min(1).max(100).default(20),
```

`JoiObjectId()` adds OpenAPI metadata:
```js
export const JoiObjectId = () =>
  Joi.string().length(24).hex()
    .custom((v, h) => (isValidObjectId(v) ? v : h.error('any.invalid')), 'ObjectId')
    .meta({ format: 'objectid', examples: ['665f1c2e8b3c4a0012345678'] });
```

`.meta({...})` merges any OpenAPI keyword into the generated schema (`format`, `examples`, `deprecated`, `pattern`).

Spectral's OWASP rules then **enforce the validation standard**: an unbounded string (`maxLength` missing) or integer (`minimum`/`maximum` missing) in a request schema fails the lint. Fix the Joi schema, not the docs.

---

## 6. Public routes are explicit in code and docs

```js
// utils/authGuard.js
export const publicRoute = Object.assign((req, res, next) => next(), { isPublic: true });

export const accessGuard = (moduleKey, permissionKey) =>
  Object.assign(
    (req, res, next) => { /* RBAC check — see architecture.md §8 */ },
    { isAccessGuard: true, permission: `${moduleKey}.${permissionKey}` },   // tags read by the contract test
  );
```

```js
route.post('/login', publicRoute, sensitiveLimiter, joiValidator(validation.login), controller.login);
// docs.js
'/login': { post: op({ tag, summary: 'Log in', public: true, validation: validation.login, data: 'Session' }) },
```

The contract test fails if the router and docs disagree about which routes are public.

---

## 7. Serving & Security

| Environment | `DOCS_MODE` | Behaviour |
|---|---|---|
| local / development / staging | `public` | `/v1/docs` + `/v1/openapi.json` open; "Try it out" on |
| production (default) | `protected` | HTTP Basic (`DOCS_USER` / `DOCS_PASSWORD` ≥ 16 chars, constant-time check), "Try it out" off |
| production (high-risk / internal API) | `off` | Not mounted; publish `openapi.json` as a CI artifact or to an internal portal |

Config (`config/env.js`):
```js
DOCS_MODE: Joi.string().valid('public', 'protected', 'off')
  .default(Joi.ref('NODE_ENV', { adjust: (env) => (env === 'production' ? 'protected' : 'public') })),
DOCS_USER: Joi.string().when('DOCS_MODE', { is: 'protected', then: Joi.required() }),
DOCS_PASSWORD: Joi.string().min(16).when('DOCS_MODE', { is: 'protected', then: Joi.required() }),
```

Rules:
- Docs never contain secrets, real customer data, internal hostnames, or real tokens in examples.
- Docs responses send `Cache-Control: no-store`.
- Docs are mounted **after** helmet. If a strict CSP blocks the UI, relax CSP **only** for `/v1/docs`, never globally.
- Describe errors honestly: `404` means "not found **or outside your scope**". That's intentional, so it doesn't leak whether a record exists.
- `x-permission` documents the required RBAC permission for every protected operation.
- Docs routes count toward rate limits like any other route.

---

## 8. CI

```json
{
  "scripts": {
    "docs:export": "node -e \"import('./src/app/docs/spec.js').then(({spec})=>require('node:fs').writeFileSync('openapi.json', JSON.stringify(spec,null,2)))\"",
    "docs:lint": "npm run docs:export && spectral lint openapi.json --fail-severity=error"
  }
}
```

Pipeline: `npm test` (includes `tests/openapi.test.js`) → `npm run docs:lint` → upload `openapi.json` as a build artifact.
Optional breaking-change gate: diff `openapi.json` against `main` with `oasdiff breaking` and fail on removed or renamed fields without a version bump.

---

## 9. Versioning & Change Management

- Additive changes (new optional field, new endpoint) → same version.
- Breaking changes (remove/rename field, tighten validation, change semantics) → new `/v2` route **or** a 6-month deprecation: `deprecated: true` in docs, a `Deprecation` + `Sunset` header on responses, and an announcement.
- `info.version` follows `package.json` semver. Keep a `CHANGELOG.md` section per API release.
- Frontend clients generate types from the spec (`npx openapi-typescript https://api…/v1/openapi.json -o src/api/schema.d.ts`), so contract changes become compile errors, not production bugs.
