// REPORTS-P1-C1: delivery-records submission workflow routes, mounted inside the cases router
// (after requireAuth). Records-mode approve/reject is served by POST /api/cases/:id/approve.
import { safeRouter } from '../lib/safeRouter.js';
import { prisma } from '../lib/db.js';
import { sendCaseEditError } from '../lib/caseJsonEdits.js';
import { deliveryFlags } from '../lib/deliveryFlags.js';
import { notify } from '../services/notify.js';
import { parseAdopt, parseSubmit, parseWithdraw, adoptRecords, submitDeliveries, withdrawSubmission, listSubmissions } from '../lib/deliveryWorkflow.js';

const router = safeRouter();
function sendError(res, error) {
  if (error?.issues) return res.status(400).json({ error: 'invalid_body', message: error.message, issues: error.issues });
  return sendCaseEditError(res, error);
}
const hidden = res => res.status(404).json({ error: 'feature_disabled', message: '交付明細功能尚未啟用' });

// Read-only history and current summary. Legacy cases stay hidden while the delivery feature is off;
// records cases remain readable whatever the switches say (switching off never hides evidence).
router.get('/:id/delivery-submissions', async (req, res) => {
  try {
    const data = await listSubmissions(req.params.id);
    if (data.mode !== 'records' && !deliveryFlags().recordsEnabled) return hidden(res);
    res.json(data);
  } catch (e) { if (sendError(res, e)) return; throw e; }
});
// Admin-only one-way adoption of an in-progress legacy case.
router.post('/:id/delivery-mode/adopt', async (req, res) => {
  if (!deliveryFlags().workflowActive) return hidden(res);
  try {
    const result = await adoptRecords(req.user, req.params.id, parseAdopt(req.body));
    res.status(result.status).json({ mode: result.mode, case: result.case, replayed: result.replayed });
  } catch (e) { if (sendError(res, e)) return; throw e; }
});
router.post('/:id/delivery-submissions', async (req, res) => {
  let result;
  try { result = await submitDeliveries(req.user, req.params.id, parseSubmit(req.body)); }
  catch (e) { if (sendError(res, e)) return; throw e; }
  // Notifications run only after the committed first write; an exact replay never re-notifies.
  if (!result.replayed) {
    try {
      const row = await prisma.case.findUnique({ where: { id: req.params.id }, select: { id: true, title: true } });
      const admins = await prisma.staff.findMany({ where: { role: 'admin', active: true, pendingActivation: false }, select: { id: true } });
      for (const a of admins) {
        await notify({ type: 'reviewDone', recipientId: a.id, subject: `📝 交付明細送審待核可：${row.id} · ${row.title}`,
          body: `${req.user.name} 已送出案件 ${row.id}「${row.title}」的交付明細，等待您核可或退回。`, relatedCaseId: row.id });
      }
    } catch (e) { console.warn('[delivery-submissions] notify failed (submission already committed):', e.message); }
  }
  res.status(result.status).json({ submission: result.submission, case: result.case, replayed: result.replayed });
});
router.post('/:id/delivery-submissions/:sid/withdraw', async (req, res) => {
  try {
    const result = await withdrawSubmission(req.user, req.params.id, req.params.sid, parseWithdraw(req.body));
    res.status(result.status).json({ submission: result.submission, case: result.case, replayed: result.replayed });
  } catch (e) { if (sendError(res, e)) return; throw e; }
});
export default router;
