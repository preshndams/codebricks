// CodeBricks contract tests — copy to tests/openapi.test.js.
// Fails the build when: a route is undocumented, a documented operation has no route, a protected
// route is missing guard/accessGuard, docs and router disagree about what is public, or an
// operation lacks auth/permission metadata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modules } from '../src/app/modules/index.js';
import { spec } from '../src/app/docs/spec.js';
import { listRoutes } from '../src/app/docs/openapi.js';
import { guard } from '../src/app/utils/authGuard.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const key = (method, path) => `${method.toUpperCase()} ${path}`;

const documented = () =>
  Object.entries(spec.paths).flatMap(([path, ops]) =>
    Object.keys(ops).filter((m) => METHODS.includes(m)).map((m) => key(m, path)),
  );

test('every route is documented, every documented operation is routed', () => {
  const routed = listRoutes(modules).map(([m, p]) => key(m, p));
  const docs = documented();
  assert.deepEqual(routed.filter((r) => !docs.includes(r)), [], 'routes missing from docs.js');
  assert.deepEqual(docs.filter((d) => !routed.includes(d)), [], 'documented operations with no route');
});

test('protected routes mount guard + accessGuard; public routes are explicit on both sides', () => {
  for (const m of modules) {
    for (const layer of m.router.stack.filter((l) => l.route)) {
      const handles = layer.route.stack.map((l) => l.handle);
      const isPublic = handles.some((h) => h.isPublic);
      for (const method of Object.keys(layer.route.methods)) {
        const path = `${m.path}${layer.route.path === '/' ? '' : layer.route.path}`.replace(/:(\w+)/g, '{$1}');
        const op = spec.paths[path]?.[method];
        const where = key(method, path);
        if (isPublic) {
          assert.deepEqual(op?.security, [], `${where} is publicRoute but docs require auth`);
        } else {
          assert.ok(handles.includes(guard), `${where} is missing guard`);
          assert.ok(handles.some((h) => h.isAccessGuard), `${where} is missing accessGuard`);
          assert.ok(op?.security?.length, `${where} docs must declare bearerAuth`);
          assert.ok(op?.['x-permission'], `${where} docs must declare x-permission`);
        }
      }
    }
  }
});

test('every operation has a summary, tag, operationId and error responses', () => {
  const ids = new Set();
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const where = key(method, path);
      assert.ok(op.summary, `${where} needs a summary`);
      assert.ok(op.tags?.length, `${where} needs a tag`);
      assert.ok(!ids.has(op.operationId), `duplicate operationId ${op.operationId}`);
      ids.add(op.operationId);
      for (const code of ['400', '429', '500']) assert.ok(op.responses[code], `${where} must document ${code}`);
    }
  }
});
