# Node Backend — Security Playbook

Concrete controls for Express 5 + Mongoose + Redis. Every section maps to **OWASP Top 10:2025** (A01–A10) and **OWASP API Security Top 10:2023** (API1–API10).
Inherits `${CLAUDE_PLUGIN_ROOT}/shared/security-baseline.md`.

---

## 0. Threat-Model Every Feature (5 questions, before code)

1. **Assets** — what's valuable here? (money, PII, credentials, availability)
2. **Actors** — anonymous, customer, staff role X, other tenant/branch, provider webhook, insider
3. **Entry points** — routes, webhooks, queues, cron, admin scripts
4. **Abuse cases** — "As a CSO in branch A, can I read/modify branch B's customer?" "Can I replay this deposit?" "Can I make the server call an arbitrary URL?" "Can I make it send 10,000 SMS?"
5. **Controls** — which sections below close each abuse case? Write them into the PR description.

---

## 1. Broken Access Control — A01 / API1 / API3 / API5

**Object-level (BOLA/IDOR)** — scope inside the query (see `scoped()` in architecture.md):
```js
// ❌ fetch then check (forgettable, leaks existence via 403 vs 404)
const c = await Customer.findById(id); if (c.branchId != user.branchId) throw ...
// ✅ the database enforces it
const c = await Customer.findOne(scoped({ _id: id }, user)).lean();
if (!c) throw new NotFoundError('Customer not found');
```

**Multi-source ID confusion** — the attacker picks which value your guard reads:
```js
// ❌ guard validates customerId from ?query, handler acts on :savingId from params
const { customerId, savingId } = { ...req.params, ...req.query, ...req.body };
// ✅ one declared source, validated, and the handler re-scopes its own lookup
const { savingId } = req.validated.params;
const saving = await Saving.findOne(scoped({ _id: savingId }, req.user, 'branchId'));
```

**Function-level (BFLA)** — every route has `accessGuard(module, action)`. Add a test that walks `app._router` / a route registry and fails if any non-`// PUBLIC:` route lacks `guard`.

**Property-level (BOPLA / mass assignment)**:
```js
const UPDATABLE = ['firstName', 'lastName', 'phoneNumber', 'address'];   // never role, status, balance, branchId
await Customer.updateOne(scoped({ _id: id }, user), { $set: pick(req.validated.body, UPDATABLE) }, { runValidators: true });
```
Responses: explicit `.select()` / DTO mappers. Schema secrets: `password: { type: String, select: false }`.

**Privilege changes** (role, permissions, branch reassignment) → bump `permissionsVersion` and delete the user's sessions so stale cached permissions die immediately.

---

## 2. Security Misconfiguration — A02 / API8

| Check | Correct |
|---|---|
| helmet | On in all envs |
| CORS | Allowlist function; no `*` with credentials; no origin reflection |
| `x-powered-by` | Disabled |
| `trust proxy` | Exact hop count/subnet (wrong value = rate limits bypassable via `X-Forwarded-For`) |
| Body parsers | `limit` on `json` **and** `urlencoded`; `extended: false` |
| Swagger | Off in prod or behind `guard` + admin permission |
| Errors | No stack traces / DB messages to clients |
| `NODE_ENV` | `production` in prod (Express perf + no dev logging) |
| Debug endpoints / seed routes | Absent from prod builds |
| Cookies (if used) | `HttpOnly; Secure; SameSite=Lax`; `__Host-` prefix |
| HTTP methods | Only those the router defines; OPTIONS handled by CORS |

---

## 3. Software Supply Chain — A03 / API10

- `package-lock.json` **committed**; CI uses `npm ci`. A gitignored lockfile means every deploy resolves fresh, unreviewed versions → **High**.
- `.npmrc`:
  ```ini
  ignore-scripts=true
  audit-level=high
  save-exact=true
  ```
  Packages that truly need install scripts (`bcrypt`, `sharp`): run `npm rebuild <pkg>` explicitly in CI, or prefer pure-JS alternatives (`bcryptjs`, `@node-rs/argon2` prebuilt).
