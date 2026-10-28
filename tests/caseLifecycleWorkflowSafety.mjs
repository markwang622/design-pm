// REPORTS-P2-D1b: actual Express case + lifecycle (cycle / seal / resume) routes against an isolated,
// rollback-capable Prisma double (serialized like Serializable). Harness forked from
// tests/caseScheduleWorkflowSafety.mjs and extended with case_cycles, case_lifecycle_requests and the 0006 delivery
// attribution rule. No listener, real database, SMTP or production data.
// Real PostgreSQL constraints, triggers and overlapping transactions: tests/postgresMaintenance.mjs.
import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex } from 'node:stream';
import { createRequire } from 'node:module';
const root = process.env.DESIGN_PM_ROOT || new URL('../', import.meta.url).pathname;
const require = createRequire(root + '/package.json');
const express = require('express'), cookieParser = require('cookie-parser');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'isolated-lifecycle-workflow-tests-secret';
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
    lifecycleMode: 'legacy', lifecycleModeSince: null, lifecycleModeById: null, lifecycleModeByName: null, lifecycleModeReason: null, lifecycleModeRequestId: null,
    lifecycleModeFingerprint: null, lifecycleStatus: null, currentCycleId: null, pendingLifecycleRequestId: null,
    items: [{ key: 'item-key-main-0001', n: '主視覺 KV', status: 'doing' }], logs: [], contentVersion: 3, updatedAt: new Date('2026-10-20T01:00:00.000Z'),
    deliveryMode: 'legacy', deliveryModeSince: null, deliveryModeById: null, deliveryModeByName: null, deliveryModeReason: null,
    deliveryModeRequestId: null, deliveryModeFingerprint: null, pendingDeliverySubmissionId: null, ...extra };
}
const recordsStamp = { deliveryMode: 'records', deliveryModeSince: new Date('2026-10-19T00:00:00Z'), deliveryModeById: 1, deliveryModeByName: 'Admin', deliveryModeReason: '測試案件' };
function reset() {
  state = { staff: new Map(clone([...people])), cases: new Map([[R, freshCase(R, recordsStamp)], [L, freshCase(L)]]), deliveries: new Map(), submissions: new Map(), schedules: new Map(), cycles: new Map(), lifecycle: new Map(), audits: [], notifications: [], transfers: [] };
  queue = Promise.resolve(); fault = ''; beforeTx = null; trace = { transactions: 0 };
  process.env.DELIVERY_RECORDS_ENABLED = '1'; process.env.DELIVERY_WORKFLOW_ENABLED = '1'; process.env.SCHEDULE_WORKFLOW_ENABLED = '1'; process.env.LIFECYCLE_WORKFLOW_ENABLED = '1';
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
    scheduleRequests: [...db.schedules.values()].filter(s => s.caseId === row.id).length,
    cycles: [...db.cycles.values()].filter(s => s.caseId === row.id).length, lifecycleRequests: [...db.lifecycle.values()].filter(s => s.caseId === row.id).length };
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
  // Mirrors 0006: lifecycle pointers only on managed cases; at most one pending pointer.
  if ((row.pendingLifecycleRequestId || row.currentCycleId || row.lifecycleStatus) && row.lifecycleMode !== 'managed') throw Object.assign(Error('check cases_lifecycle_mode_stamp'), { code: 'P2004' });
  if ([row.pendingDeliverySubmissionId, row.pendingScheduleRequestId, row.pendingLifecycleRequestId].filter(Boolean).length > 1) throw Object.assign(Error('check cases_single_pending'), { code: 'P2004' });
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
      create: async ({ data }) => {
        if (db.deliveries.has(data.id)) throw p2002();
        const c = db.cases.get(data.caseId); const cyc = data.cycleId ? db.cycles.get(data.cycleId) : null;   // 0006 attribution trigger
        if (c.lifecycleMode === 'managed' ? (data.cycleId !== c.currentCycleId || c.lifecycleStatus !== 'active' || c.pendingLifecycleRequestId || !cyc || cyc.endedAt) : data.cycleId != null) throw Object.assign(Error('delivery cycle attribution'), { code: 'P2004' });
        const row = { cycleId: null, ...clone(data), createdAt: new Date(), voidedAt: null, voidedById: null, voidedByName: null, voidReason: null, voidRequestId: null }; db.deliveries.set(row.id, row); return clone(row);
      },
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
    caseCycle: {
      findUnique: async ({ where }) => clone(db.cycles.get(where.id) ?? null),
      findMany: async ({ where } = {}) => [...db.cycles.values()].filter(c => matches(c, where)).sort((a, b) => a.sequence - b.sequence).map(clone),
      count: async ({ where }) => [...db.cycles.values()].filter(c => matches(c, where)).length,
      create: async ({ data }) => {
        if ([...db.cycles.values()].some(c => c.caseId === data.caseId && (c.sequence === data.sequence || !c.endedAt))) throw p2002();   // seq unique + one open
        const row = { startedAt: new Date(), endedAt: null, outcome: null, endedById: null, endedByName: null, endReason: null, endRequestId: null, endSnapshot: null, ...clone(data) };
        db.cycles.set(row.id, row); return clone(row);
      },
      updateMany: async ({ where, data }) => {
        const rows = [...db.cycles.values()].filter(c => matches(c, where));
        for (const r of rows) { assert.equal(r.endedAt, null, 'cycle ends once (0006 trigger)'); Object.assign(r, clone(data)); }
        return { count: rows.length };
      },
    },
    lifecycleRequest: {
      findUnique: async ({ where }) => clone(where.id ? db.lifecycle.get(where.id) ?? null : [...db.lifecycle.values()].find(s => s.decisionOperationId && s.decisionOperationId === where.decisionOperationId) ?? null),
      findMany: async ({ where } = {}) => [...db.lifecycle.values()].filter(s => matches(s, where)).sort((a, b) => b.createdAt - a.createdAt).map(clone),
      count: async ({ where }) => [...db.lifecycle.values()].filter(s => matches(s, where)).length,
      create: async ({ data }) => {
        if (db.lifecycle.has(data.id) || [...db.lifecycle.values()].some(r => r.caseId === data.caseId && !r.decision)) throw p2002();   // id + one pending
        const row = { ...clone(data), createdAt: new Date(Date.now() + db.lifecycle.size), decision: null, decidedAt: null, decidedById: null, decidedByName: null, decisionReason: null, decisionOperationId: null, decisionFingerprint: null, resultCycleId: null };
        db.lifecycle.set(row.id, row); return clone(row);
      },
      updateMany: async ({ where, data }) => {
        if (data.decisionOperationId && [...db.lifecycle.values()].some(s => s.decisionOperationId === data.decisionOperationId)) throw p2002();
        const rows = [...db.lifecycle.values()].filter(s => matches(s, where));
        for (const r of rows) { assert.equal(r.decidedAt, null, 'decision stamped once'); Object.assign(r, clone(data)); }
        return { count: rows.length };
      },
    },
    changeLog: { createMany: async ({ data }) => { if (fault === 'audit' && inTx) throw Error('Synthetic audit failure'); db.audits.push(...clone(data)); return { count: data.length }; } },
    transferLog: { create: async ({ data }) => { db.transfers.push(clone(data)); return clone(data); } },
    notification: { findFirst: async () => null, updateMany: async () => ({ count: 0 }), create: async ({ data }) => { assert.equal(inTx, false, 'notifications only after commit'); state.notifications.push(clone(data)); return clone(data); }, createMany: async ({ data }) => { state.notifications.push(...clone(data)); return { count: data.length }; } },
  };
}
reset();
for (const model of ['case', 'staff', 'changeLog', 'notification', 'deliveryRecord', 'deliverySubmission', 'scheduleRequest', 'caseCycle', 'lifecycleRequest', 'transferLog']) {
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
    const isolated = { ...state, staff: new Map(clone([...state.staff])), cases: new Map(clone([...state.cases])), deliveries: new Map(clone([...state.deliveries])), submissions: new Map(clone([...state.submissions])), schedules: new Map(clone([...state.schedules])), cycles: new Map(clone([...state.cycles])), lifecycle: new Map(clone([...state.lifecycle])), audits: clone(state.audits) };
    const value = await run(client(isolated, true));
    if (fault === 'commit') throw Object.assign(Error('Synthetic serialization failure'), { code: 'P2034' });
    state = { ...isolated, notifications: state.notifications, transfers: state.transfers }; return value;
  });
  queue = result.catch(() => {}); return result;
};
const app = express(); app.use(cookieParser()); app.use('/api/cases', (await import(root + '/src/routes/cases.js')).default);
app.use((e, _req, res, _next) => { if (process.env.DEBUG_500) console.error('500:', e); res.status(500).json({ error: 'server_error' }); });
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

