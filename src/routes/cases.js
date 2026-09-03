import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { nextCaseId } from '../lib/ids.js';
import { notify, tplCaseAssigned, tplCollabInvite } from '../services/notify.js';
import { detectChanges, writeChangeLog, TRACKED_FIELDS } from '../services/changelog.js';

const router = Router();
router.use(requireAuth);

// ─── Helpers ───────────────────────────────────────────────
const caseInclude = {
  designer: { select: { id: true, name: true, seniority: true, active: true } },
  collaborators: { select: { id: true, name: true, seniority: true, active: true } },
  createdBy: { select: { id: true, name: true } },
};

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
  reason: z.string().optional(), // required only when tracked fields change
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
  requestCount: z.number().int().optional(),
  outputCount: z.number().int().optional(),
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
  const today = new Date();

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
      const id = await nextCaseId(r.level, openDate);
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
      // Status-specific fields (v3.6: any of done/closed/review_done are "終態")
      const isFinal = r.status === 'done' || r.status === 'closed' || r.status === 'review_done';
      if (isFinal) {
        data.closedOn = closedOn || today;
        if (r.archivePath) data.archivePath = r.archivePath;
        if (r.requestCount !== undefined) data.requestCount = r.requestCount;
        if (r.outputCount !== undefined) data.outputCount = r.outputCount;
        if (data.archivePath == null || data.archivePath === '') {
          data.archivePath = `/設計部共用/2026/匯入/${id}-${r.title}`.replace(/\s+/g, '_');
        }
        // closed → also auto-archive (v3.6 #17)
        if (r.status === 'closed') data.archived = true;
      }

      const row = await prisma.case.create({ data, include: caseInclude });
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
    include: caseInclude,
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

  // Designer must not be in collaborators list
  const collabIds = body.collaboratorIds.filter((id) => id !== body.designerId);

  // Bug #1 修復：nextCaseId 為「讀最大+1」非原子，兩個併發建立可能撞同 ID。
  // 撞號（P2002 unique violation）時重算 ID 再試，最多 5 次。
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
    items: body.items ?? undefined,
    logs: body.logs ?? undefined,
    designer: { connect: { id: body.designerId } },
    collaborators: { connect: collabIds.map((id) => ({ id })) },
    createdBy: req.user?.id ? { connect: { id: req.user.id } } : undefined,
  };
  let created;
  for (let attempt = 0; ; attempt++) {
    const id = await nextCaseId(body.level, body.openDate);
    try {
      created = await prisma.case.create({ data: { id, ...caseData }, include: caseInclude });
      break;
    } catch (e) {
      if (e.code === 'P2002' && attempt < 4) continue; // ID 撞號 → 重算重試
      throw e;
    }
  }

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

  const existing = await prisma.case.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'not_found' });

  // ── Permission: non-admin can only PATCH cases they own (v3.6 #16) ──
  // Note: bulk-import / approval / transfer have their own permission gates.
  if (req.user.role !== 'admin' && existing.designerId !== req.user.id) {
    // Allow self-collaborated cases? For simplicity, NO — only the primary
    // designer may edit. Collaborators read but don't write.
    return res.status(403).json({
      error: 'forbidden',
      message: '此案件不屬於你，僅主負責人可修改',
    });
  }

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
  };

  if (body.designerId !== undefined && body.designerId !== existing.designerId) {
    data.designer = { connect: { id: body.designerId } };
    await prisma.transferLog.create({
      data: {
        caseId: existing.id,
        fromName: (await prisma.staff.findUnique({ where: { id: existing.designerId }, select: { name: true } }))?.name ?? '—',
        toName: (await prisma.staff.findUnique({ where: { id: body.designerId }, select: { name: true } }))?.name ?? '—',
        reason: '主管派發',
        operator: req.user.name,
      },
    });
  }

  if (body.collaboratorIds !== undefined) {
    data.collaborators = {
      set: body.collaboratorIds.filter((id) => id !== (body.designerId ?? existing.designerId)).map((id) => ({ id })),
    };
  }

  // When entering a final-ish state, stamp closedOn (idempotent)
  if (body.status && FINAL_STATUSES.has(body.status) && !existing.closedOn) {
    data.closedOn = new Date();
  }

  // (v3.6 #17) closed → auto-archive
  if (body.status === 'closed') {
    data.archived = true;
  }

  const updated = await prisma.case.update({
    where: { id: req.params.id },
    data,
    include: caseInclude,
  });

  // Persist ChangeLog rows for tracked-field diffs
  if (changes.length > 0) {
    try {
      await writeChangeLog(updated.id, changes, reasonStr, req.user.name);
    } catch (e) {
      console.warn('[cases.update] changelog write failed:', e.message);
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
  if (existing.status !== 'review_done') {
    return res.status(409).json({
      error: 'wrong_state',
      message: '此案件不在「確稿完成」狀態，無法審核',
      currentStatus: existing.status,
    });
  }

  const data = { };
  if (decision === 'approve') {
    if (!existing.archivePath || !String(existing.archivePath).trim()) {
      return res.status(422).json({
        error: 'archive_path_required',
        message: '結案前必須先填寫檔案歸檔位置',
      });
    }
    data.status = 'closed';
    data.archived = true;
    if (!existing.closedOn) data.closedOn = new Date();
  } else {
    data.status = 'doing';
  }

  const updated = await prisma.case.update({
    where: { id: existing.id },
    data,
    include: caseInclude,
  });

  // ChangeLog
  try {
    await writeChangeLog(
      updated.id,
      [{ field: 'status', fromValue: 'review_done', toValue: data.status }],
      decision === 'approve' ? `審核通過 ${comment ? '— ' + comment : ''}` : `退回修改 ${comment ? '— ' + comment : ''}`,
      req.user.name,
    );
  } catch (e) {
    console.warn('[approve] changelog failed:', e.message);
  }

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
  await prisma.$transaction([
    prisma.notification.updateMany({
      where: { relatedCaseId: existing.id },
      data: { relatedCaseId: null },
    }),
    prisma.case.delete({ where: { id: existing.id } }),
  ]);

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
  const updated = await prisma.case.update({
    where: { id: req.params.id },
    data: { archived: true },
    include: caseInclude,
  });
  res.json(updated);
});

