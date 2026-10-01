# Node Backend — Architecture Templates

Hardened reference implementation of the CodeBricks module pattern (derived from the psardi backend).
Copy the shapes, keep the project's existing names. JavaScript ESM shown; TypeScript projects use identical structure.

---

## 1. `src/index.js` — Bootstrap

Order matters: config → connections → listen → signals. Nothing else lives here.

```js
import { config } from './app/config/env.js';
import { createApp } from './app/index.js';
import { connectDB, disconnectDB } from './app/utils/db.js';
import { redis } from './app/utils/redis.js';
import { logger } from './app/utils/logger.js';

const start = async () => {
  await connectDB();                 // throws → process exits non-zero
  await redis.ping();

  const app = createApp();
  const server = app.listen(config.port, () => logger.info({ port: config.port }, 'server listening'));

  server.requestTimeout = 30_000;
  server.headersTimeout = 35_000;
  server.keepAliveTimeout = 5_000;

  const shutdown = (signal) => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await Promise.allSettled([disconnectDB(), redis.quit()]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();   // hard stop
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

process.on('unhandledRejection', (err) => { logger.fatal({ err }, 'unhandledRejection'); process.exit(1); });
process.on('uncaughtException', (err) => { logger.fatal({ err }, 'uncaughtException'); process.exit(1); });

start().catch((err) => { logger.fatal({ err }, 'startup failed'); process.exit(1); });
```

Scripts: `"start": "node --env-file-if-exists=.env src/index.js"`, `"dev": "node --watch --env-file-if-exists=.env src/index.js"` (Node 22+ — no `dotenv`/`nodemon` needed). Set `"engines": { "node": ">=24" }`.

---

## 2. `src/app/config/env.js` — Validated Config

The **only** file that reads `process.env`. Everything else imports `config`.

```js
import Joi from 'joi';

const schema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'staging', 'production').default('development'),
  PORT: Joi.number().port().default(4000),
  MONGO_URI: Joi.string().uri({ scheme: ['mongodb', 'mongodb+srv'] }).required(),
  REDIS_URI: Joi.string().uri({ scheme: ['redis', 'rediss'] }).required(),
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_ISSUER: Joi.string().default('api'),
  JWT_AUDIENCE: Joi.string().default('web'),
  CORS_ORIGINS: Joi.string().required(),            // comma-separated allowlist
  TRUST_PROXY: Joi.alternatives(Joi.number().integer().min(0), Joi.string()).default(1),
  ENABLE_DOCS: Joi.boolean().default(false),
  PAYSTACK_SECRET_KEY: Joi.string().allow(''),
  PAYSTACK_BASE_URL: Joi.string().uri({ scheme: ['https'] }).default('https://api.paystack.co'),
}).unknown(true);                                   // OS env has many unrelated keys

const { value, error } = schema.validate(process.env, { abortEarly: false });
if (error) {
  // Print key names only — never values.
  throw new Error(`Invalid environment: ${error.details.map((d) => d.context.key).join(', ')}`);
}

export const config = Object.freeze({
  env: value.NODE_ENV,
  isProd: value.NODE_ENV === 'production',
  port: value.PORT,
  mongoUri: value.MONGO_URI,
  redisUri: value.REDIS_URI,
  jwt: { secret: value.JWT_SECRET, issuer: value.JWT_ISSUER, audience: value.JWT_AUDIENCE, ttl: '15m' },
  corsOrigins: value.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  trustProxy: value.TRUST_PROXY,
  enableDocs: value.ENABLE_DOCS,
  paystack: { secret: value.PAYSTACK_SECRET_KEY, baseUrl: value.PAYSTACK_BASE_URL },
});
```

Commit `.env.example` (keys, no values). Never commit `.env`.

---

## 3. `src/app/index.js` — App Factory

