// REPORTS-P2-D1b: lifecycle-managed cases — work cycles, incomplete seal and same-ID resume.
//
// Confirmed rules (policy-decision.json, 2026-10-26): an incomplete seal is requested by the current
// primary/collaborator (an admin may file it) and only takes effect after a manager approves; the request may
// explicitly declare "no archivable file" with its own reason. A resume of the same case ID is likewise a
// designer request that a manager approves. A seal is neither completion nor cancellation: outputs, official
// dates, lateness and all earlier evidence stay as they are; no KPI rule changes.
//
// Same transaction model as REPORTS-P1-C1 / P2-D1a: every mutation re-reads, inside ONE Serializable
// transaction, the active actor (active / pendingActivation / current role), the current assignment, the case
// mode/status/current cycle/pending pointers and the browser-supplied versions (expectedUpdatedAt +
// expectedContentVersion + expectedCycleId). Request/decision stamp, cycle start/end, case pointers + version
// and the audit rows commit together. Stable ids + fingerprints (bound to actor, case, cycle, kind and intent):
// an exact retry replays; the same id with different intent conflicts. Approval never rebases: the request's
// snapshot (status, schedule, assignment, archive evidence, active delivery ids) must still hold.
// Outputs are counted once by delivery id; cycle snapshots only reference ids and are never summed.
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from './db.js';
import { CaseEditError } from './caseJsonEdits.js';
import { reasonProblem, scheduleOf } from './scheduleWorkflow.js';
import { REASON_CATEGORIES } from './reasonCategories.js';
import { summarize } from './deliveries.js';

const OP_ID = /^[A-Za-z0-9_-]{8,100}$/;
const OPEN_STATUSES = new Set(['todo', 'wait', 'doing', 'review', 'print']);
const RESUME_STATUS = 'doing';
const fail = (status, code, message, extra) => Object.assign(new CaseEditError(status, code, message), extra ? { extra } : {});
const conflict = () => fail(409, 'edit_conflict', '案件已被其他操作更新，請重新載入後再試；這次沒有寫入。');
const requestConflict = () => fail(409, 'lifecycle_request_conflict', '這個操作識別碼已用於其他內容；既有紀錄未更動，請重新整理後再操作。');
const clientUpdate = () => fail(409, 'client_update_required', '此案件的生命週期受控管，請重新整理頁面（需要最新版本與週期資訊）後再操作；這次沒有寫入。');
export const LIFECYCLE_PAUSED_MESSAGE = '未完成封存／復工流程目前暫停：既有週期與申請紀錄仍可查看，撤回與退回仍可使用；恢復後才能新導入、申請或核准。';
const paused = () => fail(409, 'lifecycle_workflow_paused', LIFECYCLE_PAUSED_MESSAGE);
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// LIFECYCLE_WORKFLOW_ENABLED=1 → new adoption / requests / approvals. Off never downgrades a managed case:
// its guards stay in force and history stays readable; withdraw and reject remain available.
export function lifecycleFlags(env = process.env) {
  return { workflowEnabled: env.LIFECYCLE_WORKFLOW_ENABLED === '1' };
}

// ── guards shared with the existing writers (called inside their own transaction / CAS) ────────────────
const SEALED_MESSAGE = '案件已未完成封存，僅供檢視；如需繼續，請提出復工申請並經主管核准。';
const CLOSED_MESSAGE = '受控案件已結案或取消，週期已結束，僅供檢視（本批不提供重新啟動）。';
const PENDING_MESSAGE = '此案件有待主管決議的封存／復工申請；請先等核准／退回或撤回申請，再進行這項異動。';
// `kind`: 'content' (logs, title/note…) is refused only when sealed; 'evidence' (items, deliveries, dates,
// status, assignment, archive path, counts, delivery/schedule workflow, transfer, cancel, archive) is also
// refused while a lifecycle request is pending.
// Completed / cancelled managed cases are read-only too (their cycle has ended); the only exception — a legacy
// closure-count correction on a completed case — is handled by lifecyclePatchCheck, not here.
export function lifecycleProblem(row, kind = 'evidence') {
  if (!row || row.lifecycleMode !== 'managed') return null;
  if (row.lifecycleStatus === 'sealed_incomplete') return fail(409, 'lifecycle_sealed', SEALED_MESSAGE);
  if (row.lifecycleStatus === 'completed' || row.lifecycleStatus === 'cancelled') return fail(409, 'lifecycle_closed', CLOSED_MESSAGE);
  if (kind === 'evidence' && row.pendingLifecycleRequestId) return fail(409, 'lifecycle_request_pending', PENDING_MESSAGE, { pendingRequestId: row.pendingLifecycleRequestId });
  return null;
}
export function assertLifecycle(row, kind) { const p = lifecycleProblem(row, kind); if (p) throw p; }
// Browser cycle binding for lifecycle-managed cases (never filled in from what the server just read).
export function cycleProblem(row, expectedCycleId) {
  if (!row || row.lifecycleMode !== 'managed') return null;
  if (expectedCycleId === undefined || expectedCycleId === null) return clientUpdate();
  if (expectedCycleId !== row.currentCycleId) return fail(409, 'cycle_conflict', '案件的工作週期已改變（例如剛封存或復工），請重新載入後再操作；這次沒有寫入。');
  return null;
}
export function assertCycle(row, expectedCycleId) { const p = cycleProblem(row, expectedCycleId); if (p) throw p; }
export const expectedCycleField = z.string().regex(OP_ID).nullable().optional();

