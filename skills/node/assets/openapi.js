// CodeBricks OpenAPI toolkit — copy to src/app/docs/openapi.js.
// Generates an OpenAPI 3.1 spec from each module's Joi validation + docs.js, serves Swagger UI,
// and exposes listRoutes() for the route↔spec drift test. Verified with Joi 18, Express 5,
// swagger-ui-express 5, and Spectral (spectral:oas + OWASP API ruleset: 0 errors).
import { timingSafeEqual, createHash } from 'node:crypto';
import swaggerUi from 'swagger-ui-express';

// ---------- Joi → OpenAPI 3.1 (JSON Schema 2020-12) ----------
// Uses Joi's public describe() output so request docs can never drift from validation.

const rulesOf = (d) => Object.fromEntries((d.rules ?? []).map((r) => [r.name, r.args ?? {}]));

const describeToSchema = (d) => {
  const flags = d.flags ?? {};
  const rules = rulesOf(d);
  let s = {};

  switch (d.type) {
    case 'string':
      s.type = 'string';
      if (rules.min) s.minLength = rules.min.limit;
      if (rules.max) s.maxLength = rules.max.limit;
      if (rules.length) s.minLength = s.maxLength = rules.length.limit;
      if (rules.email) s.format = 'email';
      if (rules.uri) s.format = 'uri';
      if (rules.guid || rules.uuid) s.format = 'uuid';
      if (rules.isoDate) s.format = 'date-time';
      if (rules.hex) s.pattern = '^[0-9a-fA-F]+$';
      if (rules.pattern) s.pattern = String(rules.pattern.regex).replace(/^\/|\/[a-z]*$/g, '');
      break;
    case 'number':
      s.type = rules.integer ? 'integer' : 'number';
      if (rules.min) s.minimum = rules.min.limit;
      if (rules.max) s.maximum = rules.max.limit;
      if (rules.greater) s.exclusiveMinimum = rules.greater.limit;
      if (rules.less) s.exclusiveMaximum = rules.less.limit;
      if (s.type === 'integer') s.format = Math.abs(s.maximum ?? Infinity) <= 2_147_483_647 ? 'int32' : 'int64';
      break;
    case 'boolean':
      s.type = 'boolean';
      break;
    case 'date':
      s = { type: 'string', format: 'date-time' };
      break;
    case 'array':
      s.type = 'array';
      s.items = d.items?.length === 1 ? describeToSchema(d.items[0]) : d.items?.length ? { oneOf: d.items.map(describeToSchema) } : {};
      if (rules.min) s.minItems = rules.min.limit;
      if (rules.max) s.maxItems = rules.max.limit;
      if (rules.length) s.minItems = s.maxItems = rules.length.limit;
      break;
    case 'object': {
      s.type = 'object';
      const keys = Object.entries(d.keys ?? {}).filter(([, v]) => v.flags?.presence !== 'forbidden');
      if (keys.length) s.properties = Object.fromEntries(keys.map(([k, v]) => [k, describeToSchema(v)]));
      const required = keys.filter(([, v]) => v.flags?.presence === 'required').map(([k]) => k);
      if (required.length) s.required = required;
      s.additionalProperties = flags.unknown === true;
      if (rules.min) s.minProperties = rules.min.limit;
      if (rules.max) s.maxProperties = rules.max.limit;
      break;
    }
    case 'alternatives':
      s.oneOf = (d.matches ?? []).filter((m) => m.schema).map((m) => describeToSchema(m.schema));
      break;
    default:
      break; // any / custom → unconstrained
  }

  const allow = d.allow ?? [];
  if (flags.only && allow.length) s.enum = allow.filter((v) => v !== null && v !== '');
  if (allow.includes(null) && s.type) s.type = [s.type, 'null'];
  if (flags.description) s.description = flags.description;
  if (flags.default !== undefined && typeof flags.default !== 'function') s.default = flags.default;
  if (d.examples?.length) s.examples = d.examples;
  for (const meta of d.metas ?? []) Object.assign(s, meta); // .meta({...}) overrides / extends
  return s;
};

export const joiToSchema = (joiSchema) => describeToSchema(joiSchema.describe());

// ---------- Operation builder ----------

const envelope = (data) => ({
  type: 'object',
  required: ['success', 'message', 'data'],
  properties: { success: { const: true }, message: { type: 'string', maxLength: 500, pattern: '^[^<>]*$' }, data },
});

