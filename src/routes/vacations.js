// ─────────────────────────────────────────────────────────────
// Vacation routes — anyone can CRUD their own; admin can CRUD anyone's.
// All staff can view all vacations (so kanban / gantt show them).
// ─────────────────────────────────────────────────────────────
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform((s) => new Date(s + 'T00:00:00Z'));

const createSchema = z.object({
  staffId: z.number().int().optional(), // self by default; admin can specify
  startDate: dateStr,
  endDate: dateStr,
  type: z.enum(['annual', 'sick', 'personal', 'other']).default('annual'),
  note: z.string().default(''),
});

const updateSchema = z.object({
  startDate: dateStr.optional(),
  endDate: dateStr.optional(),
  type: z.enum(['annual', 'sick', 'personal', 'other']).optional(),
  note: z.string().optional(),
});

const include = {
  staff: { select: { id: true, name: true } },
};

// GET — list. Optional ?staffId= or ?from= / ?to= filter.
router.get('/', async (req, res) => {
  const where = {};
  if (req.query.staffId) where.staffId = Number(req.query.staffId);
  if (req.query.from || req.query.to) {
    where.AND = [];
    if (req.query.from) where.AND.push({ endDate: { gte: new Date(req.query.from) } });
    if (req.query.to) where.AND.push({ startDate: { lte: new Date(req.query.to) } });
  }
  const rows = await prisma.vacation.findMany({
    where,
    include,
    orderBy: { startDate: 'desc' },
  });
  res.json(rows);
});

// POST — create. Defaults to self; admin can specify staffId.
router.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  const body = parsed.data;
  let staffId = body.staffId ?? req.user.id;
  if (staffId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden', message: '只能填寫自己的休假' });
  }
  if (body.endDate < body.startDate) {
    return res.status(422).json({ error: 'invalid_range', message: '結束日不能早於起始日' });
  }
  const created = await prisma.vacation.create({
    data: { staffId, startDate: body.startDate, endDate: body.endDate, type: body.type, note: body.note },
    include,
  });
  res.status(201).json(created);
});

// PATCH — update. Self or admin.
router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.vacation.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (existing.staffId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const updated = await prisma.vacation.update({ where: { id }, data: parsed.data, include });
  res.json(updated);
});

// DELETE — self or admin.
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.vacation.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (existing.staffId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  await prisma.vacation.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
