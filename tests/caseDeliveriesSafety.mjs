// REPORTS-P1-A: actual Express case/delivery routes against an isolated, rollback-capable
// Prisma double. No listener, real database, external HTTP, SMTP or production data is used.
// Real PostgreSQL constraints, triggers and concurrency are covered by tests/postgresMaintenance.mjs.
import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex } from 'node:stream';
import { createRequire } from 'node:module';
const root = process.env.DESIGN_PM_ROOT || new URL('../', import.meta.url).pathname;
const require = createRequire(root + '/package.json');
const express = require('express'), cookieParser = require('cookie-parser');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'isolated-delivery-record-tests-signing-secret';
process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:1/never_connect';
for (const key of Object.keys(process.env)) if (key.startsWith('SMTP_')) delete process.env[key];
const { prisma } = await import(root + '/src/lib/db.js');
const { signToken } = await import(root + '/src/middleware/auth.js');
const { taipeiCalendarDay } = await import(root + '/src/services/analytics.js');
const clone = value => structuredClone(value), cid = 'A-2026-10-101', other = 'B-2026-10-202';
const KEY_A = 'item-key-main-0001', KEY_B = 'item-key-ext-00002';
const today = taipeiCalendarDay().toISOString().slice(0, 10);
const people = new Map([
  { id: 1, name: 'Admin', role: 'admin' }, { id: 2, name: 'Owner', role: 'member' }, { id: 3, name: 'Unrelated', role: 'member' },
  { id: 4, name: 'Collaborator', role: 'member' }, { id: 5, name: 'Observer', role: 'observer' },
].map(p => [p.id, { active: true, pendingActivation: false, sessionVersion: 0, ...p }]));
let state, queue, fault, beforeTx, trace;
function freshCase(id, extra = {}) {
  return { id, title: 'Delivery fixture', requester: 'Fixture', level: 'A', designerId: 2, collaborators: [{ id: 4 }], createdById: 1,
    status: 'doing', archived: false, archivePath: null, closedOn: null, cancelledOn: null, requestCount: null, outputCount: null,
    openDate: new Date('2026-10-01'), dispatchDate: new Date('2026-10-02'), goLiveDate: new Date('2026-10-30'), note: '',
    items: [{ key: KEY_A, n: '主視覺 KV', type: '1 平面', status: 'doing' }, { key: KEY_B, n: 'FB 延伸', type: '2 數位', status: 'doing' }],
    logs: [], contentVersion: 3, updatedAt: new Date('2026-10-20T01:00:00.000Z'), ...extra };
}
function reset() {
  state = { staff: new Map(clone([...people])), cases: new Map([[cid, freshCase(cid)], [other, freshCase(other, { designerId: 3, collaborators: [] })]]),
    deliveries: new Map(), audits: [], notifications: [] };
  queue = Promise.resolve(); fault = ''; beforeTx = null; trace = { transactions: 0, rawStatements: 0 };
}
function matches(record, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (key === 'OR') return value.some(part => matches(record, part));
    if (key === 'collaborators' && value?.some) return record.collaborators.some(p => matches(p, value.some));
    if (value instanceof Date) return record[key] instanceof Date && record[key].getTime() === value.getTime();
    if (value && typeof value === 'object') {
      if ('startsWith' in value) return String(record[key]).startsWith(value.startsWith);
      if ('not' in value) return value.not === null ? record[key] != null : record[key] !== value.not;
      throw Error('Unsupported fixture predicate ' + key);
    }
    return record[key] === value;
  });
}
const hydrateCase = row => row && clone({ ...row, designer: { id: row.designerId, name: people.get(row.designerId)?.name }, collaborators: row.collaborators.map(p => ({ id: p.id, name: people.get(p.id)?.name })) });
const p2002 = () => Object.assign(Error('Unique constraint failed'), { code: 'P2002' });
function client(db, inTx = false) {
  return {
    staff: {
      findUnique: async ({ where }) => clone(db.staff.get(where.id) ?? null),
      findMany: async () => clone([...db.staff.values()]),
    },
    case: {
      findUnique: async ({ where }) => hydrateCase(db.cases.get(where.id) ?? null),
      findMany: async ({ where } = {}) => [...db.cases.values()].filter(r => matches(r, where)).map(hydrateCase),
      updateMany: async ({ where, data }) => {
        if (fault === 'advance-throw' && inTx) throw Error('Synthetic transaction failure');
        if (fault === 'advance-lost' && inTx) return { count: 0 };
        const rows = [...db.cases.values()].filter(r => matches(r, where));
        for (const row of rows) for (const [k, v] of Object.entries(data)) row[k] = v && typeof v === 'object' && 'increment' in v ? row[k] + v.increment : clone(v);
        return { count: rows.length };
      },
      create: async ({ data }) => {
        if (db.cases.has(data.id)) throw p2002();
        const row = { ...freshCase(data.id), items: null, ...clone(data), designerId: data.designer?.connect?.id ?? data.designerId, collaborators: data.collaborators?.connect ?? [] };
        delete row.designer; delete row.createdBy; db.cases.set(row.id, row); return hydrateCase(row);
      },
      delete: async ({ where }) => {
        // Real PostgreSQL RESTRICT (23001) reaches Prisma 6 as an unknown request error without a P2003 code.
        if ([...db.deliveries.values()].some(d => d.caseId === where.id)) throw Object.assign(Error('update or delete on table "cases" violates RESTRICT setting of foreign key constraint "case_deliveries_caseId_fkey" on table "case_deliveries"'), { name: 'PrismaClientUnknownRequestError' });
        const row = db.cases.get(where.id); db.cases.delete(where.id); return clone(row);
      },
    },
    deliveryRecord: {
      findUnique: async ({ where }) => clone((where.id ? db.deliveries.get(where.id) : [...db.deliveries.values()].find(d => d.voidRequestId === where.voidRequestId)) ?? null),
      findMany: async ({ where, select } = {}) => [...db.deliveries.values()].filter(d => matches(d, where)).map(d => clone(select ? Object.fromEntries(Object.keys(select).map(k => [k, d[k]])) : d)),
      count: async ({ where }) => [...db.deliveries.values()].filter(d => matches(d, where)).length,
      create: async ({ data }) => {
        if (fault === 'race-p2002' && inTx) {
          // Another identical request commits first; this transaction then hits the unique id.
          state.deliveries.set(data.id, { ...clone(data), createdAt: new Date(), voidedAt: null, voidedById: null, voidedByName: null, voidReason: null, voidRequestId: null });
          throw p2002();
        }
        if (db.deliveries.has(data.id)) throw p2002();
        const row = { ...clone(data), createdAt: new Date(), voidedAt: null, voidedById: null, voidedByName: null, voidReason: null, voidRequestId: null };
        db.deliveries.set(row.id, row); return clone(row);
      },
      updateMany: async ({ where, data }) => {
        if (data.voidRequestId && [...db.deliveries.values()].some(d => d.voidRequestId === data.voidRequestId)) throw p2002();
        const rows = [...db.deliveries.values()].filter(d => matches(d, where));
        for (const row of rows) Object.assign(row, clone(data));
        return { count: rows.length };
      },
    },
    changeLog: { createMany: async ({ data }) => { db.audits.push(...clone(data)); return { count: data.length }; } },
    deliverySubmission: { count: async () => 0 }, // REPORTS-P1-C1 submissions are exercised in caseDeliveryWorkflowSafety
    scheduleRequest: { count: async () => 0 }, // REPORTS-P2-D1a schedule requests are exercised in caseScheduleWorkflowSafety
    caseCycle: { count: async () => 0 }, lifecycleRequest: { count: async () => 0 }, // REPORTS-P2-D1b: see caseLifecycleWorkflowSafety
    notification: {
      updateMany: async () => ({ count: 0 }), findFirst: async () => null,
      create: async ({ data }) => { db.notifications.push(clone(data)); return clone(data); },
    },
  };
}
reset();
for (const model of ['case', 'staff', 'changeLog', 'notification', 'deliveryRecord', 'deliverySubmission', 'scheduleRequest', 'caseCycle', 'lifecycleRequest', 'transferLog']) {
  for (const method of ['findUnique', 'findFirst', 'findMany', 'count', 'update', 'updateMany', 'create', 'createMany', 'delete', 'deleteMany']) {
    prisma[model][method] = async (...args) => {
      const fn = client(state)[model]?.[method];
      if (!fn) throw Error('Blocked unexpected Prisma method ' + model + '.' + method);
      return fn(...args);
    };
  }
}
for (const method of ['$connect', '$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe']) prisma[method] = async () => { trace.rawStatements++; throw Error('Live database prohibited'); };
prisma.$disconnect = async () => {};
prisma.$transaction = (run, options) => {
  if (Array.isArray(run)) return Promise.all(run); // delete route: operations already issued
  assert.equal(options?.isolationLevel, 'Serializable', 'delivery mutations must be Serializable');
  const result = queue.then(async () => {
    trace.transactions++;
    if (beforeTx) { const hook = beforeTx; beforeTx = null; hook(state); }
    const isolated = clone(state);
    const value = await run(client(isolated, true));
    if (fault === 'commit') throw Object.assign(Error('Synthetic serialization failure'), { code: 'P2034' });
    state = isolated; return value;
  });
  queue = result.catch(() => {}); return result;
};
const app = express(); app.use(cookieParser()); app.use('/api/cases', (await import(root + '/src/routes/cases.js')).default);
app.use((_error, _req, res, _next) => res.status(500).json({ error: 'server_error' }));
function call(path, method = 'GET', body, as = 2) {
  return new Promise((resolve, reject) => {
    const socket = new Duplex({ read() {}, write(_b, _e, done) { done(); } });
    const req = new http.IncomingMessage(socket); req.url = '/api/cases/' + path; req.method = method;
    req.headers = { cookie: 'designpm_token=' + signToken(people.get(as)), 'content-type': 'application/json' }; req.body = body === undefined ? {} : clone(body);
    const res = new http.ServerResponse(req);
    res.end = data => { resolve({ status: res.statusCode, data: JSON.parse(String(data)) }); socket.destroy(); return res; };
    app.handle(req, res, error => reject(error || Error('Route not handled')));
  });
}
const version = (id = cid) => ({ expectedUpdatedAt: state.cases.get(id).updatedAt.toISOString(), expectedContentVersion: state.cases.get(id).contentVersion });
let seq = 0; const rid = (tag = 'req') => `${tag}-${String(++seq).padStart(6, '0')}`;
const delivery = (extra = {}, id = cid) => ({ id: rid(), itemName: '主視覺 KV', kind: 'main', quantity: 1, unit: '件', deliveredOn: '2026-10-21', ...version(id), ...extra });
const post = (body, as = 2, id = cid) => call(id + '/deliveries', 'POST', body, as);
const list = (id = cid, as = 2) => call(id + '/deliveries', 'GET', undefined, as);
const voidRec = (recordId, body, as = 2, id = cid) => call(`${id}/deliveries/${recordId}/void`, 'POST', body, as);
const voidBody = (extra = {}, id = cid) => ({ requestId: rid('void'), reason: '數量登錄錯誤', ...version(id), ...extra });
const persisted = () => [...state.deliveries.values()];