- CI gates: `npm audit --omit=dev --audit-level=high`, `npx lockfile-lint --type npm --path package-lock.json --allowed-hosts npm --validate-https`, the CodeBricks scanner.
- Renovate with `minimumReleaseAge: "3 days"`; group minor/patch; review majors.
- GitHub Actions hardening:
  ```yaml
  permissions: { contents: read }
  jobs:
    ci:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@<full-40-char-sha>   # v5
          with: { persist-credentials: false }
        - uses: actions/setup-node@<full-sha>         # v5
          with: { node-version: 24, cache: npm }
        - run: npm ci
        - run: node scripts/scan-supply-chain.mjs .  # copy from codebricks/skills/security-audit/scripts
        - run: npm run lint && npm test
        - run: npm audit --omit=dev --audit-level=high
  ```
  Deploy jobs: separate workflow, `environment:` with required reviewers, OIDC to cloud instead of long-lived keys. Self-hosted runners that hold deploy credentials never run code from PRs.
- Before running a pulled repo: scan first (Pre-Flight step 2). Payloads ride along in commits titled like ordinary features.

---

## 4. Cryptographic Failures — A04

```js
// Passwords — argon2id (preferred)
import { hash, verify } from '@node-rs/argon2';
const pwHash = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 }); // OWASP minimums
const ok = await verify(pwHash, password);

// bcryptjs acceptable for existing projects: cost >= 12
const pwHash2 = await bcrypt.hash(password, 12);
```

```js
import { randomInt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

// OTP / PIN — CSPRNG, stored hashed, short TTL, attempt-limited
const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
await redis.set(`otp:${userId}`, sha256(otp), 'EX', 300);
await redis.set(`otp:tries:${userId}`, 0, 'EX', 300);

const sha256 = (s) => createHash('sha256').update(s).digest();
export const safeEqual = (a, b) => a.length === b.length && timingSafeEqual(a, b);

// Opaque tokens (reset links, API keys): 32 random bytes, store only the hash
const token = randomBytes(32).toString('base64url');
```

- JWT: `HS256` with ≥ 32-byte secret, or `EdDSA`/`ES256` with keys from a secret manager. Always pass `algorithms`, `issuer`, `audience`. Access TTL ≤ 15 min; refresh tokens are opaque, rotated on use, reuse detection revokes the family.
- Field encryption for government IDs / account numbers: AES-256-GCM with a KMS-held data key; store `iv`, `tag`, `keyId`. Keep a separate blind index (HMAC) if you must search by the value.
- Never log, return, or email secrets. Reset links expire in ≤ 30 min and are single-use.

---

## 5. Injection — A05 / API8

**NoSQL operator injection**: `{ "password": { "$ne": null } }` in a body bypasses naive lookups.
Defences (all three): Joi types (`Joi.string()` rejects objects), `mongoose.set('sanitizeFilter', true)`, never pass request objects into filters.

**Regex injection / ReDoS**:
```js
// ❌ { name: { $regex: searchTerm, $options: 'i' } }  — "(a+)+$" pins the DB CPU
// ✅
searchTerm: Joi.string().trim().max(100)                // bound it
const rx = new RegExp(escapeRegex(searchTerm), 'i');    // escape it
// Better for large collections: a text index or Atlas Search
```
Keep `security/detect-unsafe-regex` and `security/detect-non-literal-regexp` **on**; suppress per-line with a justification only after escaping.

**Command / path / template**:
```js
import { execFile } from 'node:child_process';
execFile('pdftotext', [safePath, '-'], { timeout: 10_000 });     // args array, no shell

const base = path.resolve('storage/exports');
const target = path.resolve(base, name);
if (!target.startsWith(base + path.sep)) throw new ValidationError('Invalid path');
```

**Header injection**: user text in `Content-Disposition` → `res.attachment(safeFilename(exportTitle) + '.pdf')`.

