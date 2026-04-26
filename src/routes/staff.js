import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireAuth, requireAdmin, validatePasswordStrength } from '../middleware/auth.js';
import { workloadScore, workloadForAll, suggestSuccessor } from '../services/workload.js';
import { notify, tplStaffAdd, tplDeparture } from '../services/notify.js';

const router = Router();
router.use(requireAuth);

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform((s) => new Date(s + 'T00:00:00Z'));

// ─── GET /api/staff — list with workload scores ──────────
router.get('/', async (req, res) => {
  const includeInactive = req.query.includeInactive === '1';
  const staff = await prisma.staff.findMany({
    where: includeInactive ? {} : { active: true },
    select: {
      id: true, name: true, email: true, active: true, joined: true, departedOn: true,
      seniority: true, roleTitle: true, role: true,
    },
    orderBy: [{ active: 'desc' }, { id: 'asc' }],
  });
  const enriched = await Promise.all(
    staff.map(async (s) => ({ ...s, workload: await workloadScore(s.id) }))
  );
  res.json(enriched);
});

// ─── GET /api/staff/workload — all active members sorted ─
router.get('/workload', async (req, res) => {
  const rows = await workloadForAll();
  res.json(rows);
});

// ─── POST /api/staff — create (admin) ────────────────────
const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8).optional(),
  joined: dateStr,
  seniority: z.enum(['senior', 'mid', 'junior']),
  roleTitle: z.string().optional(),
  role: z.enum(['admin', 'member']).default('member'),
});

router.post('/', requireAdmin, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  const body = parsed.data;

  const defaultPw = process.env.SEED_DEFAULT_PASSWORD || 'design2026!';
  // v3.6 (#22): if admin supplies a password, enforce strength
  if (body.password) {
    const strengthErr = validatePasswordStrength(body.password);
    if (strengthErr) {
      return res.status(422).json({ error: 'weak_password', message: strengthErr });
    }
  }
  const hash = await bcrypt.hash(body.password || defaultPw, 12);

  try {
    const created = await prisma.staff.create({
      data: {
        name: body.name,
        email: body.email,
        password: hash,
        joined: body.joined,
        seniority: body.seniority,
        roleTitle: body.roleTitle || '設計師',
        role: body.role,
      },
    });

    // Notify all active members
    const others = await prisma.staff.findMany({ where: { active: true, NOT: { id: created.id } }, select: { id: true } });
    const tpl = tplStaffAdd({ newStaff: created });
    await Promise.all(
      others.map((o) => notify({ type: 'staffAdd', recipientId: o.id, ...tpl }))
    );

    res.status(201).json({
      ...created, password: undefined,
      tempPassword: body.password ? undefined : defaultPw,
    });
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({ error: 'duplicate', field: e.meta?.target });
    }
    throw e;
  }
});

// ─── PATCH /api/staff/:id — update (admin or self, v3.4 expanded) ─
const updateSchema = z.object({
  name: z.string().optional(),
  email: z.string().email().optional(),
  seniority: z.enum(['senior', 'mid', 'junior']).optional(),
  roleTitle: z.string().optional(),
  role: z.enum(['admin', 'member']).optional(),
  // v3.4: admin-only password reset for OTHER users
  resetPassword: z.string().min(8).optional(),
});

router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid_id' });

  const isSelf = req.user.id === id;
  const isAdmin = req.user.role === 'admin';

  if (!isSelf && !isAdmin) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });

  const data = { ...parsed.data };
  // non-admin cannot change role
  if (data.role && !isAdmin) delete data.role;
  // Password reset: only admin, only for OTHER users (self uses /change-password with current pw)
  if (data.resetPassword !== undefined) {
    if (!isAdmin || isSelf) {
      return res.status(403).json({
        error: 'password_reset_forbidden',
        message: '管理員只能重設他人的密碼；自己的密碼請走「修改密碼」並輸入舊密碼',
      });
    }
    // v3.6 (#22): enforce strength on admin-reset too
    const strengthErr = validatePasswordStrength(data.resetPassword);
    if (strengthErr) {
      return res.status(422).json({ error: 'weak_password', message: strengthErr });
    }
    data.password = await bcrypt.hash(data.resetPassword, 12);
    delete data.resetPassword;
  }

  try {
    const updated = await prisma.staff.update({ where: { id }, data });
    res.json({ ...updated, password: undefined });
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({ error: 'duplicate', field: e.meta?.target });
    }
    if (e.code === 'P2025') {
      return res.status(404).json({ error: 'not_found' });
    }
    throw e;
  }
});

