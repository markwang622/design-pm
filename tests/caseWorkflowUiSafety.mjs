// REPORTS-P1-C2: the actual public/case-workflow.js (records submit / withdraw / review / adoption) together with
// B's public/case-deliveries.js, in the same inert minimal DOM scaffold B uses (reused from
// tests/caseDeliveriesUiSafety.mjs, not copied). normalizeCase / escapeHtml / v10SyncUpdatedAt and the real inline
// hooks (v54KanbanDrop, renderApproval, v36ApprovalDecision, v40RenderClosure) are extracted from index.html.
// A small in-memory server double implements the accepted C1 contract. No network, database, browser or mail.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
process.env.TZ = 'Asia/Taipei';
const root = process.env.DESIGN_PM_ROOT || new URL('../', import.meta.url).pathname;
const source = fs.readFileSync(root + '/public/index.html', 'utf8');
const plugin = fs.readFileSync(root + '/public/case-workflow.js', 'utf8');
const deliveriesPlugin = fs.readFileSync(root + '/public/case-deliveries.js', 'utf8');
const css = fs.readFileSync(root + '/public/case-workflow.css', 'utf8');
const lifecyclePlugin = fs.readFileSync(root + '/public/case-lifecycle.js', 'utf8');
const bTest = fs.readFileSync(root + '/tests/caseDeliveriesUiSafety.mjs', 'utf8');
function section(start, end, text = source) { const a = text.indexOf(start), b = text.indexOf(end, a + start.length); assert(a >= 0 && b > a, 'source section exists: ' + start); return text.slice(a, b); }
const { dom } = new Function(section('const decode=', '\nconst helpers', bTest) + '\nreturn { dom };')();
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const plain = v => JSON.parse(JSON.stringify(v));
const httpError = (status, error, message) => Object.assign(new Error(message || error), { status, data: { error, message } });
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const helpers = section('function escapeHtml(s)', 'async function v33SaveEdit') + section('function v20TaiwanToday()', '\n}\n') + '\n}\n'
  + section('function normalizeCase(b)', 'function findStaffId') + section('function v10SyncUpdatedAt(c, raw)', '// 409 = 他人已更新');
const kanbanDrop = section('async function v54KanbanDrop(caseId, newStatus)', '// ============== Gantt');
const approvalUi = section('async function renderApproval()', 'function v36UpdateApprovalBadge(count)');
const closureUi = section('const V40_DELIVERED', 'function saveClosure(c)');

// ── in-memory C1 server double ──────────────────────────────────────────────
const record = (extra = {}) => ({ id: 'dlv-main-0001', caseId: 'R-1', itemKey: null, itemName: '主視覺 KV', kind: 'main', quantity: 1, unit: '件', deliveredOn: '2026-10-21', note: null,
  recordedById: 2, recordedByName: 'Owner', voided: false, ...extra });
const mainExtSupport = () => [record(), record({ id: 'dlv-ext-0001', itemName: 'FB 延伸', kind: 'extension', quantity: 3 }),
  record({ id: 'dlv-sup-0001', itemName: '版面諮詢', kind: 'support', quantity: 0, note: '提供版面諮詢，未新增設計檔案' })];