**Prototype pollution**: reject `__proto__`, `constructor`, `prototype` keys (Joi `object().unknown(false)` does); avoid deep-merge of request data; use `Object.hasOwn`, `Object.create(null)` for lookup maps; `--disable-proto=delete` Node flag in prod.

**Lookup-table injection**: `PROVIDERS[configValue.toLowerCase()]` → validate against `Object.hasOwn(PROVIDERS, key)` or a `Map`, and fail closed.

---

## 6. Insecure Design — A06 / API6 (business flows)

**Money movement template** (deposit / withdrawal / loan repayment):
```js
import mongoose from 'mongoose';

export const withdraw = async ({ savingId, amountKobo, idempotencyKey }, actor) => {
  const cached = await redis.get(`idem:${actor.userId}:${idempotencyKey}`);
  if (cached) return JSON.parse(cached);                     // replay → same result, no double debit

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const saving = await Saving.findOneAndUpdate(
        scoped({ _id: savingId, status: 'ACTIVE', balanceKobo: mongoose.trusted({ $gte: amountKobo }) }, actor),
        { $inc: { balanceKobo: -amountKobo } },
        { new: true, session },
      );
      if (!saving) throw new UnProcessibleEntityError('Insufficient balance or savings unavailable');

      const [txn] = await Transaction.create([{
        savingId, type: 'WITHDRAWAL', amountKobo, balanceAfterKobo: saving.balanceKobo,
        status: 'PENDING_APPROVAL', requestedBy: actor.userId, idempotencyKey,
      }], { session });

      await AuditLog.create([{ actor: actor.userId, action: 'WITHDRAWAL_REQUESTED', ref: txn._id, amountKobo }], { session });
      result = { success: true, message: 'Withdrawal requested', data: { transactionId: txn.id } };
    });
    await redis.set(`idem:${actor.userId}:${idempotencyKey}`, JSON.stringify(result), 'EX', 86_400);
    return result;
  } finally {
    await session.endSession();
  }
};
```
Requirements this encodes: integer kobo; conditional atomic update (no read-modify-write race); transaction spanning balance + ledger + audit; idempotency; scoped access; state machine.

**Approval (maker-checker)**:
```js
const txn = await Transaction.findOneAndUpdate(
  { _id: id, status: 'PENDING_APPROVAL', requestedBy: { $ne: actor.userId } },   // can't approve your own
  { $set: { status: 'APPROVED', approvedBy: actor.userId, approvedAt: new Date() } },
  { new: true, session },
);
```

**Abuse limits**: daily withdrawal caps, velocity checks, SMS/OTP per-recipient + per-IP + global budget, export row caps, report date-range caps.

**Unique constraints** at the DB level for anything that must not duplicate (account numbers, references, idempotency keys).

---

## 7. Authentication Failures — A07 / API2

