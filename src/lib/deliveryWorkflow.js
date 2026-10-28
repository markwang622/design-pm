// REPORTS-P1-C1: delivery-records submission and approval.
//
// Every mutation re-reads, inside ONE Serializable transaction: the active signed-in actor
// (active / pendingActivation / current role), current primary/collaborator assignment, the
// case mode, status and the browser-supplied version (expectedUpdatedAt + expectedContentVersion),
// the archive path and the active delivery records. It then writes the submission/decision stamp,
// the audit row and the case version together. Each operation carries a stable client id and an
// operation-specific fingerprint: the identical retry returns the stored result without rewriting
// anything; the same id with a different payload/actor/case/target submission conflicts.
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from './db.js';
import { CaseEditError } from './caseJsonEdits.js';
import { summarize } from './deliveries.js';
import { deliveryFlags, PAUSED_MESSAGE } from './deliveryFlags.js';
import { taipeiCalendarDay } from '../services/analytics.js';
import { assertLifecycle, assertCycle, closeCycleInTx } from './caseLifecycle.js';

const OP_ID = /^[A-Za-z0-9_-]{8,100}$/;
const ACTIVE_STATUSES = new Set(['todo', 'wait', 'doing', 'review', 'print']);
const TERMINAL = new Set(['done', 'closed']);
const fail = (status, code, message) => new CaseEditError(status, code, message);
const conflict = () => fail(409, 'edit_conflict', '案件已被其他操作更新，請重新載入後再試；這次沒有寫入。');
const requestConflict = () => fail(409, 'delivery_request_conflict', '這個操作識別碼已用於其他內容；既有紀錄未更動，請重新整理後再操作。');
const paused = () => fail(409, 'delivery_workflow_paused', PAUSED_MESSAGE);
const clientUpdate = () => fail(409, 'client_update_required', '這個案件已採交付明細制，請重新整理頁面（需要最新版本資訊）後再操作；這次沒有寫入。');
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ymd = value => (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
// REPORTS-P2-D1b: expectedCycleId is required (checked in the transaction) on lifecycle-managed cases.
const versionFields = { expectedUpdatedAt: z.string().datetime({ offset: true }), expectedContentVersion: z.number().int().nonnegative(),
  expectedCycleId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/).nullable().optional() };
const invalid = issues => Object.assign(fail(400, 'invalid_body', '內容格式不正確'), { issues });
function parse(schema, body) { const r = schema.safeParse(body); if (!r.success) throw invalid(r.error.issues); return r.data; }

// ── request parsing ──────────────────────────────────────────────────────────
const adoptSchema = z.object({ requestId: z.string().regex(OP_ID), reason: z.string().trim().min(2).max(500), ...versionFields }).strict();
const submitSchema = z.object({ id: z.string().regex(OP_ID), completenessConfirmed: z.boolean().optional(), ...versionFields }).strict();
const withdrawSchema = z.object({ id: z.string().regex(OP_ID), reason: z.string().trim().min(2).max(500), ...versionFields }).strict();
const decisionSchema = z.object({
  decision: z.enum(['approve', 'reject']), submissionId: z.string().regex(OP_ID), operationId: z.string().regex(OP_ID),
  comment: z.string().trim().max(1000).optional(), zeroSupportApproved: z.boolean().optional(), ...versionFields,
}).strict();
export const parseAdopt = body => parse(adoptSchema, body);
export function parseSubmit(body) {
  // A missing version means an outdated page: refuse explicitly instead of submitting on the user's behalf.
  if (body && typeof body === 'object' && (body.expectedUpdatedAt === undefined || body.expectedContentVersion === undefined)) throw clientUpdate();
  const input = parse(submitSchema, body);
  if (input.completenessConfirmed !== true) throw fail(422, 'completeness_confirmation_required', '送審前請確認本案交付已完整登錄。');
  return input;
}
export function parseWithdraw(body) {
  if (body && typeof body === 'object' && (body.expectedUpdatedAt === undefined || body.expectedContentVersion === undefined)) throw clientUpdate();
  return parse(withdrawSchema, body);
}
// Records-mode /approve: an old client sends only {decision, comment} → explicit update request.
export function parseDecision(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.submissionId === undefined || b.operationId === undefined || b.expectedUpdatedAt === undefined || b.expectedContentVersion === undefined) throw clientUpdate();
  const input = parse(decisionSchema, b);
  if (input.decision === 'reject' && (!input.comment || input.comment.length < 2)) throw fail(422, 'reject_reason_required', '退回時請填寫原因（至少 2 個字），讓設計師知道要修正什麼。');
  return input;
}

