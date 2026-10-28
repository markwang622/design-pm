// REPORTS-P3-E2: the actual public/work-reports.js (manager work-report page) in the inert DOM scaffold reused from
// tests/caseDeliveriesUiSafety.mjs. Payloads are built by the accepted E1b pure builder (src/lib/workReportPayload.js) from
// SYNTHETIC C/K projections; envelopes follow the E1b API shapes. No network, database, browser or mail.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto, { webcrypto } from 'node:crypto';
process.env.TZ = 'Asia/Taipei';
const root = process.env.DESIGN_PM_ROOT || decodeURIComponent(new URL('../', import.meta.url).pathname);
const plugin = fs.readFileSync(root + '/public/work-reports.js', 'utf8');
const css = fs.readFileSync(root + '/public/work-reports.css', 'utf8');
const index = fs.readFileSync(root + '/public/index.html', 'utf8');
const bTest = fs.readFileSync(root + '/tests/caseDeliveriesUiSafety.mjs', 'utf8');
function section(start, end, text) { const a = text.indexOf(start), b = text.indexOf(end, a + start.length); assert(a >= 0 && b > a, 'source section exists: ' + start); return text.slice(a, b); }
const { dom } = new Function(section('const decode=', '\nconst helpers', bTest) + '\nreturn { dom };')();
const P = await import(root + '/src/lib/workReportPayload.js');
const RP = await import(root + '/src/lib/reportPeriods.js');
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const httpError = (status, error, message, extra = {}) => Object.assign(new Error(message || error), { status, data: { error, message }, ...extra });
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };

// ── synthetic sources → real E1b payloads ─────────────────────────────────────────────────────────────────
const TABLES = ['cases', '_collaborators', 'case_deliveries', 'case_cycles', 'case_lifecycle_requests', 'case_schedule_requests', 'case_delivery_submissions', 'staff', 'hotels', 'change_logs'];
function state(parts, coverageStart = '2026-01-01T00:00:00.000000Z') {
  const tables = Object.fromEntries(TABLES.map(t => [t, {}]));
  for (const [t, rows] of Object.entries(parts)) for (const r of rows) tables[t][t === '_collaborators' ? r.caseId + ':' + r.staffId : String(r.id)] = r;
  return { status: 'ok', coverageStart, maxEventId: '10', tables };
}
const staff = [{ id: 1, name: '王一', role: 'member', active: true, departedOn: null }, { id: 2, name: '陳二', role: 'member', active: false, departedOn: '2026-10-20' }, { id: 3, name: '林三', role: 'member', active: true, departedOn: null }];
const hotels = [{ id: 1, region: '集團', name: '集團本部', sortOrder: 10, active: true }, { id: 5, region: '宜蘭', name: '礁溪館', sortOrder: 20, active: false }, { id: 3, region: '新竹', name: '新竹館', sortOrder: 20, active: true }];
const kase = (id, extra = {}) => ({ id, title: 'Case ' + id, subTitle: null, hotel: '集團本部', level: 'A', status: 'doing', urgent: false, openDate: '2026-10-01', dispatchDate: '2026-10-02', copyDate: null,
  printDate: null, goLiveDate: '2026-11-30', closedOn: null, cancelledOn: null, archived: false, designerId: 1, deliveryMode: 'records', scheduleMode: 'legacy', scheduleBaseline: null, lifecycleMode: 'legacy',
  lifecycleStatus: null, requestCount: null, outputCount: null, items: null, logs: null, ...extra });
const dlv = (id, caseId, kind, quantity, deliveredOn, extra = {}) => ({ id, caseId, itemKey: null, itemName: '品項' + id, kind, quantity, unit: '件', deliveredOn, note: null, recordedById: 1,
  recordedByName: '王一', cycleId: null, voidedAt: null, voidReason: null, ...extra });
const week = RP.periodFromStart('week', '2026-10-19'), wi = RP.periodInstants(week);
function payloadOf({ coverage = '2026-01-01T00:00:00.000000Z', insufficient = false, revision = 1 } = {}) {
  if (insufficient) return P.buildWorkReportPayload({ period: week, cutoff: wi.cutoffInstant, knowledgeCutoff: wi.cutoffInstant, observedAt: wi.cutoffInstant, coverageStart: '2026-10-27T00:00:00.000000Z',
    revision, supersedesId: revision > 1 ? 'wr_p' : null, revisionReason: revision > 1 ? '補登' : null, trigger: 'manual', endState: { status: 'insufficient', coverageStart: '2026-10-27T00:00:00.000000Z', tables: null }, knowledge: null });
  const sub = { id: 'sub-1', caseId: 'X', decision: 'approved', decidedAt: '2026-10-23T01:00:00', decidedByName: '主管九', recordIds: ['D3'], zeroSupportApproved: true };
  const parts = { staff, hotels, cases: [
    kase('X', { hotel: '新竹館', logs: [{ id: 'log-x-0001', date: '2026-10-21', note: '=SUM(A1) 初稿' }], scheduleBaseline: { dispatchDate: '2026-10-02', goLiveDate: '2026-11-20', observedAt: '2026-10-05T01:00:00Z' } }),
    kase('Y', { hotel: null, title: '無館別, "引號"\n換行', designerId: 2 }), kase('Z', { hotel: '不存在館', deliveryMode: 'legacy', outputCount: 7, title: '=HYPERLINK("http://x","y")' }),
    kase('U', { deliveryMode: 'legacy', status: 'done', closedOn: null })],
    _collaborators: [{ caseId: 'X', staffId: 3 }],
    case_deliveries: [dlv('D1', 'X', 'main', 2, '2026-10-20'), dlv('D2', 'X', 'extension', 3, '2026-10-21'), dlv('D3', 'X', 'support', 0, '2026-10-22', { note: '@僅提供既有檔案' }), dlv('D4', 'Y', 'main', 1, '2026-10-22', { unit: '式' })],
    case_delivery_submissions: [sub] };
  return P.buildWorkReportPayload({ period: week, cutoff: wi.cutoffInstant, knowledgeCutoff: wi.cutoffInstant, observedAt: wi.cutoffInstant, coverageStart: coverage, revision,
    supersedesId: revision > 1 ? 'wr_p' : null, revisionReason: revision > 1 ? '補登' : null, trigger: 'manual', generatedBy: { id: 9, name: '主管九' }, endState: state(parts, coverage), knowledge: state(parts, coverage) });
}
const meta = (id, payload, extra = {}) => ({ id, periodKind: 'week', startDate: week.startDate, endDateExclusive: week.endDateExclusive, label: week.label, cutoffInstant: wi.cutoffInstant,
  knowledgeCutoff: payload.meta.knowledgeCutoff, observedAt: payload.meta.observedAt, generatedAt: '2026-10-27T02:00:00.123456Z', coverageStart: payload.meta.coverageStart, rulesVersion: P.RULES_VERSION,
  revision: payload.meta.revision, supersedesId: payload.meta.supersedesId, revisionReason: payload.meta.revisionReason, generatedById: 9, generatedByName: '主管九', trigger: 'manual',
  payloadSha256: P.payloadSha256(payload), sourceCompleteness: payload.sourceCompleteness.status, ...extra });
