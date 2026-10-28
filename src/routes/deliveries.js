// REPORTS-P1-A: /api/cases/:id/deliveries — mounted inside the cases router (after requireAuth).
// Disabled unless DELIVERY_RECORDS_ENABLED=1; the flag is read per request so tests and
// operators can toggle it without code changes. A does not change submit/approve rules.
import { safeRouter } from '../lib/safeRouter.js';
import { prisma } from '../lib/db.js';
import { PAUSED_MESSAGE } from '../lib/deliveryFlags.js';
import { sendCaseEditError } from '../lib/caseJsonEdits.js';
import { parseCreate, parseVoid, parseReplace, listDeliveries, createDelivery, voidDelivery, replaceDelivery } from '../lib/deliveries.js';

export const DELIVERY_FLAG = 'DELIVERY_RECORDS_ENABLED';
export const deliveriesEnabled = (env = process.env) => env[DELIVERY_FLAG] === '1';

const router = safeRouter();
router.use('/:id/deliveries', async (req, res, next) => {
  if (deliveriesEnabled()) return next();
  // REPORTS-P1-C1: switching the feature off never hides or downgrades a records-mode case:
  // its evidence stays readable and its mutations pause explicitly. Legacy cases stay hidden.
  const row = await prisma.case.findUnique({ where: { id: req.params.id }, select: { deliveryMode: true } });
  if (row?.deliveryMode === 'records') {
    if (req.method === 'GET') return next();
    return res.status(409).json({ error: 'delivery_workflow_paused', message: PAUSED_MESSAGE });
  }
  return res.status(404).json({ error: 'feature_disabled', message: '交付明細功能尚未啟用' });
});
function sendError(res, error) {
  if (error?.issues) return res.status(400).json({ error: 'invalid_body', message: error.message, issues: error.issues });
  return sendCaseEditError(res, error);
}
// Read visibility follows GET /api/cases/:id (any authenticated account). No writes.
router.get('/:id/deliveries', async (req, res) => {
  try { res.json(await listDeliveries(req.params.id)); }
  catch (e) { if (sendError(res, e)) return; throw e; }
});
router.post('/:id/deliveries', async (req, res) => {
  try {
    const result = await createDelivery(req.user, req.params.id, parseCreate(req.body));
    res.status(result.status).json({ record: result.record, case: result.case, replayed: result.replayed });
  } catch (e) { if (sendError(res, e)) return; throw e; }
});
// Correction in A = void (immutable stamp + reason) and append a new record. No edit/delete.
router.post('/:id/deliveries/:rid/void', async (req, res) => {
  try {
    const result = await voidDelivery(req.user, req.params.id, req.params.rid, parseVoid(req.body));
    res.status(result.status).json({ record: result.record, case: result.case, replayed: result.replayed });
  } catch (e) { if (sendError(res, e)) return; throw e; }
});
// REPORTS-P1-B: atomic correction — create the replacement and void the original in one transaction.
router.post('/:id/deliveries/:rid/replace', async (req, res) => {
  try {
    const result = await replaceDelivery(req.user, req.params.id, req.params.rid, parseReplace(req.body));
    res.status(result.status).json({ original: result.original, replacement: result.replacement, case: result.case, replayed: result.replayed });
  } catch (e) { if (sendError(res, e)) return; throw e; }
});
export default router;