function summarize(records) {
  const act = records.filter(r => !r.voided), groups = [];
  for (const kind of ['main', 'extension', 'support']) { const rows = act.filter(r => r.kind === kind); if (rows.length) groups.push({ kind, unit: '件', quantity: rows.reduce((s, r) => s + r.quantity, 0), records: rows.length }); }
  return { status: act.length ? 'recorded' : 'unknown', groups, activeRecords: act.length, voidedRecords: records.length - act.length, zeroSupportRecords: act.filter(r => r.kind === 'support' && r.quantity === 0).length };
}
function makeServer(opts = {}) {
  const s = {
    mode: opts.mode || 'records', status: opts.status || 'doing', archivePath: opts.archivePath === undefined ? '/shared/R-1' : opts.archivePath,
    version: 5, stamp: Date.parse('2026-10-22T01:00:00.000Z'), records: opts.records || mainExtSupport(), subs: [], pending: null,
    workflow: { recordsEnabled: true, workflowEnabled: true, workflowActive: opts.paused ? false : true }, hook: null, archived: false,
  };
  const iso = () => new Date(s.stamp).toISOString();
  const bump = () => { s.version++; s.stamp += 1000; return { id: 'R-1', updatedAt: iso(), contentVersion: s.version }; };
  const checkVersion = body => { if (body.expectedContentVersion !== s.version || body.expectedUpdatedAt !== iso()) throw httpError(409, 'edit_conflict'); };
  const raw = () => ({ id: 'R-1', title: '品牌年度主視覺', status: s.status, archived: s.archived, archivePath: s.archivePath, designer: { id: 2, name: 'Owner' }, collaborators: [{ id: 4, name: 'Collab' }],
    level: 'A', items: [{ key: 'item-key-main-0001', n: '主視覺 KV' }], logs: [{ date: '2026-10-21', note: '已完成交付', by: 'Owner' }], updatedAt: iso(), contentVersion: s.version,
    deliveryMode: s.mode, deliveryModeSince: s.mode === 'records' ? '2026-10-19T00:00:00.000Z' : null, deliveryModeByName: s.mode === 'records' ? 'Admin' : null, deliveryModeReason: s.mode === 'records' ? '測試案件' : null,
    pendingDeliverySubmissionId: s.pending, openDate: '2026-10-01', dispatchDate: '2026-10-02', goLiveDate: '2026-10-30', requestCount: null, outputCount: null });
  s.raw = raw; s.iso = iso;
  s.respond = call => {
    if (s.hook) { const r = s.hook(call); if (r !== undefined) return r; }
    const { method, url, body } = call;
    if (method === 'GET' && url === '/api/cases/R-1') return raw();
    if (method === 'GET' && url === '/api/cases/R-1/deliveries') return { caseId: 'R-1', updatedAt: iso(), contentVersion: s.version, records: plain(s.records), summary: summarize(s.records), legacy: { requestCount: null, outputCount: null }, mode: s.mode, status: s.status, pendingSubmissionId: s.pending, workflow: { ...s.workflow, paused: s.mode === 'records' && !s.workflow.workflowActive } };
    if (method === 'GET' && url === '/api/cases/R-1/delivery-submissions') {
      if (s.mode !== 'records' && !s.workflow.recordsEnabled) throw httpError(404, 'feature_disabled');
      return { caseId: 'R-1', mode: s.mode, status: s.status, updatedAt: iso(), contentVersion: s.version, pendingSubmissionId: s.pending, workflow: { ...s.workflow, paused: s.mode === 'records' && !s.workflow.workflowActive }, submissions: plain(s.subs.slice().reverse()) };
    }
    if (method === 'POST' && url === '/api/cases/R-1/delivery-submissions') {
      const prior = s.subs.find(x => x.id === body.id); if (prior) return { submission: plain(prior), case: { id: 'R-1', updatedAt: iso(), contentVersion: s.version, status: s.status }, replayed: true };
      if (!s.workflow.workflowActive) throw httpError(409, 'delivery_workflow_paused');
      checkVersion(body);
      const act = s.records.filter(r => !r.voided);
      const sub = { id: body.id, caseId: 'R-1', status: 'pending', submittedByName: 'Owner', submittedAt: iso(), archivePath: s.archivePath, recordIds: act.map(r => r.id), summary: summarize(s.records).groups,
        zeroSupport: act.filter(r => r.kind === 'support' && r.quantity === 0).map(r => ({ id: r.id, itemName: r.itemName, note: r.note })), decidedAt: null };
      s.subs.push(sub); s.pending = sub.id; s.status = 'review_done';
      return { submission: plain(sub), case: bump(), replayed: false };
    }
    const wd = url.match(/^\/api\/cases\/R-1\/delivery-submissions\/([^/]+)\/withdraw$/);
    if (method === 'POST' && wd) {
      const sub = s.subs.find(x => x.id === wd[1]); checkVersion(body);
      Object.assign(sub, { status: 'withdrawn', decidedAt: iso(), decidedByName: 'Owner', decisionReason: body.reason }); s.pending = null; s.status = 'doing';
      return { submission: plain(sub), case: bump(), replayed: false };
    }
    if (method === 'POST' && url === '/api/cases/R-1/approve') {
      const sub = s.subs.find(x => x.id === body.submissionId);
      if (!sub || sub.decidedAt || s.pending !== sub.id) throw httpError(409, 'submission_closed');
      checkVersion(body);
      if (body.decision === 'approve') { s.status = 'closed'; s.archived = true; Object.assign(sub, { status: 'approved', zeroSupportApproved: !!body.zeroSupportApproved }); }
      else { s.status = 'doing'; Object.assign(sub, { status: 'rejected', decisionReason: body.comment }); }
      Object.assign(sub, { decidedAt: iso(), decidedByName: 'Admin' }); s.pending = null;
      return { submission: plain(sub), case: bump(), replayed: false };
    }
    if (method === 'POST' && url === '/api/cases/R-1/delivery-mode/adopt') { checkVersion(body); s.mode = 'records'; return { mode: 'records', case: bump(), replayed: false }; }
    if (method === 'PATCH' && url === '/api/cases/R-1') { s.archivePath = body.archivePath; bump(); return raw(); }
    throw Error('unexpected ' + method + ' ' + url);
  };
  return s;
}
function makeStorage() {
  const map = new Map();
  return { map, getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
}

// ── environment: B + C2 plugins over a stand-in drawer chain ────────────────
function env({ me = { id: 2, name: 'Owner', role: 'member' }, role = 'designer', server = makeServer(), storage = makeStorage(), archiveDraft = null } = {}) {
  const d = dom(), calls = [], toasts = [], opened = [];
  const drawer = d.seed('drawer'); const body = d.element('div'); body.className = 'drawer-body'; drawer.appendChild(body);
  const archive = d.element('div', 'd-archive'); body.appendChild(archive);
  archive.innerHTML = '<input id="d-archive-input" value="/shared/R-1"><button id="d-archive-save">儲存歸檔位置</button><span id="d-archive-feedback">歸檔位置已儲存</span>';
  const status = d.element('div'); status.className = 'status-change'; body.appendChild(status); status.innerHTML = '<select id="d-status"><option value="doing">doing</option><option value="review_done">review_done</option></select>';
  const closure = d.element('div', 'd-closure'); body.appendChild(closure);
  const items = d.element('div'); items.className = 'v43-items-panel'; body.appendChild(items); items.innerHTML = '<span class="v43-drag" draggable="true">⠿</span><input data-k="n" value="主視覺 KV"><button data-act="add">新增子案件</button>';
  const c = vm.createContext({ console, Date, Intl, Set, Map, Promise, JSON, Math, Number, String, Object, Array, Error, URLSearchParams, crypto: webcrypto,
    setTimeout, clearTimeout, document: d.document, sessionStorage: storage, ME: me, currentRole: role, STAFF: [], CASES: [], currentCase: null, TODAY: new Date(today + 'T00:00:00+08:00'),
    showToast: (m, t) => toasts.push({ m, t }), location: { reload: () => toasts.push({ m: 'reload' }) } });
  c.window = c;
  vm.runInContext(helpers + '\nconst IS_OBSERVER = () => currentRole === "observer";\nfunction ME_NAME() { return ME?.name || ""; }', c);
  c.v95DrawerSeq = (() => { let n = 0; return { bump: () => ++n, now: () => n }; })();
  c.fetchJson = async (method, url, payload) => { const call = { method, url, body: payload === undefined ? undefined : plain(payload) }; calls.push(call); return server.respond(call); };
  c.decorateCase = () => {}; c.decorateCases = () => {}; c.refreshAll = () => {}; c.renderKanban = () => {}; c.renderApproval = () => { c.__approvalRenders = (c.__approvalRenders || 0) + 1; };
  c.v41ArchivePending = new Map();
  let draft = archiveDraft;
  c.v41ArchiveDraft = row => (draft === null ? String(row.archivePath || '').trim() : draft);
  c.v41SaveArchive = async row => { const raw = await c.fetchJson('PATCH', '/api/cases/' + row.id, { archivePath: draft }); row.archivePath = raw.archivePath; row._updatedAt = raw.updatedAt; row._contentVersion = raw.contentVersion; draft = null; return true; };
  // Base drawer chain stand-in: sets currentCase and bumps the generation like v95; sweeps are covered by B's suite.
  c.openDrawer = async row => { opened.push(row.id); c.currentCase = row; c.v95DrawerSeq.bump(); await Promise.resolve(); };
  vm.runInContext(deliveriesPlugin, c);
  vm.runInContext(plugin, c);
  const rootEl = () => d.get('d-workflow');
  const html = () => rootEl()?.innerHTML || '';
  const btn = (label, rootNode = rootEl()) => rootNode.querySelectorAll('button').find(b => b.textContent.trim() === label);
  const field = (name, rootNode = rootEl()) => rootNode.querySelector(`[data-f="${name}"]`);
  const type = (name, value, rootNode) => { const el = field(name, rootNode); el.value = value; el.dispatchEvent({ type: 'input' }); };
  const check = (name, on = true, rootNode) => { const el = field(name, rootNode); el.checked = on; el.dispatchEvent({ type: 'change' }); };
  const open = async (row = c.normalizeCase(server.raw())) => { c.CASES = c.CASES.some(x => x.id === row.id) ? c.CASES : [row, ...c.CASES]; c.openDrawer(row); await flush(); return row; };
  const writes = () => calls.filter(x => x.method !== 'GET');
  return { c, d, server, calls, toasts, opened, storage, rootEl, html, btn, field, type, check, open, writes, setDraft: v => { draft = v; } };
}
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); } }

