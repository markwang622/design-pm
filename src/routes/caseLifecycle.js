// REPORTS-P2-D1b: lifecycle routes (incomplete seal / same-ID resume), mounted inside the cases router after
// requireAuth. Default off (LIFECYCLE_WORKFLOW_ENABLED). No notifications or email are sent in this slice.
import { safeRouter } from '../lib/safeRouter.js';
import { sendCaseEditError } from '../lib/caseJsonEdits.js';
import {
  lifecycleFlags, parseAdopt, parseRequest, parseWithdraw, parseDecide,
  adoptLifecycle, requestLifecycle, withdrawLifecycleRequest, decideLifecycleRequest, listLifecycle,
} from '../lib/caseLifecycle.js';

const router = safeRouter();
function sendError(res, error) {
  if (error?.issues) return res.status(400).json({ error: 'invalid_body', message: error.message, issues: error.issues });
  return sendCaseEditError(res, error);
}
const hidden = res => res.status(404).json({ error: 'feature_disabled', message: '生命週期管理功能尚未啟用' });

// One consistent snapshot. A legacy case without history stays hidden while the feature is off; managed cases
// (and any case with cycles or requests) remain readable whatever the switch says.
router.get('/:id/lifecycle', async (req, res) => {
  try {
    const data = await listLifecycle(req.params.id);
    if (data.mode !== 'managed' && !data.cycles.length && !data.requests.length && !lifecycleFlags().workflowEnabled) return hidden(res);
    res.json(data);
  } catch (e) { if (sendError(res, e)) return; throw e; }
});
router.post('/:id/lifecycle/adopt', async (req, res) => {
  if (!lifecycleFlags().workflowEnabled) return hidden(res);
  try {
    const result = await adoptLifecycle(req.user, req.params.id, parseAdopt(req.body));
    res.status(result.status).json({ mode: result.mode, cycleId: result.cycleId, case: result.case, replayed: result.replayed });
  } catch (e) { if (sendError(res, e)) return; throw e; }
});
router.post('/:id/lifecycle/requests', async (req, res) => {
  try {
    const result = await requestLifecycle(req.user, req.params.id, parseRequest(req.body));
    res.status(result.status).json({ request: result.request, case: result.case, replayed: result.replayed });
  } catch (e) { if (sendError(res, e)) return; throw e; }
});
router.post('/:id/lifecycle/requests/:rid/withdraw', async (req, res) => {
  try {
    const result = await withdrawLifecycleRequest(req.user, req.params.id, req.params.rid, parseWithdraw(req.body));
    res.status(result.status).json({ request: result.request, case: result.case, replayed: result.replayed });
  } catch (e) { if (sendError(res, e)) return; throw e; }
});
router.post('/:id/lifecycle/requests/:rid/decide', async (req, res) => {
  try {
    const result = await decideLifecycleRequest(req.user, req.params.id, req.params.rid, parseDecide(req.body));
    res.status(result.status).json({ request: result.request, case: result.case, replayed: result.replayed, decision: result.decision });
  } catch (e) { if (sendError(res, e)) return; throw e; }
});
export default router;
