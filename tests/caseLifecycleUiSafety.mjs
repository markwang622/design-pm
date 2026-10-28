// REPORTS-P2-D2: the actual public/case-lifecycle.js (schedule + seal/resume panels, write binder, Kanban guard),
// public/release-notice.js and the notices API, plus the shared outcome reader helpers extracted from index.html,
// in the inert DOM scaffold reused from tests/caseDeliveriesUiSafety.mjs. No network, database, browser or mail.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import { Duplex } from 'node:stream';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
process.env.TZ = 'Asia/Taipei';
const root = process.env.DESIGN_PM_ROOT || new URL('../', import.meta.url).pathname;
const source = fs.readFileSync(root + '/public/index.html', 'utf8');
const plugin = fs.readFileSync(root + '/public/case-lifecycle.js', 'utf8');
const noticePlugin = fs.readFileSync(root + '/public/release-notice.js', 'utf8');
const bTest = fs.readFileSync(root + '/tests/caseDeliveriesUiSafety.mjs', 'utf8');
function section(start, end, text = source) { const a = text.indexOf(start), b = text.indexOf(end, a + start.length); assert(a >= 0 && b > a, 'source section exists: ' + start); return text.slice(a, b); }
const { dom } = new Function(section('const decode=', '\nconst helpers', bTest) + '\nreturn { dom };')();
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const plain = v => JSON.parse(JSON.stringify(v));
const httpError = (status, error, message) => Object.assign(new Error(message || error), { status, data: { error, message } });
const helpers = section('function escapeHtml(s)', 'async function v33SaveEdit') + section('function normalizeCase(b)', 'function findStaffId');
const UA = '2026-10-26T01:00:00.000Z';
const lifeData = (extra = {}) => ({ caseId: 'R-1', mode: 'managed', lifecycleStatus: 'active', status: 'doing', archived: false, updatedAt: UA, contentVersion: 7, currentCycleId: 'cycle-0001-aaaa',
  pendingRequestId: null, reasonCategories: { requester_change: '需求方變更', other: '其他' }, workflow: { workflowEnabled: true, paused: false },
  outputs: { currentCycle: { cycleId: 'cycle-0001-aaaa', sequence: 1, summary: { groups: [] }, unattributedRecords: 0, status: 'none_recorded' }, cumulative: { status: 'unknown', groups: [] }, legacyCounts: { requestCount: null, outputCount: null } },
  cycles: [{ id: 'cycle-0001-aaaa', sequence: 1, source: 'adoption', startedAt: UA, startReason: '試行', open: true }], requests: [], ...extra });
const schedData = (extra = {}) => ({ caseId: 'R-1', mode: 'managed', status: 'doing', archived: false, updatedAt: UA, contentVersion: 7, lifecycleMode: 'managed', currentCycleId: 'cycle-0001-aaaa',
  schedule: { dispatchDate: '2026-10-02', copyDate: '2026-10-10', printDate: null, goLiveDate: '2026-10-30' }, baseline: { dispatchDate: '2026-10-02', copyDate: null, printDate: null, goLiveDate: '2026-10-30' },
  pendingRequestId: null, reasonCategories: { requester_change: '需求方變更', other: '其他' }, workflow: { workflowEnabled: true, paused: false }, requests: [], ...extra });
const caseRow = (extra = {}) => ({ id: 'R-1', name: '品牌主視覺', status: 'doing', archived: false, _designerId: 2, _collaboratorIds: [4], archivePath: '/shared/R-1', _updatedAt: UA, _contentVersion: 7,
  lifecycleMode: 'managed', lifecycleStatus: 'active', currentCycleId: 'cycle-0001-aaaa', scheduleMode: 'managed', pendingLifecycleRequestId: null, ...extra });

function env({ me = { id: 2, name: 'Owner', role: 'member' }, role = 'designer', responder = () => ({}), withKanban = false } = {}) {
  const d = dom(), calls = [], toasts = [], opened = [], kanban = [];
  const drawer = d.seed('drawer'); const body = d.element('div'); body.className = 'drawer-body'; drawer.appendChild(body);
  const archive = d.element('div', 'd-archive'); body.appendChild(archive); archive.innerHTML = '<input id="d-archive-input" value="/shared/R-1"><button id="d-archive-save">儲存</button>';
  const status = d.element('div'); status.className = 'status-change'; body.appendChild(status); status.innerHTML = '<select id="d-status"><option value="doing">doing</option></select>';
  const store = new Map();
  const c = vm.createContext({ console, Date, Intl, Set, Map, Promise, JSON, Math, Number, String, Object, Array, Error, crypto: webcrypto, setTimeout, clearTimeout, document: d.document,
    sessionStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) }, ME: me, currentRole: role, CASES: [], currentCase: null,
    TODAY: new Date('2026-10-26T00:00:00+08:00'), showToast: (m, t) => toasts.push({ m, t }), ENDED_STATUS_KEYS: new Set(['done', 'closed', 'cancelled']) });
  c.window = c;
  vm.runInContext(helpers + '\nconst IS_OBSERVER = () => currentRole === "observer";\nfunction isCancelled(c) { return c.status === "cancelled"; }', c);
  c.v95DrawerSeq = (() => { let n = 0; return { bump: () => ++n, now: () => n }; })();
  c.fetchJson = async (method, url, payload) => { const call = { method, url, body: payload === undefined ? undefined : plain(payload) }; calls.push(call); return responder(call); };
  c.decorateCase = () => {}; c.decorateCases = () => {}; c.refreshAll = () => {};
  if (withKanban) c.v54KanbanDrop = async (id, s) => { kanban.push([id, s]); };
  c.openDrawer = async row => { opened.push(row.id); c.currentCase = row; c.v95DrawerSeq.bump(); await Promise.resolve(); };
  vm.runInContext(plugin, c);
  const rootEl = () => d.get('d-lifecycle');
  const btn = label => rootEl().querySelectorAll('button').find(b => b.textContent.trim() === label);
  const fld = name => rootEl().querySelector(`[data-f="${name}"]`);
  const type = (name, value) => { const el = fld(name); el.value = value; el.dispatchEvent({ type: el.tagName === 'SELECT' ? 'change' : 'input' }); };
  const open = async row => { c.CASES = [row]; c.openDrawer(row); await flush(); return row; };
  return { c, d, calls, toasts, opened, kanban, rootEl, btn, fld, type, open, posts: () => calls.filter(x => x.method !== 'GET') };
}
const routes = (life, sched, onPost) => call => {
  if (call.method === 'GET' && call.url.endsWith('/lifecycle')) return life;
  if (call.method === 'GET' && call.url.endsWith('/schedule-requests')) return sched;
  if (call.method === 'GET' && /\/api\/cases\/R-1$/.test(call.url)) return { id: 'R-1', title: '品牌主視覺', status: 'doing', updatedAt: '2026-10-26T02:00:00.000Z', contentVersion: 8, lifecycleMode: 'managed', lifecycleStatus: 'active', currentCycleId: 'cycle-0001-aaaa', scheduleMode: 'managed' };
  return onPost ? onPost(call) : { request: { id: call.body.id }, case: {}, replayed: false };
};
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); } }

