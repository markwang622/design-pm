// REPORTS-P2-D1a: managed schedule mode, schedule-change requests and manager decisions.
//
// Confirmed rule (policy-decision.json, 2026-10-26): every postponement of a parent milestone
// (dispatchDate / copyDate / printDate / goLiveDate) needs manager approval; moving one earlier needs a
// meaningful reason; clearing an existing optional deadline (copyDate / printDate) also needs approval
// (anti-bypass). An empty optional date stays historically unknown.
// Child-item dates are not covered by this slice.
//
// Same transaction model as REPORTS-P1-C1: every mutation re-reads, inside ONE Serializable
// transaction, the active signed-in actor (active / pendingActivation / current role), the current
// primary/collaborator assignment, the case mode/status and the browser-supplied version
// (expectedUpdatedAt + expectedContentVersion). Request/decision stamp, case dates + version and the
// audit rows commit together. Stable client ids + operation fingerprints: the identical retry
// returns the stored result; the same id with different intent conflicts. A proposal never changes
// the official dates; approval applies exactly the immutable proposal once, and only if the current
// schedule and assignment still equal the request's snapshot (never rebased silently).
// Reason categories are for filing and reading only: they are not an automatic exoneration and do
// not change any KPI denominator or completion count.
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from './db.js';
import { CaseEditError } from './caseJsonEdits.js';
import { assertLifecycle, assertCycle } from './caseLifecycle.js';

const OP_ID = /^[A-Za-z0-9_-]{8,100}$/;
export const MILESTONES = ['dispatchDate', 'copyDate', 'printDate', 'goLiveDate'];
const OPEN_FOR_REQUESTS = new Set(['todo', 'wait', 'doing', 'review', 'print']);
export { REASON_CATEGORIES } from './reasonCategories.js';
import { REASON_CATEGORIES } from './reasonCategories.js';
const fail = (status, code, message) => new CaseEditError(status, code, message);
const conflict = () => fail(409, 'edit_conflict', '案件已被其他操作更新，請重新載入後再試；這次沒有寫入。');
const requestConflict = () => fail(409, 'schedule_request_conflict', '這個操作識別碼已用於其他內容；既有紀錄未更動，請重新整理後再操作。');
const clientUpdate = () => fail(409, 'client_update_required', '此案件的時程受控管，請重新整理頁面（需要最新版本資訊）後再操作；這次沒有寫入。');
export const SCHEDULE_PAUSED_MESSAGE = '時程異動申請目前暫停：既有申請紀錄仍可查看，撤回與退回仍可使用；恢復後才能新申請、導入或核准。';
const paused = () => fail(409, 'schedule_workflow_paused', SCHEDULE_PAUSED_MESSAGE);
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// SCHEDULE_WORKFLOW_ENABLED=1 → new adoption / requests / approvals. Off never downgrades a managed
// case: its PATCH date guards stay in force and history stays readable.
export function scheduleFlags(env = process.env) {
  return { workflowEnabled: env.SCHEDULE_WORKFLOW_ENABLED === '1' };
}

