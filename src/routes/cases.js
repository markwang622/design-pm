import { safeRouter } from '../lib/safeRouter.js';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { createWithCaseId } from '../lib/ids.js';
import { taipeiCalendarDay } from '../services/analytics.js';
import { caseEditPermission } from '../lib/casePermissions.js';
import { caseContentInclude, replaceCaseJson, appendCaseLog, sendCaseEditError } from '../lib/caseJsonEdits.js';
import { notify, tplCaseAssigned, tplCollabInvite } from '../services/notify.js';
import { detectChanges, writeChangeLog, TRACKED_FIELDS } from '../services/changelog.js';
import deliveriesRouter from './deliveries.js';
import { assignNewItemKeys, reconcileItemKeys } from '../lib/caseItemKeys.js';
import { linkedItemKeys } from '../lib/deliveries.js';
import deliveryWorkflowRouter from './deliveryWorkflow.js';
import { deliveryFlags } from '../lib/deliveryFlags.js';
import { parseDecision, decideSubmission, cancelPendingSubmissionInTx } from '../lib/deliveryWorkflow.js';
import { CaseEditError } from '../lib/caseJsonEdits.js';
import scheduleWorkflowRouter from './scheduleWorkflow.js';
import { managedPatchCheck, managedDateProblem, invalidatePendingScheduleInTx } from '../lib/scheduleWorkflow.js';
import caseLifecycleRouter from './caseLifecycle.js';
import { lifecyclePatchCheck, lifecycleProblem, cycleProblem, closeCycleInTx, expectedCycleField } from '../lib/caseLifecycle.js';

const router = safeRouter(); // v9.6: async 錯誤一律交給 error middleware
router.use(requireAuth);
router.use(deliveriesRouter); // REPORTS-P1-A：/:id/deliveries（預設關閉，見 DELIVERY_RECORDS_ENABLED）
router.use(deliveryWorkflowRouter); // REPORTS-P1-C1：送審／撤回／導入／送審紀錄（見 DELIVERY_WORKFLOW_ENABLED）
router.use(scheduleWorkflowRouter); // REPORTS-P2-D1a：時程受控導入／改期申請／主管決議（見 SCHEDULE_WORKFLOW_ENABLED）
router.use(caseLifecycleRouter); // REPORTS-P2-D1b：生命週期導入／未完成封存／復工（見 LIFECYCLE_WORKFLOW_ENABLED）

// REPORTS-P1-C1: records-mode cases may only enter review_done / done / closed through the
// dedicated submission and approval endpoints. Evidence (archive path, items, legacy counts) is
// frozen while a submission is pending and after approval; C1 offers no reopen of approved records.
const recordsFrozen = row => row.deliveryMode === 'records' && (row.status === 'review_done' || terminalStatus(row.status));
function recordsPatchViolation(existing, body) {
  if (existing.deliveryMode !== 'records') return null;
  if (body.status !== undefined && body.status !== existing.status) {
    if (body.status === 'review_done') return [409, 'delivery_submission_required', '此案件採交付明細制，請使用「送審」動作並確認交付已完整登錄。'];
    if (terminalStatus(body.status)) return [409, 'delivery_approval_required', '交付明細制案件只能經由送審與主管核可結案，不能直接改成結案狀態。'];
    if (existing.status === 'review_done') return [409, 'delivery_withdraw_required', '案件正待主管核可：請由主責／協作者撤回，或由主管退回後再調整狀態。'];
    if (terminalStatus(existing.status)) return [409, 'records_reopen_unavailable', '交付明細制案件核可後暫不提供重啟；同案復工將於後續批次提供。'];
  }
  const touchesEvidence = (body.archivePath !== undefined && body.archivePath !== existing.archivePath)
    || (body.requestCount !== undefined && body.requestCount !== existing.requestCount)
    || (body.outputCount !== undefined && body.outputCount !== existing.outputCount);
  if (recordsFrozen(existing) && touchesEvidence) return [409, 'delivery_evidence_frozen', '送審中或已核可的交付明細制案件，歸檔位置與數量已凍結；如需更正請先撤回或由主管退回。'];
  return null;
}
const recordsModeStamp = user => (deliveryFlags().workflowActive
  ? { deliveryMode: 'records', deliveryModeSince: new Date(), deliveryModeById: user.id, deliveryModeByName: user.name || '—', deliveryModeReason: '流程啟用後新建案件' }
  : {});
const evidenceCount = { _count: { select: { deliveries: true, deliverySubmissions: true, scheduleRequests: true, cycles: true, lifecycleRequests: true } } };
// REPORTS-P2-D1b: browser versions + cycle for a lifecycle-managed case's state/assignment action (cancel,
// transfer, legacy approve). Never filled in from what the server just read.
function lifecycleActionProblem(existing, body) {
  if (existing.lifecycleMode !== 'managed') return null;
  const blocked = lifecycleProblem(existing, 'evidence');
  if (blocked) return [blocked.status, blocked.code, blocked.message, blocked.extra];
  if (!body || body.expectedUpdatedAt === undefined || body.expectedContentVersion === undefined) {
    return [409, 'client_update_required', '此案件的生命週期受控管，請重新整理頁面（需要最新版本與週期資訊）後再操作；這次沒有寫入。'];
  }
  const cycle = cycleProblem(existing, body.expectedCycleId);
  if (cycle) return [cycle.status, cycle.code, cycle.message];
  if (existing.contentVersion !== body.expectedContentVersion || new Date(body.expectedUpdatedAt).getTime() !== new Date(existing.updatedAt).getTime()) {
    return [409, 'edit_conflict', '案件已被其他操作更新，請重新載入後再試；這次沒有寫入。'];
  }
  return null;
}
const sendTuple = (res, t) => res.status(t[0]).json({ error: t[1], message: t[2], ...(t[3] || {}) });
const browserVersionFields = { expectedUpdatedAt: z.string().datetime({ offset: true }).optional(), expectedContentVersion: z.number().int().nonnegative().optional(), expectedCycleId: expectedCycleField };

// ─── Helpers ───────────────────────────────────────────────
const caseInclude = caseContentInclude;

const CANCEL_REASONS = ['需求方取消', '活動/檔期取消', '預算未過', '重複需求', '併入其他案', '延到下期', '內部方向調整', '其他'];
const ACTIVE_STATUSES = ['todo', 'wait', 'doing', 'review', 'review_done', 'print'];
const terminalStatus = status => status === 'done' || status === 'closed';

function workflowError(status, error, message) {
  return Object.assign(new Error(message), { caseWorkflow: true, status, error });
}
function sendWorkflowError(res, e) {
  if (e.code === 'P2034') e = workflowError(409, 'case_conflict', '案件已被其他操作更新，請重新載入案件後再試');
  if (!e.caseWorkflow) return false;
  res.status(e.status).json({ error: e.error, message: e.message });
  return true;
}
async function writeWorkflowAudit(tx, caseId, changes, reason, operator) {
  if (!changes.length) return;
  await tx.changeLog.createMany({ data: changes.map(change => ({ caseId, ...change, reason, operator })) });
}

