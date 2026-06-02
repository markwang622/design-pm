// ─────────────────────────────────────────────────────────────
// Shoot routes (G2) — 拍攝行程，部門共享、不綁特定同仁。
// 任何登入者可建立/瀏覽；編輯/刪除限建立者或 admin。
// ─────────────────────────────────────────────────────────────
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform((s) => new Date(s + 'T00:00:00Z'));

const createSchema = z.object({
  desc: z.string().min(1).max(300),
  mode: z.enum(['in-house', 'outsource']).default('in-house'),
  startDate: dateStr,
  endDate: dateStr,
  photographer: z.string().max(120).default(''),
  hotel: z.string().max(60).optional().nullable(),
  note: z.string().max(500).default(''),
});

const updateSchema = z.object({
  desc: z.string().min(1).max(300).optional(),
  mode: z.enum(['in-house', 'outsource']).optional(),
  startDate: dateStr.optional(),
  endDate: dateStr.optional(),
  photographer: z.string().max(120).optional(),
  hotel: z.string().max(60).optional().nullable(),
  note: z.string().max(500).optional(),
});

const include = {
  createdBy: { select: { id: true, name: true } },
};

router.get('/', async (req, res) => {
  const where = {};
  if (req.query.from || req.query.to) {
    where.AND = [];
    if (req.query.from) where.AND.push({ endDate: { gte: new Date(req.query.from) } });
    if (req.query.to) where.AND.push({ startDate: { lte: new Date(req.query.to) } });
  }
  const rows = await prisma.shoot.findMany({
    where, include, orderBy: { startDate: 'desc' },
  });
  res.json(rows);
});

router.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  const body = parsed.data;
  if (body.endDate < body.startDate) {
    return res.status(422).json({ error: 'invalid_range', message: '結束日不能早於起始日' });
  }
  const created = await prisma.shoot.create({
    data: {
      desc: body.desc,
      mode: body.mode,
      startDate: body.startDate,
      endDate: body.endDate,
      photographer: body.photographer,
      hotel: body.hotel ?? null,
      note: body.note,
      createdById: req.user?.id ?? null,
    },
    include,
  });
  res.status(201).json(created);
});

router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.shoot.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  // 編輯權限：建立者或 admin
  if (existing.createdById && existing.createdById !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden', message: '只有建立者或 admin 可編輯此拍攝行程' });
  }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  const updated = await prisma.shoot.update({ where: { id }, data: parsed.data, include });
  res.json(updated);
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.shoot.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (existing.createdById && existing.createdById !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  await prisma.shoot.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