/** Every 2xx/4xx advertises rate-limit state (express-rate-limit `standardHeaders: 'draft-8'`). */
// Inlined (not components.headers) — the OWASP ruleset treats a components.headers map as a response.
const rateLimitHeaders = {
  'Access-Control-Allow-Origin': { description: 'Echoes the request Origin only when it is on the server allowlist', schema: { type: 'string', format: 'uri', maxLength: 200 } },
  RateLimit: { description: 'Remaining quota and reset (IETF RateLimit header, draft-8)', schema: { type: 'string', maxLength: 200, pattern: String.raw`^[\w=;,." -]*$` } },
  'RateLimit-Policy': { description: 'Quota policy (IETF RateLimit-Policy header, draft-8)', schema: { type: 'string', maxLength: 200, pattern: String.raw`^[\w=;,." -]*$` } },
};
const retryAfterHeader = { 'Retry-After': { description: 'Seconds until the client may retry', schema: { type: 'integer', format: 'int32', minimum: 0, maximum: 86_400 } } };

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const errorRef = (code) => ({ $ref: `#/components/responses/${code}` });

const toParameters = (joiSchema, location) => {
  if (!joiSchema) return [];
  const schema = joiToSchema(joiSchema);
  return Object.entries(schema.properties ?? {}).map(([name, s]) => {
    const { description, ...rest } = s;
    return { name, in: location, required: location === 'path' || (schema.required ?? []).includes(name), ...(description && { description }), schema: rest };
  });
};

/**
 * Build one OpenAPI operation from the route's Joi validation + a few facts.
 * @param {object} o
 * @param {string} o.summary
 * @param {string} o.tag
 * @param {object} [o.validation]  the same object passed to joiValidator: { params, query, body }
 * @param {string} [o.permission]  e.g. 'branch.canList' → documented as x-permission
 * @param {boolean} [o.public]     no auth (also needs a // PUBLIC: comment on the route)
 * @param {number} [o.status]      success status (default 200)
 * @param {string|object} [o.data] component schema name, { list: 'Name' } for paginated lists, or inline schema
 * @param {string} [o.description]
 * @param {boolean} [o.idempotent] documents the Idempotency-Key header (money-moving POSTs)
 * @param {boolean} [o.deprecated]
 */
export const op = (o) => {
  const v = o.validation ?? {};
  const data =
    typeof o.data === 'string' ? ref(o.data)
    : o.data?.list ? ref(`Paginated${o.data.list}`)
    : o.data ?? { type: 'array', maxItems: 0 };

  const parameters = [...toParameters(v.params?.schema, 'path'), ...toParameters(v.query?.schema, 'query')];
  if (o.idempotent) parameters.push({ $ref: '#/components/parameters/IdempotencyKey' });

  const responses = {
    [o.status ?? 200]: { description: 'Success', headers: rateLimitHeaders, content: { 'application/json': { schema: envelope(data) } } },
    400: errorRef('BadRequest'),
    429: errorRef('TooManyRequests'),
    500: errorRef('ServerError'),
  };
  if (!o.public) Object.assign(responses, { 401: errorRef('Unauthorized'), 403: errorRef('Forbidden') });
  if (v.params) responses[404] = errorRef('NotFound');

  return {
    ...(o.id && { operationId: o.id }), // otherwise derived in buildSpec from method + path
    tags: [o.tag],
    summary: o.summary,
    ...(o.description && { description: o.description }),
    ...(o.permission && { 'x-permission': o.permission, description: `${o.description ? `${o.description}\n\n` : ''}**Requires permission:** \`${o.permission}\`` }),
    ...(o.deprecated && { deprecated: true }),
    ...(parameters.length && { parameters }),
    ...(v.body && { requestBody: { required: true, content: { 'application/json': { schema: joiToSchema(v.body.schema) } } } }),
    security: o.public ? [] : [{ bearerAuth: [] }],
    responses,
  };
};

// ---------- Spec assembly ----------

const EXAMPLE_REQUEST_ID = '0b7c4a52-1f0e-4f6b-9d3c-2a1e5f8b7c90';
const errorResponse = (description, error, message, extraHeaders = {}) => ({
  description,
  headers: { ...rateLimitHeaders, ...extraHeaders },
  content: { 'application/json': { schema: ref('Error'), example: { success: false, message, error, requestId: EXAMPLE_REQUEST_ID } } },
});

/** Stable error codes — keep in sync with utils/error.js. Documented as an enum so clients can switch on them. */
export const ERROR_CODES = [
  'VALIDATION_ERROR', 'BAD_REQUEST', 'AUTHENTICATION_ERROR', 'AUTHORISATION_ERROR', 'ENTRY_NOT_FOUND', 'ROUTE_NOT_FOUND',
  'ENTRY_EXISTS', 'WRONG_INPUT', 'PAYMENT_REQUIRED', 'RATE_LIMITED', 'FATAL_ERROR',
];