// Claim the snapshot before changing relations. The row lock, ownership change,
// transfer record and audit all belong to one transaction; callers notify after it.
// Serializable also protects assignment eligibility against concurrent departures.
// `options` (optional, REPORTS-P1-C1) — a function is treated as { inTx }:
//   inTx(tx, current)  runs after the snapshot claim inside the same transaction (current = re-read actor);
//   snapshotEvidence   also claims deliveryMode + contentVersion, so any submit / approval / adoption /
//                      delivery write committed after `existing` was read makes this write lose (409),
//                      even within the same millisecond;
//   revalidateActor    re-reads the signed-in staff row in the transaction (active, activated, current
//                      role) and enforces primary/collaborator assignment from the database role;
//   primaryOrAdmin     (with revalidateActor; the 403 message) narrows that to current admin or primary;
//   bumpContentVersion advances contentVersion with the write (records evidence edits), so a later
//                      submission carrying the pre-edit browser version loses;
//   snapshotSchedule   (REPORTS-P2-D1a) also claims scheduleMode + pendingScheduleRequestId, so an adoption
//                      or schedule request committed after `existing` was read makes this write lose;
//   snapshotLifecycle  (REPORTS-P2-D1b) also claims lifecycleStatus + currentCycleId + pendingLifecycleRequestId;
//   closeCycle         (REPORTS-P2-D1b) { outcome, actor, reason } closes the current cycle in the same transaction;
//   patchPermission    (REPORTS-P2-D1a, with revalidateActor) the intended PATCH body: the action-specific rules
//                      (closed admin-only, reassignment primary/admin-only) are re-checked against the re-read
//                      actor, so a demotion after the outer checks cannot keep those privileges.
async function applyWorkflow(existing, data, changes, reason, operator, toDesignerId, actor, options) {
  const opts = typeof options === 'function' ? { inTx: options } : (options || {});
  const inTx = opts.inTx;
  return prisma.$transaction(async tx => {
    let currentActor;
    if (opts.revalidateActor) {
      const current = await tx.staff.findUnique({ where: { id: opts.revalidateActor.id ?? -1 }, select: { id: true, name: true, role: true, active: true, pendingActivation: true } });
      if (!current || !current.active || current.pendingActivation) throw workflowError(403, 'actor_inactive', '帳號已停用或尚未啟用，這次沒有儲存。');
      if (current.role === 'observer') throw workflowError(403, 'read_only', '觀察者帳號為唯讀。');
      currentActor = current;
      operator = current.name || operator;
      // primaryOrAdmin: CURRENT admin or CURRENT primary only (collaborators never); the claim below
      // keeps designerId pinned to the read snapshot, so primary-ness holds at commit.
      if (opts.patchPermission) {
        const denied = caseEditPermission({ id: current.id, role: current.role }, existing, opts.patchPermission);
        if (denied === 'closed_admin_only') throw workflowError(403, 'closed_admin_only', '結案需要由 admin 在審核中心通過，這次沒有儲存。');
        if (denied === 'assignment_primary_only') throw workflowError(403, 'assignment_primary_only', '主責與協作者調整、取消專案請交由主負責人或管理員處理；這次沒有儲存。');
        if (denied) throw workflowError(403, 'forbidden', '你目前沒有此案件的編輯權限，這次沒有儲存。');
      }
      if (opts.primaryOrAdmin) {
        if (current.role !== 'admin' && current.id !== existing.designerId) throw workflowError(403, 'forbidden', opts.primaryOrAdmin);
      } else {
        actor = { id: current.id, role: current.role };
      }
    }
    let target;
    if (toDesignerId !== undefined) {
      target = await tx.staff.findUnique({ where: { id: toDesignerId } });
      if (!target?.active || target.pendingActivation || !['admin', 'member'].includes(target.role)) {
        throw workflowError(422, 'designer_unavailable', '主負責人不存在、已停用、尚未啟用或為觀察者，請選擇已啟用的設計師或管理員');
      }
    }
    const { collaborators, ...scalarData } = data;
    const claimed = await tx.case.updateMany({
      where: {
        id: existing.id, designerId: existing.designerId, status: existing.status, updatedAt: existing.updatedAt,
        ...(opts.snapshotEvidence && { deliveryMode: existing.deliveryMode, contentVersion: existing.contentVersion }),
        ...(opts.snapshotSchedule && { scheduleMode: existing.scheduleMode, pendingScheduleRequestId: existing.pendingScheduleRequestId, contentVersion: existing.contentVersion }),
        ...(opts.snapshotLifecycle && { lifecycleMode: existing.lifecycleMode, lifecycleStatus: existing.lifecycleStatus, currentCycleId: existing.currentCycleId,
          pendingLifecycleRequestId: existing.pendingLifecycleRequestId, contentVersion: existing.contentVersion }),
        ...(actor && actor.role !== 'admin' && { OR: [{ designerId: actor.id }, { collaborators: { some: { id: actor.id } } }] }),
      },
      data: { ...scalarData, ...(target && { designerId: target.id }), ...(opts.bumpContentVersion && { contentVersion: { increment: 1 } }) },
    });
    if (claimed.count !== 1) throw workflowError(409, 'case_conflict', '案件已被其他操作更新，請重新載入案件後再試');
    if (collaborators || target) {
      await tx.case.update({
        where: { id: existing.id },
        data: { collaborators: collaborators || { disconnect: [{ id: target.id }] } },
      });
    }
    if (target) {
      const from = await tx.staff.findUnique({ where: { id: existing.designerId }, select: { name: true } });
      await tx.transferLog.create({ data: { caseId: existing.id, fromName: from?.name || '—', toName: target.name, reason, operator } });
    }
    if (typeof inTx === 'function') await inTx(tx, currentActor);
    if (opts.closeCycle) {
      const who = currentActor || opts.closeCycle.actor;
      await closeCycleInTx(tx, existing, opts.closeCycle.outcome, { id: who.id, name: who.name }, opts.closeCycle.reason ?? reason, { finalStatus: scalarData.status });
    }
    await writeWorkflowAudit(tx, existing.id, changes, reason, operator);
    return tx.case.findUnique({ where: { id: existing.id }, include: caseInclude });
  }, { isolationLevel: 'Serializable' });
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform((s) => new Date(s + 'T00:00:00Z'));

const createSchema = z.object({
  title: z.string().min(1).max(100),
  subTitle: z.string().optional(),
  requester: z.string().optional().default(''), // B4: 需求單位未填只警示不擋
  hotel: z.string().optional(),
  level: z.enum(['SS', 'S', 'A', 'B', 'C', 'D']),
  category: z.string().optional(),
  designerId: z.number().int(),
  collaboratorIds: z.array(z.number().int()).max(3).default([]),
  requestedOn: dateStr.optional().nullable(), // v7.7: 需求單位提出日（簽核鏈起點）
  openDate: dateStr,
  dispatchDate: dateStr,
  copyDate: dateStr.optional(),
  goLiveDate: dateStr,
  urgent: z.boolean().default(false),
  note: z.string().default(''),
  contact: z.string().optional().nullable(), // B2: 案件聯絡人
  deliverables: z.array(z.string()).max(30).optional(), // C1: 製作物項目（多選）
  needsOutsourcing: z.boolean().default(false), // D2: 需發包
  copyPath: z.string().optional().nullable(),   // H2: 文案路徑
  source: z.string().optional().nullable(),     // H3: 專案來源/需求單號
  printDate: dateStr.optional().nullable(),     // H4: 印刷送印日
  // B1: 通知改為由前端勾選決定（預設不寄）
  notifyDesigner: z.boolean().default(false),
  notifyCollaborators: z.boolean().default(false),
  // A2: 建立時即可帶入子案件與初始進度日誌（存入 Json 欄位，持久化）
  items: z.array(z.any()).max(50).optional(),
  logs: z.array(z.any()).max(500).optional(),
});

// Per-case quantities are explicit counts, never inferred from elapsed days.
// Omission preserves unknown/historical values; zero is a valid stored count.
const closureCountSchema = z.number({ invalid_type_error: '請填入 0 到 1,000,000 的整數' })
  .int('請填入整數').min(0, '數量不可小於 0').max(1_000_000, '數量不可超過 1,000,000');

const updateSchema = z.object({
  title: z.string().optional(),
  subTitle: z.string().optional(),
  requester: z.string().optional(),
  hotel: z.string().optional(),
  level: z.enum(['SS', 'S', 'A', 'B', 'C', 'D']).optional(),
  category: z.string().optional(),
  // v3.6: three-stage close — review → review_done → closed
  // 'done' kept for backward compat with v3.3/v3.4 data; treated like 'closed'
  status: z.enum(['todo', 'wait', 'doing', 'review', 'review_done', 'print', 'done', 'closed', 'cancelled']).optional(),
  designerId: z.number().int().optional(),
  collaboratorIds: z.array(z.number().int()).max(3).optional(),
  requestedOn: dateStr.optional().nullable(), // v7.7
  openDate: dateStr.optional(),
  dispatchDate: dateStr.optional(),
  copyDate: dateStr.optional().nullable(),
  goLiveDate: dateStr.optional(),
  urgent: z.boolean().optional(),
  note: z.string().optional(),
  contact: z.string().optional().nullable(), // B2: 案件聯絡人
  deliverables: z.array(z.string()).max(30).optional(), // C1: 製作物項目
  needsOutsourcing: z.boolean().optional(), // D2: 需發包
  copyPath: z.string().optional().nullable(),   // H2: 文案路徑
  source: z.string().optional().nullable(),     // H3: 專案來源/需求單號
  printDate: dateStr.optional().nullable(),     // H4: 印刷送印日
  archivePath: z.string().optional().nullable(),
  requestCount: closureCountSchema.optional(),
  outputCount: closureCountSchema.optional(),
  reason: z.string().optional(), // required only when tracked fields change
  // REPORTS-P2-D1a: browser versions; required for tracked changes on schedule-managed cases (ignored for legacy).
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
  expectedContentVersion: z.number().int().nonnegative().optional(),
  expectedCycleId: expectedCycleField, // REPORTS-P2-D1b: required for writes on lifecycle-managed cases
});

// ─── POST /api/cases/bulk-import — admin only (v3.4) ──────
// Accepts { rows: [...] } where each row is a partial case row.
// Designer is identified by NAME (string) instead of ID, since
// CSV uploads don't carry IDs. Status / archivePath / closedOn /
// requestCount / outputCount are optional — historical records
// can be imported with status=done.
const bulkRowSchema = z.object({
  title: z.string().min(1),
  subTitle: z.string().optional(),
  requester: z.string().default('—'),
  hotel: z.string().optional(),
  level: z.enum(['SS', 'S', 'A', 'B', 'C', 'D']).default('C'),
  category: z.string().optional(),
  designerName: z.string().min(1),
  collaboratorNames: z.array(z.string()).default([]),
  status: z.enum(['todo', 'wait', 'doing', 'review', 'review_done', 'print', 'done', 'closed', 'cancelled']).default('todo'),
  urgent: z.boolean().default(false),
  note: z.string().default(''),
  // Dates — accept YYYY-MM-DD strings; convert later
  requestedOn: z.string().optional(), // v7.7
  openDate: z.string().optional(),
  dispatchDate: z.string().optional(),
  copyDate: z.string().optional(),
  goLiveDate: z.string().optional(),
  closedOn: z.string().optional(),
  archivePath: z.string().optional(),
  requestCount: closureCountSchema.optional(),
  outputCount: closureCountSchema.optional(),
  cancelReason: z.enum(CANCEL_REASONS).optional(),
  cancelStage: z.enum(ACTIVE_STATUSES).optional(),
  cancelledOn: z.string().refine(s => {
    const date = parseDate(s);
    return date && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === s;
  }, 'cancelledOn 必須是有效的 YYYY-MM-DD 日期').optional(),
});

const bulkImportSchema = z.object({
  rows: z.array(z.any()).min(1).max(500),
  defaultGoLiveDate: z.string().optional(), // fallback when missing
});

function parseDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(`${s}T00:00:00Z`);
}