await test('one outcome selector: sealed is neither active nor completed; legacy archived keeps its meaning; 本月結案 counts completed only', async () => {
  const t = env(); const o = r => t.c.v2Outcome(t.c.normalizeCase({ id: 'X', title: 'x', ...r }));
  assert.equal(o({ status: 'doing', archived: true, lifecycleMode: 'managed', lifecycleStatus: 'sealed_incomplete' }), 'sealed_incomplete');
  assert.equal(o({ status: 'closed', archived: true, lifecycleMode: 'managed', lifecycleStatus: 'completed' }), 'completed');
  assert.equal(o({ status: 'doing', archived: true }), 'completed', 'legacy archived = finished (unchanged)');
  assert.equal(o({ status: 'cancelled', archived: true }), 'cancelled'); assert.equal(o({ status: 'doing' }), 'active');
  assert.equal(t.c.v2OutcomeLabel(t.c.normalizeCase({ id: 'X', title: 'x', status: 'doing', archived: true, lifecycleMode: 'managed', lifecycleStatus: 'sealed_incomplete' })), '未完成封存');
  const n = t.c.normalizeCase({ id: 'X', title: 'x', lifecycleMode: 'managed', lifecycleStatus: 'active', currentCycleId: 'cycle-1', pendingLifecycleRequestId: 'r1', scheduleMode: 'managed', scheduleBaseline: { a: 1 } });
  assert.equal(n.currentCycleId, 'cycle-1'); assert.equal(n.pendingLifecycleRequestId, 'r1'); assert.equal(n.scheduleMode, 'managed');
  vm.runInContext(section('async function v62LoadClosed()', 'function v62ShowClosed(items)'), t.c);
  t.c.api = { cases: { listArchived: async () => [{ id: 'S', title: 's', status: 'doing', archived: true, lifecycleMode: 'managed', lifecycleStatus: 'sealed_incomplete' },
    { id: 'C', title: 'c', status: 'closed', archived: true }, { id: 'X', title: 'x', status: 'cancelled', archived: true }] } };
  assert.deepEqual((await t.c.v62LoadClosed()).map(c => c.id), ['C'], 'sealed and cancelled are not completions');
});
await test('seal request (no archivable file): category + specific reason + evidence, versions and cycle from the viewed lifecycle snapshot; nothing pre-applied', async () => {
  const t = env({ responder: routes(lifeData(), schedData()) }); await t.open(caseRow());
  t.btn('申請未完成封存…').click(); await flush();
  t.type('reasonCategory', 'requester_change'); t.type('reason', '需求方暫停活動');
  const radio = t.rootEl().querySelectorAll('input').find(i => i.getAttribute('value') === 'no_file'); radio.checked = true; radio.dispatchEvent({ type: 'change' }); await flush();
  t.type('noFileReason', '僅完成討論稿，尚未產出檔案');
  t.btn('送出封存申請').click(); await flush();
  const post = t.posts().find(x => x.url === '/api/cases/R-1/lifecycle/requests');
  assert(post, 'posted'); assert.equal(post.body.kind, 'seal'); assert.equal(post.body.reasonCategory, 'requester_change'); assert.deepEqual(post.body.evidence, { type: 'no_file', reason: '僅完成討論稿，尚未產出檔案' });
  assert.equal(post.body.expectedUpdatedAt, UA); assert.equal(post.body.expectedContentVersion, 7); assert.equal(post.body.expectedCycleId, 'cycle-0001-aaaa'); assert.match(post.body.id, /^seal-/);
});
await test('placeholder reason is refused before sending; an ambiguous result resends the identical request (same id and body)', async () => {
  let n = 0; const t = env({ responder: routes(lifeData(), schedData(), () => { if (++n === 1) throw httpError(0, 'network'); return { request: {}, case: {}, replayed: true }; }) });
  await t.open(caseRow());
  t.btn('申請未完成封存…').click(); await flush(); t.type('reasonCategory', 'other'); t.type('reason', '—'); t.btn('送出封存申請').click(); await flush();
  assert.equal(t.posts().length, 0); assert.match(t.rootEl().innerHTML, /請寫出具體原因/);
  t.type('reason', '需求方暫停活動'); t.btn('送出封存申請').click(); await flush();
  assert.match(t.rootEl().innerHTML, /無法確認是否已送出/); t.btn('重新確認送出').click(); await flush();
  const posts = t.posts().filter(x => x.url.endsWith('/lifecycle/requests')); assert.equal(posts.length, 2); assert.deepEqual(posts[1].body, posts[0].body);
});
await test('schedule: earlier-only change saves directly with a reason (PATCH, viewed versions); a postponement becomes an approval request', async () => {
  const t = env({ responder: routes(lifeData(), schedData()) }); await t.open(caseRow());
  t.btn('調整里程碑日期…').click(); await flush();
  const goLive = t.rootEl().querySelectorAll('input').find(i => i.getAttribute('data-date') === 'goLiveDate');
  goLive.value = '2026-10-28'; goLive.dispatchEvent({ type: 'input' }); t.type('reason', '需求方提早上線'); t.btn('送出').click(); await flush();
  const patch = t.posts().find(x => x.method === 'PATCH'); assert(patch, 'direct save'); assert.equal(patch.url, '/api/cases/R-1');
  assert.deepEqual([patch.body.goLiveDate, patch.body.reason, patch.body.expectedContentVersion, patch.body.expectedCycleId], ['2026-10-28', '需求方提早上線', 7, 'cycle-0001-aaaa']);
  const t2 = env({ responder: routes(lifeData(), schedData()) }); await t2.open(caseRow());
  t2.btn('調整里程碑日期…').click(); await flush();
  const g2 = t2.rootEl().querySelectorAll('input').find(i => i.getAttribute('data-date') === 'goLiveDate'); g2.value = '2026-11-06'; g2.dispatchEvent({ type: 'input' });
  t2.type('reason', '需求方延後活動檔期'); t2.btn('送出').click(); await flush();
  assert.equal(t2.posts().length, 0, 'postponement needs a category'); t2.type('reasonCategory', 'requester_change'); t2.btn('送出').click(); await flush();
  const req = t2.posts().find(x => x.url === '/api/cases/R-1/schedule-requests'); assert(req); assert.deepEqual(req.body.proposedDates, { goLiveDate: '2026-11-06' });
});
await test('paused: the approve action is not offered (disabled) while reject stays available; observers get no request actions', async () => {
  const pend = { id: 'seal-req-0001', kind: 'seal', status: 'pending', requestedByName: 'Owner', requestedAt: UA, reason: '需求方暫停', reasonCategoryLabel: '其他', evidence: { type: 'archive', archivePath: '/shared/R-1' } };
  const t = env({ me: { id: 1, name: 'Admin', role: 'admin' }, role: 'admin', responder: routes(lifeData({ pendingRequestId: pend.id, requests: [pend], workflow: { workflowEnabled: false, paused: true } }), schedData()) });
  await t.open(caseRow({ pendingLifecycleRequestId: pend.id }));
  t.btn('審核申請').click(); await flush();
  assert.equal(t.btn('核准未完成封存').disabled, true); assert.equal(t.btn('退回').disabled, false);
  assert.equal(t.d.get('d-status').disabled, true, 'old evidence controls frozen while a lifecycle request is pending');
  const o = env({ me: { id: 5, name: 'Obs', role: 'observer' }, role: 'observer', responder: routes(lifeData(), schedData()) }); await o.open(caseRow());
  assert(!o.btn('申請未完成封存…') && !o.btn('調整里程碑日期…'));
});
await test('write binder: legacy untouched; managed fills all three only from the one cached snapshot; never replaces explicit (even stale) versions', async () => {
  const t = env({ responder: () => ({}) });
  const legacy = { id: 'L-1', lifecycleMode: 'legacy', scheduleMode: 'legacy', _updatedAt: UA, _contentVersion: 3 }; t.c.CASES = [legacy, caseRow()];
  assert.deepEqual(plain(t.c.caseLifecycleUi.bindBody('/api/cases/L-1', { title: 'x' })), { title: 'x' });
  assert.deepEqual(plain(t.c.caseLifecycleUi.bindBody('/api/cases/R-1', { title: 'x' })), { title: 'x', expectedUpdatedAt: UA, expectedContentVersion: 7, expectedCycleId: 'cycle-0001-aaaa' });
  assert.deepEqual(plain(t.c.caseLifecycleUi.bindBody('/api/cases/R-1/logs', { logs: [], expectedUpdatedAt: UA, expectedContentVersion: 7 })).expectedCycleId, 'cycle-0001-aaaa', 'same snapshot → cycle added');
  const stale = { items: [], expectedUpdatedAt: '2026-10-20T00:00:00.000Z', expectedContentVersion: 5 };
  assert.deepEqual(plain(t.c.caseLifecycleUi.bindBody('/api/cases/R-1/items', stale)), stale, 'stale explicit versions stay honest (server 409)');
  assert.deepEqual(plain(t.c.caseLifecycleUi.bindBody('/api/cases/R-1/lifecycle/requests', { a: 1 })), { a: 1 }, 'explicit lifecycle routes untouched');
});
// The real v43 sub-items editor (index.html) mounted in the same drawer as the real lifecycle module.
const itemsEditor = section('api.cases.patchItems =', '// ─── v4.4: 子案件納入');
function mountItems(t, row, { prompts = [] } = {}) {
  const { c, d } = t;
  if (!c.__itemsLoaded) {
    Object.assign(c, { api: { cases: {} }, STAFF: [{ id: 2, name: 'Owner', active: true, role: 'member' }], DELIVERABLES: ['PDF', '海報'], confirmAnswers: [], prompts,
      v20SameId: (a, b) => a != null && b != null && String(a) === String(b), v20IsPrimary: (x, id) => String(x._designerId) === String(id), v20IsCollab: (x, id) => (x._collaboratorIds || []).some(y => String(y) === String(id)),
      ME_NAME: () => 'Owner', v20TaiwanToday: () => '2026-10-26', ymd: dt => String(dt), ymdIso: dt => (dt instanceof Date ? dt.toISOString().slice(0, 10) : String(dt)),
      v10SyncUpdatedAt: (x, raw) => { if (raw && raw.updatedAt) x._updatedAt = raw.updatedAt; if (raw && raw.contentVersion != null) x._contentVersion = raw.contentVersion; },
      v10ConflictMsg: (e, m) => m, reloadCase: async () => {}, v33RenderChangeLog: () => {} });
    c.confirm = () => (c.confirmAnswers.length ? c.confirmAnswers.shift() : true); c.prompt = () => (c.prompts.length ? c.prompts.shift() : null);
    vm.runInContext(itemsEditor, c); c.__itemsLoaded = true;
  }
  const host = d.element('div'); d.get('drawer').appendChild(host); c.v43InjectSubItemsPanel(row, host);
  const nameInput = () => host.querySelector('input[data-k="n"]');
  const edit = value => { const el = nameInput(); el.value = value; el.oninput({ target: el }); };
  return { host, html: () => host.querySelector('.v43-items-panel').innerHTML, nameInput, edit, addBtn: () => host.querySelector('#v43-item-add'), saveBtn: () => host.querySelector('#v43-items-save') };
}
const itemRow = extra => caseRow({ items: [{ key: 'item-0001', n: '主視覺', type: 'PDF', status: '尚未製作', logs: [] }], ...extra });