const full = payloadOf({ revision: 2 }), partial = payloadOf({ coverage: '2026-10-21T00:00:00.000000Z' }), thin = payloadOf({ insufficient: true });
const V1 = meta('wr_00000000-0000-4000-8000-000000000001', partial, { generatedAt: '2026-10-26T01:00:00.000000Z' });
const V2 = meta('wr_00000000-0000-4000-8000-000000000002', full);
const VI = { ...meta('wr_00000000-0000-4000-8000-00000000000a', thin), startDate: '2026-10-12', endDateExclusive: '2026-10-19', label: '2026-W42' };
const payloads = { [V1.id]: partial, [V2.id]: full, [VI.id]: thin };
const envOf = id => ({ snapshot: Object.values({ V1, V2, VI }).find(v => v.id === id), payloadSha256: P.payloadSha256(payloads[id]), payload: payloads[id] });
function viewOf(id, filter) {
  const v = P.filterPayload(payloads[id], filter);
  return { snapshot: envOf(id).snapshot, payloadSha256: P.payloadSha256(payloads[id]), view: { filter: v.filter, derivedFrom: { snapshotId: id, payloadSha256: P.payloadSha256(payloads[id]) }, viewSha256: P.payloadSha256(v), payload: v } };
}
const periodsResp = (extra = {}) => ({ kind: 'week', rulesVersion: P.RULES_VERSION, periods: [
  { kind: 'week', startDate: '2026-10-12', endDateExclusive: '2026-10-19', label: '2026-W42', ended: true, versions: [VI] },
  { kind: 'week', startDate: '2026-10-19', endDateExclusive: '2026-10-26', label: '2026-W43', ended: true, versions: [V1, V2] },
  { kind: 'week', startDate: '2026-10-26', endDateExclusive: '2026-11-02', label: '2026-W44', ended: false, versions: [] }, ...(extra.more || [])] });

// RFC 4180 reader for assertions (quoted fields may hold commas, quotes, CR/LF)
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; continue; }
    if (ch === '"') q = true; else if (ch === ',') { row.push(f); f = ''; } else if (ch === '\r' && text[i + 1] === '\n') { row.push(f); rows.push(row); row = []; f = ''; i++; } else f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
// ── inert page + real module ──────────────────────────────────────────────────────────────────────────
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); promise.catch(() => {}); return { promise, resolve, reject }; }
function page({ me = { id: 9, name: '主管九', role: 'admin' }, role = 'admin', viewAs = null, routes } = {}) {
  const d = dom(), calls = [], toasts = [], opened = [], downloads = [], navRenders = [];
  const main = d.seed('main-area'); main.className = 'main';
  const nav = d.seed('nav');
  const c = vm.createContext({ console, Date, Intl, Set, Map, Promise, JSON, Math, Number, String, Object, Array, Error, RegExp, URLSearchParams, Uint8Array, crypto: webcrypto,
    setTimeout, clearTimeout, document: d.document, ME: me, currentRole: role, currentView: 'dashboard', v36ViewAsName: viewAs, CASES: [{ id: 'X', name: 'Case X (live)' }],
    NAV_DEF: { admin: [{ key: 'dashboard', label: '總覽' }], designer: [{ key: 'personal', label: '我的任務' }], observer: [{ key: 'dashboard', label: '總覽' }] },
    showToast: (m, t) => toasts.push({ m, t }), openDrawer: row => opened.push(row.id),
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts?.type; } },
    URL: { createObjectURL: b => { downloads.push(b); return 'blob:fixture'; }, revokeObjectURL() {} } });
  c.window = c; c.globalThis = c;
  c.renderNav = () => { navRenders.push(c.currentRole); nav.innerHTML = c.NAV_DEF[c.currentRole].map(n => `<button data-view="${n.key}">${n.label}</button>`).join(''); };
  c.switchView = function (v) { c.currentView = v; d.document.querySelectorAll('.view').forEach(x => x.classList.toggle('active', x.dataset.view === v)); c.renderNav(); };
  c.fetchJson = async (method, url, body) => { const call = { method, url, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) }; calls.push(call); return routes(call); };
  vm.runInContext(plugin, c);
  const view = () => d.document.querySelector('div.view[data-view="work-reports"]');
  const q = sel => view()?.querySelector(sel);
  const act = (name, extra = '') => q(`[data-act="${name}"]${extra}`);
  const field = (name, value) => { const el = q(`[data-field="${name}"]`); el.value = value; el.dispatchEvent({ type: name === 'reason' ? 'input' : 'change' }); };
  const text = () => view()?.textContent || '';
  return { c, d, calls, toasts, opened, downloads, navRenders, view, q, act, field, text, gets: () => calls.filter(x => x.method === 'GET' && !x.url.startsWith(SCHED_URL)), scheds: () => calls.filter(x => x.url === SCHED_URL), posts: () => calls.filter(x => x.method === 'POST'),
    go: async () => { c.switchView('work-reports'); await flush(); } };
}
// REPORTS-P3-E3: read-only scheduler status (its own generation; not a report read). Default fixture: disabled.
const SCHED_URL = '/api/work-reports/scheduler/status';
const schedOff = { enabled: false, configuredStartDate: null, now: '2026-10-28T02:00:00.000000Z', rulesVersion: P.RULES_VERSION, initialized: false, state: null, next: [], counts: {}, recent: [] };
const baseRoutes = (extra = () => undefined) => call => {
  const r = extra(call); if (r !== undefined) return r;
  if (call.method === 'GET' && call.url === SCHED_URL) return schedOff;
  if (call.method === 'GET' && call.url.startsWith('/api/work-reports/periods?')) return periodsResp();
  if (call.method === 'GET' && /^\/api\/work-reports\?kind=week&start=/.test(call.url)) return { period: {}, versions: periodsResp().periods.find(p => call.url.includes(p.startDate)).versions };
  const m = call.url.match(/^\/api\/work-reports\/(wr_[0-9a-f-]+)(\?(.*))?$/);
  if (call.method === 'GET' && m) {
    if (!m[3]) return envOf(m[1]);
    const qs = new URLSearchParams(m[3]); return viewOf(m[1], { hotel: qs.get('hotel') || undefined, staffId: qs.get('staffId') ? Number(qs.get('staffId')) : undefined });
  }
  throw httpError(404, 'not_found', 'no route ' + call.url);
};