router.post('/bulk-import', requireAdmin, async (req, res) => {
  const parsed = bulkImportSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  }
  const { rows } = parsed.data;
  const fallbackGoLive = parsed.data.defaultGoLiveDate
    ? parseDate(parsed.data.defaultGoLiveDate)
    : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 2 weeks from now
  const today = taipeiCalendarDay();

  // Build a name → id lookup for staff
  const allStaff = await prisma.staff.findMany({
    select: { id: true, name: true, active: true },
  });
  const nameToId = new Map(allStaff.map((s) => [s.name.toLowerCase(), s.id]));

  const created = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const rowParsed = bulkRowSchema.safeParse(raw);
    if (!rowParsed.success) {
      errors.push({
        rowIndex: i,
        title: raw?.title || '(unknown)',
        message: 'invalid_fields: ' + rowParsed.error.issues.map((e) => e.path.join('.') + ' ' + e.message).join('; '),
      });
      continue;
    }
    const r = rowParsed.data;

    const designerId = nameToId.get(r.designerName.toLowerCase());
    if (!designerId) {
      errors.push({
        rowIndex: i,
        title: r.title,
        message: `找不到設計師「${r.designerName}」 — 請先在「人員」分頁新增此成員，或修改 CSV`,
      });
      continue;
    }

    const unknownCollaborators = r.collaboratorNames.filter(n => !nameToId.has(n.toLowerCase()));
    if (unknownCollaborators.length) {
      errors.push({ rowIndex: i, title: r.title, message: `找不到協作者「${unknownCollaborators.join('、')}」，請修正 CSV 人員名稱後重新匯入此列` });
      continue;
    }
    if (r.status === 'cancelled' && !r.cancelReason) {
      errors.push({ rowIndex: i, title: r.title, message: '取消案件必須提供 cancelReason（例如：需求方取消），請補齊後重新匯入此列' });
      continue;
    }
    const collabIds = (r.collaboratorNames || [])
      .map((n) => nameToId.get(String(n).toLowerCase()))
      .filter((id) => id && id !== designerId);

    // Build dates with sensible fallbacks
    const requestedOn = parseDate(r.requestedOn); // v7.7
    const openDate = parseDate(r.openDate) || today;
    const dispatchDate = parseDate(r.dispatchDate) || openDate;
    const copyDate = parseDate(r.copyDate);
    const goLiveDate = parseDate(r.goLiveDate) || fallbackGoLive;
    const closedOn = parseDate(r.closedOn);

    try {
      const row = await createWithCaseId(r.level, openDate, async id => {
        const data = {
          id,
          title: r.title.slice(0, 100),
          subTitle: r.subTitle,
          requester: r.requester,
          hotel: r.hotel,
          level: r.level,
          category: r.category,
          status: r.status,
          urgent: !!r.urgent,
          note: r.note || '',
          requestedOn,
          openDate,
          dispatchDate,
          copyDate,
          goLiveDate,
          designer: { connect: { id: designerId } },
          collaborators: { connect: collabIds.map((id) => ({ id })) },
          createdBy: req.user?.id ? { connect: { id: req.user.id } } : undefined,
        };
        // Only actual closure receives a completion date. Review submission is active.
        if (terminalStatus(r.status) || r.status === 'review_done') {
          if (terminalStatus(r.status)) data.closedOn = closedOn || today;
          if (r.archivePath) data.archivePath = r.archivePath;
          if (r.requestCount !== undefined) data.requestCount = r.requestCount;
          if (r.outputCount !== undefined) data.outputCount = r.outputCount;
          if (data.archivePath == null || data.archivePath === '') {
            data.archivePath = `/設計部共用/2026/匯入/${id}-${r.title}`.replace(/\s+/g, '_');
          }
          // closed → also auto-archive (v3.6 #17)
          if (r.status === 'closed') data.archived = true;
        }

        if (r.status === 'cancelled') {
          Object.assign(data, { archived: true, closedOn: null, cancelReason: r.cancelReason, cancelStage: r.cancelStage || 'todo', cancelledOn: parseDate(r.cancelledOn) || today });
        }
        return prisma.case.create({ data, include: caseInclude });
      });
      created.push({ rowIndex: i, id: row.id, title: row.title, designer: row.designer.name });
    } catch (e) {
      errors.push({
        rowIndex: i,
        title: r.title,
        message: e.message?.slice(0, 200) || 'unknown_error',
      });
    }
  }

  res.json({
    ok: true,
    summary: {
      total: rows.length,
      created: created.length,
      failed: errors.length,
    },
    created,
    errors,
  });
});

// ─── GET /api/cases — list ─────────────────────────────────
router.get('/', async (req, res) => {
  const includeArchived = req.query.includeArchived === '1';
  const rows = await prisma.case.findMany({
    where: includeArchived ? {} : { archived: false },
    include: { ...caseInclude, ...evidenceCount }, // REPORTS-P1-C1：來源匯出可辨識交付證據
    orderBy: { goLiveDate: 'asc' },
  });
  res.json(rows);
});

// ─── GET /api/cases/:id ───────────────────────────────────
router.get('/:id', async (req, res) => {
  const row = await prisma.case.findUnique({
    where: { id: req.params.id },
    include: {
      ...caseInclude,
      transferLogs: { orderBy: { date: 'desc' } },
      changeLogs: { orderBy: { createdAt: 'desc' } },
      ...evidenceCount,
    },
  });
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(row);
});

