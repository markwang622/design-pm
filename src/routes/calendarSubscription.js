import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { safeRouter } from '../lib/safeRouter.js';
import { prisma } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';
import { CalendarConfigurationError, calendarPrivacyHeaders, createCalendarSubscription } from '../services/calendarSubscription.js';

const router = safeRouter();
router.use(calendarPrivacyHeaders, requireAuth);
const querySchema = z.object({ scope: z.enum(['mine', 'team']).default('mine') }).strict();
const emptyBody = z.object({}).strict();
// requireAuth verified this cookie. Retain its version for the second read / atomic revoke.
const sessionVersion = req => jwt.decode(req.cookies.designpm_token)?.sessionVersion ?? 0;

router.get('/', async (req, res, next) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_query' });
  const staff = await prisma.staff.findUnique({ where: { id: req.user.id }, select: {
    id: true, active: true, pendingActivation: true, calendarVersion: true, sessionVersion: true,
  } });
  if (!staff?.active || staff.pendingActivation || staff.sessionVersion !== sessionVersion(req)) {
    return res.status(401).json({ error: 'session_expired' });
  }
  try { return res.json(createCalendarSubscription(staff, parsed.data.scope)); }
  catch (error) {
    if (error instanceof CalendarConfigurationError) return res.status(503).json({ error: 'calendar_unavailable' });
    return next(error);
  }
});

router.post('/revoke', async (req, res) => {
  if (Object.keys(req.query).length || !emptyBody.safeParse(req.body ?? {}).success) {
    return res.status(400).json({ error: 'invalid_body' });
  }
  const result = await prisma.staff.updateMany({
    where: { id: req.user.id, active: true, pendingActivation: false, sessionVersion: sessionVersion(req) },
    data: { calendarVersion: { increment: 1 } },
  });
  if (!result.count) return res.status(401).json({ error: 'session_expired' });
  res.json({ ok: true });
});

export default router;
