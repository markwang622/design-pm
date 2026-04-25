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
  requester: z.string().min(1),
  hotel: z.string().optional(),
  level: z.enum(['SS', 'S', 'A', 'B', 'C', 'D']),
  category: z.string().optional(),
  designerId: z.number().int(),
  collaboratorIds: z.array(z.number().int()).max(3).default([]),
  openDate: dateStr,
  dispatchDate: dateStr,
  copyDate: dateStr.optional(),
  goLiveDate: dateStr,
  urgent: z.boolean().default(false),
  note: z.string().default(''),
});

const updateSchema = z.object({
  title: z.string().optional(),
  subTitle: z.string().optional(),
  requester: z.string().optional(),
  hotel: z.string().optional(),
  level: z.enum(['SS', 'S', 'A', 'B', 'C', 'D']).optional(),
  category: z.string().optional(),
  status: z.enum(['todo', 'wait', 'doing', 'review', 'done']).optional(),
  designerId: z.number().int().optional(),
  collaboratorIds: z.array(z.number().int()).max(3).optional(),
  openDate: dateStr.optional(),
  dispatchDate: dateStr.optional(),
  copyDate: dateStr.optional().nullable(),
  goLiveDate: dateStr.optional(),
  urgent: z.boolean().optional(),
  note: z.string().optional(),
  archivePath: z.string().optional().nullable(),
  reason: z.string().optional(), // required only when tracked fields change
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

  const id = await nextCaseId(body.level, body.openDate);

  const created = await prisma.case.create({
    data: {
      id,
      title: body.title,
      subTitle: body.subTitle,
      requester: body.requester,
      hotel: body.hotel,
      level: body.level,
      category: body.category,
      openDate: body.openDate,
      dispatchDate: body.dispatchDate,
      copyDate: body.copyDate,
      goLiveDate: body.goLiveDate,
      urgent: body.urgent,
      note: body.note,
      designer: { connect: { id: body.designerId } },
      collaborators: { connect: collabIds.map((id) => ({ id })) },
      createdBy: req.user?.id ? { connect: { id: req.user.id } } : undefined,
    },
    include: caseInclude,
  });

  // Fire-and-forget notifications
  try {
    const designerRow = created.designer;
    const operatorName = req.user.name;

    // Notify primary
    const tpl = tplCaseAssigned({
      caseRow: { ...created, designerName: designerRow.name },
      operatorName,
    });
    await notify({ type: 'caseAssigned', recipientId: designerRow.id, ...tpl, relatedCaseId: created.id });

    // Notify collaborators
    for (const c of created.collaborators) {
      const t = tplCollabInvite({
        caseRow: { ...created, designerName: designerRow.name },
        operatorName,
      });
      await notify({ type: 'collabInvite', recipientId: c.id, ...t, relatedCaseId: created.id });
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

  // ── Archive-path guard (PRD §5.6) ───────────────────────
  if (body.status === 'done') {
    const nextPath = body.archivePath !== undefined ? body.archivePath : existing.archivePath;
    if (!nextPath || !String(nextPath).trim()) {
      return res.status(422).json({
        error: 'archive_path_required',
        message: '未填寫檔案歸檔位置，無法結案',
      });
    }
  }

  // ── ChangeLog reason guard (v3.3) ───────────────────────
  // For diffing: build a synthetic "patch" with the values to compare.
  const trackedPatch = {};
  for (const f of TRACKED_FIELDS) {
    if (body[f] !== undefined) trackedPatch[f] = body[f];
  }
  const changes = detectChanges(existing, trackedPatch);
  const reasonStr = (body.reason || '').trim();
  if (changes.length > 0 && !reasonStr) {
    return res.status(422).json({
      error: 'reason_required',
      message: '時程或任務欄位調整時，必須填寫調整原因',
      changedFields: changes.map((c) => c.field),
    });
  }

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
    ...(body.goLiveDate !== undefined && { goLiveDate: body.goLiveDate }),
    ...(body.urgent !== undefined && { urgent: body.urgent }),
    ...(body.note !== undefined && { note: body.note }),
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

  // When going to done, stamp closedOn
  if (body.status === 'done' && existing.status !== 'done') {
    data.closedOn = new Date();
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

  res.json(updated);
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

export default router;