// ─── POST /api/cases — create ─────────────────────────────
router.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  }
  const body = parsed.data;
  let createItems;
  try { createItems = body.items ? assignNewItemKeys(body.items) : undefined; } // REPORTS-P1-A：伺服器產生穩定子案件 key
  catch (e) { if (sendCaseEditError(res, e)) return; throw e; }

  // Designer must not be in collaborators list
  const collabIds = body.collaboratorIds.filter((id) => id !== body.designerId);

  // Shared bounded collision retry also covers clone and bulk import.
  const caseData = {
    title: body.title,
    subTitle: body.subTitle,
    requester: body.requester,
    hotel: body.hotel,
    level: body.level,
    category: body.category,
    requestedOn: body.requestedOn ?? undefined, // v7.7
    openDate: body.openDate,
    dispatchDate: body.dispatchDate,
    copyDate: body.copyDate,
    printDate: body.printDate ?? undefined,
    goLiveDate: body.goLiveDate,
    urgent: body.urgent,
    note: body.note,
    contact: body.contact ?? undefined,
    copyPath: body.copyPath ?? undefined,
    source: body.source ?? undefined,
    deliverables: body.deliverables ?? undefined,
    needsOutsourcing: body.needsOutsourcing ?? false,
    items: createItems,
    logs: body.logs ?? undefined,
    designer: { connect: { id: body.designerId } },
    collaborators: { connect: collabIds.map((id) => ({ id })) },
    createdBy: req.user?.id ? { connect: { id: req.user.id } } : undefined,
    ...recordsModeStamp(req.user), // REPORTS-P1-C1：流程開啟後的新建一般案件採交付明細制
  };
  const created = await createWithCaseId(body.level, body.openDate, id =>
    prisma.case.create({ data: { id, ...caseData }, include: caseInclude }));

  // B1: 通知改為由前端勾選決定（預設不寄）
  try {
    const designerRow = created.designer;
    const operatorName = req.user.name;

    // Notify primary — 僅在勾選時
    if (body.notifyDesigner) {
      const tpl = tplCaseAssigned({
        caseRow: { ...created, designerName: designerRow.name },
        operatorName,
      });
      await notify({ type: 'caseAssigned', recipientId: designerRow.id, ...tpl, relatedCaseId: created.id });
    }

    // Notify collaborators — 僅在勾選時
    if (body.notifyCollaborators) {
      for (const c of created.collaborators) {
        const t = tplCollabInvite({
          caseRow: { ...created, designerName: designerRow.name },
          operatorName,
        });
        await notify({ type: 'collabInvite', recipientId: c.id, ...t, relatedCaseId: created.id });
      }
    }
  } catch (e) {
    console.warn('[cases.create] notification failed:', e.message);
  }

  res.status(201).json(created);
});

// ─── PATCH /api/cases/:id — update ────────────────────────
router.patch('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  }
  const body = parsed.data;

  const existing = await prisma.case.findUnique({ where: { id: req.params.id }, include: { collaborators: { select: { id: true } } } });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  // REPORTS-P2-D1a: managed cases validate the raw calendar dates before any legacy coercion.
  const badDate = managedDateProblem(existing, req.body);
  if (badDate) return res.status(400).json({ error: 'invalid_date', field: badDate.field, message: badDate.message });

  const denied = caseEditPermission(req.user, existing, body);
  if (denied) return res.status(403).json({ error: denied, message: denied === 'assignment_primary_only'
    ? '主責與協作者調整、取消專案請交由主負責人或管理員處理'
    : '僅管理員、主負責人與共同協作者可編輯；結案仍須管理員核可' });

  if (body.status === 'cancelled') {
    return res.status(422).json({ error: 'cancel_action_required', message: `取消案件必須填寫原因，請使用 POST /api/cases/${existing.id}/cancel 並提供 reason` });
  }
  if (existing.status === 'cancelled' && body.status !== undefined) {
    return res.status(422).json({ error: 'uncancel_action_required', message: `請先使用 POST /api/cases/${existing.id}/uncancel 還原取消，再調整案件狀態` });
  }
  // REPORTS-P1-C1: records mode routes status and frozen evidence through the delivery workflow (admins too).
  const recordsViolation = recordsPatchViolation(existing, body);
  if (recordsViolation) return res.status(recordsViolation[0]).json({ error: recordsViolation[1], message: recordsViolation[2] });

  // ── Archive-path guard ───────────────────────────────────
  // Required when going into review_done / done / closed (any "終態")
  const FINAL_STATUSES = new Set(['review_done', 'done', 'closed']);
  if (body.status && FINAL_STATUSES.has(body.status)) {
    const nextPath = body.archivePath !== undefined ? body.archivePath : existing.archivePath;
    if (!nextPath || !String(nextPath).trim()) {
      return res.status(422).json({
        error: 'archive_path_required',
        message: '未填寫檔案歸檔位置，無法進入確稿完成 / 結案',
      });
    }
  }

  // ── Approval gate (v3.6 #13): non-admin can NOT directly set 'closed'.
  // Designer must use review_done; admin then approves via /approve endpoint.
  if (body.status === 'closed' && req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'closed_admin_only',
      message: '結案需要由 admin 在審核中心通過，請改成「確稿完成」狀態',
    });
  }

  // ── ChangeLog reason guard (v3.3) ───────────────────────
  // For diffing: build a synthetic "patch" with the values to compare.
  const trackedPatch = {};
  for (const f of TRACKED_FIELDS) {
    if (body[f] !== undefined) trackedPatch[f] = body[f];
  }
  const changes = detectChanges(existing, trackedPatch);
  // REPORTS-P2-D1a: schedule-managed cases — tracked/date changes need a meaningful reason and the real
  // browser versions; postponing or clearing a parent milestone (dispatch/copy/print/goLive) needs an
  // approved schedule request; nothing may slip past a pending request. Applies while paused too.
  const managed = managedPatchCheck(existing, body, changes);
  if (managed.error) return res.status(managed.error[0]).json({ error: managed.error[1], message: managed.error[2], ...(managed.error[3] || {}) });
  if (managed.tracked) changes.push(...managed.extraChanges);
  // REPORTS-P2-D1b: lifecycle-managed cases — any real change needs versions + the current cycle and goes through
  // the claim; sealed cases are read-only; evidence edits wait for a pending lifecycle request; no reopen after
  // completion/cancellation; reaching done/closed closes the current cycle as `completed` in the same transaction.
  const lifecycle = lifecyclePatchCheck(existing, body);
  if (lifecycle.error) return sendTuple(res, lifecycle.error);
  if (lifecycle.tracked) for (const c of lifecycle.extraChanges) if (!changes.some(x => x.field === c.field)) changes.push(c);
  // Unchanged protected fields are never written on managed cases (no blind overwrite of a concurrent approval).
  const skipUnchanged = new Set([...(managed.unchanged || []), ...(lifecycle.unchanged || [])]);
  // D3: 調整原因改為非必填（未填則記錄為「—」）
  const reasonStr = (body.reason || '').trim() || '—';

  const data = {
    ...(body.title !== undefined && { title: body.title }),
    ...(body.subTitle !== undefined && { subTitle: body.subTitle }),
    ...(body.requester !== undefined && { requester: body.requester }),
    ...(body.hotel !== undefined && { hotel: body.hotel }),
    ...(body.level !== undefined && { level: body.level }),
    ...(body.category !== undefined && { category: body.category }),
    ...(body.status !== undefined && { status: body.status }),
    ...(body.requestedOn !== undefined && { requestedOn: body.requestedOn }),
    ...(body.openDate !== undefined && { openDate: body.openDate }),
    ...(body.dispatchDate !== undefined && { dispatchDate: body.dispatchDate }),
    ...(body.copyDate !== undefined && { copyDate: body.copyDate }),
    ...(body.printDate !== undefined && { printDate: body.printDate }),
    ...(body.goLiveDate !== undefined && { goLiveDate: body.goLiveDate }),
    ...(body.urgent !== undefined && { urgent: body.urgent }),
    ...(body.note !== undefined && { note: body.note }),
    ...(body.contact !== undefined && { contact: body.contact }),
    ...(body.copyPath !== undefined && { copyPath: body.copyPath }),
    ...(body.source !== undefined && { source: body.source }),
    ...(body.deliverables !== undefined && { deliverables: body.deliverables }),
    ...(body.needsOutsourcing !== undefined && { needsOutsourcing: body.needsOutsourcing }),
    ...(body.archivePath !== undefined && { archivePath: body.archivePath }),
    ...(body.requestCount !== undefined && { requestCount: body.requestCount }),
    ...(body.outputCount !== undefined && { outputCount: body.outputCount }),
  };

  for (const f of skipUnchanged) delete data[f];
  const transferring = body.designerId !== undefined && body.designerId !== existing.designerId;
  if (body.collaboratorIds !== undefined && !skipUnchanged.has('collaboratorIds')) {
    data.collaborators = {
      set: [...new Set(body.collaboratorIds)].filter(id => id !== (body.designerId ?? existing.designerId)).map(id => ({ id })),
    };
  } else if (body.designerId !== undefined && !skipUnchanged.has('designerId')) {
    data.collaborators = { disconnect: [{ id: body.designerId }] };
  }

  if (body.status !== undefined && !skipUnchanged.has('status')) {
    if (terminalStatus(body.status)) {
      if (!terminalStatus(existing.status) || !existing.closedOn) data.closedOn = taipeiCalendarDay();
      if (body.status === 'closed') data.archived = true;
    } else {
      data.closedOn = null;
      if (terminalStatus(existing.status)) data.archived = false;
    }
  }

  let updated;
  const hasClosureCounts = body.requestCount !== undefined || body.outputCount !== undefined;
  // REPORTS-P1-C1: archive path and legacy counts are submission evidence. Their write claims the
  // read snapshot (status, mode, updatedAt AND contentVersion) with the actor re-validated inside the
  // transaction; a submit/approval/adoption that commits in between makes this PATCH lose with 409.
  const evidenceEdit = body.archivePath !== undefined || hasClosureCounts;
  if (managed.tracked || lifecycle.tracked) {
    // Managed tracked change: Serializable claim of the browser-confirmed snapshot (versions, mode, pending
    // schedule request, delivery mode, lifecycle), actor + assignment re-read in the transaction, version advanced.
    if (lifecycle.closing) data.lifecycleStatus = 'completed';
    const managedOptions = { snapshotEvidence: true, snapshotSchedule: true, snapshotLifecycle: existing.lifecycleMode === 'managed', revalidateActor: req.user,
      bumpContentVersion: true, patchPermission: body, ...(lifecycle.closing && { closeCycle: { outcome: 'completed', actor: req.user } }) };
    try { updated = await applyWorkflow(existing, data, changes, reasonStr, req.user.name, transferring ? body.designerId : undefined, req.user, managedOptions); }
    catch (e) { if (sendWorkflowError(res, e)) return; throw e; }
  } else if (transferring || body.status !== undefined || evidenceEdit) {
    // Count edits share the workflow snapshot claim, including current ownership
    // or collaboration, so a revoked editor cannot persist a stale submission.
    const evidenceOptions = evidenceEdit ? { snapshotEvidence: true, revalidateActor: req.user, bumpContentVersion: existing.deliveryMode === 'records', patchPermission: body } : undefined;
    try { updated = await applyWorkflow(existing, data, changes, reasonStr, req.user.name, transferring ? body.designerId : undefined, evidenceEdit ? req.user : undefined, evidenceOptions); }
    catch (e) { if (sendWorkflowError(res, e)) return; throw e; }
  } else {
    // REPORTS-P2-D1a: pin the schedule mode that was read, so an adoption committed in between cannot let a
    // legacy-rules date write slip onto a now-managed case.
    if ((existing.scheduleMode === 'managed' || existing.lifecycleMode === 'managed') && !Object.keys(data).length) {
      updated = await prisma.case.findUnique({ where: { id: req.params.id }, include: caseInclude });   // true no-op: nothing written
    } else {
      try { updated = await prisma.case.update({ where: { id: req.params.id, scheduleMode: existing.scheduleMode }, data, include: caseInclude }); }
      catch (e) { if (e?.code === 'P2025') return res.status(409).json({ error: 'case_conflict', message: '案件已被其他操作更新，請重新載入案件後再試' }); throw e; }
    }
    if (changes.length) {
      try { await writeChangeLog(updated.id, changes, reasonStr, req.user.name); }
      catch (e) { console.warn('[cases.update] changelog write failed:', e.message); }
    }
  }

  // (v3.6 #12) When designer pushes to review_done, notify all admins
  if (body.status === 'review_done' && existing.status !== 'review_done') {
    try {
      const admins = await prisma.staff.findMany({
        where: { role: 'admin', active: true },
        select: { id: true, name: true },
      });
      for (const a of admins) {
        await notify({
          type: 'reviewDone',
          recipientId: a.id,
          subject: `📝 確稿完成待審核：${updated.id} · ${updated.title}`,
          body: `${updated.designer?.name || '—'} 已將案件 ${updated.id}「${updated.title}」推到「確稿完成」狀態，等待您審核 → 通過後自動結案、進入歷史。`,
          relatedCaseId: updated.id,
        });
      }
    } catch (e) {
      console.warn('[cases.update] reviewDone notify failed:', e.message);
    }
  }

  // (v4.0 #1) Admin proxy edit: when admin edits someone else's case, notify the designer.
  if (req.user.role === 'admin' && req.user.id !== existing.designerId && changes.length > 0) {
    try {
      const fieldLabels = {
        goLiveDate: '上線日', dispatchDate: '派發日', copyDate: '文案日',
        designerId: '主負責人', status: '狀態', level: '分級', urgent: '急件',
      };
      const detail = changes
        .map(c => `${fieldLabels[c.field] || c.field}：${c.fromValue || '—'} → ${c.toValue || '—'}`)
        .join('\n');
      await notify({
        type: 'adminProxyEdit',
        recipientId: existing.designerId,
        subject: `✏️ 你的案件被 admin 修改：${updated.id} · ${updated.title}`,
        body: `Admin ${req.user.name} 代為修改了案件 ${updated.id}「${updated.title}」。\n\n變更內容：\n${detail}\n\n原因：${reasonStr || '—'}\n\n請打開系統查看詳情。`,
        relatedCaseId: updated.id,
      });
    } catch (e) {
      console.warn('[cases.update] proxy-edit notify failed:', e.message);
    }
  }

  res.json(updated);
});

