/* REPORTS-P3-E2 工作報告（週報／月報／季報）：主管查看已保存的報告快照、產生初版、建立修訂版、篩選、圖表與 CSV。
 * - 只用 /api/work-reports 公開 API；畫面、圖表、明細與 CSV 一律來自「同一份成功載入的快照或其篩選 view」，
 *   不讀即時案件、分析或人員資料補洞，也不重新計算業務數字（未知維持未知、已知部分明確標示）。
 * - 入口與每個操作都檢查：真實登入者 ME.role=admin、目前視角 currentRole=admin、沒有 view-as／觀察者預覽。
 *   這只是畫面守門；正式權限邊界在伺服器（requireAuth＋requireAdmin＋發布交易內重驗）。
 * - 非同步回覆一律綁「登入者＋視角＋目前頁面＋選取世代」；離頁、換人、切預覽或改選期間／版本／篩選後，
 *   舊的成功、失敗與 finally 都不得改寫新畫面。只檢 isConnected 不夠（隱藏的頁面仍在 DOM 內）。
 * - 寫入不自動重送：每次新操作產生穩定識別碼；結果不明時保留完全相同的請求，需使用者明確「以同一請求重試」。
 */
(() => {
  if (window.__workReportsInstalled) return;
  window.__workReportsInstalled = true;

  const VIEW = 'work-reports';
  const API = '/api/work-reports';
  const PAGE_SIZE = 50;
  const KIND_LABEL = { week: '週報', month: '月報', quarter: '季報' };
  const SPAN = { week: 24, month: 24, quarter: 12 };          // 期間清單長度（伺服器上限 60）
  const OUTPUT_KIND = { main: '主設計', extension: '延伸', support: '支援' };
  const END_KIND = { open: '進行中', completed: '已完成', cancelled: '已取消', sealed_incomplete: '未完成封存（非完成）',
    archived_not_completed: '已收起（非完成）', not_recorded_at_cutoff: '期末尚無紀錄' };
  const COMPLETENESS = { complete: '來源完整', partial: '部分可重建（已知部分）', insufficient: '期末來源資料不足' };
  const REASONS = { end_state_before_coverage: '期末早於來源版本起點，無法重建期末狀態', period_start_before_coverage: '期間開始早於來源版本起點，期間前段不可證明',
    cases_deleted_during_period: '期間內有案件被刪除，母體不完整' };
  const BASIS = { legacy_missing_start_date: '舊制案件缺開始日期', legacy_missing_end_date: '舊制案件缺結束日期', legacy_archived_without_end_date: '舊制案件已收起但無結束日期',
    managed_without_cycle: '受控案件沒有週期紀錄', cycle_time_unknown: '週期時間不明', before_lifecycle_adoption: '導入生命週期管理前（不推測）',
    not_recorded_at_cutoff: '期末尚無紀錄', managed_cycles: '依工作週期', legacy_date_proxy: '依既有日期推估（舊制）' };
  const LIMITS = { case_deleted_after_cutoff: '期末之後原案已刪除（報告保留期末內容）', undated_logs: '有日期無效或缺日期的日誌（未計入本期）',
    legacy_output_period_unknown: '舊制產出的期間歸屬不明', delivery_cycle_attribution_unknown: '部分交付的工作週期歸屬不明', recorded_after_cutoff: '期後補登的案件', ...BASIS };
  const KNOWLEDGE = { as_of_cutoff: '期末已知', recorded_after_cutoff: '期後補登', corrected_after_cutoff: '期後更正', removed_after_cutoff: '期後移除',
    unidentified: '無法辨識（舊資料無識別碼）', voided_after_cutoff: '期後作廢' };
  const ZERO = { approved: '主管已核可', not_approved: '主管未核可', pending: '待主管核可', not_submitted: '尚未送審' };
  const DELIVERY_STATUS = { known: '已記錄', none_recorded: '本期無交付紀錄', unknown: '未知（舊制，期間不明）', partial: '已知部分（另有舊制未知）' };
  const MILESTONES = [['dispatchDate', '派發日'], ['copyDate', '文案日'], ['printDate', '送印日'], ['goLiveDate', '上線日']];

  const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const ICON = {
    report: '<path d="M4 2.5h6l2.5 2.5v8.5H4z"/><path d="M6 8h4M6 10.5h4M6 5.5h2"/>',
    info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 5v.3"/>',
    alert: '<path d="M8 2.2 14 13H2z"/><path d="M8 6.5v3M8 11.2v.3"/>',
    check: '<circle cx="8" cy="8" r="6"/><path d="m5.5 8.2 1.8 1.8 3.3-3.6"/>',
    clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2.2 1.4"/>',
    filter: '<path d="M2.5 3.5h11l-4.2 5v4l-2.6 1v-5z"/>',
    download: '<path d="M8 2.5v7.5M5 7.5l3 3 3-3M3 13h10"/>',
    refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.8v2.6h-2.6"/>',
    plus: '<path d="M8 3.5v9M3.5 8h9"/>',
    chevron: '<path d="m6 4 4 4-4 4"/>',
  };
  const icon = (name, label) => `<svg class="wr-ico" viewBox="0 0 16 16" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true" focusable="false"'}>${ICON[name] || ''}</svg>`;

  // ── 純函式：數字語意、CSV（測試直接呼叫） ────────────────────────────────────────────────────────
  // {total, knownSubtotal}：total 有值＝完整數；只有 knownSubtotal＝「已知部分」；兩者皆 null＝資料不足。絕不把 null 當 0。
  function countText(metric) {
    if (!metric || typeof metric !== 'object') return { value: '—', note: '資料不足', state: 'unknown' };
    if (metric.total != null) return { value: String(metric.total), note: '', state: 'total' };
    if (metric.knownSubtotal != null) return { value: String(metric.knownSubtotal), note: '已知部分', state: 'known' };
    return { value: '—', note: '資料不足', state: 'unknown' };
  }
  const kindLabel = (kind, unit) => `${OUTPUT_KIND[kind] || kind}（${unit}）`;
  // 使用者輸入文字的公式注入防護：去掉前導空白／控制字元／BOM 後若以 = + - @ 起頭，或本身以 tab／CR 等控制字元起頭，前加單引號。
  function safeText(value) {
    const s = String(value ?? '');
    if (/^[\s\u0000-\u001f\u007f﻿]*[=+\-@]/.test(s) || /^[\u0000-\u001f\u007f]/.test(s)) return "'" + s;
    return s;
  }
  function csvCell(value, { text = true } = {}) {
    if (value == null) return '';
    let s = typeof value === 'number' ? String(value) : (text ? safeText(value) : String(value));
    if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  const csvRow = cells => cells.map(c => (c && typeof c === 'object' && 'raw' in c) ? csvCell(c.raw, { text: false }) : csvCell(c)).join(',');
  const raw = v => ({ raw: v });   // 系統產生、已知安全的值（hash、ISO 時間、數字字串）
  function fileName(display) {
    const s = display.snapshot, label = String(s.label || s.startDate || 'report').replace(/[^A-Za-z0-9_-]/g, '_');
    return `work-report_${label}_r${Number(s.revision) || 0}${display.filter ? '_filtered' : ''}.csv`;
  }
  // REPORTS-P3-E3：排程版本沒有人員操作者（generatedByName 保持 null），只顯示觸發方式。
  const triggerText = s => (s.trigger === 'scheduled' ? '系統自動彙整' : '管理員手動');
  function personNames(list) { return (list || []).map(p => p && (p.name || `#${p.id}`)).filter(Boolean).join('、'); }
  function totalsText(groups) { return (groups || []).map(g => `${OUTPUT_KIND[g.kind] || g.kind} ${g.quantity} ${g.unit}`).join('；'); }

  // 匯出目前成功載入的版本／篩選結果的「全部」列（不只當頁）。不回查、不重算。
  function buildCsv(display) {
    const s = display.snapshot, p = display.payload, sc = p.sourceCompleteness || {}, sum = p.summary || {};
    const out = [];
    const meta = [['報告', '工作報告'], ['報告ID', raw(s.id)], ['期間類型', KIND_LABEL[s.periodKind] || s.periodKind], ['期間', raw(`${s.label}（${s.startDate} 至 ${s.endDateExclusive} 前）`)],
      ['版本', s.revision === 1 ? '初版（1）' : `修訂版（${s.revision}）`], ['修訂原因', s.revisionReason || ''], ['期末截止 C', raw(s.cutoffInstant)], ['知識截止 K', raw(s.knowledgeCutoff)],
      ['產生時間', raw(s.generatedAt)], ['產生者', s.generatedByName || ''], ['產生方式', triggerText(s)], ['規則版本', raw(s.rulesVersion)], ['來源完整性', COMPLETENESS[sc.status] || sc.status || ''],
      ['完整性原因', (sc.reasons || []).map(r => REASONS[r] || r).join('；')], ['來源版本起點', raw(sc.coverageStart || '')],
      ['篩選', display.filter ? filterText(display.filter, display) : '無（全部）'], ['原版本雜湊 payloadSha256', raw(display.payloadSha256)],
      ['篩選檢視雜湊 viewSha256', raw(display.viewSha256 || '')], ['匯出範圍', '目前版本與篩選的全部結果（不只畫面當頁）']];
    for (const [k, v] of meta) out.push(csvRow([k, v]));
    out.push('');
    out.push(csvRow(['指標', '總數', '已知部分', '說明']));
    const metric = (label, m) => { const t = countText(m); out.push(csvRow([label, t.state === 'total' ? raw(t.value) : '', m?.knownSubtotal != null ? raw(String(m.knownSubtotal)) : '', t.state === 'total' ? '' : t.note])); };
    metric('列入案件', sum.caseCount); metric('期間在辦', sum.activeCaseCount); metric('本期完成', sum.completedInPeriod);
    for (const g of (sum.deliveries?.period || [])) out.push(csvRow([`本期交付 ${kindLabel(g.kind, g.unit)}`, g.total != null ? raw(String(g.total)) : '', raw(String(g.knownSubtotal)), g.total != null ? '' : '已知部分']));
    if (sc.status === 'insufficient') {
      out.push(csvRow(['說明', '期末來源資料不足：沒有可重建的明細，數字為未知，不代表沒有工作']));
      out.push(csvRow(['說明', '歷史追蹤起點（來源版本起點）晚於本期期末；原案件資料仍保留；修訂版無法還原當時沒有記錄的期末狀態']));
    }
    out.push('');
    // 種類×單位各自一欄；不同單位不合併
    const pairs = [], seen = new Set();
    const addPair = g => { const k = g.kind + '\u0000' + g.unit; if (!seen.has(k)) { seen.add(k); pairs.push([g.kind, g.unit]); } };
    for (const r of p.rows || []) { for (const g of r.deliveries?.period?.totals || []) addPair(g); for (const g of r.deliveries?.cumulativeToEnd?.totals || []) addPair(g); }
    const rank = k => ({ main: 0, extension: 1, support: 2 }[k] ?? 3);
    pairs.sort((a, b) => rank(a[0]) - rank(b[0]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    out.push(csvRow(['館別', '館別對應', '案號', '標題', '身分依據', '主責', '協作', '期末狀態', '期間在辦', '在辦依據', '本期完成', '本期進度筆數', '本期進度',
      '交付狀態', ...pairs.map(([k, u]) => `本期 ${kindLabel(k, u)}`), ...pairs.map(([k, u]) => `累計至期末 ${kindLabel(k, u)}`), '舊制需求數（期間不明）', '舊制產出數（期間不明）',
      '支援0說明', '期後作廢', '下一步', '限制']));
    const hotelName = hotelNamer(p);
    for (const r of orderedRows(p, p.rows || [])) {
      const d = r.deliveries || {}, unknownQty = d.status === 'unknown' || d.status === 'partial';   // 舊制部分：缺的種類是未知，不是 0
      const qty = (totals, kind, unit) => { const g = (totals || []).find(x => x.kind === kind && x.unit === unit); if (g) return raw(String(g.quantity)); return unknownQty ? '未知' : raw('0'); };
      const zero = (d.period?.records || []).filter(x => x.zeroSupport).map(x => `${x.itemName || x.id}：${x.zeroSupport.note || '（未填原因）'}（${ZERO[x.zeroSupport.status] || x.zeroSupport.status}）`).join('；');
      out.push(csvRow([hotelName(r.hotel), hotelMatch(r.hotel), r.id, r.title || '', r.identityBasis === 'knowledge_cutoff' ? '期後補登（依知識截止）' : '期末（C）',
        personNames(r.assignment?.designer ? [r.assignment.designer] : []), personNames(r.assignment?.collaborators), END_KIND[r.endState?.kind] || r.endState?.kind || '',
        ({ yes: '是', no: '否', unknown: '未知' }[r.activity?.state] || ''), BASIS[r.activity?.basis] || r.activity?.basis || '', ({ yes: '是', no: '否', unknown: '未知' }[r.completion?.state] || ''),
        raw(String((r.progress || []).length)), (r.progress || []).map(e => `${e.date} ${e.note ?? ''}${e.knowledge && e.knowledge !== 'as_of_cutoff' ? `（${KNOWLEDGE[e.knowledge] || e.knowledge}）` : ''}`).join('\n'),
        DELIVERY_STATUS[d.status] || d.status || '', ...pairs.map(([k, u]) => qty(d.period?.totals, k, u)), ...pairs.map(([k, u]) => qty(d.cumulativeToEnd?.totals, k, u)),
        d.legacyCounts?.requestCount != null ? raw(String(d.legacyCounts.requestCount)) : (d.legacyCounts ? '未知' : ''), d.legacyCounts?.outputCount != null ? raw(String(d.legacyCounts.outputCount)) : (d.legacyCounts ? '未知' : ''),
        zero, (d.voidedAfterCutoff || []).map(v => `${v.id} ${OUTPUT_KIND[v.kind] || v.kind} ${v.quantity} ${v.unit}${v.voidReason ? '：' + v.voidReason : ''}`).join('；'),
        r.nextStep?.label || '', (r.limitations || []).map(x => LIMITS[x] || x).join('；')]));
    }
    if ((p.unresolved || []).length) {
      out.push('');
      out.push(csvRow(['未能確認期間在辦的案件（未列入明細，使總數維持未知）']));
      out.push(csvRow(['館別', '案號', '標題', '主責', '原因']));
      for (const u of orderedRows(p, p.unresolved)) out.push(csvRow([hotelName(u.hotel), u.id, u.title || '', personNames(u.assignment?.designer ? [u.assignment.designer] : []), BASIS[u.activity?.basis] || u.activity?.basis || '']));
    }
    return '﻿' + out.join('\r\n') + '\r\n';
  }

  function hotelMatch(h) { return h ? ({ matched: '字典館別', unmatched: '未對應館名（保留原值）', none: '未填館別', not_recorded_at_cutoff: '期末尚無紀錄' }[h.match] || h.match) : ''; }
  function hotelNamer(payload) {
    const byKey = new Map((payload.hotelOrder || []).map(h => [h.key, h]));
    return h => {
      if (!h) return '';
      if (h.groupKey === 'none') return '（未填館別）';
      if (h.groupKey === 'not_recorded_at_cutoff') return h.raw ? `${h.raw}（期末尚無紀錄）` : '（期末尚無紀錄）';
      const o = byKey.get(h.groupKey);
      return (o && o.name) || h.raw || '';
    };
  }
  // 館別順序永遠取快照 hotelOrder；組內依案號（或使用者選的欄位）穩定排序。
  function orderedRows(payload, rows, sortKey = 'id', dir = 'ascending') {
    const rank = new Map((payload.hotelOrder || []).map((h, i) => [h.key, i]));
    const val = r => sortKey === 'title' ? String(r.title || '') : sortKey === 'endState' ? String(END_KIND[r.endState?.kind] || '') : String(r.id);
    const sign = dir === 'descending' ? -1 : 1;
    return rows.map((r, i) => ({ r, i })).sort((a, b) => {
      const ga = rank.has(a.r.hotel?.groupKey) ? rank.get(a.r.hotel.groupKey) : 1e9, gb = rank.has(b.r.hotel?.groupKey) ? rank.get(b.r.hotel.groupKey) : 1e9;
      if (ga !== gb) return ga - gb;
      const va = val(a.r), vb = val(b.r);
      if (va !== vb) return (va < vb ? -1 : 1) * sign;
      return a.i - b.i;
    }).map(x => x.r);
  }
  function filterText(filter, display) {
    const parts = [];
    if (filter.hotel) { const h = (display.payload.hotelOrder || []).find(x => x.key === filter.hotel); parts.push('館別：' + (h ? (h.name || hotelGroupFallback(h.key)) : filter.hotel)); }
    if (filter.staffId != null) { const s = (display.basePayload?.staff || display.payload.staff || []).find(x => x.id === filter.staffId); parts.push('參與案件（期末指派）：' + (s ? s.name : '#' + filter.staffId)); }
    return parts.join('；');
  }
  const hotelGroupFallback = key => key === 'none' ? '未填館別' : key === 'not_recorded_at_cutoff' ? '期末尚無紀錄' : String(key).replace(/^unmatched:/, '');

  // 回應 envelope → 單一顯示來源。原版：payload；篩選：view.payload（不同 envelope，雜湊語意分開）。
  function buildDisplay(envelope, requestedId, base) {
    if (!envelope || typeof envelope !== 'object' || !envelope.snapshot) throw shapeError();
    if (requestedId && envelope.snapshot.id !== requestedId) throw shapeError();
    const filtered = !!envelope.view, payload = filtered ? envelope.view.payload : envelope.payload;
    if (!payload || !payload.meta || !payload.summary || !Array.isArray(payload.rows) || !payload.sourceCompleteness) throw shapeError();
    return { snapshot: envelope.snapshot, payload, payloadSha256: envelope.payloadSha256, viewSha256: filtered ? envelope.view.viewSha256 : null,
      filter: filtered ? envelope.view.filter : null, basePayload: base || (filtered ? null : payload) };
  }
  function shapeError() { const e = new Error('回應格式異常'); e.wrShape = true; return e; }

  // REPORTS-P3-E3a 可用性：已產生的期間依「最新版本」保存的 sourceCompleteness；缺值或未知值誠實標「完整性待確認」。
  // 尚未產生的期間依目前的歷史追蹤起點（periods.coverage.coverageStart）預估：C < 起點＝只會資料不足（不提供產生）；
  // S < 起點 ≤ C＝部分可重建；起點 ≤ S 只代表時間上涵蓋（期間內刪除的案件仍可能使報告只有部分）。
  // 舊伺服器沒有 coverage 欄位時不預判、不擋產生，維持原行為。
  const AVAIL = { complete: '可檢視', partial: '部分可重建', insufficient: '資料不足' };
  function versionAvailability(v) {
    const st = v && Object.prototype.hasOwnProperty.call(AVAIL, v.sourceCompleteness) ? v.sourceCompleteness : null;
    return { state: st || 'unconfirmed', text: st ? AVAIL[st] : '完整性待確認' };
  }
  const US_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;   // 同格式才能直接比大小
  function preAvailability(period, coverage) {
    if (!period) return null;
    if (!period.ended) return { state: 'not_ended', block: true, text: `期間尚未結束（${period.endDateExclusive} 起才能產生）。` };
    if (!coverage || typeof coverage !== 'object' || !('coverageStart' in coverage)) return { state: 'unknown', block: false, text: '' };
    const cov = coverage.coverageStart, S0 = period.startInstant, C = period.cutoffInstant;
    if (cov == null) return { state: 'no_coverage', block: true, text: '系統尚未建立歷史追蹤起點，目前無法產生報告。' };
    if (!US_ISO.test(String(cov)) || !US_ISO.test(String(S0)) || !US_ISO.test(String(C))) return { state: 'unknown', block: false, text: '' };
    if (C < cov) return { state: 'insufficient', block: true, cov,
      text: `本期期末（${showTime(C)}）早於歷史追蹤起點（${showTime(cov)}，台北時間），產生的報告只會是「資料不足」，所以這裡不提供產生。原案件資料仍保留，這不代表本期沒有工作。` };
    if (S0 < cov) return { state: 'partial', block: false, cov,
      text: `歷史追蹤起點（${showTime(cov)}，台北時間）落在本期之中：產生後只會有起點之後可證明的「已知部分」，不是完整總數。` };
    return { state: 'covered', block: false, cov, text: '歷史追蹤起點早於本期開始，時間上涵蓋整期；若期間內有案件被刪除，仍可能只有部分可重建。' };
  }
  const PRE_TAG = { insufficient: '尚未產生・預計資料不足', partial: '尚未產生・預計部分可重建', covered: '尚未產生', no_coverage: '尚未產生・無追蹤起點', unknown: '尚未產生' };
  function periodTag(period, coverage) {
    const latest = latestVersion(period?.versions);
    if (latest) return '已產生・' + versionAvailability(latest).text;
    if (!period?.ended) return '';
    return PRE_TAG[preAvailability(period, coverage).state] || '';
  }

  window.WorkReportsUI = Object.freeze({ countText, safeText, csvCell, buildCsv, fileName, buildDisplay, orderedRows, versionAvailability, preAvailability, periodTag });

  // ── 權限、狀態與世代 ─────────────────────────────────────────────────────────────────────────────
  const me = () => (typeof ME !== 'undefined' && ME) || {};
  const role = () => (typeof currentRole !== 'undefined' ? currentRole : '');
  const viewNow = () => (typeof currentView !== 'undefined' ? currentView : '');
  const viewingAs = () => (typeof v36ViewAsName !== 'undefined' && !!v36ViewAsName);
  function allowed() {
    const m = me();
    return !!m.id && m.role === 'admin' && role() === 'admin' && !viewingAs() && !document.body?.classList?.contains('observer-mode');
  }
  const actorKey = () => `${me().id || 0}|${me().role || ''}`;
  const fresh = () => ({ actor: actorKey(), gen: 0, kind: 'week', anchor: null, periods: null, coverage: null, start: null, versions: [], selectedId: null,
    filter: { hotel: '', staffId: '' }, sched: null, schedGen: 0, base: new Map(), display: null, displayKey: null, phase: 'idle', message: '', errorRetry: null,
    op: null, busy: false, needsReload: false, reviseOpen: false, reviseDraft: '', opMessage: '', sort: { key: 'id', dir: 'ascending' }, page: 1, expanded: new Set(), caseNote: '' });
  let S = fresh();
  function ensureActor() { if (S.actor !== actorKey()) S = fresh(); }
  const token = () => ({ gen: S.gen, actor: actorKey() });
  const valid = t => t.gen === S.gen && t.actor === actorKey() && S.actor === t.actor && viewNow() === VIEW && allowed() && !!rootEl()?.isConnected;
  const bump = () => ++S.gen;
  const selectionKey = () => `${S.kind}|${S.start}|${S.selectedId}|${S.filter.hotel}|${S.filter.staffId}`;

  function rootEl() { return document.querySelector(`div.view[data-view="${VIEW}"]`); }
  function ensureView() {
    let views = [...document.querySelectorAll(`div.view[data-view="${VIEW}"]`)];
    for (const extra of views.slice(1)) extra.remove();
    let view = views[0];
    const main = document.querySelector('.main');
    if (!view) { view = document.createElement('div'); view.className = 'view wr-view'; view.dataset.view = VIEW; (main || document.body).appendChild(view); }
    else if (main && view.parentNode !== main) main.appendChild(view);
    if (!view.__wrWired) { view.__wrWired = true; view.addEventListener('click', onClick); view.addEventListener('change', onChange); view.addEventListener('input', onInput); }
    return view;
  }
  // 離頁、換人、切預覽：作廢所有進行中的讀取並清除主管資料與畫面（寫入中的操作只保留給同一登入者）
  function teardown() {
    bump();
    const keepOp = S.actor === actorKey() ? S.op : null;
    S.base = new Map(); S.display = null; S.displayKey = null; S.periods = null; S.coverage = null; S.versions = []; S.phase = 'idle'; S.expanded = new Set(); S.caseNote = '';
    S.schedGen++; S.sched = null;
    S.op = keepOp; if (!keepOp) S.busy = false;
    const v = rootEl(); if (v) v.innerHTML = '';
  }
  function deny() { teardown(); const v = rootEl(); if (v) { v.classList.remove('active'); v.innerHTML = ''; } }

  // ── 導覽：只在真 admin 的 admin 視角出現；重複載入不重複 ──────────────────────────────────────────
  if (typeof NAV_DEF !== 'undefined' && NAV_DEF.admin && !NAV_DEF.admin.some(n => n.key === VIEW)) NAV_DEF.admin.push({ key: VIEW, label: '工作報告' });
  if (allowed() && typeof renderNav === 'function') { try { renderNav(); } catch {} }   // 模組晚於登入資料載入時補上導覽
  const originalSwitch = window.switchView;
  window.switchView = function (v) {
    if (v === VIEW) {
      if (!allowed()) { deny(); if (typeof showToast === 'function') showToast('工作報告只供管理員在管理員視角使用', 'err'); return; }
      ensureActor(); ensureView();
      const r = typeof originalSwitch === 'function' ? originalSwitch.apply(this, arguments) : undefined;
      if (viewNow() !== VIEW) { currentView = VIEW; document.querySelectorAll('.view').forEach(x => x.classList.toggle('active', x.dataset.view === VIEW)); if (typeof renderNav === 'function') renderNav(); }
      enter();
      return r;
    }
    if (viewNow() === VIEW || S.gen) teardown();
    return typeof originalSwitch === 'function' ? originalSwitch.apply(this, arguments) : undefined;
  };

  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  function shiftDate(d, kind, n) {
    const [y, m, day] = d.split('-').map(Number);
    if (kind === 'week') return new Date(Date.UTC(y, m - 1, day + n * 7)).toISOString().slice(0, 10);
    const t = new Date(Date.UTC(y, m - 1 + n * (kind === 'quarter' ? 3 : 1), 1));
    return t.toISOString().slice(0, 10);
  }
  const showTime = iso => {
    if (!iso) return '—';
    const t = new Date(String(iso).replace(/(\.\d{3})\d+/, '$1'));
    if (!Number.isFinite(t.getTime())) return String(iso);
    return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(t);
  };

  // ── 讀取：期間 → 版本 → 快照／篩選 view，每步都核對世代 ────────────────────────────────────────────
  const getJson = url => window.fetchJson('GET', url);
  function enter() {
    if (!allowed()) return deny();
    ensureActor();
    if (!S.anchor) S.anchor = today();
    loadPeriods(); loadSched();
  }
  // REPORTS-P3-E3：排程狀態只讀；獨立世代，晚到或換人／離頁的回應丟棄，失敗只顯示一行提示。
  async function loadSched() {
    const g = ++S.schedGen, actor = actorKey();
    const ok = () => g === S.schedGen && actor === actorKey() && S.actor === actor && viewNow() === VIEW && allowed();
    try {
      const data = await getJson(`${API}/scheduler/status`);
      if (!ok()) return;
      S.sched = data && typeof data === 'object' && typeof data.enabled === 'boolean' && Array.isArray(data.next) ? { data } : { error: true };
    } catch { if (!ok()) return; S.sched = { error: true }; }
    render();
  }
  async function loadPeriods() {
    bump(); const t = token();
    S.periods = null; S.coverage = null; S.display = null; S.displayKey = null; S.phase = 'loading'; S.message = '載入期間中…'; S.errorRetry = null; render();
    const to = S.anchor, from = shiftDate(to, S.kind, -(SPAN[S.kind] - 1));
    try {
      const data = await getJson(`${API}/periods?kind=${encodeURIComponent(S.kind)}&from=${from}&to=${to}`);
      if (!valid(t)) return;
      if (!data || !Array.isArray(data.periods)) throw shapeError();
      S.periods = data.periods;
      S.coverage = data.coverage && typeof data.coverage === 'object' ? data.coverage : null;   // 舊 API 沒有此欄位 → null（不預判）
      const keep = S.start && S.periods.find(p => p.startDate === S.start);
      const ended = S.periods.filter(p => p.ended);
      const chosen = keep || ended.at(-1) || S.periods.at(-1) || null;
      selectPeriod(chosen ? chosen.startDate : null, { keepFilter: !!keep, fromLoad: true });
    } catch (e) {
      if (!valid(t)) return;
      fail(e, () => loadPeriods());
    }
  }
  function currentPeriod() { return (S.periods || []).find(p => p.startDate === S.start) || null; }
  function latestVersion(list) {
    return (list || []).slice().sort((a, b) => (a.generatedAt < b.generatedAt ? -1 : a.generatedAt > b.generatedAt ? 1 : a.revision - b.revision)).at(-1) || null;
  }
  function selectPeriod(start, { keepFilter = false } = {}) {
    bump();
    S.start = start; S.page = 1; S.expanded = new Set(); S.reviseOpen = false; S.caseNote = '';
    if (!keepFilter) S.filter = { hotel: '', staffId: '' };
    const p = currentPeriod();
    S.versions = p ? (p.versions || []) : [];
    const keepId = keepFilter && S.selectedId && S.versions.some(v => v.id === S.selectedId) ? S.selectedId : null;
    S.selectedId = keepId || latestVersion(S.versions)?.id || null;
    loadReport();
  }
  async function loadReport() {
    bump(); const t = token();
    S.display = null; S.displayKey = null; S.errorRetry = null; S.caseNote = '';
    const p = currentPeriod();
    if (!p) { S.phase = 'empty'; S.message = '這段時間沒有可選的期間。'; return render(); }
    if (!S.selectedId) { S.phase = 'no-report'; S.message = ''; return render(); }
    S.phase = 'loading'; S.message = '載入報告中…'; render();
    const id = S.selectedId, filter = { ...S.filter };
    try {
      let base = S.base.get(id);
      if (!base) {
        const env = await getJson(`${API}/${encodeURIComponent(id)}`);
        if (!valid(t)) return;
        base = buildDisplay(env, id);
        S.base.set(id, base);
      }
      let display = base;
      if (filter.hotel || filter.staffId) {
        const q = new URLSearchParams(); if (filter.hotel) q.set('hotel', filter.hotel); if (filter.staffId) q.set('staffId', filter.staffId);
        const env = await getJson(`${API}/${encodeURIComponent(id)}?${q}`);
        if (!valid(t)) return;
        if (!env || !env.view) throw shapeError();
        display = buildDisplay(env, id, base.payload);
      }
      S.display = display; S.displayKey = selectionKey(); S.phase = 'ready'; S.message = '';
      render();
    } catch (e) {
      if (!valid(t)) return;
      fail(e, () => loadReport());
    }
  }
  function fail(e, retry) {
    if (e?.authExpired || e?.status === 401) { teardown(); S.phase = 'auth'; S.message = '登入已過期，請重新登入。'; return render(); }
    if (e?.status === 403) { teardown(); S.phase = 'denied'; S.message = '沒有權限查看工作報告（僅限管理員）。'; return render(); }
    S.phase = 'error';
    S.message = e?.wrShape ? '伺服器回應格式異常，請重新整理再試。'
      : e?.status === 404 ? '找不到這個報告版本（可能已被全站重置清除），請重新整理。'
      : e?.status === 0 ? (e.timeout ? '讀取逾時，請檢查連線後重試。' : '無法連線到伺服器，請檢查網路後重試。')
      : e?.status >= 500 ? `伺服器暫時無法回應（HTTP ${e.status}），請稍後重試。`
      : (e?.data?.message || '讀取失敗，請重試。');
    S.errorRetry = retry; render();
  }

  // ── 寫入：產生初版／建立修訂版（不自動重送；結果不明時以完全相同的請求明確重試） ────────────────────────
  function newKey() {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return 'wr-' + c.randomUUID();
    const b = new Uint8Array(16); c.getRandomValues(b); return 'wr-' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  function startGenerate() {
    const p = currentPeriod();
    if (!p || !p.ended || S.busy || S.op || S.versions.length || preAvailability(p, S.coverage)?.block) return;
    send({ action: 'generate', url: `${API}/generate`, body: { periodKind: S.kind, startDate: p.startDate, idempotencyKey: newKey() }, ctx: { kind: S.kind, start: p.startDate } });
  }
  function submitRevision() {
    const target = latestVersion(S.versions);
    if (!target || S.busy || S.op) return;
    const reason = String(S.reviseDraft || '').trim();
    if (reason.length < 2) { S.opMessage = '請寫出具體的修訂原因（至少 2 個字）。'; return render(); }
    send({ action: 'revise', url: `${API}/${encodeURIComponent(target.id)}/revisions`, body: { reason, expectedLatestRevision: target.revision, idempotencyKey: newKey() },
      ctx: { kind: S.kind, start: S.start, parentId: target.id } });
  }
  async function send(op) {
    S.op = { ...op, state: 'sending', gen: S.gen, actor: actorKey() }; S.busy = true; S.opMessage = op.action === 'generate' ? '正在產生報告…' : '正在建立修訂版…'; render();
    const mine = S.op;
    const same = () => S.op === mine && mine.actor === actorKey();
    try {
      const r = await window.fetchJson('POST', mine.url, mine.body);
      if (!same()) return;
      // 2xx 但缺必要的 snapshot／id：不能當成功，保留原請求（同一識別碼）供明確重試
      const id = r?.snapshot?.id;
      if (typeof id !== 'string' || !/^wr_[0-9a-f-]{36}$/.test(id)) { settleFailure(mine, Object.assign(new Error('bad_response'), { status: 200, data: { error: 'bad_response' } })); return; }
      S.op = null; S.busy = false; S.reviseOpen = false; S.reviseDraft = '';
      if (typeof showToast === 'function') showToast(mine.action === 'generate' ? (r?.replayed ? '報告先前已建立（同一請求）' : '已產生本期報告') : (r?.replayed ? '修訂版先前已建立（同一請求）' : '已建立修訂版'));
      if (S.gen === mine.gen && S.kind === mine.ctx.kind && S.start === mine.ctx.start && viewNow() === VIEW && allowed()) await refreshVersions(id);
      else { S.opMessage = '已完成；切回該期間即可查看。'; if (viewNow() === VIEW && allowed()) render(); }
    } catch (e) {
      if (!same()) return;
      settleFailure(mine, e);
    }
  }
  function settleFailure(op, e) {
    const st = e?.status, code = e?.data?.error;
    const stay = () => { if (viewNow() === VIEW && allowed()) render(); };
    if (e?.authExpired || st === 401) { S.op = null; S.busy = false; teardown(); S.phase = 'auth'; S.message = '登入已過期，請重新登入；這次是否已建立需重新登入後查看版本。'; return stay(); }
    if (st === 403) { S.op = null; S.busy = false; teardown(); S.phase = 'denied'; S.message = '沒有權限產生或修訂報告（僅限在職管理員）。'; return stay(); }
    const unknown = st === 0 || st >= 500 || code === 'bad_response' || code === 'source_not_settled' || code === 'report_conflict';
    if (unknown) {
      op.state = 'unknown'; S.busy = false;
      S.opMessage = code === 'source_not_settled' ? '來源資料仍在寫入中，這次沒有建立。稍後請按「以同一請求重試」。'
        : code === 'report_conflict' ? '報告同時被其他操作更新，這次沒有保存。可按「以同一請求重試」或重新載入。'
        : (e?.timeout ? '請求逾時，結果不明。' : st >= 500 ? `伺服器錯誤（HTTP ${st}），結果不明。` : code === 'bad_response' ? '伺服器回應格式異常，結果不明。' : '連線中斷或回應異常，結果不明。') + '請按「以同一請求重試」（伺服器會以同一識別碼回放，不會重複建立），或重新載入查看。';
      return stay();
    }
    S.op = null; S.busy = false;
    S.opMessage = code === 'report_exists' ? '此期間已有初版報告（可能由其他主管或先前請求建立），這次沒有建立。請重新載入版本。'
      : code === 'not_latest_revision' || code === 'revision_conflict' ? '最新版本已變更，這次沒有建立修訂版。請重新載入後，對最新版本再修訂。'
      : code === 'idempotency_conflict' ? '操作識別碼衝突，這次沒有建立。請重新載入後再操作。'
      : code === 'period_not_ended' ? '期間尚未結束，不能產生報告。'
      : code === 'report_too_large' ? '報告內容超過上限，沒有保存。'
      : code === 'not_found' ? '找不到要修訂的版本（可能已被全站重置清除），請重新載入。'
      : st === 400 ? (e?.data?.message || '輸入格式不正確。')
      : (e?.data?.message || '操作失敗，請重新載入後再試。');
    if (['report_exists', 'not_latest_revision', 'revision_conflict', 'idempotency_conflict', 'not_found'].includes(code)) S.needsReload = true;
    stay();
  }
  function retryOp() {
    const op = S.op;
    if (!op || op.state !== 'unknown' || S.busy || op.actor !== actorKey()) return;
    send({ action: op.action, url: op.url, body: op.body, ctx: op.ctx });   // 完全相同的 url＋body＋識別碼
  }
  function abandonOp() { S.op = null; S.busy = false; S.opMessage = ''; S.needsReload = false; reloadVersions(); }
  async function refreshVersions(selectId) {
    bump(); const t = token();
    S.phase = 'loading'; S.message = '重新載入版本中…'; S.display = null; S.displayKey = null; render();
    try {
      const data = await getJson(`${API}?kind=${encodeURIComponent(S.kind)}&start=${encodeURIComponent(S.start)}`);
      if (!valid(t)) return;
      if (!data || !Array.isArray(data.versions)) throw shapeError();
      S.versions = data.versions;
      const p = currentPeriod(); if (p) p.versions = data.versions;
      S.selectedId = (selectId && S.versions.some(v => v.id === selectId)) ? selectId : (latestVersion(S.versions)?.id || null);
      S.opMessage = selectId && S.selectedId === selectId ? '' : S.opMessage;
      S.needsReload = false;
      loadReport();
    } catch (e) {
      if (!valid(t)) return;
      fail(e, () => refreshVersions(selectId));
    }
  }
  function reloadVersions() { if (S.start) refreshVersions(null); else loadPeriods(); }

  // ── 事件（委派在 view 上，安裝一次） ───────────────────────────────────────────────────────────
  function guard() {
    if (!allowed() || viewNow() !== VIEW) { deny(); return false; }
    if (S.actor !== actorKey()) { S = fresh(); enter(); return false; }   // 換人：舊畫面上的操作一律不執行
    return true;
  }
  function onClick(ev) {
    const el = ev.target?.closest ? ev.target.closest('[data-act]') : null;
    if (!el || el.disabled) return;
    if (!guard()) return;
    const act = el.dataset.act;
    if (act === 'kind') { if (S.kind !== el.dataset.kind) { S.kind = el.dataset.kind; S.start = null; S.selectedId = null; S.anchor = today(); loadPeriods(); } }
    else if (act === 'prev' || act === 'next') stepPeriod(act === 'prev' ? -1 : 1);
    else if (act === 'refresh') { S.base = new Map(); loadPeriods(); loadSched(); }
    else if (act === 'retry-load') { const fn = S.errorRetry; if (typeof fn === 'function') fn(); }
    else if (act === 'generate') startGenerate();
    else if (act === 'revise-open') { S.reviseOpen = true; S.opMessage = ''; render(); }
    else if (act === 'revise-cancel') { S.reviseOpen = false; S.opMessage = ''; render(); }
    else if (act === 'revise-submit') submitRevision();
    else if (act === 'op-retry') retryOp();
    else if (act === 'op-abandon' || act === 'reload-versions') abandonOp();
    else if (act === 'csv') exportCsv();
    else if (act === 'sort') { const k = el.dataset.key; S.sort = { key: k, dir: S.sort.key === k && S.sort.dir === 'ascending' ? 'descending' : 'ascending' }; S.page = 1; render(); }
    else if (act === 'page') { S.page = Math.max(1, Number(el.dataset.page) || 1); render(); }
    else if (act === 'expand') { const id = el.dataset.id; S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id); render(); }
    else if (act === 'open-case') openCurrentCase(el.dataset.id);
  }
  function onChange(ev) {
    const el = ev.target; if (!el?.dataset?.field) return;
    if (!guard()) return;
    const f = el.dataset.field;
    if (f === 'period') { if (el.value && el.value !== S.start) selectPeriod(el.value); }
    else if (f === 'version') { if (el.value && el.value !== S.selectedId) { S.selectedId = el.value; S.page = 1; S.expanded = new Set(); S.reviseOpen = false; loadReport(); } }
    else if (f === 'hotel') { S.filter = { ...S.filter, hotel: el.value }; S.page = 1; loadReport(); }
    else if (f === 'staff') { S.filter = { ...S.filter, staffId: el.value }; S.page = 1; loadReport(); }
    else if (f === 'jump') { if (/^\d{4}-\d{2}-\d{2}$/.test(el.value)) { S.anchor = el.value; S.start = null; S.selectedId = null; loadPeriods(); } }
  }
  function onInput(ev) { const el = ev.target; if (el?.dataset?.field === 'reason') { if (!guard()) return; S.reviseDraft = el.value; } }
  function stepPeriod(dir) {
    const list = S.periods || [], i = list.findIndex(p => p.startDate === S.start);
    if (i < 0) return;
    const j = i + dir;
    if (j >= 0 && j < list.length) return selectPeriod(list[j].startDate);
    if (dir < 0) { S.anchor = shiftDate(list[0].startDate, S.kind, -1); S.start = null; S.selectedId = null; return loadPeriods(); }
  }
  function openCurrentCase(id) {
    const list = typeof CASES !== 'undefined' && Array.isArray(CASES) ? CASES : [];
    const c = list.find(x => x && x.id === id);
    if (!c || typeof openDrawer !== 'function') { S.caseNote = `目前案件清單找不到 ${id}（可能已封存或刪除）；報告內容照原樣保存，不受影響。`; return render(); }
    S.caseNote = '';
    openDrawer(c);   // 開啟的是「目前案件」，不會改寫報告內容
  }
  function exportCsv() {
    if (S.phase !== 'ready' || !S.display || S.displayKey !== selectionKey()) return;
    const text = buildCsv(S.display), name = fileName(S.display);
    try {
      const blob = new Blob([text], { type: 'text/csv;charset=utf-8' }), url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { if (typeof showToast === 'function') showToast('匯出失敗，請重試', 'err'); }
  }

  // ── 畫面 ────────────────────────────────────────────────────────────────────────────────────
  function render() {
    const view = rootEl();
    if (!view || viewNow() !== VIEW || !allowed()) return;
    const focusKey = document.activeElement && view.contains?.(document.activeElement) ? document.activeElement.dataset?.focus : null;
    view.innerHTML = head() + schedLine() + controls() + `<div class="wr-status" role="status" aria-live="polite">${esc(statusLine())}</div>` + content();
    if (focusKey) view.querySelector(`[data-focus="${focusKey}"]`)?.focus?.();
  }
  function statusLine() {
    if (S.phase === 'loading') return S.message;
    // REPORTS-P3-E3a：選取期間／版本的可用性寫在選單外（窄螢幕的原生 select 會截斷 option 尾端）。
    if (S.phase === 'ready' && S.display) {
      const s = S.display.snapshot, a = versionAvailability({ sourceCompleteness: S.display.payload?.sourceCompleteness?.status || s.sourceCompleteness });
      return `已載入 ${s.label} ${s.revision === 1 ? '初版' : '修訂版 ' + s.revision}${S.display.filter ? '（篩選檢視）' : ''} · 可用性：${a.text}`;
    }
    if (S.phase === 'no-report') { const p = currentPeriod(); if (p) return `${p.label} · ${p.ended ? periodTag(p, S.coverage) || '尚未產生' : '期間尚未結束'}`; }
    return '';
  }
  function head() {
    return `<div class="wb-heading wr-head"><div><h1>${icon('report')}工作報告</h1><p class="wb-help">已保存的週報／月報／季報快照。期末狀態依期間結束時的資料，交付與進度依產生報告當下已知的資料；未知不以 0 表示。</p></div></div>`;
  }
  const PAUSE = { coverage_epoch_changed: '資料來源起點已改變，例如全站重置', clock_regressed: '資料庫時鐘異常' };
  const JOB_CODE = { source_not_settled: '資料異動尚未結束', source_clock_unreliable: '資料庫時鐘異常', source_coverage_missing: '缺少來源版本',
    report_too_large: '報告過大', report_timeout: '產生逾時', db_unavailable: '資料庫暫時無法連線', idempotency_conflict: '識別碼衝突',
    scheduler_epoch_changed: '排程已重新初始化', exhausted_lease_expired: '多次中斷' };
  const codeText = c => (!c ? '' : JOB_CODE[c] || (c.startsWith('exhausted_') ? `多次重試仍失敗：${JOB_CODE[c.slice(10)] || c.slice(10)}` : c));
  function schedLine() {
    const x = S.sched;
    if (!x) return '';
    if (x.error) return `<section class="wb-surface wr-sched" aria-label="自動彙整狀態"><p>${icon('info')}自動彙整狀態暫時無法讀取。</p></section>`;
    const d = x.data, st = d.state, items = [];
    if (!d.enabled) items.push(`${icon('clock')}<strong>自動彙整：${st ? '已停用' : '未啟用'}</strong>（${st ? '已產生的報告不受影響；' : ''}各期仍可手動產生）`);
    else if (!st) items.push(`${icon('clock')}<strong>自動彙整：已啟用</strong>，等待首次執行`);
    else if (st.status === 'paused') items.push(`${icon('alert')}<strong>自動彙整：已暫停</strong>（${esc(PAUSE[st.pausedReason] || st.pausedReason)}），需由維運重新初始化`);
    else if (!st.startDateMatches) items.push(`${icon('alert')}<strong>自動彙整：暫不執行</strong>（設定的起始日與已保存的不同，請聯絡維運）`);
    else {
      items.push(`${icon('check')}<strong>自動彙整：已啟用</strong>（每期結束後 00:05 產生初版，不覆蓋既有版本）`);
      if ((d.next || []).length) items.push(`下一次：${d.next.map(n => `${esc(KIND_LABEL[n.kind] || n.kind)} ${esc(n.label)}（${esc(showTime(n.dueAt))}）`).join('、')}`);
    }
    const done = (d.recent || []).find(j => j.status === 'succeeded' || j.status === 'skipped_existing');
    if (done) items.push(`最近：${esc(KIND_LABEL[done.periodKind] || done.periodKind)} ${esc(done.label)}${done.status === 'succeeded' ? ' 已自動產生' : ' 已有版本，略過'}`);
    const att = d.attention || [];
    const warn = att.length ? `<ul class="wr-sched-warn">${att.map(j => `<li>${icon('alert')}${esc(KIND_LABEL[j.periodKind] || j.periodKind)} ${esc(j.label)}：${j.status === 'blocked' ? '異常，需維運處理' : `重試中（第 ${j.attemptCount} 次，${esc(showTime(j.nextAttemptAt))} 再試）`}${j.lastErrorCode ? ` · ${esc(codeText(j.lastErrorCode))}` : ''}</li>`).join('')}</ul>` : '';
    return `<section class="wb-surface wr-sched" aria-label="自動彙整狀態"><p>${items.join('<span class="wr-sep" aria-hidden="true"> · </span>')}</p>${warn}</section>`;
  }
  function controls() {
    const p = currentPeriod(), list = S.periods || [], i = list.findIndex(x => x.startDate === S.start);
    const loading = S.phase === 'loading';
    const kinds = Object.entries(KIND_LABEL).map(([k, l]) => `<button type="button" class="wb-button" data-act="kind" data-kind="${k}" data-focus="kind-${k}" aria-pressed="${S.kind === k}">${l}</button>`).join('');
    const periodOpts = list.map(x => `<option value="${esc(x.startDate)}" ${x.startDate === S.start ? 'selected' : ''}>${esc(x.label)}（${esc(x.startDate)}${x.ended ? '' : '，進行中'}）${periodTag(x, S.coverage) ? ' · ' + esc(periodTag(x, S.coverage)) : ''}</option>`).join('');
    const versions = S.versions.slice().sort((a, b) => a.revision - b.revision || (a.generatedAt < b.generatedAt ? -1 : 1));
    const verOpts = versions.map(v => `<option value="${esc(v.id)}" ${v.id === S.selectedId ? 'selected' : ''}>${v.revision === 1 ? '初版' : '修訂版 ' + v.revision} · ${esc(showTime(v.generatedAt))}${v.revisionReason ? ' · ' + esc(v.revisionReason) : ''}${v.trigger === 'scheduled' ? ' · 系統自動彙整' : ''} · ${esc(versionAvailability(v).text)}</option>`).join('');
    const base = S.selectedId ? S.base.get(S.selectedId) : null, bp = base?.payload;
    const hotelOpts = bp ? bp.hotelOrder.map(h => `<option value="${esc(h.key)}" ${S.filter.hotel === h.key ? 'selected' : ''}>${esc(h.name || hotelGroupFallback(h.key))}${h.active === false ? '（停用）' : ''}${h.key.startsWith('unmatched:') ? '（未對應館名）' : ''}</option>`).join('') : '';
    const staffOpts = bp ? bp.staff.map(s => `<option value="${s.id}" ${String(S.filter.staffId) === String(s.id) ? 'selected' : ''}>${esc(s.name || '#' + s.id)}${s.active === false ? '（已停用）' : ''}${s.asOf === 'knowledge_cutoff' ? '（期後資料）' : ''}</option>`).join('') : '';
    const filterDisabled = !bp || loading || bp.sourceCompleteness?.status === 'insufficient';
    const latest = latestVersion(S.versions);
    let primary;
    if (!p) primary = '';
    else if (!S.versions.length) {
      const pre = preAvailability(p, S.coverage);
      const why = !p.ended ? `期間尚未結束（${esc(p.endDateExclusive)} 起才能產生）` : pre.state === 'insufficient' ? '本期早於歷史追蹤起點，產生只會是資料不足'
        : pre.state === 'no_coverage' ? '尚未建立歷史追蹤起點' : pre.state === 'partial' ? '預計部分可重建（只有已知部分）' : '';
      primary = `<button type="button" class="wb-button wr-primary" data-act="generate" data-focus="generate" ${pre.block || S.busy || S.op || loading ? 'disabled' : ''}>${icon('plus')}產生本期報告</button>${why ? `<span class="wb-help wr-why">${why}</span>` : ''}`;
    }
    else primary = `<button type="button" class="wb-button wr-primary" data-act="revise-open" data-focus="revise-open" ${S.busy || S.op || loading || S.reviseOpen ? 'disabled' : ''}>${icon('plus')}建立修訂版</button>`;
    const csvReady = S.phase === 'ready' && S.display && S.displayKey === selectionKey();
    return `<section class="wb-surface wr-controls" aria-label="選擇報告">
      <div class="wr-row"><div class="wr-kinds" role="group" aria-label="報告類型">${kinds}</div>
        <div class="wr-period"><button type="button" class="wb-button" data-act="prev" data-focus="prev" aria-label="上一期" ${loading || i < 0 ? 'disabled' : ''}>‹</button>
        <label class="wr-field"><span>期間</span><select data-field="period" data-focus="period" ${loading || !list.length ? 'disabled' : ''}>${periodOpts || '<option value="">（載入中）</option>'}</select></label>
        <button type="button" class="wb-button" data-act="next" data-focus="next" aria-label="下一期" ${loading || i < 0 || i >= list.length - 1 ? 'disabled' : ''}>›</button>
        <label class="wr-field"><span>跳至日期</span><input type="date" data-field="jump" data-focus="jump" value="${esc(S.anchor || '')}" ${loading ? 'disabled' : ''}></label></div></div>
      <div class="wr-row"><label class="wr-field wr-grow"><span>版本</span><select data-field="version" data-focus="version" ${loading || !versions.length ? 'disabled' : ''}>${verOpts || '<option value="">尚無報告</option>'}</select></label>
        <label class="wr-field"><span>${icon('filter')}館別</span><select data-field="hotel" data-focus="hotel" ${filterDisabled ? 'disabled' : ''}><option value="">全部館別</option>${hotelOpts}</select></label>
        <label class="wr-field"><span>${icon('filter')}參與案件（期末指派：主責或協作）</span><select data-field="staff" data-focus="staff" ${filterDisabled ? 'disabled' : ''}><option value="">全部人員</option>${staffOpts}</select></label></div>
      <div class="wr-row wr-actions">${primary}
        <button type="button" class="wb-button" data-act="refresh" data-focus="refresh" ${loading ? 'disabled' : ''}>${icon('refresh')}重新整理</button>
        <button type="button" class="wb-button" data-act="csv" data-focus="csv" ${csvReady ? '' : 'disabled'} title="匯出目前版本與篩選的全部結果">${icon('download')}匯出 CSV（全部篩選結果）</button></div>
      ${opPanel(latest)}
    </section>`;
  }
  function opPanel(latest) {
    const parts = [];
    if (S.reviseOpen && latest && !S.op) {
      parts.push(`<div class="wr-revise"><label class="wr-field wr-grow"><span>修訂原因（必填，請寫出具體原因）</span><textarea data-field="reason" data-focus="reason" rows="2" maxlength="500">${esc(S.reviseDraft)}</textarea></label>
        <p class="wb-help">將以目前最新版本（${latest.revision === 1 ? '初版' : '修訂版 ' + latest.revision}）為基礎建立新版本；舊版本內容與雜湊不會改變。</p>
        ${latest.sourceCompleteness === 'insufficient' ? `<p class="wb-help wr-avail-note">${icon('alert')}這份報告資料不足，是因為本期期末早於歷史追蹤起點；建立修訂版不會還原當時沒有記錄的期末狀態。</p>`
          : latest.sourceCompleteness === 'partial' ? `<p class="wb-help wr-avail-note">${icon('alert')}這份報告只有部分可重建；建立修訂版不會補回歷史追蹤起點之前沒有記錄的資料。</p>` : ''}
        <div class="wr-row"><button type="button" class="wb-button wr-primary" data-act="revise-submit" data-focus="revise-submit" ${S.busy ? 'disabled' : ''}>送出修訂</button><button type="button" class="wb-button" data-act="revise-cancel" data-focus="revise-cancel" ${S.busy ? 'disabled' : ''}>取消</button></div></div>`);
    }
    if (S.op && S.op.state === 'unknown') parts.push(`<div class="wr-row"><button type="button" class="wb-button wr-primary" data-act="op-retry" data-focus="op-retry">${icon('refresh')}以同一請求重試</button><button type="button" class="wb-button" data-act="op-abandon" data-focus="op-abandon">重新載入版本</button></div>`);
    else if (S.needsReload && !S.op) parts.push(`<div class="wr-row"><button type="button" class="wb-button" data-act="reload-versions" data-focus="reload-versions">${icon('refresh')}重新載入版本</button></div>`);
    const msg = S.opMessage ? `<p class="wr-op-msg">${icon(S.op?.state === 'unknown' ? 'alert' : 'info')}${esc(S.opMessage)}</p>` : '';
    return `<div class="wr-op" role="status" aria-live="polite">${msg}${parts.join('')}</div>`;
  }
  function content() {
    if (S.phase === 'loading' || S.phase === 'idle') return `<div class="wb-surface wr-state">${icon('clock')}${esc(S.message || '載入中…')}</div>`;
    if (S.phase === 'error') return `<div class="wb-surface wr-state wr-error" role="alert">${icon('alert')}${esc(S.message)} <button type="button" class="wb-button" data-act="retry-load" data-focus="retry-load">重試</button></div>`;
    if (S.phase === 'auth' || S.phase === 'denied') return `<div class="wb-surface wr-state wr-error" role="alert">${icon('alert')}${esc(S.message)}</div>`;
    if (S.phase === 'empty') return `<div class="wb-surface wr-state">${icon('info')}${esc(S.message)}</div>`;
    if (S.phase === 'no-report') {
      const p = currentPeriod();
      if (!p || !p.ended) return `<div class="wb-surface wr-state">${icon('info')}這個期間尚未結束，結束後才能產生報告。</div>`;
      const pre = preAvailability(p, S.coverage);
      if (pre.block) return `<div class="wb-surface wr-state wr-avail wr-avail-${esc(pre.state)}">${icon('alert')}這個期間尚未產生報告。${esc(pre.text)}</div>`;
      return `<div class="wb-surface wr-state wr-avail wr-avail-${esc(pre.state)}">${icon('info')}這個期間尚未產生報告。按「產生本期報告」建立初版。${pre.text ? `<p class="wb-help">${esc(pre.text)}</p>` : ''}</div>`;
    }
    if (S.phase !== 'ready' || !S.display) return '';
    const d = S.display, p = d.payload;
    return overview(d) + charts(p) + table(p) + unresolved(p) + (S.caseNote ? `<p class="wr-op-msg" role="status">${icon('info')}${esc(S.caseNote)}</p>` : '');
  }
  function overview(d) {
    const s = d.snapshot, p = d.payload, sc = p.sourceCompleteness || {}, sum = p.summary || {};
    const insufficient = sc.status === 'insufficient';
    const status = `<div class="wr-complete wr-complete-${esc(sc.status)}">${icon(sc.status === 'complete' ? 'check' : 'alert')}<div><strong>${esc(COMPLETENESS[sc.status] || sc.status)}</strong>
      ${(sc.reasons || []).length ? `<ul>${sc.reasons.map(r => `<li>${esc(REASONS[r] || r)}</li>`).join('')}</ul>` : ''}
      ${insufficient ? '<p>期末來源資料不足：沒有可重建的明細，所有數字為未知，<b>不代表這期沒有工作</b>。</p>' + insufficientNote(s, sc) : sc.status === 'partial' ? '<p>只顯示可證明的「已知部分」，不是完整總數。</p>' : '<p>來源版本涵蓋整個期間；舊制案件的數量仍可能是未知。</p>'}
      ${(sc.deletedCaseIds || []).length ? `<p>期間內被刪除的案件：${esc(sc.deletedCaseIds.join('、'))}</p>` : ''}</div></div>`;
    const meta = `<dl class="wr-meta">
      <div><dt>期間</dt><dd>${esc(s.label)}（${esc(s.startDate)} 至 ${esc(s.endDateExclusive)} 前）</dd></div>
      <div><dt>版本</dt><dd>${s.revision === 1 ? '初版' : '修訂版 ' + s.revision}${s.revisionReason ? '：' + esc(s.revisionReason) : ''}</dd></div>
      <div><dt>期末狀態依據（C）</dt><dd title="${esc(s.cutoffInstant)}">${esc(showTime(s.cutoffInstant))} 的資料</dd></div>
      <div><dt>交付與進度依據（K）</dt><dd title="${esc(s.knowledgeCutoff)}">${esc(showTime(s.knowledgeCutoff))} 已知的資料${s.knowledgeCutoff !== s.cutoffInstant ? '（含期後補登／更正，已逐筆標示）' : ''}</dd></div>
      <div><dt>產生</dt><dd>${esc(showTime(s.generatedAt))} · ${s.trigger === 'scheduled' ? '系統自動彙整' : '管理員手動' + (s.generatedByName ? '（' + esc(s.generatedByName) + '）' : '')}</dd></div>
      ${d.filter ? `<div><dt>篩選</dt><dd>${esc(filterText(d.filter, d))}（人員篩選為參與案件，不是個人產出分攤）</dd></div>` : ''}
      <div><dt>雜湊</dt><dd class="wr-hash">原版本 ${esc(String(d.payloadSha256 || '').slice(0, 12))}…${d.viewSha256 ? ` · 篩選檢視 ${esc(String(d.viewSha256).slice(0, 12))}…` : ''}</dd></div></dl>`;
    const card = (label, m) => { const t = countText(m); return `<div class="wr-card"><small>${esc(label)}</small><strong>${esc(t.value)}</strong>${t.note ? `<span class="wr-note">${esc(t.note)}</span>` : ''}</div>`; };
    const deliveries = insufficient ? '' : (sum.deliveries?.period || []).map(g => card(`本期 ${kindLabel(g.kind, g.unit)}`, { total: g.total, knownSubtotal: g.knownSubtotal })).join('');
    const cards = `<div class="wr-cards">${card('列入案件', sum.caseCount)}${card('本期完成', sum.completedInPeriod)}${deliveries}
      ${!insufficient && !(sum.deliveries?.period || []).length ? `<div class="wr-card"><small>本期交付</small><strong>${sum.deliveries?.status === 'complete' ? '0' : '—'}</strong><span class="wr-note">${sum.deliveries?.status === 'complete' ? '沒有交付紀錄' : '沒有已知紀錄（另有未知）'}</span></div>` : ''}</div>`;
    return `<section class="wb-surface wr-overview" aria-label="報告摘要">${status}${meta}${cards}</section>`;
  }
  function insufficientNote(s, sc) {
    const cov = sc.coverageStart || s.coverageStart;
    const when = cov ? `歷史追蹤起點是 ${esc(showTime(cov))}（台北時間），晚於本期期末 ${esc(showTime(s.cutoffInstant))}。` : '歷史追蹤起點晚於本期期末。';
    return `<p>${when}系統從起點之後才逐筆記錄案件的變化，所以無法還原本期期末當時的狀態。</p>
      <p>原案件資料仍保留在系統中，沒有遺失。這份報告與 CSV 照原樣保留供追溯；之後再建立修訂版，也無法還原當時沒有記錄的期末狀態。</p>`;
  }
  function bars(items, caption, emptyText) {
    if (!items.length) return `<figure class="wr-chart"><figcaption>${esc(caption)}</figcaption><p class="wb-help">${esc(emptyText)}</p></figure>`;
    const max = Math.max(1, ...items.map(x => x.value));
    return `<figure class="wr-chart"><figcaption>${esc(caption)}</figcaption><ul class="wr-bars">${items.map(x => `<li><span class="wr-bar-label">${esc(x.label)}</span>
      <span class="wr-bar-track" aria-hidden="true">${x.value > 0 ? `<span class="wr-bar wr-bar-${esc(x.tone || 'a')}" style="width:${Math.max(2, Math.round((x.value / max) * 100))}%"></span>` : ''}</span>
      <span class="wr-bar-value">${esc(String(x.value))}${x.note ? `<small>${esc(x.note)}</small>` : ''}</span></li>`).join('')}</ul>
      <details class="wr-alt"><summary>以表格檢視</summary><table><thead><tr><th scope="col">項目</th><th scope="col">數值</th><th scope="col">說明</th></tr></thead><tbody>${items.map(x => `<tr><th scope="row">${esc(x.label)}</th><td>${esc(String(x.value))}</td><td>${esc(x.note || '')}</td></tr>`).join('')}</tbody></table></details></figure>`;
  }
  function charts(p) {
    if (p.sourceCompleteness?.status === 'insufficient') return `<section class="wb-surface wr-charts" aria-label="圖表"><p class="wb-help">${icon('alert')}期末來源資料不足，不繪製圖表（不是零產出）。</p></section>`;
    const del = p.summary?.deliveries || {};
    const dItems = (del.period || []).map(g => ({ label: kindLabel(g.kind, g.unit), value: g.total ?? g.knownSubtotal ?? 0, note: g.total == null ? '已知部分' : '', tone: g.kind === 'main' ? 'a' : g.kind === 'extension' ? 'b' : 'c' }));
    const counts = new Map();
    for (const r of p.rows || []) { const k = r.endState?.kind || 'unknown'; counts.set(k, (counts.get(k) || 0) + 1); }
    const order = ['open', 'completed', 'sealed_incomplete', 'archived_not_completed', 'cancelled', 'not_recorded_at_cutoff'];
    const sItems = [...counts.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([k, n]) => ({ label: END_KIND[k] || k, value: n, tone: k === 'completed' ? 'a' : k === 'open' ? 'b' : 'c' }));
    const unres = (p.unresolved || []).length;
    return `<section class="wb-surface wr-charts" aria-label="圖表">
      ${bars(dItems, '本期交付（依種類與單位，不跨單位相加）', del.status === 'complete' ? '本期沒有交付紀錄。' : '沒有已知交付紀錄（另有未知）。')}
      ${bars(sItems, `列入案件的期末狀態${unres ? `（另有 ${unres} 件無法確認在辦，未列入）` : ''}`, '沒有列入的案件。')}</section>`;
  }
  function table(p) {
    const name = hotelNamer(p);
    const rows = orderedRows(p, p.rows || [], S.sort.key, S.sort.dir);
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)); if (S.page > pages) S.page = pages;
    const pageRows = rows.slice((S.page - 1) * PAGE_SIZE, S.page * PAGE_SIZE);
    const sortTh = (key, label) => `<th scope="col" aria-sort="${S.sort.key === key ? S.sort.dir : 'none'}"><button type="button" class="wr-sort" data-act="sort" data-key="${key}" data-focus="sort-${key}">${label}<span aria-hidden="true">${S.sort.key === key ? (S.sort.dir === 'ascending' ? ' ▲' : ' ▼') : ''}</span></button></th>`;
    let body = '', group = null;
    for (const r of pageRows) {
      if (r.hotel?.groupKey !== group) {
        group = r.hotel?.groupKey;
        const h = (p.hotelOrder || []).find(x => x.key === group), n = rows.filter(x => x.hotel?.groupKey === group).length;
        body += `<tr class="wr-group"><th scope="colgroup" colspan="7">${esc(name(r.hotel))}${h?.active === false ? ' <small>（停用館別）</small>' : ''}${r.hotel?.match === 'unmatched' ? ' <small>（未對應館名，保留原值）</small>' : ''} <small>· ${n} 件</small></th></tr>`;
      }
      body += rowHtml(r);
      if (S.expanded.has(r.id)) body += `<tr class="wr-detail" id="wr-detail-${esc(r.id)}"><td colspan="7">${detail(r)}</td></tr>`;
    }
    const used = new Set(rows.map(r => r.hotel?.groupKey));
    const emptyHotels = (p.hotelOrder || []).filter(h => !used.has(h.key) && h.key.startsWith('hotel:'));
    const pager = pages > 1 ? `<nav class="wb-pager" aria-label="明細分頁"><button type="button" class="wb-button" data-act="page" data-page="${S.page - 1}" data-focus="page-prev" ${S.page <= 1 ? 'disabled' : ''}>‹ 上一頁</button><span class="wb-page-now" aria-current="page">第 ${S.page} / ${pages} 頁（共 ${rows.length} 件）</span><button type="button" class="wb-button" data-act="page" data-page="${S.page + 1}" data-focus="page-next" ${S.page >= pages ? 'disabled' : ''}>下一頁 ›</button></nav>` : '';
    return `<section class="wb-surface wr-ledger" aria-label="報告明細"><h2>案件明細（依館別）</h2>
      ${rows.length ? `<div class="wr-table-wrap" role="region" aria-label="報告明細表（可左右捲動）" tabindex="0"><table class="wr-table"><thead><tr>${sortTh('id', '案件')}<th scope="col">主責／協作</th><th scope="col">本期進度</th>${sortTh('endState', '期末狀態')}<th scope="col">本期產出</th><th scope="col">下一步</th><th scope="col"><span class="wr-sr">詳情</span></th></tr></thead><tbody>${body}</tbody></table></div>${pager}`
        : `<p class="wb-help">${icon('info')}沒有列入的案件${p.sourceCompleteness?.status === 'insufficient' ? '（期末來源資料不足，不代表沒有工作）' : ''}。</p>`}
      ${emptyHotels.length ? `<p class="wb-help">本期沒有列入案件的館別：${emptyHotels.map(h => esc(h.name) + (h.active === false ? '（停用）' : '')).join('、')}</p>` : ''}</section>`;
  }
  function rowHtml(r) {
    const a = r.assignment || {}, d = r.deliveries || {};
    const prog = r.progress || [], late = prog.filter(e => e.knowledge && e.knowledge !== 'as_of_cutoff').length, last = prog.at(-1);
    const outputs = d.status === 'unknown' ? '未知（舊制，期間不明）' : d.status === 'none_recorded' ? '本期無交付紀錄' : totalsText(d.period?.totals) + (d.status === 'partial' ? '；另有舊制未知' : '');
    const kOnly = r.identityBasis === 'knowledge_cutoff';
    return `<tr class="wr-row-case${kOnly ? ' wr-konly' : ''}"><td><span class="wr-id">${esc(r.id)}</span><span class="wr-title">${esc(r.title || '')}</span>${kOnly ? '<span class="wr-badge">期後補登</span>' : ''}</td>
      <td>${a.designer ? esc(a.designer.name || '#' + a.designer.id) : '—'}${(a.collaborators || []).length ? `<small>協作：${esc(personNames(a.collaborators))}</small>` : ''}${a.basis === 'knowledge_cutoff' ? '<small>（依知識截止）</small>' : ''}</td>
      <td>${prog.length ? `${prog.length} 筆${last?.note ? `<small>${esc(String(last.note).slice(0, 60))}</small>` : ''}${late ? `<small class="wr-late">含期後標示 ${late} 筆</small>` : ''}` : '—'}</td>
      <td>${esc(END_KIND[r.endState?.kind] || r.endState?.kind || '')}${r.completion?.state === 'yes' ? '<small>本期完成</small>' : ''}</td>
      <td>${esc(outputs)}</td><td>${esc(r.nextStep?.label || '')}</td>
      <td><button type="button" class="wb-button wr-expand" data-act="expand" data-id="${esc(r.id)}" data-focus="expand-${esc(r.id)}" aria-expanded="${S.expanded.has(r.id)}" aria-controls="wr-detail-${esc(r.id)}">${icon('chevron')}詳情<span class="wr-sr">：${esc(r.id)}</span></button></td></tr>`;
  }
  function detail(r) {
    const d = r.deliveries || {}, sch = r.schedule, out = [];
    if (r.identityBasis === 'knowledge_cutoff') out.push(`<p class="wr-op-msg">${icon('info')}此案在期末（C）尚無紀錄，是之後補登的案件；名稱與指派取自知識截止（K），不代表期末狀態。</p>`);
    if (sch) {
      out.push(`<h3>時程（期末）</h3><ul>${MILESTONES.map(([k, l]) => `<li>${l}：${esc(sch.official?.[k] || '—')}</li>`).join('')}</ul>`);
      if (sch.observedAtAdoption) out.push(`<p class="wb-help">導入時觀測：${MILESTONES.map(([k, l]) => `${l} ${esc(sch.observedAtAdoption[k] || '—')}`).join('、')}（導入當下觀測到的日期，不是歷史原始承諾）</p>`);
    }
    if ((r.scheduleChanges || []).length) out.push(`<h3>本期時程變更</h3><ul>${r.scheduleChanges.map(c => `<li>${esc(c.field)}：${esc(c.fromValue || '—')} → ${esc(c.toValue || '—')}；原因：${esc(c.reason || '—')}（${esc(KNOWLEDGE[c.knowledge] || c.knowledge)}）</li>`).join('')}</ul>`);
    if ((r.progress || []).length) out.push(`<h3>本期進度</h3><ul>${r.progress.map(e => `<li>${esc(e.date)} ${e.itemName ? `［${esc(e.itemName)}］` : ''}${esc(e.note ?? '')}${e.by ? ` — ${esc(e.by)}` : ''} <span class="wr-k">${esc(KNOWLEDGE[e.knowledge] || e.knowledge)}</span></li>`).join('')}</ul>`);
    if (r.undatedLogCount) out.push(`<p class="wb-help">另有 ${r.undatedLogCount} 筆日期無效或缺日期的日誌，未計入本期。</p>`);
    const recs = d.period?.records || [];
    out.push(`<h3>本期交付紀錄</h3>${recs.length ? `<ul>${recs.map(x => `<li>${esc(OUTPUT_KIND[x.kind] || x.kind)} ${esc(String(x.quantity))} ${esc(x.unit)} · ${esc(x.itemName || '')} · ${esc(x.deliveredOn)} <span class="wr-k">${esc(KNOWLEDGE[x.knowledge] || x.knowledge)}</span>${x.cycleAttribution === 'unknown' ? ' <small>（週期歸屬不明）</small>' : ''}${x.zeroSupport ? `<br><small>支援 0：${esc(x.zeroSupport.note || '（未填原因）')}；${esc(ZERO[x.zeroSupport.status] || x.zeroSupport.status)}</small>` : ''}</li>`).join('')}</ul>` : `<p class="wb-help">${esc(DELIVERY_STATUS[d.status] || '—')}</p>`}`);
    if ((d.voidedAfterCutoff || []).length) out.push(`<h3>期後作廢（未計入本版本）</h3><ul>${d.voidedAfterCutoff.map(v => `<li>${esc(v.id)} ${esc(OUTPUT_KIND[v.kind] || v.kind)} ${esc(String(v.quantity))} ${esc(v.unit)}${v.voidReason ? '：' + esc(v.voidReason) : ''}</li>`).join('')}</ul>`);
    if ((d.cumulativeToEnd?.totals || []).length) out.push(`<p class="wb-help">累計至期末：${esc(totalsText(d.cumulativeToEnd.totals))}（不含期末之後的交付）</p>`);
    if (d.legacyCounts) out.push(`<p class="wb-help">舊制總數（期間歸屬未知，未加入本期）：需求數 ${d.legacyCounts.requestCount ?? '未知'}、產出數 ${d.legacyCounts.outputCount ?? '未知'}</p>`);
    if ((r.limitations || []).length) out.push(`<h3>限制</h3><ul>${r.limitations.map(x => `<li>${esc(LIMITS[x] || x)}</li>`).join('')}</ul>`);
    out.push(`<button type="button" class="wb-button" data-act="open-case" data-id="${esc(r.id)}" data-focus="open-${esc(r.id)}">查看目前案件<span class="wr-sr">：${esc(r.id)}（開啟目前資料，不會改變這份報告）</span></button>`);
    return `<div class="wr-detail-body">${out.join('')}</div>`;
  }
  function unresolved(p) {
    const list = orderedRows(p, p.unresolved || []);
    if (!list.length) return '';
    const name = hotelNamer(p);
    return `<section class="wb-surface wr-unresolved" aria-label="未能確認在辦的案件"><h2>${icon('alert')}未能確認期間在辦的案件（${list.length} 件，未列入明細，使總數維持未知）</h2>
      <ul>${list.map(u => `<li><span class="wr-id">${esc(u.id)}</span> ${esc(u.title || '')} · ${esc(name(u.hotel))} · ${esc(BASIS[u.activity?.basis] || u.activity?.basis || '')}</li>`).join('')}</ul></section>`;
  }
})();