// ── fingerprints ─────────────────────────────────────────────────────────────
export const adoptFingerprint = (actorId, caseId, input) => sha(['delivery.adopt.v1', caseId, actorId, input.reason]);
// REPORTS-P2-D1b: a supplied browser cycle id is part of the intent (appended only when present, so existing
// legacy fingerprints are unchanged).
const withCycle = (intent, input) => (input.expectedCycleId != null ? [...intent, input.expectedCycleId] : intent);
export const submitFingerprint = (actorId, caseId, input) => sha(withCycle(['delivery.submit.v1', caseId, actorId, input.completenessConfirmed === true], input));
export const withdrawFingerprint = (actorId, caseId, submissionId, input) => sha(withCycle(['delivery.withdraw.v1', caseId, actorId, submissionId, input.reason], input));
export const decisionFingerprint = (actorId, caseId, input) => sha(withCycle(['delivery.decision.v1', caseId, actorId, input.submissionId, input.decision, input.comment ?? null, input.zeroSupportApproved ?? null], input));
function recordsFingerprint(records) {
  return sha(records.map(r => [r.id, r.kind, r.quantity, r.unit, ymd(r.deliveredOn), r.itemKey ?? null, r.itemName, r.note ?? null]));
}

// ── shared transaction steps ─────────────────────────────────────────────────
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
async function claimCase(tx, row, data) {
  const previous = new Date(row.updatedAt), next = new Date(Math.max(Date.now(), previous.getTime() + 1));
  const claimed = await tx.case.updateMany({ where: { id: row.id, updatedAt: previous, contentVersion: row.contentVersion }, data: { ...data, updatedAt: next, contentVersion: { increment: 1 } } });
  if (claimed.count !== 1) throw conflict();
  return { id: row.id, updatedAt: next.toISOString(), contentVersion: row.contentVersion + 1 };
}
async function audit(tx, caseId, changes, reason, operator) {
  if (changes.length) await tx.changeLog.createMany({ data: changes.map(change => ({ caseId, ...change, reason, operator })) });
}
const activeRecords = (tx, caseId) => tx.deliveryRecord.findMany({ where: { caseId, voidedAt: null }, orderBy: { id: 'asc' } });
const serializable = fn => prisma.$transaction(fn, { isolationLevel: 'Serializable' });
const retryable = e => e?.code === 'P2002' || e?.code === 'P2034';

export function serializeSubmission(s) {
  if (!s) return null;
  return {
    id: s.id, caseId: s.caseId, submittedById: s.submittedById, submittedByName: s.submittedByName, submittedAt: new Date(s.createdAt).toISOString(),
    completenessConfirmed: s.completenessConfirmed, caseContentVersion: s.caseContentVersion, archivePath: s.archivePath,
    recordIds: s.recordIds, recordsFingerprint: s.recordsFingerprint, summary: s.summary, zeroSupport: s.zeroSupport,
    itemsSnapshot: s.itemsSnapshot, legacyCounts: s.legacyCounts, status: s.decision || 'pending',
    decision: s.decision || null, decidedAt: s.decidedAt ? new Date(s.decidedAt).toISOString() : null,
    decidedById: s.decidedById ?? null, decidedByName: s.decidedByName ?? null, decisionReason: s.decisionReason ?? null,
    zeroSupportApproved: s.zeroSupportApproved ?? null,
  };
}
async function caseVersion(caseId) {
  const row = await prisma.case.findUnique({ where: { id: caseId }, select: { id: true, updatedAt: true, contentVersion: true, status: true } });
  return row ? { id: row.id, updatedAt: new Date(row.updatedAt).toISOString(), contentVersion: row.contentVersion, status: row.status } : null;
}