// ── values ──────────────────────────────────────────────────────────────────
export const ymd = value => (value == null ? null : (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10));
export function realDay(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(text + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === text && text >= '2000-01-01' && text <= '2100-12-31';
}
const dayField = z.string().refine(realDay, '請填有效的日期（YYYY-MM-DD）');
const PLACEHOLDERS = new Set(['—', '-', '--', 'n/a', 'na', 'none', 'null', 'tbd', 'todo', 'test', 'ok', '無', '沒有', '略', '同上', '待補', '不適用', '看板拖曳', '拖曳',
  '改期', '延期', '調整', '更新', '修改', '變更', '狀態變更', '變更狀態', '改狀態', '更新狀態', '調整日期', '日期調整', '改日期']);
// A reason must say why: 2–500 characters after trimming, not only punctuation/symbols/digits, and not
// an action placeholder such as 「—」「N/A」「看板拖曳」.
export function reasonProblem(text) {
  const t = String(text ?? '').trim();
  if (t.length < 2) return '請填寫具體原因（至少 2 個字）';
  if (t.length > 500) return '原因最多 500 字';
  let symbolsOnly;
  try { symbolsOnly = /^[\s\p{P}\p{S}\d]+$/u.test(t); } catch { symbolsOnly = /^[\s\d\-_.,;:!?/\\|—–·。，、；：！？]+$/.test(t); }
  if (symbolsOnly) return '原因不能只有符號或數字，請寫出具體原因';
  if (PLACEHOLDERS.has(t.toLowerCase())) return '請寫出具體原因，而不是「' + t + '」這類動作描述';
  return null;
}
const reasonField = z.string().superRefine((v, ctx) => { const p = reasonProblem(v); if (p) ctx.addIssue({ code: z.ZodIssueCode.custom, message: p }); }).transform(v => v.trim());
export const scheduleOf = row => ({ dispatchDate: ymd(row.dispatchDate), copyDate: ymd(row.copyDate), printDate: ymd(row.printDate), goLiveDate: ymd(row.goLiveDate) });
const sameSchedule = (a, b) => MILESTONES.every(k => (a?.[k] ?? null) === (b?.[k] ?? null));
const assignmentOf = row => ({ designerId: row.designerId, collaboratorIds: (row.collaborators || []).map(c => c.id).sort((x, y) => x - y) });
const sameAssignment = (a, b) => a && b && a.designerId === b.designerId && JSON.stringify(a.collaboratorIds) === JSON.stringify(b.collaboratorIds);

// Classify a direct milestone edit against the official schedule: 'later' and 'cleared' need an approved
// request; 'earlier' and 'added' (an empty optional date being filled) need only a meaningful reason.
export function classifyMilestones(current, next) {
  const out = [];
  for (const field of MILESTONES) {
    if (!(field in next)) continue;
    const from = current[field] ?? null, to = next[field] ?? null;
    if (from === to) continue;
    const kind = from && !to ? 'cleared' : !from && to ? 'added' : to > from ? 'later' : 'earlier';
    out.push({ field, from, to, kind });
  }
  return out;
}

// Direct PATCH on a schedule-managed case (also while the workflow is paused). Returns { tracked:false }
// when nothing tracked changes (legacy behaviour, no fake event), { error:[status, code, message, extra] }
// to refuse, or { tracked:true, extraChanges } for an allowed change that must go through the versioned,
// actor-revalidated claim. `trackedChanges` are the existing TRACKED_FIELDS diffs (status, dates, owner…).
// Protected fields whose submitted value equals the read snapshot are reported in `unchanged` and must NOT
// be written: an apparent no-op (e.g. a full date payload) would otherwise overwrite a concurrent approval.
const PROTECTED = ['dispatchDate', 'copyDate', 'printDate', 'goLiveDate', 'openDate', 'status', 'designerId', 'level', 'urgent'];
const sameValue = (a, b) => (a instanceof Date || b instanceof Date || a == null || b == null ? ymd(a) === ymd(b) && (a == null) === (b == null) : a === b);
// Raw managed date input must be a genuine calendar date before the legacy schema coerces it
// (2026-02-30 must not silently become 2026-03-02). Optional milestones may be null.
export function managedDateProblem(existing, rawBody) {
  if (existing.scheduleMode !== 'managed' || !rawBody || typeof rawBody !== 'object') return null;
  for (const f of [...MILESTONES, 'openDate']) {
    if (rawBody[f] === undefined) continue;
    if (rawBody[f] === null && (f === 'copyDate' || f === 'printDate')) continue;
    if (!realDay(rawBody[f])) return { field: f, message: `${f} 必須是有效的日曆日期（YYYY-MM-DD）` };
  }
  return null;
}
// Collaborator set exactly as PATCH would store it: stable ids, de-duplicated, never the primary, order-free.
const collaboratorSet = (ids, designerId) => [...new Set(ids)].filter(id => id !== designerId).sort((a, b) => a - b);
export function managedPatchCheck(existing, body, trackedChanges) {
  if (existing.scheduleMode !== 'managed') return { tracked: false };
  const unchanged = PROTECTED.filter(f => body[f] !== undefined && sameValue(existing[f], body[f]));
  // Collaborators are assignment: a real set change is a protected edit (versions, reason, in-transaction
  // primary/admin check); a reordered/duplicate same set is a true no-op and is never written.
  let collaboratorChange = null;
  if (body.collaboratorIds !== undefined) {
    const before = collaboratorSet((existing.collaborators || []).map(c => c.id), existing.designerId);
    const after = collaboratorSet(body.collaboratorIds, body.designerId ?? existing.designerId);
    if (before.join(',') === after.join(',')) unchanged.push('collaboratorIds');
    else collaboratorChange = { field: 'collaborators', fromValue: before.join(',') || '—', toValue: after.join(',') || '—' };
  }
  const next = {};
  for (const f of MILESTONES) if (body[f] !== undefined) next[f] = body[f] === null ? null : ymd(body[f]);
  const milestones = classifyMilestones(scheduleOf(existing), next);
  const openChanged = body.openDate !== undefined && ymd(body.openDate) !== ymd(existing.openDate);
  const tracked = trackedChanges.length > 0 || milestones.length > 0 || openChanged || !!collaboratorChange;
  if (!tracked) return { tracked: false, unchanged };
  if (body.expectedUpdatedAt === undefined || body.expectedContentVersion === undefined) {
    return { error: [409, 'client_update_required', '此案件的時程受控管，請重新整理頁面（需要最新版本資訊）後再修改；這次沒有寫入。'] };
  }
  const closing = body.status !== undefined && body.status !== existing.status && ['review_done', 'done', 'closed'].includes(body.status);
  if (existing.pendingScheduleRequestId && (milestones.length || closing)) {
    return { error: [409, 'schedule_request_pending', '此案件有待主管決議的改期申請；請先等核准／退回或撤回申請，再調整里程碑或送審。', { pendingRequestId: existing.pendingScheduleRequestId }] };
  }
  const needApproval = milestones.filter(m => m.kind === 'later' || m.kind === 'cleared');
  if (needApproval.length) {
    return { error: [409, 'schedule_approval_required', '延後或清除里程碑日期須提出改期申請並經主管核准；提前可直接修改並填寫具體原因。',
      { fields: needApproval.map(m => ({ field: m.field, from: m.from, to: m.to, kind: m.kind })) }] };
  }
  const problem = reasonProblem(body.reason);
  if (problem) return { error: [422, 'reason_required', problem] };
  if (existing.contentVersion !== body.expectedContentVersion || new Date(body.expectedUpdatedAt).getTime() !== new Date(existing.updatedAt).getTime()) {
    return { error: [409, 'edit_conflict', '案件已被其他操作更新，請重新載入後再試；這次沒有寫入。'] };
  }
  // printDate and openDate are not in the legacy TRACKED_FIELDS list; managed cases audit them too.
  const extraChanges = [];
  for (const m of milestones) if (m.field === 'printDate') extraChanges.push({ field: 'printDate', fromValue: m.from ?? '', toValue: m.to ?? '' });
  if (openChanged) extraChanges.push({ field: 'openDate', fromValue: ymd(existing.openDate) ?? '', toValue: ymd(body.openDate) ?? '' });
  if (collaboratorChange) extraChanges.push(collaboratorChange);
  return { tracked: true, extraChanges, unchanged };
}

// ── request parsing ─────────────────────────────────────────────────────────
// REPORTS-P2-D1b: expectedCycleId is required (checked in the transaction) on lifecycle-managed cases.
const versionFields = { expectedUpdatedAt: z.string().datetime({ offset: true }), expectedContentVersion: z.number().int().nonnegative(),
  expectedCycleId: z.string().regex(OP_ID).nullable().optional() };
const needsVersions = b => b && typeof b === 'object' && (b.expectedUpdatedAt === undefined || b.expectedContentVersion === undefined);
const invalid = issues => Object.assign(fail(400, 'invalid_body', '內容格式不正確'), { issues });
function parse(schema, body) { const r = schema.safeParse(body); if (!r.success) throw invalid(r.error.issues); return r.data; }
const adoptSchema = z.object({ requestId: z.string().regex(OP_ID), reason: reasonField, ...versionFields }).strict();
const proposeSchema = z.object({
  id: z.string().regex(OP_ID), reasonCategory: z.enum(Object.keys(REASON_CATEGORIES)), reason: reasonField,
  proposedDates: z.object({ dispatchDate: dayField.optional(), copyDate: dayField.nullable().optional(), printDate: dayField.nullable().optional(), goLiveDate: dayField.optional() }).strict()
    .refine(d => Object.keys(d).length > 0, '請至少提出一個里程碑日期'),
  impactFrom: dayField.optional(), impactTo: dayField.optional(), ...versionFields,
}).strict().superRefine((b, ctx) => {
  if ((b.impactFrom === undefined) !== (b.impactTo === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['impactTo'], message: '影響區間需同時填寫起訖日' });
  else if (b.impactFrom !== undefined && b.impactFrom > b.impactTo) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['impactTo'], message: '影響區間的起日不可晚於訖日' });
});
const withdrawSchema = z.object({ operationId: z.string().regex(OP_ID), reason: reasonField, ...versionFields }).strict();
const decideSchema = z.object({ operationId: z.string().regex(OP_ID), decision: z.enum(['approve', 'reject']), reason: z.string().max(500).optional(), ...versionFields }).strict();
export function parseAdopt(body) { if (needsVersions(body)) throw clientUpdate(); return parse(adoptSchema, body); }
export function parsePropose(body) { if (needsVersions(body)) throw clientUpdate(); return parse(proposeSchema, body); }
export function parseWithdraw(body) { if (needsVersions(body)) throw clientUpdate(); return parse(withdrawSchema, body); }
export function parseDecide(body) {
  if (needsVersions(body)) throw clientUpdate();
  const input = parse(decideSchema, body);
  const reason = input.reason === undefined ? undefined : input.reason.trim();
  if (input.decision === 'reject') {
    const p = reasonProblem(reason);
    if (p) throw fail(422, 'reject_reason_required', '退回時請寫出具體原因：' + p);
  } else if (reason) {
    const p = reasonProblem(reason); if (p) throw invalid([{ path: ['reason'], message: p }]);
  }
  return { ...input, reason: reason || undefined };
}

