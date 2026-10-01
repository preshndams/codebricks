# CodeBricks

**Engineering-grade frontend, backend, and security skills for Claude Code.**

CodeBricks is an opinionated Claude Code plugin for senior-level product engineering. Each skill activates a principal-engineer persona that enforces architecture, performance, accessibility, visual quality, and **security** standards that production apps actually require.

Every skill inherits two shared rule sets:
- **`shared/design-rules.md`**: the design laws (typography, color, composition, motion, all states).
- **`shared/security-baseline.md`**: the security laws (OWASP Top 10:2025, API Security Top 10, supply chain).

---

## Why CodeBricks

Most AI-assisted code ships the happy path: Inter font, purple gradient, spinner for loading, `cors()` wide open, `$regex: req.query.search`, a lockfile in `.gitignore`. It looks finished. It isn't.

- **Generic is worse than ugly.** Every UI must pass the brand test.
- **All states ship together.** Loading skeleton, error with retry, designed empty state.
- **Performance is measured.** Core Web Vitals, FPS budgets, query plans.
- **Security is the floor, not a feature.** Every endpoint is authenticated, authorized at the object level, validated, rate-limited, and audited. Every repo is scanned for supply-chain payloads before it runs.

---

## Skills

| Command | What it is |
|---|---|
| `/codebricks:setup` | Intake questionnaire (design + backend + security) → `CODEBRICKS.md` + `questionnaire.md` |
| `/codebricks:nextjs` | Next.js 16 App Router: RSC, Cache Components, secured Server Actions, DAL, `proxy.ts` |
| `/codebricks:react` | React 19.2 SPA: Vite, React Compiler, TanStack Query, Zod 4, Motion |
| `/codebricks:react-native` | Expo SDK 57 / RN 0.86: New Architecture, Reanimated 4, FlashList v2, secure storage |
| `/codebricks:flutter` | Flutter 3.44+: Riverpod 3, go_router, freezed 3, Material 3, obfuscated releases |
| `/codebricks:node` | **Node.js 24 + Express 5 backend standard for large-scale apps**: module architecture, Swagger/OpenAPI docs by default, RBAC, money-safe flows, queues/outbox, resilience, observability |
| `/codebricks:security-audit` | Supply-chain/malware scan + OWASP Top 10:2025 audit of any stack, with incident response |

```
.claude-plugin/
  plugin.json                 ← plugin manifest
  marketplace.json            ← lets you install straight from GitHub
shared/
  design-rules.md             ← universal design laws
  security-baseline.md        ← universal security laws
skills/
  setup/        SKILL.md + CODEBRICKS.template.md
  nextjs/       SKILL.md
  react/        SKILL.md
  react-native/ SKILL.md
  flutter/      SKILL.md
  node/         SKILL.md + references/{architecture,api-docs,security,scale,testing-ops}.md
                + assets/{openapi.js, openapi.test.js, .spectral.yaml}
  security-audit/ SKILL.md + scripts/scan-supply-chain.mjs
```

---

## Installation

### Option A: Plugin marketplace (recommended)

In Claude Code:
```
/plugin marketplace add preshndams/codebricks
/plugin install codebricks@codebricks
```
Or from your shell:
```bash
claude plugin marketplace add preshndams/codebricks
claude plugin install codebricks@codebricks
```
Updates: `claude plugin marketplace update codebricks`.

### Option B: Local folder (development)

```bash
git clone https://github.com/preshndams/codebricks.git
claude --plugin-dir ./codebricks
```

> **Upgrading from v1?** v1 was copied into `~/.claude/commands/codebricks/`. Delete that folder after installing the plugin, or you'll have duplicate commands.

---

## Workflow

### New project
```
1. /codebricks:setup            → answer the questionnaire (pass "backend", "frontend" or "full")
2. Commit CODEBRICKS.md + questionnaire.md (+ screenshots/ for UI references)
3. Build with the platform skill
```

### Ongoing
```
/codebricks:node            add a withdrawals module with maker-checker approval
/codebricks:nextjs          build the products page
/codebricks:flutter         implement the checkout screen
/codebricks:security-audit  .
/codebricks:security-audit  ../some-cloned-repo --scan-only
```

---

## The Node Backend Skill

`/codebricks:node` builds on a battle-tested Express layout, hardened:

