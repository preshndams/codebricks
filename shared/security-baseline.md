# CodeBricks — Shared Security Baseline

> Every CodeBricks skill (frontend, mobile, backend, audit) inherits this file.
> Platform skills add stack-specific controls on top. They never relax these.
> Mapped to **OWASP Top 10:2025**, **OWASP API Security Top 10:2023**, and **OWASP ASVS 5.0**.

---

## The Security Laws (non-negotiable)

**Law S1 — Never trust input. Any input.**
Bodies, params, query strings, headers, cookies, webhooks, files, env-provided URLs, third-party API responses, deep links, and data read back from your own database are all untrusted until validated against an allowlist schema.

**Law S2 — Deny by default. Authorize every object.**
Authentication answers *who*. Authorization answers *may this user touch THIS record*. Every read and write of a tenant/branch/user-owned record is scoped in the query itself, not checked after the fact.

**Law S3 — Secrets never leave the server.**
No secret in client bundles, mobile binaries, `NEXT_PUBLIC_` / `VITE_` / `EXPO_PUBLIC_` / `--dart-define` values, logs, error responses, git history, or screenshots. Anything shipped to a device is public.

**Law S4 — Fail closed, fail quietly.**
On error, deny access and roll back. Return a generic message plus a correlation ID to the client; log full detail server-side. Never leak stack traces, query shapes, internal hostnames, or upstream error bodies.

**Law S5 — The supply chain is attack surface.**
Every dependency, build script, CI action, editor config, and git hook can execute code on your machine or server. Treat them like code you wrote — because once installed, they are.

---

## Pre-Flight Security Checklist (every session)

