// Actual Express handlers over loopback HTTP, with blocked in-memory Prisma.
// No external service, real database, SMTP, account recovery or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const root = process.env.DESIGN_PM_ROOT || new URL('../', import.meta.url).pathname;
const require = createRequire(root + '/package.json');
const express = require('express'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'isolated-session-recovery-and-admin-safety-secret';
process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/never_connect';
for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) delete process.env[key];
const { prisma } = await import(root + '/src/lib/db.js');
const { requireAuth, signToken, JWT_SECRET } = await import(root + '/src/middleware/auth.js');
const clone = value => structuredClone(value);
const person = (id, role = 'member') => ({ id, name: 'Fixture ' + id, role, active: true, pendingActivation: false, sessionVersion: 0 });
let state, databaseFailure, commitConflict, queue, transactions;
function reset(twoAdmins = false) { state = { staff: [person(1, 'admin'), person(2, twoAdmins ? 'admin' : 'member')], notifications: [] }; databaseFailure = commitConflict = false; queue = Promise.resolve(); transactions = []; }
function matches(row, where = {}) { return Object.entries(where).every(([key, value]) => value && typeof value === 'object' ? ('not' in value ? row[key] !== value.not : false) : row[key] === value); }
function adapter(data, transaction = false) {
  return {
    staff: {
      findUnique: async ({ where }) => { if (databaseFailure) throw Error('Synthetic database unavailable'); return clone(data.staff.find(row => matches(row, where)) || null); },
      findMany: async ({ where = {} } = {}) => clone(data.staff.filter(row => matches(row, where))),
      update: async ({ where, data: patch }) => {
        const row = data.staff.find(row => matches(row, where)); if (!row) throw Object.assign(Error('Missing fixture'), { code: 'P2025' });
        for (const [key, value] of Object.entries(patch)) row[key] = value?.increment ? row[key] + value.increment : clone(value);
        return clone(row);
      },
      delete: async ({ where }) => { assert(transaction, 'staff deletion must be transactional'); const row = data.staff.find(row => matches(row, where)); data.staff = data.staff.filter(p => p !== row); return clone(row); },
    },
    case: { findMany: async () => [] },
    notification: { findFirst: async () => null, create: async ({ data: row }) => { state.notifications.push(clone(row)); return row; } },
  };
}
reset();
for (const model of ['staff', 'case', 'notification', 'transferLog']) for (const method of ['findUnique', 'findMany', 'findFirst', 'count', 'create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany']) {
  prisma[model][method] = async (...args) => { const fn = adapter(state)[model]?.[method]; if (!fn) throw Error('Blocked unexpected Prisma access ' + model + '.' + method); return fn(...args); };
}
for (const method of ['$connect', '$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe']) prisma[method] = async () => { throw Error('Live database prohibited'); };
prisma.$transaction = (fn, options) => {
  assert.equal(options?.isolationLevel, 'Serializable'); transactions.push(options);
  const result = queue.then(async () => { const data = clone(state), result = await fn(adapter(data, true)); if (commitConflict) throw Object.assign(Error('Fixture serializable conflict'), { code: 'P2034' }); state = data; return result; });
  queue = result.catch(() => {}); return result;
};
prisma.$disconnect = async () => {};
const app = express(); app.use(express.json(), cookieParser());
app.use('/api/auth', (await import(root + '/src/routes/auth.js')).default);
app.use('/api/staff', (await import(root + '/src/routes/staff.js')).default);
app.all('/api/private', requireAuth, (req, res) => res.json({ id: req.user.id }));
// Register the actual source's login/SPA gates, without starting its server,
// background reminders, or a separate implementation of authentication logic.
const source = fs.readFileSync(root + '/src/index.js', 'utf8');
const start = source.indexOf('function isAuthed(req)'), end = source.indexOf('// Error handler', start);
assert(start >= 0 && end > start);
vm.runInNewContext(source.slice(start, end), { app, jwt, JWT_SECRET, path, PUBLIC_DIR: path.join(root, 'public'), sendNoCacheHtml(res, file) { res.set('Cache-Control', 'no-store'); res.sendFile(file); } });
app.use((_error, _req, res, _next) => res.status(500).json({ error: 'server_error' }));
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const cookie = (id = 1, claims = {}) => 'designpm_token=' + signToken({ id, sessionVersion: 0, ...claims });
async function call(url, { method = 'GET', body, token = cookie() } = {}) {
  const response = await fetch(base + url, { method, redirect: 'manual', headers: { ...(token ? { Cookie: token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, location: response.headers.get('location'), cleared: response.headers.get('set-cookie') };
}
const adminCount = () => state.staff.filter(s => s.role === 'admin' && s.active && !s.pendingActivation).length;
const depart = (id, actor = id) => call('/api/staff/' + id + '/departure', { method: 'POST', body: { successors: {} }, token: cookie(actor) });
const demote = (id, actor = id) => call('/api/staff/' + id, { method: 'PATCH', body: { role: 'member' }, token: cookie(actor) });
let passed = 0;
async function test(name, fn) { reset(); await fn(); passed++; console.log('PASS ' + name); }
try {
  await test('login is always reachable with a valid signed cookie and does not redirect to the shell', async () => {
    const r = await call('/login'); assert.equal(r.status, 200); assert.equal(r.location, null); assert.match(r.data, /id="login-form"/);
  });
  for (const [name, change] of [['deleted', () => { state.staff = state.staff.filter(s => s.id !== 1); }], ['inactive', () => { state.staff[0].active = false; }], ['pending', () => { state.staff[0].pendingActivation = true; }], ['revoked version', () => { state.staff[0].sessionVersion++; }]]) {
    await test(name + ' session returns 401 clears cookie and reaches the login page without a redirect loop', async () => {
      const stale = cookie(); change(); const r = await call('/api/auth/me', { token: stale });
      assert.equal(r.status, 401); assert.equal(r.data.error, 'session_expired'); assert.match(r.cleared, /designpm_token=;/); assert.match(r.cleared, /Expires=Thu, 01 Jan 1970/);
      assert.equal((await call('/login', { token: stale })).status, 200);
      const shell = await call('/', { token: '' }); assert.equal(shell.status, 302); assert.equal(shell.location, '/login');
      assert.equal((await call(shell.location, { token: '' })).status, 200);
    });
  }
  await test('malformed expired and future login tokens clear their cookies', async () => {
    for (const token of ['designpm_token=invalid', 'designpm_token=' + jwt.sign({ id: 1 }, JWT_SECRET, { expiresIn: -1 }), 'designpm_token=' + jwt.sign({ id: 1 }, JWT_SECRET, { notBefore: 3600 })]) {
      const r = await call('/api/auth/me', { token }); assert.equal(r.status, 401); assert.equal(r.data.error, 'invalid_token'); assert.match(r.cleared, /designpm_token=;/);
    }
  });
  await test('valid login and anonymous API behavior remain intact', async () => {
    const r = await call('/api/auth/me'); assert.equal(r.status, 200); assert.equal(r.data.id, 1); assert.equal(r.cleared, null);
    assert.equal((await call('/api/auth/me', { token: '' })).status, 401); assert.equal((await call('/')).status, 200);
  });
  await test('database failure remains 500 keeps the session cookie and leaves login reachable', async () => {
    databaseFailure = true; const r = await call('/api/auth/me'); assert.equal(r.status, 500); assert.equal(r.cleared, null);
    assert.equal((await call('/login')).status, 200); databaseFailure = false; assert.equal((await call('/api/auth/me')).status, 200);
  });
  await test('authorization denial does not clear a still-valid observer session', async () => {
    state.staff[0].role = 'observer'; const r = await call('/api/private', { method: 'POST', body: {} }); assert.equal(r.status, 403); assert.equal(r.cleared, null);
  });
  await test('the sole login administrator cannot self-depart through the UI delete/departure route', async () => {
    const before = clone(state.staff); const r = await depart(1); assert.equal(r.status, 409); assert.equal(r.data.error, 'last_admin'); assert.match(r.data.message, /管理員/);
    assert.deepEqual(state.staff, before); assert.equal(adminCount(), 1); assert.equal((await call('/api/auth/me')).status, 200);
  });
  await test('the last eligible administrator cannot be demoted or hard-deleted', async () => {
    assert.equal((await demote(1)).data.error, 'last_admin');
    const r = await call('/api/staff/1', { method: 'DELETE' }); assert.equal(r.status, 409); assert.equal(r.data.error, 'last_admin'); assert.equal(adminCount(), 1);
  });
  await test('pending inactive and non-admin staff cannot satisfy the remaining-admin requirement', async () => {
    for (const flags of [{ role: 'admin', pendingActivation: true }, { role: 'admin', active: false }, { role: 'observer' }]) {
      reset(); Object.assign(state.staff[1], flags); assert.equal((await depart(1)).data.error, 'last_admin'); assert.equal((await demote(1)).data.error, 'last_admin'); assert.equal(adminCount(), 1);
    }
  });
  await test('deactivating another member leaves the current administrator and app authenticated', async () => {
    assert.equal((await depart(2, 1)).status, 200); assert.equal(state.staff[1].active, false); assert.equal((await call('/api/auth/me')).status, 200); assert.equal((await call('/api/private')).status, 200);
  });
  await test('self-departure with another eligible administrator invalidates only the departed session', async () => {
    reset(true); const stale = cookie(); assert.equal((await depart(1)).status, 200); assert.equal(adminCount(), 1);
    const r = await call('/api/auth/me', { token: stale }); assert.equal(r.status, 401); assert.match(r.cleared, /designpm_token=;/);
    assert.equal((await call('/login', { token: stale })).status, 200); assert.equal((await call('/api/auth/me', { token: cookie(2) })).status, 200);
  });
  await test('demotion with another eligible administrator and inactive staff deletion remain supported', async () => {
    reset(true); assert.equal((await demote(2, 1)).status, 200); assert.equal(state.staff[1].role, 'member');
    state.staff[1].active = false; assert.equal((await call('/api/staff/2', { method: 'DELETE' })).status, 200); assert.equal(state.staff.length, 1); assert.equal(adminCount(), 1);
  });
  for (const endpoints of [['demote', 'demote'], ['depart', 'depart'], ['demote', 'depart']]) {
    await test('concurrent administrator removal retains one eligible administrator: ' + endpoints.join('/'), async () => {
      reset(true); const remove = (kind, id) => kind === 'demote' ? demote(id) : depart(id);
      const results = await Promise.all(endpoints.map((kind, index) => remove(kind, index + 1)));
      assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); assert.equal(adminCount(), 1); assert(transactions.every(t => t.isolationLevel === 'Serializable'));
    });
  }
  await test('a serialization failure rolls back a demotion or departure and returns 409', async () => {
    for (const remove of [demote, depart]) { reset(true); const before = clone(state.staff); commitConflict = true; const r = await remove(1); assert.equal(r.status, 409); assert.deepEqual(state.staff, before); assert.equal(adminCount(), 2); }
  });
  console.log(JSON.stringify({ passed, liveDatabase: false, emailsSent: 0, accountRecovery: false }));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); }