await test('nav registers once, appears only for a real admin in admin view, and a late module fills the nav without re-bootstrapping', async () => {
  const p = page({ routes: baseRoutes() });
  assert.deepEqual(p.c.NAV_DEF.admin.map(n => n.key), ['dashboard', 'work-reports']); assert.equal(p.c.NAV_DEF.designer.length, 1);
  assert.equal(p.navRenders.length, 1, 'module loaded after auth re-renders the nav once');
  vm.runInContext(plugin, p.c); assert.equal(p.c.NAV_DEF.admin.filter(n => n.key === 'work-reports').length, 1, 'second load is a no-op');
  assert.equal(p.calls.length, 0, 'loading the module never calls the reports API');
  const before = page({ me: { id: 0, name: '', role: 'member' }, role: 'designer', routes: baseRoutes() });
  assert.equal(before.navRenders.length, 0, 'not logged in yet: bootstrap renders the nav later');
  await p.go();
  assert.equal(p.d.document.querySelectorAll('div.view[data-view="work-reports"]').length, 1); assert(p.view().classList.contains('active'));
  assert.equal(p.c.currentView, 'work-reports'); assert.equal(p.d.document.querySelector('#nav [data-view="work-reports"]').tagName, 'BUTTON', 'nav button is not the view');
});

await test('direct entry is blocked for a real member, an observer, admin view-as and admin observer preview — no request, no manager DOM', async () => {
  for (const [label, opts] of [['member', { me: { id: 2, name: '陳二', role: 'member' }, role: 'designer' }], ['observer', { me: { id: 4, name: '觀', role: 'observer' }, role: 'observer' }],
    ['view-as', { role: 'designer', viewAs: '王一' }], ['observer preview', { role: 'observer' }], ['view-as name with admin role', { role: 'admin', viewAs: '王一' }]]) {
    const p = page({ ...opts, routes: baseRoutes() });
    p.c.switchView('work-reports'); await flush();
    assert.equal(p.calls.length, 0, label); assert.notEqual(p.c.currentView, 'work-reports', label);
    assert(!p.view() || p.view().textContent === '', label); assert(p.toasts.length >= 1, label);
  }
  // an admin page whose viewer flips to preview: every handler re-checks before acting
  const p = page({ routes: baseRoutes() }); await p.go(); assert(p.text().includes('2026-W43'));
  const n = p.calls.length; p.c.currentRole = 'observer'; p.act('refresh').click(); await flush();
  assert.equal(p.calls.length, n, 'no new request after the preview switch'); assert.equal(p.view().textContent, '', 'manager data cleared');
  const q = page({ routes: baseRoutes() }); await q.go(); q.d.document.body.classList.add('observer-mode'); q.act('generate')?.click(); q.act('revise-open')?.click(); await flush();
  assert.equal(q.posts().length, 0); assert.equal(q.view().textContent, '');
});