const cyc = (id = L) => row(id).currentCycleId;
const vc = (id = L) => ({ ...v(id), expectedCycleId: cyc(id) });
const cycles = (id = L) => [...state.cycles.values()].filter(c => c.caseId === id).sort((a, b) => a.sequence - b.sequence);
const lreqs = (id = L) => [...state.lifecycle.values()].filter(r => r.caseId === id);
const adoptL = (id = L, extra = {}, as = 1) => call(id + '/lifecycle/adopt', 'POST', { requestId: nid('lcadopt'), reason: '試行生命週期管理', ...v(id), ...extra }, as);
const managedL = async (id = L) => { const r = await adoptL(id); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.cycleId; };
const sealBody = (extra = {}, id = L) => ({ id: nid('seal'), kind: 'seal', reasonCategory: 'requester_change', reason: '需求方暫停活動，先行封存', evidence: { type: 'archive', archivePath: row(id).archivePath }, ...vc(id), ...extra });
const resumeBody = (extra = {}, id = L) => ({ id: nid('resume'), kind: 'resume', reasonCategory: 'requester_change', reason: '需求方確認活動恢復', ...vc(id), ...extra });
const lreq = (body, as = 2, id = L) => call(id + '/lifecycle/requests', 'POST', body, as);
const decideL = (rid, extra = {}, as = 1, id = L) => call(`${id}/lifecycle/requests/${rid}/decide`, 'POST', { operationId: nid('op'), decision: 'approve', ...vc(id), ...extra }, as);
const withdrawL = (rid, extra = {}, as = 2, id = L) => call(`${id}/lifecycle/requests/${rid}/withdraw`, 'POST', { operationId: nid('wd'), reason: '先完成剩餘交付再說', ...vc(id), ...extra }, as);
const deliverL = (extra = {}, id = L, as = 2) => call(id + '/deliveries', 'POST', { id: nid('dlv'), itemName: '主視覺 KV', kind: 'main', quantity: 1, unit: '件', deliveredOn: '2026-10-21', ...vc(id), ...extra }, as);
const pendingL = async (body = sealBody(), as = 2, id = L) => { const r = await lreq(body, as, id); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.request; };
const sealed = async (id = L) => { const q = await pendingL(sealBody({}, id), 2, id); const d = await decideL(q.id, {}, 1, id); assert.equal(d.status, 200, JSON.stringify(d.data)); return q; };
const legacyDelivery = (id, extra = {}) => { const rec = { id, caseId: L, itemKey: null, itemName: '舊版主視覺', kind: 'main', quantity: 2, unit: '件', deliveredOn: new Date('2026-10-05'), note: null,
  recordedById: 2, recordedByName: 'Owner', requestFingerprint: 'f'.repeat(64), createdAt: new Date('2026-10-05'), voidedAt: null, voidedById: null, voidedByName: null, voidReason: null, voidRequestId: null, cycleId: null, ...extra }; state.deliveries.set(id, rec); return rec; };