await test('unsaved sub-item edits block a D2 workflow send (nothing silently lost); discard returns to the snapshot, then the same request goes through', async () => {
  const t = env({ responder: routes(lifeData(), schedData()) }); const row = await t.open(itemRow());
  const ed = mountItems(t, row);
  ed.edit('主視覺 第二版'); assert.equal(t.c.v43ItemsDirty('R-1'), true);
  t.btn('申請未完成封存…').click(); await flush(); t.type('reasonCategory', 'requester_change'); t.type('reason', '需求方暫停活動');
  t.btn('送出封存申請').click(); await flush();
  assert.equal(t.posts().length, 0, 'no request while item edits are unsaved'); assert.equal(t.opened.length, 1, 'drawer not reopened');
  assert.match(t.rootEl().innerHTML, /子案件有尚未儲存的變更，這次沒有送出/);
  assert.equal(ed.nameInput().value, '主視覺 第二版', 'the unsaved edit is still on screen');
  assert.equal(t.fld('reason').value, '需求方暫停活動', 'the request draft is kept too');
  t.c.confirmAnswers.push(false); t.btn('放棄子案件變更').click(); await flush();
  assert.equal(ed.nameInput().value, '主視覺 第二版', 'cancelled confirm discards nothing');
  t.btn('放棄子案件變更').click(); await flush();
  assert.equal(ed.nameInput().value, '主視覺'); assert.equal(t.c.v43ItemsDirty('R-1'), false);
  t.btn('送出封存申請').click(); await flush();
  assert.equal(t.posts().filter(x => x.url === '/api/cases/R-1/lifecycle/requests').length, 1);
});
await test('a saved sub-item edit is no longer unsaved: the workflow request then goes through', async () => {
  const t = env({ responder: routes(lifeData(), schedData(), call => (call.url === '/api/cases/R-1/items'
    ? { id: 'R-1', items: call.body.items, updatedAt: '2026-10-26T03:00:00.000Z', contentVersion: 8 } : { request: { id: call.body.id }, case: {}, replayed: false })) });
  const row = await t.open(itemRow()); const ed = mountItems(t, row, { prompts: ['調整子案件名稱'] });
  ed.edit('主視覺 第二版'); await ed.saveBtn().onclick(); await flush();
  const patch = t.posts().find(x => x.url === '/api/cases/R-1/items'); assert(patch); assert.equal(patch.body.expectedCycleId, 'cycle-0001-aaaa'); assert.equal(patch.body.items[0].key, 'item-0001');
  assert.equal(t.c.v43ItemsDirty('R-1'), false);
});
await test('items editor capability: pending / sealed / closed render read-only on every render, and stale handlers refuse at the event entry', async () => {
  // opened from an active snapshot; the drawer's fresher lifecycle read (newer contentVersion) shows a pending request
  let release; const gate = new Promise(r => { release = r; });
  const t = env({ responder: routes(gate.then(() => lifeData({ contentVersion: 8, pendingRequestId: 'seal-req-0001' })), schedData()) });
  const row = itemRow(); t.c.CASES = [row]; t.c.openDrawer(row); await flush();
  const ed = mountItems(t, row);
  assert(ed.addBtn(), 'editable before the read arrives'); const staleInput = ed.nameInput(), staleSave = ed.saveBtn(), staleAdd = ed.addBtn();
  ed.edit('主視覺 第二版');
  release(); await flush();
  assert(!ed.addBtn() && !ed.saveBtn(), 're-rendered read-only (no add/save)'); assert.equal(ed.nameInput().disabled, true);
  assert.match(ed.html(), /封存／復工申請待主管決議：子案件暫停修改/);
  assert.match(ed.html(), /尚未儲存的子案件變更，但案件目前不能修改/, 'the unsaved edit is disclosed, not silently dropped');
  const toasts = t.toasts.length;
  staleInput.value = '偷改'; staleInput.oninput({ target: staleInput }); staleAdd.onclick(); await staleSave.onclick(); await flush();
  assert.equal(t.posts().length, 0, 'old handlers never write'); assert(t.toasts.length > toasts && /暫停修改/.test(t.toasts.at(-1).m));
  assert.notEqual(ed.nameInput().value, '偷改');
  t.c.confirmAnswers.push(true); ed.host.querySelector('button[data-act="v43-discard"]').onclick();
  assert.equal(t.c.v43ItemsDirty('R-1'), false); assert.equal(ed.nameInput().value, '主視覺'); assert.equal(ed.nameInput().disabled, true, 'still read-only after discard');
  for (const [extra, re] of [[{ lifecycleStatus: 'sealed_incomplete', archived: true }, /未完成封存：子案件僅可瀏覽/], [{ lifecycleStatus: 'completed' }, /已結案或取消：子案件僅可瀏覽/], [{ lifecycleStatus: 'cancelled' }, /已結案或取消/]]) {
    const u = env({ responder: routes(lifeData({ lifecycleStatus: extra.lifecycleStatus }), schedData()) }); const r2 = await u.open(itemRow(extra)); const e2 = mountItems(u, r2);
    assert(!e2.addBtn() && e2.nameInput().disabled, extra.lifecycleStatus); assert.match(e2.html(), re);
  }
  // legacy (not lifecycle-managed) is unchanged
  const l = env({ responder: routes(lifeData({ mode: 'legacy' }), schedData()) }); const r3 = await l.open(itemRow({ lifecycleMode: null, lifecycleStatus: null })); const e3 = mountItems(l, r3);
  assert(e3.addBtn() && !e3.nameInput().disabled);
});