// ── adoption: legacy → records (admin, one-way) ──────────────────────────────
export async function adoptRecords(user, caseId, input) {
  const replay = async () => {
    const row = await prisma.case.findFirst({ where: { deliveryModeRequestId: input.requestId } });
    if (!row) return null;
    if (row.id !== caseId || row.deliveryModeFingerprint !== adoptFingerprint(user.id, caseId, input)) throw requestConflict();
    return { status: 200, replayed: true, case: await caseVersion(caseId), mode: 'records' };
  };
  try {
    const result = await serializable(async tx => {
      const actor = await loadActor(tx, user, { adminOnly: true });
      const prior = await tx.case.findFirst({ where: { deliveryModeRequestId: input.requestId }, select: { id: true } });
      if (prior) return { replay: true };
      if (!deliveryFlags().workflowActive) throw paused();
      const row = await loadCase(tx, caseId);
      if (row.deliveryMode === 'records') throw fail(409, 'already_records', '此案件已採交付明細制。');
      assertLifecycle(row, 'evidence'); // REPORTS-P2-D1b
      assertCycle(row, input.expectedCycleId);
      if (row.archived || row.status === 'cancelled' || row.status === 'review_done' || TERMINAL.has(row.status)) {
        throw fail(409, 'adoption_not_allowed', '只有未封存、在辦且未送主管核可的案件可以導入交付明細制。');
      }
      assertVersion(row, input);
      const version = await claimCase(tx, row, {
        deliveryMode: 'records', deliveryModeSince: new Date(), deliveryModeById: actor.id, deliveryModeByName: actor.name,
        deliveryModeReason: input.reason, deliveryModeRequestId: input.requestId, deliveryModeFingerprint: adoptFingerprint(actor.id, caseId, input),
      });
      await audit(tx, caseId, [{ field: 'deliveryMode', fromValue: 'legacy', toValue: 'records' }], `導入交付明細制：${input.reason}`, actor.name);
      return { status: 201, replayed: false, case: version, mode: 'records' };
    });
    return result.replay ? await replay() : result;
  } catch (e) {
    if (e instanceof CaseEditError) throw e;
    if (retryable(e)) { const r = await replay(); if (r) return r; throw conflict(); }
    throw e;
  }
}

