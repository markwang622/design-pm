import { Router } from 'express';
import { prisma } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// ─── GET /api/notifications — list mine ───────────────────
router.get('/', async (req, res) => {
  const unreadOnly = req.query.unread === '1';
  const rows = await prisma.notification.findMany({
    where: {
      recipientId: req.user.id,
      ...(unreadOnly ? { readAt: null } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json(rows);
});

// ─── GET /api/notifications/unread-count ──────────────────
router.get('/unread-count', async (req, res) => {
  const n = await prisma.notification.count({
    where: { recipientId: req.user.id, readAt: null },
  });
  res.json({ count: n });
});

// ─── POST /api/notifications/:id/read ─────────────────────
router.post('/:id/read', async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid_id' });

  const n = await prisma.notification.findUnique({ where: { id } });
  if (!n || n.recipientId !== req.user.id) {
    return res.status(404).json({ error: 'not_found' });
  }
  const updated = await prisma.notification.update({
    where: { id },
    data: { readAt: new Date() },
  });
  res.json(updated);
});

// ─── POST /api/notifications/read-all ─────────────────────
router.post('/read-all', async (req, res) => {
  const r = await prisma.notification.updateMany({
    where: { recipientId: req.user.id, readAt: null },
    data: { readAt: new Date() },
  });
  res.json({ ok: true, updated: r.count });
});

export default router;
