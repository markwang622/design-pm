import { Router } from 'express';
import { prisma } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';
import { notify } from '../services/notify.js';

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

// ─── POST /api/notifications/:id/resend — 強制重寄 (v4.3 C) ──
// 只能對自己收到的通知重寄。繞過去重，直接觸發 SMTP 寄送。
router.post('/:id/resend', async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid_id' });
  const n = await prisma.notification.findUnique({ where: { id } });
  if (!n) return res.status(404).json({ error: 'not_found' });
  // 自己的通知 OR admin 可重寄
  if (n.recipientId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    // 用 force=true 繞過去重，重新寄送
    await notify({
      type: n.type,
      recipientId: n.recipientId,
      subject: '[重寄] ' + n.subject,
      body: n.body,
      relatedCaseId: n.relatedCaseId,
      force: true,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[notify] resend failed:', e);
    res.status(500).json({ error: 'resend_failed', message: e.message });
  }
});

export default router;