// ── round 3: another writer (B delivery form) saving the same case re-syncs the D2 reader ──────────────
const outputsAt = (version, current, cumulative) => lifeData({ contentVersion: version, updatedAt: `2026-10-26T0${version - 6}:00:00.000Z`,
  outputs: { currentCycle: { cycleId: 'cycle-0001-aaaa', sequence: 1, summary: { groups: current ? [{ kind: 'main', unit: '件', quantity: current, records: 1 }] : [] }, unattributedRecords: 0, status: current ? 'recorded' : 'none_recorded' },
    cumulative: { status: 'recorded', groups: [{ kind: 'main', unit: '件', quantity: cumulative, records: 2 }] }, legacyCounts: { requestCount: null, outputCount: null } } });
function syncEnv(onPost) {
  const life = { now: outputsAt(7, 0, 2), queue: null };
  const t = env({ responder: call => {
    if (call.method === 'GET' && call.url === '/api/cases/R-1/lifecycle') return life.queue ? life.queue.shift()() : life.now;
    if (call.method === 'GET' && call.url.endsWith('/schedule-requests')) return schedData();
    if (call.method === 'POST' && /\/deliveries$/.test(call.url)) return { record: { id: 'd-new' }, case: { id: 'R-1', updatedAt: life.now.updatedAt, contentVersion: life.now.contentVersion } };
    return onPost ? onPost(call) : { request: { id: call.body && call.body.id }, case: {}, replayed: false };
  } });
  const lifeGets = () => t.calls.filter(x => x.method === 'GET' && x.url === '/api/cases/R-1/lifecycle').length;
  const bSave = async (caseId = 'R-1') => { await t.c.fetchJson('POST', `/api/cases/${caseId}/deliveries`, { id: 'dlv-1', kind: 'main', quantity: 3 }); await flush(); };
  return { t, life, lifeGets, bSave };
}
await test('a successful same-case delivery save re-reads the D2 summary and versions without a manual reload; other cases and older replies never overwrite', async () => {
  const { t, life, lifeGets, bSave } = syncEnv(); await t.open(caseRow());
  assert.match(t.rootEl().innerHTML, /本期尚未登錄/); assert.match(t.rootEl().innerHTML, /主設計 2 件/);
  life.now = outputsAt(8, 3, 5); await bSave();
  const html = t.rootEl().innerHTML;
  assert.match(html, /<dt>本期產出<\/dt><dd>主設計 3 件<\/dd>/); assert.match(html, /<dt>全案累計<\/dt><dd>主設計 5 件<\/dd>/);
  assert(!/摘要與版本已過期/.test(html), 'a quick successful resync shows no stale banner');
  t.btn('申請未完成封存…').click(); await flush(); t.type('reasonCategory', 'requester_change'); t.type('reason', '需求方暫停活動'); t.btn('送出封存申請').click(); await flush();
  const post = t.posts().find(x => x.url === '/api/cases/R-1/lifecycle/requests');
  assert.equal(post.body.expectedContentVersion, 8, 'the D2 write carries the re-read version, not the pre-delivery one');
  // another case's save never touches this drawer
  const before = lifeGets(); await bSave('R-2'); assert.equal(lifeGets(), before);
  // out of order: the older re-read (A) resolving after the newer one (B) is discarded
  const u = syncEnv(); await u.t.open(caseRow());
  let resolveA, resolveB; u.life.queue = [() => new Promise(r => { resolveA = r; }), () => new Promise(r => { resolveB = r; })];
  u.life.now = outputsAt(8, 3, 5); await u.bSave(); u.life.now = outputsAt(9, 4, 6); await u.bSave();
  resolveB(outputsAt(9, 4, 6)); await flush(); resolveA(outputsAt(8, 3, 5)); await flush();
  assert.match(u.t.rootEl().innerHTML, /<dt>本期產出<\/dt><dd>主設計 4 件<\/dd>/, 'newest read wins');
});
await test('with a D2 form open another save only marks the snapshot stale: input kept, sending waits for 重新讀取摘要; an unconfirmed request resends its exact body', async () => {
  const { t, life, bSave } = syncEnv(); await t.open(caseRow());
  t.btn('申請未完成封存…').click(); await flush(); t.type('reasonCategory', 'requester_change'); t.type('reason', '需求方暫停活動');
  life.now = outputsAt(8, 3, 5); await bSave();
  assert.match(t.rootEl().innerHTML, /下方摘要與版本已過期。你的輸入已保留/); assert.match(t.rootEl().innerHTML, /主設計 2 件/, 'form view keeps the snapshot it showed');
  assert.equal(t.fld('reason').value, '需求方暫停活動'); assert.equal(t.btn('送出封存申請').disabled, true);
  assert.equal(t.posts().filter(x => /lifecycle/.test(x.url)).length, 0);
  t.btn('重新讀取摘要').click(); await flush();
  assert.equal(t.fld('reason').value, '需求方暫停活動', 'the form and its input survive the re-read'); assert.match(t.rootEl().innerHTML, /主設計 5 件/);
  t.btn('送出封存申請').click(); await flush();
  assert.equal(t.posts().find(x => x.url === '/api/cases/R-1/lifecycle/requests').body.expectedContentVersion, 8);
  // an already-sent request with an unknown result keeps its exact body (versions are not swapped in)
  let n = 0; const a = syncEnv(call => { if (++n === 1) throw httpError(0, 'network'); return { request: {}, case: {}, replayed: true }; }); await a.t.open(caseRow());
  a.t.btn('申請未完成封存…').click(); await flush(); a.t.type('reasonCategory', 'other'); a.t.type('reason', '需求方暫停活動'); a.t.btn('送出封存申請').click(); await flush();
  a.life.now = outputsAt(8, 3, 5); await a.bSave();
  const again = a.t.btn('重新確認送出'); assert(again && !again.disabled, 'the unconfirmed request can still be confirmed'); again.click(); await flush();
  const sent = a.t.posts().filter(x => x.url === '/api/cases/R-1/lifecycle/requests'); assert.equal(sent.length, 2); assert.deepEqual(sent[1].body, sent[0].body); assert.equal(sent[1].body.expectedContentVersion, 7);
});

