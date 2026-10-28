// REPORTS-P2-D1a: actual Express case + schedule-request routes against an isolated, rollback-capable Prisma
// double (serialized like Serializable). Harness forked from tests/caseDeliveryWorkflowSafety.mjs and extended
// with case_schedule_requests. No listener, real database, SMTP or production data.
// Real PostgreSQL constraints, triggers and overlapping transactions: tests/postgresMaintenance.mjs.
import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex } from 'node:stream';
import { createRequire } from 'node:module';
const root = process.env.DESIGN_PM_ROOT || new URL('../', import.meta.url).pathname;
const require = createRequire(root + '/package.json');
const express = require('express'), cookieParser = require('cookie-parser');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'isolated-schedule-workflow-tests-secret';
process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:1/never_connect';
for (const key of Object.keys(process.env)) if (key.startsWith('SMTP_')) delete process.env[key];
const { prisma } = await import(root + '/src/lib/db.js');
const { signToken } = await import(root + '/src/middleware/auth.js');
const clone = v => structuredClone(v);
const people = new Map([
  { id: 1, name: 'Admin', role: 'admin' }, { id: 2, name: 'Owner', role: 'member' }, { id: 3, name: 'Unrelated', role: 'member' },
  { id: 4, name: 'Collaborator', role: 'member' }, { id: 5, name: 'Observer', role: 'observer' }, { id: 6, name: 'Second Admin', role: 'admin' },
].map(p => [p.id, { active: true, pendingActivation: false, sessionVersion: 0, ...p }]));
const R = 'R-2026-10-001', L = 'L-2026-10-002';
let state, queue, fault, beforeTx, trace;
function freshCase(id, extra = {}) {
  return { id, title: 'Workflow ' + id, requester: 'Fixture', level: 'A', designerId: 2, collaborators: [{ id: 4 }], createdById: 1, status: 'doing', archived: false,
    archivePath: '/shared/' + id, closedOn: null, cancelledOn: null, cancelReason: null, cancelStage: null, requestCount: null, outputCount: null, note: '',
    openDate: new Date('2026-10-01'), dispatchDate: new Date('2026-10-02'), copyDate: new Date('2026-10-10'), printDate: null, goLiveDate: new Date('2026-10-30'),
    scheduleMode: 'legacy', scheduleModeSince: null, scheduleModeById: null, scheduleModeByName: null, scheduleModeReason: null, scheduleModeRequestId: null,
    scheduleModeFingerprint: null, scheduleBaseline: null, pendingScheduleRequestId: null, level: 'A', urgent: false,
    items: [{ key: 'item-key-main-0001', n: '主視覺 KV', status: 'doing' }], logs: [], contentVersion: 3, updatedAt: new Date('2026-10-20T01:00:00.000Z'),
    deliveryMode: 'legacy', deliveryModeSince: null, deliveryModeById: null, deliveryModeByName: null, deliveryModeReason: null,
    deliveryModeRequestId: null, deliveryModeFingerprint: null, pendingDeliverySubmissionId: null, ...extra };
}
const recordsStamp = { deliveryMode: 'records', deliveryModeSince: new Date('2026-10-19T00:00:00Z'), deliveryModeById: 1, deliveryModeByName: 'Admin', deliveryModeReason: '測試案件' };
function reset() {
  state = { staff: new Map(clone([...people])), cases: new Map([[R, freshCase(R, recordsStamp)], [L, freshCase(L)]]), deliveries: new Map(), submissions: new Map(), schedules: new Map(), audits: [], notifications: [], transfers: [] };
  queue = Promise.resolve(); fault = ''; beforeTx = null; trace = { transactions: 0 };
  process.env.DELIVERY_RECORDS_ENABLED = '1'; process.env.DELIVERY_WORKFLOW_ENABLED = '1'; process.env.SCHEDULE_WORKFLOW_ENABLED = '1';
}
function matches(record, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (key === 'OR') return value.some(part => matches(record, part));
    if (key === 'AND') return value.every(part => matches(record, part));
    if (key === 'NOT') return !matches(record, value);
    if (key === 'collaborators' && value?.some) return record.collaborators.some(p => matches(p, value.some));
    if (value instanceof Date) return record[key] instanceof Date && record[key].getTime() === value.getTime();
    if (value && typeof value === 'object') {
      if ('startsWith' in value) return String(record[key]).startsWith(value.startsWith);
      if ('not' in value) return value.not === null ? record[key] != null : record[key] !== value.not;
      if ('in' in value) return value.in.includes(record[key]);
      throw Error('Unsupported fixture predicate ' + key);
    }
    return record[key] === value;
  });
}
const p2002 = () => Object.assign(Error('Unique constraint failed'), { code: 'P2002' });
function hydrate(db, row, withCounts) {
  if (!row) return null;
  const out = clone({ ...row, designer: { id: row.designerId, name: people.get(row.designerId)?.name }, collaborators: row.collaborators.map(p => ({ id: p.id, name: people.get(p.id)?.name })) });
  if (withCounts) out._count = { deliveries: [...db.deliveries.values()].filter(d => d.caseId === row.id).length, deliverySubmissions: [...db.submissions.values()].filter(s => s.caseId === row.id).length,
    scheduleRequests: [...db.schedules.values()].filter(s => s.caseId === row.id).length };
  return out;
}
function applyData(row, data) {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && 'increment' in v) row[k] = row[k] + v.increment;
    else if (k === 'collaborators') { if (v.set) row.collaborators = clone(v.set); if (v.disconnect) row.collaborators = row.collaborators.filter(c => !v.disconnect.some(d => d.id === c.id)); }
    else row[k] = clone(v);
  }
}
function checkCaseConstraints(row) {
  // Mirrors 0004: pending submission only on records review_done; records always stamped.
  if (row.pendingDeliverySubmissionId && !(row.deliveryMode === 'records' && row.status === 'review_done')) throw Object.assign(Error('check cases_pending_delivery_submission'), { code: 'P2004' });
  // Mirrors 0005: a pending schedule request / baseline only on managed cases.
  if ((row.pendingScheduleRequestId || row.scheduleBaseline) && row.scheduleMode !== 'managed') throw Object.assign(Error('check cases_schedule_mode_stamp'), { code: 'P2004' });
}
function client(db, inTx = false) {
  return {
    staff: { findUnique: async ({ where }) => clone(db.staff.get(where.id) ?? null), findMany: async ({ where } = {}) => [...db.staff.values()].filter(s => matches(s, where)).map(clone) },
    case: {
      findUnique: async ({ where, include }) => hydrate(db, db.cases.get(where.id) ?? null, !!include?._count),
      findFirst: async ({ where }) => hydrate(db, [...db.cases.values()].find(r => matches(r, where)) ?? null),
      findMany: async ({ where, include } = {}) => [...db.cases.values()].filter(r => matches(r, where)).map(r => hydrate(db, r, !!include?._count)),
      updateMany: async ({ where, data }) => {
        if (fault === 'claim-lost' && inTx) return { count: 0 };
        const rows = [...db.cases.values()].filter(r => matches(r, where));
        for (const row of rows) { applyData(row, data); checkCaseConstraints(row); }
        return { count: rows.length };
      },
      update: async ({ where, data }) => {
        const row = db.cases.get(where.id);
        if (!row || !matches(row, where)) throw Object.assign(Error('Record to update not found'), { code: 'P2025' });
        applyData(row, data); row.updatedAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)); return hydrate(db, row);
      },
      create: async ({ data }) => {
        if (db.cases.has(data.id)) throw p2002();
        const row = { ...freshCase(data.id), items: null, ...clone(data), designerId: data.designer?.connect?.id ?? data.designerId, collaborators: data.collaborators?.connect ?? [] };
        delete row.designer; delete row.createdBy; db.cases.set(row.id, row); return hydrate(db, row);
      },
      delete: async ({ where }) => {
        if ([...db.schedules.values()].some(d => d.caseId === where.id)) throw Object.assign(Error('violates RESTRICT setting of foreign key constraint "case_schedule_requests_caseId_fkey"'), {});
        if ([...db.deliveries.values(), ...db.submissions.values()].some(d => d.caseId === where.id)) throw Object.assign(Error('violates RESTRICT setting of foreign key constraint "case_delivery_submissions_caseId_fkey"'), {});
        const row = db.cases.get(where.id); db.cases.delete(where.id); return clone(row);
      },
    },
    deliveryRecord: {
      findUnique: async ({ where }) => clone(db.deliveries.get(where.id) ?? [...db.deliveries.values()].find(d => where.voidRequestId && d.voidRequestId === where.voidRequestId) ?? null),
      findMany: async ({ where, select } = {}) => [...db.deliveries.values()].filter(d => matches(d, where)).sort((a, b) => a.id.localeCompare(b.id)).map(d => clone(select ? Object.fromEntries(Object.keys(select).map(k => [k, d[k]])) : d)),
      count: async ({ where }) => [...db.deliveries.values()].filter(d => matches(d, where)).length,
      create: async ({ data }) => { if (db.deliveries.has(data.id)) throw p2002(); const row = { ...clone(data), createdAt: new Date(), voidedAt: null, voidedById: null, voidedByName: null, voidReason: null, voidRequestId: null }; db.deliveries.set(row.id, row); return clone(row); },
      updateMany: async ({ where, data }) => { const rows = [...db.deliveries.values()].filter(d => matches(d, where)); for (const r of rows) Object.assign(r, clone(data)); return { count: rows.length }; },
    },
    deliverySubmission: {
      findUnique: async ({ where }) => clone(where.id ? db.submissions.get(where.id) ?? null : [...db.submissions.values()].find(s => s.decisionOperationId && s.decisionOperationId === where.decisionOperationId) ?? null),
      findMany: async ({ where } = {}) => [...db.submissions.values()].filter(s => matches(s, where)).sort((a, b) => b.createdAt - a.createdAt).map(clone),
      count: async ({ where }) => [...db.submissions.values()].filter(s => matches(s, where)).length,
      create: async ({ data }) => {
        if (db.submissions.has(data.id)) throw p2002();
        assert.equal(data.completenessConfirmed, true); assert(Array.isArray(data.recordIds) && data.recordIds.length >= 1); assert(String(data.archivePath).trim());
        const row = { ...clone(data), createdAt: new Date(Date.now() + db.submissions.size), decision: null, decidedAt: null, decidedById: null, decidedByName: null, decisionReason: null, decisionOperationId: null, decisionFingerprint: null, zeroSupportApproved: null };
        db.submissions.set(row.id, row); return clone(row);
      },
      updateMany: async ({ where, data }) => {
        if (data.decisionOperationId && [...db.submissions.values()].some(s => s.decisionOperationId === data.decisionOperationId)) throw p2002();
        const rows = [...db.submissions.values()].filter(s => matches(s, where)); for (const r of rows) Object.assign(r, clone(data)); return { count: rows.length };
      },
    },
    scheduleRequest: {
      findUnique: async ({ where }) => clone(where.id ? db.schedules.get(where.id) ?? null : [...db.schedules.values()].find(s => s.decisionOperationId && s.decisionOperationId === where.decisionOperationId) ?? null),
      findMany: async ({ where } = {}) => [...db.schedules.values()].filter(s => matches(s, where)).sort((a, b) => b.createdAt - a.createdAt).map(clone),
      count: async ({ where }) => [...db.schedules.values()].filter(s => matches(s, where)).length,
      create: async ({ data }) => {
        if (db.schedules.has(data.id)) throw p2002();
        assert(String(data.reason).trim().length >= 2); assert.notDeepEqual(data.currentSchedule, data.proposedSchedule);
        for (const k of ['dispatchDate', 'copyDate', 'printDate', 'goLiveDate']) { assert(k in data.currentSchedule && k in data.proposedSchedule, 'snapshot carries ' + k); }
        const row = { ...clone(data), createdAt: new Date(Date.now() + db.schedules.size), decision: null, decidedAt: null, decidedById: null, decidedByName: null, decisionReason: null, decisionOperationId: null, decisionFingerprint: null, approvedSchedule: null };
        db.schedules.set(row.id, row); return clone(row);
      },
      updateMany: async ({ where, data }) => {
        if (data.decisionOperationId && [...db.schedules.values()].some(s => s.decisionOperationId === data.decisionOperationId)) throw p2002();
        const rows = [...db.schedules.values()].filter(s => matches(s, where));
        for (const r of rows) { assert.equal(r.decidedAt, null, 'decision stamped once (0005 trigger)'); for (const [k, v] of Object.entries(data)) if (v !== undefined) r[k] = clone(v); }
        return { count: rows.length };
      },
    },
    changeLog: { createMany: async ({ data }) => { if (fault === 'audit' && inTx) throw Error('Synthetic audit failure'); db.audits.push(...clone(data)); return { count: data.length }; } },
    transferLog: { create: async ({ data }) => { db.transfers.push(clone(data)); return clone(data); } },
    notification: { findFirst: async () => null, updateMany: async () => ({ count: 0 }), create: async ({ data }) => { assert.equal(inTx, false, 'notifications only after commit'); state.notifications.push(clone(data)); return clone(data); }, createMany: async ({ data }) => { state.notifications.push(...clone(data)); return { count: data.length }; } },
  };
}
reset();
for (const model of ['case', 'staff', 'changeLog', 'notification', 'deliveryRecord', 'deliverySubmission', 'scheduleRequest', 'transferLog']) {
  for (const method of ['findUnique', 'findFirst', 'findMany', 'count', 'update', 'updateMany', 'create', 'createMany', 'delete', 'deleteMany']) {
    prisma[model][method] = async (...args) => { const fn = client(state)[model]?.[method]; if (!fn) throw Error('Blocked unexpected Prisma method ' + model + '.' + method); return fn(...args); };
  }
}
for (const method of ['$connect', '$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe']) prisma[method] = async () => { throw Error('Live database prohibited'); };
prisma.$transaction = (run, options) => {
  if (Array.isArray(run)) return Promise.all(run);
  assert.equal(options?.isolationLevel, 'Serializable');
  const result = queue.then(async () => {
    trace.transactions++;
    if (beforeTx) { const hook = beforeTx; beforeTx = null; hook(state); }
    const isolated = { ...state, staff: new Map(clone([...state.staff])), cases: new Map(clone([...state.cases])), deliveries: new Map(clone([...state.deliveries])), submissions: new Map(clone([...state.submissions])), schedules: new Map(clone([...state.schedules])), audits: clone(state.audits) };
    const value = await run(client(isolated, true));
    if (fault === 'commit') throw Object.assign(Error('Synthetic serialization failure'), { code: 'P2034' });
    state = { ...isolated, notifications: state.notifications, transfers: state.transfers }; return value;
  });
  queue = result.catch(() => {}); return result;
};
const app = express(); app.use(cookieParser()); app.use('/api/cases', (await import(root + '/src/routes/cases.js')).default);
app.use((_e, _req, res, _next) => res.status(500).json({ error: 'server_error' }));
function call(path, method = 'GET', body, as = 2) {
  return new Promise((resolve, reject) => {
    const socket = new Duplex({ read() {}, write(_b, _e, done) { done(); } });
    const req = new http.IncomingMessage(socket); req.url = '/api/cases/' + path; req.method = method;
    req.headers = { cookie: 'designpm_token=' + signToken(people.get(as)), 'content-type': 'application/json' }; req.body = body === undefined ? {} : clone(body);
    const res = new http.ServerResponse(req);
    res.end = data => { resolve({ status: res.statusCode, data: JSON.parse(String(data)) }); socket.destroy(); return res; };
    app.handle(req, res, e => reject(e || Error('Route not handled')));
  });
}
const v = (id = L) => ({ expectedUpdatedAt: state.cases.get(id).updatedAt.toISOString(), expectedContentVersion: state.cases.get(id).contentVersion });
let seq = 0; const nid = tag => `${tag}-${String(++seq).padStart(6, '0')}`;
const row = (id = L) => state.cases.get(id);
const reqs = () => [...state.schedules.values()];
const ymd = d => (d ? new Date(d).toISOString().slice(0, 10) : null);
const sched = (id = L) => ({ dispatchDate: ymd(row(id).dispatchDate), copyDate: ymd(row(id).copyDate), printDate: ymd(row(id).printDate), goLiveDate: ymd(row(id).goLiveDate) });
const adopt = async (id = L, extra = {}, as = 1) => call(id + '/schedule-mode/adopt', 'POST', { requestId: nid('adopt'), reason: '試行時程受控管理', ...v(id), ...extra }, as);
const proposeBody = (extra = {}, id = L) => ({ id: nid('sch'), reasonCategory: 'requester_change', reason: '需求方延後活動檔期', proposedDates: { goLiveDate: '2026-11-06' }, ...v(id), ...extra });
const propose = (body, as = 2, id = L) => call(id + '/schedule-requests', 'POST', body, as);
const decideBody = (extra = {}, id = L) => ({ operationId: nid('op'), decision: 'approve', ...v(id), ...extra });
const decideS = (rid, body, as = 1, id = L) => call(`${id}/schedule-requests/${rid}/decide`, 'POST', body, as);
const withdrawS = (rid, extra = {}, as = 2, id = L) => call(`${id}/schedule-requests/${rid}/withdraw`, 'POST', { operationId: nid('wd'), reason: '改由下週再評估', ...v(id), ...extra }, as);
const patch = (body, as = 2, id = L) => call(id, 'PATCH', body, as);
const managed = async (id = L) => { const r = await adopt(id); assert.equal(r.status, 201, JSON.stringify(r.data)); };
const pending = async (body = proposeBody(), as = 2, id = L) => { const r = await propose(body, as, id); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.request; };
function pauseNextPatchRead() {
  const real = prisma.case.findUnique; let release, readDone;
  const gate = new Promise(r => { release = r; }); const done = new Promise(r => { readDone = r; });
  prisma.case.findUnique = async args => {
    const result = await real(args);
    if (args?.include?.collaborators?.select?.id && !args.include._count) { prisma.case.findUnique = real; readDone(); await gate; }
    return result;
  };
  return { readDone: done, release: () => release() };
}

