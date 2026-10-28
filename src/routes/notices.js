// REPORTS-P2-D2: per-account release notices. Identity comes from the session only (a body/userId is ignored).
import { safeRouter } from '../lib/safeRouter.js';
import { prisma } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';
import { publishedNotices } from '../lib/releaseNotices.js';

const router = safeRouter();
router.use(requireAuth);

// Published member notices with this account's dismissed flag. `pending` = not yet dismissed (shown once).
router.get('/', async (req, res) => {
  const notices = publishedNotices();
  const dismissed = notices.length ? await prisma.memberNoticeDismissal.findMany({
    where: { staffId: req.user.id, noticeId: { in: notices.map(n => n.id) } }, select: { noticeId: true, dismissedAt: true },
  }) : [];
  const at = new Map(dismissed.map(d => [d.noticeId, d.dismissedAt]));
  const list = notices.map(n => ({ ...n, dismissed: at.has(n.id), dismissedAt: at.has(n.id) ? new Date(at.get(n.id)).toISOString() : null }));
  // staffId lets the browser discard a response that belongs to a different (old) session.
  res.json({ staffId: req.user.id, notices: list, pending: list.filter(n => !n.dismissed).map(n => n.id) });
});

// Idempotent: the first dismissal is kept; repeating it (another device, a retry, every close path) changes nothing.
router.post('/:id/dismiss', async (req, res) => {
  const notice = publishedNotices().find(n => n.id === req.params.id);
  if (!notice) return res.status(404).json({ error: 'notice_not_found', message: '找不到這則更新通知。' });
  // The write target is ALWAYS the session account. expectedStaffId is only a precondition: a dialog opened for
  // another account (old tab / switched session) must not dismiss on behalf of the account now signed in.
  const expected = req.body && req.body.expectedStaffId;
  if (expected !== undefined && Number(expected) !== req.user.id) return res.status(409).json({ error: 'notice_actor_changed', message: '登入帳號已變更，這次沒有儲存；請重新整理頁面。' });
  let row;
  try { row = await prisma.memberNoticeDismissal.create({ data: { staffId: req.user.id, noticeId: notice.id } }); }
  catch (e) {
    if (e?.code !== 'P2002') throw e;
    row = await prisma.memberNoticeDismissal.findUnique({ where: { staffId_noticeId: { staffId: req.user.id, noticeId: notice.id } } });
  }
  res.json({ id: notice.id, dismissed: true, dismissedAt: new Date(row.dismissedAt).toISOString() });
});
export default router;
