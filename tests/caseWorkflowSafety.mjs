// Actual route integration against isolated, rollback-capable in-memory Prisma.
// No listener, real database, SMTP credentials, or external network is used.
import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex } from 'node:stream';
import { createRequire } from 'node:module';
const root = process.env.DESIGN_PM_ROOT || new URL('../', import.meta.url).pathname;
const require = createRequire(root + '/package.json');
const express = require('express'), cookieParser = require('cookie-parser');
process.env.JWT_SECRET = 'isolated-case-workflow-tests-secret-32bytes';
process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:1/never_connect';
for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) delete process.env[key];
const { prisma } = await import(root + '/src/lib/db.js');
const { signToken } = await import(root + '/src/middleware/auth.js');
const { nextCaseId } = await import(root + '/src/lib/ids.js');
const { taipeiCalendarDay } = await import(root + '/src/services/analytics.js');
const clone = value => structuredClone(value), cid = 'A-2026-10-001';
const basePeople = [
  { id: 1, name: 'Admin', role: 'admin' }, { id: 2, name: 'Owner', role: 'member' },
  { id: 3, name: 'Outsider', role: 'member' }, { id: 4, name: 'Collaborator', role: 'member' },
  { id: 5, name: 'Observer', role: 'observer' }, { id: 6, name: 'Inactive', role: 'member', active: false },
  { id: 7, name: 'Pending', role: 'member', pendingActivation: true },
].map(person => ({ active: true, pendingActivation: false, sessionVersion: 0, ...person }));
let state, people, transactionQueue, inTransaction, fail, caseReads, idReads, createAttempts, caseBarrier, idBarrier, collisions, notificationsInTransaction;
function reset() {
  people = new Map(basePeople.map(p => [p.id, clone(p)]));
  state = { cases: new Map([[cid, {
    id: cid, title: 'Fixture case', subTitle: '', requester: 'Requester', level: 'A', status: 'doing',
    designerId: 2, collaborators: [{ id: 4 }], archived: false, archivePath: '/fixture/archive',
    requestedOn: new Date('2026-10-01'), openDate: new Date('2026-10-01'), dispatchDate: new Date('2026-10-01'),
    goLiveDate: new Date('2026-10-30'), closedOn: null, cancelledOn: null, cancelReason: null, cancelStage: null,
    note: 'Original note', updatedAt: new Date('2026-10-01T00:00:00Z'), contentVersion: 0,
  }]]), audits: [], transfers: [], notifications: [] };
  transactionQueue = Promise.resolve(); inTransaction = 0; fail = ''; caseReads = 0; idReads = 0;
  createAttempts = 0; caseBarrier = null; idBarrier = null; collisions = 0; notificationsInTransaction = 0;
}
const row = () => state.cases.get(cid);
function matches(record, where) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) return true;
    if (key === 'AND') return expected.every(w => matches(record, w));
    if (key === 'OR') return expected.some(w => matches(record, w));
    if (expected instanceof Date) return new Date(record[key]).getTime() === expected.getTime();
    if (expected && typeof expected === 'object') {
      if (expected.startsWith !== undefined) return String(record[key]).startsWith(expected.startsWith);
      if (expected.in) return expected.in.includes(record[key]);
      throw Error('Unsupported fixture predicate ' + key);
    }
    return record[key] === expected;
  });
}
function hydrate(record) {
  if (!record) return null;
  return clone({ ...record, designer: people.get(record.designerId), collaborators: record.collaborators.map(c => people.get(c.id) || c) });
}
function apply(record, data) {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (key === 'collaborators') {
      if (value.set) record.collaborators = clone(value.set);
      if (value.disconnect) record.collaborators = record.collaborators.filter(c => !value.disconnect.some(d => d.id === c.id));
      if (value.connect) for (const c of value.connect) if (!record.collaborators.some(x => x.id === c.id)) record.collaborators.push(clone(c));
    } else if (key === 'designer') record.designerId = value.connect.id;
    else if (key === 'createdBy') record.createdById = value.connect.id;
    else record[key] = clone(value);
  }
  record.updatedAt = new Date(Math.max(Date.now(), new Date(record.updatedAt || 0).getTime() + 1));
  return record;
}
const unique = (target = ['id']) => Object.assign(Error('Fixture unique constraint'), { code: 'P2002', meta: { target } });
function client(database, transaction = false) {
  return {
    staff: {
      findUnique: async ({ where }) => clone(people.get(where.id) || null),
      findMany: async ({ where = {} } = {}) => clone([...people.values()].filter(p => matches(p, where))),
    },
    case: {
      findUnique: async ({ where }) => {
        const found = hydrate(database.cases.get(where.id));
        if (!transaction) { caseReads++; if (caseBarrier) await caseBarrier(); }
        return found;
      },
      findMany: async ({ where = {} } = {}) => {
        const found = [...database.cases.values()].filter(c => matches(c, where)).map(hydrate);
        if (where.id?.startsWith && !transaction) { idReads++; if (idBarrier) await idBarrier(); }
        return found;
      },
      updateMany: async ({ where, data }) => {
        if (fail === 'claim') throw Error('Fixture claim failure');
        let count = 0;
        for (const record of database.cases.values()) if (matches(record, where)) { apply(record, data); count++; }
        return { count };
      },
      update: async ({ where, data }) => {
        if (fail === 'case-update') throw Error('Fixture relation update failure');
        const record = database.cases.get(where.id);
        if (!record) throw Object.assign(Error('Missing fixture record'), { code: 'P2025' });
        return hydrate(apply(record, data));
      },
      create: async ({ data }) => {
        createAttempts++;
        if (fail === 'other-unique') throw unique(['otherField']);
        if (collisions === Infinity || collisions-- > 0) throw unique();
        if (fail === 'case-create') throw Error('Fixture create failure');
        if (database.cases.has(data.id)) throw unique();
        if (!people.has(data.designer?.connect?.id)) throw Object.assign(Error('Missing designer'), { code: 'P2025' });
        const record = apply({ status: 'todo', archived: false, collaborators: [], closedOn: null, cancelledOn: null, cancelReason: null, cancelStage: null, contentVersion: 0 }, data);
        database.cases.set(record.id, record);
        return hydrate(record);
      },
    },
    transferLog: { create: async ({ data }) => {
      assert(transaction, 'transfer audit must share the ownership transaction');
      if (fail === 'transfer-log') throw Error('Fixture transfer audit failure');
      database.transfers.push(clone(data)); return clone(data);
    } },
    changeLog: { createMany: async ({ data }) => {
      if (fail === 'audit') throw Error('Fixture change audit failure');
      database.audits.push(...clone(data)); return { count: data.length };
    } },
    notification: {
      findFirst: async () => null,
      create: async ({ data }) => {
        if (inTransaction) notificationsInTransaction++;
        assert.equal(inTransaction, 0, 'notifications must run after commit');
        state.notifications.push(clone(data)); return clone(data);
      },
    },
  };
}
for (const model of ['case', 'staff', 'transferLog', 'changeLog', 'notification']) {
  for (const op of ['findUnique', 'findFirst', 'findMany', 'create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany']) {
    prisma[model][op] = async (...args) => {
      const fn = client(state)[model]?.[op];
      if (!fn) throw Error('Unmocked ' + model + '.' + op);
      return fn(...args);
    };
  }
}
prisma.$connect = async () => { throw Error('Live database prohibited'); };
prisma.$disconnect = async () => {};
prisma.$transaction = async (fn, options) => {
  assert.equal(options?.isolationLevel, 'Serializable', 'case workflow and staff departure share serializable isolation');
  assert.equal(typeof fn, 'function', 'workflow uses interactive transactions');
  const previous = transactionQueue; let release;
  transactionQueue = new Promise(resolve => { release = resolve; });
  await previous;
  const isolated = clone(state); inTransaction++;
  try {
    const result = await fn(client(isolated, true));
    if (fail === 'concurrent-target-departure') {
      // Simulate PostgreSQL rejecting this write skew at commit after a
      // concurrent departure independently deactivated the validated target.
      people.get(4).active = false;
      throw Object.assign(Error('Fixture serializable assignment/departure conflict'), { code: 'P2034' });
    }
    state = isolated; return result;
  }
  finally { inTransaction--; release(); }
};
const app = express(); app.use(cookieParser()); app.use('/api/cases', (await import(root + '/src/routes/cases.js')).default);
app.use((e, _req, res, _next) => res.status(e.code === 'P2002' ? 409 : 500).json({ error: e.code || 'fixture_server_error' }));
function call(suffix = '', method = 'POST', body = {}, as = 2) {
  return new Promise((resolve, reject) => {
    const socket = new Duplex({ read() {}, write(_b, _e, done) { done(); } });
    const req = new http.IncomingMessage(socket); req.url = '/api/cases/' + suffix; req.method = method;
    req.headers = { cookie: 'designpm_token=' + signToken(people.get(as)), 'content-type': 'application/json' }; req.body = clone(body);
    const res = new http.ServerResponse(req);
    res.end = data => { resolve({ status: res.statusCode, data: JSON.parse(String(data)) }); socket.destroy(); return res; };
    app.handle(req, res, e => reject(e || Error('Route not handled')));
  });
}
function synchronizeFirst(n) {
  let count = 0, release; const waiting = new Promise(resolve => { release = resolve; });
  return async () => { if (++count <= n) { if (count === n) release(); await waiting; } };
}
const approve = decision => call(cid + '/approve', 'POST', { decision }, 1);
const transfer = (id = 4) => call(cid + '/transfer', 'POST', { toDesignerId: id, reason: 'Transfer fixture' }, 1);
const importRow = extra => ({ title: 'Imported fixture', level: 'A', designerName: 'Owner', openDate: '2026-10-22', ...extra });
const createBody = extra => ({ title: 'Created fixture', level: 'A', designerId: 2, openDate: '2026-10-22', dispatchDate: '2026-10-22', goLiveDate: '2026-11-10', ...extra });
const assertNoAudit = () => { assert.equal(state.audits.length, 0); assert.equal(state.transfers.length, 0); assert.equal(state.notifications.length, 0); };
let passed = 0;
async function test(name, fn) { reset(); await fn(); passed++; console.log('PASS ' + name); }
await test('requestedOn PATCH persists replacement, explicit null, and omitted values', async () => {
  assert.equal((await call(cid, 'PATCH', { requestedOn: '2026-10-15' }, 1)).status, 200);
  assert.equal(row().requestedOn.toISOString().slice(0, 10), '2026-10-15');
  await call(cid, 'PATCH', { title: 'Keep date' }); assert.equal(row().requestedOn.toISOString().slice(0, 10), '2026-10-15');
  assert.equal((await call(cid, 'PATCH', { requestedOn: null }, 1)).status, 200); assert.equal(row().requestedOn, null);
});
await test('generic cancellation is an actionable 422 with no partial mutation', async () => {
  const before = clone(row()); const result = await call(cid, 'PATCH', { status: 'cancelled', title: 'Must not save' });
  assert.equal(result.status, 422); assert.equal(result.data.error, 'cancel_action_required');
  assert(result.data.message.includes('/api/cases/' + cid + '/cancel')); assert.deepEqual(row(), before); assertNoAudit();
});
await test('collaborator assignment and cancellation restrictions still return 403', async () => {
  for (const patch of [{ designerId: 4 }, { collaboratorIds: [] }, { status: 'cancelled' }, { status: 'done' }, { status: 'closed' }]) {
    assert.equal((await call(cid, 'PATCH', patch, 4)).status, 403);
  }
  assert.equal((await call(cid + '/cancel', 'POST', { reason: '需求方取消' }, 4)).status, 403); assertNoAudit();
});
await test('dedicated cancellation validates its reason before writing', async () => {
  assert.equal((await call(cid + '/cancel', 'POST', {})).status, 400);
  assert.equal((await call(cid + '/cancel', 'POST', { reason: 'Unknown' })).status, 400);
  assert.equal(row().status, 'doing'); assertNoAudit();
});
await test('dedicated cancellation stores reason, stage, Taipei business day and archive atomically', async () => {
  row().closedOn = new Date('2026-01-02');
  const result = await call(cid + '/cancel', 'POST', { reason: '需求方取消', note: 'Cancelled fixture' });
  assert.equal(result.status, 200); assert.equal(row().status, 'cancelled'); assert.equal(row().archived, true);
  assert.equal(row().cancelReason, '需求方取消'); assert.equal(row().cancelStage, 'doing'); assert.equal(row().closedOn, null);
  assert.equal(row().cancelledOn.toISOString(), taipeiCalendarDay().toISOString()); assert.match(row().note, /Cancelled fixture/);
  assert.equal(state.audits.length, 1);
});
await test('uncancel restores active stage and clears all terminal metadata', async () => {
  Object.assign(row(), { status: 'cancelled', cancelStage: 'review', cancelledOn: new Date(), cancelReason: '需求方取消', archived: true, closedOn: new Date('2026-01-02') });
  assert.equal((await call(cid + '/uncancel')).status, 200);
  assert.equal(row().status, 'review'); assert.equal(row().archived, false);
  for (const key of ['closedOn', 'cancelledOn', 'cancelReason', 'cancelStage']) assert.equal(row()[key], null);
});
await test('legacy terminal cancelStage reopens safely instead of producing unarchived closed cases', async () => {
  Object.assign(row(), { status: 'cancelled', cancelStage: 'closed', archived: true });
  assert.equal((await call(cid + '/uncancel')).status, 200); assert.equal(row().status, 'doing'); assert.equal(row().closedOn, null); assert.equal(row().archived, false);
});
await test('generic reopening of cancelled cases points to the dedicated restore action', async () => {
  row().status = 'cancelled'; row().archived = true;
  const result = await call(cid, 'PATCH', { status: 'doing' }); assert.equal(result.status, 422); assert.equal(result.data.error, 'uncancel_action_required');
  assert.equal(row().status, 'cancelled'); assert.equal(row().archived, true); assertNoAudit();
});
await test('a delivered case must be reopened before cancellation', async () => {
  Object.assign(row(), { status: 'closed', archived: true, closedOn: new Date('2026-01-02') });
  assert.equal((await call(cid + '/cancel', 'POST', { reason: '需求方取消' })).status, 422); assert.equal(row().status, 'closed'); assertNoAudit();
});
await test('reopening a closed case clears closure date and archived flag', async () => {
  Object.assign(row(), { status: 'closed', archived: true, closedOn: new Date('2026-01-02') });
  assert.equal((await call(cid, 'PATCH', { status: 'doing' })).status, 200); assert.equal(row().closedOn, null); assert.equal(row().archived, false);
});
await test('nonterminal full-form saves preserve an intentionally archived active case', async () => {
  row().archived = true;
  assert.equal((await call(cid, 'PATCH', { status: 'doing', title: 'Saved full form' })).status, 200);
  assert.equal(row().archived, true); assert.equal(row().title, 'Saved full form');
  assert.equal((await call(cid, 'PATCH', { status: 'review' })).status, 200); assert.equal(row().archived, true);
});
await test('submitting review clears obsolete closure dates without recording an actual closure', async () => {
  row().closedOn = new Date('2026-01-02');
  assert.equal((await call(cid, 'PATCH', { status: 'review_done' })).status, 200); assert.equal(row().closedOn, null); assert.equal(row().archived, false);
});
await test('rejection clears archived flag and rejected submission completion date', async () => {
  Object.assign(row(), { status: 'review_done', archived: true, closedOn: new Date('2026-01-02') });
  assert.equal((await approve('reject')).status, 200); assert.equal(row().status, 'doing'); assert.equal(row().archived, false); assert.equal(row().closedOn, null);
});
await test('reject resubmit approve stamps actual approval day rather than the rejected candidate', async () => {
  Object.assign(row(), { status: 'review_done', closedOn: new Date('2026-01-02') });
  assert.equal((await approve('reject')).status, 200);
  assert.equal((await call(cid, 'PATCH', { status: 'review_done' })).status, 200); assert.equal(row().closedOn, null);
  assert.equal((await approve('approve')).status, 200); assert.equal(row().status, 'closed'); assert.equal(row().archived, true);
  assert.equal(row().closedOn.toISOString(), taipeiCalendarDay().toISOString()); assert.equal(notificationsInTransaction, 0);
});
await test('approval without archive location rejects without mutation or notification', async () => {
  row().status = 'review_done'; row().archivePath = '  ';
  assert.equal((await approve('approve')).status, 422); assert.equal(row().status, 'review_done'); assertNoAudit();
});
for (const decisions of [['approve', 'reject'], ['reject', 'approve'], ['approve', 'approve']]) {
  await test('concurrent review decisions have exactly one winner: ' + decisions.join('/'), async () => {
    row().status = 'review_done'; caseBarrier = synchronizeFirst(2);
    const results = await Promise.all(decisions.map(approve)); assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal(state.audits.length, 1); assert.equal(state.notifications.length, 1); assert.equal(notificationsInTransaction, 0);
    if (row().status === 'closed') { assert.equal(row().archived, true); assert.equal(row().closedOn.toISOString(), taipeiCalendarDay().toISOString()); }
    else { assert.equal(row().status, 'doing'); assert.equal(row().archived, false); assert.equal(row().closedOn, null); }
  });
}
await test('approval audit failure rolls back the decision and sends no notification', async () => {
  row().status = 'review_done'; const before = clone(row()); fail = 'audit';
  assert.equal((await approve('approve')).status, 500); assert.deepEqual(row(), before); assertNoAudit();
});
await test('generic status audit failure rolls back all requested changes', async () => {
  const before = clone(row()); fail = 'audit';
  assert.equal((await call(cid, 'PATCH', { status: 'review_done', title: 'Must rollback' })).status, 500); assert.deepEqual(row(), before); assertNoAudit();
});
await test('cancellation audit failure leaves the original active case intact', async () => {
  const before = clone(row()); fail = 'audit';
  assert.equal((await call(cid + '/cancel', 'POST', { reason: '需求方取消' })).status, 500); assert.deepEqual(row(), before); assertNoAudit();
});
await test('concurrent cancellation and approval cannot both succeed', async () => {
  row().status = 'review_done'; caseBarrier = synchronizeFirst(2);
  const results = await Promise.all([call(cid + '/cancel', 'POST', { reason: '需求方取消' }), approve('approve')]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); assert.equal(state.audits.length, 1); assert.equal(row().archived, true);
  if (row().status === 'cancelled') { assert.equal(row().closedOn, null); assert.equal(state.notifications.length, 0); }
  else { assert.equal(row().status, 'closed'); assert.equal(row().cancelledOn, null); assert.equal(state.notifications.length, 1); }
});
for (const endpoint of ['patch', 'transfer']) {
  await test(endpoint + ' rejects missing inactive pending and observer assignment targets without ghost audit', async () => {
    for (const id of [999, 6, 7, 5]) {
      const result = endpoint === 'patch' ? await call(cid, 'PATCH', { designerId: id }, 1) : await transfer(id);
      assert.equal(result.status, 422); assert.equal(result.data.error, 'designer_unavailable');
      assert.equal(row().designerId, 2); assertNoAudit();
    }
  });
}
for (const endpoint of ['patch', 'transfer']) {
  await test(endpoint + ' rolls back a serializable assignment/departure conflict and rejects the now-inactive target', async () => {
    const before = clone(row()); fail = 'concurrent-target-departure';
    const result = endpoint === 'patch' ? await call(cid, 'PATCH', { designerId: 4 }, 1) : await transfer(4);
    assert.equal(result.status, 409); assert.equal(result.data.error, 'case_conflict'); assert.match(result.data.message, /重新載入.*再試/);
    assert.equal(people.get(4).active, false); assert.deepEqual(row(), before); assertNoAudit();
    fail = '';
    const retry = endpoint === 'patch' ? await call(cid, 'PATCH', { designerId: 4 }, 1) : await transfer(4);
    assert.equal(retry.status, 422); assert.equal(retry.data.error, 'designer_unavailable'); assert.deepEqual(row(), before); assertNoAudit();
  });
}
await test('generic reassignment atomically removes the new primary from collaborators', async () => {
  const result = await call(cid, 'PATCH', { designerId: 4, reason: 'Owner transfer' });
  assert.equal(result.status, 200); assert.equal(row().designerId, 4); assert.deepEqual(row().collaborators, []);
  assert.equal(state.transfers.length, 1); assert.equal(state.transfers[0].fromName, 'Owner'); assert.equal(state.transfers[0].toName, 'Collaborator');
  assert.equal(state.transfers[0].reason, 'Owner transfer'); assert.equal(state.audits.length, 1);
});
await test('explicit transfer writes ownership and both audits before notifying the target', async () => {
  assert.equal((await transfer()).status, 200); assert.equal(row().designerId, 4); assert.deepEqual(row().collaborators, []);
  assert.equal(state.transfers.length, 1); assert.equal(state.audits.length, 1); assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].recipientId, 4); assert.equal(notificationsInTransaction, 0);
});
await test('generic combined assignment filters duplicate collaborators and logs every tracked change', async () => {
  assert.equal((await call(cid, 'PATCH', { designerId: 4, collaboratorIds: [4, 3, 3], status: 'review', reason: 'Combined fixture' }, 1)).status, 200);
  assert.equal(row().designerId, 4); assert.deepEqual(row().collaborators, [{ id: 3 }]); assert.equal(row().status, 'review');
  assert.equal(state.transfers.length, 1); assert.deepEqual(state.audits.map(a => a.field).sort(), ['designerId', 'status']);
});
await test('generic reassignment transfer-log failure rolls back ownership and other fields', async () => {
  const before = clone(row()); fail = 'transfer-log';
  assert.equal((await call(cid, 'PATCH', { designerId: 4, title: 'Must rollback' }, 1)).status, 500); assert.deepEqual(row(), before); assertNoAudit();
});
await test('transfer change-audit failure rolls back owner collaborators and transfer record', async () => {
  const before = clone(row()); fail = 'audit'; assert.equal((await transfer()).status, 500); assert.deepEqual(row(), before); assertNoAudit();
});
await test('reassignment relation failure cannot commit its earlier scalar ownership claim', async () => {
  const before = clone(row()); fail = 'case-update'; assert.equal((await transfer()).status, 500); assert.deepEqual(row(), before); assertNoAudit();
});
await test('concurrent transfers have one winner and a single truthful transfer record', async () => {
  caseBarrier = synchronizeFirst(2); const results = await Promise.all([transfer(4), transfer(3)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); assert.equal(state.transfers.length, 1); assert.equal(state.audits.length, 1);
  assert.equal(state.transfers[0].toName, people.get(row().designerId).name); assert.equal(state.notifications.length, 1);
});
await test('unchanged ownership full form and ordinary collaborator edits remain supported', async () => {
  assert.equal((await call(cid, 'PATCH', { designerId: 2, collaboratorIds: [4], title: 'Joint edit' }, 4)).status, 200);
  assert.equal(row().title, 'Joint edit'); assert.equal(row().designerId, 2); assert.deepEqual(row().collaborators, [{ id: 4 }]);
  assert.equal((await call(cid, 'PATCH', { status: 'review_done' }, 4)).status, 200); assert.equal(row().status, 'review_done');
});
await test('unrelated members observers and non-admin approval or transfer cannot mutate the case', async () => {
  for (const as of [3, 5]) assert.equal((await call(cid, 'PATCH', { title: 'Forbidden' }, as)).status, 403);
  assert.equal((await call(cid + '/approve', 'POST', { decision: 'approve' })).status, 403);
  assert.equal((await call(cid + '/transfer', 'POST', { toDesignerId: 3 })).status, 403); assertNoAudit();
});
await test('numeric ID allocation advances past four digit suffixes and ignores malformed suffixes', async () => {
  for (const id of ['A-2026-10-999', 'A-2026-10-1000', 'A-2026-10-garbage', 'A-2026-10-1000junk']) state.cases.set(id, { ...clone(row()), id });
  assert.equal(await nextCaseId('A', new Date('2026-10-22')), 'A-2026-10-1001');
  assert.equal(await nextCaseId('B', new Date('2026-10-22')), 'B-2026-10-001');
  const id = 'A-2026-10-10000'; state.cases.set(id, { ...clone(row()), id });
  assert.equal(await nextCaseId('A', new Date('2026-10-22')), 'A-2026-10-10001');
});
await test('ordinary create retries ID collisions while preserving all validated case data', async () => {
  collisions = 1; const result = await call('', 'POST', createBody({ requestedOn: '2026-10-15', collaboratorIds: [2, 4], note: 'Preserved note' }));
  assert.equal(result.status, 201); assert.equal(createAttempts, 2); assert.equal(result.data.note, 'Preserved note');
  assert.equal(result.data.requestedOn.slice(0, 10), '2026-10-15'); assert.deepEqual(result.data.collaborators.map(c => c.id), [4]);
});
await test('concurrent clone requests both create unique clean reopened cases', async () => {
  Object.assign(row(), { status: 'closed', archived: true, closedOn: new Date('2026-01-02'), cancelReason: 'Old cancellation' });
  idBarrier = synchronizeFirst(2); const results = await Promise.all([call(cid + '/clone'), call(cid + '/clone')]);
  assert.deepEqual(results.map(r => r.status), [201, 201]); assert.equal(new Set(results.map(r => r.data.id)).size, 2);
  assert.equal(createAttempts, 3);
  for (const { data } of results) { assert.equal(data.status, 'todo'); assert.equal(data.archived, false); assert.equal(data.closedOn, null); assert.equal(data.cancelReason, null); assert.equal(data.openDate, taipeiCalendarDay().toISOString()); }
});
await test('concurrent imports retry collisions and rebuild their ID-derived archive paths', async () => {
  idBarrier = synchronizeFirst(2);
  const results = await Promise.all([1, 2].map(() => call('bulk-import', 'POST', { rows: [importRow({ status: 'closed' })] }, 1)));
  assert.deepEqual(results.map(r => r.data.summary.created), [1, 1]); assert.equal(new Set(results.map(r => r.data.created[0].id)).size, 2);
  assert.equal(createAttempts, 3);
  for (const result of results) { const id = result.data.created[0].id, imported = state.cases.get(id); assert(imported.archivePath.includes(id)); assert.equal(imported.status, 'closed'); assert.equal(imported.archived, true); }
});
await test('clone collision exhaustion is bounded and cannot create a phantom case', async () => {
  collisions = Infinity; const result = await call(cid + '/clone'); assert.equal(result.status, 409); assert.equal(createAttempts, 5); assert.equal(state.cases.size, 1); assertNoAudit();
});
await test('import collision exhaustion reports a failed row after five attempts', async () => {
  collisions = Infinity; const result = await call('bulk-import', 'POST', { rows: [importRow({})] }, 1);
  assert.equal(result.status, 200); assert.deepEqual(result.data.summary, { total: 1, created: 0, failed: 1 }); assert.equal(createAttempts, 5); assert.equal(state.cases.size, 1);
});
await test('non-ID unique errors are not masked by retry', async () => {
  fail = 'other-unique'; assert.equal((await call(cid + '/clone')).status, 409); assert.equal(createAttempts, 1); assert.equal(state.cases.size, 1);
});
await test('invalid create clone and import fields still reject before allocating IDs', async () => {
  assert.equal((await call('', 'POST', createBody({ level: 'INVALID' }))).status, 400);
  assert.equal((await call(cid + '/clone', 'POST', { goLiveDate: 'invalid' })).status, 400);
  const result = await call('bulk-import', 'POST', { rows: [importRow({ status: 'invalid' })] }, 1);
  assert.equal(result.data.summary.failed, 1);
  const invalidCancellationDate = await call('bulk-import', 'POST', { rows: [importRow({ status: 'cancelled', cancelReason: '需求方取消', cancelledOn: '2026-02-31' })] }, 1);
  assert.equal(invalidCancellationDate.data.summary.failed, 1);
  assert.equal(idReads, 0); assert.equal(createAttempts, 0);
});
await test('unknown import collaborators are reported instead of silently dropping participation', async () => {
  const result = await call('bulk-import', 'POST', { rows: [importRow({ collaboratorNames: ['Missing Person'] })] }, 1);
  assert.equal(result.data.summary.failed, 1); assert.match(result.data.errors[0].message, /Missing Person/); assert.equal(createAttempts, 0);
});
await test('cancelled imports require a reason and preserve cancellation invariants', async () => {
  const result = await call('bulk-import', 'POST', { rows: [importRow({ status: 'cancelled' }), importRow({ status: 'cancelled', cancelReason: '需求方取消', cancelStage: 'review', cancelledOn: '2026-10-15', closedOn: '2026-01-02' })] }, 1);
  assert.deepEqual(result.data.summary, { total: 2, created: 1, failed: 1 }); assert.match(result.data.errors[0].message, /cancelReason/);
  const imported = state.cases.get(result.data.created[0].id); assert.equal(imported.archived, true); assert.equal(imported.closedOn, null); assert.equal(imported.cancelReason, '需求方取消');
  assert.equal(imported.cancelStage, 'review'); assert.equal(imported.cancelledOn.toISOString().slice(0, 10), '2026-10-15');
});
await test('review imports have no closure date while historical closed records retain their explicit end date', async () => {
  const result = await call('bulk-import', 'POST', { rows: [importRow({ status: 'review_done', closedOn: '2026-01-02' }), importRow({ status: 'closed', closedOn: '2026-10-15' })] }, 1);
  assert.equal(result.data.summary.created, 2); const imported = result.data.created.map(c => state.cases.get(c.id));
  assert.equal(imported[0].closedOn, null); assert.equal(imported[0].archived, false); assert.equal(imported[1].closedOn.toISOString().slice(0, 10), '2026-10-15');
});
await prisma.$disconnect();
console.log(JSON.stringify({ passed, liveDatabase: false, emailsSent: 0, notificationsInTransaction }));
