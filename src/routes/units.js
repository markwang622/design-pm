// ─────────────────────────────────────────────────────────────
// Request-unit dictionary — admin can add / rename / hide units.
// Frontend pulls /api/units at bootstrap to populate dropdowns.
// (v4.7 — mirror of routes/hotels.js)
// ─────────────────────────────────────────────────────────────
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/units — everyone (members need it for case create dropdown)
router.get('/', async (req, res) => {
  const includeInactive = req.query.includeInactive === '1';
  const rows = await prisma.requestUnit.findMany({
    where: includeInactive ? {} : { active: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  res.json(rows);
});

const createSchema = z.object({
  name: z.string().min(1).max(40),
  sortOrder: z.number().int().optional(),
});

router.post('/', requireAdmin, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  try {
    let sortOrder = parsed.data.sortOrder;
    if (sortOrder === undefined) {
      const last = await prisma.requestUnit.findFirst({ orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
      sortOrder = (last?.sortOrder ?? 0) + 10;
    }
    const created = await prisma.requestUnit.create({
      data: { name: parsed.data.name, sortOrder },
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'duplicate', message: '需求單位名稱已存在' });
    throw e;
  }
});

const updateSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

router.patch('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid_id' });
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  try {
    const updated = await prisma.requestUnit.update({ where: { id }, data: parsed.data });
    res.json(updated);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'duplicate' });
    if (e.code === 'P2025') return res.status(404).json({ error: 'not_found' });
    throw e;
  }
});

// DELETE: only allowed if no cases reference this unit name; otherwise 409.
router.delete('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const unit = await prisma.requestUnit.findUnique({ where: { id } });
  if (!unit) return res.status(404).json({ error: 'not_found' });
  const usingCount = await prisma.case.count({ where: { requester: unit.name } });
  if (usingCount > 0) {
    return res.status(409).json({
      error: 'in_use',
      message: `仍有 ${usingCount} 件案件使用此需求單位，請先設為停用而非刪除`,
    });
  }
  await prisma.requestUnit.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
