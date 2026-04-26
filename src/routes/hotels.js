// ─────────────────────────────────────────────────────────────
// Hotel dictionary — admin can add / rename / hide hotels.
// Frontend pulls /api/hotels at bootstrap to populate dropdowns.
// ─────────────────────────────────────────────────────────────
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/hotels — everyone (members need it for case create dropdown)
router.get('/', async (req, res) => {
  const includeInactive = req.query.includeInactive === '1';
  const rows = await prisma.hotel.findMany({
    where: includeInactive ? {} : { active: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  res.json(rows);
});

const createSchema = z.object({
  region: z.string().min(1).max(20),
  name: z.string().min(1).max(40),
  sortOrder: z.number().int().optional(),
});

router.post('/', requireAdmin, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  try {
    // Default sortOrder: append at end
    let sortOrder = parsed.data.sortOrder;
    if (sortOrder === undefined) {
      const last = await prisma.hotel.findFirst({ orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
      sortOrder = (last?.sortOrder ?? 0) + 10;
    }
    const created = await prisma.hotel.create({
      data: { region: parsed.data.region, name: parsed.data.name, sortOrder },
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'duplicate', message: '館別名稱已存在' });
    throw e;
  }
});

const updateSchema = z.object({
  region: z.string().min(1).max(20).optional(),
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
    const updated = await prisma.hotel.update({ where: { id }, data: parsed.data });
    res.json(updated);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'duplicate' });
    if (e.code === 'P2025') return res.status(404).json({ error: 'not_found' });
    throw e;
  }
});

// DELETE: only allowed if no cases reference this hotel; otherwise return 409.
router.delete('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const hotel = await prisma.hotel.findUnique({ where: { id } });
  if (!hotel) return res.status(404).json({ error: 'not_found' });
  const usingCount = await prisma.case.count({ where: { hotel: hotel.name } });
  if (usingCount > 0) {
    return res.status(409).json({
      error: 'in_use',
      message: `仍有 ${usingCount} 件案件使用此館別，請先設為停用而非刪除`,
    });
  }
  await prisma.hotel.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
