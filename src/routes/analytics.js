// ─────────────────────────────────────────────────────────────
// Analytics route — admin-only.
//   GET /api/analytics?period=week|month|half|year&offset=0&staffId=
// ─────────────────────────────────────────────────────────────
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { rollup } from '../services/analytics.js';

const router = Router();
router.use(requireAuth, requireAdmin);

const querySchema = z.object({
  period: z.enum(['week', 'month', 'half', 'year']).default('month'),
  offset: z.coerce.number().int().min(-52).max(0).default(0),
  staffId: z.coerce.number().int().optional(),
});

router.get('/', async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_query', issues: parsed.error.issues });
  }
  try {
    const data = await rollup(parsed.data);
    res.json(data);
  } catch (e) {
    console.error('[analytics] rollup failed:', e);
    res.status(500).json({ error: 'internal' });
  }
});

export default router;