// ─── POST /api/cases/:id/approve — admin approval (v3.6 #13/#21) ─
// Body: { decision: 'approve' | 'reject', comment?: string }
//   approve → status = 'closed', archived = true (auto), notify designer
//   reject  → status = 'doing', notify designer with comment
// Only allowed when current status is 'review_done'.
const approveSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: z.string().optional(),
  ...browserVersionFields, // REPORTS-P2-D1b: required for lifecycle-managed legacy-delivery cases
});
router.post('/:id/approve', requireAdmin, async (req, res) => {
  const parsed = approveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const { decision, comment } = parsed.data;

  const existing = await prisma.case.findUnique({
    where: { id: req.params.id },
    include: { designer: { select: { id: true, name: true } } },
  });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (existing.deliveryMode === 'records') {
    // REPORTS-P1-C1: records decisions bind to the submission, the browser's versions and a stable
    // operation id; approve re-verifies evidence and explicit zero-support approval in one transaction.
    let result;
    try { result = await decideSubmission(req.user, existing.id, parseDecision(req.body)); }
    catch (e) {
      if (e?.issues) return res.status(400).json({ error: 'invalid_body', message: e.message, issues: e.issues });
      if (sendCaseEditError(res, e)) return; throw e;
    }
    if (!result.replayed) {
      try {
        const approved = result.decision === 'approve';
        await notify({ type: approved ? 'caseClosed' : 'caseRejected', recipientId: existing.designer.id,
          subject: approved ? `✅ 案件已結案：${existing.id} · ${existing.title}` : `↩ 案件被退回：${existing.id} · ${existing.title}`,
          body: approved ? `Admin ${req.user.name} 已核可交付明細送審，案件已結案。${result.submission.decisionReason ? '評語：' + result.submission.decisionReason : ''}`
            : `Admin ${req.user.name} 退回此案，狀態已切回「進行中」。原因：${result.submission.decisionReason}`, relatedCaseId: existing.id });
      } catch (e) { console.warn('[approve:records] notify failed (decision already committed):', e.message); }
    }
    return res.json({ submission: result.submission, case: result.case, replayed: result.replayed });
  }
  if (existing.status !== 'review_done') {
    return res.status(409).json({
      error: 'wrong_state',
      message: '此案件不在「確稿完成」狀態，無法審核',
      currentStatus: existing.status,
    });
  }

  if (decision === 'approve' && (!existing.archivePath || !String(existing.archivePath).trim())) {
    return res.status(422).json({ error: 'archive_path_required', message: '結案前必須先填寫檔案歸檔位置' });
  }
  // REPORTS-P2-D1b: a lifecycle-managed case needs the browser's versions + cycle; approval closes the current
  // cycle as `completed` in the same transaction (rejection keeps it open).
  const lifecycleIssue = lifecycleActionProblem(existing, parsed.data);
  if (lifecycleIssue) return sendTuple(res, lifecycleIssue);
  const lifecycleManaged = existing.lifecycleMode === 'managed';
  const data = decision === 'approve'
    ? { status: 'closed', archived: true, closedOn: taipeiCalendarDay(), ...(lifecycleManaged && { lifecycleStatus: 'completed' }) }
    : { status: 'doing', archived: false, closedOn: null };
  let updated;
  try {
    updated = await applyWorkflow(existing, data,
      [{ field: 'status', fromValue: 'review_done', toValue: data.status }],
      `${decision === 'approve' ? '審核通過' : '退回修改'}${comment ? ' — ' + comment : ''}`, req.user.name, undefined, undefined,
      lifecycleManaged ? { snapshotLifecycle: true, bumpContentVersion: true, revalidateActor: req.user, patchPermission: { status: data.status },
        ...(decision === 'approve' && { closeCycle: { outcome: 'completed', actor: req.user } }) } : undefined);
  } catch (e) { if (sendWorkflowError(res, e)) return; throw e; }

  // Notify designer
  try {
    await notify({
      type: decision === 'approve' ? 'caseClosed' : 'caseRejected',
      recipientId: existing.designer.id,
      subject: decision === 'approve'
        ? `✅ 案件已結案：${updated.id} · ${updated.title}`
        : `↩ 案件被退回：${updated.id} · ${updated.title}`,
      body: decision === 'approve'
        ? `Admin ${req.user.name} 已通過審核，案件已自動結案並進入歷史。${comment ? '評語：' + comment : ''}`
        : `Admin ${req.user.name} 退回此案，狀態已切回「進行中」，請依評語修改後重新提送。${comment ? '評語：' + comment : ''}`,
      relatedCaseId: updated.id,
    });
  } catch (e) {
    console.warn('[approve] notify failed:', e.message);
  }

  res.json(updated);
});