let passed = 0;
async function test(name, fn) { reset(); process.env.DELIVERY_RECORDS_ENABLED = '1'; await fn(); passed++; console.log('PASS ' + name); }

await test('routes are disabled by default and touch nothing until DELIVERY_RECORDS_ENABLED=1', async () => {
  delete process.env.DELIVERY_RECORDS_ENABLED;
  for (const [path, method, body] of [[cid + '/deliveries', 'GET'], [cid + '/deliveries', 'POST', delivery()], [cid + '/deliveries/whatever-1/void', 'POST', voidBody()]]) {
    const res = await call(path, method, body); assert.equal(res.status, 404); assert.equal(res.data.error, 'feature_disabled');
  }
  for (const value of ['0', 'true', 'yes', '']) { process.env.DELIVERY_RECORDS_ENABLED = value; assert.equal((await list()).status, 404); }
  assert.equal(persisted().length, 0); assert.equal(trace.transactions, 0);
  process.env.DELIVERY_RECORDS_ENABLED = '1'; assert.equal((await list()).status, 200);
});
await test('GET reports unknown (not zero) with legacy totals untouched and performs no writes', async () => {
  state.cases.get(cid).outputCount = 7; const before = clone([...state.cases.values()]);
  const res = await list(cid, 5);
  assert.equal(res.status, 200); assert.equal(res.data.summary.status, 'unknown'); assert.deepEqual(res.data.summary.groups, []);
  assert.deepEqual(res.data.legacy, { requestCount: null, outputCount: 7, requestCountStatus: 'unknown', outputCountStatus: 'legacy_total' });
  assert.equal(res.data.contentVersion, 3); assert.equal(res.data.updatedAt, '2026-10-20T01:00:00.000Z');
  assert.deepEqual(clone([...state.cases.values()]), before); assert.equal(trace.transactions, 0);
  assert.equal((await list('NOPE-1')).status, 404);
});
await test('main 1 and extension 3 are recorded, grouped separately and advance the case version atomically', async () => {
  const a = await post(delivery({ itemKey: KEY_A, itemName: undefined, kind: 'main', quantity: 1 }));
  assert.equal(a.status, 201); assert.equal(a.data.record.itemName, '主視覺 KV'); assert.equal(a.data.record.recordedById, 2); assert.equal(a.data.record.recordedByName, 'Owner');
  assert.equal(a.data.case.contentVersion, 4); assert.equal(state.cases.get(cid).contentVersion, 4);
  const b = await post(delivery({ itemKey: KEY_B, itemName: undefined, kind: 'extension', quantity: 3, deliveredOn: '2026-10-22' }), 4);
  assert.equal(b.status, 201); assert.equal(b.data.case.contentVersion, 5);
  const res = await list();
  assert.deepEqual(res.data.summary.groups, [{ kind: 'main', unit: '件', quantity: 1, records: 1 }, { kind: 'extension', unit: '件', quantity: 3, records: 1 }]);
  assert.equal(res.data.summary.status, 'recorded'); assert.equal(res.data.summary.firstDeliveredOn, '2026-10-21'); assert.equal(res.data.summary.lastDeliveredOn, '2026-10-22');
  assert.equal(state.cases.get(cid).outputCount, null, 'legacy outputCount is never derived or overwritten');
  assert.equal(state.notifications.length, 0);
});
await test('zero output only for support with a meaningful note', async () => {
  const ok = await post(delivery({ kind: 'support', quantity: 0, itemName: '跨部門協調', note: '協調印刷廠與館方確認尺寸' }));
  assert.equal(ok.status, 201); assert.equal(ok.data.record.quantity, 0);
  for (const note of [undefined, null, '', '   ', '無', 'n/a', '----', '1234', '同上', '待補']) {
    const res = await post(delivery({ kind: 'support', quantity: 0, itemName: '支援', note }));
    assert.equal(res.status, 422, 'note ' + JSON.stringify(note)); assert.equal(res.data.error, 'zero_output_note_required');
  }
  for (const kind of ['main', 'extension']) {
    const res = await post(delivery({ kind, quantity: 0, note: '有說明也不能是 0 件主設計' }));
    assert.equal(res.status, 422); assert.equal(res.data.error, 'zero_output_kind');
  }
  assert.equal(persisted().length, 1);
  assert.equal((await list()).data.summary.zeroSupportRecords, 1);
});
await test('invalid quantities, kinds, units, dates and client-asserted identity are rejected without writes', async () => {
  const bad = [
    { quantity: -1 }, { quantity: 1.5 }, { quantity: '3' }, { quantity: 1000001 }, { quantity: null }, { quantity: 1e309 },
    { kind: 'revision' }, { kind: 'print' }, { unit: '份' }, { unit: '' },
    { deliveredOn: '2026-02-30' }, { deliveredOn: '2025-02-29' }, { deliveredOn: '2026-13-01' }, { deliveredOn: '20261021' }, { deliveredOn: '2026-10-21T00:00:00Z' },
    { id: 'short' }, { id: 'has space in id' }, { itemKey: 'bad key!' }, { recordedById: 1 }, { recordedByName: 'Admin' },
    { expectedUpdatedAt: undefined }, { expectedContentVersion: undefined }, { expectedContentVersion: -1 }, { itemName: '   ' },
  ];
  for (const extra of bad) {
    const res = await post(delivery(extra));
    assert.equal(res.status, 400, JSON.stringify(extra)); assert.equal(res.data.error, 'invalid_body'); assert(Array.isArray(res.data.issues));
  }
  for (const [extra, code] of [[{ deliveredOn: '2099-01-01' }, 'delivered_on_future'], [{ deliveredOn: '1999-12-31' }, 'delivered_on_out_of_range'], [{ itemName: undefined }, 'item_name_required'], [{ itemKey: 'item-key-missing-9' }, 'item_key_unknown']]) {
    const res = await post(delivery(extra)); assert.equal(res.status, 422, code); assert.equal(res.data.error, code);
  }
  assert.equal(persisted().length, 0); assert.equal(state.cases.get(cid).contentVersion, 3);
  assert.equal((await post(delivery({ deliveredOn: '2024-02-29' }))).status, 201, 'a real leap day is valid');
  assert.equal((await post(delivery({ deliveredOn: today }))).status, 201, 'today (Taipei) is valid');
});
await test('assignment: owner, collaborator and admin may record; observer and unrelated may not', async () => {
  for (const as of [2, 4, 1]) assert.equal((await post(delivery(), as)).status, 201);
  const observer = await post(delivery(), 5); assert.equal(observer.status, 403); assert.equal(observer.data.error, 'read_only');
  const unrelated = await post(delivery(), 3); assert.equal(unrelated.status, 403); assert.equal(unrelated.data.error, 'forbidden');
  assert.equal(persisted().length, 3); assert.deepEqual(persisted().map(r => r.recordedById), [2, 4, 1]);
  assert.equal((await list(cid, 5)).status, 200, 'observers keep read access');
});
await test('permission revoked or account deactivated just before the transaction commits nothing', async () => {
  beforeTx = db => { db.cases.get(cid).collaborators = []; };
  const revoked = await post(delivery(), 4); assert.equal(revoked.status, 403); assert.equal(revoked.data.error, 'forbidden');
  beforeTx = db => { db.staff.get(2).active = false; };
  const inactive = await post(delivery(), 2); assert.equal(inactive.status, 403); assert.equal(inactive.data.error, 'actor_inactive');
  assert.equal(persisted().length, 0); assert.equal(state.cases.get(cid).contentVersion, 3);
});
await test('same id and content replays even with a stale version; different payload, actor or case conflicts', async () => {
  const body = delivery({ itemKey: KEY_A, itemName: undefined, note: '第一版交付' });
  const first = await post(body); assert.equal(first.status, 201);
  await post(delivery()); // advances the version past the retried request
  const replay = await post(body);
  assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true); assert.deepEqual(replay.data.record, first.data.record);
  assert.equal(replay.data.case.contentVersion, 5, 'replay returns the current case version and writes nothing');
  for (const [changed, as, id] of [[{ quantity: 2 }, 2, cid], [{ note: '不同說明' }, 2, cid], [{ deliveredOn: '2026-10-20' }, 2, cid], [{ itemName: '改了品名' }, 2, cid], [{}, 4, cid], [{}, 1, cid]]) {
    const res = await post({ ...body, ...changed, ...version(id) }, as, id);
    assert.equal(res.status, 409, JSON.stringify(changed) + ' as ' + as); assert.equal(res.data.error, 'delivery_request_conflict');
  }
  const otherCase = await post({ ...body, ...version(other) }, 3, other);
  assert.equal(otherCase.status, 409); assert.equal(otherCase.data.error, 'delivery_request_conflict');
  assert.equal(persisted().length, 2); assert.equal(state.cases.get(cid).contentVersion, 5);
});
await test('concurrent identical requests store one record; concurrent different payloads with one id conflict', async () => {
  const body = delivery();
  const [a, b] = await Promise.all([post(body), post(body)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]); assert.equal(persisted().length, 1);
  const body2 = delivery();
  const [c, d] = await Promise.all([post(body2), post({ ...body2, quantity: 9 })]);
  assert.deepEqual([c.status, d.status].sort(), [201, 409]); assert.equal(persisted().length, 2);
});
await test('a unique-key race resolves to replay for the same request and never duplicates', async () => {
  fault = 'race-p2002'; const body = delivery();
  const res = await post(body); assert.equal(res.status, 200); assert.equal(res.data.replayed, true);
  assert.equal(persisted().length, 1);
  fault = 'race-p2002'; const res2 = await post({ ...delivery(), id: 'race-other-0001' });
  fault = ''; const conflicting = await post({ ...delivery(), id: 'race-other-0001', quantity: 4 });
  assert.equal(res2.status, 200); assert.equal(conflicting.status, 409);
});
await test('stale revisions are rejected with 409 and no partial write', async () => {
  for (const extra of [{ expectedContentVersion: 2 }, { expectedUpdatedAt: '2026-10-19T01:00:00.000Z' }]) {
    const res = await post(delivery(extra)); assert.equal(res.status, 409); assert.equal(res.data.error, 'edit_conflict');
  }
  assert.equal(persisted().length, 0); assert.equal(state.cases.get(cid).contentVersion, 3);
});
await test('failed version claim, thrown failures and serialization failures roll the record back', async () => {
  fault = 'advance-lost'; assert.equal((await post(delivery())).status, 409);
  fault = 'advance-throw'; assert.equal((await post(delivery())).status, 500);
  fault = 'commit'; const res = await post(delivery()); assert.equal(res.status, 409); assert.equal(res.data.error, 'edit_conflict');
  assert.equal(persisted().length, 0); assert.equal(state.cases.get(cid).contentVersion, 3);
});
await test('void keeps the original, excludes it from summary, is idempotent and immutable', async () => {
  const created = (await post(delivery({ quantity: 2 }))).data.record;
  const missingReason = await voidRec(created.id, voidBody({ reason: ' ' })); assert.equal(missingReason.status, 400);
  const body = voidBody();
  const res = await voidRec(created.id, body);
  assert.equal(res.status, 200); assert.equal(res.data.record.voided, true); assert.equal(res.data.record.voidReason, '數量登錄錯誤'); assert.equal(res.data.record.quantity, 2);
  assert.equal(res.data.case.contentVersion, 5);
  const summary = (await list()).data;
  assert.equal(summary.summary.status, 'unknown'); assert.equal(summary.summary.voidedRecords, 1); assert.equal(summary.records.length, 1, 'voided evidence stays listed');
  const replay = await voidRec(created.id, body); assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true);
  const again = await voidRec(created.id, voidBody()); assert.equal(again.status, 409); assert.equal(again.data.error, 'delivery_already_voided');
  const reused = await voidRec(created.id, { ...body, reason: '另一個原因' }); assert.equal(reused.status, 409); assert.equal(reused.data.error, 'delivery_request_conflict');
  const second = (await post(delivery())).data.record;
  const crossUse = await voidRec(second.id, { ...body, ...version() }); assert.equal(crossUse.status, 409); assert.equal(crossUse.data.error, 'delivery_request_conflict');
  assert.equal(state.cases.get(cid).contentVersion, 6); assert.equal(persisted().length, 2);
  const replacement = await post(delivery({ quantity: 1, note: '更正：實際 1 件' })); assert.equal(replacement.status, 201);
  assert.deepEqual((await list()).data.summary.groups, [{ kind: 'main', unit: '件', quantity: 2, records: 2 }]);
});
await test('void applies the same assignment, version and record-ownership checks', async () => {
  const created = (await post(delivery())).data.record;
  assert.equal((await voidRec(created.id, voidBody(), 5)).status, 403);
  assert.equal((await voidRec(created.id, voidBody(), 3)).status, 403);
  assert.equal((await voidRec(created.id, voidBody({ expectedContentVersion: 3 }))).status, 409);
  assert.equal((await voidRec(created.id, voidBody({}, other), 3, other)).status, 404, 'a record cannot be voided through another case');
  assert.equal((await voidRec('missing-record-1', voidBody())).status, 404);
  assert.equal(state.deliveries.get(created.id).voidedAt, null); assert.equal((await voidRec(created.id, voidBody(), 4)).status, 200);
});
await test('review_done, done, closed, cancelled and archived cases reject new deliveries and voids; reads continue', async () => {
  const existing = (await post(delivery())).data.record;
  for (const patch of [{ status: 'review_done' }, { status: 'done' }, { status: 'closed', archived: true }, { status: 'cancelled', archived: true }, { status: 'doing', archived: true }]) {
    Object.assign(state.cases.get(cid), patch);
    const create = await post(delivery()); assert.equal(create.status, 409, JSON.stringify(patch)); assert.equal(create.data.error, 'case_locked');
    const voided = await voidRec(existing.id, voidBody()); assert.equal(voided.status, 409); assert.equal(voided.data.error, 'case_locked');
    assert.equal((await list()).status, 200);
  }
  assert.equal(persisted().length, 1); assert.equal(state.deliveries.get(existing.id).voidedAt, null);
});
await test('item name snapshot is preserved when the linked item is later renamed', async () => {
  const rec = (await post(delivery({ itemKey: KEY_A, itemName: undefined }))).data.record;
  const items = clone(state.cases.get(cid).items); items[0].n = '主視覺 KV（改名）';
  const res = await call(cid + '/items', 'PATCH', { items, ...version() }); assert.equal(res.status, 200);
  assert.equal(res.data.items[0].key, KEY_A); assert.equal((await list()).data.records[0].itemName, '主視覺 KV'); assert.equal(rec.itemKey, KEY_A);
});
await test('old screens that drop keys keep unchanged and uniquely named items stable', async () => {
  const keyless = clone(state.cases.get(cid).items).map(({ key, ...rest }) => rest);
  let res = await call(cid + '/items', 'PATCH', { items: keyless, ...version() });
  assert.equal(res.status, 200); assert.deepEqual(res.data.items.map(i => i.key), [KEY_A, KEY_B]);
  keyless[1].status = 'done'; keyless.push({ n: '新增 IG 尺寸', status: 'todo' });
  res = await call(cid + '/items', 'PATCH', { items: keyless, ...version() });
  assert.equal(res.status, 200); assert.equal(res.data.items[1].key, KEY_B, 'edited unlinked item keeps identity by unique name');
  assert.match(res.data.items[2].key, /^[A-Za-z0-9_-]{8,64}$/); assert(![KEY_A, KEY_B].includes(res.data.items[2].key));
  const reordered = [res.data.items[2], res.data.items[0], res.data.items[1]].map(({ key, ...rest }) => rest);
  res = await call(cid + '/items', 'PATCH', { items: reordered, ...version() });
  assert.deepEqual(res.data.items.map(i => i.n), ['新增 IG 尺寸', '主視覺 KV', 'FB 延伸']); assert.equal(res.data.items[1].key, KEY_A, 'not array-index matching');
});
await test('duplicate, foreign and malformed item keys are rejected without changing items', async () => {
  const base = clone(state.cases.get(cid).items);
  for (const [items, code] of [[[base[0], { ...base[1], key: KEY_A }], 'item_key_duplicate'], [[base[0], { ...base[1], key: 'item-key-foreign-1' }], 'item_key_foreign'], [[{ ...base[0], key: 'bad key!' }], 'item_key_invalid']]) {
    const res = await call(cid + '/items', 'PATCH', { items, ...version() }); assert.equal(res.status, 422, code); assert.equal(res.data.error, code);
  }
  assert.deepEqual(state.cases.get(cid).items, base); assert.equal(state.cases.get(cid).contentVersion, 3);
});
await test('linked items cannot be removed or ambiguously replaced; explicit keys and voided-only links can proceed', async () => {
  const rec = (await post(delivery({ itemKey: KEY_B, itemName: undefined, kind: 'extension', quantity: 3 }))).data.record;
  const base = clone(state.cases.get(cid).items);
  let res = await call(cid + '/items', 'PATCH', { items: [base[0]], ...version() });
  assert.equal(res.status, 409); assert.equal(res.data.error, 'linked_item_removed'); assert.match(res.data.message, /FB 延伸/);
  const editedKeyless = base.map(({ key, ...rest }) => rest); editedKeyless[1].status = 'done';
  res = await call(cid + '/items', 'PATCH', { items: editedKeyless, ...version() });
  assert.equal(res.status, 409, 'a linked key is never guessed from the name'); assert.deepEqual(state.cases.get(cid).items, base);
  const explicit = clone(base); explicit[1].status = 'done'; explicit[1].n = 'FB 延伸 4 尺寸';
  res = await call(cid + '/items', 'PATCH', { items: explicit, ...version() }); assert.equal(res.status, 200); assert.equal(res.data.items[1].key, KEY_B);
  assert.equal((await voidRec(rec.id, voidBody())).status, 200);
  res = await call(cid + '/items', 'PATCH', { items: [explicit[0]], ...version() }); assert.equal(res.status, 200, 'only non-voided evidence pins an item');
});
await test('a delivery written after an items editor loaded makes that stale items save 409', async () => {
  const stale = version(); assert.equal((await post(delivery({ itemKey: KEY_A, itemName: undefined }))).status, 201);
  const res = await call(cid + '/items', 'PATCH', { items: [state.cases.get(cid).items[1]], ...stale });
  assert.equal(res.status, 409); assert.equal(state.cases.get(cid).items.length, 2);
});
await test('new cases receive server item keys and refuse client-supplied keys', async () => {
  const base = { title: '新案', level: 'B', designerId: 2, openDate: '2026-10-21', dispatchDate: '2026-10-21', goLiveDate: '2026-11-10' };
  const res = await call('', 'POST', { ...base, items: [{ n: '主視覺' }, { n: '延伸' }] }, 1);
  assert.equal(res.status, 201); const keys = res.data.items.map(i => i.key);
  assert.equal(new Set(keys).size, 2); assert(keys.every(k => /^[A-Za-z0-9_-]{8,64}$/.test(k)));
  const foreign = await call('', 'POST', { ...base, items: [{ n: '主視覺', key: KEY_A }] }, 1);
  assert.equal(foreign.status, 422); assert.equal(foreign.data.error, 'item_key_foreign');
});
await test('cases with delivery evidence (even voided) cannot be deleted, including the FK race path', async () => {
  const rec = (await post(delivery())).data.record; await voidRec(rec.id, voidBody());
  let res = await call(cid, 'DELETE', undefined, 1); assert.equal(res.status, 409); assert.equal(res.data.error, 'case_has_deliveries'); assert(state.cases.has(cid));
  const realCount = prisma.deliveryRecord.count; prisma.deliveryRecord.count = async () => 0; // a delivery lands after the pre-check
  try { res = await call(cid, 'DELETE', undefined, 1); } finally { prisma.deliveryRecord.count = realCount; }
  assert.equal(res.status, 409); assert.equal(res.data.error, 'case_has_deliveries'); assert(state.cases.has(cid));
  state.cases.get(other).status = 'todo'; res = await call(other, 'DELETE', undefined, 1); assert.equal(res.status, 200); assert(!state.cases.has(other));
});
await test('Codex finding 1: an unchanged minimal item created without defaults keeps its linked key on a keyless save', async () => {
  const created = await call('', 'POST', { title: '最小子案件', level: 'B', designerId: 2, openDate: '2026-10-21', dispatchDate: '2026-10-21', goLiveDate: '2026-11-10', items: [{ n: 'Minimal item' }, { n: 'Second', status: null, assigneeId: null }] }, 1);
  assert.equal(created.status, 201); const id = created.data.id, [key, key2] = created.data.items.map(i => i.key);
  assert.equal((await post(delivery({ itemKey: key, itemName: undefined }, id), 2, id)).status, 201);
  assert.equal((await post(delivery({ itemKey: key2, itemName: undefined }, id), 2, id)).status, 201);
  const res = await call(id + '/items', 'PATCH', { items: [{ n: 'Minimal item' }, { n: 'Second' }], ...version(id) });
  assert.equal(res.status, 200, JSON.stringify(res.data)); assert.deepEqual(res.data.items.map(i => i.key), [key, key2]);
  const again = await call(id + '/items', 'PATCH', { items: [{ n: 'Minimal item', type: '', owner: '', status: '尚未製作' }, { n: 'Second', start: null, logs: [] }], ...version(id) });
  assert.equal(again.status, 200); assert.deepEqual(again.data.items.map(i => i.key), [key, key2]);
  const edited = await call(id + '/items', 'PATCH', { items: [{ n: 'Minimal item', status: 'done' }, { n: 'Second' }], ...version(id) });
  assert.equal(edited.status, 409, 'an edited linked item is still never guessed'); assert.equal(edited.data.error, 'linked_item_removed');
});
await test('Codex finding 2: omitting a previously supplied custom itemName is a different request, not a wildcard', async () => {
  const body = delivery({ itemKey: KEY_A, itemName: 'Custom delivery name' });
  assert.equal((await post(body)).status, 201);
  const { itemName, ...omitted } = body;
  const res = await post(omitted); assert.equal(res.status, 409); assert.equal(res.data.error, 'delivery_request_conflict');
  assert.equal(persisted().length, 1); assert.equal(persisted()[0].itemName, 'Custom delivery name');
  // The reverse direction and exact retries after a later item rename.
  const derived = delivery({ itemKey: KEY_B, itemName: undefined, kind: 'extension', quantity: 3 });
  const first = await post(derived); assert.equal(first.status, 201); assert.equal(first.data.record.itemName, 'FB 延伸');
  const items = clone(state.cases.get(cid).items); items[1].n = 'FB 延伸（改名）';
  assert.equal((await call(cid + '/items', 'PATCH', { items, ...version() })).status, 200);
  const retry = await post(derived); assert.equal(retry.status, 200, 'the exact omitted-name retry still replays after a rename'); assert.equal(retry.data.record.itemName, 'FB 延伸');
  const named = await post({ ...derived, itemName: 'FB 延伸' }); assert.equal(named.status, 409, 'supplying the derived name explicitly is a different intent');
  assert.equal(persisted().length, 2); assert.match(persisted()[0].requestFingerprint, /^[0-9a-f]{64}$/);
  assert.notEqual(persisted()[0].requestFingerprint, persisted()[1].requestFingerprint);
});
const replaceRec = (recordId, body, as = 2, id = cid) => call(`${id}/deliveries/${recordId}/replace`, 'POST', body, as);
const replaceBody = (extra = {}, id = cid) => ({ ...delivery({ quantity: 2, note: '更正為 2 件' }, id), id: rid('fix'), reason: '數量登錄錯誤', ...extra });
const active = () => persisted().filter(r => !r.voidedAt);
await test('B replace: one transaction voids the original, stores the replacement and advances the version once', async () => {
  const original = (await post(delivery({ quantity: 1 }))).data.record; assert.equal(state.cases.get(cid).contentVersion, 4);
  const body = replaceBody(); const res = await replaceRec(original.id, body);
  assert.equal(res.status, 201); assert.equal(res.data.replayed, false);
  assert.equal(res.data.original.id, original.id); assert.equal(res.data.original.voided, true); assert.equal(res.data.original.voidReason, '數量登錄錯誤'); assert.equal(res.data.original.quantity, 1);
  assert.equal(res.data.replacement.id, body.id); assert.equal(res.data.replacement.quantity, 2); assert.equal(res.data.replacement.voided, false);
  assert.equal(state.deliveries.get(original.id).voidRequestId, body.id, 'the void stamp names the replacement operation');
  assert.equal(res.data.case.contentVersion, 5); assert.equal(state.cases.get(cid).contentVersion, 5, 'exactly one version step');
  assert.deepEqual((await list()).data.summary.groups, [{ kind: 'main', unit: '件', quantity: 2, records: 1 }]);
  assert.equal(persisted().length, 2); assert.equal(active().length, 1);
});
await test('B replace: invalid reason or replacement payload changes nothing', async () => {
  const original = (await post(delivery())).data.record;
  for (const extra of [{ reason: undefined }, { reason: ' ' }, { reason: 'x' }, { quantity: 1.5 }, { kind: 'revision' }, { deliveredOn: '2026-02-30' }, { recordedById: 1 }, { unexpected: true }]) {
    const res = await replaceRec(original.id, replaceBody(extra)); assert.equal(res.status, 400, JSON.stringify(extra));
  }
  for (const [extra, code] of [[{ kind: 'support', quantity: 0, note: '無' }, 'zero_output_note_required'], [{ kind: 'main', quantity: 0 }, 'zero_output_kind'], [{ deliveredOn: '2099-01-01' }, 'delivered_on_future'], [{ itemKey: 'item-key-missing-9' }, 'item_key_unknown']]) {
    const res = await replaceRec(original.id, replaceBody(extra)); assert.equal(res.status, 422, code); assert.equal(res.data.error, code);
  }
  assert.equal(persisted().length, 1); assert.equal(state.deliveries.get(original.id).voidedAt, null); assert.equal(state.cases.get(cid).contentVersion, 4);
});
await test('B replace: roles, locked states, missing/foreign originals and already-voided originals are refused', async () => {
  const original = (await post(delivery())).data.record;
  assert.equal((await replaceRec(original.id, replaceBody(), 5)).data.error, 'read_only');
  assert.equal((await replaceRec(original.id, replaceBody(), 3)).data.error, 'forbidden');
  assert.equal((await replaceRec('missing-record-1', replaceBody())).status, 404);
  assert.equal((await replaceRec(original.id, replaceBody({}, other), 3, other)).status, 404, 'original must belong to the path case');
  for (const patch of [{ status: 'review_done' }, { status: 'closed', archived: true }, { status: 'cancelled', archived: true }, { status: 'doing', archived: true }]) {
    Object.assign(state.cases.get(cid), patch); const res = await replaceRec(original.id, replaceBody());
    assert.equal(res.status, 409); assert.equal(res.data.error, 'case_locked');
  }
  Object.assign(state.cases.get(cid), { status: 'doing', archived: false });
  assert.equal((await voidRec(original.id, voidBody())).status, 200);
  const res = await replaceRec(original.id, replaceBody()); assert.equal(res.status, 409); assert.equal(res.data.error, 'delivery_already_voided');
  assert.equal(active().length, 0); assert.equal(persisted().length, 1);
  assert.equal((await replaceRec(original.id, replaceBody(), 4)).status, 409, 'collaborators reach the same state check');
});
await test('B replace: exact retry replays after a lost response; any changed element conflicts', async () => {
  const original = (await post(delivery())).data.record;
  const body = replaceBody(); const first = await replaceRec(original.id, body); assert.equal(first.status, 201);
  const retry = await replaceRec(original.id, body); // stale version: response was lost
  assert.equal(retry.status, 200); assert.equal(retry.data.replayed, true); assert.equal(retry.data.replacement.id, body.id); assert.equal(retry.data.original.id, original.id);
  assert.equal(state.cases.get(cid).contentVersion, 5);
  const second = (await post(delivery())).data.record;
  for (const [changed, recordId, as] of [[{ reason: '另一個原因' }, original.id, 2], [{ quantity: 3 }, original.id, 2], [{ note: '不同說明' }, original.id, 2], [{}, second.id, 2], [{}, original.id, 4]]) {
    const res = await replaceRec(recordId, { ...body, ...changed, ...version() }, as);
    assert.equal(res.status, 409, JSON.stringify(changed) + recordId + as); assert.equal(res.data.error, 'delivery_request_conflict');
  }
  const { reason, ...plain } = body; const asCreate = await post({ ...plain, ...version() });
  assert.equal(asCreate.status, 409, 'a replacement is never replayed as a plain create'); assert.equal(asCreate.data.error, 'delivery_request_conflict');
  const plainId = (await post(delivery())).data.record.id;
  const asReplace = await replaceRec(second.id, replaceBody({ id: plainId })); assert.equal(asReplace.status, 409, 'a plain create is never replayed as a replacement');
  assert.equal(state.deliveries.get(second.id).voidedAt, null); assert.equal(active().length, 3);
});
await test('B replace: failures at any step leave neither the replacement, the void stamp nor a version step', async () => {
  const original = (await post(delivery())).data.record;
  for (const f of ['advance-lost', 'advance-throw', 'commit']) {
    fault = f; const res = await replaceRec(original.id, replaceBody()); fault = '';
    assert(res.status === 409 || res.status === 500, f);
    assert.equal(persisted().length, 1, f); assert.equal(state.deliveries.get(original.id).voidedAt, null, f); assert.equal(state.cases.get(cid).contentVersion, 4, f);
  }
  assert.equal((await replaceRec(original.id, replaceBody({ expectedContentVersion: 3 }))).data.error, 'edit_conflict');
  assert.equal(persisted().length, 1);
});
await test('B replace: concurrent replace/void and two concurrent replacements leave exactly one active successor', async () => {
  const a = (await post(delivery())).data.record;
  const [r1, v1] = await Promise.all([replaceRec(a.id, replaceBody()), voidRec(a.id, voidBody())]);
  assert.deepEqual([r1.status, v1.status].sort(), [201, 409]);
  const b = (await post(delivery())).data.record;
  const [x, y] = await Promise.all([replaceRec(b.id, replaceBody()), replaceRec(b.id, replaceBody({ quantity: 5 }))]);
  assert.deepEqual([x.status, y.status].sort(), [201, 409]);
  const successors = active().filter(r => r.id !== a.id && r.id !== b.id); assert.equal(persisted().filter(r => r.voidedAt).length, 2);
  assert.equal(active().length, successors.length); assert.equal(active().length, 1 + (r1.status === 201 ? 1 : 0));
});
await test('B replace: disabled flag hides the operation', async () => {
  const original = (await post(delivery())).data.record; delete process.env.DELIVERY_RECORDS_ENABLED;
  const res = await replaceRec(original.id, replaceBody()); assert.equal(res.status, 404); assert.equal(res.data.error, 'feature_disabled');
  assert.equal(persisted().length, 1);
});
await test('delivery writes never issue raw SQL, notifications or legacy count changes', async () => {
  await post(delivery()); const rec = (await post(delivery())).data.record; await voidRec(rec.id, voidBody());
  assert.equal(trace.rawStatements, 0); assert.equal(state.notifications.length, 0);
  assert.equal(state.cases.get(cid).requestCount, null); assert.equal(state.cases.get(cid).outputCount, null);
});
console.log(JSON.stringify({ passed, liveDatabase: false, emailsSent: 0, flag: 'DELIVERY_RECORDS_ENABLED' }));