```js
import express from 'express';
import middleware from './routes/middleware.js';
import routes from './routes/index.js';
import swagger from './routes/swagger.js';
import { errorHandler, notFoundHandler } from './utils/errorHandler.js';
import { config } from './config/env.js';
import './utils/eventHandlers.js';

export const createApp = () => {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  middleware(app);
  routes(app);
  if (config.enableDocs) swagger(app);   // off by default; protect with guard if on in prod

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
};
```

A factory (not a singleton) lets tests build a fresh app with `supertest`.

---

## 4. `src/app/routes/middleware.js` — Security Stack

```js
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { redis } from '../utils/redis.js';

export const limiter = (opts) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: new RedisStore({ sendCommand: (...args) => redis.call(...args), prefix: `rl:${opts?.name ?? 'global'}:` }),
    message: { success: false, message: 'Too many requests, please try again later.', error: 'RATE_LIMITED' },
    ...opts,
  });

// Strict limiter for login / OTP / reset / SMS / export routes — import into module routers.
export const sensitiveLimiter = limiter({ name: 'sensitive', windowMs: 15 * 60 * 1000, limit: 10 });

export default (app) => {
  app.use(pinoHttp({
    logger,
    genReqId: (req, res) => {
      const id = randomUUID();       // never trust a client-supplied ID for correlation
      res.setHeader('X-Request-Id', id);
      return id;
    },
    serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url }) }, // no bodies, no headers
  }));

  app.use(helmet());                 // every environment
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    maxAge: 600,
  }));
  app.use(compression());
  app.use(limiter());
  app.use(json({ limit: '100kb' }));
  app.use(urlencoded({ extended: false, limit: '100kb' }));
};
```

Webhook routes that need the raw body for HMAC verification mount `express.raw({ type: 'application/json', limit: '100kb' })` **before** `json()` on that path only.

---

## 5. `src/app/routes/index.js` — Mounting

```js
import { Router } from 'express';
import mongoose from 'mongoose';
import { redis } from '../utils/redis.js';
import userRoute from '../modules/user/index.js';
import branchRoute from '../modules/branch/index.js';
import savingTypeRoute from '../modules/savingType/index.js';   // a ROUTER — never a model

export default (app) => {
  const v1 = Router();

  v1.get('/healthz', (req, res) => res.json({ success: true, message: 'ok', data: [] }));
  v1.get('/readyz', async (req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    const redisUp = (await redis.ping().catch(() => null)) === 'PONG';
    res.status(dbUp && redisUp ? 200 : 503).json({ success: dbUp && redisUp, message: 'readiness', data: { dbUp, redisUp } });
  });

  v1.use('/user', userRoute);
  v1.use('/branch', branchRoute);
  v1.use('/saving-type', savingTypeRoute);

  app.use('/v1', v1);
};
```

---

## 6. `src/app/utils/error.js` + `errorHandler.js`

Keep the house error classes; add a base class so the handler can tell "safe to show" from "internal".

```js
// error.js
export class AppError extends Error {
  constructor(message, { name, httpStatusCode, expose = true } = {}) {
    super(message);
    this.name = name;
    this.httpStatusCode = httpStatusCode;
    this.expose = expose;          // only AppErrors with expose=true reach the client verbatim
  }
}
export class ValidationError extends AppError { constructor(m) { super(m, { name: 'VALIDATION_ERROR', httpStatusCode: 400 }); } }
export class AuthenticationError extends AppError { constructor(m = 'Authentication required') { super(m, { name: 'AUTHENTICATION_ERROR', httpStatusCode: 401 }); } }
export class AuthorizationError extends AppError { constructor(m = 'Access denied') { super(m, { name: 'AUTHORISATION_ERROR', httpStatusCode: 403 }); } }
export class NotFoundError extends AppError { constructor(m = 'Not found') { super(m, { name: 'ENTRY_NOT_FOUND', httpStatusCode: 404 }); } }
export class EntryExistError extends AppError { constructor(m) { super(m, { name: 'ENTRY_EXISTS', httpStatusCode: 409 }); } }
export class UnProcessibleEntityError extends AppError { constructor(m) { super(m, { name: 'WRONG_INPUT', httpStatusCode: 422 }); } }
export class TooManyRequestsError extends AppError { constructor(m = 'Too many requests') { super(m, { name: 'RATE_LIMITED', httpStatusCode: 429 }); } }
```