await test('Kanban drop on a managed case opens the drawer instead of writing; legacy drops go through', async () => {
  const t = env({ withKanban: true, responder: routes(lifeData(), schedData()) }); t.c.CASES = [caseRow(), { id: 'L-1', status: 'doing', lifecycleMode: 'legacy', scheduleMode: 'legacy' }];
  await t.c.v54KanbanDrop('R-1', 'review'); await flush(); assert.deepEqual(t.kanban, []); assert.equal(t.opened.at(-1), 'R-1');
  await t.c.v54KanbanDrop('L-1', 'review'); assert.deepEqual(plain(t.kanban), [['L-1', 'review']]);
});
await test('release notice: shown once; every close path persists with the session-bound expected actor; failure offers retry; an account switch never writes for the new account', async () => {
  const mk = (failFirst) => {
    const d = dom(); const bar = d.seed('topbar'); bar.className = 'topbar'; const calls = []; let n = 0;
    const c = vm.createContext({ console, Promise, JSON, String, Object, Array, Error, setTimeout, clearTimeout, document: d.document, ME: { id: 2, name: 'Owner', role: 'member' } });
    c.window = c; vm.runInContext('function escapeHtml(s){return String(s).replace(/[&<>"]/g,"")}', c);
    c.fetchJson = async (method, url, body) => { calls.push({ method, url, body: body && plain(body) }); if (method === 'GET') return { staffId: c.ME.id, notices: [{ id: 'qa-synthetic-notice-v2', title: '測試', items: ['一'], dismissed: false }] }; if (failFirst && ++n === 1) throw httpError(0, 'network'); return { dismissed: true }; };
    vm.runInContext(noticePlugin, c); return { c, d, calls };
  };
  const a = mk(false); await a.c.releaseNotices.start(); await flush();
  const dlg = a.d.get('rn-dialog'); assert(dlg); assert.equal(dlg.getAttribute('role'), 'dialog');
  dlg.dispatchEvent({ type: 'keydown', key: 'Escape' }); await flush();
  assert.deepEqual(plain(a.calls.filter(x => x.method === 'POST')), [{ method: 'POST', url: '/api/notices/qa-synthetic-notice-v2/dismiss', body: { expectedStaffId: 2 } }]); assert.equal(a.d.get('rn-dialog'), null);
  const b = mk(true); await b.c.releaseNotices.start(); await flush();
  b.d.get('rn-dialog').querySelectorAll('button').find(x => x.textContent === '知道了').click(); await flush();
  assert.match(b.d.get('rn-dialog').querySelector('.rn-msg').textContent, /尚未儲存到伺服器/); b.d.get('rn-dialog').querySelectorAll('button').find(x => x.textContent === '重試儲存').click(); await flush();
  assert.equal(b.d.get('rn-dialog'), null); assert.equal(b.calls.filter(x => x.method === 'POST').length, 2);
  const s = mk(false); await s.c.releaseNotices.start(); await flush(); s.c.ME = { id: 9, name: 'Other', role: 'member' };
  s.d.get('rn-dialog').querySelectorAll('button').find(x => x.textContent === '知道了').click(); await flush();
  assert.equal(s.calls.filter(x => x.method === 'POST').length, 0, 'old dialog never writes for the new account'); assert.equal(s.d.get('rn-dialog'), null);
});
// ── round 3: admin role / view-as switching (the real menu, legacy delegated listener and nav from index.html) ──
// Browser click semantics: the bubble path is fixed before handlers run, so the parent listener still receives a
// click whose button the menu just rebuilt (detached).
const browserClick = el => { const path = []; for (let n = el; n; n = n.parentNode) path.push(n); const ev = { type: 'click', target: el, preventDefault() {}, stopPropagation() { ev.stopped = true; } };
  for (const n of path) { if (ev.stopped) break; if (n.onclick) n.onclick(ev); for (const fn of (n.events && n.events.click) || []) fn(ev); } };