Login flow:
1. Rate-limit by IP **and** by account identifier (`sensitiveLimiter` + Redis counter per email/phone).
2. Same error and similar timing for unknown user vs wrong password (verify against a dummy hash when user not found).
3. After N failures: exponential backoff / temporary lock + notify user.
4. On success: new session ID (`sid = randomUUID()`), store `session:<sid>` in Redis with TTL, sign JWT `{ sub, sid }` only — no roles/permissions in the token (they're read from the session server-side).
5. Single-session policy (if required): `userLogin:<userId> → sid`; new login deletes the previous `session:<sid>`.
6. Logout, password change, role change, account disable → delete sessions.
7. MFA (TOTP / WebAuthn) for admin, finance, and approval roles.

Password reset: opaque token hashed at rest, 30-min TTL, single use, invalidates all sessions on success, response identical whether or not the account exists.

---

## 8. Software & Data Integrity — A08

**Webhook verification (Paystack example)**:
```js
// routes: mount raw body ONLY for the webhook path, before express.json()
route.post('/webhooks/paystack', express.raw({ type: 'application/json', limit: '100kb' }), async (req, res) => {
  // PUBLIC: provider callback — authenticated by HMAC signature
  const expected = createHmac('sha512', config.paystack.secret).update(req.body).digest('hex');
  const received = String(req.headers['x-paystack-signature'] ?? '');
  if (!safeEqual(Buffer.from(expected), Buffer.from(received))) return res.sendStatus(401);

  const event = JSON.parse(req.body.toString('utf8'));
  const fresh = await redis.set(`webhook:paystack:${event.data?.id}:${event.event}`, 1, 'EX', 7 * 86_400, 'NX');
  if (!fresh) return res.sendStatus(200);          // replay / duplicate

  await queue.add('paystack-event', event);       // process async, idempotently
  res.sendStatus(200);
});
```
Always re-verify the transaction with the provider's API before crediting — the webhook is a hint, not proof.

**Deserialization**: no `eval`, `new Function`, `vm` on input; no `node-serialize`; YAML with safe schema only.

**Code integrity**: protected branches, required reviews, signed commits for release branches, CODEOWNERS on configs.

---

## 9. Logging & Alerting Failures — A09

Log (structured, with `requestId`, `userId`, `ip`): login success/failure, lockouts, permission denials, role changes, money movements, webhook verification failures, rate-limit trips, admin exports.
Never log: bodies, tokens, passwords, OTPs, full account/card numbers, government IDs.
Audit log collection: append-only (no update/delete routes; DB user without delete privilege on that collection), retained per regulation.
Alerts: 5xx rate, auth-failure spikes, 403 spikes from one user (IDOR probing), SMS spend, unusual export volume.

---

## 10. Mishandling of Exceptional Conditions — A10

- Every `await` on a lookup handles `null` → 404 / fail closed. Guards never `next()` after an unresolved scope.
- Outbound calls: timeout + bounded retry with backoff on idempotent calls only; circuit-break flaky providers.
  ```js
  export const http = axios.create({ timeout: 10_000, maxRedirects: 0 });
  const { data } = await http.get(`${base}/bank/resolve`, { params: { account_number, bank_code }, headers });  // params encoded
  ```
- Upstream errors mapped to typed errors; upstream bodies never forwarded.
- Event listeners and queue workers catch, log, and dead-letter — never crash the process silently or swallow silently.
- Process-level handlers exit on fatal errors so the orchestrator restarts a clean process.
- Transactions roll back on any throw (use `withTransaction`).

---

## 11. Unrestricted Resource Consumption — API4

Body limits · pagination caps · `maxTimeMS` · report/export caps and streaming · upload size + type limits (presigned S3 POST with `content-length-range` and fixed `Content-Type`) · per-route rate limits · server timeouts · queue concurrency limits.

## 12. SSRF — API7

Outbound hosts come from config, not input. If a URL must come from input (webhooks to customer endpoints): `https` only, resolve DNS and reject private/link-local/metadata ranges (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `::1`, `fc00::/7`), no redirects, short timeout.

## 13. Unsafe Consumption of APIs — API10

Validate provider responses with a schema before use; treat them as untrusted input; bound their size; never render provider error strings to users.

## 14. Improper Inventory — API9

`/v1` versioning; deprecated routes removed, not forgotten; OpenAPI generated from code is the inventory; staging uses separate credentials and data.

---

## Review Grep Kit

```bash
grep -rnE '\$regex' src/                                   # raw regex queries
grep -rnE '\.\.\.req\.(params|query|body)' src/            # merged-source IDs
grep -rnE 'findByIdAndUpdate\([^,]+,\s*(req\.)?body' src/  # mass assignment
grep -rnE 'Math\.random' src/                              # weak randomness
grep -rnE 'console\.(log|error)\(.*(req\.body|headers|token|password)' src/
grep -rnE 'cors\(\)' src/                                  # open CORS
grep -rnE 'limit\)?\.default\(0\)' src/                    # unbounded pagination
grep -rnE 'eval\(|new Function\(|global\[' src/            # code execution / payloads
```