```js
// errorHandler.js
import { AppError } from './error.js';

export const notFoundHandler = (req, res) =>
  res.status(404).json({ success: false, message: 'Route not found', error: 'ROUTE_NOT_FOUND' });

// Express 5: async throws and rejected promises land here automatically.
export const errorHandler = (err, req, res, _next) => {
  const isApp = err instanceof AppError && err.expose;
  const isBodyParse = err.type === 'entity.parse.failed' || err.type === 'entity.too.large';
  const status = isApp ? err.httpStatusCode : isBodyParse ? (err.status ?? 400) : 500;

  if (status >= 500) req.log.error({ err }, 'unhandled error');
  else req.log.warn({ err: { name: err.name, message: err.message } }, 'request rejected');

  res.status(status).json({
    success: false,
    message: isApp ? err.message : isBodyParse ? 'Invalid request body' : 'Something went wrong. Please try again.',
    error: isApp ? err.name : status === 500 ? 'FATAL_ERROR' : 'BAD_REQUEST',
    requestId: req.id,
  });
};
```

Mongo duplicate key (`err.code === 11000`) → convert to `EntryExistError` in the **service**, with a field-agnostic message.

---

## 7. `src/app/utils/index.js` — Validator & Helpers

```js
import Joi from 'joi';
import { isValidObjectId } from 'mongoose';
import { ValidationError } from './error.js';

const DEFAULT_OPTS = { abortEarly: true, allowUnknown: false, stripUnknown: false, convert: true };

const run = (schema, data, options) => {
  const { error, value } = schema.validate(data, { ...DEFAULT_OPTS, ...options });
  if (error) throw new ValidationError(error.details[0].message.replace(/"/g, ''));
  return value;
};

/** Validates body/params/query/headers. Results live ONLY in req.validated.* — controllers read nothing else. */
export const joiValidator = (constraint) => (req, res, next) => {
  req.validated = {};
  for (const part of ['params', 'query', 'body', 'headers']) {
    if (constraint[part]) {
      const opts = part === 'headers' ? { allowUnknown: true, ...constraint[part].options } : constraint[part].options;
      req.validated[part] = run(constraint[part].schema, req[part] ?? {}, opts);
    }
  }
  next();
};

export const JoiObjectId = () =>
  Joi.string().length(24).hex().custom((v, h) => (isValidObjectId(v) ? v : h.error('any.invalid')), 'ObjectId');

/** Standard pagination fragment — capped, never "0 = everything". */
export const paginationSchema = {
  pageNo: Joi.number().integer().min(1).max(10_000).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
};

/** Escape user text before using it in a RegExp / $regex. */
export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Allowlist object keys for updates (prevents mass assignment). */
export const pick = (obj, keys) =>
  Object.fromEntries(keys.filter((k) => Object.hasOwn(obj, k)).map((k) => [k, obj[k]]));

export const safeFilename = (s, fallback = 'export') =>
  (String(s || fallback).replace(/[^\w.-]+/g, '_').slice(0, 80) || fallback);
```

---

## 8. `src/app/utils/authGuard.js` — AuthN, RBAC, Scope

