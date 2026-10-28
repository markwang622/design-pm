// REPORTS-P2-D1a: schedule-change request routes, mounted inside the cases router (after requireAuth).
// Default off (SCHEDULE_WORKFLOW_ENABLED). No notifications or email are sent in this slice.
import { safeRouter } from '../lib/safeRouter.js';
import { sendCaseEditError } from '../lib/caseJsonEdits.js';
import {
  scheduleFlags, parseAdopt, parsePropose, parseWithdraw, parseDecide,
  adoptManagedSchedule, proposeSchedule, withdrawScheduleRequest, decideScheduleRequest, listScheduleRequests,
} from '../lib/scheduleWorkflow.js';

const router = safeRouter();
function sendError(res, error) {
  if (error?.issues) return res.status(400).json({ error: 'invalid_body', message: error.message, issues: error.issues });
  return sendCaseEditError(res, error);
}
const hidden = res => res.status(404).json({ error: 'feature_disabled', message: '時程異動申請功能尚未啟用' });

// Read-only history. A legacy case with no history stays hidden while the feature is off; managed cases
// (and any case with history) remain readable whatever the switch says.
router.get('/:id/schedule-requests', async (req, res) => {
  try {
    const data = await listScheduleRequests(req.params.id);
    if (data.mode !== 'managed' && !data.requests.length && !scheduleFlags().workflowEnabled) return hidden(res);
    res.json(data);
  } catch (e) { if (sendError(res, e)) return; throw e; }
});
// Admin-only one-way adoption of an open legacy case.
router.post('/:id/schedule-mode/adopt', async (req, res) => {
  if (!scheduleFlags().workflowEnabled) return hidden(res);
  try {
    const result = await adoptManagedSchedule(req.user, req.params.id, parseAdopt(req.body));
    res.status(result.status).json({ mode: result.mode, baseline: result.baseline, case: result.case, replayed: result.replayed });
  } catch (e) { if (sendError(res, e)) return; throw e; }
});
router.post('/:id/schedule-requests', async (req, res) => {
  try {
    const result = await proposeSchedule(req.user, req.params.id, parsePropose(req.body));
    res.status(result.status).json({ request: result.request, case: result.case, replayed: result.replayed });
  } catch (e) { if (sendError(res, e)) return; throw e; }
});
router.post('/:id/schedule-requests/:rid/withdraw', async (req, res) => {
  try {
    const result = await withdrawScheduleRequest(req.user, req.params.id, req.params.rid, parseWithdraw(req.body));
    res.status(result.status).json({ request: result.request, case: result.case, replayed: result.replayed });
  } catch (e) { if (sendError(res, e)) return; throw e; }
});
router.post('/:id/schedule-requests/:rid/decide', async (req, res) => {
  try {
    const result = await decideScheduleRequest(req.user, req.params.id, req.params.rid, parseDecide(req.body));
    res.status(result.status).json({ request: result.request, case: result.case, replayed: result.replayed, decision: result.decision });
  } catch (e) { if (sendError(res, e)) return; throw e; }
});
export default router;