await test('default = latest ended week and its latest version; in-progress period can be viewed but generating is disabled with a reason', async () => {
  const p = page({ routes: baseRoutes() }); await p.go();
  assert.match(p.gets()[0].url, /^\/api\/work-reports\/periods\?kind=week&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
  assert.equal(p.q('[data-field="period"]').value, '2026-10-19'); assert.equal(p.q('[data-field="version"]').value, V2.id);
  assert.equal(p.gets()[1].url, '/api/work-reports/' + V2.id);
  assert(p.act('revise-open') && !p.act('generate'), 'a period with versions offers a revision');
  p.field('period', '2026-10-26'); await flush();
  const gen = p.act('generate'); assert(gen.disabled); assert(p.text().includes('期間尚未結束'));
  assert(p.text().includes('這個期間尚未結束，結束後才能產生報告。'));
});

await test('insufficient snapshot: explicit "source data insufficient", every number unknown, no bars, CSV keeps unknown (never 0)', async () => {
  const p = page({ routes: baseRoutes() }); await p.go();
  p.field('period', '2026-10-12'); await flush();
  const t = p.text();
  assert(t.includes('期末來源資料不足') && t.includes('不代表這期沒有工作')); assert(t.includes('不繪製圖表（不是零產出）'));
  assert.equal(p.view().querySelectorAll('.wr-bars').length, 0); assert.equal(p.view().querySelectorAll('.wr-card strong').map(x => x.textContent).join(','), '—,—');
  assert(p.q('[data-field="hotel"]').disabled && p.q('[data-field="staff"]').disabled, 'no filtering of an empty reconstruction');
  p.act('csv').click(); const csv = p.downloads[0].parts[0];
  assert(csv.startsWith('﻿')); assert(csv.includes('列入案件,,,資料不足')); assert(!/列入案件,0/.test(csv)); assert(csv.includes('期末來源資料不足'));
});

await test('complete / partial display: total vs known subtotal, kinds and units apart, hotelOrder groups (inactive, unmatched, none) and unresolved kept', async () => {
  const p = page({ routes: baseRoutes() }); await p.go();
  const cards = p.view().querySelectorAll('.wr-card').map(x => x.textContent);
  assert(cards.some(x => x.startsWith('列入案件3')) && cards.some(x => x.includes('本期 主設計（件）2已知部分')), cards.join('|'));
  assert(cards.some(x => x.includes('本期 主設計（式）1')) && cards.some(x => x.includes('本期 支援（件）0')), 'unit 式 never merged into 件; support 0 kept');
  const bars = p.view().querySelectorAll('.wr-bars')[0].querySelectorAll('li').map(li => li.textContent);
  assert.deepEqual(bars.map(b => b.replace(/\s+/g, '')), ['主設計（件）2已知部分', '主設計（式）1已知部分', '延伸（件）3已知部分', '支援（件）0已知部分']);
  const barLis = p.view().querySelectorAll('.wr-bars')[0].querySelectorAll('li');
  assert.deepEqual(barLis.map(li => li.querySelectorAll('.wr-bar').length), [1, 1, 1, 0], 'zero draws no bar; positive values keep a visible bar');
  assert(barLis.slice(0, 3).every(li => /width:(\d+)%/.test(li.querySelector('.wr-bar').getAttribute('style')) && Number(li.querySelector('.wr-bar').getAttribute('style').match(/width:(\d+)%/)[1]) >= 2));
  const groupLabels = () => p.view().querySelectorAll('tr.wr-group').map(x => x.textContent.replace(/\s+/g, ' ').replace(/\s*·\s*\d+ 件\s*$/, '').trim());
  const groups = groupLabels();
  assert.deepEqual(groups, ['新竹館', '不存在館 （未對應館名，保留原值）', '（未填館別）'], groups.join('|'));
  assert(p.text().includes('本期沒有列入案件的館別：集團本部、礁溪館（停用）'));
  assert(p.text().includes('未能確認期間在辦的案件（1 件') && p.text().includes('舊制案件缺結束日期'));
  // sorting never reorders hotel groups
  p.act('sort', '[data-key="id"]').click(); await flush();
  assert.equal(p.q('th[aria-sort="descending"]').textContent.trim().startsWith('案件'), true);
  assert.deepEqual(groupLabels(), groups);
  // detail: zero-support reason + approval, adoption-observed wording, open current case labelled as current
  p.act('expand', '[data-id="X"]').click(); await flush();
  const det = p.q('.wr-detail').textContent;
  assert(det.includes('支援 0：@僅提供既有檔案；主管已核可')); assert(det.includes('導入時觀測') && det.includes('不是歷史原始承諾'));
  assert(p.act('expand', '[data-id="X"]').getAttribute('aria-expanded') === 'true');
  p.act('open-case', '[data-id="X"]').click(); assert.deepEqual(p.opened, ['X']); assert(det.includes('查看目前案件'));
  p.act('expand', '[data-id="Y"]').click(); await flush(); p.act('open-case', '[data-id="Y"]').click(); await flush();
  assert(p.text().includes('目前案件清單找不到 Y') && p.text().includes('報告內容照原樣保存'));
});

await test('filter: staff filter requests the view envelope, shows both hashes, labels "participating cases", CSV carries the view rows and metadata', async () => {
  const p = page({ routes: baseRoutes() }); await p.go();
  const staffLabel = p.q('[data-field="staff"]').closest('label').textContent; assert(staffLabel.includes('參與案件（期末指派：主責或協作）'));
  assert(p.q('[data-field="staff"]').textContent.includes('陳二（已停用）'));
  p.field('staff', '3'); await flush();
  assert.equal(p.gets().at(-1).url, `/api/work-reports/${V2.id}?staffId=3`);
  const env = viewOf(V2.id, { staffId: 3 });
  assert(p.text().includes('原版本 ' + env.payloadSha256.slice(0, 12)) && p.text().includes('篩選檢視 ' + env.view.viewSha256.slice(0, 12)));
  assert(p.text().includes('人員篩選為參與案件，不是個人產出分攤'));
  assert.deepEqual(p.view().querySelectorAll('tr.wr-row-case .wr-id').map(x => x.textContent), ['X']);
  p.act('csv').click(); const csv = p.downloads[0].parts[0];
  assert(csv.includes(env.view.viewSha256) && csv.includes(env.payloadSha256) && csv.includes('參與案件（期末指派）：林三'));
  assert.equal(csv.split('\r\n').filter(l => /^新竹館,|^"?（未填館別）/.test(l)).length, 1, 'only the filtered rows');
  assert.equal(p.downloads[0].type, 'text/csv;charset=utf-8');
});

await test('late replies: A→B quick switch, late A success / late A failure / late A after leaving the page never overwrite B or release its loader', async () => {
  const gates = {};
  const p = page({ routes: baseRoutes(call => { const m = call.url.match(/(wr_[0-9a-f-]+)$/); if (call.method === 'GET' && m && gates[m[1]]) return gates[m[1]].promise; }) });
  await p.go(); assert(p.text().includes('2026-W43'));
  gates[V1.id] = deferred(); gates[VI.id] = deferred();
  p.field('version', V1.id); await flush(); assert(p.text().includes('載入報告中'));
  assert(p.act('csv').disabled, 'no export while the selection is loading');
  p.field('period', '2026-10-12'); await flush();
  gates[V1.id].resolve(envOf(V1.id)); await flush();
  assert(p.text().includes('載入報告中') && !p.text().includes('部分可重建'), 'late A success ignored, B loader still on');
  gates[VI.id].resolve(envOf(VI.id)); await flush(); assert(p.text().includes('期末來源資料不足'));
  // late failure
  gates[V2.id] = deferred(); p.field('period', '2026-10-19'); await flush();
  p.field('period', '2026-10-12'); await flush();
  gates[V2.id].reject(httpError(500, 'server_error')); await flush();
  assert(!p.view().querySelector('.wr-error') && p.text().includes('期末來源資料不足'), 'late A failure ignored');
  // leave the page, then A answers
  const g3 = deferred(); gates[V2.id] = g3; p.field('period', '2026-10-19'); await flush();
  p.c.switchView('dashboard'); await flush(); assert.equal(p.view().textContent, '', 'leaving clears manager data');
  g3.resolve(envOf(V2.id)); await flush(); assert.equal(p.view().textContent, '', 'late success after leaving does not render');
  // a failing load shows a retry that re-runs the same selection
  const q = page({ routes: baseRoutes(call => call.url === '/api/work-reports/' + V2.id && !q.c.__ok ? Promise.reject(httpError(0, 'timeout', 'x', { timeout: true })) : undefined) });
  await q.go(); assert(q.text().includes('讀取逾時')); q.c.__ok = true; q.act('retry-load').click(); await flush(); assert(q.text().includes('列入案件'));
});

await test('generate: stable key, no double submit, unknown result retried with the identical body+key, success re-reads versions and selects the new id', async () => {
  const NEW = meta('wr_00000000-0000-4000-8000-0000000000f1', thin, { startDate: '2026-10-05', endDateExclusive: '2026-10-12', label: '2026-W41' });
  let mode = 'timeout', versions = [];
  const more = [{ kind: 'week', startDate: '2026-10-05', endDateExclusive: '2026-10-12', label: '2026-W41', ended: true, versions: [] }];
  const p = page({ routes: baseRoutes(call => {
    if (call.url.startsWith('/api/work-reports/periods?')) { const r = periodsResp(); r.periods.unshift(...more.map(x => ({ ...x, versions: [...x.versions] }))); return r; }
    if (call.url === '/api/work-reports?kind=week&start=2026-10-05') return { versions };
    if (call.url === '/api/work-reports/' + NEW.id) return { snapshot: NEW, payloadSha256: P.payloadSha256(thin), payload: thin };
    if (call.method === 'POST') {
      if (mode === 'timeout') return Promise.reject(httpError(0, 'timeout', '請求逾時', { timeout: true }));
      if (mode === 'exists') return Promise.reject(httpError(409, 'report_exists', '此期間已有初版報告'));
      versions = [NEW]; return { snapshot: NEW, replayed: true };
    }
  }) });
  await p.go(); p.field('period', '2026-10-05'); await flush();
  assert(p.text().includes('這個期間尚未產生報告'));
  const g = p.act('generate'); g.click(); g.click(); await flush();
  assert.equal(p.posts().length, 1, 'double click sends once');
  const first = p.posts()[0]; assert.equal(first.url, '/api/work-reports/generate');
  assert.deepEqual(Object.keys(first.body), ['periodKind', 'startDate', 'idempotencyKey']); assert.match(first.body.idempotencyKey, /^wr-[0-9a-f-]{36}$/);
  assert(p.text().includes('結果不明') && p.act('op-retry')); assert(p.act('generate').disabled, 'no new operation while a result is unknown');
  mode = 'ok'; p.act('op-retry').click(); await flush();
  assert.equal(p.posts().length, 2); assert.deepEqual(p.posts()[1], first, 'retry = identical url + body + key');
  assert(p.gets().some(c => c.url === '/api/work-reports?kind=week&start=2026-10-05'), 'versions re-read after success');
  assert.equal(p.q('[data-field="version"]').value, NEW.id); assert(p.text().includes('2026-W41'));
  // 409: a readable message, the operation ends, a later click is a NEW key
  const q = page({ routes: baseRoutes(call => { if (call.url.startsWith('/api/work-reports/periods?')) { const r = periodsResp(); r.periods.unshift(...more.map(x => ({ ...x, versions: [...x.versions] }))); return r; } if (call.method === 'POST') return Promise.reject(httpError(409, 'report_exists', 'exists')); }) });
  await q.go(); q.field('period', '2026-10-05'); await flush(); q.act('generate').click(); await flush();
  assert(q.text().includes('此期間已有初版報告') && q.act('reload-versions')); assert.equal(q.posts().length, 1, 'never re-sent automatically');
  q.act('generate').click(); await flush(); assert.equal(q.posts().length, 2); assert.notEqual(q.posts()[0].body.idempotencyKey, q.posts()[1].body.idempotencyKey);
});

await test('early review ①: a 2xx without snapshot.id is not success — the operation stays unknown with the original body+key for an explicit retry', async () => {
  const NEW = meta('wr_00000000-0000-4000-8000-0000000000f3', thin, { startDate: '2026-10-05', endDateExclusive: '2026-10-12', label: '2026-W41' });
  const more = [{ kind: 'week', startDate: '2026-10-05', endDateExclusive: '2026-10-12', label: '2026-W41', ended: true, versions: [] }];
  const answers = [{}, { snapshot: {} }, { snapshot: NEW, replayed: true }]; let versions = [];
  const p = page({ routes: baseRoutes(call => {
    if (call.url.startsWith('/api/work-reports/periods?')) { const r = periodsResp(); r.periods.unshift(...more.map(x => ({ ...x, versions: [] }))); return r; }
    if (call.url === '/api/work-reports?kind=week&start=2026-10-05') return { versions };
    if (call.url === '/api/work-reports/' + NEW.id) return { snapshot: NEW, payloadSha256: P.payloadSha256(thin), payload: thin };
    if (call.method === 'POST') { const a = answers.shift(); if (a.snapshot?.id) versions = [NEW]; return a; }
  }) });
  await p.go(); p.field('period', '2026-10-05'); await flush(); p.act('generate').click(); await flush();
  assert(p.text().includes('回應格式異常，結果不明') && p.act('op-retry')); assert(!p.gets().some(c => c.url.includes('start=2026-10-05')), 'no versions re-read on a bad 2xx');
  p.act('op-retry').click(); await flush(); assert(p.act('op-retry'), 'second bad 2xx still keeps the operation');
  p.act('op-retry').click(); await flush();
  assert.equal(p.posts().length, 3); assert(p.posts().every(x => JSON.stringify(x) === JSON.stringify(p.posts()[0])), 'every retry is the identical url+body+key');
  assert.equal(p.q('[data-field="version"]').value, NEW.id);
});

await test('revision: concrete reason required, expectedLatestRevision + latest parent, conflicts and 403/401 return to a safe state without auto-retry', async () => {
  const outcomes = [];
  const p = page({ routes: baseRoutes(call => { if (call.method === 'POST') { const o = outcomes.shift(); return o instanceof Error ? Promise.reject(o) : o; } }) });
  await p.go(); p.act('revise-open').click(); await flush();
  p.act('revise-submit').click(); await flush(); assert.equal(p.posts().length, 0); assert(p.text().includes('請寫出具體的修訂原因'));
  p.field('reason', ' 補登期後交付 '); outcomes.push(httpError(409, 'revision_conflict', 'stale'));
  p.act('revise-submit').click(); await flush();
  assert.deepEqual(p.posts()[0].url, `/api/work-reports/${V2.id}/revisions`);
  assert.deepEqual({ ...p.posts()[0].body, idempotencyKey: 'k' }, { reason: '補登期後交付', expectedLatestRevision: 2, idempotencyKey: 'k' });
  assert(p.text().includes('最新版本已變更') && !p.act('op-retry')); assert.equal(p.posts().length, 1);
  outcomes.push(httpError(403, 'admin_only', 'no'));
  p.act('revise-open').click(); await flush(); p.field('reason', '補登期後交付'); p.act('revise-submit').click(); await flush();
  assert(p.text().includes('沒有權限產生或修訂報告') && !p.text().includes('列入案件'), '403 clears manager data');
  const q = page({ routes: baseRoutes(call => { if (call.method === 'POST') return Promise.reject(httpError(401, 'session_expired', 'x', { authExpired: true })); }) });
  await q.go(); q.act('revise-open').click(); await flush(); q.field('reason', '期後更正交付'); q.act('revise-submit').click(); await flush();
  assert(q.text().includes('登入已過期') && !q.text().includes('列入案件'));
  // success while the user moved to another period: the new id is not force-selected
  const r = page({ routes: baseRoutes(call => { if (call.method === 'POST') return r.c.__post.promise; }) }); r.c.__post = deferred();
  await r.go(); r.act('revise-open').click(); await flush(); r.field('reason', '期後更正交付'); r.act('revise-submit').click(); await flush();
  r.field('period', '2026-10-12'); await flush();
  r.c.__post.resolve({ snapshot: { ...V2, id: 'wr_00000000-0000-4000-8000-0000000000f2', revision: 3 }, replayed: false }); await flush();
  assert.equal(r.q('[data-field="period"]').value, '2026-10-12'); assert(r.text().includes('已完成；切回該期間即可查看'));
});

await test('actor change on the same page: stale controls do nothing and private data is dropped', async () => {
  const p = page({ routes: baseRoutes() }); await p.go(); const n = p.calls.length;
  p.c.ME = { id: 11, name: '另一位主管', role: 'admin' };
  p.act('revise-open').click(); await flush();
  assert.equal(p.posts().length, 0); assert(p.calls.length > n, 're-entered for the new actor'); assert(!p.text().includes('修訂原因'));
});

await test('CSV: BOM, CRLF, quoting, formula-injection guard, unknown vs 0, kinds/units as separate columns, safe filename', () => {
  const U = vm.runInContext('window.WorkReportsUI', page({ routes: baseRoutes() }).c);
  for (const [input, want] of [['=1+1', "'=1+1"], ['+A', "'+A"], ['-2', "'-2"], ['@x', "'@x"], [' =x', "' =x"], ['\t=x', "'\t=x"], ['\r=x', "'\r=x"], ['﻿=x', "'﻿=x"], ['\u0001ok', "'\u0001ok"], ['中文', '中文'], ['a-b', 'a-b']])
    assert.equal(U.safeText(input), want, JSON.stringify(input));
  assert.equal(U.csvCell('a,b'), '"a,b"'); assert.equal(U.csvCell('他說"好"'), '"他說""好"""'); assert.equal(U.csvCell('x\r\ny'), '"x\r\ny"'); assert.equal(U.csvCell(null), ''); assert.equal(U.csvCell(0), '0');
  assert.equal(U.csvCell('\t=x'), "'\t=x", 'guarded; a tab needs no quoting'); assert.equal(U.csvCell('\r=x'), '"\'\r=x"', 'guarded, then quoted for CR');
  assert.deepEqual(['total', 'known', 'unknown'].map((_, i) => JSON.parse(JSON.stringify(U.countText([{ total: 3, knownSubtotal: 3 }, { total: null, knownSubtotal: 2 }, { total: null, knownSubtotal: null }][i])))),
    [{ value: '3', note: '', state: 'total' }, { value: '2', note: '已知部分', state: 'known' }, { value: '—', note: '資料不足', state: 'unknown' }]);
  assert.deepEqual(U.countText(null).state, 'unknown');
  const display = U.buildDisplay(envOf(V2.id), V2.id), csv = U.buildCsv(display);
  assert(csv.startsWith('﻿') && csv.endsWith('\r\n') && !/[^\r]\n(?![^"]*"(?:[^"]*"[^"]*")*[^"]*$)/.test(csv.split('案號')[0]));
  const lines = csv.split('\r\n'); const header = lines.find(l => l.startsWith('館別,館別對應,案號'));
  for (const col of ['本期 主設計（件）', '本期 主設計（式）', '本期 延伸（件）', '本期 支援（件）', '累計至期末 主設計（式）']) assert(header.includes(col), col);
  const table = parseCsv(csv.slice(1)), cols = table.find(r => r[0] === '館別' && r[2] === '案號'), rowZ = table.find(r => r[0] === '不存在館');
  assert.equal(rowZ[cols.indexOf('標題')], '\'=HYPERLINK("http://x","y")');
  assert.equal(rowZ[cols.indexOf('本期 主設計（件）')], '未知', 'legacy unknown is not 0'); assert.equal(rowZ[cols.indexOf('舊制產出數（期間不明）')], '7');
  const rowX = lines.find(l => l.startsWith('新竹館,')); assert(rowX.includes('2026-10-21 =SUM(A1) 初稿'), 'text inside a cell that starts with a date is not a formula');
  assert(rowX.includes('D3：@僅提供既有檔案（主管已核可）'), 'zero-support reason and approval exported');
  assert(lines.find(l => l.startsWith('不存在館,')).includes(`"'=HYPERLINK(""http://x"",""y"")"`), 'a title starting with = is guarded, then quoted');
  assert(csv.includes('"無館別, ""引號""\n換行"'), 'comma, quotes and newline quoted');
  assert(csv.includes('未能確認期間在辦的案件'), 'unresolved section kept');
  assert(csv.includes(display.payloadSha256) && csv.includes(V2.id) && csv.includes(V2.knowledgeCutoff));
  assert.equal(U.fileName(display), 'work-report_2026-W43_r2.csv');
  assert.match(U.fileName({ snapshot: { ...V2, label: '../館 名' }, filter: { hotel: 'unmatched:../x' } }), /^work-report_[A-Za-z0-9_-]+_r2_filtered\.csv$/, 'no raw path characters or hotel names');
  assert.throws(() => U.buildDisplay({ snapshot: { id: 'wr_other' }, payload: full }, V2.id), /回應格式異常/);
  assert.throws(() => U.buildDisplay({ snapshot: V2, payloadSha256: 'x' }, V2.id), /回應格式異常/);
});

await test('index wiring, cache-bust hashes and CSS scope', () => {
  const sha = f => crypto.createHash('sha256').update(fs.readFileSync(root + '/public/' + f)).digest('hex').slice(0, 12);
  assert(index.includes(`<script src="/work-reports.js?v=${sha('work-reports.js')}"></script>`)); assert(index.includes(`<link rel="stylesheet" href="/work-reports.css?v=${sha('work-reports.css')}">`));
  assert(index.indexOf('/work-reports.js?v=') > index.indexOf('/release-notice.js?v='), 'outermost switchView hook');
  assert.equal((index.match(/work-reports\.js\?v=/g) || []).length, 1);
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]+\{/g, '').split('}').map(b => b.split('{')[0].trim()).filter(Boolean);
  const topLevel = sel => { const out = []; let depth = 0, cur = ''; for (const ch of sel) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && !depth) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
  for (const sel of selectors) for (const part of topLevel(sel)) assert(part.trim().startsWith('.view[data-view="work-reports"]'), 'scoped: ' + part);
  assert(/:is\(\.wb-button,select,input\)\{min-height:44px\}/.test(css) && /\.wr-sort\{min-height:44px;min-width:44px/.test(css), '44px targets on this page');
  assert(css.includes('prefers-reduced-motion'));
  // round2: hidden screen-reader text is anchored inside the labelled table region (no page-root overflow at 360/390px)
  assert(/\.wr-table-wrap\{position:relative;overflow-x:auto;max-width:100%;min-width:0/.test(css), 'table region is the containing block');
  assert(/\.wr-sr\{position:absolute;top:0;left:0;/.test(css), 'hidden text pinned to its containing block');
  // round3: the two texts on the bare page background use the main ink pair (cards keep muted)
  assert(/\.wr-head \.wb-help\{color:var\(--hf-ink,#233b56\)\}/.test(css) && /\.wr-status\{font-size:12px;color:var\(--hf-ink,#233b56\)/.test(css), 'bare-background text uses --hf-ink');
  assert(/\.view\[data-view="work-reports"\] \.wb-help\{color:var\(--hf-muted,#526983\)/.test(css), 'in-card help text keeps muted');
  const sr = plugin.match(/class="wr-sr"/g).length; assert.equal(sr, 3, 'all hidden texts sit inside the table region (th, row button, detail button)');
  assert(!/overflow-x:hidden|overflow:hidden;?\s*\}/.test(css.replace(/\.wr-sr\{[^}]*\}/, '').replace(/\.wr-bar-track\{[^}]*\}/, '')), 'no page-wide overflow masking');
  assert(!/https?:\/\//.test(plugin) && !/<script/i.test(plugin.replace(/<script/gi, m => m)), 'no CDN / remote asset');
});

await test('REPORTS-P3-E3 scheduled versions read 系統自動彙整 with no person; status line is read-only, guarded and generation-checked', async () => {
  // a scheduled initial version (real builder: generatedBy null, trigger scheduled) next to a manual revision
  const auto = P.buildWorkReportPayload({ period: week, cutoff: wi.cutoffInstant, knowledgeCutoff: wi.cutoffInstant, observedAt: wi.cutoffInstant, coverageStart: '2026-10-27T00:00:00.000000Z',
    revision: 1, supersedesId: null, revisionReason: null, trigger: 'scheduled', generatedBy: null, endState: { status: 'insufficient', coverageStart: '2026-10-27T00:00:00.000000Z', tables: null }, knowledge: null });
  assert.equal(auto.meta.generatedBy, null); assert.equal(auto.meta.trigger, 'scheduled');
  const VS = { ...meta('wr_00000000-0000-4000-8000-0000000000aa', auto), generatedById: null, generatedByName: null, trigger: 'scheduled' };
  const status = { enabled: true, configuredStartDate: '2026-10-28', now: '2026-10-28T02:00:00.000000Z', rulesVersion: P.RULES_VERSION, initialized: true,
    state: { status: 'active', pausedReason: null, epoch: 1, startDate: '2026-10-28', activatedAt: '2026-10-28T01:00:00.000000Z', startDateMatches: true, coverageMatches: true },
    next: [{ kind: 'week', startDate: '2026-10-26', endDateExclusive: '2026-11-02', label: '2026-W44', dueAt: '2026-11-01T16:05:00.000000Z' }],
    counts: { succeeded: 1, blocked: 1 }, recent: [{ id: 'wj_1', periodKind: 'week', startDate: '2026-10-19', label: '2026-W43', status: 'succeeded', attemptCount: 1, maxAttempts: 6, nextAttemptAt: null, lastErrorCode: null, snapshotId: VS.id, finishedAt: '2026-10-26T16:06:00.000000Z', epoch: 1 }],
    attention: [{ id: 'wj_2', periodKind: 'month', startDate: '2026-09-01', label: '2026-09', status: 'blocked', attemptCount: 6, maxAttempts: 6, nextAttemptAt: null, lastErrorCode: 'exhausted_source_not_settled', snapshotId: null, finishedAt: '2026-10-01T02:00:00.000000Z', epoch: 1 },
      { id: 'wj_3', periodKind: 'quarter', startDate: '2026-07-01', label: '2026-Q3', status: 'pending', attemptCount: 2, maxAttempts: 6, nextAttemptAt: '2026-10-28T02:04:00.000000Z', lastErrorCode: 'source_not_settled', snapshotId: null, finishedAt: null, epoch: 1 }] };
  const gate = deferred();
  const p = page({ routes: baseRoutes(call => {
    if (call.url === SCHED_URL) return gate.promise;
    if (call.url.startsWith('/api/work-reports/periods?')) { const r = periodsResp(); r.periods[1] = { ...r.periods[1], versions: [VS] }; return r; }
    if (call.url === '/api/work-reports/' + VS.id) return { snapshot: VS, payloadSha256: P.payloadSha256(auto), payload: auto };
  }) });
  await p.go();
  assert.equal(p.scheds().length, 1, 'one status read on entry'); assert(!p.q('.wr-sched'), 'nothing shown before the status arrives');
  assert(p.text().includes('系統自動彙整'), 'the meta and version list name the trigger'); assert(!p.text().includes('主管九'), 'no person is shown for a scheduled version');
  assert((p.q('[data-field="version"]').textContent || p.q('[data-field="version"]').innerHTML || '').includes('系統自動彙整'), 'version option names the trigger');
  const csv = parseCsv(p.c.WorkReportsUI.buildCsv(p.c.WorkReportsUI.buildDisplay({ snapshot: VS, payloadSha256: P.payloadSha256(auto), payload: auto }, VS.id)).replace(/^﻿/, ''));
  assert.deepEqual(csv.find(r => r[0] === '產生者'), ['產生者', ''], 'the person column stays empty'); assert.deepEqual(csv.find(r => r[0] === '產生方式'), ['產生方式', '系統自動彙整']);
  gate.resolve(status); await flush();
  const line = p.q('.wr-sched').textContent;
  for (const s of ['自動彙整：已啟用', '週報 2026-W44', '2026-W43 已自動產生', '2026-09：異常，需維運處理', '多次重試仍失敗：資料異動尚未結束', '2026-Q3：重試中（第 2 次']) assert(line.includes(s), s);
  assert.equal(p.posts().length, 0, 'status reading never writes');
  assert(!p.q('.wr-sched [data-act]'), 'no run / retry / publish control on the page');
  // refresh re-reads; a late status from a previous entry is discarded after leaving
  const late = deferred(); let hold = true;
  const q = page({ routes: baseRoutes(call => (call.url === SCHED_URL && hold ? late.promise : undefined)) });
  await q.go(); q.c.switchView('dashboard'); await flush(); hold = false;
  late.resolve(status); await flush();
  assert(!q.view() || !q.view().textContent.includes('自動彙整'), 'late status after leaving is dropped');
  // paused / disabled / failure texts; a manual version keeps the person
  for (const [d, want] of [[{ ...status, state: { ...status.state, status: 'paused', pausedReason: 'coverage_epoch_changed' }, attention: [] }, '資料來源起點已改變'],
    [{ ...status, enabled: false, attention: [] }, '已產生的報告不受影響'], [schedOff, '各期仍可手動產生']]) {
    const r = page({ routes: baseRoutes(call => (call.url === SCHED_URL ? d : undefined)) }); await r.go();
    assert(r.q('.wr-sched').textContent.includes(want), want); assert(r.text().includes('管理員手動（主管九）'), 'manual versions still show the admin');
  }
  const f = page({ routes: baseRoutes(call => (call.url === SCHED_URL ? Promise.reject(httpError(500, 'server_error')) : undefined)) }); await f.go();
  assert(f.q('.wr-sched').textContent.includes('暫時無法讀取') && f.text().includes('2026-W43'), 'a failed status read does not block the report');
  // guard: member / preview never read the status
  const m = page({ me: { id: 2, name: '陳二', role: 'member' }, role: 'designer', routes: baseRoutes() }); m.c.switchView('work-reports'); await flush();
  assert.equal(m.scheds().length, 0);
});

console.log(JSON.stringify({ workReportsUiTests: passed }));