// ─── GET /api/staff/:id/departure-preview — pre-compute ──
router.get('/:id/departure-preview', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const leaver = await prisma.staff.findUnique({ where: { id } });
  if (!leaver) return res.status(404).json({ error: 'not_found' });

  const [ownedDone, ownedOpen, collabOn] = await Promise.all([
    prisma.case.findMany({ where: { designerId: id, status: 'done', archived: false } }),
    prisma.case.findMany({
      where: { designerId: id, status: { not: 'done' }, archived: false },
      include: { collaborators: { select: { id: true, name: true } } },
    }),
    prisma.case.findMany({
      where: { archived: false, collaborators: { some: { id } }, NOT: { designerId: id } },
      select: { id: true, title: true, designerId: true },
    }),
  ]);

  const suggestions = await Promise.all(
    ownedOpen.map(async (c) => ({
      caseId: c.id,
      suggestion: await suggestSuccessor({ excludeId: id, level: c.level }),
    }))
  );

  res.json({
    leaver: { id: leaver.id, name: leaver.name, joined: leaver.joined, seniority: leaver.seniority },
    toArchive: ownedDone.map((c) => ({ id: c.id, title: c.title })),
    toTransfer: ownedOpen.map((c) => ({
      id: c.id,
      title: c.title,
      level: c.level,
      status: c.status,
      goLiveDate: c.goLiveDate,
      collaborators: c.collaborators,
      suggestion: suggestions.find((s) => s.caseId === c.id)?.suggestion ?? null,
    })),
    toRemoveCollab: collabOn,
  });
});

// ─── POST /api/staff/:id/departure — execute ─────────────
const departureSchema = z.object({
  successors: z.record(z.string(), z.number().int()), // caseId → newDesignerId
});

router.post('/:id/departure', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const parsed = departureSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const leaver = await prisma.staff.findUnique({ where: { id } });
  if (!leaver) return res.status(404).json({ error: 'not_found' });
  if (!leaver.active) return res.status(400).json({ error: 'already_departed' });

  // Pull current state
  const [ownedDone, ownedOpen, collabOn] = await Promise.all([
    prisma.case.findMany({ where: { designerId: id, status: 'done', archived: false } }),
    prisma.case.findMany({ where: { designerId: id, status: { not: 'done' }, archived: false } }),
    prisma.case.findMany({
      where: { archived: false, collaborators: { some: { id } }, NOT: { designerId: id } },
      select: { id: true },
    }),
  ]);

  // Ensure every open owned case has a successor
  for (const c of ownedOpen) {
    if (!parsed.data.successors[c.id]) {
      return res.status(400).json({
        error: 'missing_successor',
        caseId: c.id,
        message: `案件 ${c.id} 尚未指定繼承人`,
      });
    }
  }

  const transferred = [];
  const archived = [];
  const removedCollab = [];

  await prisma.$transaction(async (tx) => {
    // 1. Archive done cases
    for (const c of ownedDone) {
      await tx.case.update({ where: { id: c.id }, data: { archived: true } });
      archived.push(c.id);
    }

    // 2. Transfer open cases
    for (const c of ownedOpen) {
      const toId = parsed.data.successors[c.id];
      const toStaff = await tx.staff.findUnique({ where: { id: toId }, select: { id: true, name: true } });
      if (!toStaff) throw new Error(`successor ${toId} not found`);
      await tx.case.update({
        where: { id: c.id },
        data: { designer: { connect: { id: toId } } },
      });
      await tx.transferLog.create({
        data: {
          caseId: c.id,
          fromName: leaver.name,
          toName: toStaff.name,
          reason: '離職移轉',
          operator: req.user.name,
        },
      });
      transferred.push({ caseId: c.id, toName: toStaff.name });
    }

    // 3. Remove collaborator relationships
    for (const c of collabOn) {
      await tx.case.update({
        where: { id: c.id },
        data: { collaborators: { disconnect: { id } } },
      });
      removedCollab.push(c.id);
    }

    // 4. Mark staff inactive
    await tx.staff.update({
      where: { id },
      data: { active: false, departedOn: new Date() },
    });
  });

  // Notifications (outside transaction)
  try {
    const tpl = tplDeparture({ leaver, transferred, archived, removedCollab });
    const admins = await prisma.staff.findMany({ where: { role: 'admin', active: true }, select: { id: true } });
    const recipientIds = new Set([
      ...admins.map((a) => a.id),
      ...(await Promise.all(
        transferred.map(async (t) => {
          const s = await prisma.staff.findUnique({ where: { name: t.toName }, select: { id: true } });
          return s?.id;
        })
      )).filter(Boolean),
    ]);
    for (const rid of recipientIds) {
      await notify({ type: 'departure', recipientId: rid, ...tpl });
    }
  } catch (e) {
    console.warn('[departure] notification failed:', e.message);
  }

  res.json({ ok: true, transferred, archived, removedCollab });
});

// ─── DELETE /api/staff/:id — hard delete (admin, rare) ──
router.delete('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  // safety: must be inactive
  const s = await prisma.staff.findUnique({ where: { id } });
  if (!s) return res.status(404).json({ error: 'not_found' });
  if (s.active) return res.status(400).json({ error: 'active_staff_cannot_delete' });
  await prisma.staff.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