// ── snapshots ───────────────────────────────────────────────────────────────────────────────────────────
const assignmentIds = row => ({ designerId: row.designerId, collaboratorIds: (row.collaborators || []).map(c => c.id).sort((a, b) => a - b) });
async function assignmentNamed(tx, row) {
  const ids = [row.designerId, ...(row.collaborators || []).map(c => c.id)];
  const staff = await tx.staff.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const name = id => staff.find(s => s.id === id)?.name ?? null;
  const a = assignmentIds(row);
  return { designerId: a.designerId, designerName: name(a.designerId), collaborators: a.collaboratorIds.map(id => ({ id, name: name(id) })) };
}
const activeDeliveryIds = async (tx, caseId) => (await tx.deliveryRecord.findMany({ where: { caseId, voidedAt: null }, select: { id: true }, orderBy: { id: 'asc' } })).map(r => r.id);
const cycleDeliveryIds = async (tx, caseId, cycleId) => (await tx.deliveryRecord.findMany({ where: { caseId, cycleId, voidedAt: null }, select: { id: true }, orderBy: { id: 'asc' } })).map(r => r.id);
const legacyCounts = row => ({ requestCount: row.requestCount ?? null, outputCount: row.outputCount ?? null });
// Structural JSON equality: object key order is irrelevant (PostgreSQL JSONB re-orders keys), array order and every
// value still matter; undefined members are dropped exactly as JSON.stringify drops them.
const canonical = v => (Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => [k, canonical(v[k])])) : v);
const sameJson = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// Closes the current open cycle in the caller's transaction (completion, cancellation or approved seal).
// `row` is the snapshot the caller claimed (its lifecycle status decides); the end evidence is read from the
// case as it stands inside this transaction.
export async function closeCycleInTx(tx, row, outcome, actor, reason, { endRequestId = null, noFile = null, finalStatus } = {}) {
  if (!row || row.lifecycleMode !== 'managed' || row.lifecycleStatus !== 'active') return;
  const fresh = await tx.case.findUnique({ where: { id: row.id }, include: { collaborators: { select: { id: true } } } });
  const endSnapshot = {
    status: finalStatus ?? fresh.status, schedule: scheduleOf(fresh), assignment: await assignmentNamed(tx, fresh),
    archivePath: String(fresh.archivePath ?? '').trim() || null, noFile,
    activeDeliveryIds: await activeDeliveryIds(tx, row.id), cycleDeliveryIds: await cycleDeliveryIds(tx, row.id, row.currentCycleId),
    legacyCounts: legacyCounts(fresh),
  };
  const text = String(reason ?? '').trim();
  const ended = await tx.caseCycle.updateMany({ where: { id: row.currentCycleId, caseId: row.id, endedAt: null }, data: {
    endedAt: new Date(), outcome, endedById: actor.id, endedByName: actor.name || '—', endReason: text.length >= 2 ? text.slice(0, 500) : `案件${outcome === 'completed' ? '結案' : '取消'}`,
    endRequestId, endSnapshot,
  } });
  if (ended.count !== 1) throw Object.assign(new Error('current cycle changed'), { caseWorkflow: true, status: 409, error: 'case_conflict', message: '案件已被其他操作更新，請重新載入案件後再試' });
}

// ── request parsing ─────────────────────────────────────────────────────────────────────────────────────
const versionFields = { expectedUpdatedAt: z.string().datetime({ offset: true }), expectedContentVersion: z.number().int().nonnegative(), expectedCycleId: expectedCycleField };
const needsVersions = b => b && typeof b === 'object' && (b.expectedUpdatedAt === undefined || b.expectedContentVersion === undefined);
const invalid = issues => Object.assign(fail(400, 'invalid_body', '內容格式不正確'), { issues });
function parse(schema, body) { const r = schema.safeParse(body); if (!r.success) throw invalid(r.error.issues); return r.data; }
const reasonField = z.string().superRefine((v, ctx) => { const p = reasonProblem(v); if (p) ctx.addIssue({ code: z.ZodIssueCode.custom, message: p }); }).transform(v => v.trim());
const adoptSchema = z.object({ requestId: z.string().regex(OP_ID), reason: reasonField, ...versionFields }).strict();
const evidenceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('archive'), archivePath: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ type: z.literal('no_file'), reason: reasonField }).strict(),
]);
const requestSchema = z.object({ id: z.string().regex(OP_ID), kind: z.enum(['seal', 'resume']), reasonCategory: z.enum(Object.keys(REASON_CATEGORIES)), reason: reasonField,
  evidence: evidenceSchema.optional(), ...versionFields }).strict()
  .superRefine((b, ctx) => {
    if (b.kind === 'seal' && !b.evidence) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: '封存申請須附歸檔位置，或明確聲明無可歸檔檔案並說明原因' });
    if (b.kind === 'resume' && b.evidence) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: '復工申請不附歸檔證據' });
  });
