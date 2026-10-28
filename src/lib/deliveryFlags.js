// REPORTS-P1-C1: delivery feature switches, read per request.
// DELIVERY_RECORDS_ENABLED=1  → delivery evidence API/UI (A/B).
// DELIVERY_WORKFLOW_ENABLED=1 → records-mode submit/approve/adoption and new records cases (C1).
// The workflow is active only when both are on. Turning a switch off never downgrades an
// existing records case: its new submissions/approvals pause with an explicit message.
export function deliveryFlags(env = process.env) {
  const records = env.DELIVERY_RECORDS_ENABLED === '1', workflow = env.DELIVERY_WORKFLOW_ENABLED === '1';
  return { recordsEnabled: records, workflowEnabled: workflow, workflowActive: records && workflow };
}
export const PAUSED_MESSAGE = '交付明細流程目前暫停：既有明細與送審紀錄仍可查看，恢復後即可繼續送審與核可。';