// ── submit (admin / primary / collaborator) ──────────────────────────────────
async function replaySubmit(prior, user, caseId, input) {
  if (prior.caseId !== caseId || prior.requestFingerprint !== submitFingerprint(user.id, caseId, input)) throw requestConflict();
  return { status: 200, replayed: true, submission: serializeSubmission(prior), case: await caseVersion(caseId) };
}
export async function submitDeliveries(user, caseId, input) {
  try {
    const result = await serializable(async tx => {
      const actor = await loadActor(tx, user);
      const prior = await tx.deliverySubmission.findUnique({ where: { id: input.id } });
      if (prior) return { prior };
      const row = await loadCase(tx, caseId);
      if (row.deliveryMode !== 'records') throw fail(409, 'not_records_mode', '此案件為舊制（無交付日期明細），請沿用原本的送審方式。');
      if (!deliveryFlags().workflowActive) throw paused();
      assertAssigned(actor, row);
      // REPORTS-P2-D1b: no delivery review while sealed / a seal-resume request is pending; browser cycle bound.
      assertLifecycle(row, 'evidence');
      assertCycle(row, input.expectedCycleId);
      // REPORTS-P2-D1a: an open schedule request must be decided or withdrawn before delivery review.
      if (row.pendingScheduleRequestId) throw fail(409, 'schedule_request_pending', '此案件有待主管決議的改期申請；請先等核准／退回或撤回改期申請，再送審交付。');
      if (row.status === 'review_done') throw fail(409, 'already_submitted', '此案件已送主管核可；如需更正請先撤回。');
      if (row.archived || !ACTIVE_STATUSES.has(row.status)) throw fail(409, 'case_locked', '案件已結案、取消或封存，無法送審。');
      assertVersion(row, input);
      if (!row.archivePath || !String(row.archivePath).trim()) throw fail(422, 'archive_path_required', '送審前請先填寫檔案歸檔位置。');
      const records = await activeRecords(tx, caseId);
      if (!records.length) throw fail(422, 'deliveries_required', '送審前至少需要一筆有效交付；全部作廢視為尚未登錄。');
      const items = (Array.isArray(row.items) ? row.items : []).filter(it => it && typeof it === 'object' && !Array.isArray(it));
      const submission = await tx.deliverySubmission.create({ data: {
        id: input.id, caseId, requestFingerprint: submitFingerprint(actor.id, caseId, input), submittedById: actor.id, submittedByName: actor.name,
        completenessConfirmed: true, caseContentVersion: row.contentVersion, caseUpdatedAt: new Date(row.updatedAt), archivePath: String(row.archivePath),
        recordIds: records.map(r => r.id), recordsFingerprint: recordsFingerprint(records), summary: summarize(records).groups,
        zeroSupport: records.filter(r => r.kind === 'support' && r.quantity === 0).map(r => ({ id: r.id, itemName: r.itemName, note: r.note })),
        itemsSnapshot: items.map(it => ({ key: typeof it.key === 'string' ? it.key : null, n: String(it.n ?? '') })),
        legacyCounts: { requestCount: row.requestCount, outputCount: row.outputCount },
      } });
      const version = await claimCase(tx, row, { status: 'review_done', pendingDeliverySubmissionId: submission.id, closedOn: null });
      await audit(tx, caseId, [{ field: 'status', fromValue: row.status, toValue: 'review_done' }], `交付明細送審（${submission.id}）`, actor.name);
      return { status: 201, replayed: false, submission: serializeSubmission(submission), case: version };
    });
    return result.prior ? await replaySubmit(result.prior, user, caseId, input) : result;
  } catch (e) {
    if (e instanceof CaseEditError) throw e;
    if (retryable(e)) {
      const prior = await prisma.deliverySubmission.findUnique({ where: { id: input.id } });
      if (prior) return replaySubmit(prior, user, caseId, input);
      throw conflict();
    }
    throw e;
  }
}