- [ ] Is there a `SECURITY.md` or a security section in `CODEBRICKS.md`? Read it. It sets data classification and compliance (GDPR, NDPR, HIPAA, PCI-DSS).
- [ ] What data does this feature touch? Classify it: **public / internal / personal (PII) / sensitive (financial, health, credentials, government IDs)**.
- [ ] Who may call this? Unauthenticated, authenticated, role, owner-only, tenant-scoped?
- [ ] Is a lockfile committed? (`package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `pubspec.lock`). If it's gitignored, flag it as **High**.
- [ ] Before running ANY project script (`npm install`, `npm run dev`, build, tests) in an unfamiliar or recently-pulled repo: run `/codebricks:security-audit --scan-only` or the scanner directly. Obfuscated payloads hide in config files and entry points.

---

## Universal Controls

### Input & Output
- Validate with a schema (Zod, Joi, Valibot, freezed+json_serializable) at every trust boundary. **Reject unknown keys** — never strip-and-continue on security-relevant fields.
- Bound everything: string lengths, array sizes, numeric ranges, pagination `limit` (hard max, never "0 = unlimited"), upload sizes, request body size.
- Encode on output for the context: HTML, attribute, URL, header, SQL/NoSQL, shell, log line.
- Never build queries, shell commands, regexes, file paths, URLs, or HTTP headers by string-concatenating user input.

### Authentication
- Passwords: **argon2id** (preferred) or bcrypt cost ≥ 12. Never MD5/SHA-x for passwords.
- Tokens, OTPs, reset codes, IDs: `crypto.randomBytes` / `crypto.randomInt` / `crypto.randomUUID` (or platform CSPRNG). **Never `Math.random()`.**
- Compare secrets with constant-time comparison (`crypto.timingSafeEqual`).
- Sessions/JWTs: short-lived access token, rotating refresh token, server-side revocation list, algorithm pinned, `iss`/`aud`/`exp` verified.
- Web: tokens in `HttpOnly; Secure; SameSite=Lax|Strict` cookies — **not** `localStorage`. Mobile: OS keystore (Keychain / Keystore via secure storage).
- Brute force: rate-limit and lock out login, OTP, password reset, and any endpoint that sends SMS/email (SMS pumping fraud is real money).
- Privileged roles (admin, finance, support) require MFA.

### Authorization
- Object-level: include the owner/tenant/branch in the DB query (`findOne({ _id, branchId })`), not a post-fetch `if`.
- Function-level: every route declares its required permission; a route without one fails CI review.
- Property-level: response DTOs are allowlists; write DTOs are allowlists. Never accept `role`, `isAdmin`, `balance`, `status`, `ownerId` from the client unless that endpoint exists to change exactly that field under a stricter permission.
- Never make an authorization decision from a value the client can supply in more than one place (e.g. merging `params`, `query`, and `body` — attackers choose which one you read).

### Data Protection
- TLS everywhere; HSTS on web.
- Encrypt sensitive fields at rest (government IDs, account numbers, health data) with envelope encryption / KMS.
- Money: integer minor units (kobo, cents) or `Decimal128` — **never floating point**. Balance changes are atomic, transactional, idempotent, and audited.
- Minimize: don't collect, return, or log what you don't need.

### Errors, Logging & Monitoring
- Structured logs with a request/correlation ID. Redact `authorization`, `cookie`, `password`, `pin`, `otp`, `token`, `secret`, `bvn`, `nin`, `cardNumber`, `cvv`, `accountNumber` by default.
- Never log request bodies wholesale — not even in development (dev logs leak to shared terminals, CI, and screenshots).
- Audit log (append-only) for auth events, permission changes, and every money movement: who, what, when, from where, before/after.
- Alert on: auth failure spikes, 5xx spikes, rate-limit trips, privilege changes, outbound calls to unknown hosts.

### Security Headers (web / API)
`Content-Security-Policy` (nonce-based for apps with inline scripts), `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `frame-ancestors 'none'` (or explicit allowlist). CORS: explicit origin allowlist — never `*` with credentials, never reflect arbitrary `Origin`.

---

## Supply Chain (OWASP A03:2025)

- **Commit the lockfile.** Install with `npm ci` / `pnpm install --frozen-lockfile` / `flutter pub get --enforce-lockfile`.
- `.npmrc`: `ignore-scripts=true` by default; allowlist packages that genuinely need install scripts.
- Delay adopting brand-new releases (Renovate `minimumReleaseAge` / pnpm `minimumReleaseAge` ≥ 3 days). Most malicious npm versions are pulled within hours.
- CI: `npm audit --omit=dev --audit-level=high` (or `osv-scanner`) fails the build. Dependabot/Renovate on.
- GitHub Actions: pin third-party actions to a full commit SHA, set `permissions:` to least privilege, never expose secrets to `pull_request` from forks, don't run untrusted code on self-hosted runners that hold deploy credentials.
- Branch protection + required review on `main` and deploy branches. `CODEOWNERS` on config files (`*.config.*`, `.github/`, `.vscode/`, `.husky/`, `package.json`).
- **Watch for injected payloads** — the active real-world pattern:
  - Code appended to the end of a line after hundreds of spaces (invisible in editors without wrap).
  - `global[...] = require`, `new Function(...)`, `eval(...)`, large `String.fromCharCode` / hex / base64 blobs in non-asset files.
  - Edits to `postcss.config.*`, `tailwind.config.*`, `next.config.*`, `vite.config.*`, `eslint.config.*`, `babel.config.*`, entry points, and dev scripts that ride along in unrelated feature commits.
  - `.vscode/tasks.json` with `"runOn": "folderOpen"`, unexpected `preinstall`/`postinstall` scripts, modified `.husky/` or `.git/hooks/`.
  - If found: **stop**, do not run the project, treat the machine that committed it as compromised, follow the incident steps in `/codebricks:security-audit`.

---

## Security Severity Scale (used in every report)

| Severity | Meaning | Example |
|---|---|---|
| **Critical** | Exploitable now; RCE, auth bypass, mass data/money exposure | Malicious payload in repo; missing auth on a money endpoint |
| **High** | Exploitable with modest effort or insider access | IDOR across tenants; NoSQL operator injection; secrets in client bundle |
| **Medium** | Needs chaining or specific conditions | Missing rate limit on OTP; verbose 500 errors; open CORS without credentials |
| **Low** | Hardening / defence in depth | Missing `Permissions-Policy`; outdated but unexploitable dependency |

---

## Security Validation Checklist (before marking any task done)

- [ ] All new inputs validated by schema with unknown keys rejected and every field bounded
- [ ] Every new route/action/screen has explicit authN + authZ, object-level scoped
- [ ] No secrets in client code, public env vars, logs, or responses
- [ ] Errors are generic to the client and detailed (and redacted) server-side
- [ ] Rate limits on auth, OTP, messaging, and expensive endpoints
- [ ] Money/state changes are atomic, idempotent, and audited
- [ ] No new dependency without checking: maintainer, age, downloads, install scripts, necessity
- [ ] Lockfile updated and committed with the change
- [ ] Report includes a `🔒 Security` section listing controls applied and residual risks with severity