```js
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { getCache } from './redis.js';
import { USER_ROLE, ROLE_MAPPER } from './constant.js';
import { AuthenticationError, AuthorizationError } from './error.js';

const BEARER = /^Bearer ([A-Za-z0-9._-]+)$/;

/** AuthN: valid signature + live server-side session. 401 on any failure. */
export const guard = async (req, res, next) => {
  const match = BEARER.exec(req.headers.authorization ?? '');
  if (!match) throw new AuthenticationError('Access denied, kindly login');

  let payload;
  try {
    payload = jwt.verify(match[1], config.jwt.secret, {
      algorithms: ['HS256'], issuer: config.jwt.issuer, audience: config.jwt.audience,
    });
  } catch {
    throw new AuthenticationError('Session expired, kindly login');
  }

  const session = await getCache(`session:${payload.sid}`);     // allowlist: logout/password change deletes it
  if (!session || session.userId !== payload.sub) throw new AuthenticationError('Session expired, kindly login');

  req.user = session;   // { userId, role, branchId, assignedStates, permissionsVersion }
  next();
};

/** RBAC: permission derived from the role map on the server — never from the token or the client. */
export const accessGuard = (moduleKey, permissionKey) => (req, res, next) => {
  const { role } = req.user;
  if (role === USER_ROLE.superAdmin) return next();
  if (ROLE_MAPPER[role]?.[moduleKey]?.permissions?.[permissionKey] !== true) {
    throw new AuthorizationError(`Access denied: missing ${moduleKey}.${permissionKey}`);
  }
  next();
};

/**
 * Object-level authorization IN the database query. Services wrap every scoped lookup:
 *   Customer.findOne(scoped({ _id: customerId }, req.user))
 * A record outside the user's scope is simply not found → 404, never leaked.
 *
 * - `$and` (not object spread) so the scope can never overwrite a caller's key (e.g. both use `_id`).
 * - `mongoose.trusted()` marks server-built operators so `sanitizeFilter` doesn't neutralise them.
 * - Regional users: resolve assigned states → branch IDs at login and store them in the session.
 */
export const scoped = (filter, user, field = 'branchId') => {
  if (user.role === USER_ROLE.superAdmin) return filter;
  const branchIds = user.isRegional ? user.assignedBranchIds : user.branchId ? [user.branchId] : [];
  if (!branchIds?.length) throw new AuthorizationError('No data scope assigned');   // fail closed
  return { $and: [filter, { [field]: mongoose.trusted({ $in: branchIds }) }] };
};
```

Add `import mongoose from 'mongoose';` at the top of `authGuard.js`.

If a scope **middleware** is unavoidable, it reads IDs from exactly one source (`req.validated.params`), handles `null` lookups as 404, and never falls through to `next()` when the scope cannot be resolved.

---

## 9. The Module — `src/app/modules/branch/*`

### `index.js` — Router
```js
import { Router } from 'express';
import * as controller from './controller.js';
import validation from './validation.js';
import { joiValidator } from '../../utils/index.js';
import { guard, accessGuard } from '../../utils/authGuard.js';
import { ROUTE_MAPPER, ACTION_MAPPER } from '../../utils/constant.js';
import { processExport, processExportData } from '../../utils/processMiddleware.js';
import { sensitiveLimiter } from '../../routes/middleware.js';

const M = ROUTE_MAPPER.branch.name;
const route = Router();

route.get('/', guard, accessGuard(M, ACTION_MAPPER.list), joiValidator(validation.listBranch), processExport, controller.listBranch, processExportData);
route.get('/:branchId', guard, accessGuard(M, ACTION_MAPPER.view), joiValidator(validation.viewBranch), controller.viewBranch);
route.post('/', guard, accessGuard(M, ACTION_MAPPER.add), joiValidator(validation.createBranch), controller.createBranch);
route.patch('/:branchId', guard, accessGuard(M, ACTION_MAPPER.update), joiValidator(validation.updateBranch), controller.updateBranch);
route.delete('/:branchId', guard, accessGuard(M, ACTION_MAPPER.delete), joiValidator(validation.deleteBranch), controller.deleteBranch);
route.get('/export/all', guard, sensitiveLimiter, accessGuard(M, ACTION_MAPPER.list), /* ... */);

export default route;
```

Static paths (`/export/all`) are declared before or distinctly from param paths so `/:branchId` never swallows them.