// ── decisions: withdraw (assigned) / approve / reject (admin) ────────────────
async function replayDecision(stamped, expected) {
  if (stamped.decisionFingerprint !== expected) throw requestConflict();
  return { status: 200, replayed: true, submission: serializeSubmission(stamped), case: await caseVersion(stamped.caseId) };
}
async function stampDecision(tx, submission, actor, decision, operationId, fingerprint, reason, zeroSupportApproved) {
  const stamped = await tx.deliverySubmission.updateMany({ where: { id: submission.id, decidedAt: null }, data: {
    decision, decidedAt: new Date(), decidedById: actor.id, decidedByName: actor.name, decisionReason: reason ?? null,
    decisionOperationId: operationId, decisionFingerprint: fingerprint, zeroSupportApproved: decision === 'approved' ? !!zeroSupportApproved : null,
  } });
  if (stamped.count !== 1) throw conflict();
  return tx.deliverySubmission.findUnique({ where: { id: submission.id } });
}
async function pendingSubmission(tx, caseId, submissionId, row) {
  const submission = await tx.deliverySubmission.findUnique({ where: { id: submissionId } });
  if (!submission || submission.caseId !== caseId) throw fail(404, 'submission_not_found', '找不到這筆送審紀錄。');
  if (submission.decidedAt) throw fail(409, 'submission_closed', '這筆送審已被處理（核可、退回、撤回或取消），請重新整理。');
  if (row.deliveryMode !== 'records' || row.status !== 'review_done' || row.pendingDeliverySubmissionId !== submissionId) {
    throw fail(409, 'submission_not_pending', '這筆送審已不是目前待核可的版本，請重新整理。');
  }
  return submission;
}
function decisionErrorWrap(fn, operationId, expected) {
  return fn().catch(async e => {
    if (e instanceof CaseEditError) throw e;
    if (retryable(e)) {
      const stamped = await prisma.deliverySubmission.findUnique({ where: { decisionOperationId: operationId } });
      if (stamped) return replayDecision(stamped, expected);
      throw conflict();
    }
    throw e;
  });
}
export function withdrawSubmission(user, caseId, submissionId, input) {
  const expected = withdrawFingerprint(user.id, caseId, submissionId, input);
  return decisionErrorWrap(async () => {
    const result = await serializable(async tx => {
      const actor = await loadActor(tx, user);
      const done = await tx.deliverySubmission.findUnique({ where: { decisionOperationId: input.id } });
      if (done) return { done };
      const row = await loadCase(tx, caseId);
      assertAssigned(actor, row);
      const submission = await pendingSubmission(tx, caseId, submissionId, row);
      assertVersion(row, input);
      assertCycle(row, input.expectedCycleId); // REPORTS-P2-D1b
      // Withdraw stays available while the workflow is paused so a submitted case never dead-ends.
      const stamped = await stampDecision(tx, submission, actor, 'withdrawn', input.id, withdrawFingerprint(actor.id, caseId, submissionId, input), input.reason);
      const version = await claimCase(tx, row, { status: 'doing', pendingDeliverySubmissionId: null, archived: false, closedOn: null });
      await audit(tx, caseId, [{ field: 'status', fromValue: 'review_done', toValue: 'doing' }], `撤回送審（${submissionId}）：${input.reason}`, actor.name);
      return { status: 200, replayed: false, submission: serializeSubmission(stamped), case: version };
    });
    return result.done ? replayDecision(result.done, expected) : result;
  }, input.id, expected);
}
export function decideSubmission(user, caseId, input) {
  const expected = decisionFingerprint(user.id, caseId, input);
  return decisionErrorWrap(async () => {
    const result = await serializable(async tx => {
      const actor = await loadActor(tx, user, { adminOnly: true });
      const done = await tx.deliverySubmission.findUnique({ where: { decisionOperationId: input.operationId } });
      if (done) return { done };
      const row = await loadCase(tx, caseId);
      if (row.deliveryMode !== 'records') throw fail(409, 'not_records_mode', '此案件為舊制，請使用原本的核可方式。');
      const submission = await pendingSubmission(tx, caseId, input.submissionId, row);
      assertVersion(row, input);
      assertCycle(row, input.expectedCycleId); // REPORTS-P2-D1b
      const fp = decisionFingerprint(actor.id, caseId, input);
      if (input.decision === 'reject') {
        // Rejecting must stay possible even when the archive path or deliveries are incomplete or paused.
        const stamped = await stampDecision(tx, submission, actor, 'rejected', input.operationId, fp, input.comment);
        const version = await claimCase(tx, row, { status: 'doing', pendingDeliverySubmissionId: null, archived: false, closedOn: null });
        await audit(tx, caseId, [{ field: 'status', fromValue: 'review_done', toValue: 'doing' }], `退回修改（${submission.id}）— ${input.comment}`, actor.name);
        return { status: 200, replayed: false, submission: serializeSubmission(stamped), case: version, decision: 'reject' };
      }
      if (!deliveryFlags().workflowActive) throw paused();
      const records = await activeRecords(tx, caseId);
      if (!row.archivePath || String(row.archivePath) !== submission.archivePath || recordsFingerprint(records) !== submission.recordsFingerprint) {
        throw fail(409, 'submission_evidence_changed', '送審後的歸檔位置或交付明細已不同於送審摘要，不能核可；請退回讓設計師重新送審。');
      }
      const zeroCount = Array.isArray(submission.zeroSupport) ? submission.zeroSupport.length : 0;
      if (zeroCount > 0 && input.zeroSupportApproved !== true) {
        throw fail(422, 'zero_support_confirmation_required', `此送審含 ${zeroCount} 筆數量為 0 的支援工作，核可前請確認已審閱並核可其說明。`);
      }
      const stamped = await stampDecision(tx, submission, actor, 'approved', input.operationId, fp, input.comment || null, input.zeroSupportApproved === true);
      // REPORTS-P2-D1b: completion closes the current cycle as `completed` in the same transaction.
      const lifecycleManaged = row.lifecycleMode === 'managed' && row.lifecycleStatus === 'active';
      const version = await claimCase(tx, row, { status: 'closed', archived: true, closedOn: taipeiCalendarDay(), pendingDeliverySubmissionId: null,
        ...(lifecycleManaged && { lifecycleStatus: 'completed' }) });
      if (lifecycleManaged) await closeCycleInTx(tx, row, 'completed', actor, `審核通過（${submission.id}）`, { finalStatus: 'closed' });
      await audit(tx, caseId, [{ field: 'status', fromValue: 'review_done', toValue: 'closed' }], `審核通過（${submission.id}）${input.comment ? ' — ' + input.comment : ''}`, actor.name);
      return { status: 200, replayed: false, submission: serializeSubmission(stamped), case: version, decision: 'approve' };
    });
    return result.done ? replayDecision(result.done, expected) : result;
  }, input.operationId, expected);
}