// ── fingerprints (versions excluded: an exact retry replays even after the case moved on) ──
const normalizedProposal = d => Object.fromEntries(MILESTONES.filter(k => k in d).map(k => [k, d[k] ?? null]));
// REPORTS-P2-D1b: a supplied browser cycle id is part of the intent (appended only when present).
const withCycle = (intent, input) => (input.expectedCycleId != null ? [...intent, input.expectedCycleId] : intent);
export const adoptFingerprint = (actorId, caseId, input) => sha(withCycle(['schedule.adopt.v1', caseId, actorId, input.reason], input));
export const proposeFingerprint = (actorId, caseId, input) => sha(withCycle(['schedule.request.v1', caseId, actorId, input.reasonCategory, input.reason,
  normalizedProposal(input.proposedDates), input.impactFrom ?? null, input.impactTo ?? null], input));
export const withdrawFingerprint = (actorId, caseId, rid, input) => sha(withCycle(['schedule.withdraw.v1', caseId, actorId, rid, input.reason], input));
export const decideFingerprint = (actorId, caseId, rid, input) => sha(withCycle(['schedule.decision.v1', caseId, actorId, rid, input.decision, input.reason ?? null], input));

// ── shared transaction steps ────────────────────────────────────────────────
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
  if (row.scheduleMode !== 'managed') throw fail(409, 'schedule_not_managed', '此案件的時程尚未導入受控管理，沿用原本的編輯方式。');
}
function assertOpen(row) {
  if (row.archived || row.status === 'cancelled' || row.status === 'done' || row.status === 'closed') {
    throw fail(409, 'case_locked', '案件已結案、取消或封存，不接受改期申請或核准。');
  }
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
const serializable = fn => prisma.$transaction(fn, { isolationLevel: 'Serializable' });
const retryable = e => e?.code === 'P2002' || e?.code === 'P2034';
const dateOrNull = text => (text ? new Date(text + 'T00:00:00Z') : null);
const scheduleText = s => `派發 ${s.dispatchDate}／文案 ${s.copyDate ?? '未填'}／送印 ${s.printDate ?? '未填'}／上線 ${s.goLiveDate}`;

export function serializeRequest(r) {
  if (!r) return null;
  return {
    id: r.id, caseId: r.caseId, status: r.decision || 'pending', requestedById: r.requestedById, requestedByName: r.requestedByName,
    requestedAt: new Date(r.createdAt).toISOString(), reasonCategory: r.reasonCategory, reasonCategoryLabel: REASON_CATEGORIES[r.reasonCategory] || r.reasonCategory,
    reason: r.reason, impactFrom: ymd(r.impactFrom), impactTo: ymd(r.impactTo), currentSchedule: r.currentSchedule, proposedSchedule: r.proposedSchedule,
    caseUpdatedAt: new Date(r.caseUpdatedAt).toISOString(), caseContentVersion: r.caseContentVersion, assignmentSnapshot: r.assignmentSnapshot,
    decision: r.decision || null, decidedAt: r.decidedAt ? new Date(r.decidedAt).toISOString() : null, decidedById: r.decidedById ?? null,
    decidedByName: r.decidedByName ?? null, decisionReason: r.decisionReason ?? null, approvedSchedule: r.approvedSchedule ?? null,
  };
}
async function caseVersion(caseId) {
  const row = await prisma.case.findUnique({ where: { id: caseId }, select: { id: true, updatedAt: true, contentVersion: true, status: true } });
  return row ? { id: row.id, updatedAt: new Date(row.updatedAt).toISOString(), contentVersion: row.contentVersion, status: row.status } : null;
}

// ── adoption: legacy → managed (admin, one-way) ─────────────────────────────
export async function adoptManagedSchedule(user, caseId, input) {
  const replay = async () => {
    const row = await prisma.case.findFirst({ where: { scheduleModeRequestId: input.requestId } });
    if (!row) return null;
    if (row.id !== caseId || row.scheduleModeFingerprint !== adoptFingerprint(user.id, caseId, input)) throw requestConflict();
    return { status: 200, replayed: true, case: await caseVersion(caseId), mode: 'managed', baseline: row.scheduleBaseline };
  };
  try {
    const result = await serializable(async tx => {
      const actor = await loadActor(tx, user, { adminOnly: true });
      const prior = await tx.case.findFirst({ where: { scheduleModeRequestId: input.requestId }, select: { id: true } });
      if (prior) return { replay: true };
      if (!scheduleFlags().workflowEnabled) throw paused();
      const row = await loadCase(tx, caseId);
      if (row.scheduleMode === 'managed') throw fail(409, 'already_managed', '此案件的時程已受控管。');
      assertOpen(row);
      assertLifecycle(row, 'evidence'); // REPORTS-P2-D1b
      assertVersion(row, input);
      assertCycle(row, input.expectedCycleId);
      // Baseline = what is observed right now. It is not a historical original promise; dates nobody
      // recorded before adoption stay unknown.
      const baseline = { ...scheduleOf(row), observedAt: new Date().toISOString(), source: 'observed_at_adoption' };
      const version = await claimCase(tx, row, {
        scheduleMode: 'managed', scheduleModeSince: new Date(), scheduleModeById: actor.id, scheduleModeByName: actor.name, scheduleModeReason: input.reason,
        scheduleModeRequestId: input.requestId, scheduleModeFingerprint: adoptFingerprint(actor.id, caseId, input), scheduleBaseline: baseline,
      });
      await audit(tx, caseId, [{ field: 'scheduleMode', fromValue: 'legacy', toValue: 'managed' }], `導入時程受控管理：${input.reason}（導入時觀測：${scheduleText(baseline)}）`, actor.name);
      return { status: 201, replayed: false, case: version, mode: 'managed', baseline };
    });
    return result.replay ? await replay() : result;
  } catch (e) {
    if (e instanceof CaseEditError) throw e;
    if (retryable(e)) { const r = await replay(); if (r) return r; throw conflict(); }
    throw e;
  }
}

// ── propose (admin / primary / collaborator) — official dates unchanged ─────
async function replayPropose(prior, user, caseId, input) {
  if (prior.caseId !== caseId || prior.requestFingerprint !== proposeFingerprint(user.id, caseId, input)) throw requestConflict();
  return { status: 200, replayed: true, request: serializeRequest(prior), case: await caseVersion(caseId) };
}
export async function proposeSchedule(user, caseId, input) {
  try {
    const result = await serializable(async tx => {
      const actor = await loadActor(tx, user);
      const prior = await tx.scheduleRequest.findUnique({ where: { id: input.id } });
      if (prior) return { prior };
      const row = await loadCase(tx, caseId);
      assertManaged(row);
      if (!scheduleFlags().workflowEnabled) throw paused();
      assertAssigned(actor, row);
      assertOpen(row);
      assertLifecycle(row, 'evidence'); // REPORTS-P2-D1b: no new request while sealed / seal-resume pending
      if (row.status === 'review_done') throw fail(409, 'delivery_pending_review', '案件正待主管核可交付；請先完成或撤回送審，再申請改期。');
      if (row.pendingScheduleRequestId) throw fail(409, 'schedule_request_pending', '此案件已有一筆待決議的改期申請；請先等主管決議或撤回後再提出。');
      assertVersion(row, input);
      assertCycle(row, input.expectedCycleId);
      const current = scheduleOf(row);
      const proposed = { ...current, ...normalizedProposal(input.proposedDates) };
      if (sameSchedule(current, proposed)) throw fail(422, 'schedule_no_change', '提案日期與目前正式時程相同，沒有需要申請的異動。');
      const request = await tx.scheduleRequest.create({ data: {
        id: input.id, caseId, requestFingerprint: proposeFingerprint(actor.id, caseId, input), requestedById: actor.id, requestedByName: actor.name,
        reasonCategory: input.reasonCategory, reason: input.reason, impactFrom: dateOrNull(input.impactFrom), impactTo: dateOrNull(input.impactTo),
        currentSchedule: current, proposedSchedule: proposed, caseUpdatedAt: new Date(row.updatedAt), caseContentVersion: row.contentVersion,
        assignmentSnapshot: assignmentOf(row),
      } });
      const version = await claimCase(tx, row, { pendingScheduleRequestId: request.id });
      await audit(tx, caseId, [{ field: 'scheduleRequest', fromValue: scheduleText(current), toValue: scheduleText(proposed) }],
        `提出改期申請（${request.id}，${REASON_CATEGORIES[input.reasonCategory]}）：${input.reason}`, actor.name);
      return { status: 201, replayed: false, request: serializeRequest(request), case: version };
    });
    return result.prior ? await replayPropose(result.prior, user, caseId, input) : result;
  } catch (e) {
    if (e instanceof CaseEditError) throw e;
    if (retryable(e)) {
      const prior = await prisma.scheduleRequest.findUnique({ where: { id: input.id } });
      if (prior) return replayPropose(prior, user, caseId, input);
      throw conflict();
    }
    throw e;
  }
}

// ── decisions: withdraw (assigned) / approve / reject (admin) ───────────────
async function replayDecision(stamped, expected, caseId, rid) {
  if (stamped.caseId !== caseId || stamped.id !== rid || stamped.decisionFingerprint !== expected) throw requestConflict();
  return { status: 200, replayed: true, request: serializeRequest(stamped), case: await caseVersion(stamped.caseId) };
}
async function stampDecision(tx, request, actor, decision, operationId, fingerprint, reason, approvedSchedule) {
  const stamped = await tx.scheduleRequest.updateMany({ where: { id: request.id, decidedAt: null }, data: {
    decision, decidedAt: new Date(), decidedById: actor.id, decidedByName: actor.name, decisionReason: reason ?? null,
    decisionOperationId: operationId, decisionFingerprint: fingerprint, approvedSchedule: approvedSchedule ?? undefined,
  } });
  if (stamped.count !== 1) throw conflict();
  return tx.scheduleRequest.findUnique({ where: { id: request.id } });
}
async function pendingRequest(tx, caseId, rid, row) {
  const request = await tx.scheduleRequest.findUnique({ where: { id: rid } });
  if (!request || request.caseId !== caseId) throw fail(404, 'schedule_request_not_found', '找不到這筆改期申請。');
  if (request.decidedAt) throw fail(409, 'schedule_request_closed', '這筆改期申請已被處理（核准、退回、撤回或失效），請重新整理。');
  if (row.pendingScheduleRequestId !== rid) throw fail(409, 'schedule_request_not_pending', '這筆改期申請已不是目前待決議的申請，請重新整理。');
  return request;
}
function decisionErrorWrap(fn, operationId, expected, caseId, rid) {
  return fn().catch(async e => {
    if (e instanceof CaseEditError) throw e;
    if (retryable(e)) {
      const stamped = await prisma.scheduleRequest.findUnique({ where: { decisionOperationId: operationId } });
      if (stamped) return replayDecision(stamped, expected, caseId, rid);
      throw conflict();
    }
    throw e;
  });
}
export function withdrawScheduleRequest(user, caseId, rid, input) {
  const expected = withdrawFingerprint(user.id, caseId, rid, input);
  return decisionErrorWrap(async () => {
    const result = await serializable(async tx => {
      const actor = await loadActor(tx, user);
      const done = await tx.scheduleRequest.findUnique({ where: { decisionOperationId: input.operationId } });
      if (done) return { done };
      const row = await loadCase(tx, caseId);
      assertAssigned(actor, row);
      const request = await pendingRequest(tx, caseId, rid, row);
      assertVersion(row, input);
      assertCycle(row, input.expectedCycleId); // REPORTS-P2-D1b
      // Withdraw stays available while the workflow is paused so a request never dead-ends.
      const stamped = await stampDecision(tx, request, actor, 'withdrawn', input.operationId, withdrawFingerprint(actor.id, caseId, rid, input), input.reason);
      const version = await claimCase(tx, row, { pendingScheduleRequestId: null });
      await audit(tx, caseId, [{ field: 'scheduleRequest', fromValue: rid, toValue: 'withdrawn' }], `撤回改期申請（${rid}）：${input.reason}`, actor.name);
      return { status: 200, replayed: false, request: serializeRequest(stamped), case: version };
    });
    return result.done ? replayDecision(result.done, expected, caseId, rid) : result;
  }, input.operationId, expected, caseId, rid);
}
export function decideScheduleRequest(user, caseId, rid, input) {
  const expected = decideFingerprint(user.id, caseId, rid, input);
  return decisionErrorWrap(async () => {
    const result = await serializable(async tx => {
      const actor = await loadActor(tx, user, { adminOnly: true });
      const done = await tx.scheduleRequest.findUnique({ where: { decisionOperationId: input.operationId } });
      if (done) return { done };
      const row = await loadCase(tx, caseId);
      assertManaged(row);
      const request = await pendingRequest(tx, caseId, rid, row);
      assertVersion(row, input);
      assertCycle(row, input.expectedCycleId); // REPORTS-P2-D1b
      const fp = decideFingerprint(actor.id, caseId, rid, input);
      if (input.decision === 'reject') {
        // Rejecting stays possible while paused so a request never dead-ends.
        const stamped = await stampDecision(tx, request, actor, 'rejected', input.operationId, fp, input.reason);
        const version = await claimCase(tx, row, { pendingScheduleRequestId: null });
        await audit(tx, caseId, [{ field: 'scheduleRequest', fromValue: rid, toValue: 'rejected' }], `退回改期申請（${rid}）：${input.reason}`, actor.name);
        return { status: 200, replayed: false, request: serializeRequest(stamped), case: version, decision: 'reject' };
      }
      if (!scheduleFlags().workflowEnabled) throw paused();
      assertOpen(row);
      assertLifecycle(row, 'evidence'); // REPORTS-P2-D1b
      // Never rebase: the official schedule and assignment must still be exactly what the requester saw.
      if (!sameSchedule(scheduleOf(row), request.currentSchedule) || !sameAssignment(assignmentOf(row), request.assignmentSnapshot)) {
        throw fail(409, 'schedule_base_changed', '申請送出後，正式時程或主責／協作者已改變；這份申請不能直接核准，請退回後依最新時程重新申請。');
      }
      const proposed = request.proposedSchedule;
      const stamped = await stampDecision(tx, request, actor, 'approved', input.operationId, fp, input.reason, proposed);
      const version = await claimCase(tx, row, {
        dispatchDate: dateOrNull(proposed.dispatchDate), copyDate: dateOrNull(proposed.copyDate), printDate: dateOrNull(proposed.printDate),
        goLiveDate: dateOrNull(proposed.goLiveDate), pendingScheduleRequestId: null,
      });
      const changes = classifyMilestones(request.currentSchedule, proposed).map(c => ({ field: c.field, fromValue: c.from ?? '', toValue: c.to ?? '' }));
      await audit(tx, caseId, changes, `改期核准（${rid}，${REASON_CATEGORIES[request.reasonCategory]}）：${request.reason}${input.reason ? ' — 主管：' + input.reason : ''}`, actor.name);
      return { status: 200, replayed: false, request: serializeRequest(stamped), case: version, decision: 'approve' };
    });
    return result.done ? replayDecision(result.done, expected, caseId, rid) : result;
  }, input.operationId, expected, caseId, rid);
}

// Used by the cancel route inside its own workflow transaction: a pending schedule request can never
// survive a cancellation (and so can never be approved later). The current actor stamps it.
export async function invalidatePendingScheduleInTx(tx, row, reason, operatorName, operatorId) {
  if (!row.pendingScheduleRequestId) return;
  const operationId = 'cancel-' + crypto.randomUUID();
  const stamped = await tx.scheduleRequest.updateMany({ where: { id: row.pendingScheduleRequestId, decidedAt: null }, data: {
    decision: 'invalidated', decidedAt: new Date(), decidedById: operatorId, decidedByName: operatorName, decisionReason: reason,
    decisionOperationId: operationId, decisionFingerprint: sha(['schedule.invalidate.v1', row.id, operatorId, row.pendingScheduleRequestId, reason]),
  } });
  if (stamped.count !== 1) throw Object.assign(new Error('pending schedule request changed'), { caseWorkflow: true, status: 409, error: 'case_conflict', message: '案件已被其他操作更新，請重新載入案件後再試' });
}

export async function listScheduleRequests(caseId) {
  const row = await prisma.case.findUnique({ where: { id: caseId }, select: {
    id: true, status: true, archived: true, updatedAt: true, contentVersion: true, dispatchDate: true, copyDate: true, printDate: true, goLiveDate: true,
    scheduleMode: true, scheduleModeSince: true, scheduleModeByName: true, scheduleModeReason: true, scheduleBaseline: true, pendingScheduleRequestId: true,
    lifecycleMode: true, lifecycleStatus: true, currentCycleId: true, // REPORTS-P2-D2: requests bind to the cycle the user viewed
  } });
  if (!row) throw fail(404, 'not_found', '找不到案件');
  const rows = await prisma.scheduleRequest.findMany({ where: { caseId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
  const flags = scheduleFlags();
  return {
    caseId, mode: row.scheduleMode, status: row.status, archived: row.archived, updatedAt: new Date(row.updatedAt).toISOString(), contentVersion: row.contentVersion,
    lifecycleMode: row.lifecycleMode, lifecycleStatus: row.lifecycleStatus ?? null, currentCycleId: row.currentCycleId ?? null,
    schedule: scheduleOf(row), baseline: row.scheduleBaseline ?? null,
    adoption: row.scheduleMode === 'managed' ? { since: new Date(row.scheduleModeSince).toISOString(), byName: row.scheduleModeByName, reason: row.scheduleModeReason } : null,
    pendingRequestId: row.pendingScheduleRequestId, reasonCategories: REASON_CATEGORIES,
    workflow: { ...flags, paused: row.scheduleMode === 'managed' && !flags.workflowEnabled },
    requests: rows.map(serializeRequest),
  };
}