await test('normalizeCase keeps records mode, adoption stamp and pending id; a missing mode is safely legacy', async () => {
  const t = env(); const n = t.c.normalizeCase({ ...t.server.raw(), pendingDeliverySubmissionId: 'sub-abc-123456', _count: { deliveries: 3, deliverySubmissions: 1 } });
  assert.equal(n.deliveryMode, 'records'); assert.equal(n.deliveryModeByName, 'Admin'); assert.equal(n.pendingDeliverySubmissionId, 'sub-abc-123456');
  assert.deepEqual(plain(n._deliveryCounts), { deliveries: 3, submissions: 1 }); assert.equal(n._contentVersion, 5);
  const old = t.c.normalizeCase({ id: 'L-9', title: 'old', status: 'doing' }); assert.equal(old.deliveryMode, 'legacy'); assert.equal(old.pendingDeliverySubmissionId, null);
  assert.equal(t.c.normalizeCase({ ...t.server.raw(), deliveryMode: 'something' }).deliveryMode, 'legacy');
});
await test('records submit: saves the unsaved archive first, previews main/extension/support separately with 0-reason and evidence, requires the checkbox, posts the exact versions', async () => {
  const t = env({ archiveDraft: '/shared/R-1/final' }); const row = await t.open();
  assert.match(t.html(), /◆ 交付明細制/); assert.match(t.html(), /送出主管核可…/);
  t.btn('送出主管核可…').click(); await flush();
  const order = t.calls.map(x => x.method + ' ' + x.url);
  const patchAt = order.indexOf('PATCH /api/cases/R-1'), listAt = order.lastIndexOf('GET /api/cases/R-1/deliveries');
  assert(patchAt >= 0 && listAt > patchAt, 'archive save is awaited before the authoritative preview: ' + order.join(', '));
  assert.equal(row._contentVersion, 6, 'both stamps synced from the archive save'); assert.equal(row.archivePath, '/shared/R-1/final');
  const h = t.html();
  for (const chip of ['主設計 <b>1</b> 件', '延伸 <b>3</b> 件', '支援 <b>0</b> 件']) assert(h.includes(chip), chip);
  assert.match(h, /\/shared\/R-1\/final/); assert.match(h, /提供版面諮詢，未新增設計檔案/); assert.match(h, /送出後成為送審依據的交付紀錄（3 筆/);
  assert.equal(t.field('confirm').checked, false, 'never pre-checked, even though a log says 已完成交付');
  assert(!/合計|總計/.test(h), 'no combined KPI total');
  t.btn('送出主管核可').click(); await flush();
  assert.equal(t.writes().filter(x => x.method === 'POST').length, 0, 'no POST without the checkbox'); assert.match(t.html(), /請勾選確認交付已完整登錄/);
  t.check('confirm'); t.btn('送出主管核可').click(); await flush();
  const post = t.writes().find(x => x.method === 'POST'); assert.equal(post.url, '/api/cases/R-1/delivery-submissions');
  assert.deepEqual(Object.keys(post.body).sort(), ['completenessConfirmed', 'expectedContentVersion', 'expectedUpdatedAt', 'id']);
  assert.equal(post.body.completenessConfirmed, true); assert.equal(post.body.expectedContentVersion, 6); assert.match(post.body.id, /^sub-[A-Za-z0-9_-]{8,}$/);
  assert(!t.writes().some(x => x.method === 'PATCH' && x.body && 'status' in x.body), 'never the old PATCH status');
  assert.equal(row.status, 'review_done'); assert.equal(row.pendingDeliverySubmissionId, post.body.id); assert.equal(row._contentVersion, 7);
  assert.equal(t.opened.at(-1), 'R-1', 'drawer reopened to resync status and read-only state'); assert(t.toasts.some(x => /已送出主管核可/.test(x.m)));
});
await test('missing archive or deliveries gives actionable jumps and keeps submit disabled', async () => {
  const t = env({ server: makeServer({ archivePath: null, records: [record({ voided: true })] }) }); await t.open();
  t.btn('送出主管核可…').click(); await flush();
  assert.match(t.html(), /尚未填寫檔案歸檔位置/); assert.match(t.html(), /尚無有效交付/);
  assert.equal(t.btn('送出主管核可').disabled, true); assert.equal(t.field('confirm').disabled, true);
  t.btn('前往登錄交付').click(); await flush();
  assert.equal(t.rootEl().querySelector('[data-cw-panel]'), null, 'panel closes so the user can act');
  t.btn('送出主管核可…').click(); await flush(); t.btn('前往填寫歸檔位置').click();
  assert.equal(t.d.get('d-archive-input').getAttribute('aria-invalid'), 'true'); assert.equal(t.d.document.activeElement, t.d.get('d-archive-input'));
  assert.equal(t.writes().length, 0);
});
for (const [label, me, role, allowed] of [
  ['primary', { id: 2, name: 'Owner', role: 'member' }, 'designer', true], ['collaborator by real id', { id: '4', name: 'Collab', role: 'member' }, 'designer', true],
  ['admin', { id: 1, name: 'Admin', role: 'admin' }, 'admin', true], ['same name, different id', { id: 9, name: 'Owner', role: 'member' }, 'designer', false],
  ['observer', { id: 5, name: 'Obs', role: 'observer' }, 'observer', false], ['admin previewing as observer', { id: 1, name: 'Admin', role: 'admin' }, 'observer', false],
]) await test('submit entry by real identity: ' + label, async () => {
  const t = env({ me, role }); await t.open();
  assert.equal(!!t.btn('送出主管核可…'), allowed);
  if (!allowed) assert.match(t.html(), /僅可檢視|唯讀/);
});
for (const committed of [false, true]) await test('ambiguous network result keeps the exact request; reopening forces reconfirm or reconciles; never a second submission (' + (committed ? 'server committed' : 'request lost') + ')', async () => {
  const t = env(); await t.open();
  t.btn('送出主管核可…').click(); await flush(); t.check('confirm');
  let fail = true; t.server.hook = call => { if (call.method === 'POST' && fail) { fail = false; if (committed) { t.server.hook = null; t.server.respond(call); } throw httpError(0, 'network'); } };
  t.btn('送出主管核可').click(); await flush();
  const first = t.writes().find(x => x.method === 'POST');
  assert.match(t.html(), /無法確認是否已送出/); assert(t.btn('重新確認送出')); assert.equal(t.field('confirm'), null, 'content locked while unconfirmed');
  await t.open(t.c.CASES[0]); await flush();
  if (committed) {
    assert.match(t.html(), /已確認送出：這份送審已建立，沒有重複送出/); assert.match(t.html(), /待主管核可/);
    assert.equal(t.writes().filter(x => x.method === 'POST').length, 1, 'history reconciled the lost success: no resend');
  } else {
    assert(t.btn('重新確認送出'), 'reopened drawer forces the same request to be reconfirmed');
    t.btn('重新確認送出').click(); await flush();
    const posts = t.writes().filter(x => x.method === 'POST'); assert.equal(posts.length, 2);
    assert.deepEqual(posts[1].body, first.body, 'identical id and payload'); assert.equal(t.c.CASES[0].status, 'review_done');
  }
  assert.equal(t.server.subs.length, 1, 'exactly one submission');
});
await test('early review P2: a 409 marks the summary stale; 重新檢視 shows the new evidence with completeness UNchecked until reconfirmed', async () => {
  const t = env(); await t.open();
  t.btn('送出主管核可…').click(); await flush(); t.check('confirm');
  t.server.records.push(record({ id: 'dlv-ext-0002', itemName: 'IG 延伸', kind: 'extension', quantity: 2 })); t.server.version++; // a collaborator adds evidence
  t.btn('送出主管核可').click(); await flush();
  assert.match(t.html(), /案件內容剛被更新/); assert.equal(t.btn('送出主管核可').disabled, true); assert.equal(t.server.subs.length, 0);
  t.btn('重新檢視').click(); await flush();
  assert(t.html().includes('延伸 <b>5</b> 件'), 'the new evidence is shown'); assert.equal(t.field('confirm').getAttribute('checked'), null, 'old confirmation not carried over');
  t.btn('送出主管核可').click(); await flush(); assert.equal(t.server.subs.length, 0, 'blocked until confirmed again'); assert.match(t.html(), /請勾選確認/);
  t.check('confirm'); t.btn('送出主管核可').click(); await flush();
  assert.equal(t.server.subs.length, 1); assert.equal(t.writes().filter(x => x.method === 'POST').at(-1).body.expectedContentVersion, 6);
});
await test('early review P2: a stored confirmed draft reopened after the evidence changed must be confirmed again', async () => {
  const t = env(); await t.open();
  t.btn('送出主管核可…').click(); await flush(); t.check('confirm'); t.btn('取消').click(); await flush();
  t.server.version++; t.server.stamp += 1000;
  t.btn('送出主管核可…').click(); await flush();
  assert.equal(t.field('confirm').getAttribute('checked'), null); t.btn('送出主管核可').click(); await flush(); assert.equal(t.server.subs.length, 0);
  // unchanged evidence keeps a confirmation made for that exact revision
  t.check('confirm'); t.btn('取消').click(); await flush(); t.btn('送出主管核可…').click(); await flush();
  assert.notEqual(t.field('confirm').getAttribute('checked'), null, 'same revision keeps the checkbox');
});
await test('early review P2: an equal-contentVersion GET with an older updatedAt cannot roll back newer cached state or stamps', async () => {
  const t = env(); const row = await t.open();
  t.btn('送出主管核可…').click(); await flush(); t.check('confirm');
  const gate = deferred(); let armed = false;
  t.server.hook = call => {
    if (call.method === 'POST' && call.url.endsWith('/delivery-submissions')) { armed = true; return undefined; }
    if (armed && call.method === 'GET' && call.url === '/api/cases/R-1') { armed = false; const snapshot = t.server.raw(); return gate.promise.then(() => snapshot); }
  };
  t.btn('送出主管核可').click(); await flush();
  assert.equal(row._contentVersion, 6, 'stamped exactly +1 from the operation response');
  // meanwhile a non-evidence edit (title) lands: updatedAt moves, contentVersion does not
  const newer = new Date(Date.parse(row._updatedAt) + 5000).toISOString(); row.name = '新標題（較新）'; row._updatedAt = newer;
  gate.resolve(); await flush(); await flush();
  assert.equal(row.name, '新標題（較新）', 'older equal-CV snapshot discarded'); assert.equal(row._updatedAt, newer, 'stamp never moves backwards');
  assert.equal(row._contentVersion, 6);
});
await test('pending records: evidence controls read-only with explanation, snapshot visible, withdraw needs a reason and resubmit works', async () => {
  const t = env(); await t.open(); t.btn('送出主管核可…').click(); await flush(); t.check('confirm'); t.btn('送出主管核可').click(); await flush();
  await flush();
  for (const id of ['d-archive-input', 'd-archive-save']) assert.equal(t.d.get(id).disabled, true, id);
  const panel = t.d.document.querySelector('#drawer .v43-items-panel');
  assert(panel.querySelectorAll('input, button').every(el => el.disabled)); assert.equal(panel.querySelector('.v43-drag').getAttribute('draggable'), 'false');
  assert.match(panel.textContent, /送審期間/); assert.match(t.html(), /送審依據/); assert.match(t.html(), /待主管核可/);
  t.btn('撤回送審…').click(); await flush(); t.type('reason', '數'); t.btn('撤回送審').click(); await flush();
  assert.match(t.html(), /撤回原因（至少 2 個字）/); assert.equal(t.writes().filter(x => /withdraw/.test(x.url)).length, 0);
  t.type('reason', '數量需要更正'); t.btn('撤回送審').click(); await flush();
  const wd = t.writes().find(x => /withdraw/.test(x.url)); assert.equal(wd.body.reason, '數量需要更正'); assert.match(wd.body.id, /^wd-/); assert.equal(wd.body.expectedContentVersion, 6);
  assert.equal(t.c.CASES[0].status, 'doing'); await flush();
  assert.equal(t.d.get('d-archive-input').disabled, false, 'evidence editable again after withdraw');
  assert(t.btn('送出主管核可…'), 'can resubmit'); assert.match(t.html(), /上次送審已撤回：數量需要更正/); assert.match(t.html(), /送審紀錄（1）/);
});
await test('admin drawer review: support-0 needs the separate manager checkbox; reject needs a reason; approve posts submission/operation ids and freezes', async () => {
  const server = makeServer(); const owner = env({ server }); await owner.open(); owner.btn('送出主管核可…').click(); await flush(); owner.check('confirm'); owner.btn('送出主管核可').click(); await flush();
  const t = env({ server, me: { id: 1, name: 'Admin', role: 'admin' }, role: 'admin' }); await t.open();
  t.btn('審核這份送審').click(); await flush();
  assert.match(t.html(), /我已審閱上列 1 筆 0 件支援工作的說明/); assert.equal(t.field('zeroOk').checked, false);
  t.btn('核可並結案').click(); await flush(); assert.equal(t.writes().length, 0); assert.match(t.html(), /核可前請勾選/);
  t.btn('退回修改').click(); await flush(); assert.equal(t.writes().length, 0); assert.match(t.html(), /退回時請填寫原因/);
  t.check('zeroOk'); t.btn('核可並結案').click(); await flush();
  const ap = t.writes()[0]; assert.equal(ap.url, '/api/cases/R-1/approve');
  assert.equal(ap.body.decision, 'approve'); assert.equal(ap.body.submissionId, server.subs[0].id); assert.match(ap.body.operationId, /^op-/); assert.equal(ap.body.zeroSupportApproved, true); assert.equal(ap.body.expectedContentVersion, 6);
  assert.equal(t.c.CASES[0].status, 'closed'); await flush();
  assert.match(t.html(), /已核可結案/); assert.match(t.html(), /暫不提供重啟/); assert(!t.btn('送出主管核可…'));
});
await test('paused flags: records stays records; history readable; approve and new submit unavailable; reject and withdraw still work', async () => {
  const server = makeServer(); const owner = env({ server }); await owner.open(); owner.btn('送出主管核可…').click(); await flush(); owner.check('confirm'); owner.btn('送出主管核可').click(); await flush();
  server.workflow = { recordsEnabled: false, workflowEnabled: false, workflowActive: false };
  const t = env({ server, me: { id: 1, name: 'Admin', role: 'admin' }, role: 'admin' }); await t.open();
  assert.match(t.html(), /◆ 交付明細制/); assert.match(t.html(), /流程目前暫停/); assert.match(t.html(), /送審依據/);
  t.btn('審核這份送審').click(); await flush(); assert.equal(t.btn('核可並結案').disabled, true);
  t.type('comment', '請補充延伸尺寸'); t.btn('退回修改').click(); await flush();
  const rj = t.writes()[0]; assert.equal(rj.body.decision, 'reject'); assert.equal(rj.body.comment, '請補充延伸尺寸'); assert.equal(rj.body.zeroSupportApproved, undefined);
  await flush(); assert.match(t.html(), /流程暫停中，暫不能新送審/); assert(!t.btn('送出主管核可…'));
});
await test('legacy feature-off hides quietly; legacy adoption is admin-only, needs reason + one-way acknowledgement and a stable request id', async () => {
  const off = makeServer({ mode: 'legacy' }); off.workflow = { recordsEnabled: false, workflowEnabled: false, workflowActive: false };
  const hidden = env({ server: off, me: { id: 1, name: 'Admin', role: 'admin' } }); await hidden.open(); assert.equal(hidden.rootEl(), null);
  const member = env({ server: makeServer({ mode: 'legacy' }) }); await member.open();
  assert.match(member.html(), /◇ 舊制/); assert.match(member.html(), /舊制案件/); assert(!member.btn('改用交付明細制…')); assert(!member.btn('送出主管核可…'));
  const t = env({ server: makeServer({ mode: 'legacy' }), me: { id: 1, name: 'Admin', role: 'admin' }, role: 'admin' }); await t.open();
  t.btn('改用交付明細制…').click(); await flush(); assert.match(t.html(), /單向變更，無法改回舊制/);
  t.type('reason', '試行導入'); t.btn('確認導入').click(); await flush(); assert.equal(t.writes().length, 0); assert.match(t.html(), /請勾選確認/);
  t.check('ack'); t.btn('確認導入').click(); await flush();
  const ad = t.writes()[0]; assert.equal(ad.url, '/api/cases/R-1/delivery-mode/adopt'); assert.match(ad.body.requestId, /^adopt-/); assert.equal(ad.body.reason, '試行導入');
  assert.equal(t.c.CASES[0].deliveryMode, 'records'); await flush(); assert.match(t.html(), /◆ 交付明細制/);
});
await test('legacy status/Kanban/approval keep the original paths (no interception)', async () => {
  const t = env({ server: makeServer({ mode: 'legacy' }) }); const row = await t.open();
  assert.equal(t.c.caseWorkflowUi.interceptStatus(row, 'doing', 'review_done', null), false);
  assert.equal(t.c.caseWorkflowUi.interceptKanban(row, 'review_done'), false);
  assert.equal(t.c.caseWorkflowUi.handleLegacyDecision('R-1', 'approve'), false);
});
await test('status select on records: review_done opens the submit flow and resets the select; pending → doing opens withdraw', async () => {
  const t = env(); const row = await t.open(); const sel = t.d.get('d-status'); sel.value = 'review_done';
  assert.equal(t.c.caseWorkflowUi.interceptStatus(row, 'doing', 'review_done', sel), true); await flush();
  assert.equal(sel.value, 'doing'); assert(t.rootEl().querySelector('[data-cw-panel="submit"]'));
  t.check('confirm'); t.btn('送出主管核可').click(); await flush(); await flush();
  assert.equal(t.c.caseWorkflowUi.interceptStatus(t.c.CASES[0], 'review_done', 'doing', sel), true); await flush();
  assert(t.rootEl().querySelector('[data-cw-panel="withdraw"]'));
  assert(!t.writes().some(x => x.method === 'PATCH'), 'never PATCH status');
  // the real v33 handler consults C2 before any archive save / reason prompt / PATCH
  const v33 = section('// ── status change with reason', '// ── urgent toggle with reason');
  const hook = v33.indexOf('caseWorkflowUi.interceptStatus'); assert(hook > 0 && hook < v33.indexOf('v41ArchivePending.get') && hook < v33.indexOf('api.cases.update'));
});
await test('Kanban drop on records intercepts before any optimistic change; collaborator allowed by id; unassigned refused; legacy still PATCHes', async () => {
  for (const [me, expectOpen] of [[{ id: '4', name: 'Collab', role: 'member' }, true], [{ id: 9, name: 'Owner', role: 'member' }, false]]) {
    const t = env({ me }); const row = t.c.normalizeCase(t.server.raw()); t.c.CASES = [row];
    t.c.api = { cases: { update: async () => { throw Error('old PATCH must not be called'); } } }; t.c.STATUSES = [];
    vm.runInContext(kanbanDrop, t.c);
    await t.c.v54KanbanDrop('R-1', 'review_done'); await flush();
    assert.equal(row.status, 'doing', 'no optimistic mutation');
    assert.equal(t.opened.includes('R-1'), expectOpen);
    if (expectOpen) assert(t.rootEl().querySelector('[data-cw-panel="submit"]'), 'same submit summary path'); else assert(t.toasts.some(x => /主責、協作者或管理員/.test(x.m)));
  }
  const t = env({ server: makeServer({ mode: 'legacy', archivePath: '/x' }), me: { id: 1, name: 'Admin', role: 'admin' } }); const row = t.c.normalizeCase(t.server.raw()); t.c.CASES = [row];
  const updates = []; t.c.api = { cases: { update: async (id, body) => { updates.push(body); return {}; } } }; t.c.STATUSES = [];
  vm.runInContext(kanbanDrop, t.c); await t.c.v54KanbanDrop('R-1', 'review_done');
  assert.deepEqual(plain(updates), [{ status: 'review_done', reason: '看板拖曳' }]);
});
await test('D2 round4: on a lifecycle-managed records case the real managed Kanban wrapper hands send-review to C2 (preview, no PATCH); ordinary managed drags still need the drawer + reason', async () => {
  // real load order: index.html v54KanbanDrop → case-deliveries.js → case-workflow.js → case-lifecycle.js (outermost wrapper)
  const managedEnv = ({ me, pendingLife = null } = {}) => {
    const server = makeServer(); const base = server.respond;
    const life = { lifecycleMode: 'managed', lifecycleStatus: 'active', currentCycleId: 'cycle-0004-dddd', pendingLifecycleRequestId: pendingLife };
    server.respond = call => {
      if (call.method === 'GET' && /\/(lifecycle|schedule-requests)$/.test(call.url)) throw httpError(404, 'feature_disabled');
      const r = base(call);
      return call.method === 'GET' && /^\/api\/cases\/R-1(\/deliveries|\/delivery-submissions)?$/.test(call.url) ? { ...r, ...life, scheduleMode: 'managed' } : r;
    };
    const t = env({ server, ...(me ? { me } : {}) }); const row = t.c.normalizeCase(server.raw()); Object.assign(row, life, { scheduleMode: 'managed' }); t.c.CASES = [row];
    t.updates = []; t.c.api = { cases: { update: async (id, body) => { t.updates.push(body); return {}; } } }; t.c.STATUSES = [];
    vm.runInContext(kanbanDrop, t.c); vm.runInContext(lifecyclePlugin, t.c);
    return { t, row };
  };
  let { t, row } = managedEnv();
  await t.c.v54KanbanDrop('R-1', 'review_done'); await flush();
  assert.equal(row.status, 'doing', 'no optimistic status'); assert.equal(t.updates.length, 0, 'no PATCH status'); assert.equal(t.writes().length, 0, 'nothing submitted automatically');
  assert(t.rootEl().querySelector('[data-cw-panel="submit"]'), 'C2 submit preview opened'); assert.match(t.html(), /送出主管核可前請確認/);
  assert(!t.toasts.some(x => /受控案件請在案件抽屜變更狀態/.test(x.m)), 'not swallowed by the generic managed toast');
  // ordinary managed status target: still drawer + reason, never a PATCH
  ({ t, row } = managedEnv());
  await t.c.v54KanbanDrop('R-1', 'wait'); await flush();
  assert.equal(t.updates.length, 0); assert(t.toasts.some(x => /受控案件請在案件抽屜變更狀態並寫明具體原因/.test(x.m))); assert.equal(t.opened.at(-1), 'R-1'); assert.equal(row.status, 'doing');
  // unassigned member: C2 refuses, no drawer intent, no write
  ({ t, row } = managedEnv({ me: { id: 9, name: 'Stranger', role: 'member' } }));
  await t.c.v54KanbanDrop('R-1', 'review_done'); await flush();
  assert(t.toasts.some(x => /主責、協作者或管理員/.test(x.m))); assert.equal(t.updates.length + t.writes().length, 0);
  // pending lifecycle request: the C2 path opens but refuses to submit (round2 gate), nothing written
  ({ t, row } = managedEnv({ pendingLife: 'seal-req-0001' }));
  await t.c.v54KanbanDrop('R-1', 'review_done'); await flush();
  assert(!t.rootEl().querySelector('[data-cw-panel="submit"]')); assert.match(t.html(), /封存／復工申請待主管決議，暫不能送審/); assert.equal(t.updates.length + t.writes().length, 0);
});
await test('approval queue: records rows open the snapshot review (no old buttons); old decision handler refuses records; legacy rows unchanged', async () => {
  const server = makeServer(); const owner = env({ server }); await owner.open(); owner.btn('送出主管核可…').click(); await flush(); owner.check('confirm'); owner.btn('送出主管核可').click(); await flush();
  const t = env({ server, me: { id: 1, name: 'Admin', role: 'admin' }, role: 'admin' });
  const view = t.d.seed('v36-approval-list'); const approves = []; let pendingLoads = 0;
  t.c.v36EnsureApprovalView = () => {}; t.c.v36UpdateApprovalBadge = () => {}; t.c.v20Inflight = new Set(); t.c.confirm = () => true; t.c.reloadCase = async () => {};
  t.c.api = { cases: { pending: async () => (pendingLoads++, [{ ...server.raw(), id: 'R-1' }, { ...server.raw(), id: 'L-2', deliveryMode: 'legacy', archivePath: '/l' }]), approve: async (id, body) => { approves.push([id, body]); return {}; } } };
  vm.runInContext(approvalUi, t.c); await t.c.renderApproval();
  const recordsCard = view.querySelector('[data-c2-queue="R-1"]'); assert(recordsCard); assert.equal(view.querySelectorAll('[data-approve-id="R-1"]').length, 0);
  assert.equal(view.querySelectorAll('[data-approve-id="L-2"]').length, 2, 'legacy approve/reject buttons kept');
  await t.c.v36ApprovalDecision('R-1', 'approve'); await flush(); assert.equal(approves.length, 0, 'old {decision, comment} never sent for records');
  const qcard = recordsCard.closest(".card"); assert(qcard.querySelector(".cw-queue-panel"), "opened the C2 review instead");
  const qroot = qcard.querySelector(".cw-queue-panel");
  assert.match(qroot.innerHTML, /送審依據/); assert.match(qroot.innerHTML, /\/shared\/R-1/);
  t.check('zeroOk', true, qroot); t.btn('核可並結案', qroot).click(); await flush();
  const ap = t.writes().find(x => x.url === '/api/cases/R-1/approve'); assert.equal(ap.body.submissionId, server.subs[0].id); assert.equal(ap.body.zeroSupportApproved, true);
  assert(pendingLoads >= 2, 'queue re-rendered after the decision');
  await t.c.v36ApprovalDecision('L-2', 'approve'); assert.deepEqual(plain(approves), [['L-2', { decision: 'approve', comment: '' }]], 'legacy path unchanged');
});
// Acceptance round 1 P2: the reviewer's support-0 approval and comment belong to one immutable submission.
async function queueWithPending() {
  const server = makeServer(); const owner = env({ server }); await owner.open(); owner.btn('送出主管核可…').click(); await flush(); owner.check('confirm'); owner.btn('送出主管核可').click(); await flush();
  const t = env({ server, me: { id: 1, name: 'Admin', role: 'admin' }, role: 'admin' });
  const list = t.d.seed('v36-approval-list');
  t.c.v36EnsureApprovalView = () => {}; t.c.v36UpdateApprovalBadge = () => {}; t.c.v20Inflight = new Set(); t.c.confirm = () => true; t.c.reloadCase = async () => {};
  t.c.api = { cases: { pending: async () => (server.pending ? [{ ...server.raw(), id: 'R-1' }] : []), approve: async () => { throw Error('old approve must not be called'); } } };
  vm.runInContext(approvalUi, t.c); await t.c.renderApproval();
  list.querySelector('[data-c2-review="R-1"]').click(); await flush();
  const qroot = () => list.querySelector('.cw-queue-panel');
  return { server, t, qroot };
}
function replaceWithS2(server) {   // another admin rejects S1; the designer corrects and resubmits S2 with a new support-0 reason
  const s1 = server.subs[0]; Object.assign(s1, { status: 'rejected', decidedAt: server.iso(), decidedByName: 'Admin B', decisionReason: '補充說明' });
  server.version++; server.stamp += 1000;
  const s2 = { ...plain(s1), id: 'sub-second-000002', status: 'pending', decidedAt: null, decidedByName: null, decisionReason: null, submittedAt: server.iso(),
    zeroSupport: [{ id: 'dlv-sup-0001', itemName: '版面諮詢', note: '新說明：協助排版審稿兩次' }] };
  server.subs.push(s2); server.pending = s2.id; server.status = 'review_done'; server.version++; server.stamp += 1000;
  return { s1, s2 };
}
await test('queue S1 → another admin decides → resubmitted S2: stale approve 409s, S2 opens unchecked with no carried comment, approve blocked until S2 is acknowledged', async () => {
  const { server, t, qroot } = await queueWithPending();
  t.check('zeroOk', true, qroot()); t.type('comment', 'S1 專用評語', qroot());
  const { s2 } = replaceWithS2(server);
  t.btn('核可並結案', qroot()).click(); await flush(); await flush();
  const first = t.writes().filter(x => x.url === '/api/cases/R-1/approve'); assert.equal(first.length, 1); assert.equal(first[0].body.submissionId, server.subs[0].id);
  assert(qroot().innerHTML.includes('新說明：協助排版審稿兩次'), 'S2 snapshot shown'); assert.match(qroot().innerHTML, /另一份新送審/);
  assert.equal(t.field('zeroOk', qroot()).getAttribute('checked'), null, 'S1 acknowledgement not carried to S2');
  assert.equal(t.field('comment', qroot()).textContent, '', 'S1 comment not carried to S2');
  t.btn('核可並結案', qroot()).click(); await flush();
  assert.equal(t.writes().filter(x => x.url === '/api/cases/R-1/approve').length, 1, 'no approve until S2 acknowledged'); assert.match(qroot().innerHTML, /核可前請勾選/);
  t.check('zeroOk', true, qroot()); t.btn('核可並結案', qroot()).click(); await flush();
  const second = t.writes().filter(x => x.url === '/api/cases/R-1/approve')[1];
  assert.equal(second.body.submissionId, s2.id); assert.equal(second.body.zeroSupportApproved, true); assert.equal(second.body.comment, undefined); assert.equal(s2.status, 'approved');
});
await test('queue: an ambiguous S1 decision is reconfirmed with the identical request, never retargeted to S2; same-submission 409 keeps the comment draft', async () => {
  const { server, t, qroot } = await queueWithPending();
  t.check('zeroOk', true, qroot()); t.type('comment', '確認無誤', qroot());
  let lose = true; server.hook = call => { if (lose && call.url === '/api/cases/R-1/approve') { lose = false; throw httpError(503, 'unavailable'); } };
  t.btn('核可並結案', qroot()).click(); await flush();
  const original = t.writes().find(x => x.url === '/api/cases/R-1/approve');
  replaceWithS2(server);
  // the queue view re-reads history (as after any reload): the ambiguous S1 request must stay bound to S1
  const v = t.c.caseWorkflowUi._queue('R-1'); assert(v);
  v.root.onclick({ target: { closest: () => ({ dataset: { act: 'reload' }, disabled: false }) } }); await flush();
  assert.match(qroot().innerHTML, /上一份送審的操作結果不明/); assert(!qroot().innerHTML.includes('核可並結案'), 'S2 decision controls withheld until S1 is reconfirmed');
  t.btn('重新確認送出', qroot()).click(); await flush(); await flush();
  const approves = t.writes().filter(x => x.url === '/api/cases/R-1/approve');
  assert.equal(approves.length, 2); assert.deepEqual(approves[1].body, original.body, 'exact S1 payload resent, not rewritten');
  assert.equal(server.subs[1].status, 'pending', 'S2 untouched'); assert.equal(t.field('zeroOk', qroot()).getAttribute('checked'), null, 'then S2 starts unacknowledged');
  // same submission, determinate 409 (version moved): the comment draft is kept for that submission
  t.type('comment', '同一份的評語', qroot()); server.version++; t.btn('退回修改', qroot()).click(); await flush();
  assert.equal(t.field('comment', qroot()).textContent, '同一份的評語');
});
await test('D2: a pending lifecycle request on the viewed snapshot offers no submit button; a summary that turns pending blocks the send (no 409-bound POST)', async () => {
  const server = makeServer(); const base = server.respond; let pendingLife = 'seal-req-0001';
  server.respond = call => { const r = base(call); return call.method === 'GET' && /\/(delivery-submissions|deliveries)$/.test(call.url)
    ? { ...r, lifecycleMode: 'managed', lifecycleStatus: 'active', currentCycleId: 'cycle-0001-aaaa', pendingLifecycleRequestId: pendingLife } : r; };
  const t = env({ server }); await t.open();
  assert(!t.btn('送出主管核可…'), 'no submit button while the viewed snapshot has a pending lifecycle request');
  assert.match(t.html(), /封存／復工申請待主管決議，暫不能送審/);
  pendingLife = null; t.btn('重新讀取').click(); await flush();
  t.btn('送出主管核可…').click(); await flush();
  assert.match(t.html(), /送出主管核可前請確認/); t.check('confirm');
  pendingLife = 'seal-req-0002'; t.btn('重新檢視').click(); await flush();
  assert.match(t.html(), /封存／復工申請待主管決議，暫不能送審/); assert.equal(t.btn('送出主管核可').disabled, true);
  assert.equal(t.writes().filter(x => x.method === 'POST').length, 0);
  // sealed / ended cycle: also not submittable
  pendingLife = null; server.respond = call => { const r = base(call); return call.method === 'GET' && /\/(delivery-submissions|deliveries)$/.test(call.url)
    ? { ...r, lifecycleMode: 'managed', lifecycleStatus: 'sealed_incomplete', currentCycleId: 'cycle-0001-aaaa', pendingLifecycleRequestId: null } : r; };
  const u = env({ server }); await u.open(); assert(!u.btn('送出主管核可…')); assert.match(u.html(), /週期已結束，無法送審/);
});
await test('frozen records evidence renders the sub-items panel read-only with matching copy (index.html)', async () => {
  const panel = section('function v43InjectSubItemsPanel(c, body)', 'const panel = document.createElement');
  assert.match(panel, /const v43EvidenceFrozen = c\.deliveryMode === 'records' && \['review_done', 'done', 'closed'\]\.includes\(c\.status\);/);
  assert.match(panel, /const v43RoleCanWrite = \(isAdmin \|\| isPrimary \|\| isCollab\) && !v43EvidenceFrozen;/);
  assert.match(panel, /const writable = \(\) => v43RoleCanWrite && !v43LifecycleLock\(c\);/);   // REPORTS-P2-D2: + lifecycle, re-checked per render
  assert.match(section('function v43InjectSubItemsPanel(c, body)', '<div id="v43-collapsible"'), /送審中・暫停修改（撤回後可編輯）/);
});
await test('history switch: legacyClosed → approvedRecords → differentLegacyClosed → live case rebuilds the reopen area for the current case only', async () => {
  const d = dom(); const drawer = d.seed('drawer'); const body = d.element('div'); body.className = 'drawer-body'; drawer.appendChild(body);
  body.innerHTML = '<input id="d-log-input"><button id="d-log-submit">儲存進度</button>';
  const reopened = [];
  const c = vm.createContext({ console, document: d.document, ME: { id: 1, name: 'Admin', role: 'admin' }, ENDED_STATUS_KEYS: new Set(['done', 'closed', 'cancelled']), Set, Promise });
  c.window = c; c.ME_NAME = () => 'Admin'; c.v20IsMine = () => false; c.v71CanCancel = () => false; c.IS_OBSERVER = () => false;
  c.openDrawer = async () => {}; c.v37ReopenCase = row => reopened.push(row.id);   // stand-in: no real clone / write
  vm.runInContext(section('function v2Outcome(c)', 'function ymdIso(dt)') + section('const _v37OrigOpenDrawer', 'async function v37ReopenCase'), c);   // REPORTS-P2-D2 outcome helper
  const wrapText = () => d.get('v37-reopen-wrap')?.textContent || '';
  const reopenBtn = () => d.get('v37-reopen-btn');
  await c.openDrawer({ id: 'L-983', status: 'closed', archived: true, deliveryMode: 'legacy', _designerId: 2 });
  assert.match(wrapText(), /可開新案沿用內容/); assert(reopenBtn() && !reopenBtn().disabled); reopenBtn().click(); assert.deepEqual(reopened, ['L-983']);
  await c.openDrawer({ id: 'R-985', status: 'closed', archived: true, deliveryMode: 'records', _designerId: 2 });
  assert.equal(d.document.querySelectorAll('#v37-reopen-wrap').length, 1, 'one fresh wrap, not a reused one');
  assert.equal(reopenBtn(), null, 'approved records: no reopen button'); assert.match(wrapText(), /交付明細制案件核可後暫不提供重啟/); assert(!/可開新案/.test(wrapText()));
  assert.equal(d.get('d-log-submit').disabled, true, 'historical read-only sweep still applies');
  await c.openDrawer({ id: 'L-990', status: 'done', archived: true, deliveryMode: 'legacy', _designerId: 2 });
  assert.match(wrapText(), /可開新案沿用內容/); reopenBtn().click(); assert.deepEqual(reopened, ['L-983', 'L-990'], 'handler bound to the current case, never the previous one');
  await c.openDrawer({ id: 'L-991', status: 'doing', archived: false, deliveryMode: 'legacy', _designerId: 1 });
  assert.equal(d.get('v37-reopen-wrap'), null, 'live case cleans the historical area'); assert.equal(d.get('d-log-submit').disabled, false, 'live case re-enables swept controls');
});
await test('case switch and delayed responses never paint another case; op response with a version jump does not stamp stale content', async () => {
  const t = env(); const gate = deferred(); let held = true;
  t.server.hook = call => { if (held && call.url === '/api/cases/R-1/delivery-submissions') { held = false; return gate.promise.then(() => t.server.respond({ ...call })); } };
  const row = t.c.normalizeCase(t.server.raw()); t.c.CASES = [row]; t.c.openDrawer(row); await flush();
  const other = { ...row, id: 'X-9', deliveryMode: 'legacy' };
  t.c.openDrawer(other); await flush();
  gate.resolve(); await flush();
  assert(!/送出主管核可/.test(t.html()), 'A history did not render into B');
  // version jump: our op +1 but the server is already +3 → do not stamp, rely on the authoritative refetch
  const local = t.c.normalizeCase(t.server.raw()); local.logs = [{ note: 'stale local', by: 'x', date: new Date() }];
  t.c.CASES = [local];
  t.server.version += 2;
  await t.open(local); t.btn('送出主管核可…').click(); await flush();
  assert.equal(local._contentVersion, 7, 'merged only through the authoritative GET with its content'); assert.notEqual(local.logs[0].note, 'stale local');
});
await test('approved records: closure counts are read-only (0 stays 0, unknown stays —) and legacy closure inputs are unchanged', async () => {
  const t = env(); vm.runInContext(closureUi, t.c); t.c.workdaysBetween = () => 5; t.c.exportDetail = () => {};
  t.c.v40RenderClosure({ status: 'closed', deliveryMode: 'records', requestCount: 0, outputCount: null, open: new Date() });
  const box = t.d.get('d-closure');
  assert.equal(box.querySelector('#d-req-count'), null); assert.equal(box.querySelector('#d-closure-save'), null);
  assert.equal(box.querySelector('[data-closure-value="requestCount"]').textContent, '0'); assert.equal(box.querySelector('[data-closure-value="outputCount"]').textContent, '—');
  t.c.v40RenderClosure({ status: 'closed', deliveryMode: 'legacy', requestCount: 2, outputCount: 0, open: new Date() });
  assert(box.querySelector('#d-req-count')); assert(box.querySelector('#d-closure-save'));
  const v37 = section('const _v37OrigOpenDrawer', 'async function v37ReopenCase');
  assert.match(v37, /const canReopen = \(isAdmin \|\| isOriginalDesigner\) && c\.deliveryMode !== 'records' && c\.lifecycleMode !== 'managed';/);
});
await test('assets load after B, CSS keeps 44px mobile targets and token-based dark mode; drafts are scoped by real user id and case', async () => {
  const order = [source.indexOf('/case-deliveries.js?v='), source.indexOf('/case-workflow.js?v=')]; assert(order[0] > 0 && order[1] > order[0], 'C2 hook is outermost');
  assert.match(source, /<script src="\/case-workflow\.js\?v=[0-9a-f]{12}"><\/script>/); assert.match(source, /<link rel="stylesheet" href="\/case-workflow\.css\?v=[0-9a-f]{12}">/);
  assert.match(css, /@media\(max-width:620px\)\{[^}]*\.cw-root \.cw-btn[^{]*\{min-height:44px;min-width:44px/);
  assert(!/#[0-9a-f]{3,6}\)?;?\s*\}\s*$/.test('') && /var\(--hf-ink/.test(css) && /var\(--hf-surface/.test(css));
  const storage = makeStorage(); const t = env({ storage }); await t.open(); t.btn('送出主管核可…').click(); await flush(); t.check('confirm');
  const keys = [...storage.map.keys()].filter(k => k.startsWith('dpm.workflow.v1:2:R-1:')); assert(keys.length >= 1, 'draft keyed by real user id and case');
  const intruder = env({ storage, me: { id: 9, name: 'Owner', role: 'member' } }); assert.equal(intruder.c.caseWorkflowUi.readDraft(9, 'R-1', 'submit'), null);
});
console.log(JSON.stringify({ passed, failed, browserAutomation: false, liveNetwork: false, productionWrites: 0 }));
if (failed) process.exitCode = 1;