const withdrawSchema = z.object({ operationId: z.string().regex(OP_ID), reason: reasonField, ...versionFields }).strict();
const decideSchema = z.object({ operationId: z.string().regex(OP_ID), decision: z.enum(['approve', 'reject']), reason: z.string().max(500).optional(), ...versionFields }).strict();
export function parseAdopt(body) { if (needsVersions(body)) throw clientUpdate(); return parse(adoptSchema, body); }
export function parseRequest(body) { if (needsVersions(body) || (body && body.expectedCycleId === undefined)) throw clientUpdate(); return parse(requestSchema, body); }
export function parseWithdraw(body) { if (needsVersions(body) || (body && body.expectedCycleId === undefined)) throw clientUpdate(); return parse(withdrawSchema, body); }
export function parseDecide(body) {
  if (needsVersions(body) || (body && body.expectedCycleId === undefined)) throw clientUpdate();
  const input = parse(decideSchema, body);
  const reason = input.reason === undefined ? undefined : input.reason.trim();
  if (input.decision === 'reject') { const p = reasonProblem(reason); if (p) throw fail(422, 'reject_reason_required', '退回時請寫出具體原因：' + p); }
  else if (reason) { const p = reasonProblem(reason); if (p) throw invalid([{ path: ['reason'], message: p }]); }
  return { ...input, reason: reason || undefined };
}

// ── fingerprints (bound to actor, case, cycle, kind and normalized intent; versions excluded) ──────────
const evidenceIntent = e => (!e ? null : e.type === 'archive' ? ['archive', e.archivePath.trim()] : ['no_file', e.reason]);
export const adoptFingerprint = (actorId, caseId, input) => sha(['lifecycle.adopt.v1', caseId, actorId, input.reason]);
export const requestFingerprint = (actorId, caseId, input) => sha(['lifecycle.request.v1', caseId, actorId, input.expectedCycleId ?? null, input.kind, input.reasonCategory, input.reason, evidenceIntent(input.evidence)]);
export const withdrawFingerprint = (actorId, caseId, rid, input) => sha(['lifecycle.withdraw.v1', caseId, actorId, rid, input.expectedCycleId ?? null, input.reason]);
export const decideFingerprint = (actorId, caseId, rid, input) => sha(['lifecycle.decision.v1', caseId, actorId, rid, input.expectedCycleId ?? null, input.decision, input.reason ?? null]);

// ── shared transaction steps ────────────────────────────────────────────────────────────────────────────
async function loadActor(tx, user, { adminOnly = false } = {}) {
  const actor = await tx.staff.findUnique({ where: { id: user?.id ?? -1 }, select: { id: true, name: true, role: true, active: true, pendingActivation: true } });
  if (!actor || !actor.active || actor.pendingActivation) throw fail(403, 'actor_inactive', '帳號已停用或尚未啟用，無法執行此操作。');
  if (actor.role === 'observer') throw fail(403, 'read_only', '觀察者帳號為唯讀。');
  if (adminOnly && actor.role !== 'admin') throw fail(403, 'admin_only', '只有在職的管理員可以執行此操作。');
  return actor;
}
async function loadCase(tx, caseId) {
  const row = await tx.case.findUnique({ where: { id: caseId }, include: { collaborators: { select: { id: true } } } });
  if (!row) throw fail(404, 'not_found', '找不到案件');
  return row;
}
function assertAssigned(actor, row) {
  if (actor.role !== 'admin' && row.designerId !== actor.id && !row.collaborators.some(c => c.id === actor.id)) {
    throw fail(403, 'forbidden', '只有主負責人、協作者或管理員可以執行此操作。');
  }
}
function assertVersion(row, input) {
  if (row.contentVersion !== input.expectedContentVersion || new Date(input.expectedUpdatedAt).getTime() !== new Date(row.updatedAt).getTime()) throw conflict();
}
function assertManaged(row) {
  if (row.lifecycleMode !== 'managed') throw fail(409, 'lifecycle_not_managed', '此案件尚未導入生命週期管理。');
}
function assertNoOtherPending(row) {
  if (row.pendingDeliverySubmissionId || row.status === 'review_done') throw fail(409, 'delivery_pending_review', '案件正待主管核可交付；請先完成核可、退回或撤回送審，再申請。');
  if (row.pendingScheduleRequestId) throw fail(409, 'schedule_request_pending', '案件有待決議的改期申請；請先等核准／退回或撤回，再申請。');
}
async function claimCase(tx, row, data) {
  const previous = new Date(row.updatedAt), next = new Date(Math.max(Date.now(), previous.getTime() + 1));
  const claimed = await tx.case.updateMany({ where: { id: row.id, updatedAt: previous, contentVersion: row.contentVersion,
    lifecycleStatus: row.lifecycleStatus, currentCycleId: row.currentCycleId, pendingLifecycleRequestId: row.pendingLifecycleRequestId },
  data: { ...data, updatedAt: next, contentVersion: { increment: 1 } } });
  if (claimed.count !== 1) throw conflict();
  return { id: row.id, updatedAt: next.toISOString(), contentVersion: row.contentVersion + 1 };
}
async function audit(tx, caseId, changes, reason, operator) {
  if (changes.length) await tx.changeLog.createMany({ data: changes.map(change => ({ caseId, ...change, reason, operator })) });
}
const serializable = fn => prisma.$transaction(fn, { isolationLevel: 'Serializable' });
const retryable = e => e?.code === 'P2002' || e?.code === 'P2034';
const newCycleId = () => 'cycle-' + crypto.randomUUID();