function roleEnv() {
  const d = dom(); d.seed('nav'); const rs = d.seed('role-switch'); rs.className = 'role-switch'; rs.innerHTML = '<button data-role="designer" class="active">設計師</button><button data-role="admin">管理員</button>';
  const me = { id: 1, name: 'Admin', role: 'admin' };
  const c = vm.createContext({ console, document: d.document, Object, Array, String, Number, JSON, STAFF: [{ id: 1, name: 'Admin', role: 'admin', active: true }, { id: 2, name: 'Owner', role: 'member', active: true }, { id: 6, name: 'Obs', role: 'observer', active: true }],
    showToast: () => {} });
  c.window = c;
  vm.runInContext(section('function escapeHtml(s)', '\n}\n') + '\n}\n' + `let ME = ${JSON.stringify(me)};\nlet currentRole = 'admin', currentView = 'dashboard';\n`
    + section('function v20SameId(a, b)', 'function v20IsMine') + section('const NAV_DEF = {', 'function switchView(v) {')
    + 'function switchView(v) { currentView = v; renderNav(); }\n'
    + section("const roleSwitchEl = document.getElementById('role-switch');", '// ═══') + section('let v36ViewAsName = null;', '// Override ME_NAME')
    + '\nthis.__s = () => ({ role: currentRole, view: currentView, viewAs: v36ViewAsName, me: JSON.parse(JSON.stringify(ME)), viewerId: v20ViewerId(), nav: document.getElementById("nav").children.map(b => b.textContent) });', c);
  vm.runInContext('v36BuildUserMenu(); renderNav();', c);
  const btn = text => d.get('role-switch').children.find(b => b.tagName === 'BUTTON' && b.textContent === text);
  return { c, d, btn, state: () => plain(c.__s()), navOf: role => plain(vm.runInContext(`NAV_DEF[${JSON.stringify(role)}].map(i => i.label)`, c)) };
}
await test('admin view switching: 👁 觀察者 shows only overview + calendar; returning to admin restores the nav; member preview never replaces the session identity', async () => {
  const r = roleEnv(); const adminNav = r.navOf('admin'); assert(adminNav.length > 2); assert.deepEqual(r.state().nav, adminNav);
  browserClick(r.btn('👁 觀察者'));
  let st = r.state(); assert.equal(st.role, 'observer', 'the parent listener must not overwrite the role with undefined'); assert.deepEqual(st.nav, ['總覽', '📅 行事曆']);
  assert(r.d.document.body.classList.contains('observer-mode'));
  browserClick(r.btn('Admin (Admin)'));
  st = r.state(); assert.equal(st.role, 'admin'); assert.deepEqual(st.nav, adminNav); assert(!r.d.document.body.classList.contains('observer-mode'));
  const sel = r.d.get('role-switch').children.find(x => x.tagName === 'SELECT'); sel.value = 'Owner'; sel.onchange(); browserClick(sel);
  st = r.state(); assert.equal(st.role, 'designer'); assert.equal(st.viewAs, 'Owner'); assert.deepEqual(st.nav, r.navOf('designer'));
  assert.deepEqual(st.me, { id: 1, name: 'Admin', role: 'admin' }, 'the session identity is unchanged by a preview'); assert.equal(st.viewerId, 2, 'only the display viewer follows the preview');
  // write permissions are decided by the signed-in id, never the previewed name
  assert.match(section('function v43InjectSubItemsPanel(c, body)', 'const panel = document.createElement'), /const isPrimary = v20IsPrimary\(c, ME\.id\);[^\n]*\n\s*const isCollab = v20IsCollab\(c, ME\.id\);/);
  assert.equal(vm.runInContext('v20IsPrimary({ _designerId: 2 }, ME.id)', r.c), false); assert.equal(vm.runInContext('v20IsPrimary({ _designerId: 2 })', r.c), true);
  // a stray button without a valid data-role (or an unknown role) changes nothing
  browserClick(r.btn('Admin (Admin)')); const stray = r.d.element('button'); stray.textContent = 'x'; r.d.get('role-switch').appendChild(stray); browserClick(stray);
  const bogus = r.d.element('button'); bogus.setAttribute('data-role', 'superuser'); r.d.get('role-switch').appendChild(bogus); browserClick(bogus);
  st = r.state(); assert.equal(st.role, 'admin'); assert.deepEqual(st.nav, adminNav);
});