```
src/
  index.js / worker.js / scheduler.js   ← api, queue consumers, repeatable jobs (scale independently)
  app/
    index.js                    ← app factory: middleware → routes + docs → 404 → error handler
    config/env.js               ← the only file that reads process.env
    routes/{index,middleware}.js
    docs/{openapi,spec}.js      ← OpenAPI 3.1 generator + spec (Swagger UI at /v1/docs)
    modules/index.js            ← module registry: routing AND docs read this one list
    modules/<domain>/
      index.js                  ← guard → accessGuard → joiValidator → controller
      controller.js             ← HTTP only
      service.js                ← business logic, typed errors
      validation.js             ← Joi schemas (unknown keys rejected, every field bounded) → also the docs
      model.js                  ← Mongoose schema + indexes
      docs.js                   ← OpenAPI operations for the module
      [repository|public|events|jobs].js  ← added as the module grows
    utils/{authGuard,error,constant,logger,db,redis,...}.js
    utils/providers/<vendor>.js
```

**API docs by default.** Request schemas are generated from the same Joi validation that guards each route, so docs can't drift. Swagger UI is served at `/v1/docs` (public in dev, Basic-auth in production). A contract test fails the build if any route is undocumented or unguarded, and Spectral lints the spec against the OWASP API Security ruleset. The generator (`assets/openapi.js`) is verified against Joi 18, Express 5 and swagger-ui-express 5.

**Built for scale** (`references/scale.md`):
- modular monolith with lint-enforced boundaries
- stateless API processes
- BullMQ queues with a transactional outbox
- cursor pagination, ETags and 202 async jobs
- circuit breakers and load shedding
- OpenTelemetry tracing and SLOs
- zero-trust networking and secrets
- a full CI/CD pipeline and a production-readiness gate

What it enforces, among other things:
- **Object-level authorization in the query** (`scoped({ _id }, user)`), never fetch-then-check, never IDs merged from params+query+body.
- **Injection-proof Mongo:** `sanitizeFilter`, `strictQuery`, escaped + bounded regex search, allowlisted updates with `runValidators`.
- **Money integrity:** integer minor units, transactions with conditional atomic updates, idempotency keys, ledger + audit log, maker-checker.
- **Always-on hardening:** helmet, CORS allowlist, body limits, Redis-backed rate limits (strict on login/OTP/SMS), server timeouts, redacted structured logs, generic 5xx with request IDs.
- **Operational safety:** env validation at boot, health/readiness probes, graceful shutdown, fatal-error exit, tests for 401/403/cross-tenant/injection/double-spend.

---

## Security Model

- **Shared baseline**: five laws (never trust input, deny by default, secrets never leave the server, fail closed, the supply chain is attack surface) plus universal controls, all inherited by every skill.
- **Platform controls**: Server Action/DAL rules for Next.js, token storage and XSS rules for React, secure storage, deep links and OTA signing for React Native and Flutter, and the full Express playbook for Node.
- **Supply-chain gate**: every skill scans an unfamiliar repo **before** running `npm install` or a dev server. The scanner (`skills/security-audit/scripts/scan-supply-chain.mjs`) is dependency-free and read-only. It detects:
  - code hidden after long whitespace runs
  - `global[...] = require` hijacks
  - `eval` of encoded blobs
  - side effects in `*.config.*` files
  - install scripts
  - auto-run VS Code tasks
  - suspicious git hooks
  - lockfile problems
  - unpinned CI actions

  Use it in CI too:
  ```bash
  node path/to/scan-supply-chain.mjs .    # exit 2 = critical, 1 = high
  ```

---

## Technology Versions (October 2026)

| Area | Version |
|---|---|
| Node.js | 24 LTS (26 LTS from Oct 2026) |
| Express | 5.x |
| Mongoose | 9.x |
| Next.js | 16.x |
| React | 19.2 (+ React Compiler) |
| Vite | 7+ |
| Expo SDK / React Native | 57 / 0.86 |
| Reanimated | 4.x |
| Flutter / Dart | 3.44+ / 3.12+ |
| Riverpod | 3.x |
| TypeScript | 5.x |
| Tailwind CSS | 4.x |
| TanStack Query | 5.x |
| Zod | 4.x |
| Zustand | 5.x |
| Motion (ex-Framer Motion) | 12.x |

---

## Contributing

Skills are plain markdown. No build step.

1. Create `skills/<name>/SKILL.md` with frontmatter `name`, `description` (what + when to use), optional `argument-hint`.
2. Structure: Role → Pre-Flight (read `${CLAUDE_PLUGIN_ROOT}/shared/design-rules.md` and/or `security-baseline.md`, run the scanner on unfamiliar repos) → Stack → Instructions → Security → Scope → Inputs → Success Criteria → Review Flags → Reporting.
3. Keep `SKILL.md` under 500 lines; move deep reference material into `references/`.
4. Validate: `claude plugin validate .`
5. Open a pull request.

MIT licence.

---

*Built for engineers who are never satisfied with "good enough."*