let passed = 0;
async function test(name, fn) { reset(); await fn(); passed++; console.log('PASS ' + name); }

await test('adoption: admin-only, meaningful reason, real versions, observed baseline (unknown stays null), exact replay, one-way', async () => {
  assert.equal((await adopt(L, {}, 2)).data.error, 'admin_only'); assert.equal((await adopt(L, {}, 5)).data.error, 'read_only');
  for (const reason of ['看板拖曳', '—', '!!', ' 1 ']) assert.equal((await adopt(L, { reason })).status, 400, reason);
  assert.equal((await adopt(L, { expectedContentVersion: undefined })).data.error, 'client_update_required');
  assert.equal((await adopt(L, { expectedContentVersion: 1 })).data.error, 'edit_conflict');
  const body = { requestId: nid('adopt'), reason: '試行時程受控管理', ...v() };
  const r = await call(L + '/schedule-mode/adopt', 'POST', body, 1); assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(row().scheduleMode, 'managed'); assert.equal(row().scheduleModeById, 1); assert.equal(row().contentVersion, 4);
  assert.deepEqual(row().scheduleBaseline && { ...row().scheduleBaseline, observedAt: 'x' }, { dispatchDate: '2026-10-02', copyDate: '2026-10-10', printDate: null, goLiveDate: '2026-10-30', observedAt: 'x', source: 'observed_at_adoption' });
  assert.deepEqual(sched(), { dispatchDate: '2026-10-02', copyDate: '2026-10-10', printDate: null, goLiveDate: '2026-10-30' }, 'official dates unchanged');
  assert(state.audits.some(a => a.field === 'scheduleMode' && /導入時觀測/.test(a.reason)));
  const replay = await call(L + '/schedule-mode/adopt', 'POST', body, 1); assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true); assert.equal(row().contentVersion, 4);
  assert.equal((await call(L + '/schedule-mode/adopt', 'POST', { ...body, reason: '其他原因說明' }, 1)).data.error, 'schedule_request_conflict');
  assert.equal((await adopt()).data.error, 'already_managed');
  assert.equal(row().deliveryMode, 'legacy', 'independent of deliveryMode');
  process.env.SCHEDULE_WORKFLOW_ENABLED = '0'; assert.equal((await adopt(R)).status, 404); process.env.SCHEDULE_WORKFLOW_ENABLED = '1';
  Object.assign(row(R), { status: 'closed', archived: true }); assert.equal((await adopt(R)).data.error, 'case_locked');
});
await test('proposal keeps the official dates; strict dates/keys/impact/reason; one pending; exact replay vs changed intent', async () => {
  await managed();
  const before = sched();
  for (const [extra, code] of [[{ proposedDates: { goLiveDate: '2026-02-30' } }, 400], [{ proposedDates: { goLiveDate: '2026-11-06', title: 'x' } }, 400], [{ proposedDates: {} }, 400],
    [{ proposedDates: { goLiveDate: null } }, 400], [{ impactFrom: '2026-10-20' }, 400], [{ impactFrom: '2026-10-22', impactTo: '2026-10-20' }, 400],
    [{ reason: '看板拖曳' }, 400], [{ reason: '。。。' }, 400], [{ reasonCategory: 'blame_vendor' }, 400], [{ extra: 1 }, 400],
    [{ proposedDates: { goLiveDate: '2026-10-30' } }, 422], [{ expectedUpdatedAt: undefined }, 409], [{ expectedContentVersion: 0 }, 409]]) {
    const r = await propose(proposeBody(extra)); assert.equal(r.status, code, JSON.stringify(extra) + ' ' + JSON.stringify(r.data));
  }
  assert.equal((await propose(proposeBody(), 3)).data.error, 'forbidden', 'unassigned member');
  const body = proposeBody({ proposedDates: { goLiveDate: '2026-11-06', printDate: '2026-11-01', copyDate: null }, impactFrom: '2026-10-20', impactTo: '2026-10-24', reasonCategory: 'external_vendor' });
  const r = await propose(body, 4); assert.equal(r.status, 201, 'collaborator may propose');
  assert.deepEqual(sched(), before, 'official dates unchanged by a proposal');
  assert.deepEqual(r.data.request.currentSchedule, before); assert.deepEqual(r.data.request.proposedSchedule, { dispatchDate: '2026-10-02', copyDate: null, printDate: '2026-11-01', goLiveDate: '2026-11-06' });
  assert.equal(r.data.request.status, 'pending'); assert.equal(row().pendingScheduleRequestId, body.id); assert.deepEqual(r.data.request.assignmentSnapshot, { designerId: 2, collaboratorIds: [4] });
  const replay = await propose(body, 4); assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true, 'exact retry replays even with the old version');
  assert.equal((await propose({ ...body, reason: '另一個不同的原因' }, 4)).data.error, 'schedule_request_conflict');
  assert.equal((await propose(proposeBody())).data.error, 'schedule_request_pending');
  const list = await call(L + '/schedule-requests', 'GET', undefined, 5); assert.equal(list.status, 200, 'observer can read');
  assert.equal(list.data.pendingRequestId, body.id); assert.equal(list.data.mode, 'managed'); assert.deepEqual(list.data.schedule, before); assert.equal(list.data.baseline.source, 'observed_at_adoption');
  assert.equal(reqs().length, 1);
});
await test('approve applies the immutable proposal exactly once (incl. printDate set and copyDate cleared); replay and second manager do nothing', async () => {
  await managed(); const req = await pending(proposeBody({ proposedDates: { goLiveDate: '2026-11-06', printDate: '2026-11-01', copyDate: null } }));
  assert.equal((await decideS(req.id, decideBody(), 2)).data.error, 'admin_only');
  const body = decideBody({ reason: '同意配合活動延期' }); const audits = state.audits.length;
  const ok = await decideS(req.id, body); assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(sched(), { dispatchDate: '2026-10-02', copyDate: null, printDate: '2026-11-01', goLiveDate: '2026-11-06' });
  assert.equal(row().pendingScheduleRequestId, null); assert.equal(ok.data.request.status, 'approved'); assert.deepEqual(ok.data.request.approvedSchedule, ok.data.request.proposedSchedule);
  assert.deepEqual(ok.data.request.currentSchedule, { dispatchDate: '2026-10-02', copyDate: '2026-10-10', printDate: null, goLiveDate: '2026-10-30' }, 'prior official dates kept');
  const added = state.audits.slice(audits); assert.deepEqual(added.map(a => a.field).sort(), ['copyDate', 'goLiveDate', 'printDate']); assert(added.every(a => /改期核准/.test(a.reason) && a.operator === 'Admin'));
  assert.equal(row().scheduleBaseline.goLiveDate, '2026-10-30', 'adoption baseline never rewritten (lateness stays visible)');
  const cv = row().contentVersion;
  const replay = await decideS(req.id, body); assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true); assert.equal(row().contentVersion, cv); assert.equal(state.audits.length, audits + 3);
  assert.equal((await decideS(req.id, { ...body, decision: 'reject', reason: '改成退回原因' })).data.error, 'schedule_request_conflict');
  assert.equal((await decideS(req.id, decideBody(), 6)).data.error, 'schedule_request_closed');
});
await test('two managers deciding at once: exactly one wins', async () => {
  await managed(); const req = await pending(); const base = v();
  const res = await Promise.all([decideS(req.id, { operationId: nid('op'), decision: 'approve', ...base }, 1), decideS(req.id, { operationId: nid('op'), decision: 'reject', reason: '日期無法配合印刷', ...base }, 6)]);
  assert.deepEqual(res.map(r => r.status).sort(), [200, 409], JSON.stringify(res.map(r => r.data)));
  const decided = reqs()[0]; assert(['approved', 'rejected'].includes(decided.decision));
  assert.equal(ymd(row().goLiveDate), decided.decision === 'approved' ? '2026-11-06' : '2026-10-30');
});
await test('reject needs a meaningful reason; reject and withdraw keep the official dates and full history; withdraw needs current assignment', async () => {
  await managed(); let req = await pending();
  for (const reason of [undefined, '—', '看板拖曳']) assert.equal((await decideS(req.id, decideBody({ decision: 'reject', ...(reason === undefined ? {} : { reason }) }))).data.error, 'reject_reason_required');
  const rj = await decideS(req.id, decideBody({ decision: 'reject', reason: '印刷廠排程無法延後' })); assert.equal(rj.status, 200); assert.equal(ymd(row().goLiveDate), '2026-10-30');
  req = await pending();
  assert.equal((await withdrawS(req.id, { reason: '—' })).status, 400);
  assert.equal((await withdrawS(req.id, {}, 3)).data.error, 'forbidden');
  const wd = await withdrawS(req.id, {}, 4); assert.equal(wd.status, 200, 'collaborator withdraws'); assert.equal(ymd(row().goLiveDate), '2026-10-30'); assert.equal(row().pendingScheduleRequestId, null);
  const list = await call(L + '/schedule-requests'); assert.deepEqual(list.data.requests.map(r => r.status).sort(), ['rejected', 'withdrawn']);
});
await test('never rebase: changed assignment or schedule after the request blocks approval (409) and changes nothing', async () => {
  await managed(); let req = await pending();
  const t = await call(L + '/transfer', 'POST', { toDesignerId: 6, reason: '主管派發' }, 1); assert.equal(t.status, 200, JSON.stringify(t.data));
  let r = await decideS(req.id, decideBody()); assert.equal(r.data.error, 'schedule_base_changed'); assert.equal(ymd(row().goLiveDate), '2026-10-30'); assert.equal(row().pendingScheduleRequestId, req.id);
  assert.equal((await decideS(req.id, decideBody({ decision: 'reject', reason: '主責已改，請重新申請' }))).status, 200);
  req = await pending(proposeBody(), 6);
  row().dispatchDate = new Date('2026-10-03'); // another committed path moved a milestone
  r = await decideS(req.id, decideBody()); assert.equal(r.data.error, 'schedule_base_changed'); assert.equal(ymd(row().goLiveDate), '2026-10-30');
});
await test('actor re-read inside the transaction: demoted admin, deactivated or revoked collaborator are refused', async () => {
  await managed(); const req = await pending();
  beforeTx = db => { db.staff.get(1).role = 'member'; }; assert.equal((await decideS(req.id, decideBody())).data.error, 'admin_only');
  beforeTx = db => { db.staff.get(4).active = false; }; assert.equal((await withdrawS(req.id, {}, 4)).data.error, 'actor_inactive');
  state.staff.get(4).active = true;
  beforeTx = db => { db.cases.get(L).collaborators = []; }; assert.equal((await withdrawS(req.id, {}, 4)).data.error, 'forbidden');
  assert.equal(row().pendingScheduleRequestId, req.id); assert.equal(reqs()[0].decision, null);
});
await test('managed PATCH: postponing or clearing any parent milestone (incl. printDate) needs approval; earlier/added need reason + versions; no-op writes nothing', async () => {
  await managed(); row().printDate = new Date('2026-10-25');
  const r0 = { reason: '需求方提早上線', ...v() };
  for (const body of [{ goLiveDate: '2026-11-02' }, { dispatchDate: '2026-10-05' }, { copyDate: '2026-10-12' }, { copyDate: null }, { printDate: '2026-10-27' }, { printDate: null }]) {
    const r = await patch({ ...body, ...r0 }); assert.equal(r.status, 409, JSON.stringify(body)); assert.equal(r.data.error, 'schedule_approval_required'); assert(r.data.fields.length === 1);
  }
  const admin = await patch({ goLiveDate: '2026-11-02', ...r0 }, 1); assert.equal(admin.data.error, 'schedule_approval_required', 'admins cannot bypass either');
  assert.equal((await patch({ goLiveDate: '2026-10-28', ...v() })).data.error, 'reason_required');
  assert.equal((await patch({ goLiveDate: '2026-10-28', reason: '看板拖曳', ...v() })).data.error, 'reason_required');
  assert.equal((await patch({ goLiveDate: '2026-10-28', reason: '需求方提早上線' })).data.error, 'client_update_required');
  assert.equal((await patch({ goLiveDate: '2026-10-28', reason: '需求方提早上線', expectedUpdatedAt: v().expectedUpdatedAt, expectedContentVersion: 0 })).data.error, 'edit_conflict');
  assert.equal((await patch({ status: 'review', reason: '看板拖曳', ...v() })).data.error, 'reason_required', 'old Kanban reason refused');
  const cv = row().contentVersion, audits = state.audits.length;
  const ok = await patch({ goLiveDate: '2026-10-28', printDate: '2026-10-20', ...r0 }); assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ymd(row().goLiveDate), '2026-10-28'); assert.equal(ymd(row().printDate), '2026-10-20'); assert.equal(row().contentVersion, cv + 1);
  assert.deepEqual(state.audits.slice(audits).map(a => a.field).sort(), ['goLiveDate', 'printDate']); assert(state.audits.slice(audits).every(a => a.reason === '需求方提早上線'));
  row().copyDate = null; const add = await patch({ copyDate: '2026-10-15', reason: '需求方補提供文案日', ...v() }); assert.equal(add.status, 200, 'filling an empty optional date: reason only');
  const od = await patch({ openDate: '2026-09-30', reason: '建案日資料更正', ...v() }); assert.equal(od.status, 200); assert(state.audits.some(a => a.field === 'openDate' && a.fromValue === '2026-10-01'));
  assert.equal((await patch({ openDate: '2026-09-29' })).data.error, 'client_update_required', 'openDate correction needs versions');
  const st = await patch({ status: 'review', reason: '已交需求單位確認稿件', ...v() }); assert.equal(st.status, 200); assert.equal(row().status, 'review');
  const noopBefore = [row().contentVersion, state.audits.length, row().updatedAt.getTime()];
  const noop = await patch({ goLiveDate: '2026-10-28' }); assert.equal(noop.status, 200);
  assert.deepEqual([row().contentVersion, state.audits.length], noopBefore.slice(0, 2), 'true no-op: no version step, no audit');
  assert.equal((await patch({ title: '只改標題' })).status, 200, 'non-schedule edits keep the legacy contract');
  process.env.SCHEDULE_WORKFLOW_ENABLED = '0';
  assert.equal((await patch({ goLiveDate: '2026-12-01', ...r0, ...v() })).data.error, 'schedule_approval_required', 'paused flag is not a bypass');
});
await test('post-auth demotion: an admin-collaborator demoted after the outer checks cannot reassign or close a managed case', async () => {
  await managed(); row().collaborators = [{ id: 4 }, { id: 6 }]; row().archivePath = '/shared/' + L;
  const snap = () => JSON.stringify([row().designerId, row().collaborators.map(c => c.id), row().status, row().contentVersion, state.audits.length]);
  for (const [body, code] of [
    [{ designerId: 4, reason: '改由協作者主責', ...v() }, 'assignment_primary_only'],
    [{ collaboratorIds: [6], reason: '調整協作名單以便交接', designerId: 2, status: 'review', ...v() }, 'assignment_primary_only'],
    [{ status: 'closed', reason: '主管確認可以結案', ...v() }, 'closed_admin_only'],
  ]) {
    const before = snap(); state.staff.get(6).role = 'admin';
    beforeTx = db => { db.staff.get(6).role = 'member'; };   // demoted after auth + caseEditPermission, before the tx re-read
    const r = await patch(body, 6); beforeTx = null;
    assert.equal(r.status, 403, JSON.stringify(body) + ' ' + JSON.stringify(r.data)); assert.equal(r.data.error, code);
    assert.equal(snap(), before, 'nothing written');
  }
  state.staff.get(6).role = 'admin';
  const ok = await patch({ status: 'closed', reason: '主管確認可以結案', ...v() }, 6); assert.equal(ok.status, 200, 'a current admin may still close: ' + JSON.stringify(ok.data));
});
// Acceptance round 2: a collaborator-only PATCH is an assignment edit on managed cases.
await test('round 2: collaborator-only PATCH on a managed case — post-auth demotion, collaborator, missing/stale versions and placeholders are refused unchanged', async () => {
  await managed(); row().collaborators = [{ id: 4 }, { id: 6 }];
  const snap = () => JSON.stringify([row().collaborators.map(c => c.id).sort(), row().contentVersion, row().updatedAt.getTime(), state.audits.length]);
  const before = snap();
  beforeTx = db => { db.staff.get(6).role = 'member'; };   // admin-collaborator demoted after auth + initial read
  let r = await patch({ collaboratorIds: [3], reason: '調整協作名單以便交接', ...v() }, 6); beforeTx = null;
  assert.equal(r.status, 403, JSON.stringify(r.data)); assert.equal(r.data.error, 'assignment_primary_only'); assert.equal(snap(), before);
  state.staff.get(6).role = 'admin';
  r = await patch({ collaboratorIds: [3], reason: '調整協作名單以便交接', ...v() }, 4); assert.equal(r.status, 403); assert.equal(r.data.error, 'assignment_primary_only', 'a current collaborator cannot change assignment');
  for (const [body, code] of [[{ collaboratorIds: [3], reason: '調整協作名單以便交接' }, 'client_update_required'],
    [{ collaboratorIds: [3], reason: '調整協作名單以便交接', expectedUpdatedAt: v().expectedUpdatedAt, expectedContentVersion: 0 }, 'edit_conflict'],
    [{ collaboratorIds: [3], reason: '—', ...v() }, 'reason_required'], [{ collaboratorIds: [3], ...v() }, 'reason_required']]) {
    r = await patch(body, 2); assert.equal(r.data.error, code, JSON.stringify(body));
  }
  assert.equal(snap(), before, 'nothing written by any refused request');
});
await test('round 2: permitted collaborator change is one atomic version + audit; same set (reordered/duplicate/incl. primary) is a true no-op; audit failure rolls back', async () => {
  await managed(); row().collaborators = [{ id: 4 }, { id: 6 }];
  for (const ids of [[6, 4], [4, 6, 6], [4, 2, 6]]) {
    const before = [row().contentVersion, row().updatedAt.getTime(), state.audits.length];
    const r = await patch({ collaboratorIds: ids }, 2); assert.equal(r.status, 200, JSON.stringify(ids));
    assert.deepEqual([row().contentVersion, row().updatedAt.getTime(), state.audits.length], before, 'same set ' + JSON.stringify(ids) + ' writes nothing');
  }
  const cv = row().contentVersion, audits = state.audits.length;
  fault = 'audit'; assert.equal((await patch({ collaboratorIds: [3], reason: '調整協作名單以便交接', ...v() }, 2)).status, 500); fault = '';
  assert.deepEqual(row().collaborators.map(c => c.id).sort(), [4, 6]); assert.equal(row().contentVersion, cv); assert.equal(state.audits.length, audits);
  const ok = await patch({ collaboratorIds: [3], reason: '調整協作名單以便交接', ...v() }, 2); assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(row().collaborators.map(c => c.id), [3]); assert.equal(row().contentVersion, cv + 1);
  const added = state.audits.slice(audits); assert.equal(added.length, 1); assert.deepEqual([added[0].field, added[0].fromValue, added[0].toValue, added[0].reason], ['collaborators', '4,6', '3', '調整協作名單以便交接']);
  const admin = await patch({ collaboratorIds: [4], reason: '主管調整協作人員', ...v() }, 1); assert.equal(admin.status, 200); assert.deepEqual(row().collaborators.map(c => c.id), [4]);
});
await test('round 2: a stale same-set payload cannot overwrite a concurrent collaborator change', async () => {
  await managed();
  const pause = pauseNextPatchRead(); const stale = patch({ title: '只改標題', collaboratorIds: [4] }, 2); await pause.readDone;
  assert.equal((await patch({ collaboratorIds: [3], reason: '改由其他設計師協作', ...v() }, 2)).status, 200);
  pause.release(); const r = await stale;
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(row().title, '只改標題'); assert.deepEqual(row().collaborators.map(c => c.id), [3], 'concurrent assignment survives');
});
await test('legacy cases keep the original PATCH contract; a legacy read racing adoption cannot slip a date through', async () => {
  const r = await patch({ goLiveDate: '2026-12-01' }); assert.equal(r.status, 200); assert.equal(ymd(row().goLiveDate), '2026-12-01');
  assert(state.audits.some(a => a.field === 'goLiveDate' && a.reason === '—'), 'legacy reason stays optional');
  const pause = pauseNextPatchRead(); const late = patch({ goLiveDate: '2026-12-20' }); await pause.readDone;
  await managed(); pause.release(); const lr = await late;
  assert.equal(lr.status, 409, JSON.stringify(lr.data)); assert.equal(ymd(row().goLiveDate), '2026-12-01');
});
await test('early review 1: an apparently unchanged full date payload cannot overwrite a concurrent approval', async () => {
  await managed(); const req = await pending();
  const full = { title: '只改標題', dispatchDate: '2026-10-02', copyDate: '2026-10-10', printDate: null, goLiveDate: '2026-10-30', level: 'A', urgent: false };
  const pause = pauseNextPatchRead(); const p = patch(full); await pause.readDone;
  assert.equal((await decideS(req.id, decideBody())).status, 200); assert.equal(ymd(row().goLiveDate), '2026-11-06');
  const audits = state.audits.length; pause.release(); const r = await p;
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(row().title, '只改標題');
  assert.equal(ymd(row().goLiveDate), '2026-11-06', 'approved date survives the stale full payload'); assert.equal(state.audits.length, audits, 'no fake audit');
  const before = [row().contentVersion, row().updatedAt.getTime()];
  const noop = await patch({ dispatchDate: '2026-10-02', goLiveDate: '2026-11-06', printDate: null });
  assert.equal(noop.status, 200); assert.deepEqual([row().contentVersion, row().updatedAt.getTime()], before, 'true no-op writes nothing at all');
});
await test('early review 3: managed PATCH rejects non-calendar raw dates for all four milestones and openDate before coercion', async () => {
  await managed();
  for (const f of ['dispatchDate', 'copyDate', 'printDate', 'goLiveDate', 'openDate']) {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-10-1', 'tomorrow']) {
      const r = await patch({ [f]: bad, reason: '需求方提早上線', ...v() }); assert.equal(r.status, 400, f + ' ' + bad); assert.equal(r.data.error, /^\d{4}-\d{2}-\d{2}$/.test(bad) ? 'invalid_date' : 'invalid_body', f + ' ' + bad);
    }
  }
  assert.deepEqual(sched(), { dispatchDate: '2026-10-02', copyDate: '2026-10-10', printDate: null, goLiveDate: '2026-10-30' });
  for (const f of ['dispatchDate', 'goLiveDate']) assert.equal((await patch({ [f]: null, reason: '需求方提早上線', ...v() })).status, 400, f + ' is required');
  assert.equal((await patch({ copyDate: null, reason: '不需要文案日', ...v() })).data.error, 'schedule_approval_required', 'optional null = clearing → approval');
  assert.equal((await patch({ goLiveDate: '2026-10-28', reason: '需求方提早上線', ...v() })).status, 200, 'a genuine earlier date still works');
});
await test('managed PATCH racing a proposal loses (snapshot claim), dates and audit unchanged', async () => {
  await managed();
  const pause = pauseNextPatchRead(); const p = patch({ goLiveDate: '2026-10-28', reason: '需求方提早上線', ...v() }); await pause.readDone;
  await pending(); const audits = state.audits.length; pause.release(); const r = await p;
  assert.equal(r.status, 409); assert.equal(ymd(row().goLiveDate), '2026-10-30'); assert.equal(state.audits.length, audits);
  assert.equal((await patch({ goLiveDate: '2026-10-28', reason: '需求方提早上線', ...v() })).data.error, 'schedule_request_pending', 'milestones locked while a request is pending');
});
await test('delivery workflow: a pending schedule request blocks delivery submission (records) and legacy review_done; delivery review blocks new requests', async () => {
  await managed(R);
  const d = await call(R + '/deliveries', 'POST', { id: nid('dlv'), itemName: '主視覺 KV', kind: 'main', quantity: 1, unit: '件', deliveredOn: '2026-10-21', ...v(R) }, 2); assert.equal(d.status, 201);
  const req = await pending(proposeBody({}, R), 2, R);
  const s = await call(R + '/delivery-submissions', 'POST', { id: nid('sub'), completenessConfirmed: true, ...v(R) }, 2); assert.equal(s.data.error, 'schedule_request_pending');
  assert.equal(row(R).status, 'doing'); assert.equal(state.submissions.size, 0);
  assert.equal((await withdrawS(req.id, {}, 2, R)).status, 200);
  const s2 = await call(R + '/delivery-submissions', 'POST', { id: nid('sub'), completenessConfirmed: true, ...v(R) }, 2); assert.equal(s2.status, 201);
  assert.equal((await propose(proposeBody({}, R), 2, R)).data.error, 'delivery_pending_review');
  await managed(L); await pending();
  assert.equal((await patch({ status: 'review_done', archivePath: '/x', reason: '設計完成送主管核可', ...v() })).data.error, 'schedule_request_pending');
});
await test('cancel invalidates the pending request atomically (current actor); a failed cancel rolls both back; archive is blocked until handled', async () => {
  await managed(); let req = await pending();
  assert.equal((await call(L + '/archive', 'POST', {}, 1)).data.error, 'schedule_request_pending'); assert.equal(row().archived, false);
  fault = 'audit'; const failed = await call(L + '/cancel', 'POST', { reason: '需求方取消' }, 2); fault = '';
  assert.equal(failed.status, 500); assert.equal(row().status, 'doing'); assert.equal(reqs()[0].decision, null); assert.equal(row().pendingScheduleRequestId, req.id);
  const c = await call(L + '/cancel', 'POST', { reason: '需求方取消' }, 2); assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(row().status, 'cancelled'); assert.equal(row().pendingScheduleRequestId, null); assert.equal(ymd(row().goLiveDate), '2026-10-30');
  const stamped = reqs()[0]; assert.equal(stamped.decision, 'invalidated'); assert.equal(stamped.decidedById, 2); assert.match(stamped.decisionReason, /專案取消/);
  assert.equal((await decideS(req.id, decideBody())).data.error, 'schedule_request_closed', 'cannot approve after cancellation');
  assert.equal((await propose(proposeBody())).data.error, 'case_locked');
  reset(); await managed(); req = await pending(); await decideS(req.id, decideBody({ decision: 'reject', reason: '日期無法配合印刷' }));
  assert.equal((await call(L + '/archive', 'POST', {}, 1)).status, 200);
});
await test('forced audit / commit failures roll the decision, dates, pointer and version back together', async () => {
  await managed(); const req = await pending(); const snap = JSON.stringify([sched(), row().contentVersion, row().pendingScheduleRequestId, state.audits.length]);
  fault = 'audit'; assert.equal((await decideS(req.id, decideBody())).status, 500); fault = '';
  fault = 'commit'; assert.equal((await decideS(req.id, decideBody())).status, 409); fault = '';
  assert.equal(JSON.stringify([sched(), row().contentVersion, row().pendingScheduleRequestId, state.audits.length]), snap); assert.equal(reqs()[0].decision, null);
  assert.equal((await decideS(req.id, decideBody({ decision: 'reject', reason: '日期無法配合印刷' }))).status, 200);
  const cv = row().contentVersion;
  fault = 'audit'; assert.equal((await propose(proposeBody())).status, 500); fault = '';
  assert.equal(reqs().length, 1, 'no request row survives a failed audit'); assert.equal(row().pendingScheduleRequestId, null); assert.equal(row().contentVersion, cv);
});
await test('flag off: history readable (paused), new adopt/request/approve blocked, reject/withdraw allowed; legacy without history stays hidden', async () => {
  await managed(); const a = await pending(); process.env.SCHEDULE_WORKFLOW_ENABLED = '0';
  const list = await call(L + '/schedule-requests'); assert.equal(list.status, 200); assert.equal(list.data.workflow.paused, true);
  assert.equal((await call(R + '/schedule-requests')).status, 404, 'legacy without history hidden');
  assert.equal((await adopt(R)).status, 404);
  assert.equal((await decideS(a.id, decideBody())).data.error, 'schedule_workflow_paused');
  assert.equal((await decideS(a.id, decideBody({ decision: 'reject', reason: '暫停期間先退回' }))).status, 200);
  process.env.SCHEDULE_WORKFLOW_ENABLED = '1'; const b = await pending(); process.env.SCHEDULE_WORKFLOW_ENABLED = '0';
  assert.equal((await propose(proposeBody())).data.error, 'schedule_workflow_paused');
  assert.equal((await withdrawS(b.id)).status, 200);
  assert.equal((await propose(proposeBody())).data.error, 'schedule_workflow_paused');
  assert.equal(row().scheduleMode, 'managed', 'never downgraded');
});
await test('delete is blocked by schedule history; list/get expose _count.scheduleRequests; clone and CSV stay legacy', async () => {
  await managed(); await pending(); row().status = 'todo';
  const del = await call(L, 'DELETE', undefined, 1); assert.equal(del.status, 409); assert.equal(del.data.error, 'case_has_schedule_requests'); assert(row());
  const one = await call(L, 'GET', undefined, 1); assert.equal(one.data._count.scheduleRequests, 1); assert.equal(one.data.scheduleMode, 'managed');
  const cl = await call(L + '/clone', 'POST', { reasonForReopen: '同案延伸' }, 1); assert.equal(cl.status, 201, JSON.stringify(cl.data));
  assert.equal(state.cases.get(cl.data.id).scheduleMode ?? 'legacy', 'legacy'); assert.equal(state.cases.get(cl.data.id).pendingScheduleRequestId ?? null, null);
});
console.log(JSON.stringify({ passed, liveDatabase: false, emailsSent: 0, flags: ['SCHEDULE_WORKFLOW_ENABLED'] }));