export function serializeCycle(c) {
  if (!c) return null;
  return { id: c.id, caseId: c.caseId, sequence: c.sequence, source: c.source, startedAt: new Date(c.startedAt).toISOString(), startedById: c.startedById,
    startedByName: c.startedByName, startReason: c.startReason, startRequestId: c.startRequestId, startSnapshot: c.startSnapshot,
    open: !c.endedAt, endedAt: c.endedAt ? new Date(c.endedAt).toISOString() : null, outcome: c.outcome ?? null, endedById: c.endedById ?? null,
    endedByName: c.endedByName ?? null, endReason: c.endReason ?? null, endRequestId: c.endRequestId ?? null, endSnapshot: c.endSnapshot ?? null };
}
export function serializeRequest(r) {
  if (!r) return null;
  return { id: r.id, caseId: r.caseId, kind: r.kind, cycleId: r.cycleId, status: r.decision || 'pending', requestedById: r.requestedById, requestedByName: r.requestedByName,
    requestedAt: new Date(r.createdAt).toISOString(), reasonCategory: r.reasonCategory, reasonCategoryLabel: REASON_CATEGORIES[r.reasonCategory] || r.reasonCategory, reason: r.reason,
    evidence: r.kind !== 'seal' ? null : r.noFileDeclared ? { type: 'no_file', reason: r.noFileReason } : { type: 'archive', archivePath: r.archivePath },
    snapshot: r.snapshot, caseUpdatedAt: new Date(r.caseUpdatedAt).toISOString(), caseContentVersion: r.caseContentVersion,
    decision: r.decision || null, decidedAt: r.decidedAt ? new Date(r.decidedAt).toISOString() : null, decidedById: r.decidedById ?? null,
    decidedByName: r.decidedByName ?? null, decisionReason: r.decisionReason ?? null, resultCycleId: r.resultCycleId ?? null };
}
async function caseVersion(caseId) {
  const row = await prisma.case.findUnique({ where: { id: caseId }, select: { id: true, updatedAt: true, contentVersion: true, status: true, currentCycleId: true, lifecycleStatus: true } });
  return row ? { id: row.id, updatedAt: new Date(row.updatedAt).toISOString(), contentVersion: row.contentVersion, status: row.status, currentCycleId: row.currentCycleId, lifecycleStatus: row.lifecycleStatus } : null;
}
async function requestSnapshot(tx, row) {
  return { status: row.status, schedule: scheduleOf(row), assignment: assignmentIds(row), archivePath: String(row.archivePath ?? '').trim() || null,
    activeDeliveryIds: await activeDeliveryIds(tx, row.id) };
}

// ── adoption: legacy → managed (admin, one-way) ─────────────────────────────────────────────────────────
export async function adoptLifecycle(user, caseId, input) {
  const replay = async () => {
    const row = await prisma.case.findFirst({ where: { lifecycleModeRequestId: input.requestId } });
    if (!row) return null;
    if (row.id !== caseId || row.lifecycleModeFingerprint !== adoptFingerprint(user.id, caseId, input)) throw requestConflict();
    return { status: 200, replayed: true, case: await caseVersion(caseId), mode: 'managed', cycleId: row.currentCycleId };
  };
  try {
    const result = await serializable(async tx => {
      const actor = await loadActor(tx, user, { adminOnly: true });
      const prior = await tx.case.findFirst({ where: { lifecycleModeRequestId: input.requestId }, select: { id: true } });
      if (prior) return { replay: true };
      if (!lifecycleFlags().workflowEnabled) throw paused();
      const row = await loadCase(tx, caseId);
      if (row.lifecycleMode === 'managed') throw fail(409, 'already_managed', '此案件已導入生命週期管理。');
      if (row.archived || !OPEN_STATUSES.has(row.status)) throw fail(409, 'lifecycle_adoption_not_allowed', '只有未封存、在辦（非送審中、結案或取消）的案件可以導入。');
      assertNoOtherPending(row);
      assertVersion(row, input);
      if (input.expectedCycleId != null) throw fail(409, 'cycle_conflict', '導入前案件沒有工作週期；請重新載入後再操作。');
      const cycle = await tx.caseCycle.create({ data: {
        id: newCycleId(), caseId, sequence: 1, source: 'adoption', startedById: actor.id, startedByName: actor.name, startReason: input.reason, startRequestId: input.requestId,
        // Observed at adoption — never labelled an original promise; earlier deliveries keep unknown attribution.
        startSnapshot: { source: 'observed_at_adoption', attribution: 'legacy_unknown', status: row.status, schedule: scheduleOf(row), assignment: await assignmentNamed(tx, row),
          archivePath: row.archivePath ? String(row.archivePath) : null, carryForwardDeliveryIds: await activeDeliveryIds(tx, caseId), legacyCounts: legacyCounts(row), observedAt: new Date().toISOString() },
      } });
      const version = await claimCase(tx, row, {
        lifecycleMode: 'managed', lifecycleModeSince: new Date(), lifecycleModeById: actor.id, lifecycleModeByName: actor.name, lifecycleModeReason: input.reason,
        lifecycleModeRequestId: input.requestId, lifecycleModeFingerprint: adoptFingerprint(actor.id, caseId, input), lifecycleStatus: 'active', currentCycleId: cycle.id,
      });
      await audit(tx, caseId, [{ field: 'lifecycleMode', fromValue: 'legacy', toValue: 'managed' }], `導入生命週期管理（週期 1 ${cycle.id}）：${input.reason}`, actor.name);
      return { status: 201, replayed: false, case: { ...version, currentCycleId: cycle.id, lifecycleStatus: 'active', status: row.status }, mode: 'managed', cycleId: cycle.id };
    });
    return result.replay ? await replay() : result;
  } catch (e) {
    if (e instanceof CaseEditError) throw e;
    if (retryable(e)) { const r = await replay(); if (r) return r; throw conflict(); }
    throw e;
  }
}