let passed = 0;
async function test(name, fn) { reset(); await fn(); passed++; console.log('PASS ' + name); }

await test('adoption: admin-only, versions, no browser cycle; cycle 1 observed at adoption with carried-forward unknown-attribution deliveries; replay; one-way', async () => {
  legacyDelivery('dlv-legacy-0001');
  assert.equal((await adoptL(L, {}, 2)).data.error, 'admin_only'); assert.equal((await adoptL(L, { reason: '看板拖曳' })).status, 400);
  assert.equal((await adoptL(L, { expectedContentVersion: undefined })).data.error, 'client_update_required');
  assert.equal((await adoptL(L, { expectedCycleId: 'cycle-not-yet-0001' })).data.error, 'cycle_conflict');
  const body = { requestId: nid('lcadopt'), reason: '試行生命週期管理', ...v() };
  const r = await call(L + '/lifecycle/adopt', 'POST', body, 1); assert.equal(r.status, 201, JSON.stringify(r.data));
  const c1 = cycles()[0]; assert.equal(cycles().length, 1); assert.equal(c1.sequence, 1); assert.equal(c1.source, 'adoption'); assert.equal(row().currentCycleId, c1.id);
  assert.equal(c1.startSnapshot.source, 'observed_at_adoption'); assert.equal(c1.startSnapshot.attribution, 'legacy_unknown'); assert.deepEqual(c1.startSnapshot.carryForwardDeliveryIds, ['dlv-legacy-0001']);
  assert.deepEqual(c1.startSnapshot.legacyCounts, { requestCount: null, outputCount: null }, 'unknown stays unknown');
  assert.equal(row().lifecycleMode, 'managed'); assert.equal(row().lifecycleStatus, 'active'); assert.equal(row().deliveryMode, 'legacy'); assert.equal(row().scheduleMode, 'legacy', 'independent modes');
  assert.equal(state.deliveries.get('dlv-legacy-0001').cycleId, null, 'existing evidence is not re-linked');
  const replay = await call(L + '/lifecycle/adopt', 'POST', body, 1); assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true); assert.equal(cycles().length, 1);
  assert.equal((await call(L + '/lifecycle/adopt', 'POST', { ...body, reason: '另一個導入原因' }, 1)).data.error, 'lifecycle_request_conflict');
  assert.equal((await adoptL()).data.error, 'already_managed');
  Object.assign(row(R), { status: 'review_done' }); assert.equal((await adoptL(R)).data.error, 'lifecycle_adoption_not_allowed');
  process.env.LIFECYCLE_WORKFLOW_ENABLED = '0'; assert.equal((await adoptL(R)).status, 404);
});
await test('seal request: reason category + reason + archive-or-no-file evidence, browser cycle, assignment; nothing takes effect; exact replay vs changed intent; one pending', async () => {
  await managedL(); const before = JSON.stringify([row().status, row().archived, row().lifecycleStatus, cycles()[0].endedAt]);
  for (const [extra, code] of [[{ evidence: undefined }, 400], [{ evidence: { type: 'no_file', reason: '—' } }, 400], [{ reasonCategory: undefined }, 400], [{ reasonCategory: 'blame' }, 400],
    [{ reason: '看板拖曳' }, 400], [{ expectedCycleId: undefined }, 409], [{ expectedCycleId: 'cycle-wrong-000001' }, 409], [{ expectedContentVersion: 0 }, 409],
    [{ evidence: { type: 'archive', archivePath: '/elsewhere' } }, 409]]) {
    const r = await lreq(sealBody(extra)); assert.equal(r.status, code, JSON.stringify(extra) + ' ' + JSON.stringify(r.data));
  }
  assert.equal((await lreq(sealBody(), 3)).data.error, 'forbidden'); assert.equal((await lreq(sealBody(), 5)).data.error, 'read_only');
  const body = sealBody({ evidence: { type: 'no_file', reason: '僅完成討論稿，尚未產出檔案' }, reasonCategory: 'external_vendor' });
  const r = await lreq(body, 4); assert.equal(r.status, 201, 'collaborator may request');
  assert.deepEqual(r.data.request.evidence, { type: 'no_file', reason: '僅完成討論稿，尚未產出檔案' }); assert.equal(r.data.request.reasonCategory, 'external_vendor');
  assert.equal(JSON.stringify([row().status, row().archived, row().lifecycleStatus, cycles()[0].endedAt]), before, 'request does not seal anything');
  assert.equal(row().pendingLifecycleRequestId, body.id);
  assert.equal((await lreq(body, 4)).data.replayed, true); assert.equal((await lreq({ ...body, reasonCategory: 'other' }, 4)).data.error, 'lifecycle_request_conflict');
  assert.equal((await lreq(sealBody())).data.error, 'lifecycle_request_pending');
});
await test('seal approval ends the cycle sealed_incomplete with end evidence; not completed, not cancelled; outputs, status and dates kept; two managers → one wins', async () => {
  await managedL(); legacyDelivery('dlv-legacy-0002'); const d = await deliverL(); assert.equal(d.status, 201); assert.equal(d.data.record.cycleId, cyc());
  const q = await pendingL(); const base = vc();
  const res = await Promise.all([call(`${L}/lifecycle/requests/${q.id}/decide`, 'POST', { operationId: nid('op'), decision: 'approve', ...base }, 1),
    call(`${L}/lifecycle/requests/${q.id}/decide`, 'POST', { operationId: nid('op'), decision: 'reject', reason: '請先完成延伸尺寸', ...base }, 6)]);
  assert.deepEqual(res.map(x => x.status).sort(), [200, 409]);
  if (lreqs()[0].decision === 'rejected') { assert.equal(row().lifecycleStatus, 'active'); return; }
  const c1 = cycles()[0]; assert.equal(c1.outcome, 'sealed_incomplete'); assert.equal(c1.endRequestId, q.id); assert(c1.endedAt);
  assert.deepEqual(c1.endSnapshot.activeDeliveryIds.sort(), ['dlv-legacy-0002', d.data.record.id].sort()); assert.deepEqual(c1.endSnapshot.cycleDeliveryIds, [d.data.record.id]);
  assert.equal(c1.endSnapshot.archivePath, row().archivePath); assert.equal(c1.endSnapshot.noFile, null);
  assert.equal(row().lifecycleStatus, 'sealed_incomplete'); assert.equal(row().archived, true); assert.equal(row().status, 'doing', 'not done/closed/cancelled'); assert.equal(row().closedOn, null);
  assert.equal(ymd(row().goLiveDate), '2026-10-30'); assert.equal(state.deliveries.size, 2, 'outputs kept');
  const list = await call(L + '/lifecycle', 'GET', undefined, 5); assert.equal(list.status, 200); assert.equal(list.data.lifecycleStatus, 'sealed_incomplete'); assert.equal(list.data.cycles[0].open, false);
});
await test('sealed cases are read-only through every existing writer; resume must go through a request', async () => {
  await managedL(); await sealed(); const snap = JSON.stringify([...state.cases.get(L) && [row().title, row().status, row().archived, row().logs, row().items, row().contentVersion], state.deliveries.size]);
  const writes = [
    [() => call(L, 'PATCH', { title: '封存後改標題', ...vc() }, 2), 'lifecycle_sealed'], [() => call(L, 'PATCH', { status: 'review', reason: '想直接改狀態繞過復工', ...vc() }, 1), 'lifecycle_sealed'],
    [() => call(L + '/items', 'PATCH', { items: [], ...vc() }, 2), 'lifecycle_sealed'], [() => call(L + '/logs', 'POST', { entry: { id: nid('log'), note: '封存後補日誌' }, expectedCycleId: cyc() }, 2), 'lifecycle_sealed'],
    [() => deliverL(), null], [() => call(L + '/cancel', 'POST', { reason: '需求方取消', ...vc() }, 2), 'lifecycle_sealed'], [() => call(L + '/uncancel', 'POST', {}, 1), null],
    [() => call(L + '/transfer', 'POST', { toDesignerId: 6, reason: '主管派發', ...vc() }, 1), 'lifecycle_sealed'], [() => call(L + '/archive', 'POST', {}, 1), 'lifecycle_sealed'],
    [() => call(L + '/clone', 'POST', { reasonForReopen: '想開新案' }, 1), 'lifecycle_resume_required'],
  ];
  for (const [i, [fn, code]] of writes.entries()) { const r = await fn(); assert(r.status >= 400, 'write #' + i + ' ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 80)); if (code) assert.equal(r.data.error, code, 'write #' + i); }
  assert.equal(JSON.stringify([row().title, row().status, row().archived, row().logs, row().items, row().contentVersion].length && [...state.cases.get(L) && [row().title, row().status, row().archived, row().logs, row().items, row().contentVersion], state.deliveries.size]), snap, 'nothing written');
  assert.equal((await lreq(sealBody())).data.error, 'lifecycle_seal_not_allowed');
});
await test('resume: designer request → manager approval creates ONE successor cycle on the same case id; dates unchanged; old cycle immutable; new outputs attributed to the new cycle only', async () => {
  await managedL(); legacyDelivery('dlv-legacy-0003'); const d1 = (await deliverL()).data.record; await sealed();
  assert.equal((await lreq(resumeBody({ evidence: { type: 'no_file', reason: '不該帶證據' } }))).status, 400);
  const q = await pendingL(resumeBody(), 4);
  assert.equal(row().lifecycleStatus, 'sealed_incomplete', 'request alone does not resume');
  const body = { operationId: nid('op'), decision: 'approve', ...vc() };
  const ok = await call(`${L}/lifecycle/requests/${q.id}/decide`, 'POST', body, 1); assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const [c1, c2] = cycles(); assert.equal(cycles().length, 2); assert.equal(c2.sequence, 2); assert.equal(c2.source, 'resume'); assert.equal(c2.startRequestId, q.id);
  assert.equal(c2.startSnapshot.resumedFromCycleId, c1.id); assert.deepEqual(c2.startSnapshot.carryForwardDeliveryIds.sort(), ['dlv-legacy-0003', d1.id].sort());
  assert.equal(row().currentCycleId, c2.id); assert.equal(row().lifecycleStatus, 'active'); assert.equal(row().status, 'doing'); assert.equal(row().archived, false); assert.equal(row().id, L);
  assert.equal(ymd(row().goLiveDate), '2026-10-30', 'official dates unchanged'); assert.equal(c1.outcome, 'sealed_incomplete');
  assert.equal(lreqs().find(r => r.id === q.id).resultCycleId, c2.id);
  const replay = await call(`${L}/lifecycle/requests/${q.id}/decide`, 'POST', body, 1); assert.equal(replay.data.replayed, true); assert.equal(cycles().length, 2, 'replay creates no second cycle');
  const d2 = (await deliverL({ kind: 'extension', quantity: 3, itemName: 'FB 延伸' })).data.record; assert.equal(d2.cycleId, c2.id);
  assert.equal(state.deliveries.get(d1.id).cycleId, c1.id, 'earlier output stays in its cycle');
  for (const rid of [d1.id, 'dlv-legacy-0003']) {
    const r = await call(`${L}/deliveries/${rid}/void`, 'POST', { requestId: nid('void'), reason: '想作廢舊交付', ...vc() }, 2); assert.equal(r.data.error, 'delivery_previous_cycle', rid);
  }
  const list = await call(L + '/lifecycle', 'GET', undefined, 2); const out = list.data.outputs;
  assert.equal(out.currentCycle.cycleId, c2.id); assert.equal(out.currentCycle.status, 'recorded'); assert.deepEqual(out.currentCycle.summary.groups.map(g => [g.kind, g.quantity]), [['extension', 3]]);
  assert.deepEqual(out.cumulative.groups.map(g => [g.kind, g.quantity]), [['main', 3], ['extension', 3]], 'each delivery id counted once (2 legacy + 1 + 3)');
  assert.deepEqual(out.legacyCounts, { requestCount: null, outputCount: null }, 'legacy counts reported separately, never added');
});
await test('cycle 1 with pre-adoption records reports partially_unknown; cycle-1 correction of an unattributed record is allowed', async () => {
  legacyDelivery('dlv-legacy-0004'); await managedL();
  let list = await call(L + '/lifecycle', 'GET', undefined, 2); assert.equal(list.data.outputs.currentCycle.status, 'partially_unknown'); assert.equal(list.data.outputs.currentCycle.unattributedRecords, 1);
  const r = await call(`${L}/deliveries/dlv-legacy-0004/void`, 'POST', { requestId: nid('void'), reason: '舊紀錄數量登錄錯誤', ...vc() }, 2); assert.equal(r.status, 200, JSON.stringify(r.data));
  list = await call(L + '/lifecycle', 'GET', undefined, 2); assert.equal(list.data.outputs.currentCycle.status, 'none_recorded'); assert.equal(list.data.outputs.cumulative.status, 'unknown', 'no active records = unknown, not 0');
});
await test('pending seal blocks evidence writers (dates/status/assignment/items/deliveries/submit/schedule/cancel/transfer) but allows logs; seal waits for delivery/schedule pending', async () => {
  await managedL(R); const d = await deliverL({}, R); assert.equal(d.status, 201);
  const s = await call(R + '/delivery-submissions', 'POST', { id: nid('sub'), completenessConfirmed: true, ...vc(R) }, 2); assert.equal(s.status, 201);
  assert.equal((await lreq(sealBody({}, R), 2, R)).data.error, 'delivery_pending_review');
  await managedL(); await pendingL();
  for (const [fn, code] of [
    [() => call(L, 'PATCH', { goLiveDate: '2026-10-28', reason: '需求方提早上線', ...vc() }, 2), 'lifecycle_request_pending'],
    [() => call(L, 'PATCH', { collaboratorIds: [3], reason: '調整協作名單', ...vc() }, 2), 'lifecycle_request_pending'],
    [() => call(L + '/items', 'PATCH', { items: [], ...vc() }, 2), 'lifecycle_request_pending'], [() => deliverL(), 'lifecycle_request_pending'],
    [() => call(L + '/cancel', 'POST', { reason: '需求方取消', ...vc() }, 2), 'lifecycle_request_pending'],
    [() => call(L + '/transfer', 'POST', { toDesignerId: 6, reason: '主管派發', ...vc() }, 1), 'lifecycle_request_pending'],
    [() => call(L + '/archive', 'POST', {}, 1), 'lifecycle_seal_required'],
  ]) { const r = await fn(); assert.equal(r.data.error, code, JSON.stringify(r.data)); }
  const log = await call(L + '/logs', 'POST', { entry: { id: nid('log'), note: '等待主管決議中' }, expectedCycleId: cyc() }, 2); assert.equal(log.status, 200, 'logs are not evidence');
  assert.equal((await call(L + '/logs', 'POST', { entry: { id: nid('log'), note: '沒帶週期' } }, 2)).data.error, 'client_update_required');
});
await test('approval never rebases: a changed snapshot blocks it; an admin demoted or a revoked collaborator is refused inside the transaction', async () => {
  await managedL(); let q = await pendingL();
  row().goLiveDate = new Date('2026-11-20'); // another committed path moved a milestone
  let r = await decideL(q.id); assert.equal(r.data.error, 'lifecycle_base_changed'); assert.equal(row().lifecycleStatus, 'active'); assert.equal(cycles()[0].endedAt, null);
  row().goLiveDate = new Date('2026-10-30');
  beforeTx = db => { db.staff.get(1).role = 'member'; }; assert.equal((await decideL(q.id)).data.error, 'admin_only'); state.staff.get(1).role = 'admin';
  beforeTx = db => { db.cases.get(L).collaborators = []; }; assert.equal((await withdrawL(q.id, {}, 4)).data.error, 'forbidden');
  assert.equal(lreqs()[0].decision, null);
});
await test('round 2: a snapshot stored with re-ordered JSON keys (PostgreSQL JSONB) still approves; real evidence/assignment/date changes still reject', async () => {
  const reorder = v => (Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map(k => [k, reorder(v[k])])) : v);
  await managedL(); let q = await pendingL();
  const stored = state.lifecycle.get(q.id); stored.snapshot = reorder(stored.snapshot);
  assert.notEqual(JSON.stringify(stored.snapshot), JSON.stringify(reorder(stored.snapshot)), 'key order really differs');
  const ok = await decideL(q.id); assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(row().lifecycleStatus, 'sealed_incomplete');
  for (const change of [c => { c.collaborators = []; }, c => { c.goLiveDate = new Date('2026-11-20'); }, c => { c.archivePath = '/shared/changed'; }]) {
    reset(); await managedL(); q = await pendingL(); const st = state.lifecycle.get(q.id); st.snapshot = reorder(st.snapshot);
    change(row());
    const r = await decideL(q.id); assert.equal(r.data.error, 'lifecycle_base_changed', JSON.stringify(r.data)); assert.equal(row().lifecycleStatus, 'active');
  }
  reset(); await managedL(); legacyDelivery('dlv-a-0001'); legacyDelivery('dlv-b-0002'); q = await pendingL();
  const st = state.lifecycle.get(q.id); st.snapshot = { ...reorder(st.snapshot), activeDeliveryIds: [...st.snapshot.activeDeliveryIds].reverse() };
  assert.equal((await decideL(q.id)).data.error, 'lifecycle_base_changed', 'array order stays meaningful');
});
await test('forced audit / commit failures roll back the cycle end, decision, case status and version together', async () => {
  await managedL(); const q = await pendingL(); const snap = JSON.stringify([row().lifecycleStatus, row().archived, row().contentVersion, row().pendingLifecycleRequestId, cycles()[0].endedAt, state.audits.length]);
  fault = 'audit'; assert.equal((await decideL(q.id)).status, 500); fault = '';
  fault = 'commit'; assert.equal((await decideL(q.id)).status, 409); fault = '';
  assert.equal(JSON.stringify([row().lifecycleStatus, row().archived, row().contentVersion, row().pendingLifecycleRequestId, cycles()[0].endedAt, state.audits.length]), snap);
  assert.equal(lreqs()[0].decision, null);
});
await test('completion and cancellation close the open cycle with distinct outcomes; afterwards read-only except a completed closure-count correction; no reopen', async () => {
  await managedL(); row().archivePath = '/shared/' + L;
  const closed = await call(L, 'PATCH', { status: 'closed', reason: '主管確認交付完成', ...vc() }, 1); assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.equal(row().lifecycleStatus, 'completed'); assert.equal(cycles()[0].outcome, 'completed'); assert.equal(cycles()[0].endRequestId, null);
  assert.equal((await call(L, 'PATCH', { title: '結案後改標題', ...vc() }, 1)).data.error, 'lifecycle_closed');
  assert.equal((await call(L, 'PATCH', { status: 'doing', reason: '重新開啟', ...vc() }, 1)).data.error, 'lifecycle_reopen_unavailable');
  assert.equal((await call(L + '/logs', 'POST', { entry: { id: nid('log'), note: '結案後補日誌' }, expectedCycleId: cyc() }, 2)).data.error, 'lifecycle_closed');
  const audits = state.audits.length;
  assert.equal((await call(L, 'PATCH', { requestCount: 2 }, 2)).data.error, 'client_update_required');
  const cnt = await call(L, 'PATCH', { requestCount: 2, outputCount: 0, ...vc() }, 2); assert.equal(cnt.status, 200, JSON.stringify(cnt.data));
  assert.equal(row().requestCount, 2); assert.equal(row().outputCount, 0); assert.deepEqual(state.audits.slice(audits).map(a => a.field).sort(), ['outputCount', 'requestCount']);
  reset(); await managedL();
  const c = await call(L + '/cancel', 'POST', { reason: '需求方取消', ...vc() }, 2); assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(row().lifecycleStatus, 'cancelled'); assert.equal(cycles()[0].outcome, 'cancelled');
  assert.equal((await call(L + '/uncancel', 'POST', {}, 1)).data.error, 'lifecycle_reopen_unavailable'); assert.equal(row().status, 'cancelled');
  assert.equal((await call(L, 'PATCH', { requestCount: 1, ...vc() }, 2)).data.error, 'lifecycle_closed', 'cancelled: no count correction either');
  assert.equal((await lreq(resumeBody())).data.error, 'lifecycle_resume_not_allowed', 'no reopen of cancelled cases in D1b');
});
await test('records completion via the C1 approval closes the cycle completed in the same transaction', async () => {
  await managedL(R); assert.equal((await deliverL({}, R)).status, 201);
  const s = await call(R + '/delivery-submissions', 'POST', { id: nid('sub'), completenessConfirmed: true, ...vc(R) }, 2); assert.equal(s.status, 201, JSON.stringify(s.data));
  const a = await call(R + '/approve', 'POST', { decision: 'approve', submissionId: s.data.submission.id, operationId: nid('op'), ...vc(R) }, 1); assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(row(R).status, 'closed'); assert.equal(row(R).lifecycleStatus, 'completed'); assert.equal(cycles(R)[0].outcome, 'completed');
});
await test('managed PATCH: any real change needs versions + cycle; same values are a true no-op; collaborator-only change by a demoted admin is refused in the transaction', async () => {
  await managedL(); row().collaborators = [{ id: 4 }, { id: 6 }];
  assert.equal((await call(L, 'PATCH', { title: '改標題' }, 2)).data.error, 'client_update_required');
  assert.equal((await call(L, 'PATCH', { title: '改標題', ...v() }, 2)).data.error, 'client_update_required');
  assert.equal((await call(L, 'PATCH', { title: '改標題', ...v(), expectedCycleId: 'cycle-wrong-000001' }, 2)).data.error, 'cycle_conflict');
  const before = [row().contentVersion, row().updatedAt.getTime(), state.audits.length];
  assert.equal((await call(L, 'PATCH', { title: row().title, collaboratorIds: [6, 4], level: 'A' }, 2)).status, 200);
  assert.deepEqual([row().contentVersion, row().updatedAt.getTime(), state.audits.length], before, 'true no-op writes nothing');
  beforeTx = db => { db.staff.get(6).role = 'member'; };
  const r = await call(L, 'PATCH', { collaboratorIds: [3], reason: '調整協作名單以便交接', ...vc() }, 6); beforeTx = null;
  assert.equal(r.status, 403, JSON.stringify(r.data)); assert.deepEqual(row().collaborators.map(c => c.id).sort(), [4, 6]);
  state.staff.get(6).role = 'admin';
  const ok = await call(L, 'PATCH', { title: '改標題', ...vc() }, 2); assert.equal(ok.status, 200); assert.equal(row().contentVersion, before[0] + 1);
});
await test('flag off: history readable (paused); adopt/request/approve paused; withdraw and reject still work; legacy without history hidden', async () => {
  await managedL(); const q = await pendingL(); process.env.LIFECYCLE_WORKFLOW_ENABLED = '0';
  const list = await call(L + '/lifecycle'); assert.equal(list.status, 200); assert.equal(list.data.workflow.paused, true);
  assert.equal((await call(R + '/lifecycle')).status, 404); assert.equal((await adoptL(R)).status, 404);
  assert.equal((await decideL(q.id)).data.error, 'lifecycle_workflow_paused');
  assert.equal((await decideL(q.id, { decision: 'reject', reason: '暫停期間先退回' })).status, 200);
  process.env.LIFECYCLE_WORKFLOW_ENABLED = '1'; const q2 = await pendingL(); process.env.LIFECYCLE_WORKFLOW_ENABLED = '0';
  assert.equal((await withdrawL(q2.id)).status, 200); assert.equal((await lreq(sealBody())).data.error, 'lifecycle_workflow_paused');
  assert.equal(row().lifecycleMode, 'managed', 'never downgraded'); assert.equal((await call(L + '/archive', 'POST', {}, 1)).data.error, 'lifecycle_seal_required', 'guards stay while paused');
});
await test('delete is blocked by lifecycle history; list/get expose markers; schedule requests also wait for a pending seal', async () => {
  await managedL(); row().status = 'todo';
  const del = await call(L, 'DELETE', undefined, 1); assert.equal(del.status, 409); assert.equal(del.data.error, 'case_has_lifecycle_history');
  const one = await call(L, 'GET', undefined, 1); assert.equal(one.data._count.cycles, 1); assert.equal(one.data.lifecycleMode, 'managed');
  row().status = 'doing';
  await call(L + '/schedule-mode/adopt', 'POST', { requestId: nid('adopt'), reason: '試行時程受控管理', ...vc() }, 1);
  await pendingL();
  const p = await call(L + '/schedule-requests', 'POST', { id: nid('sch'), reasonCategory: 'requester_change', reason: '需求方延後活動檔期', proposedDates: { goLiveDate: '2026-11-06' }, ...vc() }, 2);
  assert.equal(p.data.error, 'lifecycle_request_pending');
});
console.log(JSON.stringify({ passed, liveDatabase: false, emailsSent: 0, flags: ['LIFECYCLE_WORKFLOW_ENABLED'] }));