// ─── POST /api/cases/:id/cancel — 專案取消 (v7.1) ──────────
// 取消 ≠ 結案：沒有交付，不得計入達成率/結案數/交付天數。
// 記錄「取消當下的階段」以評估白工程度（愈後期取消愈貴）。
// 權限：主負責人或 admin。自動封存（從看板/行事曆收起，仍可在歷史查到）。
const CANCEL_REASONS = ['需求方取消', '活動/檔期取消', '預算未過', '重複需求', '併入其他案', '延到下期', '內部方向調整', '其他'];
const cancelSchema = z.object({
  reason: z.enum(CANCEL_REASONS),
  note: z.string().max(500).optional(),
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
  const updated = await prisma.case.update({
    where: { id: existing.id },
    data: {
      status: 'cancelled',
      cancelReason: parsed.data.reason,
      cancelStage: existing.status,           // 取消當下的階段＝白工程度依據
      cancelledOn: new Date(),
      archived: true,                          // 自動收起
      note: parsed.data.note ? `${existing.note || ''}\n[取消] ${parsed.data.note}`.trim() : existing.note,
    },
    include: caseInclude,
  });
  await writeChangeLog(
    existing.id,
    [{ field: 'status', fromValue: existing.status, toValue: 'cancelled' }],
    `專案取消：${parsed.data.reason}${parsed.data.note ? ' — ' + parsed.data.note : ''}`,
    req.user?.name || ''
  ).catch((e) => console.warn('[cancel] changelog failed:', e.message));
  res.json(updated);
});

// ─── POST /api/cases/:id/uncancel — 還原取消 (v7.1) ─────────
// 取消後又要做的情況很常見；還原回取消前的階段，不重建新案。
router.post('/:id/uncancel', async (req, res) => {
  const existing = await prisma.case.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (existing.status !== 'cancelled') return res.status(409).json({ error: 'not_cancelled', message: '此案不是取消狀態' });
  const isAdmin = req.user?.role === 'admin';
  const isPrimary = existing.designerId === req.user?.id;
  if (!isAdmin && !isPrimary) {
    return res.status(403).json({ error: 'forbidden', message: '只有主負責人或 admin 可還原' });
  }
  const back = existing.cancelStage || 'doing';
  const updated = await prisma.case.update({
    where: { id: existing.id },
    data: { status: back, cancelReason: null, cancelStage: null, cancelledOn: null, archived: false },
    include: caseInclude,
  });
  await writeChangeLog(
    existing.id,
    [{ field: 'status', fromValue: 'cancelled', toValue: back }],
    '還原取消的專案',
    req.user?.name || ''
  ).catch(() => {});
  res.json(updated);
});

// ─── POST /api/cases/:id/transfer — explicit transfer ────
const transferSchema = z.object({ toDesignerId: z.number().int(), reason: z.string().default('主管派發') });
router.post('/:id/transfer', requireAdmin, async (req, res) => {
  const parsed = transferSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const { toDesignerId, reason } = parsed.data;

  const existing = await prisma.case.findUnique({ where: { id: req.params.id }, include: { designer: true } });
  if (!existing) return res.status(404).json({ error: 'not_found' });

  const toStaff = await prisma.staff.findUnique({ where: { id: toDesignerId } });
  if (!toStaff) return res.status(400).json({ error: 'designer_not_found' });

  const updated = await prisma.case.update({
    where: { id: req.params.id },
    data: { designer: { connect: { id: toDesignerId } } },
    include: caseInclude,
  });
  await prisma.transferLog.create({
    data: {
      caseId: existing.id,
      fromName: existing.designer.name,
      toName: toStaff.name,
      reason,
      operator: req.user.name,
    },
  });

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
  const updated = await prisma.case.update({
    where: { id: existing.id },
    data: { items: newItems },
    include: caseInclude,
  });
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
const logsPatchSchema = z.object({
  logs: z.array(z.object({
    date: z.string().optional(),
    note: z.string().min(1).max(2000),
    by: z.string().optional(),
    // v6.8: 事件標籤（改稿/需求變更/等待中…）+ 改稿來源，供管理分析累計
    tag: z.string().max(20).optional(),
    tagBy: z.string().max(20).optional(),
  })).max(500),
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
  const updated = await prisma.case.update({
    where: { id: existing.id },
    data: { logs: parsed.data.logs },
    include: caseInclude,
  });
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

  const today = new Date();
  const newId = await nextCaseId(src.level, today);
  const newGoLive = parsed.data.goLiveDate
    ? new Date(parsed.data.goLiveDate + 'T00:00:00Z')
    : new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);

  const note = [
    `🔁 原案重啟：來源 ${src.id}「${src.title}」`,
    parsed.data.reasonForReopen ? `原因：${parsed.data.reasonForReopen}` : null,
    src.note ? '— 上次紀錄 —' : null,
    src.note || null,
  ].filter(Boolean).join('\n');

  const created = await prisma.case.create({
    data: {
      id: newId,
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
      collaborators: { connect: src.collaborators.map((c) => ({ id: c.id })) },
      createdBy: req.user?.id ? { connect: { id: req.user.id } } : undefined,
    },
    include: caseInclude,
  });

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