// ─── GET /api/cases/pending-requests/list — REPORTS-P2-D2 admin queue for schedule / lifecycle requests ─
// Read-only: cases with a pending schedule-change or seal/resume request, with the request kind. Decisions are
// made from the case drawer against the snapshot the manager has reviewed.
router.get('/pending-requests/list', requireAdmin, async (req, res) => {
  const rows = await prisma.case.findMany({
    where: { OR: [{ NOT: { pendingScheduleRequestId: null } }, { NOT: { pendingLifecycleRequestId: null } }] },
    select: { id: true, title: true, subTitle: true, hotel: true, level: true, status: true, archived: true, goLiveDate: true,
      designer: { select: { id: true, name: true } }, pendingScheduleRequestId: true, pendingLifecycleRequestId: true, lifecycleStatus: true },
    orderBy: { goLiveDate: 'asc' },
  });
  const lifecycleIds = rows.map(r => r.pendingLifecycleRequestId).filter(Boolean);
  const scheduleIds = rows.map(r => r.pendingScheduleRequestId).filter(Boolean);
  const [lifecycle, schedule] = await Promise.all([
    lifecycleIds.length ? prisma.lifecycleRequest.findMany({ where: { id: { in: lifecycleIds } }, select: { id: true, kind: true, requestedByName: true, createdAt: true, reasonCategory: true, reason: true } }) : [],
    scheduleIds.length ? prisma.scheduleRequest.findMany({ where: { id: { in: scheduleIds } }, select: { id: true, requestedByName: true, createdAt: true, reasonCategory: true, reason: true, currentSchedule: true, proposedSchedule: true } }) : [],
  ]);
  res.json(rows.map(r => {
    const l = lifecycle.find(x => x.id === r.pendingLifecycleRequestId), s = schedule.find(x => x.id === r.pendingScheduleRequestId);
    return { ...r, request: l ? { kind: l.kind, ...l } : s ? { kind: 'schedule', ...s } : null };
  }));
});

// ─── GET /api/cases/pending-approval — admin queue (v3.6 #21) ─
router.get('/pending-approval/list', requireAdmin, async (req, res) => {
  const rows = await prisma.case.findMany({
    where: { status: 'review_done', archived: false },
    include: caseInclude,
    orderBy: { goLiveDate: 'asc' },
  });
  res.json(rows);
});

// ─── DELETE /api/cases/:id — delete a case (v3.3) ─────────
// Permissions:
//   - admin: can delete any case (regardless of status / archived)
//   - case creator: can delete their own case ONLY if status === 'todo'
router.delete('/:id', async (req, res) => {
  const existing = await prisma.case.findUnique({
    where: { id: req.params.id },
    select: { id: true, status: true, createdById: true, designerId: true, title: true },
  });
  if (!existing) return res.status(404).json({ error: 'not_found' });

  const isAdmin = req.user?.role === 'admin';
  const isCreator = req.user?.id === existing.createdById;
  const allowed = isAdmin || (isCreator && existing.status === 'todo');
  if (!allowed) {
    return res.status(403).json({
      error: 'forbidden',
      message: isCreator
        ? '案件已開始進行，無法刪除'
        : '只有 admin 或案件建立者（todo 狀態）可以刪除案件',
    });
  }

  // Cascade-delete child rows defensively. ChangeLog and TransferLog
  // already have onDelete: Cascade in the schema, so a single delete is
  // enough — but Notifications referenced by relatedCaseId are nullable
  // strings and won't cascade.
  // REPORTS-P1-A: delivery evidence blocks deletion. The count gives a clear early answer;
  // the RESTRICT foreign key stays authoritative when a delivery is written concurrently.
  const deliveryBlocked = () => res.status(409).json({ error: 'case_has_deliveries', message: '此案件已有交付紀錄，不能刪除；如需更正請作廢個別交付紀錄。' });
  if (await prisma.deliveryRecord.count({ where: { caseId: existing.id } })) return deliveryBlocked();
  if (await prisma.deliverySubmission.count({ where: { caseId: existing.id } })) return deliveryBlocked();
  // REPORTS-P2-D1a: schedule-change history also blocks deletion (count + RESTRICT FK).
  const scheduleBlocked = () => res.status(409).json({ error: 'case_has_schedule_requests', message: '此案件已有改期申請紀錄，不能刪除；歷史紀錄必須保留。' });
  if (await prisma.scheduleRequest.count({ where: { caseId: existing.id } })) return scheduleBlocked();
  // REPORTS-P2-D1b: cycles and lifecycle requests are history too (count + RESTRICT / same-case FKs).
  const lifecycleBlocked = () => res.status(409).json({ error: 'case_has_lifecycle_history', message: '此案件已有工作週期或封存／復工紀錄，不能刪除；歷史紀錄必須保留。' });
  if (await prisma.caseCycle.count({ where: { caseId: existing.id } }) || await prisma.lifecycleRequest.count({ where: { caseId: existing.id } })) return lifecycleBlocked();
  try {
    await prisma.$transaction([
      prisma.notification.updateMany({
        where: { relatedCaseId: existing.id },
        data: { relatedCaseId: null },
      }),
      prisma.case.delete({ where: { id: existing.id } }),
    ]);
  } catch (e) {
    // PostgreSQL reports ON DELETE RESTRICT as SQLSTATE 23001, which Prisma 6 surfaces as an
    // unknown request error (no P2003 code); identify it by the constraint name.
    if (/case_schedule_requests_caseId_fkey/.test(String(e?.message || ''))) return scheduleBlocked();
    if (/case_cycles_caseId_fkey|case_lifecycle_requests_caseId_fkey|_same_case_fkey/.test(String(e?.message || ''))) return lifecycleBlocked();
    if (e?.code === 'P2003' || e?.code === 'P2014' || /case_deliveries_caseId_fkey|case_delivery_submissions_caseId_fkey/.test(String(e?.message || ''))) return deliveryBlocked();
    throw e;
  }

  res.json({ ok: true, deleted: existing.id });
});

