// REPORTS-P2-D2: member release notices — a server-side whitelist, not a CMS.
//
// Every entry may only describe what ANY signed-in member can do and where to find it. Manager-only features,
// approval rights, admin settings or internal engineering details are never written here, so nothing secret can
// reach a member payload (there is no "send everything, hide in the UI"). Text is plain; no HTML or scripts.
// A notice is visible only when its id is listed in RELEASE_NOTICES_PUBLISHED (comma separated). Default: none —
// nothing in D1/D2 is announced until the release is real. The QA notice exists for local acceptance only.
export const RELEASE_NOTICES = [
  {
    id: 'member-2026-10-schedule-lifecycle',
    title: '案件抽屜新增「時程與週期」',
    items: [
      '受控案件若需延後派發、文案、送印或上線日，請在案件抽屜「時程與週期」提出改期申請並寫明原因；提前日期也需填寫具體原因。',
      '案件需要暫停時，主責或協作者可申請「未完成封存」，附上歸檔位置，或說明沒有可歸檔檔案的原因。',
      '封存後要繼續，可在同一個案件申請「復工」，案號不變，之前的交付紀錄都會保留。',
    ],
  },
  {
    id: 'qa-synthetic-notice-v1',
    title: '測試公告（本機驗收用）',
    items: ['這是本機驗收用的測試公告，正式環境不會發布。'],
  },
  {
    id: 'qa-synthetic-notice-v2',
    title: '測試公告第二版（本機驗收用）',
    items: ['這是本機驗收用的第二版測試公告，用來確認新版本會再次提示；正式環境不會發布。'],
  },
];
const NOTICE_ID = /^[A-Za-z0-9_-]{4,80}$/;
export function publishedNoticeIds(env = process.env) {
  return String(env.RELEASE_NOTICES_PUBLISHED || '').split(',').map(s => s.trim()).filter(id => NOTICE_ID.test(id));
}
// Only whitelisted fields of published notices; order follows RELEASE_NOTICES.
export function publishedNotices(env = process.env) {
  const ids = new Set(publishedNoticeIds(env));
  return RELEASE_NOTICES.filter(n => ids.has(n.id)).map(n => ({ id: n.id, title: n.title, items: [...n.items] }));
}
