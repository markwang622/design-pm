// REPORTS-P1-C1: actual Express case/delivery/workflow routes against an isolated, rollback-capable
// Prisma double (serialized like Serializable). No listener, real database, SMTP or production data.
// Real PostgreSQL constraints, triggers and overlapping transactions: tests/postgresMaintenance.mjs.
import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex } from 'node:stream';
import { createRequire } from 'node:module';
const root = process.env.DESIGN_PM_ROOT || new URL('../', import.meta.url).pathname;
const require = createRequire(root + '/package.json');
const express = require('express'), cookieParser = require('cookie-parser');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'isolated-delivery-workflow-tests-secret';
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
    openDate: new Date('2026-10-01'), dispatchDate: new Date('2026-10-02'), goLiveDate: new Date('2026-10-30'),
    items: [{ key: 'item-key-main-0001', n: '主視覺 KV', status: 'doing' }], logs: [], contentVersion: 3, updatedAt: new Date('2026-10-20T01:00:00.000Z'),
    deliveryMode: 'legacy', deliveryModeSince: null, deliveryModeById: null, deliveryModeByName: null, deliveryModeReason: null,
    deliveryModeRequestId: null, deliveryModeFingerprint: null, pendingDeliverySubmissionId: null, ...extra };
}
const recordsStamp = { deliveryMode: 'records', deliveryModeSince: new Date('2026-10-19T00:00:00Z'), deliveryModeById: 1, deliveryModeByName: 'Admin', deliveryModeReason: '測試案件' };
function reset() {
  state = { staff: new Map(clone([...people])), cases: new Map([[R, freshCase(R, recordsStamp)], [L, freshCase(L)]]), deliveries: new Map(), submissions: new Map(), audits: [], notifications: [], transfers: [] };
  queue = Promise.resolve(); fault = ''; beforeTx = null; trace = { transactions: 0 };
  process.env.DELIVERY_RECORDS_ENABLED = '1'; process.env.DELIVERY_WORKFLOW_ENABLED = '1';
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
  if (withCounts) out._count = { deliveries: [...db.deliveries.values()].filter(d => d.caseId === row.id).length, deliverySubmissions: [...db.submissions.values()].filter(s => s.caseId === row.id).length };
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
      update: async ({ where, data }) => { const row = db.cases.get(where.id); applyData(row, data); row.updatedAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)); return hydrate(db, row); },
      create: async ({ data }) => {
        if (db.cases.has(data.id)) throw p2002();
        const row = { ...freshCase(data.id), items: null, ...clone(data), designerId: data.designer?.connect?.id ?? data.designerId, collaborators: data.collaborators?.connect ?? [] };
        delete row.designer; delete row.createdBy; db.cases.set(row.id, row); return hydrate(db, row);
      },
      delete: async ({ where }) => {
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
    changeLog: { createMany: async ({ data }) => { if (fault === 'audit' && inTx) throw Error('Synthetic audit failure'); db.audits.push(...clone(data)); return { count: data.length }; } },
    transferLog: { create: async ({ data }) => { db.transfers.push(clone(data)); return clone(data); } },
    notification: { findFirst: async () => null, updateMany: async () => ({ count: 0 }), create: async ({ data }) => { assert.equal(inTx, false, 'notifications only after commit'); state.notifications.push(clone(data)); return clone(data); }, createMany: async ({ data }) => { state.notifications.push(...clone(data)); return { count: data.length }; } },
  };
}
reset();
for (const model of ['case', 'staff', 'changeLog', 'notification', 'deliveryRecord', 'deliverySubmission', 'transferLog']) {
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
    const isolated = { ...state, staff: new Map(clone([...state.staff])), cases: new Map(clone([...state.cases])), deliveries: new Map(clone([...state.deliveries])), submissions: new Map(clone([...state.submissions])), audits: clone(state.audits) };
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
const v = (id = R) => ({ expectedUpdatedAt: state.cases.get(id).updatedAt.toISOString(), expectedContentVersion: state.cases.get(id).contentVersion });
let seq = 0; const nid = tag => `${tag}-${String(++seq).padStart(6, '0')}`;
const deliver = async (extra = {}, id = R, as = 2) => { const r = await call(id + '/deliveries', 'POST', { id: nid('dlv'), itemName: '主視覺 KV', kind: 'main', quantity: 1, unit: '件', deliveredOn: '2026-10-21', ...v(id), ...extra }, as); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.record; };
const submitBody = (extra = {}, id = R) => ({ id: nid('sub'), completenessConfirmed: true, ...v(id), ...extra });
const submit = (body, as = 2, id = R) => call(id + '/delivery-submissions', 'POST', body, as);
const decide = (body, as = 1, id = R) => call(id + '/approve', 'POST', body, as);
const approveBody = (submissionId, extra = {}, id = R) => ({ decision: 'approve', submissionId, operationId: nid('op'), ...v(id), ...extra });
const rejectBody = (submissionId, extra = {}, id = R) => ({ decision: 'reject', submissionId, operationId: nid('op'), comment: '請補充延伸尺寸', ...v(id), ...extra });
const withdraw = (sid, extra = {}, as = 2, id = R) => call(`${id}/delivery-submissions/${sid}/withdraw`, 'POST', { id: nid('wd'), reason: '數量需要更正', ...v(id), ...extra }, as);
const row = (id = R) => state.cases.get(id);
const subs = () => [...state.submissions.values()];

let passed = 0;
async function test(name, fn) { reset(); await fn(); passed++; console.log('PASS ' + name); }

await test('main 1 + extension 3: submit freezes a summary, admin approves the same submission and the case closes', async () => {
  await deliver(); await deliver({ itemName: 'FB 延伸', kind: 'extension', quantity: 3 }, R, 4);
  const s = await submit(submitBody());
  assert.equal(s.status, 201); const sub = s.data.submission;
  assert.deepEqual(sub.summary, [{ kind: 'main', unit: '件', quantity: 1, records: 1 }, { kind: 'extension', unit: '件', quantity: 3, records: 1 }]);
  assert.equal(sub.recordIds.length, 2); assert.equal(sub.archivePath, '/shared/' + R); assert.equal(sub.status, 'pending'); assert.deepEqual(sub.zeroSupport, []);
  assert.equal(row().status, 'review_done'); assert.equal(row().pendingDeliverySubmissionId, sub.id); assert.equal(row().contentVersion, 6);
  assert.equal(row().outputCount, null, 'legacy outputCount never overwritten'); assert(state.notifications.some(n => n.type === 'reviewDone'));
  const history = await call(R + '/delivery-submissions', 'GET', undefined, 5); assert.equal(history.status, 200); assert.equal(history.data.pendingSubmissionId, sub.id);
  const ok = await decide(approveBody(sub.id)); assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.submission.status, 'approved'); assert.equal(ok.data.submission.decidedByName, 'Admin');
  assert.equal(row().status, 'closed'); assert.equal(row().archived, true); assert(row().closedOn); assert.equal(row().pendingDeliverySubmissionId, null);
  assert(state.audits.some(a => a.toValue === 'closed')); assert(state.notifications.some(n => n.type === 'caseClosed'));
});
await test('all-zero support submits; approval requires explicit zeroSupportApproved:true', async () => {
  await deliver({ itemName: '版面諮詢', kind: 'support', quantity: 0, note: '提供版面諮詢，未新增設計檔案' });
  const s = await submit(submitBody()); assert.equal(s.status, 201); assert.equal(s.data.submission.zeroSupport.length, 1);
  for (const extra of [{}, { zeroSupportApproved: false }]) {
    const r = await decide(approveBody(s.data.submission.id, extra)); assert.equal(r.status, 422); assert.equal(r.data.error, 'zero_support_confirmation_required');
  }
  assert.equal(row().status, 'review_done');
  const ok = await decide(approveBody(s.data.submission.id, { zeroSupportApproved: true })); assert.equal(ok.status, 200); assert.equal(ok.data.submission.zeroSupportApproved, true);
});
await test('submit refuses missing archive, no/all-voided records, unconfirmed completeness and outdated clients without writing', async () => {
  const before = () => [row().status, row().contentVersion, subs().length].join('|'); const b0 = before();
  let r = await submit(submitBody()); assert.equal(r.status, 422); assert.equal(r.data.error, 'deliveries_required');
  const rec = await deliver();
  await call(`${R}/deliveries/${rec.id}/void`, 'POST', { requestId: nid('void'), reason: '登錄錯誤', ...v() });
  r = await submit(submitBody()); assert.equal(r.data.error, 'deliveries_required', 'all voided = no active records');
  await deliver(); row().archivePath = '  ';
  r = await submit(submitBody()); assert.equal(r.status, 422); assert.equal(r.data.error, 'archive_path_required'); row().archivePath = '/shared/x';
  for (const extra of [{ completenessConfirmed: false }, { completenessConfirmed: undefined }]) { r = await submit(submitBody(extra)); assert.equal(r.status, 422); assert.equal(r.data.error, 'completeness_confirmation_required'); }
  for (const extra of [{ expectedUpdatedAt: undefined }, { expectedContentVersion: undefined }]) { r = await submit(submitBody(extra)); assert.equal(r.status, 409); assert.equal(r.data.error, 'client_update_required'); }
  r = await submit(submitBody({ expectedContentVersion: 1 })); assert.equal(r.data.error, 'edit_conflict');
  assert.equal(row().status, 'doing'); assert.equal(subs().length, 0); assert.notEqual(before(), b0 + 'x');
});
await test('submit and decisions enforce actor, assignment and role', async () => {
  await deliver();
  assert.equal((await submit(submitBody(), 3)).data.error, 'forbidden'); assert.equal((await submit(submitBody(), 5)).data.error, 'read_only');
  const s = await submit(submitBody(), 4); assert.equal(s.status, 201, 'collaborator may submit');
  assert.equal((await decide(approveBody(s.data.submission.id), 2)).status, 403, 'members cannot approve');
  beforeTx = db => { db.staff.get(1).role = 'member'; };
  const demoted = await decide(approveBody(s.data.submission.id), 1); assert.equal(demoted.status, 403); assert.equal(demoted.data.error, 'admin_only');
  beforeTx = db => { db.staff.get(6).active = false; };
  assert.equal((await decide(approveBody(s.data.submission.id), 6)).data.error, 'actor_inactive');
  beforeTx = db => { db.cases.get(R).collaborators = []; };
  assert.equal((await withdraw(s.data.submission.id, {}, 4)).data.error, 'forbidden', 'revoked collaborator cannot withdraw');
  assert.equal(row().status, 'review_done');
});
await test('legacy cases keep the original PATCH review_done and {decision} approve contract', async () => {
  let r = await call(L, 'PATCH', { status: 'review_done' }, 2); assert.equal(r.status, 200); assert.equal(row(L).status, 'review_done');
  r = await call(L + '/approve', 'POST', { decision: 'approve', comment: 'ok' }, 1); assert.equal(r.status, 200); assert.equal(row(L).status, 'closed');
  assert.equal(row(L).requestCount, null); assert.equal(row(L).deliveryMode, 'legacy');
  assert.equal((await call(L + '/delivery-submissions', 'POST', submitBody({}, L), 2)).data.error, 'not_records_mode');
});
await test('records bypasses through PATCH, archive, items, evidence and old approve bodies are refused (admins too)', async () => {
  await deliver();
  for (const [status, code] of [['review_done', 'delivery_submission_required'], ['closed', 'delivery_approval_required'], ['done', 'delivery_approval_required']]) {
    const r = await call(R, 'PATCH', { status }, 1); assert.equal(r.status, 409, status); assert.equal(r.data.error, code);
  }
  const s = await submit(submitBody());
  const sid = s.data.submission.id;
  for (const [body, code] of [[{ status: 'doing' }, 'delivery_withdraw_required'], [{ archivePath: '/elsewhere' }, 'delivery_evidence_frozen'], [{ outputCount: 4 }, 'delivery_evidence_frozen'], [{ requestCount: 2 }, 'delivery_evidence_frozen']]) {
    const r = await call(R, 'PATCH', body, 1); assert.equal(r.status, 409, JSON.stringify(body)); assert.equal(r.data.error, code);
  }
  assert.equal((await call(R + '/archive', 'POST', {}, 1)).data.error, 'delivery_pending_review');
  const items = await call(R + '/items', 'PATCH', { items: row().items, ...v() }, 2); assert.equal(items.status, 409); assert.equal(items.data.error, 'delivery_evidence_frozen');
  const old = await decide({ decision: 'approve', comment: 'old client' }); assert.equal(old.status, 409); assert.equal(old.data.error, 'client_update_required');
  assert.equal((await call(R + '/deliveries', 'POST', { id: nid('dlv'), itemName: 'x', kind: 'main', quantity: 1, unit: '件', deliveredOn: '2026-10-21', ...v() }, 2)).data.error, 'case_locked');
  assert.equal((await call(R, 'PATCH', { title: '可改標題' }, 2)).status, 200, 'non-evidence fields stay editable');
  assert.equal((await decide(approveBody(sid))).status, 200);
  for (const body of [{ status: 'doing' }, { archivePath: '/x' }, { outputCount: 9 }]) assert.equal((await call(R, 'PATCH', body, 1)).status, 409, 'approved records cannot be reopened or re-evidenced');
  assert.equal(row().status, 'closed'); assert.equal(row().archivePath, '/shared/' + R);
});
await test('withdraw and reject return to doing, allow B correction, and resubmission keeps every round', async () => {
  const rec = await deliver();
  let s = await submit(submitBody()); const first = s.data.submission.id;
  let w = await withdraw(first); assert.equal(w.status, 200); assert.equal(w.data.submission.status, 'withdrawn'); assert.equal(row().status, 'doing'); assert.equal(row().pendingDeliverySubmissionId, null);
  const fix = await call(`${R}/deliveries/${rec.id}/replace`, 'POST', { id: nid('fix'), itemName: '主視覺 KV', kind: 'main', quantity: 2, unit: '件', deliveredOn: '2026-10-21', reason: '數量更正', ...v() }, 2);
  assert.equal(fix.status, 201);
  s = await submit(submitBody()); const second = s.data.submission.id; assert.equal(s.data.submission.summary[0].quantity, 2);
  const noReason = await decide(rejectBody(second, { comment: '' })); assert.equal(noReason.status, 422); assert.equal(noReason.data.error, 'reject_reason_required');
  const rj = await decide(rejectBody(second)); assert.equal(rj.status, 200); assert.equal(rj.data.submission.status, 'rejected'); assert.equal(row().status, 'doing');
  s = await submit(submitBody()); const third = s.data.submission.id; assert.equal((await decide(approveBody(third))).status, 200);
  const history = (await call(R + '/delivery-submissions')).data.submissions.map(x => [x.id, x.status]);
  assert.deepEqual(new Map(history), new Map([[first, 'withdrawn'], [second, 'rejected'], [third, 'approved']]));
  assert.equal(subs().find(x => x.id === first).summary[0].quantity, 1, 'earlier evidence preserved');
});
await test('cancelling invalidates the pending submission atomically; uncancel resumes at doing; old submission cannot be approved', async () => {
  await deliver(); const s = await submit(submitBody()); const sid = s.data.submission.id;
  const c = await call(R + '/cancel', 'POST', { reason: '需求方取消' }, 2); assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(row().status, 'cancelled'); assert.equal(row().pendingDeliverySubmissionId, null);
  const stamped = subs().find(x => x.id === sid); assert.equal(stamped.decision, 'cancelled'); assert.match(stamped.decisionReason, /需求方取消/);
  assert.equal((await decide(approveBody(sid))).status, 409);
  const u = await call(R + '/uncancel', 'POST', {}, 2); assert.equal(u.status, 200); assert.equal(row().status, 'doing', 'records never return straight to review_done');
  assert.equal((await decide(approveBody(sid))).data.error, 'submission_closed');
});
await test('cancel rolls back the submission stamp together with the case when the transaction fails', async () => {
  await deliver(); const s = await submit(submitBody()); fault = 'audit';
  const c = await call(R + '/cancel', 'POST', { reason: '需求方取消' }, 2); fault = '';
  assert.notEqual(c.status, 200); assert.equal(row().status, 'review_done'); assert.equal(subs().find(x => x.id === s.data.submission.id).decision, null);
});
await test('workflow switch off pauses new submit/approve without downgrading; reads, withdraw and reject stay available', async () => {
  await deliver(); const pending = (await submit(submitBody())).data.submission.id;
  process.env.DELIVERY_WORKFLOW_ENABLED = '0';
  assert.equal((await decide(approveBody(pending))).data.error, 'delivery_workflow_paused');
  assert.equal((await call(R + '/delivery-submissions', 'GET', undefined, 5)).status, 200);
  const listing = await call(R + '/deliveries'); assert.equal(listing.status, 200); assert.equal(listing.data.mode, 'records'); assert.equal(listing.data.workflow.paused, true);
  assert.equal((await withdraw(pending)).status, 200, 'withdraw is never a dead end');
  assert.equal((await submit(submitBody())).data.error, 'delivery_workflow_paused');
  assert.equal((await call(R, 'PATCH', { status: 'review_done' }, 1)).data.error, 'delivery_submission_required', 'no fallback to the legacy path');
  process.env.DELIVERY_RECORDS_ENABLED = '0';
  assert.equal((await call(R + '/deliveries')).status, 200, 'records evidence stays readable with the feature off');
  const write = await call(R + '/deliveries', 'POST', { id: nid('dlv'), itemName: 'x', kind: 'main', quantity: 1, unit: '件', deliveredOn: '2026-10-21', ...v() }); assert.equal(write.data.error, 'delivery_workflow_paused');
  assert.equal((await call(L + '/deliveries')).status, 404, 'legacy stays hidden'); assert.equal((await call(L + '/delivery-submissions')).status, 404);
  process.env.DELIVERY_RECORDS_ENABLED = '1'; process.env.DELIVERY_WORKFLOW_ENABLED = '1';
  const again = await submit(submitBody()); assert.equal(again.status, 201, 'resumes after re-enabling'); assert.equal(row().deliveryMode, 'records');
});
await test('rejecting stays possible when evidence changed or the archive path is missing; approving such a submission is refused', async () => {
  const rec = await deliver(); const sid = (await submit(submitBody())).data.submission.id;
  state.deliveries.get(rec.id).quantity = 9; // evidence altered behind the API
  const bad = await decide(approveBody(sid)); assert.equal(bad.status, 409); assert.equal(bad.data.error, 'submission_evidence_changed');
  row().archivePath = null;
  assert.equal((await decide(rejectBody(sid))).status, 200); assert.equal(row().status, 'doing');
});
await test('adoption: admin-only, flags required, eligible states only, one-way and idempotent', async () => {
  const body = (extra = {}) => ({ requestId: nid('adopt'), reason: '試行導入交付明細制', ...v(L), ...extra });
  assert.equal((await call(L + '/delivery-mode/adopt', 'POST', body(), 2)).data.error, 'admin_only');
  process.env.DELIVERY_WORKFLOW_ENABLED = '0'; assert.equal((await call(L + '/delivery-mode/adopt', 'POST', body(), 1)).status, 404); process.env.DELIVERY_WORKFLOW_ENABLED = '1';
  for (const patch of [{ status: 'review_done' }, { status: 'closed' }, { status: 'cancelled' }, { archived: true }]) {
    Object.assign(row(L), patch); assert.equal((await call(L + '/delivery-mode/adopt', 'POST', body(), 1)).data.error, 'adoption_not_allowed'); Object.assign(row(L), { status: 'doing', archived: false });
  }
  const b = body(); const a = await call(L + '/delivery-mode/adopt', 'POST', b, 1); assert.equal(a.status, 201);
  assert.equal(row(L).deliveryMode, 'records'); assert.equal(row(L).deliveryModeById, 1); assert.equal(row(L).deliveryModeRequestId, b.requestId);
  const replay = await call(L + '/delivery-mode/adopt', 'POST', b, 1); assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true);
  assert.equal((await call(L + '/delivery-mode/adopt', 'POST', { ...b, reason: '不同原因' }, 1)).data.error, 'delivery_request_conflict');
  assert.equal((await call(L + '/delivery-mode/adopt', 'POST', body(), 1)).data.error, 'already_records');
  assert(state.audits.some(x => x.field === 'deliveryMode' && x.toValue === 'records'));
});
await test('new cases are records only with both switches on; clone follows the new-case rule and copies no evidence; CSV import stays legacy', async () => {
  const base = { title: '新案', level: 'B', designerId: 2, openDate: '2026-10-21', dispatchDate: '2026-10-21', goLiveDate: '2026-11-10' };
  let r = await call('', 'POST', base, 1); assert.equal(r.status, 201); assert.equal(row(r.data.id).deliveryMode, 'records'); assert.equal(row(r.data.id).deliveryModeById, 1);
  process.env.DELIVERY_WORKFLOW_ENABLED = '0'; r = await call('', 'POST', base, 1); assert.equal(row(r.data.id).deliveryMode, 'legacy');
  process.env.DELIVERY_WORKFLOW_ENABLED = '1'; await deliver(); await submit(submitBody());
  const cl = await call(R + '/clone', 'POST', {}, 1); assert.equal(cl.status, 201); assert.equal(row(cl.data.id).deliveryMode, 'records');
  assert.equal([...state.deliveries.values()].filter(d => d.caseId === cl.data.id).length, 0); assert.equal(subs().filter(s => s.caseId === cl.data.id).length, 0);
  assert.equal(row(cl.data.id).pendingDeliverySubmissionId, null); assert.equal(row(cl.data.id).status, 'todo');
  const imported = await call('bulk-import', 'POST', { rows: [{ title: '歷史匯入', designerName: 'Owner', status: 'review_done', archivePath: '/hist/a' }, { title: '歷史結案', designerName: 'Owner', status: 'closed', archivePath: '/hist/b', outputCount: 0 }] }, 1);
  assert.equal(imported.status, 200, JSON.stringify(imported.data)); assert.equal(imported.data.summary.created, 2);
  for (const c of imported.data.created) { assert.equal(row(c.id).deliveryMode, 'legacy', 'historical import never becomes records'); assert.equal(row(c.id).pendingDeliverySubmissionId, null); }
  const imp0 = imported.data.created.find(c => row(c.id).status === 'closed'); assert.equal(row(imp0.id).outputCount, 0, 'legacy 0 stays a known 0');
});
await test('exact retries replay without rewriting; reused ids with different intent conflict', async () => {
  await deliver(); const body = submitBody(); const s = await submit(body); assert.equal(s.status, 201);
  const audits = state.audits.length, notices = state.notifications.length;
  const replay = await submit(body); assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true); assert.equal(replay.data.submission.id, body.id);
  assert.equal(state.audits.length, audits); assert.equal(state.notifications.length, notices, 'no duplicate notification');
  assert.equal((await submit(body, 4)).data.error, 'delivery_request_conflict', 'other actor');
  const ab = approveBody(body.id); assert.equal((await decide(ab)).status, 200);
  const again = await decide(ab); assert.equal(again.status, 200); assert.equal(again.data.replayed, true);
  assert.equal((await decide({ ...ab, decision: 'reject', comment: '改成退回' })).data.error, 'delivery_request_conflict');
  assert.equal((await decide({ ...ab, comment: '不同評語' })).data.error, 'delivery_request_conflict');
  assert.equal(subs().length, 1); assert.equal(subs()[0].decision, 'approved');
});
await test('concurrent decisions and races: exactly one outcome stands', async () => {
  await deliver(); let sid = (await submit(submitBody())).data.submission.id;
  const [a, b] = await Promise.all([decide(approveBody(sid), 1), decide(rejectBody(sid), 6)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]); assert.equal(subs().filter(s => s.decision).length, 1);
  reset(); await deliver();
  const d = { id: nid('dlv'), itemName: 'race', kind: 'main', quantity: 1, unit: '件', deliveredOn: '2026-10-21', ...v() };
  const [x, y] = await Promise.all([call(R + '/deliveries', 'POST', d, 2), submit(submitBody())]);
  assert.deepEqual([x.status, y.status].sort(), [201, 409], 'delivery vs submit from the same version');
  reset(); await deliver(); sid = (await submit(submitBody())).data.submission.id;
  const [w, ap] = await Promise.all([withdraw(sid), decide(approveBody(sid))]);
  assert.deepEqual([w.status, ap.status].sort(), [200, 409]); assert.equal(subs()[0].decision === 'approved' ? row().status : 'doing', row().status);
});
await test('injected audit or claim failures roll back the whole submission or decision', async () => {
  await deliver();
  for (const f of ['audit', 'claim-lost', 'commit']) { fault = f; const r = await submit(submitBody()); fault = ''; assert.notEqual(r.status, 201, f); assert.equal(subs().length, 0, f); assert.equal(row().status, 'doing', f); }
  const sid = (await submit(submitBody())).data.submission.id; const version = row().contentVersion;
  for (const f of ['audit', 'claim-lost', 'commit']) { fault = f; const r = await decide(approveBody(sid)); fault = ''; assert.notEqual(r.status, 200, f); assert.equal(subs()[0].decision, null, f); assert.equal(row().contentVersion, version, f); }
});
await test('cases with submissions cannot be deleted; list/get expose delivery markers for source exports', async () => {
  await deliver(); await submit(submitBody());
  Object.assign(row(), { status: 'todo' });
  const del = await call(R, 'DELETE', undefined, 1); assert.equal(del.status, 409); assert.equal(del.data.error, 'case_has_deliveries');
  const list = await call('?includeArchived=1', 'GET', undefined, 1); const rr = list.data.find(c => c.id === R);
  assert.equal(rr.deliveryMode, 'records'); assert.deepEqual(rr._count, { deliveries: 1, deliverySubmissions: 1 });
  const one = await call(L, 'GET', undefined, 1); assert.equal(one.data.deliveryMode, 'legacy'); assert.deepEqual(one.data._count, { deliveries: 0, deliverySubmissions: 0 });
});
// ── Acceptance round 1: frozen-evidence PATCH race ─────────────────────────
// Pause a PATCH right after its real initial read (the route's own prisma.case.findUnique), let other
// real requests commit, then release it. Deterministic interleaving without touching product code.
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
const auditsFor = field => state.audits.filter(a => a.field === field).length;
await test('race: a stale archivePath PATCH loses after submit and approval commit in between; evidence, version and audit unchanged', async () => {
  await deliver(); const pause = pauseNextPatchRead();
  const patch = call(R, 'PATCH', { archivePath: '/tampered/path' }, 2); await pause.readDone;
  const s = await submit(submitBody()); assert.equal(s.status, 201);
  const a = await decide(approveBody(s.data.submission.id)); assert.equal(a.status, 200);
  const version = row().contentVersion, audits = state.audits.length; pause.release();
  const r = await patch; assert.equal(r.status, 409, JSON.stringify(r.data)); assert.equal(r.data.error, 'case_conflict');
  assert.equal(row().archivePath, '/shared/' + R); assert.equal(row().archivePath, subs()[0].archivePath, 'live path still equals approved evidence');
  assert.equal(row().status, 'closed'); assert.equal(row().contentVersion, version); assert.equal(state.audits.length, audits);
});
await test('race: same-millisecond writes are still detected through contentVersion', async () => {
  await deliver(); const pause = pauseNextPatchRead();
  const patch = call(R, 'PATCH', { archivePath: '/same/ms' }, 2); await pause.readDone;
  row().contentVersion += 1; // a committed delivery-side write that kept the identical updatedAt
  pause.release(); const r = await patch; assert.equal(r.status, 409); assert.equal(row().archivePath, '/shared/' + R);
});
await test('race: when the evidence PATCH wins first, a submission carrying the old browser version loses', async () => {
  await deliver(); const old = v();
  const r = await call(R, 'PATCH', { archivePath: '/shared/updated' }, 2); assert.equal(r.status, 200);
  assert.equal(row().contentVersion, old.expectedContentVersion + 1, 'records evidence edit advances contentVersion');
  const late = await submit(submitBody(old)); assert.equal(late.status, 409); assert.equal(late.data.error, 'edit_conflict'); assert.equal(subs().length, 0);
  const fresh = await submit(submitBody()); assert.equal(fresh.status, 201); assert.equal(fresh.data.submission.archivePath, '/shared/updated');
});
await test('race: a legacy-snapshot evidence PATCH loses to a one-way adoption committed in between', async () => {
  const pause = pauseNextPatchRead();
  const patch = call(L, 'PATCH', { archivePath: '/legacy/new' }, 2); await pause.readDone;
  const adopt = await call(L + '/delivery-mode/adopt', 'POST', { requestId: nid('adopt'), reason: '試行導入', ...v(L) }, 1); assert.equal(adopt.status, 201);
  pause.release(); const r = await patch; assert.equal(r.status, 409); assert.equal(row(L).archivePath, '/shared/' + L);
  const again = await call(L, 'PATCH', { archivePath: '/legacy/new' }, 2); assert.equal(again.status, 200, 're-read under records rules');
});
await test('race: an editor revoked or deactivated after the PATCH read cannot write evidence', async () => {
  for (const revoke of [db => { db.cases.get(R).collaborators = []; }, db => { db.staff.get(4).active = false; }]) {
    reset(); const pause = pauseNextPatchRead();
    const patch = call(R, 'PATCH', { archivePath: '/revoked/edit' }, 4); await pause.readDone;
    revoke(state); pause.release(); const r = await patch;
    assert([403, 409].includes(r.status), JSON.stringify(r.data)); assert.equal(row().archivePath, '/shared/' + R);
  }
});
await test('legacy archive edits keep their behavior and version semantics; non-evidence edits unaffected; copy has no API URL', async () => {
  const before = row(L).contentVersion;
  const r = await call(L, 'PATCH', { archivePath: '/legacy/path' }, 2); assert.equal(r.status, 200); assert.equal(row(L).archivePath, '/legacy/path');
  assert.equal(row(L).contentVersion, before, 'legacy evidence edits do not advance contentVersion (no drawer churn)');
  assert.equal((await call(L, 'PATCH', { title: '只改標題' }, 2)).status, 200);
  await deliver(); const m = await call(R, 'PATCH', { status: 'review_done' }, 2);
  assert.equal(m.data.error, 'delivery_submission_required'); assert(!/\/api\/|POST /.test(m.data.message)); assert.match(m.data.message, /送審/);
});
// ── Acceptance round 1: cancellation authority is re-read inside the cancel transaction ──
// The cancel route's own initial read is the bare `findUnique({ where })`; pause right after it.
function pauseNextCancelRead() {
  const real = prisma.case.findUnique; let release, readDone;
  const gate = new Promise(r => { release = r; }); const done = new Promise(r => { readDone = r; });
  prisma.case.findUnique = async args => {
    const result = await real(args);
    if (args && !args.include && !args.select) { prisma.case.findUnique = real; readDone(); await gate; }
    return result;
  };
  return { readDone: done, release: () => release() };
}
async function pendingCase(as = 2) {
  await deliver({}, R, as); const s = await submit(submitBody(), as); assert.equal(s.status, 201, JSON.stringify(s.data)); return s.data.submission.id;
}
const caseSnapshot = () => JSON.stringify([row().status, row().archived, row().pendingDeliverySubmissionId, row().contentVersion, row().updatedAt.toISOString(), state.audits.length]);
await test('cancel race: a non-owner admin demoted or disabled after the initial read cannot cancel or stamp the pending submission', async () => {
  for (const [revoke, code] of [[db => { db.staff.get(6).role = 'member'; }, 'forbidden'], [db => { db.staff.get(6).role = 'observer'; }, 'read_only'], [db => { db.staff.get(6).active = false; }, 'actor_inactive']]) {
    reset(); const sid = await pendingCase(); const before = caseSnapshot(); const pause = pauseNextCancelRead();
    const cancel = call(R + '/cancel', 'POST', { reason: '需求方取消' }, 6); await pause.readDone;
    revoke(state); pause.release(); const r = await cancel;
    assert.equal(r.status, 403, JSON.stringify(r.data)); assert.equal(r.data.error, code);
    const sub = subs().find(x => x.id === sid); assert.equal(sub.decidedAt, null); assert.equal(sub.decision, null);
    assert.equal(caseSnapshot(), before, 'case, version and audit unchanged');
  }
});
await test('cancel race: an inactive primary is denied; collaborator-only never cancels', async () => {
  const sid = await pendingCase(); const before = caseSnapshot(); const pause = pauseNextCancelRead();
  const cancel = call(R + '/cancel', 'POST', { reason: '需求方取消' }, 2); await pause.readDone;
  state.staff.get(2).active = false; pause.release(); const r = await cancel;
  assert.equal(r.status, 403); assert.equal(r.data.error, 'actor_inactive'); assert.equal(subs().find(x => x.id === sid).decidedAt, null); assert.equal(caseSnapshot(), before);
  state.staff.get(2).active = true;
  const collab = await call(R + '/cancel', 'POST', { reason: '需求方取消' }, 4); assert.equal(collab.status, 403); assert.equal(collab.data.error, 'forbidden');
  assert.equal(caseSnapshot(), before);
});
await test('cancel race: an admin demoted mid-request who is still the current primary may cancel; stamp uses the current actor', async () => {
  row().designerId = 1; const sid = await pendingCase(1); const pause = pauseNextCancelRead();
  const cancel = call(R + '/cancel', 'POST', { reason: '需求方取消' }, 1); await pause.readDone;
  Object.assign(state.staff.get(1), { role: 'member', name: 'Admin（現名）' }); pause.release(); const r = await cancel;
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(row().status, 'cancelled');
  const sub = subs().find(x => x.id === sid); assert.equal(sub.decision, 'cancelled'); assert.equal(sub.decidedById, 1); assert.equal(sub.decidedByName, 'Admin（現名）');
  assert(state.audits.some(a => a.toValue === 'cancelled' && a.operator === 'Admin（現名）'));
});
console.log(JSON.stringify({ passed, liveDatabase: false, emailsSent: 0, flags: ['DELIVERY_RECORDS_ENABLED', 'DELIVERY_WORKFLOW_ENABLED'] }));