// ─── GET /api/cases/:id/changelog — audit timeline (v3.3) ─
router.get('/:id/changelog', async (req, res) => {
  const rows = await prisma.changeLog.findMany({
    where: { caseId: req.params.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json(rows);
});

// ─── POST /api/cases/:id/archive — mark archived ──────────
router.post('/:id/archive', requireAdmin, async (req, res) => {
  // REPORTS-P1-C1: a records submission awaiting approval cannot be hidden by archiving; the
  // condition is part of the update so a concurrent submit cannot slip past it.
  // REPORTS-P2-D1a: a pending schedule request must be decided or withdrawn first (same conditional update).
  const blocked = { deliveryMode: 'records', status: 'review_done' };
  // REPORTS-P2-D1b: archiving never stands in for an incomplete seal — an active or sealed lifecycle-managed case
  // is refused by the same conditional update (completed/cancelled managed cases may still be filed away).
  const lifecycleBlocked = { lifecycleMode: 'managed', lifecycleStatus: { in: ['active', 'sealed_incomplete'] } };
  const result = await prisma.case.updateMany({ where: { id: req.params.id, AND: [{ NOT: blocked }, { NOT: lifecycleBlocked }], pendingScheduleRequestId: null }, data: { archived: true } });
  if (result.count !== 1) {
    const row = await prisma.case.findUnique({ where: { id: req.params.id }, select: { id: true, pendingScheduleRequestId: true, lifecycleMode: true, lifecycleStatus: true } });
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.lifecycleMode === 'managed' && row.lifecycleStatus === 'sealed_incomplete') return res.status(409).json({ error: 'lifecycle_sealed', message: '案件已未完成封存。' });
    if (row.lifecycleMode === 'managed' && row.lifecycleStatus === 'active') return res.status(409).json({ error: 'lifecycle_seal_required', message: '未完成的受控案件不能直接封存；請提出未完成封存申請並經主管核准。' });
    if (row.pendingScheduleRequestId) return res.status(409).json({ error: 'schedule_request_pending', message: '此案件有待決議的改期申請，請先核准、退回或撤回，再封存。' });
    return res.status(409).json({ error: 'delivery_pending_review', message: '此案件的交付明細正待主管核可，請核可或退回，不能直接封存。' });
  }
  const updated = await prisma.case.findUnique({ where: { id: req.params.id }, include: caseInclude });
  res.json(updated);
});

// ─── POST /api/cases/:id/cancel — 專案取消 (v7.1) ──────────
// 取消 ≠ 結案：沒有交付，不得計入達成率/結案數/交付天數。
// 記錄「取消當下的階段」以評估白工程度（愈後期取消愈貴）。
// 權限：主負責人或 admin。自動封存（從看板/行事曆收起，仍可在歷史查到）。
const cancelSchema = z.object({
  reason: z.enum(CANCEL_REASONS),
  note: z.string().max(500).optional(),
  ...browserVersionFields, // REPORTS-P2-D1b: required for lifecycle-managed cases
});
router.post('/:id/cancel', async (req, res) => {
  const parsed = cancelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  const existing = await prisma.case.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (existing.status === 'cancelled') return res.status(409).json({ error: 'already_cancelled', message: '此案已是取消狀態' });
  const isAdmin = req.user?.role === 'admin';
  const isPrimary = existing.designerId === req.user?.id;
  if (!isAdmin && !isPrimary) {
    return res.status(403).json({ error: 'forbidden', message: '只有主負責人或 admin 可取消專案' });
  }
  if (terminalStatus(existing.status)) {
    return res.status(422).json({ error: 'closed_case', message: '已結案案件請先還原為進行中，再使用取消動作' });
  }
  // REPORTS-P2-D1b: a pending lifecycle request blocks cancellation (withdraw/reject first); sealed is read-only;
  // otherwise the current cycle closes as `cancelled` in the same transaction.
  const lifecycleIssue = lifecycleActionProblem(existing, parsed.data);
  if (lifecycleIssue) return sendTuple(res, lifecycleIssue);
  const lifecycleCancel = existing.lifecycleMode === 'managed';
  let updated;
  try {
    updated = await applyWorkflow(existing, {
      ...(lifecycleCancel && { lifecycleStatus: 'cancelled' }),
      status: 'cancelled', cancelReason: parsed.data.reason, cancelStage: existing.status,
      cancelledOn: taipeiCalendarDay(), archived: true, closedOn: null,
      note: parsed.data.note ? `${existing.note || ''}\n[取消] ${parsed.data.note}`.trim() : existing.note,
      ...(existing.pendingDeliverySubmissionId ? { pendingDeliverySubmissionId: null } : {}),
      ...(existing.pendingScheduleRequestId ? { pendingScheduleRequestId: null } : {}),
    }, [{ field: 'status', fromValue: existing.status, toValue: 'cancelled' }],
    `專案取消：${parsed.data.reason}${parsed.data.note ? ' — ' + parsed.data.note : ''}`, req.user.name, undefined, undefined, {
      // REPORTS-P1-C1: the actor is re-read in the transaction (current admin or current primary), and a
      // pending records submission is stamped "cancelled" by that current actor in the same transaction.
      revalidateActor: req.user, primaryOrAdmin: '只有主負責人或 admin 可取消專案',
      ...(lifecycleCancel && { snapshotLifecycle: true, bumpContentVersion: true, closeCycle: { outcome: 'cancelled', actor: req.user, reason: `專案取消：${parsed.data.reason}` } }),
      // REPORTS-P2-D1a: a pending schedule request is stamped "invalidated" in the same transaction too.
      inTx: async (tx, who) => {
        await cancelPendingSubmissionInTx(tx, existing, `專案取消：${parsed.data.reason}`, who.name, who.id);
        await invalidatePendingScheduleInTx(tx, existing, `專案取消：${parsed.data.reason}`, who.name, who.id);
      },
    });
  } catch (e) { if (sendWorkflowError(res, e)) return; throw e; }

  res.json(updated);
});

// ─── POST /api/cases/:id/uncancel — 還原取消 (v7.1) ─────────
// 取消後又要做的情況很常見；還原回取消前的階段，不重建新案。
router.post('/:id/uncancel', async (req, res) => {
  const existing = await prisma.case.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (existing.status !== 'cancelled') return res.status(409).json({ error: 'not_cancelled', message: '此案不是取消狀態' });
  // REPORTS-P2-D1b: a lifecycle-managed case is never reopened by uncancel (no reopen of cancelled cases in D1b).
  if (existing.lifecycleMode === 'managed') return res.status(409).json({ error: 'lifecycle_reopen_unavailable', message: '受控案件取消後本批不提供還原；週期紀錄已保留。' });
  const isAdmin = req.user?.role === 'admin';
  const isPrimary = existing.designerId === req.user?.id;
  if (!isAdmin && !isPrimary) {
    return res.status(403).json({ error: 'forbidden', message: '只有主負責人或 admin 可還原' });
  }
  let back = ACTIVE_STATUSES.includes(existing.cancelStage) ? existing.cancelStage : 'doing';
  // REPORTS-P1-C1: the records submission was invalidated by the cancellation; resubmit from doing.
  if (existing.deliveryMode === 'records' && back === 'review_done') back = 'doing';
  let updated;
  try {
    updated = await applyWorkflow(existing,
      { status: back, cancelReason: null, cancelStage: null, cancelledOn: null, archived: false, closedOn: null },
      [{ field: 'status', fromValue: 'cancelled', toValue: back }], '還原取消的專案', req.user.name);
  } catch (e) { if (sendWorkflowError(res, e)) return; throw e; }

  res.json(updated);
});

// ─── POST /api/cases/:id/transfer — explicit transfer ────
const transferSchema = z.object({ toDesignerId: z.number().int(), reason: z.string().default('主管派發'), ...browserVersionFields });
router.post('/:id/transfer', requireAdmin, async (req, res) => {
  const parsed = transferSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const { toDesignerId, reason } = parsed.data;

  const existing = await prisma.case.findUnique({ where: { id: req.params.id }, include: { designer: true } });
  if (!existing) return res.status(404).json({ error: 'not_found' });

  if (toDesignerId === existing.designerId) {
    return res.status(422).json({ error: 'same_designer', message: '請選擇不同的主負責人後再轉派' });
  }
  // REPORTS-P2-D1b: lifecycle-managed reassignment needs the browser's versions + cycle and is claimed with the
  // lifecycle snapshot; sealed or pending-lifecycle cases are refused.
  const lifecycleIssue = lifecycleActionProblem(existing, parsed.data);
  if (lifecycleIssue) return sendTuple(res, lifecycleIssue);
  let updated;
  try {
    updated = await applyWorkflow(existing, {},
      [{ field: 'designerId', fromValue: String(existing.designerId), toValue: String(toDesignerId) }],
      reason.trim() || '主管派發', req.user.name, toDesignerId, undefined,
      existing.lifecycleMode === 'managed' ? { snapshotLifecycle: true, bumpContentVersion: true, revalidateActor: req.user, patchPermission: { designerId: toDesignerId } } : undefined);
  } catch (e) { if (sendWorkflowError(res, e)) return; throw e; }
  const toStaff = updated.designer;

  // notify
  try {
    const tpl = tplCaseAssigned({
      caseRow: { ...updated, designerName: toStaff.name },
      operatorName: req.user.name,
    });
    await notify({ type: 'caseAssigned', recipientId: toStaff.id, ...tpl, relatedCaseId: updated.id });
  } catch (e) {
    console.warn('[transfer] notification failed:', e.message);
  }
  res.json(updated);
});

// ─── PATCH /api/cases/:id/items — 子案件編輯 (v4.3 B) ─────
// Permission: admin OR primary designer OR collaborator can edit.
// Replaces the whole items array (atomic update). Each item:
//   { n, type, owner, assigneeId?, start?, end?, status? }
const itemSchema = z.object({
  n: z.string().min(1),
  type: z.string().optional().default(''),
  owner: z.string().optional().default(''),
  assigneeId: z.number().int().nullable().optional(),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  // REPORTS-P1-A: stable server-issued identity; validated/reconciled against the stored snapshot.
  key: z.string().max(64).nullable().optional(),
  // D1: status 放寬為字串（支援完整製作流程清單），新增第二狀態
  status: z.string().optional().default('尚未製作'),
  status2: z.string().nullable().optional(),
  // 子項目日誌（每筆可編輯）
  logs: z.array(z.object({
    date: z.string().optional(),
    note: z.string().min(1).max(2000),
    by: z.string().optional(),
  })).max(200).optional(),
});
const itemsPatchSchema = z.object({
  items: z.array(itemSchema).max(50),
  reason: z.string().optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
  expectedContentVersion: z.number().int().nonnegative().optional(),
  expectedCycleId: expectedCycleField, // REPORTS-P2-D1b
});
router.patch('/:id/items', async (req, res) => {
  const parsed = itemsPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  }
  const existing = await prisma.case.findUnique({
    where: { id: req.params.id },
    include: { collaborators: { select: { id: true } } },
  });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  // Permission: admin OR primary designer OR collaborator
  const isAdmin = req.user?.role === 'admin';
  const isPrimary = existing.designerId === req.user?.id;
  const isCollab = existing.collaborators.some(c => c.id === req.user?.id);
  if (!isAdmin && !isPrimary && !isCollab) {
    return res.status(403).json({
      error: 'forbidden',
      message: '只有主負責人、協作者或 admin 可編輯子案件',
    });
  }
  const oldItemsCount = Array.isArray(existing.items) ? existing.items.length : 0;
  const newItems = parsed.data.items;
  let updated;
  // REPORTS-P1-A: keys are reconciled against the snapshot the conditional update claims;
  // a concurrent delivery write advances contentVersion, so this update then 409s.
  const prepare = async snapshot => {
    // REPORTS-P1-C1: items are part of the submission evidence while pending and after approval.
    if (recordsFrozen(snapshot)) throw new CaseEditError(409, 'delivery_evidence_frozen', '送審中或已核可的交付明細制案件，子案件已凍結；如需更正請先撤回或由主管退回。');
    return reconcileItemKeys(snapshot.items, newItems, await linkedItemKeys(prisma, existing.id));
  };
  try { updated = await replaceCaseJson(existing.id, req.user, 'items', newItems, parsed.data.expectedUpdatedAt, parsed.data.expectedContentVersion, prepare, parsed.data.expectedCycleId); }
  catch (e) { if (sendCaseEditError(res, e)) return; throw e; }

  // ChangeLog
  try {
    await writeChangeLog(
      existing.id,
      [{ field: 'items', fromValue: `${oldItemsCount} 項`, toValue: `${newItems.length} 項` }],
      parsed.data.reason || '子案件調整',
      req.user.name,
    );
  } catch (e) { console.warn('[items patch] changelog failed:', e.message); }
  res.json(updated);
});

// ─── PATCH /api/cases/:id/logs — 進度日誌持久化 (A3) ──────────
// 整包替換 logs 陣列（新增/編輯/刪除皆送完整陣列）。
const logEntrySchema = z.object({
  id: z.string().min(8).max(100).optional(),
  date: z.string().optional(),
  note: z.string().min(1).max(2000),
  by: z.string().optional(),
  tag: z.string().max(20).optional(),
  tagBy: z.string().max(20).optional(),
  fromMeeting: z.number().int().positive().optional(),
}).passthrough();
const logsPatchSchema = z.object({
  logs: z.array(logEntrySchema).max(500),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
  expectedContentVersion: z.number().int().nonnegative().optional(),
  expectedCycleId: expectedCycleField, // REPORTS-P2-D1b
});
const appendLogSchema = z.object({
  entry: z.object({
    id: z.string().min(8).max(100),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
      const date = new Date(s + 'T00:00:00Z');
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === s;
    }, '日期無效').optional(),
    note: z.string().trim().min(1).max(2000),
    tag: z.string().max(20).nullable().optional(),
    tagBy: z.string().max(20).nullable().optional(),
  }),
  expectedCycleId: expectedCycleField, // REPORTS-P2-D1b
});
router.post('/:id/logs', async (req, res) => {
  const parsed = appendLogSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  try { res.json(await appendCaseLog(req.params.id, req.user, parsed.data.entry, parsed.data.expectedCycleId)); }
  catch (e) { if (sendCaseEditError(res, e)) return; throw e; }
});
router.patch('/:id/logs', async (req, res) => {
  const parsed = logsPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  }
  const existing = await prisma.case.findUnique({
    where: { id: req.params.id },
    include: { collaborators: { select: { id: true } } },
  });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  // Permission: admin OR primary designer OR collaborator（協作者可共寫進度日誌）
  const isAdmin = req.user?.role === 'admin';
  const isPrimary = existing.designerId === req.user?.id;
  const isCollab = existing.collaborators.some(c => c.id === req.user?.id);
  if (!isAdmin && !isPrimary && !isCollab) {
    return res.status(403).json({
      error: 'forbidden',
      message: '只有主負責人、協作者或 admin 可編輯進度日誌',
    });
  }
  let updated;
  try { updated = await replaceCaseJson(existing.id, req.user, 'logs', parsed.data.logs, parsed.data.expectedUpdatedAt, parsed.data.expectedContentVersion, undefined, parsed.data.expectedCycleId); }
  catch (e) { if (sendCaseEditError(res, e)) return; throw e; }

  res.json(updated);
});