// ── seal / resume request (admin / primary / collaborator) — nothing takes effect yet ──────────────────
async function replayRequest(prior, user, caseId, input) {
  if (prior.caseId !== caseId || prior.requestFingerprint !== requestFingerprint(user.id, caseId, input)) throw requestConflict();
  return { status: 200, replayed: true, request: serializeRequest(prior), case: await caseVersion(caseId) };
}
export async function requestLifecycle(user, caseId, input) {
  try {
    const result = await serializable(async tx => {
      const actor = await loadActor(tx, user);
      const prior = await tx.lifecycleRequest.findUnique({ where: { id: input.id } });
      if (prior) return { prior };
      const row = await loadCase(tx, caseId);
      assertManaged(row);
      if (!lifecycleFlags().workflowEnabled) throw paused();
      assertAssigned(actor, row);
      assertVersion(row, input);
      assertCycle(row, input.expectedCycleId);
      if (row.pendingLifecycleRequestId) throw fail(409, 'lifecycle_request_pending', PENDING_MESSAGE, { pendingRequestId: row.pendingLifecycleRequestId });
      assertNoOtherPending(row);
      let evidence = { archivePath: null, noFileDeclared: null, noFileReason: null };
      if (input.kind === 'seal') {
        if (row.lifecycleStatus !== 'active' || !OPEN_STATUSES.has(row.status) || row.archived) throw fail(409, 'lifecycle_seal_not_allowed', '只有進行中、未結案或取消的受控案件可以申請未完成封存。');
        if (input.evidence.type === 'archive') {
          const saved = String(row.archivePath ?? '').trim();
          if (!saved || saved !== input.evidence.archivePath.trim()) throw fail(409, 'archive_path_mismatch', '封存證據的歸檔位置必須與案件已儲存的歸檔位置相同；請先儲存歸檔位置，或改為聲明無可歸檔檔案並說明原因。');
          evidence = { archivePath: saved, noFileDeclared: null, noFileReason: null };
        } else evidence = { archivePath: null, noFileDeclared: true, noFileReason: input.evidence.reason };
      } else if (row.lifecycleStatus !== 'sealed_incomplete') {
        throw fail(409, 'lifecycle_resume_not_allowed', '只有已未完成封存的受控案件可以申請復工；已完成或取消的案件本批不提供重新啟動。');
      }
      const request = await tx.lifecycleRequest.create({ data: {
        id: input.id, caseId, kind: input.kind, cycleId: row.currentCycleId, requestFingerprint: requestFingerprint(actor.id, caseId, input),
        requestedById: actor.id, requestedByName: actor.name, reasonCategory: input.reasonCategory, reason: input.reason, ...evidence, snapshot: await requestSnapshot(tx, row),
        caseUpdatedAt: new Date(row.updatedAt), caseContentVersion: row.contentVersion,
      } });
      const version = await claimCase(tx, row, { pendingLifecycleRequestId: request.id });
      await audit(tx, caseId, [{ field: 'lifecycleRequest', fromValue: row.lifecycleStatus, toValue: `${input.kind}:pending` }],
        `提出${input.kind === 'seal' ? '未完成封存' : '復工'}申請（${request.id}，${REASON_CATEGORIES[input.reasonCategory]}）：${input.reason}${evidence.noFileDeclared ? '（聲明無可歸檔檔案：' + evidence.noFileReason + '）' : ''}`, actor.name);
      return { status: 201, replayed: false, request: serializeRequest(request), case: { ...version, currentCycleId: row.currentCycleId, lifecycleStatus: row.lifecycleStatus, status: row.status } };
    });
    return result.prior ? await replayRequest(result.prior, user, caseId, input) : result;
  } catch (e) {
    if (e instanceof CaseEditError) throw e;
    if (retryable(e)) {
      const prior = await prisma.lifecycleRequest.findUnique({ where: { id: input.id } });
      if (prior) return replayRequest(prior, user, caseId, input);
      throw conflict();
    }
    throw e;
  }
}

