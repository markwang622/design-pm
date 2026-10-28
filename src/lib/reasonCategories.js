// Shared reason categories (REPORTS-P2-D1a schedule requests, REPORTS-P2-D1b seal/resume requests).
// A category is for filing and reading only: it is not an automatic exoneration and changes no KPI.
// Kept in its own module so the workflow modules can import it without circular initialization.
export const REASON_CATEGORIES = {
  requester_change: '需求方變更', material_delay: '資料／素材延遲', approval_delay: '簽核延遲', scope_change: '範圍調整',
  internal_capacity: '內部人力／排程', external_vendor: '外部廠商', date_correction: '日期更正', other: '其他',
};