### `validation.js`
```js
import Joi from 'joi';
import { JoiObjectId, paginationSchema } from '../../utils/index.js';
import { EXPORT_TYPES } from '../../utils/constant.js';

const name = Joi.string().trim().min(2).max(120);
const address = Joi.string().trim().max(300);
const branchIdParam = Joi.object({ branchId: JoiObjectId().required() });

export default {
  createBranch: {
    body: { schema: Joi.object({ name: name.required(), address: address.required(), state: Joi.string().max(60), lga: Joi.string().max(60) }) },
  },
  updateBranch: {
    params: { schema: branchIdParam },
    body: { schema: Joi.object({ name, address, state: Joi.string().max(60), lga: Joi.string().max(60) }).min(1) },
  },
  listBranch: {
    query: {
      schema: Joi.object({
        ...paginationSchema,
        searchTerm: Joi.string().trim().max(100),
        exportType: Joi.string().valid(...EXPORT_TYPES),
        exportTitle: Joi.string().trim().max(80),
      }),
    },
  },
  viewBranch: { params: { schema: branchIdParam } },
  deleteBranch: { params: { schema: branchIdParam } },
};
```

### `controller.js`
```js
import * as service from './service.js';
import { MODULES } from '../../utils/constant.js';

// Express 5 forwards async throws to the error handler — no try/catch boilerplate needed.
export const createBranch = async (req, res) => {
  res.status(201).json(await service.createBranch(req.validated.body, req.user));
};

export const updateBranch = async (req, res) => {
  res.status(200).json(await service.updateBranch(req.validated.params.branchId, req.validated.body, req.user));
};

export const viewBranch = async (req, res) => {
  res.status(200).json(await service.viewBranch(req.validated.params.branchId, req.user));
};

export const listBranch = async (req, res, next) => {
  const response = await service.listBranch(req.validated.query, req.user);
  if (req.validated.query.exportType) {
    req.exportData = response.data.list;
    req.exportModule = MODULES.BRANCH;
    return next();
  }
  res.status(200).json(response);
};

export const deleteBranch = async (req, res) => {
  res.status(200).json(await service.deleteBranch(req.validated.params.branchId, req.user));
};
```

### `service.js`
```js
import Branch from './model.js';
import User from '../user/model.js';
import { NotFoundError, EntryExistError, AuthorizationError } from '../../utils/error.js';
import { escapeRegex, pick, emitter } from '../../utils/index.js';
import { scoped } from '../../utils/authGuard.js';
import { USER_ROLE, EMITTER_EVENT } from '../../utils/constant.js';

const UPDATABLE = ['name', 'address', 'state', 'lga'];
const PUBLIC_FIELDS = 'name address state lga managerUserId createdAt updatedAt';

export const createBranch = async (body, actor) => {
  try {
    const branch = await Branch.create(pick(body, UPDATABLE));
    emitter.emit(EMITTER_EVENT.LOG_USER, { userId: actor.userId, action: 'CREATE_BRANCH', ref: branch.id });
    return { success: true, message: 'Branch created successfully', data: { id: branch.id } };
  } catch (err) {
    if (err.code === 11000) throw new EntryExistError('A branch with these details already exists');
    throw err;
  }
};

export const updateBranch = async (branchId, body, actor) => {
  const branch = await Branch.findOneAndUpdate(
    scoped({ _id: branchId }, actor, '_id'),
    { $set: pick(body, UPDATABLE) },
    { new: true, runValidators: true, projection: PUBLIC_FIELDS },
  ).lean();
  if (!branch) throw new NotFoundError('Branch not found');
  return { success: true, message: 'Branch updated successfully', data: branch };
};

export const listBranch = async ({ pageNo, limit, searchTerm }, actor) => {
  const filter = {};
  if (searchTerm) {
    const rx = new RegExp(escapeRegex(searchTerm), 'i');   // escaped + length-capped by the schema
    filter.$or = [{ name: rx }, { address: rx }];
  }
  const query = scoped(filter, actor, '_id');
  const [list, totalCount] = await Promise.all([
    Branch.find(query).select(PUBLIC_FIELDS)
      .populate({ path: 'managerUserId', select: 'firstName lastName role' })
      .sort({ createdAt: -1 }).skip((pageNo - 1) * limit).limit(limit)
      .maxTimeMS(5_000).lean(),
    Branch.countDocuments(query).maxTimeMS(5_000),
  ]);
  return { success: true, message: 'Branches retrieved successfully', data: { list, pageNo, limit, totalCount, totalPages: Math.ceil(totalCount / limit) } };
};

export const deleteBranch = async (branchId, actor) => {
  if (actor.role !== USER_ROLE.superAdmin) throw new AuthorizationError('Operation not allowed for user');
  if (await User.exists({ branchId })) throw new EntryExistError('Branch has assigned users and cannot be deleted');
  const { deletedCount } = await Branch.deleteOne({ _id: branchId });
  if (!deletedCount) throw new NotFoundError('Branch not found');
  return { success: true, message: 'Branch deleted successfully', data: [] };
};
```