const pascal = (s) => s.replace(/[{}]/g, '').split(/[/_-]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
const deriveOperationId = (method, path) =>
  method + pascal(path.replace(/\{(\w+)\}/g, 'By-$1'));

export const buildSpec = ({ modules, info, servers }) => {
  const paths = {};
  const schemas = {
    Error: {
      type: 'object',
      required: ['success', 'message', 'error', 'requestId'],
      properties: {
        success: { const: false },
        message: { type: 'string', maxLength: 500, pattern: '^[^<>]*$' },
        error: { type: 'string', enum: ERROR_CODES },
        requestId: { type: 'string', format: 'uuid', maxLength: 36 },
      },
    },
  };

  for (const m of modules) {
    if (!m.docs) continue;
    for (const [p, ops] of Object.entries(m.docs.paths)) {
      const full = `${m.path}${p === '/' ? '' : p}`;
      const withIds = Object.fromEntries(
        Object.entries(ops).map(([method, o]) => [method, { operationId: deriveOperationId(method, full), ...o }]),
      );
      paths[full] = { ...paths[full], ...withIds };
    }
    for (const [name, schema] of Object.entries(m.docs.schemas ?? {})) {
      schemas[name] = schema;
      schemas[`Paginated${name}`] = {
        type: 'object',
        required: ['list', 'pageNo', 'limit', 'totalCount', 'totalPages'],
        properties: {
          list: { type: 'array', maxItems: 100, items: ref(name) },
          pageNo: { type: 'integer', format: 'int32', minimum: 1, maximum: 10_000 },
          limit: { type: 'integer', format: 'int32', minimum: 1, maximum: 100 },
          totalCount: { type: 'integer', format: 'int64', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          totalPages: { type: 'integer', format: 'int64', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        },
      };
    }
  }

  return {
    openapi: '3.1.0',
    info,
    servers: servers.map((s) => ({ 'x-internal': false, ...s })), // API9: declare each server's audience
    tags: modules.filter((m) => m.docs?.tag).map((m) => m.docs.tag),
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
          description: 'Short-lived access token (≤15 min) from POST /user/login. Tokens follow RFC8725 (JWT Best Current Practices): algorithm pinned server-side, iss/aud/exp verified, session revocable server-side.',
        },
      },
      parameters: {
        IdempotencyKey: { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', format: 'uuid', maxLength: 36 }, description: 'Unique per logical operation. Replays return the original result without re-executing.' },
      },
      schemas,
      responses: {
        BadRequest: errorResponse('Validation failed', 'VALIDATION_ERROR', 'name is required'),
        Unauthorized: errorResponse('Missing or invalid session', 'AUTHENTICATION_ERROR', 'Access denied, kindly login'),
        Forbidden: errorResponse('Authenticated but not permitted', 'AUTHORISATION_ERROR', 'Access denied'),
        NotFound: errorResponse('Not found or outside your data scope', 'ENTRY_NOT_FOUND', 'Not found'),
        Conflict: errorResponse('Duplicate or state conflict', 'ENTRY_EXISTS', 'Entry already exists'),
        TooManyRequests: errorResponse('Rate limit exceeded', 'RATE_LIMITED', 'Too many requests', retryAfterHeader),
        ServerError: errorResponse('Unexpected error (details are logged server-side, never returned)', 'FATAL_ERROR', 'Something went wrong. Please try again.'),
      },
    },
  };
};

// ---------- Serving ----------

const sha = (s) => createHash('sha256').update(String(s)).digest();

/** HTTP Basic gate for docs in production. Constant-time compare on hashes (equal length). */
export const docsBasicAuth = ({ user, password }) => (req, res, next) => {
  const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
  const decoded = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
  const sep = decoded.indexOf(':');                       // passwords may contain ':'
  const u = sep >= 0 ? decoded.slice(0, sep) : '';
  const p = sep >= 0 ? decoded.slice(sep + 1) : '';
  const ok = timingSafeEqual(sha(u), sha(user)) & timingSafeEqual(sha(p), sha(password));
  if (ok) return next();
  res.set('WWW-Authenticate', 'Basic realm="api-docs"').status(401).end();
};

/**
 * Mount docs on a router: GET /openapi.json + /docs (Swagger UI).
 * mode: 'public' (local/dev/staging) | 'protected' (prod, basic auth) | 'off'
 */
export const mountDocs = (router, spec, { mode = 'public', basicAuth, persistAuthorization = false } = {}) => {
  if (mode === 'off') return;
  const gate = mode === 'protected' ? [docsBasicAuth(basicAuth)] : [];
  const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
  router.get('/openapi.json', ...gate, noStore, (req, res) => res.json(spec));
  router.use('/docs', ...gate, noStore, swaggerUi.serveFiles(spec), swaggerUi.setup(spec, {
    customSiteTitle: spec.info.title,
    swaggerOptions: { persistAuthorization, displayRequestDuration: true, tryItOutEnabled: mode === 'public' },
  }));
};

// ---------- Drift detection (used by tests) ----------

/** List [METHOD, '/v1/x/{id}'] for every route a module router registers (Express 5). */
export const listRoutes = (modules, prefix = '') =>
  modules.flatMap((m) =>
    m.router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) =>
        Object.keys(layer.route.methods).filter((verb) => verb !== '_all').map((verb) => [
          verb.toUpperCase(),
          `${prefix}${m.path}${layer.route.path === '/' ? '' : layer.route.path}`.replace(/:(\w+)/g, '{$1}'),
        ]),
      ),
  );
