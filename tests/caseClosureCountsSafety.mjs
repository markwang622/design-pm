// Actual Express case routes with durable, rollback-capable isolated Prisma.
// No listener, real database, external HTTP, SMTP or production data is used.
import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex } from 'node:stream';
import { createRequire } from 'node:module';
const root = process.env.DESIGN_PM_ROOT || new URL('../', import.meta.url).pathname;
const require = createRequire(root + '/package.json');
const express = require('express'), cookieParser = require('cookie-parser');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'isolated-closure-count-tests-signing-secret';
process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:1/never_connect';
for (const key of Object.keys(process.env)) if (key.startsWith('SMTP_')) delete process.env[key];
const { prisma } = await import(root + '/src/lib/db.js');
const { signToken } = await import(root + '/src/middleware/auth.js');
const { taipeiCalendarDay } = await import(root + '/src/services/analytics.js');
const clone = value => structuredClone(value), cid = 'A-2026-10-001';
const people = new Map([
  { id: 1, name: 'Admin', role: 'admin' }, { id: 2, name: 'Owner', role: 'member' },
  { id: 3, name: 'Unrelated', role: 'member' }, { id: 4, name: 'Collaborator', role: 'member' },
  { id: 5, name: 'Observer', role: 'observer' },
].map(person => [person.id, { active: true, pendingActivation: false, sessionVersion: 0, ...person }]));
let state, queue, inTransaction, fail, readBarrier, readHook, trace;
const row = () => state.cases.get(cid);
function reset() {
  state = { cases: new Map([[cid, {
    id: cid, title: 'Closure fixture', requester: 'Fixture', level: 'A', designerId: 2, collaborators: [{ id: 4 }],
    status: 'closed', archived: true, archivePath: '/fixture/closed', closedOn: new Date('2026-10-22'),
    openDate: new Date('2026-10-01'), dispatchDate: new Date('2026-10-02'), goLiveDate: new Date('2026-10-30'),
    cancelledOn: null, cancelReason: null, cancelStage: null, requestCount: null, outputCount: null, actualWorkdays: null,
    note: 'Original note', contentVersion: 7, updatedAt: new Date('2026-10-22T01:00:00Z'),
    items: [{ n: 'Existing item', status: 'doing' }], logs: [{ id: 'existing-log', note: 'Keep history', by: 'Owner' }],
  }]]), audits: [], transfers: [], notifications: [] };
  queue = Promise.resolve(); inTransaction = 0; fail = ''; readBarrier = null; readHook = null;
  trace = { claims: [], transactions: [], directWrites: 0, creates: 0, notificationsInTransaction: 0 };
}
function matches(record, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (key === 'OR') return value.some(part => matches(record, part));
    if (key === 'AND') return value.every(part => matches(record, part));
    if (key === 'collaborators' && value?.some) return record.collaborators.some(person => matches(person, value.some));
    if (value instanceof Date) return new Date(record[key]).getTime() === value.getTime();
    if (value && typeof value === 'object') {
      if (value.startsWith !== undefined) return String(record[key]).startsWith(value.startsWith);
      if (value.in) return value.in.includes(record[key]);
      throw Error('Unsupported fixture predicate: ' + key);
    }
    return record[key] === value;
  });
}
function hydrate(record) {
  return record ? clone({ ...record, designer: people.get(record.designerId), collaborators: record.collaborators.map(p => people.get(p.id)) }) : null;
}
function apply(record, data) {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (key === 'collaborators') {
      if (value.set) record.collaborators = clone(value.set);
      if (value.connect) record.collaborators.push(...clone(value.connect));
      if (value.disconnect) record.collaborators = record.collaborators.filter(p => !value.disconnect.some(x => p.id === x.id));
    } else if (key === 'designer') record.designerId = value.connect.id;
    else if (key === 'createdBy') record.createdById = value.connect.id;
    else if (value && typeof value === 'object' && value.increment !== undefined) record[key] += value.increment;
    else record[key] = clone(value);
  }
  record.updatedAt = new Date(Math.max(Date.now(), new Date(record.updatedAt || 0).getTime() + 1));
  return record;
}
function client(database, transaction = false) {
  return {
    staff: {
      findUnique: async ({ where }) => clone(people.get(where.id) || null),
      findMany: async ({ where = {} } = {}) => clone([...people.values()].filter(person => matches(person, where))),
    },
    case: {
      findUnique: async ({ where }) => {
        if (fail === 'read') throw Error('Synthetic read failure');
        const result = hydrate(database.cases.get(where.id));
        if (!transaction) {
          if (readHook) { const hook = readHook; readHook = null; hook(); }
          if (readBarrier) await readBarrier();
        }
        return result;
      },
      findMany: async ({ where = {} } = {}) => [...database.cases.values()].filter(record => matches(record, where)).map(hydrate),
      updateMany: async ({ where, data }) => {
        trace.claims.push(clone({ where, data, transaction }));
        if (fail === 'write') throw Error('Synthetic database write failure');
        let count = 0;
        for (const record of database.cases.values()) if (matches(record, where)) { apply(record, data); count++; }
        return { count };
      },
      update: async ({ where, data }) => {
        trace.directWrites++;
        const record = database.cases.get(where.id); assert(record);
        return hydrate(apply(record, data));
      },
      create: async ({ data }) => {
        trace.creates++; assert(!database.cases.has(data.id));
        const record = apply({ archived: false, closedOn: null, collaborators: [], contentVersion: 0, requestCount: null, outputCount: null }, data);
        database.cases.set(record.id, record); return hydrate(record);
      },
    },
    changeLog: { createMany: async ({ data }) => {
      if (fail === 'audit') throw Error('Synthetic audit failure');
      database.audits.push(...clone(data)); return { count: data.length };
    } },
    transferLog: { create: async ({ data }) => { database.transfers.push(clone(data)); return clone(data); } },
    notification: {
      findFirst: async () => null,
      create: async ({ data }) => {
        if (inTransaction) trace.notificationsInTransaction++;
        assert.equal(inTransaction, 0, 'notification must follow transaction commit');
        state.notifications.push(clone(data)); return clone(data);
      },
    },
  };
}
reset();
for (const model of ['case', 'staff', 'changeLog', 'transferLog', 'notification']) {
  for (const method of ['findUnique', 'findFirst', 'findMany', 'count', 'update', 'updateMany', 'create', 'createMany', 'delete', 'deleteMany']) {
    prisma[model][method] = async (...args) => {
      const fn = client(state)[model]?.[method];
      if (!fn) throw Error('Blocked unexpected Prisma method ' + model + '.' + method);
      return fn(...args);
    };
  }
}
for (const method of ['$connect', '$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe']) prisma[method] = async () => { throw Error('Live database prohibited'); };
prisma.$disconnect = async () => {};
prisma.$transaction = (run, options) => {
  assert.equal(options?.isolationLevel, 'Serializable'); trace.transactions.push(clone(options));
  const result = queue.then(async () => {
    const isolated = clone(state); inTransaction++;
    try {
      const result = await run(client(isolated, true));
      if (fail === 'commit') throw Object.assign(Error('Synthetic serialization failure'), { code: 'P2034' });
      state = isolated; return result;
    } finally { inTransaction--; }
  });
  queue = result.catch(() => {}); return result;
};
const app = express(); app.use(cookieParser()); app.use('/api/cases', (await import(root + '/src/routes/cases.js')).default);
app.use((_error, _req, res, _next) => res.status(500).json({ error: 'server_error' }));
function call(suffix = cid, method = 'PATCH', body = {}, as = 2) {
  return new Promise((resolve, reject) => {
    const socket = new Duplex({ read() {}, write(_b, _e, done) { done(); } });
    const req = new http.IncomingMessage(socket); req.url = '/api/cases/' + suffix; req.method = method;
    req.headers = { cookie: 'designpm_token=' + signToken(people.get(as)), 'content-type': 'application/json' }; req.body = clone(body);
    const res = new http.ServerResponse(req);
    res.end = data => { resolve({ status: res.statusCode, data: JSON.parse(String(data)) }); socket.destroy(); return res; };
    app.handle(req, res, error => reject(error || Error('Route not handled')));
  });
}
const get = (id = cid) => call(id, 'GET');
const noSideEffects = () => { assert.equal(state.audits.length, 0); assert.equal(state.transfers.length, 0); assert.equal(state.notifications.length, 0); };
function barrierForTwoReads() {
  let count = 0, release; const waiting = new Promise(resolve => { release = resolve; });
  return async () => { if (++count <= 2) { if (count === 2) release(); await waiting; } };
}
let passed = 0;
async function test(name, run) { reset(); await run(); passed++; console.log('PASS ' + name); }
await test('owner closure counts persist in the database adapter and a fresh archived-case API read', async () => {
  const before = clone(row()); const result = await call(cid, 'PATCH', { requestCount: 3, outputCount: 12, note: 'Saved closure' });
  assert.equal(result.status, 200); assert.equal(row().requestCount, 3); assert.equal(row().outputCount, 12);
  const fresh = await get(); assert.equal(fresh.status, 200); assert.equal(fresh.data.requestCount, 3); assert.equal(fresh.data.outputCount, 12); assert.equal(fresh.data.note, 'Saved closure');
  for (const key of ['status', 'archived', 'archivePath', 'closedOn', 'contentVersion', 'items', 'logs', 'actualWorkdays']) assert.deepEqual(row()[key], before[key]);
  assert.equal(trace.transactions.length, 1); assert.equal(trace.directWrites, 0); assert.equal(trace.claims[0].transaction, true); noSideEffects();
});
for (const [role, as] of [['administrator', 1], ['collaborator', 4]]) await test(role + ' retains the existing right to update closure quantities', async () => {
  assert.equal((await call(cid, 'PATCH', { requestCount: 1, outputCount: 4 }, as)).status, 200);
  const fresh = await get(); assert.equal(fresh.data.requestCount, 1); assert.equal(fresh.data.outputCount, 4); noSideEffects();
});
await test('zero and the inclusive maximum persist without truthiness defaults or truncation', async () => {
  assert.equal((await call(cid, 'PATCH', { requestCount: 0, outputCount: 1_000_000 })).status, 200);
  assert.equal((await get()).data.requestCount, 0); assert.equal((await get()).data.outputCount, 1_000_000);
  assert.equal((await call(cid, 'PATCH', { outputCount: 0 })).status, 200); assert.equal(row().requestCount, 0); assert.equal(row().outputCount, 0);
});
await test('omitted quantities preserve unknown and already stored values independently', async () => {
  assert.equal((await call(cid, 'PATCH', { requestCount: 5 })).status, 200); assert.equal(row().requestCount, 5); assert.equal(row().outputCount, null);
  assert.equal((await call(cid, 'PATCH', { title: 'Unrelated title edit' })).status, 200);
  assert.equal((await get()).data.requestCount, 5); assert.equal((await get()).data.outputCount, null);
});
for (const field of ['requestCount', 'outputCount']) await test(field + ' rejects negative fractional oversized string null and nonnumeric payloads before any write', async () => {
  for (const value of [-1, 0.5, 1_000_001, Number.MAX_SAFE_INTEGER, '12', '', null, true, [], {}, NaN, Infinity]) {
    const before = clone(row()), result = await call(cid, 'PATCH', { [field]: value, note: 'Must not save' });
    assert.equal(result.status, 400); assert.equal(result.data.error, 'invalid_body'); assert(result.data.issues.some(issue => issue.path.join('.') === field));
    assert.deepEqual(row(), before); assert.equal(trace.transactions.length, 0); assert.equal(trace.directWrites, 0); noSideEffects();
  }
});
for (const [role, as] of [['unrelated member', 3], ['observer', 5]]) await test(role + ' cannot change either count or accompanying fields', async () => {
  const before = clone(row()); assert.equal((await call(cid, 'PATCH', { requestCount: 9, outputCount: 99, note: 'Forbidden' }, as)).status, 403);
  assert.deepEqual(row(), before); assert.equal(trace.claims.length, 0); assert.equal(trace.directWrites, 0); noSideEffects();
});
await test('a missing case returns 404 without fabricating a saved count', async () => {
  assert.equal((await call('MISSING', 'PATCH', { requestCount: 1, outputCount: 1 })).status, 404); assert.equal(trace.claims.length, 0);
});
await test('collaborators cannot combine counts with ownership changes or direct closure', async () => {
  for (const extra of [{ designerId: 4 }, { collaboratorIds: [] }, { status: 'closed' }, { status: 'done' }]) {
    const before = clone(row()); assert.equal((await call(cid, 'PATCH', { requestCount: 7, outputCount: 8, ...extra }, 4)).status, 403); assert.deepEqual(row(), before);
  }
  assert.equal(trace.claims.length, 0); noSideEffects();
});
await test('quantity payloads cannot overwrite archive dates JSON history content versions or inferred workdays', async () => {
  const before = clone(row()); const result = await call(cid, 'PATCH', {
    requestCount: 2, outputCount: 6, archived: false, closedOn: '2000-01-01', updatedAt: '2000-01-01T00:00:00Z',
    contentVersion: 999, actualWorkdays: 999, items: [], logs: [], designer: { connect: { id: 3 } }, createdById: 3,
  });
  assert.equal(result.status, 200); assert.equal(row().requestCount, 2); assert.equal(row().outputCount, 6);
  for (const key of ['archived', 'closedOn', 'contentVersion', 'actualWorkdays', 'items', 'logs', 'designerId', 'createdById']) assert.deepEqual(row()[key], before[key]);
  assert(new Date(row().updatedAt) > new Date(before.updatedAt)); noSideEffects();
});
await test('missing archive path and dedicated-cancellation rules reject counts atomically', async () => {
  row().status = 'doing'; row().archived = false; row().closedOn = null; row().archivePath = null;
  for (const status of ['review_done', 'cancelled']) {
    const before = clone(row()); const result = await call(cid, 'PATCH', { requestCount: 4, outputCount: 10, status });
    assert.equal(result.status, 422); assert.equal(result.data.error, status === 'cancelled' ? 'cancel_action_required' : 'archive_path_required'); assert.deepEqual(row(), before);
  }
  assert.equal(trace.claims.length, 0); noSideEffects();
});
await test('review submission persists quantities and retains after-commit admin notification semantics', async () => {
  row().status = 'doing'; row().archived = false;
  const result = await call(cid, 'PATCH', { requestCount: 0, outputCount: 6, status: 'review_done' }, 4);
  assert.equal(result.status, 200); assert.equal(row().status, 'review_done'); assert.equal(row().closedOn, null); assert.equal(row().archived, false);
  assert.equal(row().requestCount, 0); assert.equal(row().outputCount, 6); assert.deepEqual(state.audits.map(a => a.field), ['status']);
  assert.deepEqual(state.notifications.map(n => n.type), ['reviewDone']); assert.equal(state.notifications[0].recipientId, 1); assert.equal(trace.notificationsInTransaction, 0);
  assert.equal((await call(cid, 'PATCH', { outputCount: 8 })).status, 200); assert.equal(state.notifications.length, 1); assert.equal((await get()).data.outputCount, 8);
});
await test('approval after a quantity save retains both quantities and records actual closure', async () => {
  row().status = 'review_done'; row().archived = false; row().closedOn = null;
  assert.equal((await call(cid, 'PATCH', { requestCount: 2, outputCount: 9 })).status, 200); assert.equal(state.notifications.length, 0);
  const result = await call(cid + '/approve', 'POST', { decision: 'approve' }, 1);
  assert.equal(result.status, 200); assert.equal(row().status, 'closed'); assert.equal(row().archived, true); assert.equal(row().closedOn.toISOString(), taipeiCalendarDay().toISOString());
  const fresh = await get(); assert.equal(fresh.data.requestCount, 2); assert.equal(fresh.data.outputCount, 9);
  assert.deepEqual(state.notifications.map(n => n.type), ['caseClosed']); assert.equal(trace.notificationsInTransaction, 0);
});
await test('workflow audit failure rolls back the count pair note and status without notifying', async () => {
  row().status = 'doing'; row().archived = false; const before = clone(row()); fail = 'audit';
  assert.equal((await call(cid, 'PATCH', { requestCount: 2, outputCount: 3, note: 'Rollback', status: 'review_done' })).status, 500);
  assert.deepEqual(row(), before); noSideEffects();
});
await test('database write failure cannot be reported as a successful quantity save', async () => {
  const before = clone(row()); fail = 'write'; assert.equal((await call(cid, 'PATCH', { requestCount: 10, outputCount: 20 })).status, 500);
  assert.deepEqual(row(), before); assert.equal((await get()).data.requestCount, null); noSideEffects();
});
await test('concurrent count pairs have one successful snapshot claim and one conflict without mixed totals', async () => {
  readBarrier = barrierForTwoReads();
  const pairs = [{ requestCount: 2, outputCount: 6 }, { requestCount: 4, outputCount: 20 }];
  const results = await Promise.all(pairs.map(pair => call(cid, 'PATCH', pair)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); assert.equal(results.find(r => r.status === 409).data.error, 'case_conflict');
  const winner = pairs[results.findIndex(r => r.status === 200)], fresh = await get(); assert.equal(fresh.data.requestCount, winner.requestCount); assert.equal(fresh.data.outputCount, winner.outputCount); noSideEffects();
});
await test('ownership revocation between permission read and save prevents stale quantity writes', async () => {
  readHook = () => { row().designerId = 3; row().updatedAt = new Date('2026-10-23T00:00:00Z'); };
  const result = await call(cid, 'PATCH', { requestCount: 8, outputCount: 16 });
  assert.equal(result.status, 409); assert.equal(row().designerId, 3); assert.equal(row().requestCount, null); assert.equal(row().outputCount, null); noSideEffects();
});
await test('revoked collaborator cannot save counts even when its revocation did not advance the timestamp', async () => {
  readHook = () => { row().collaborators = []; };
  const result = await call(cid, 'PATCH', { requestCount: 8, outputCount: 16 }, 4);
  assert.equal(result.status, 409); assert.equal(result.data.error, 'case_conflict'); assert.equal(row().requestCount, null); assert.equal(row().outputCount, null);
  assert.deepEqual(row().collaborators, []); assert(trace.claims[0].where.OR.some(part => part.collaborators?.some?.id === 4)); noSideEffects();
});
await test('a Serializable commit failure returns actionable 409 and rolls back all quantity edits', async () => {
  const before = clone(row()); fail = 'commit'; const result = await call(cid, 'PATCH', { requestCount: 8, outputCount: 16, note: 'Rollback' });
  assert.equal(result.status, 409); assert.equal(result.data.error, 'case_conflict'); assert.match(result.data.message, /重新載入.*再試/); assert.deepEqual(row(), before); noSideEffects();
});
await test('a quantity save preserves contentVersion and existing stale JSON revision protection', async () => {
  const before = clone(row()); assert.equal((await call(cid, 'PATCH', { requestCount: 3, outputCount: 6 })).status, 200);
  assert.equal(row().contentVersion, before.contentVersion);
  const stale = await call(cid + '/items', 'PATCH', { items: [], expectedUpdatedAt: before.updatedAt.toISOString(), expectedContentVersion: before.contentVersion });
  assert.equal(stale.status, 409); assert.equal(stale.data.error, 'edit_conflict'); assert.deepEqual(row().items, before.items); assert.equal(row().contentVersion, before.contentVersion);
  assert.equal((await get()).data.requestCount, 3); assert.equal((await get()).data.outputCount, 6); noSideEffects();
});
await test('historical CSV quantities share the nonnegative integer bounds and retain zero', async () => {
  const common = { title: 'Historical imported quantity', designerName: 'Owner', status: 'closed', level: 'A', openDate: '2026-10-01' };
  const result = await call('bulk-import', 'POST', { rows: [{ ...common, requestCount: 0, outputCount: 1_000_000 }] }, 1);
  assert.equal(result.status, 200); assert.equal(result.data.summary.created, 1);
  const fresh = await get(result.data.created[0].id); assert.equal(fresh.data.requestCount, 0); assert.equal(fresh.data.outputCount, 1_000_000); assert.equal(fresh.data.archived, true);
});
await test('CSV cannot bypass validation with negative fractional oversized or string quantities', async () => {
  const common = { title: 'Rejected quantity', designerName: 'Owner', status: 'closed', level: 'A' };
  const rows = ['requestCount', 'outputCount'].flatMap(field => [-1, 0.1, 1_000_001, '2'].map(value => ({ ...common, [field]: value })));
  const result = await call('bulk-import', 'POST', { rows }, 1);
  assert.equal(result.status, 200); assert.deepEqual(result.data.summary, { total: 8, created: 0, failed: 8 }); assert.equal(trace.creates, 0);
  assert(result.data.errors.every(error => /requestCount|outputCount/.test(error.message))); assert.equal(state.cases.size, 1); noSideEffects();
});
await prisma.$disconnect();
console.log(JSON.stringify({ passed, liveDatabase: false, externalHTTP: false, emailsSent: 0, quantityMax: 1_000_000 }));