// Used by the cancel route inside its own workflow transaction: a pending submission can never
// survive a cancellation (and so can never be approved later).
export async function cancelPendingSubmissionInTx(tx, row, reason, operatorName, operatorId) {
  if (!row.pendingDeliverySubmissionId) return;
  const operationId = 'cancel-' + crypto.randomUUID();
  const stamped = await tx.deliverySubmission.updateMany({ where: { id: row.pendingDeliverySubmissionId, decidedAt: null }, data: {
    decision: 'cancelled', decidedAt: new Date(), decidedById: operatorId, decidedByName: operatorName, decisionReason: reason,
    decisionOperationId: operationId, decisionFingerprint: sha(['delivery.cancel.v1', row.id, operatorId, row.pendingDeliverySubmissionId, reason]), zeroSupportApproved: null,
  } });
  if (stamped.count !== 1) throw Object.assign(new Error('pending submission changed'), { caseWorkflow: true, status: 409, error: 'case_conflict', message: '案件已被其他操作更新，請重新載入案件後再試' });
}

export async function listSubmissions(caseId) {
  const row = await prisma.case.findUnique({ where: { id: caseId }, select: { id: true, deliveryMode: true, pendingDeliverySubmissionId: true, status: true, updatedAt: true, contentVersion: true, lifecycleMode: true, lifecycleStatus: true, currentCycleId: true, pendingLifecycleRequestId: true } });
  if (!row) throw fail(404, 'not_found', '找不到案件');
  const rows = await prisma.deliverySubmission.findMany({ where: { caseId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
  const flags = deliveryFlags();
  return {
    caseId, mode: row.deliveryMode, status: row.status, updatedAt: new Date(row.updatedAt).toISOString(), contentVersion: row.contentVersion,
    // REPORTS-P2-D2: cycle + lifecycle read in the SAME row as the versions above (one consistent snapshot for writers).
    lifecycleMode: row.lifecycleMode || 'legacy', lifecycleStatus: row.lifecycleStatus ?? null, currentCycleId: row.currentCycleId ?? null,
    pendingLifecycleRequestId: row.pendingLifecycleRequestId ?? null,
    pendingSubmissionId: row.pendingDeliverySubmissionId, workflow: { ...flags, paused: row.deliveryMode === 'records' && !flags.workflowActive },
    submissions: rows.map(serializeSubmission),
  };
}