### `model.js`
```js
import { Schema, model } from 'mongoose';

const schema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    address: { type: String, trim: true, maxlength: 300 },
    country: { type: String, default: 'Nigeria' },
    state: { type: String, maxlength: 60, index: true },
    lga: { type: String, maxlength: 60 },
    managerUserId: { type: Schema.Types.ObjectId, ref: 'Users' },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },   // unknown paths throw instead of silently dropping
);

schema.index({ name: 1, state: 1 }, { unique: true });
schema.index({ createdAt: -1 });

export default model('Branches', schema);
```

`timestamps: true` replaces hand-rolled `createdAt`/`updatedAt` defaults (which never update `updatedAt` on `findByIdAndUpdate`).

---

## 10. Logger — `src/app/utils/logger.js`

```js
import pino from 'pino';
import { config } from '../config/env.js';

export const logger = pino({
  level: config.isProd ? 'info' : 'debug',
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie', '*.password', '*.pin', '*.otp', '*.token',
      '*.refreshToken', '*.secret', '*.bvn', '*.nin', '*.accountNumber', '*.cardNumber', '*.cvv',
    ],
    censor: '[REDACTED]',
  },
  ...(config.isProd ? {} : { transport: { target: 'pino-pretty' } }),
});
```

---

## 11. Connections

```js
// db.js
import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);
mongoose.set('sanitizeFilter', true);      // wraps $-operators in filter values with $eq — server-built
                                           // operators must be wrapped: { f: mongoose.trusted({ $in: ids }) }
mongoose.set('autoIndex', !config.isProd); // build indexes via migration in prod

export const connectDB = async () => {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000, maxPoolSize: 20 });
  logger.info('mongo connected');
};
export const disconnectDB = () => mongoose.disconnect();
```

```js
// redis.js
import Redis from 'ioredis';
import { config } from '../config/env.js';
import { logger } from './logger.js';

export const redis = new Redis(config.redisUri, { maxRetriesPerRequest: 3, enableReadyCheck: true });
redis.on('error', (err) => logger.error({ err }, 'redis error'));

export const setCache = (key, value, ttlSeconds = 86_400) => redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
export const getCache = async (key) => { const v = await redis.get(key); return v ? JSON.parse(v) : null; };
export const deleteCache = (key) => redis.del(key);
// No flushall helper. Delete by explicit key or prefix scan.
```

---

## 12. Background Jobs

- `node-cron` only when exactly one instance runs, or guard each run with a Redis lock (`SET lock:<job> <id> NX PX <ttl>`).
- Multi-instance / retryable work → BullMQ queue + worker process. Jobs are idempotent and carry their own correlation ID.
- Never leave commented-out cron examples in `src/index.js` — document jobs in `src/app/jobs/README.md`.