// ─── POST /api/cases/:id/clone — 原案重啟 (v3.7) ────────────
// Creates a NEW case copying most fields from a closed/archived one.
// New ID, new openDate (today), new status (todo), no closedOn.
// Optional `reasonForReopen` written into the new case's note.
const cloneSchema = z.object({
  reasonForReopen: z.string().optional(),
  goLiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
router.post('/:id/clone', async (req, res) => {
  const parsed = cloneSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const src = await prisma.case.findUnique({
    where: { id: req.params.id },
    include: { collaborators: { select: { id: true } } },
  });
  if (!src) return res.status(404).json({ error: 'not_found' });

  // Permission: admin OR original case's primary designer (assigned now).
  const isAdmin = req.user?.role === 'admin';
  const isDesigner = src.designerId === req.user?.id;
  if (!isAdmin && !isDesigner) {
    return res.status(403).json({ error: 'forbidden', message: '只有 admin 或原負責人可以原案重啟' });
  }
  // REPORTS-P2-D1b: a sealed (or pending seal/resume) lifecycle-managed case resumes only through an approved
  // resume request on the same case ID — the clone ("原案重啟", a NEW case) is not a side door.
  if (src.lifecycleMode === 'managed' && (src.lifecycleStatus === 'sealed_incomplete' || src.pendingLifecycleRequestId)) {
    return res.status(409).json({ error: 'lifecycle_resume_required', message: '未完成封存的案件請改提復工申請並經主管核准，沿用同一案號。' });
  }

  const today = taipeiCalendarDay();
  const newGoLive = parsed.data.goLiveDate
    ? new Date(parsed.data.goLiveDate + 'T00:00:00Z')
    : new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);

  const note = [
    `🔁 原案重啟：來源 ${src.id}「${src.title}」`,
    parsed.data.reasonForReopen ? `原因：${parsed.data.reasonForReopen}` : null,
    src.note ? '— 上次紀錄 —' : null,
    src.note || null,
  ].filter(Boolean).join('\n');

  const created = await createWithCaseId(src.level, today, id => prisma.case.create({
    data: {
      id,
      title: src.title,
      subTitle: src.subTitle,
      requester: src.requester,
      hotel: src.hotel,
      level: src.level,
      category: src.category,
      status: 'todo',
      urgent: src.urgent,
      note,
      openDate: today,
      dispatchDate: today,
      copyDate: src.copyDate, // optional reference
      goLiveDate: newGoLive,
      designer: { connect: { id: src.designerId } },
      collaborators: { connect: src.collaborators.filter(c => c.id !== src.designerId).map((c) => ({ id: c.id })) },
      createdBy: req.user?.id ? { connect: { id: req.user.id } } : undefined,
      ...recordsModeStamp(req.user), // REPORTS-P1-C1：clone 是新案，依新建規則；不複製交付或送審
    },
    include: caseInclude,
  }));

  // Notify designer of the new case
  try {
    await notify({
      type: 'caseAssigned',
      recipientId: created.designerId,
      subject: `🔁 原案重啟：${created.id} · ${created.title}`,
      body: `案件 ${src.id} 已重新開立為 ${created.id}，請檢視 note 中的歷史紀錄。`,
      relatedCaseId: created.id,
    });
  } catch (e) {
    console.warn('[clone] notify failed:', e.message);
  }

  res.status(201).json(created);
});

export default router;