// ── decisions: withdraw (assigned) / approve / reject (admin) ──────────────────────────────────────────
async function replayDecision(stamped, expected, caseId, rid) {
  if (stamped.caseId !== caseId || stamped.id !== rid || stamped.decisionFingerprint !== expected) throw requestConflict();
  return { status: 200, replayed: true, request: serializeRequest(stamped), case: await caseVersion(caseId) };
}
async function stampDecision(tx, request, actor, decision, operationId, fingerprint, reason, resultCycleId) {
  const stamped = await tx.lifecycleRequest.updateMany({ where: { id: request.id, decidedAt: null }, data: {
    decision, decidedAt: new Date(), decidedById: actor.id, decidedByName: actor.name, decisionReason: reason ?? null,
    decisionOperationId: operationId, decisionFingerprint: fingerprint, resultCycleId: resultCycleId ?? null,
  } });
  if (stamped.count !== 1) throw conflict();
  return tx.lifecycleRequest.findUnique({ where: { id: request.id } });
}
async function pendingRequest(tx, caseId, rid, row) {
  const request = await tx.lifecycleRequest.findUnique({ where: { id: rid } });
  if (!request || request.caseId !== caseId) throw fail(404, 'lifecycle_request_not_found', '找不到這筆申請。');
  if (request.decidedAt) throw fail(409, 'lifecycle_request_closed', '這筆申請已被處理（核准、退回、撤回或失效），請重新整理。');
  if (row.pendingLifecycleRequestId !== rid || row.currentCycleId !== request.cycleId) throw fail(409, 'lifecycle_request_not_pending', '這筆申請已不是目前待決議的申請，請重新整理。');
  return request;
}
function decisionErrorWrap(fn, operationId, expected, caseId, rid) {
  return fn().catch(async e => {
    if (e instanceof CaseEditError) throw e;
    if (retryable(e)) {
      const stamped = await prisma.lifecycleRequest.findUnique({ where: { decisionOperationId: operationId } });
      if (stamped) return replayDecision(stamped, expected, caseId, rid);
      throw conflict();
    }
    throw e;
  });
}
export function withdrawLifecycleRequest(user, caseId, rid, input) {
  const expected = withdrawFingerprint(user.id, caseId, rid, input);
  return decisionErrorWrap(async () => {
    const result = await serializable(async tx => {
      const actor = await loadActor(tx, user);
      const done = await tx.lifecycleRequest.findUnique({ where: { decisionOperationId: input.operationId } });
      if (done) return { done };
      const row = await loadCase(tx, caseId);
      assertAssigned(actor, row);
      const request = await pendingRequest(tx, caseId, rid, row);
      assertVersion(row, input);
      assertCycle(row, input.expectedCycleId);
      // Withdraw stays available while the workflow is paused so a request never dead-ends.
      const stamped = await stampDecision(tx, request, actor, 'withdrawn', input.operationId, withdrawFingerprint(actor.id, caseId, rid, input), input.reason);
      const version = await claimCase(tx, row, { pendingLifecycleRequestId: null });
      await audit(tx, caseId, [{ field: 'lifecycleRequest', fromValue: `${request.kind}:pending`, toValue: 'withdrawn' }], `撤回${request.kind === 'seal' ? '封存' : '復工'}申請（${rid}）：${input.reason}`, actor.name);
      return { status: 200, replayed: false, request: serializeRequest(stamped), case: { ...version, currentCycleId: row.currentCycleId, lifecycleStatus: row.lifecycleStatus, status: row.status } };
    });
    return result.done ? replayDecision(result.done, expected, caseId, rid) : result;
  }, input.operationId, expected, caseId, rid);
}
export function decideLifecycleRequest(user, caseId, rid, input) {
  const expected = decideFingerprint(user.id, caseId, rid, input);
  return decisionErrorWrap(async () => {
    const result = await serializable(async tx => {
      const actor = await loadActor(tx, user, { adminOnly: true });
      const done = await tx.lifecycleRequest.findUnique({ where: { decisionOperationId: input.operationId } });
      if (done) return { done };
      const row = await loadCase(tx, caseId);
      assertManaged(row);
      const request = await pendingRequest(tx, caseId, rid, row);
      assertVersion(row, input);
      assertCycle(row, input.expectedCycleId);
      const fp = decideFingerprint(actor.id, caseId, rid, input);
      const label = request.kind === 'seal' ? '未完成封存' : '復工';
      if (input.decision === 'reject') {
        // Rejecting stays possible while paused so a request never dead-ends; nothing else changes.
        const stamped = await stampDecision(tx, request, actor, 'rejected', input.operationId, fp, input.reason);
        const version = await claimCase(tx, row, { pendingLifecycleRequestId: null });
        await audit(tx, caseId, [{ field: 'lifecycleRequest', fromValue: `${request.kind}:pending`, toValue: 'rejected' }], `退回${label}申請（${rid}）：${input.reason}`, actor.name);
        return { status: 200, replayed: false, request: serializeRequest(stamped), case: { ...version, currentCycleId: row.currentCycleId, lifecycleStatus: row.lifecycleStatus, status: row.status }, decision: 'reject' };
      }
      if (!lifecycleFlags().workflowEnabled) throw paused();
      // Never rebase: what the requester saw must still hold.
      const now = await requestSnapshot(tx, row);
      if (!sameJson({ ...now, archivePath: undefined }, { ...request.snapshot, archivePath: undefined })
          || (request.kind === 'seal' && !request.noFileDeclared && String(row.archivePath ?? '').trim() !== request.archivePath)) {
        throw fail(409, 'lifecycle_base_changed', '申請送出後，案件狀態、時程、指派、歸檔位置或交付紀錄已改變；這份申請不能直接核准，請退回後依最新內容重新申請。');
      }
      if (request.kind === 'seal') {
        if (row.lifecycleStatus !== 'active') throw fail(409, 'lifecycle_seal_not_allowed', '案件目前不在進行中的週期。');
        await closeCycleInTx(tx, row, 'sealed_incomplete', actor, `未完成封存（${rid}）：${request.reason}`,
          { endRequestId: rid, noFile: request.noFileDeclared ? { declared: true, reason: request.noFileReason } : null });
        const stamped = await stampDecision(tx, request, actor, 'approved', input.operationId, fp, input.reason);
        // Not completion, not cancellation: status, dates and outputs stay; no closedOn. archived hides it from work lists.
        const version = await claimCase(tx, row, { lifecycleStatus: 'sealed_incomplete', archived: true, pendingLifecycleRequestId: null });
        await audit(tx, caseId, [{ field: 'lifecycleStatus', fromValue: 'active', toValue: 'sealed_incomplete' }],
          `未完成封存核准（${rid}）：${request.reason}${request.noFileDeclared ? '（無可歸檔檔案：' + request.noFileReason + '）' : ''}${input.reason ? ' — 主管：' + input.reason : ''}`, actor.name);
        return { status: 200, replayed: false, request: serializeRequest(stamped), case: { ...version, currentCycleId: row.currentCycleId, lifecycleStatus: 'sealed_incomplete', status: row.status }, decision: 'approve' };
      }
      // Resume: one successor cycle, same case id, official dates unchanged (new dates go through D1a requests).
      if (row.lifecycleStatus !== 'sealed_incomplete') throw fail(409, 'lifecycle_resume_not_allowed', '案件目前不是未完成封存狀態。');
      const previous = await tx.caseCycle.findUnique({ where: { id: row.currentCycleId } });
      if (!previous || previous.caseId !== caseId || !previous.endedAt || previous.outcome !== 'sealed_incomplete') throw fail(409, 'lifecycle_resume_not_allowed', '目前週期不是已封存的週期。');
      const cycle = await tx.caseCycle.create({ data: {
        id: newCycleId(), caseId, sequence: previous.sequence + 1, source: 'resume', startedById: actor.id, startedByName: actor.name,
        startReason: request.reason, startRequestId: rid,
        startSnapshot: { source: 'resume_approved', attribution: 'cycle_tracked', status: RESUME_STATUS, resumedFromCycleId: previous.id, schedule: scheduleOf(row),
          assignment: await assignmentNamed(tx, row), archivePath: row.archivePath ? String(row.archivePath) : null, carryForwardDeliveryIds: now.activeDeliveryIds, legacyCounts: legacyCounts(row) },
      } });
      const stamped = await stampDecision(tx, request, actor, 'approved', input.operationId, fp, input.reason, cycle.id);
      const version = await claimCase(tx, row, { lifecycleStatus: 'active', currentCycleId: cycle.id, archived: false, status: RESUME_STATUS, closedOn: null, pendingLifecycleRequestId: null });
      await audit(tx, caseId, [{ field: 'lifecycleStatus', fromValue: 'sealed_incomplete', toValue: 'active' }, ...(row.status !== RESUME_STATUS ? [{ field: 'status', fromValue: row.status, toValue: RESUME_STATUS }] : [])],
        `復工核准（${rid}，週期 ${cycle.sequence} ${cycle.id}）：${request.reason}${input.reason ? ' — 主管：' + input.reason : ''}`, actor.name);
      return { status: 200, replayed: false, request: serializeRequest(stamped), case: { ...version, currentCycleId: cycle.id, lifecycleStatus: 'active', status: RESUME_STATUS }, decision: 'approve' };
    });
    return result.done ? replayDecision(result.done, expected, caseId, rid) : result;
  }, input.operationId, expected, caseId, rid);
}