// ── notices API: whitelist, publication switch, session identity, idempotent dismissal ──
const require = createRequire(root + '/package.json');
const express = require('express'), cookieParser = require('cookie-parser');
process.env.JWT_SECRET = 'isolated-notice-tests-secret'; process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:1/never_connect';
const { prisma } = await import(root + '/src/lib/db.js');
const { signToken } = await import(root + '/src/middleware/auth.js');
const staff = new Map([[2, { id: 2, name: 'Owner', role: 'member', active: true, pendingActivation: false, sessionVersion: 0 }], [3, { id: 3, name: 'Other', role: 'member', active: true, pendingActivation: false, sessionVersion: 0 }],
  [6, { id: 6, name: 'Observer', role: 'observer', active: true, pendingActivation: false, sessionVersion: 0 }], [7, { id: 7, name: 'Observer2', role: 'observer', active: true, pendingActivation: false, sessionVersion: 0 }]]);
let rows = [];
prisma.staff.findUnique = async ({ where }) => staff.get(where.id) ?? null;
prisma.memberNoticeDismissal.findMany = async ({ where }) => rows.filter(r => r.staffId === where.staffId && where.noticeId.in.includes(r.noticeId));
prisma.memberNoticeDismissal.create = async ({ data }) => { if (rows.some(r => r.staffId === data.staffId && r.noticeId === data.noticeId)) throw Object.assign(Error('dup'), { code: 'P2002' }); const r = { ...data, dismissedAt: new Date() }; rows.push(r); return r; };
prisma.memberNoticeDismissal.findUnique = async ({ where }) => rows.find(r => r.staffId === where.staffId_noticeId.staffId && r.noticeId === where.staffId_noticeId.noticeId) ?? null;
const app = express(); app.use(express.json(), cookieParser()); app.use('/api/notices', (await import(root + '/src/routes/notices.js')).default);
// a business write behind the same real requireAuth, to prove the observer exemption does not widen anything else
const { requireAuth } = await import(root + '/src/middleware/auth.js');
let businessWrites = 0; app.post('/api/cases/:id/logs', requireAuth, (req, res) => { businessWrites++; res.json({ ok: true }); });
function call(path, method = 'GET', body, as = 2) {
  return new Promise((resolve, reject) => {
    const socket = new Duplex({ read() {}, write(_b, _e, done) { done(); } });
    const req = new http.IncomingMessage(socket); req.url = path.startsWith('/api/') ? path : '/api/notices' + path; req.method = method;
    req.headers = { cookie: 'designpm_token=' + signToken(staff.get(as)), 'content-type': 'application/json' }; req.body = body ?? {};
    const res = new http.ServerResponse(req); res.end = data => { resolve({ status: res.statusCode, data: JSON.parse(String(data)) }); socket.destroy(); return res; };
    app.handle(req, res, e => reject(e || Error('unhandled')));
  });
}
await test('notices API: nothing published by default; only whitelisted fields of published notices; per-account idempotent dismissal; expected actor precondition; unknown id 404', async () => {
  delete process.env.RELEASE_NOTICES_PUBLISHED; assert.deepEqual((await call('/')).data.notices, []);
  process.env.RELEASE_NOTICES_PUBLISHED = 'qa-synthetic-notice-v1,qa-synthetic-notice-v2';
  const g = await call('/'); assert.deepEqual(g.data.notices.map(n => Object.keys(n).sort()), [['dismissed', 'dismissedAt', 'id', 'items', 'title'], ['dismissed', 'dismissedAt', 'id', 'items', 'title']]);
  assert.equal(g.data.staffId, 2); assert(!JSON.stringify(g.data).includes('member-2026-10-schedule-lifecycle'), 'unpublished draft never sent');
  assert.equal((await call('/qa-synthetic-notice-v1/dismiss', 'POST', { expectedStaffId: 3 })).status, 409, 'old-tab actor precondition');
  assert.equal((await call('/qa-synthetic-notice-v1/dismiss', 'POST', { expectedStaffId: 2, staffId: 3 })).status, 200);
  assert.equal((await call('/qa-synthetic-notice-v1/dismiss', 'POST', {})).status, 200, 'repeat is idempotent'); assert.equal(rows.length, 1); assert.equal(rows[0].staffId, 2, 'session identity, body ignored');
  assert.deepEqual((await call('/')).data.pending, ['qa-synthetic-notice-v2'], 'a new version is still pending');
  assert.deepEqual((await call('/', 'GET', undefined, 3)).data.pending, ['qa-synthetic-notice-v1', 'qa-synthetic-notice-v2'], 'other accounts unaffected');
  assert.equal((await call('/member-2026-10-schedule-lifecycle/dismiss', 'POST', {})).status, 404, 'unpublished cannot be dismissed');
  delete process.env.RELEASE_NOTICES_PUBLISHED;
});
await test('observer (real requireAuth + notices router): may persist only their own dismissal at the exact path; actor precondition kept; every other observer write stays 403', async () => {
  rows = []; businessWrites = 0; process.env.RELEASE_NOTICES_PUBLISHED = 'qa-synthetic-notice-v1';
  const ok = await call('/qa-synthetic-notice-v1/dismiss', 'POST', { expectedStaffId: 6, staffId: 2 }, 6);
  assert.equal(ok.status, 200, 'observer closes their own notice'); assert.deepEqual(rows.map(r => [r.staffId, r.noticeId]), [[6, 'qa-synthetic-notice-v1']], 'written for the session observer only');
  assert.deepEqual((await call('/', 'GET', undefined, 6)).data.pending, []); assert.deepEqual((await call('/', 'GET', undefined, 7)).data.pending, ['qa-synthetic-notice-v1'], 'another observer unaffected');
  assert.equal((await call('/qa-synthetic-notice-v1/dismiss', 'POST', { expectedStaffId: 7 }, 6)).status, 409, 'expected-actor precondition still applies');
  assert.equal((await call('/qa-synthetic-notice-v1/dismiss?x=1', 'POST', { expectedStaffId: 6 }, 6)).status, 200, 'query string does not change the path');
  for (const [path, method] of [['/qa-synthetic-notice-v1/dismiss/extra', 'POST'], ['/qa-synthetic-notice-v1/dismiss', 'PUT'], ['/qa-synthetic-notice-v1/dismiss', 'DELETE'], ['/', 'POST'], ['/x/dismiss', 'POST'], ['/api/cases/R-1/logs', 'POST']]) {
    const r = await call(path, method, { expectedStaffId: 6 }, 6); assert.equal(r.status, 403, `${method} ${path}`); assert.equal(r.data.error, 'read_only');
  }
  assert.equal(businessWrites, 0); assert.equal(rows.length, 1);
  assert.equal((await call('/api/cases/R-1/logs', 'POST', {}, 2)).status, 200, 'members are unaffected'); 
  delete process.env.RELEASE_NOTICES_PUBLISHED;
});
console.log(JSON.stringify({ passed, failed, browserAutomation: false, liveNetwork: false, productionWrites: 0 }));
if (failed) process.exitCode = 1;