// ── consistent read (one Serializable snapshot of case + cycles + requests + deliveries) ───────────────
export async function listLifecycle(caseId) {
  return serializable(async tx => {
    const row = await tx.case.findUnique({ where: { id: caseId }, select: {
      id: true, status: true, archived: true, updatedAt: true, contentVersion: true, requestCount: true, outputCount: true,
      lifecycleMode: true, lifecycleStatus: true, currentCycleId: true, pendingLifecycleRequestId: true,
      lifecycleModeSince: true, lifecycleModeByName: true, lifecycleModeReason: true,
    } });
    if (!row) throw fail(404, 'not_found', '找不到案件');
    const cycles = await tx.caseCycle.findMany({ where: { caseId }, orderBy: { sequence: 'asc' } });
    const requests = await tx.lifecycleRequest.findMany({ where: { caseId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
    const records = await tx.deliveryRecord.findMany({ where: { caseId }, select: { id: true, kind: true, unit: true, quantity: true, deliveredOn: true, note: true, cycleId: true, voidedAt: true } });
    const active = records.filter(r => !r.voidedAt);
    const current = cycles.find(c => c.id === row.currentCycleId) || null;
    const tracked = current ? active.filter(r => r.cycleId === current.id) : [];
    const unattributed = current && current.sequence === 1 ? active.filter(r => r.cycleId == null) : [];
    const flags = lifecycleFlags();
    return {
      caseId, mode: row.lifecycleMode, lifecycleStatus: row.lifecycleStatus ?? null, status: row.status, archived: row.archived,
      updatedAt: new Date(row.updatedAt).toISOString(), contentVersion: row.contentVersion, currentCycleId: row.currentCycleId ?? null,
      pendingRequestId: row.pendingLifecycleRequestId ?? null,
      reasonCategories: REASON_CATEGORIES, // REPORTS-P2-D2: same dictionary as the D1a requests
      adoption: row.lifecycleMode === 'managed' ? { since: new Date(row.lifecycleModeSince).toISOString(), byName: row.lifecycleModeByName, reason: row.lifecycleModeReason } : null,
      workflow: { ...flags, paused: row.lifecycleMode === 'managed' && !flags.workflowEnabled },
      outputs: {
        // Current cycle: deliveries recorded in it. Before-adoption records have unknown attribution (never 0).
        currentCycle: current ? { cycleId: current.id, sequence: current.sequence, summary: summarize(tracked), unattributedRecords: unattributed.length,
          status: unattributed.length ? 'partially_unknown' : tracked.length ? 'recorded' : 'none_recorded' } : null,
        // Whole case: every active delivery counted once by id; cycle snapshots and legacy counts are never added.
        cumulative: summarize(active), legacyCounts: legacyCounts(row),
      },
      cycles: cycles.map(serializeCycle), requests: requests.map(serializeRequest),
    };
  });
}

// ── direct PATCH on a lifecycle-managed case ───────────────────────────────────────────────────────────
// Returns { tracked:false, unchanged } for a true no-op, { error:[status, code, message, extra] } to refuse, or
// { tracked:true, unchanged, closing, extraChanges, needsReason } for a write that must go through the versioned,
// actor-revalidated claim (snapshotLifecycle). Unchanged fields are never written.
const DATE_FIELDS = new Set(['requestedOn', 'openDate', 'dispatchDate', 'copyDate', 'printDate', 'goLiveDate']);
const EVIDENCE_FIELDS = new Set([...DATE_FIELDS, 'status', 'designerId', 'collaboratorIds', 'archivePath', 'requestCount', 'outputCount', 'level', 'urgent']);
const REASON_FIELDS = new Set([...DATE_FIELDS, 'status', 'designerId', 'collaboratorIds', 'level', 'urgent']);
const META_FIELDS = new Set(['reason', 'expectedUpdatedAt', 'expectedContentVersion', 'expectedCycleId']);
const ymdOf = v => (v == null ? null : (v instanceof Date ? v : new Date(v)).toISOString().slice(0, 10));
const collabSet = (ids, designerId) => [...new Set(ids)].filter(id => id !== designerId).sort((a, b) => a - b).join(',');
function fieldChanged(existing, body, f) {
  if (f === 'collaboratorIds') return collabSet((existing.collaborators || []).map(c => c.id), existing.designerId) !== collabSet(body.collaboratorIds, body.designerId ?? existing.designerId);
  if (DATE_FIELDS.has(f)) return ymdOf(existing[f]) !== ymdOf(body[f]);
  if (f === 'deliverables') return !sameJson(existing[f] ?? null, body[f] ?? null);
  return (existing[f] ?? null) !== (body[f] ?? null);
}
export function lifecyclePatchCheck(existing, body) {
  if (!existing || existing.lifecycleMode !== 'managed') return { tracked: false };
  const keys = Object.keys(body).filter(k => !META_FIELDS.has(k) && body[k] !== undefined);
  const changed = keys.filter(k => fieldChanged(existing, body, k));
  const unchanged = keys.filter(k => !changed.includes(k));
  if (!changed.length) return { tracked: false, unchanged };
  if (existing.lifecycleStatus === 'sealed_incomplete') return { error: [409, 'lifecycle_sealed', SEALED_MESSAGE] };
  const statusChange = changed.includes('status');
  if (existing.lifecycleStatus === 'completed' || existing.lifecycleStatus === 'cancelled') {
    if (statusChange) return { error: [409, 'lifecycle_reopen_unavailable', '受控案件結案或取消後本批不提供重新啟動。'] };
    // Read-only, except a legacy closure-count correction on a completed case (still versioned, cycle-bound, audited).
    const countsOnly = changed.every(k => k === 'requestCount' || k === 'outputCount');
    if (existing.lifecycleStatus !== 'completed' || !countsOnly) return { error: [409, 'lifecycle_closed', CLOSED_MESSAGE] };
  }
  if (existing.pendingLifecycleRequestId && changed.some(k => EVIDENCE_FIELDS.has(k))) {
    return { error: [409, 'lifecycle_request_pending', PENDING_MESSAGE, { pendingRequestId: existing.pendingLifecycleRequestId }] };
  }
  if (body.expectedUpdatedAt === undefined || body.expectedContentVersion === undefined || body.expectedCycleId === undefined) {
    return { error: [409, 'client_update_required', '此案件的生命週期受控管，請重新整理頁面（需要最新版本與週期資訊）後再修改；這次沒有寫入。'] };
  }
  if (body.expectedCycleId !== existing.currentCycleId) return { error: [409, 'cycle_conflict', '案件的工作週期已改變，請重新載入後再修改；這次沒有寫入。'] };
  const needsReason = changed.some(k => REASON_FIELDS.has(k));
  if (needsReason) { const p = reasonProblem(body.reason); if (p) return { error: [422, 'reason_required', p] }; }
  if (existing.contentVersion !== body.expectedContentVersion || new Date(body.expectedUpdatedAt).getTime() !== new Date(existing.updatedAt).getTime()) {
    return { error: [409, 'edit_conflict', '案件已被其他操作更新，請重新載入後再試；這次沒有寫入。'] };
  }
  const closing = statusChange && existing.lifecycleStatus === 'active' && (body.status === 'done' || body.status === 'closed');
  const extraChanges = [];
  if (changed.includes('collaboratorIds')) extraChanges.push({ field: 'collaborators', fromValue: collabSet((existing.collaborators || []).map(c => c.id), existing.designerId) || '—', toValue: collabSet(body.collaboratorIds, body.designerId ?? existing.designerId) || '—' });
  for (const f of ['printDate', 'openDate', 'requestedOn']) if (changed.includes(f)) extraChanges.push({ field: f, fromValue: ymdOf(existing[f]) ?? '', toValue: ymdOf(body[f]) ?? '' });
  for (const f of ['requestCount', 'outputCount', 'archivePath']) if (changed.includes(f)) extraChanges.push({ field: f, fromValue: existing[f] == null ? '' : String(existing[f]), toValue: body[f] == null ? '' : String(body[f]) });
  return { tracked: true, unchanged, closing, extraChanges };
}
