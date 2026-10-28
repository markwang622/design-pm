/* REPORTS-P2-D2 時程與週期：D1a 改期申請／主管決議、D1b 未完成封存／原案號復工的操作畫面，以及受控案件的寫入綁定。
 * - 掛在最外層 openDrawer 之後（B、C2 之後），等既有權限與歷史唯讀 sweep 完成才渲染；本區自行判斷可操作狀態。
 * - 權限一律以真實登入者 ME.id／ME.role 與穩定的主責／協作者 ID 判斷；view-as 與姓名不會擴大權限。
 * - 每個寫入都帶「使用者看到的那一份快照」的 expectedUpdatedAt＋expectedContentVersion（＋受控週期 expectedCycleId），
 *   從不在送出前另抓最新版本替換；結果不明時保留完全相同的請求，必須「重新確認送出」（伺服器以同一識別碼回放）。
 * - 非同步回覆綁定「原案件＋原登入者＋抽屜世代＋DOM」，切案或延遲回覆不會畫到別案。
 * - 舊制案件不會因模組載入而自動導入；導入只由管理者明確操作。
 */
(() => {
  if (window.__caseLifecycleInstalled) return;
  window.__caseLifecycleInstalled = true;

  const MILESTONES = [['dispatchDate', '派發日', true], ['copyDate', '文案日', false], ['printDate', '送印日', false], ['goLiveDate', '上線日', true]];
  const LIFE_LABEL = { active: '進行中', sealed_incomplete: '未完成封存', completed: '已結案', cancelled: '已取消' };
  const REQ_STATUS = { pending: '待主管決議', approved: '已核准', rejected: '已退回', withdrawn: '已撤回', invalidated: '已失效' };
  const KIND_LABEL = { seal: '未完成封存申請', resume: '復工申請', schedule: '改期申請' };
  const OUTCOME_LABEL = { sealed_incomplete: '未完成封存', completed: '已結案', cancelled: '已取消' };
  const OUTPUT_KIND = { main: '主設計', extension: '延伸', support: '支援' };
  const STORE_PREFIX = 'dpm.lifecycle.v1:';
  const MSG = {
    ambiguous: '連線不穩，無法確認是否已送出。內容已保留，請按「重新確認送出」；伺服器會以同一識別碼確認，不會重複建立。',
    conflict: '案件內容已被更新，這次沒有寫入。你的輸入已保留，請按「重新讀取」檢視最新內容後再確認。',
    clientUpdate: '畫面版本過舊，請重新整理頁面後再操作；你的輸入已保留。',
    generic: '操作失敗，你的輸入已保留，請稍後再試。',
    loadFail: '讀取失敗，請按「重新讀取」。',
    stale: '這個案件剛有其他內容儲存（例如交付紀錄），上方摘要與版本已過期，這次沒有送出。你的輸入已保留；請按「重新讀取摘要」確認最新內容後再送出。',
    itemsDirty: '子案件有尚未儲存的變更，這次沒有送出（送出後會重新開啟抽屜）。請先在「📋 子案件」按「💾 儲存子案件」，或按下方「放棄子案件變更」後再送出。',
  };

  const esc = value => (typeof escapeHtml === 'function' ? escapeHtml(value) : String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));
  const seqNow = () => (window.v95DrawerSeq && typeof window.v95DrawerSeq.now === 'function' ? window.v95DrawerSeq.now() : 0);
  const me = () => (typeof ME !== 'undefined' && ME && ME.id != null && ME.id !== 0 ? ME : null);
  const sameId = (a, b) => a != null && b != null && a !== '' && b !== '' && String(a) === String(b);
  const enc = id => encodeURIComponent(id);
  const toast = (m, t) => { try { if (typeof showToast === 'function') showToast(m, t); } catch {} };
  const newId = prefix => { let core; try { core = crypto.randomUUID(); } catch { core = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12); } return (prefix + '-' + core).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100); };
  const when = iso => { if (!iso) return '—'; try { return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)); } catch { return String(iso).slice(0, 16).replace('T', ' '); } };
  const day = v => (v ? String(v).slice(0, 10) : null);
  const casesList = () => (typeof CASES !== 'undefined' && Array.isArray(CASES) ? CASES : []);
  const isManaged = c => !!c && (c.lifecycleMode === 'managed' || c.scheduleMode === 'managed');

  // ── drafts（真實登入者 ID＋案件＋週期＋操作；sessionStorage 失敗改記憶體）──────────────
  const memory = new Map();
  const store = () => { try { const s = window.sessionStorage; if (!s) return null; s.setItem(STORE_PREFIX + 'p', '1'); s.removeItem(STORE_PREFIX + 'p'); return s; } catch { return null; } };
  const dkey = (u, c, op) => `${STORE_PREFIX}${u}:${c}:${op}`;
  function readDraft(u, c, op) {
    const k = dkey(u, c, op), ok = d => (d && sameId(d.userId, u) && d.caseId === c && d.op === op ? d : null);
    const s = store(); if (s) { try { const d = ok(JSON.parse(s.getItem(k) || 'null')); if (d) return d; } catch {} }
    return ok(memory.get(k)) || null;
  }
  function writeDraft(d) { const k = dkey(d.userId, d.caseId, d.op); memory.set(k, JSON.parse(JSON.stringify(d))); const s = store(); if (s) { try { const t = JSON.stringify(d); if (t.length < 8000) s.setItem(k, t); } catch {} } }
  function clearDraft(u, c, op) { const k = dkey(u, c, op); memory.delete(k); const s = store(); if (s) { try { s.removeItem(k); } catch {} } }

  // ── identity ───────────────────────────────────────────────────────────────────────────
  function access(c) {
    const actor = me();
    const readonly = !actor || actor.role === 'observer' || (typeof IS_OBSERVER === 'function' && IS_OBSERVER());
    const isAdmin = !readonly && actor.role === 'admin';
    const assigned = !!actor && !!c && (sameId(c._designerId, actor.id) || (Array.isArray(c._collaboratorIds) && c._collaboratorIds.some(x => sameId(x, actor.id))));
    return { actor, readonly, isAdmin, canRequest: !readonly && (isAdmin || assigned) };
  }

  // ── view ───────────────────────────────────────────────────────────────────────────────
  let active = null;
  const flashes = new Map();
  function isCurrent(v) {
    if (!v || active !== v || !v.root || v.root.isConnected === false || v.gen !== seqNow()) return false;
    if (typeof currentCase !== 'undefined' && currentCase && currentCase.id !== v.caseId) return false;
    const a = me(); return !!a && sameId(a.id, v.userId);
  }
  function ensureRoot() {
    let root = document.getElementById('d-lifecycle');
    if (root) return root;
    const anchor = document.getElementById('d-workflow') || document.getElementById('d-deliveries') || document.getElementById('d-archive');
    if (!anchor || !anchor.parentNode) return null;
    root = document.createElement('section'); root.id = 'd-lifecycle'; root.className = 'cl-root'; root.setAttribute('aria-labelledby', 'cl-title');
    const parent = anchor.parentNode, kids = Array.isArray(parent.children) ? parent.children : Array.from(parent.children || []);
    parent.insertBefore(root, kids[kids.indexOf(anchor) + 1] || null);
    return root;
  }
  function onOpened(c, gen) {
    const actor = me();
    if (!c || !c.id || !actor || gen !== seqNow()) return;
    if (typeof currentCase !== 'undefined' && currentCase && currentCase.id !== c.id) return;
    const root = ensureRoot(); if (!root) return;
    root.hidden = false;
    const v = { c, caseId: c.id, userId: actor.id, gen, root, sched: null, life: null, schedHidden: false, lifeHidden: false, loading: true, loadError: '', panel: null, rid: null, values: {}, errors: null, busy: false, pending: null, msg: '', msgKind: '', live: '', liveKind: '' };
    active = v;
    const f = flashes.get(`${v.userId}:${v.caseId}`); if (f) { flashes.delete(`${v.userId}:${v.caseId}`); v.live = f.msg; v.liveKind = f.kind; }
    wire(v); render(v); load(v);
  }
  // quiet: background resync after another writer saved — keep showing the current summary until the new read lands.
  async function load(v, { quiet = false } = {}) {
    const seq = v.loadSeq = (v.loadSeq || 0) + 1, writes = v.writeSeq || 0;
    if (!quiet) { v.loading = true; v.loadError = ''; if (isCurrent(v)) render(v); }
    const get = async path => { try { return { data: await fetchJson('GET', path) }; } catch (e) { return { error: e }; } };
    const [s, l] = await Promise.all([get(`/api/cases/${enc(v.caseId)}/schedule-requests`), get(`/api/cases/${enc(v.caseId)}/lifecycle`)]);
    if (!isCurrent(v) || seq !== v.loadSeq) return;   // a newer read (or another drawer) owns the view; an older reply never overwrites it
    v.syncing = false;
    if (quiet && (s.error || l.error) && (v.life || v.sched)) { v.stale = true; render(v); return; }   // keep the shown snapshot, but say it is out of date
    if (v.writeSeq === writes) v.stale = false;   // still stale if another write landed while this read was in flight
    const hidden = r => r.error && r.error.status === 404 && r.error.data && r.error.data.error === 'feature_disabled';
    v.sched = s.data || null; v.schedHidden = hidden(s); v.life = l.data || null; v.lifeHidden = hidden(l);
    v.loading = false;
    if ((s.error && !v.schedHidden) || (l.error && !v.lifeHidden)) v.loadError = MSG.loadFail;
    applyPendingFreeze(v);
    // The items editor asks lifeSnapshot() on every render and mutation; re-render it once this fresher read is in.
    if (v.life && v.life.mode === 'managed' && typeof v43Rerender === 'function') { try { v43Rerender(v.caseId); } catch {} }
    // Both features off and nothing recorded: stay out of the way (legacy drawers unchanged).
    if (v.schedHidden && v.lifeHidden) { if (active === v) { active = null; v.root.remove(); } return; }
    // Resume a pending ambiguous operation for this case, if any.
    if (quiet && v.panel) { render(v); return; }   // a resync never swaps the open form for another restored draft
    for (const op of ['sched-adopt', 'sched-request', 'life-adopt', 'life-request', ...(v.sched && v.sched.pendingRequestId ? [`sched-withdraw:${v.sched.pendingRequestId}`, `sched-decide:${v.sched.pendingRequestId}`] : []),
      ...(v.life && v.life.pendingRequestId ? [`life-withdraw:${v.life.pendingRequestId}`, `life-decide:${v.life.pendingRequestId}`] : [])]) {
      const d = readDraft(v.userId, v.caseId, op);
      if (d && d.pending && d.pending.ambiguous) { v.panel = op.split(':')[0]; v.rid = op.split(':')[1] || null; v.values = { ...(d.values || {}) }; v.pending = d.pending; v.msg = MSG.ambiguous; v.msgKind = 'error'; break; }
    }
    render(v);
  }

  // A pending seal/resume request freezes the evidence (dates, status, assignment, archive, items, deliveries) on
  // the server; the old drawer controls are disabled here with the reason, instead of failing with a 409. Logs stay.
  function applyPendingFreeze(v) {
    if (!v.life || v.life.mode !== 'managed' || !v.life.pendingRequestId) return;
    const drawer = document.getElementById('drawer'); if (!drawer) return;
    for (const id of ['d-status', 'd-archive-input', 'd-archive-save', 'd-urgent-toggle', 'd-reassign']) { const el = document.getElementById(id); if (el) { el.disabled = true; el.classList.add('cl-frozen'); } }
    v.frozenNote = '封存／復工申請待主管決議：日期、狀態、指派、歸檔位置、子案件與交付暫停修改（進度日誌仍可寫）。如需修改請先撤回申請。';
  }

  // ── snapshots used for writes (always the data the user is looking at) ──────────────────
  const schedVersions = d => ({ expectedUpdatedAt: d.updatedAt, expectedContentVersion: d.contentVersion, ...(d.lifecycleMode === 'managed' ? { expectedCycleId: d.currentCycleId ?? null } : {}) });
  const lifeVersions = d => ({ expectedUpdatedAt: d.updatedAt, expectedContentVersion: d.contentVersion, expectedCycleId: d.currentCycleId ?? null });
  const lifeAdoptVersions = d => ({ expectedUpdatedAt: d.updatedAt, expectedContentVersion: d.contentVersion });

  // ── rendering ─────────────────────────────────────────────────────────────────────────
  const field = (v, name) => (v.errors && v.errors[name] ? `<span class="cl-error" id="cl-err-${name}">${esc(v.errors[name])}</span>` : '');
  const inv = (v, name) => (v.errors && v.errors[name] ? `aria-invalid="true" aria-describedby="cl-err-${name}"` : '');
  const catOptions = (cats, sel) => `<option value="">請選擇</option>${Object.entries(cats || {}).map(([k, l]) => `<option value="${esc(k)}" ${sel === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}`;
  function actionsHtml(v, act, label, opts = {}) {
    const amb = !!(v.pending && v.pending.ambiguous);
    return `<div class="cl-actions"><button type="button" class="cl-btn cl-btn-primary${opts.danger ? ' cl-btn-danger' : ''}" data-act="${amb ? 'reconcile' : act}" ${v.busy || ((opts.disabled || v.stale) && !amb) ? 'disabled' : ''}>${amb ? '重新確認送出' : esc(label)}</button>
      ${opts.extra || ''}${v.itemsDirty ? '<button type="button" class="cl-btn" data-act="discard-items">放棄子案件變更</button>' : ''}<button type="button" class="cl-btn" data-act="close-panel" ${v.busy ? 'disabled' : ''}>取消</button></div>
      <p class="cl-msg${v.msgKind === 'error' ? ' is-error' : ''}" role="status" aria-live="polite">${esc(v.msg || '')}</p>`;
  }
  function reasonFields(v, cats, label = '原因說明') {
    const amb = !!(v.pending && v.pending.ambiguous);
    return `<fieldset ${v.busy || amb ? 'disabled' : ''}>${cats ? `<label class="cl-field">原因分類<select data-f="reasonCategory" ${inv(v, 'reasonCategory')}>${catOptions(cats, v.values.reasonCategory)}</select>${field(v, 'reasonCategory')}</label>` : ''}
      <label class="cl-field">${esc(label)}<textarea data-f="reason" maxlength="500" rows="2" ${inv(v, 'reason')}>${esc(v.values.reason || '')}</textarea>${field(v, 'reason')}</label>`;
  }
  function schedSection(v) {
    const d = v.sched, c = v.c, a = access(c);
    if (v.schedHidden || !d) return '';
    let h = `<div class="cl-sub"><h4 class="cl-subtitle">時程（主案四個里程碑）</h4>`;
    if (d.mode !== 'managed') {
      h += '<p class="cl-note">舊制時程：日期沿用原本的編輯方式。</p>';
      if (a.isAdmin && d.workflow && d.workflow.workflowEnabled && !d.archived && !['done', 'closed', 'cancelled'].includes(d.status)) {
        h += v.panel === 'sched-adopt' ? `<div class="cl-panel" data-cl-panel="sched-adopt" role="group" aria-label="導入時程受控"><p class="cl-consequence">導入後延後或清除里程碑日期須提出改期申請並經主管核准；這是單向變更。系統會記下導入當下的日期作為觀測基準（不是原始承諾）。</p>${reasonFields(v, null, '導入原因')}</fieldset>${actionsHtml(v, 'sched-adopt', '確認導入')}</div>`
          : '<div class="cl-actions"><button type="button" class="cl-btn" data-act="open:sched-adopt">導入時程受控…</button></div>';
      }
      return h + '</div>';
    }
    if (d.workflow && d.workflow.paused) h += '<p class="cl-banner" role="note">改期申請目前暫停：可檢視紀錄，撤回與退回仍可使用。</p>';
    const base = d.baseline || {};
    h += `<table class="cl-table"><thead><tr><th scope="col">里程碑</th><th scope="col">正式日期</th><th scope="col">導入時觀測</th></tr></thead><tbody>${MILESTONES.map(([k, l]) => `<tr><th scope="row">${l}</th><td>${esc(d.schedule[k] || '未填')}</td><td class="cl-muted">${esc(base[k] || '未知')}</td></tr>`).join('')}</tbody></table>`;
    const pend = (d.requests || []).find(r => r.id === d.pendingRequestId && r.status === 'pending');
    if (pend) {
      h += `<div class="cl-pending"><p><span class="cl-state is-pending">待主管決議</span> ${esc(pend.requestedByName)} · ${esc(when(pend.requestedAt))}</p>
        <ul class="cl-diff">${MILESTONES.filter(([k]) => (pend.currentSchedule[k] ?? null) !== (pend.proposedSchedule[k] ?? null)).map(([k, l]) => `<li>${l}：${esc(pend.currentSchedule[k] || '未填')} → <b>${esc(pend.proposedSchedule[k] || '清除')}</b></li>`).join('')}</ul>
        <p class="cl-muted">${esc(pend.reasonCategoryLabel || '')}：${esc(pend.reason)}${pend.impactFrom ? `（影響期間 ${esc(pend.impactFrom)}～${esc(pend.impactTo)}）` : ''}</p>`;
      if (v.panel === 'sched-withdraw') h += `<div class="cl-panel" data-cl-panel="sched-withdraw">${reasonFields(v, null, '撤回原因')}</fieldset>${actionsHtml(v, 'sched-withdraw', '撤回申請')}</div>`;
      else if (v.panel === 'sched-decide') h += `<div class="cl-panel" data-cl-panel="sched-decide">${reasonFields(v, null, '主管意見（退回必填）')}</fieldset>${actionsHtml(v, 'sched-approve', '核准改期', { disabled: !!(d.workflow && d.workflow.paused), extra: `<button type="button" class="cl-btn cl-btn-danger" data-act="sched-reject" ${v.busy ? 'disabled' : ''}>退回</button>` })}</div>`;
      else {
        const b = [];
        if (a.isAdmin) b.push('<button type="button" class="cl-btn cl-btn-primary" data-act="open:sched-decide">審核改期</button>');
        if (a.canRequest) b.push('<button type="button" class="cl-btn" data-act="open:sched-withdraw">撤回申請…</button>');
        h += b.length ? `<div class="cl-actions">${b.join('')}</div>` : '';
      }
      h += '</div>';
    } else if (a.canRequest && !d.archived && !['done', 'closed', 'cancelled'].includes(d.status)) {
      if (v.panel === 'sched-request') {
        const vals = v.values.dates || {};
        h += `<div class="cl-panel" data-cl-panel="sched-request" role="group" aria-label="改期申請"><p class="cl-consequence">只有提前或補上原本未填的日期時，送出後直接更新並記錄原因；任何延後或清除日期都會成為改期申請，正式日期在主管核准前不變。</p>
          ${reasonFields(v, d.reasonCategories)}<div class="cl-grid">${MILESTONES.map(([k, l, req]) => `<label class="cl-field">${l}${req ? '' : '（可清除）'}<input type="date" data-date="${k}" value="${esc(vals[k] ?? d.schedule[k] ?? '')}" ${inv(v, k)}>${field(v, k)}</label>`).join('')}</div>
          <div class="cl-grid"><label class="cl-field">影響期間起（選填）<input type="date" data-f="impactFrom" value="${esc(v.values.impactFrom || '')}"></label><label class="cl-field">影響期間迄（選填）<input type="date" data-f="impactTo" value="${esc(v.values.impactTo || '')}" ${inv(v, 'impactTo')}>${field(v, 'impactTo')}</label></div></fieldset>
          ${actionsHtml(v, 'sched-request', '送出')}</div>`;
      } else h += '<div class="cl-actions"><button type="button" class="cl-btn" data-act="open:sched-request">調整里程碑日期…</button></div>';
    }
    const hist = d.requests || [];
    if (hist.length) h += `<details class="cl-history"><summary>改期紀錄（${hist.length}）</summary><ol>${hist.map(r => `<li><span class="cl-state is-${esc(r.status)}">${esc(REQ_STATUS[r.status] || r.status)}</span> ${esc(when(r.requestedAt))} · ${esc(r.requestedByName)}：${esc(r.reasonCategoryLabel || '')} ${esc(r.reason)}${r.decidedAt ? `<div class="cl-muted">${esc(r.decidedByName || '')} · ${esc(when(r.decidedAt))}${r.decisionReason ? '：' + esc(r.decisionReason) : ''}</div>` : ''}</li>`).join('')}</ol></details>`;
    return h + '</div>';
  }
  function outputsHtml(o) {
    if (!o) return '';
    const groups = s => (s && s.groups && s.groups.length ? s.groups.map(g => `${esc(OUTPUT_KIND[g.kind] || g.kind)} ${esc(String(g.quantity))} ${esc(g.unit)}`).join('、') : '未登錄（未知）');
    const cur = o.currentCycle;
    const curText = !cur ? '—' : cur.status === 'partially_unknown' ? `${groups(cur.summary)}；另有 ${cur.unattributedRecords} 筆導入前紀錄歸屬未知` : cur.status === 'none_recorded' ? '本期尚未登錄' : groups(cur.summary);
    const lc = o.legacyCounts || {};
    return `<dl class="cl-dl"><dt>本期產出</dt><dd>${curText}</dd><dt>全案累計</dt><dd>${groups(o.cumulative)}</dd>
      ${lc.requestCount != null || lc.outputCount != null ? `<dt>舊版數量（另列）</dt><dd>需求 ${esc(lc.requestCount ?? '—')}、設計產出 ${esc(lc.outputCount ?? '—')}</dd>` : ''}</dl>`;
  }
  function lifeSection(v) {
    const d = v.life, c = v.c, a = access(c);
    if (v.lifeHidden || !d) return '';
    let h = `<div class="cl-sub"><h4 class="cl-subtitle">工作週期</h4>`;
    if (d.mode !== 'managed') {
      h += '<p class="cl-note">舊制案件：沒有工作週期紀錄。</p>';
      if (a.isAdmin && d.workflow && d.workflow.workflowEnabled && !d.archived && ['todo', 'wait', 'doing', 'review', 'print'].includes(d.status)) {
        h += v.panel === 'life-adopt' ? `<div class="cl-panel" data-cl-panel="life-adopt" role="group" aria-label="導入週期管理"><p class="cl-consequence">導入後可申請未完成封存與原案號復工；這是單向變更。既有交付會標示「導入前歸屬未知」，不會改掛。</p>${reasonFields(v, null, '導入原因')}</fieldset>${actionsHtml(v, 'life-adopt', '確認導入')}</div>`
          : '<div class="cl-actions"><button type="button" class="cl-btn" data-act="open:life-adopt">導入週期管理…</button></div>';
      }
      return h + '</div>';
    }
    if (d.workflow && d.workflow.paused) h += '<p class="cl-banner" role="note">封存／復工流程目前暫停：可檢視紀錄，撤回與退回仍可使用。</p>';
    if (v.frozenNote) h += `<p class="cl-banner" role="note">${esc(v.frozenNote)}</p>`;
    const cur = (d.cycles || []).find(x => x.id === d.currentCycleId);
    h += `<p class="cl-state-line"><span class="cl-state is-${esc(d.lifecycleStatus)}">${esc(LIFE_LABEL[d.lifecycleStatus] || d.lifecycleStatus)}</span>${cur ? ` 第 ${cur.sequence} 期（自 ${esc(when(cur.startedAt))}）` : ''}</p>`;
    if (d.lifecycleStatus === 'sealed_incomplete') h += '<p class="cl-note">未完成封存不算結案、也不算取消；已交付的成果與原時程都保留。</p>';
    h += outputsHtml(d.outputs);
    const pend = (d.requests || []).find(r => r.id === d.pendingRequestId && r.status === 'pending');
    if (pend) {
      h += `<div class="cl-pending"><p><span class="cl-state is-pending">${esc(KIND_LABEL[pend.kind])}・待主管決議</span> ${esc(pend.requestedByName)} · ${esc(when(pend.requestedAt))}</p>
        <p class="cl-muted">${esc(pend.reasonCategoryLabel || '')}：${esc(pend.reason)}</p>
        ${pend.evidence ? `<p class="cl-muted">${pend.evidence.type === 'no_file' ? `聲明無可歸檔檔案：${esc(pend.evidence.reason)}` : `歸檔位置：<span class="cl-path">${esc(pend.evidence.archivePath)}</span>`}</p>` : ''}`;
      if (v.panel === 'life-withdraw') h += `<div class="cl-panel" data-cl-panel="life-withdraw">${reasonFields(v, null, '撤回原因')}</fieldset>${actionsHtml(v, 'life-withdraw', '撤回申請')}</div>`;
      else if (v.panel === 'life-decide') h += `<div class="cl-panel" data-cl-panel="life-decide">${reasonFields(v, null, '主管意見（退回必填）')}</fieldset>${actionsHtml(v, 'life-approve', pend.kind === 'seal' ? '核准未完成封存' : '核准復工', { disabled: !!(d.workflow && d.workflow.paused), extra: `<button type="button" class="cl-btn cl-btn-danger" data-act="life-reject" ${v.busy ? 'disabled' : ''}>退回</button>` })}</div>`;
      else {
        const b = [];
        if (a.isAdmin) b.push('<button type="button" class="cl-btn cl-btn-primary" data-act="open:life-decide">審核申請</button>');
        if (a.canRequest) b.push('<button type="button" class="cl-btn" data-act="open:life-withdraw">撤回申請…</button>');
        h += b.length ? `<div class="cl-actions">${b.join('')}</div>` : '';
      }
      h += '</div>';
    } else if (a.canRequest && !(d.workflow && d.workflow.paused)) {
      const kind = d.lifecycleStatus === 'active' ? 'seal' : d.lifecycleStatus === 'sealed_incomplete' ? 'resume' : null;
      if (kind && v.panel === 'life-request') {
        const ev = v.values.evidenceType || 'archive';
        h += `<div class="cl-panel" data-cl-panel="life-request" role="group" aria-label="${KIND_LABEL[kind]}"><p class="cl-consequence">${kind === 'seal'
          ? '送出後案件仍在進行中，主管核准才會封存。封存不算結案；已交付成果與原時程保留。'
          : '主管核准後沿用同一案號開始新的工作週期，狀態回到「設計製作中」；正式日期不會自動改，需要時請另提改期申請。'}</p>
          ${reasonFields(v, d.reasonCategories)}${kind === 'seal' ? `<div class="cl-radio" role="radiogroup" aria-label="歸檔證據">
            <label><input type="radio" name="cl-ev" data-f="evidenceType" value="archive" ${ev === 'archive' ? 'checked' : ''}> 使用已儲存的歸檔位置：<span class="cl-path">${esc(c.archivePath || '（尚未儲存）')}</span></label>
            <label><input type="radio" name="cl-ev" data-f="evidenceType" value="no_file" ${ev === 'no_file' ? 'checked' : ''}> 沒有可歸檔的檔案</label></div>
            ${ev === 'no_file' ? `<label class="cl-field">說明為何沒有可歸檔檔案<textarea data-f="noFileReason" maxlength="500" rows="2" ${inv(v, 'noFileReason')}>${esc(v.values.noFileReason || '')}</textarea>${field(v, 'noFileReason')}</label>` : field(v, 'archive')}` : ''}</fieldset>
          ${actionsHtml(v, 'life-request', kind === 'seal' ? '送出封存申請' : '送出復工申請')}</div>`;
      } else if (kind) h += `<div class="cl-actions"><button type="button" class="cl-btn" data-act="open:life-request">${kind === 'seal' ? '申請未完成封存…' : '申請復工…'}</button></div>`;
    }
    const cycles = d.cycles || [];
    if (cycles.length) h += `<details class="cl-history"><summary>週期紀錄（${cycles.length} 期）</summary><ol>${cycles.map(y => `<li><b>第 ${y.sequence} 期</b> ${y.source === 'adoption' ? '導入（日期為導入時觀測）' : '復工核准'} · ${esc(when(y.startedAt))}：${esc(y.startReason)}
      ${y.endedAt ? `<div class="cl-muted">結束：${esc(OUTCOME_LABEL[y.outcome] || y.outcome)} · ${esc(when(y.endedAt))} · ${esc(y.endedByName || '')}${y.endSnapshot && y.endSnapshot.noFile ? `（無可歸檔檔案：${esc(y.endSnapshot.noFile.reason)}）` : y.endSnapshot && y.endSnapshot.archivePath ? `（歸檔：<span class="cl-path">${esc(y.endSnapshot.archivePath)}</span>）` : ''}</div>` : '<div class="cl-muted">進行中</div>'}</li>`).join('')}</ol></details>`;
    const reqs = d.requests || [];
    if (reqs.length) h += `<details class="cl-history"><summary>封存／復工申請（${reqs.length}）</summary><ol>${reqs.map(r => `<li><span class="cl-state is-${esc(r.status)}">${esc(REQ_STATUS[r.status] || r.status)}</span> ${esc(KIND_LABEL[r.kind])} · ${esc(when(r.requestedAt))} · ${esc(r.requestedByName)}：${esc(r.reasonCategoryLabel || '')} ${esc(r.reason)}${r.decidedAt ? `<div class="cl-muted">${esc(r.decidedByName || '')} · ${esc(when(r.decidedAt))}${r.decisionReason ? '：' + esc(r.decisionReason) : ''}</div>` : ''}</li>`).join('')}</ol></details>`;
    return h + '</div>';
  }
  function render(v) {
    if (!isCurrent(v)) return;
    const body = v.loadError ? `<p class="cl-error" role="alert">${esc(v.loadError)}</p>` : v.loading ? '<p class="cl-muted" aria-busy="true">讀取時程與週期中…</p>' : schedSection(v) + lifeSection(v);
    v.root.innerHTML = `<div class="cl-head"><h3 class="cl-title" id="cl-title">時程與週期</h3><button type="button" class="cl-btn cl-btn-quiet" data-act="reload" ${v.busy ? 'disabled' : ''}>重新讀取</button></div>
      <p class="cl-msg${v.liveKind === 'error' ? ' is-error' : v.liveKind === 'ok' ? ' is-ok' : ''}" role="status" aria-live="polite">${esc(v.live || '')}</p>${v.stale && !v.loading && !v.syncing ? `<div class="cl-stale" role="alert"><p class="cl-msg is-error">案件剛有其他內容儲存（例如交付紀錄）：下方摘要與版本已過期。你的輸入已保留。</p><button type="button" class="cl-btn" data-act="resync" ${v.busy ? 'disabled' : ''}>重新讀取摘要</button></div>` : ''}${body}`;
    if (v.focus) { const f = v.focus; v.focus = null; try { const el = v.root.querySelector(f); el && el.focus && el.focus(); } catch {} }
  }

  // ── events ────────────────────────────────────────────────────────────────────────────
  function wire(v) {
    const root = v.root;
    root.onclick = e => {
      const view = active; if (!view || view.root !== root || !isCurrent(view)) return;
      const btn = e && e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (!btn || btn.disabled) return;
      const act = btn.dataset.act;
      if (act === 'reload') { view.panel = null; view.pending = null; view.errors = null; view.msg = ''; return load(view); }
      if (view.busy) return;
      if (act === 'resync') { persist(view); view.msg = ''; view.msgKind = ''; return load(view, { quiet: true }); }   // keeps the open form, its input and any unconfirmed request
      if (act.startsWith('open:')) return openPanel(view, act.slice(5));
      if (act === 'discard-items') {
        if (typeof confirm === 'function' && !confirm('放棄子案件尚未儲存的變更？')) return;
        if (typeof v43DiscardItems === 'function') v43DiscardItems(view.caseId);
        view.itemsDirty = false; view.msg = ''; view.msgKind = ''; render(view); return;
      }
      if (act === 'close-panel') { persist(view); view.panel = null; view.rid = null; view.errors = null; view.msg = ''; view.pending = null; render(view); return; }
      if (act === 'reconcile') return send(view, view.pending);
      return submit(view, act);
    };
    const onField = e => {
      const view = active; if (!view || view.root !== root || !view.panel || view.busy || (view.pending && view.pending.ambiguous)) return;
      const el = e && e.target; if (!el || !el.dataset) return;
      if (el.dataset.date) { view.values.dates = { ...(view.values.dates || {}), [el.dataset.date]: el.value }; }
      else if (el.dataset.f) {
        if (el.type === 'radio') { if (!el.checked) return; view.values[el.dataset.f] = el.value; persist(view); render(view); return; }
        view.values[el.dataset.f] = el.value;
      } else return;
      if (view.errors) delete view.errors[el.dataset.f || el.dataset.date];
      persist(view);
    };
    root.oninput = onField; root.onchange = onField;
    root.onkeydown = e => { if (e && e.key === 'Escape' && active && active.root === root && active.panel && !active.busy) { e.preventDefault && e.preventDefault(); const view = active; persist(view); view.panel = null; view.pending = null; render(view); } };
  }
  const opKey = v => (v.panel && /withdraw|decide/.test(v.panel) ? `${v.panel}:${v.rid}` : v.panel);
  function persist(v) { if (v.panel) writeDraft({ userId: v.userId, caseId: v.caseId, op: opKey(v), values: v.values, pending: v.pending || null }); }
  function openPanel(v, panel) {
    const rid = panel.startsWith('sched-') ? (v.sched && v.sched.pendingRequestId) : (v.life && v.life.pendingRequestId);
    v.panel = panel; v.rid = /withdraw|decide/.test(panel) ? rid : null; v.errors = null; v.msg = '';
    const d = readDraft(v.userId, v.caseId, opKey(v));
    v.values = d ? { ...(d.values || {}) } : {}; v.pending = d && d.pending ? d.pending : null;
    if (v.pending && v.pending.ambiguous) { v.msg = MSG.ambiguous; v.msgKind = 'error'; }
    v.focus = '[data-cl-panel] select:not([disabled]), [data-cl-panel] textarea:not([disabled])';
    render(v);
  }

  // ── writes ────────────────────────────────────────────────────────────────────────────
  function reasonError(text) {
    const t = String(text ?? '').trim();
    if (t.length < 2) return '請寫出具體原因（至少 2 個字）';
    if (t.length > 500) return '原因最多 500 字';
    if (/^[\s\p{P}\p{S}\d]+$/u.test(t) || /^(—|-|n\/?a|無|看板拖曳|改期|延期)$/i.test(t)) return '請寫出具體原因，而不是符號或動作描述';
    return null;
  }
  function fail(v, errors) { v.errors = errors; v.msg = '請修正標示的欄位。'; v.msgKind = 'error'; render(v); try { const el = v.root.querySelector('[aria-invalid="true"]'); el && el.focus && el.focus(); } catch {} }
  function submit(v, act) {
    if (v.stale) { v.msg = MSG.stale; v.msgKind = 'error'; render(v); return; }   // never send a new intent with versions the user is no longer looking at
    const vals = v.values, cid = enc(v.caseId);
    const errs = {};
    const needReason = !['sched-approve', 'life-approve'].includes(act);
    const rErr = reasonError(vals.reason); if (needReason && rErr) errs.reason = rErr;
    if ((act === 'sched-approve' || act === 'life-approve') && vals.reason && rErr) errs.reason = rErr;
    let path, body, method = 'POST', op = opKey(v);
    if (act === 'sched-adopt') { path = `/api/cases/${cid}/schedule-mode/adopt`; body = { requestId: newId('sadopt'), reason: String(vals.reason || '').trim(), ...schedVersions(v.sched) }; }
    else if (act === 'sched-request') {
      const proposed = {};
      for (const [k, , req] of MILESTONES) {
        const now = v.sched.schedule[k] ?? null, raw = vals.dates && k in vals.dates ? vals.dates[k] : now;
        const next = raw === '' ? null : raw;
        if (req && !next) errs[k] = '此日期不可清除';
        if ((next ?? null) !== now) proposed[k] = next;
      }
      if ((vals.impactFrom && !vals.impactTo) || (!vals.impactFrom && vals.impactTo)) errs.impactTo = '影響期間需同時填寫起訖日';
      else if (vals.impactFrom && vals.impactFrom > vals.impactTo) errs.impactTo = '起日不可晚於迄日';
      if (!Object.keys(proposed).length && !Object.keys(errs).length) errs.goLiveDate = '請至少調整一個里程碑日期';
      // Earlier / newly added dates only → a reasoned direct save (no approval). Any postponement or clearing →
      // an approval request (official dates unchanged until a manager approves).
      const needsApproval = Object.entries(proposed).some(([k, next]) => { const now = v.sched.schedule[k] ?? null; return (now && !next) || (now && next && next > now); });
      if (needsApproval) {
        if (!vals.reasonCategory) errs.reasonCategory = '延後或清除日期須申請，請選擇原因分類';
        path = `/api/cases/${cid}/schedule-requests`;
        body = { id: newId('sch'), reasonCategory: vals.reasonCategory, reason: String(vals.reason || '').trim(), proposedDates: proposed, ...(vals.impactFrom ? { impactFrom: vals.impactFrom, impactTo: vals.impactTo } : {}), ...schedVersions(v.sched) };
      } else {
        path = `/api/cases/${cid}`; method = 'PATCH';
        body = { ...proposed, reason: String(vals.reason || '').trim(), ...schedVersions(v.sched) };
      }
    } else if (act === 'sched-withdraw') { path = `/api/cases/${cid}/schedule-requests/${enc(v.rid)}/withdraw`; body = { operationId: newId('swd'), reason: String(vals.reason || '').trim(), ...schedVersions(v.sched) }; }
    else if (act === 'sched-approve' || act === 'sched-reject') { path = `/api/cases/${cid}/schedule-requests/${enc(v.rid)}/decide`; body = { operationId: newId('sop'), decision: act === 'sched-approve' ? 'approve' : 'reject', ...(String(vals.reason || '').trim() ? { reason: String(vals.reason).trim() } : {}), ...schedVersions(v.sched) }; }
    else if (act === 'life-adopt') { path = `/api/cases/${cid}/lifecycle/adopt`; body = { requestId: newId('ladopt'), reason: String(vals.reason || '').trim(), ...lifeAdoptVersions(v.life) }; }
    else if (act === 'life-request') {
      if (!vals.reasonCategory) errs.reasonCategory = '請選擇原因分類';
      const kind = v.life.lifecycleStatus === 'active' ? 'seal' : 'resume';
      let evidence;
      if (kind === 'seal') {
        if ((vals.evidenceType || 'archive') === 'no_file') { const e = reasonError(vals.noFileReason); if (e) errs.noFileReason = e; evidence = { type: 'no_file', reason: String(vals.noFileReason || '').trim() }; }
        else { const p = String(v.c.archivePath || '').trim(); if (!p) errs.archive = '尚未儲存歸檔位置：請先在上方儲存歸檔位置，或改選「沒有可歸檔的檔案」並說明。'; evidence = { type: 'archive', archivePath: p }; }
      }
      path = `/api/cases/${cid}/lifecycle/requests`;
      body = { id: newId(kind), kind, reasonCategory: vals.reasonCategory, reason: String(vals.reason || '').trim(), ...(evidence ? { evidence } : {}), ...lifeVersions(v.life) };
    } else if (act === 'life-withdraw') { path = `/api/cases/${cid}/lifecycle/requests/${enc(v.rid)}/withdraw`; body = { operationId: newId('lwd'), reason: String(vals.reason || '').trim(), ...lifeVersions(v.life) }; }
    else if (act === 'life-approve' || act === 'life-reject') { path = `/api/cases/${cid}/lifecycle/requests/${enc(v.rid)}/decide`; body = { operationId: newId('lop'), decision: act === 'life-approve' ? 'approve' : 'reject', ...(String(vals.reason || '').trim() ? { reason: String(vals.reason).trim() } : {}), ...lifeVersions(v.life) }; }
    else return;
    if (act.endsWith('-reject') && rErr) errs.reason = '退回時請寫出具體原因';
    if (Object.keys(errs).length) return fail(v, errs);
    v.errors = null; v.pending = { op, path, body, method, ambiguous: false }; persist(v);
    return send(v, v.pending);
  }
  async function send(v, pending) {
    if (!pending || v.busy || !isCurrent(v)) return;
    // Success re-opens the drawer, which rebuilds the items editor: never let that silently drop unsaved item edits.
    if (typeof v43ItemsDirty === 'function' && v43ItemsDirty(v.caseId)) { v.itemsDirty = true; v.msg = MSG.itemsDirty; v.msgKind = 'error'; render(v); return; }
    v.itemsDirty = false;
    const ctx = { v, c: v.c, userId: v.userId, caseId: v.caseId, gen: v.gen, op: pending.op, values: { ...v.values } };
    v.busy = true; v.msg = '送出中…'; v.msgKind = ''; render(v);
    try { const res = await fetchJson(pending.method || 'POST', pending.path, pending.body); await onSuccess(ctx, pending, res); }
    catch (e) { onFailure(ctx, pending, e); }
  }
  async function refreshCase(c, userId) {
    let raw; try { raw = await fetchJson('GET', `/api/cases/${enc(c.id)}`); } catch { return false; }
    const now = me(); if (!now || !sameId(now.id, userId) || !raw || raw.id !== c.id || typeof normalizeCase !== 'function') return false;
    const norm = normalizeCase(raw);
    const apply = t => { if (Number.isFinite(t._contentVersion) && norm._contentVersion < t._contentVersion) return; if (t.lifecycleMode === 'managed') norm.lifecycleMode = 'managed'; if (t.scheduleMode === 'managed') norm.scheduleMode = 'managed'; Object.assign(t, norm); };
    apply(c);
    const list = casesList(), i = list.findIndex(x => x && x.id === c.id);
    // Active CASES hold only unarchived cases: a sealed case leaves the work pool, a resumed one returns to it.
    if (c.archived) { if (i >= 0) list.splice(i, 1); }
    else if (i >= 0) { if (list[i] !== c) apply(list[i]); } else list.unshift(c);
    try { if (typeof decorateCase === 'function') decorateCase(c); if (typeof decorateCases === 'function') decorateCases(); if (typeof refreshAll === 'function') refreshAll(); } catch {}
    return true;
  }
  async function onSuccess(ctx, pending, res) {
    clearDraft(ctx.userId, ctx.caseId, ctx.op);
    const text = res && res.replayed ? '已確認（未重複建立）' : '已送出';
    flashes.set(`${ctx.userId}:${ctx.caseId}`, { msg: text, kind: 'ok' });
    toast('✓ ' + text);
    await refreshCase(ctx.c, ctx.userId);
    const a = me();
    if (a && sameId(a.id, ctx.userId) && ctx.gen === seqNow() && (typeof currentCase === 'undefined' || !currentCase || currentCase.id === ctx.caseId) && typeof openDrawer === 'function') openDrawer(ctx.c);
    else flashes.delete(`${ctx.userId}:${ctx.caseId}`);
  }
  function failureText(e) {
    const s = e && e.status, code = e && e.data && e.data.error, m = e && e.data && typeof e.data.message === 'string' ? e.data.message : '';
    if (s === 409 && ['edit_conflict', 'case_conflict', 'cycle_conflict'].includes(code)) return { msg: MSG.conflict, reload: true };
    if (s === 409 && code === 'client_update_required') return { msg: MSG.clientUpdate };
    if (s === 409 || s === 422 || s === 403 || s === 404) return { msg: (m || MSG.generic) + '（這次沒有寫入，你的輸入已保留）', reload: s === 409 };
    if (s === 400 && e.data && Array.isArray(e.data.issues)) return { msg: e.data.issues.map(i => i.message).filter(Boolean).slice(0, 2).join('；') || '內容格式不正確，你的輸入已保留。' };
    return { msg: m || MSG.generic };
  }
  function onFailure(ctx, pending, e) {
    if (e && e.authExpired) { if (isCurrent(ctx.v)) { ctx.v.busy = false; render(ctx.v); } return; }
    const status = e && e.status, ambiguous = !status || status === 0 || status >= 500 || !!(e && e.timeout);
    writeDraft({ userId: ctx.userId, caseId: ctx.caseId, op: ctx.op, values: ctx.values, pending: ambiguous ? { ...pending, ambiguous: true } : null });
    const v = ctx.v; if (!isCurrent(v)) return;
    v.busy = false; v.pending = ambiguous ? { ...pending, ambiguous: true } : null;
    if (ambiguous) { v.msg = MSG.ambiguous; v.msgKind = 'error'; render(v); return; }
    const f = failureText(e); v.msg = f.msg; v.msgKind = 'error'; render(v);
  }

  // ── write binder: managed cases' existing writers carry the snapshot the user is looking at ──────────
  // Fills ONLY when a writer sent no version at all (versions + cycle from the drawer's one cached snapshot), or
  // adds the cycle when the explicit versions ARE that cached snapshot. Explicit (even stale) values are never
  // replaced, so a 409 stays honest; legacy cases and the explicit lifecycle/schedule routes are untouched.
  function snapshotOf(id) {
    if (typeof currentCase !== 'undefined' && currentCase && currentCase.id === id) return currentCase;
    return casesList().find(x => x && x.id === id) || null;
  }
  function bindBody(url, body) {
    const m = String(url).match(/^\/api\/cases\/([^/?]+)(?:\/([^?]*))?/);
    if (!m || /^(schedule-requests|schedule-mode|lifecycle)(\/|$)/.test(m[2] || '')) return body;
    const c = snapshotOf(decodeURIComponent(m[1]));
    if (!c || !isManaged(c) || !c._updatedAt || !Number.isFinite(c._contentVersion)) return body;
    const cycle = c.lifecycleMode === 'managed' ? { expectedCycleId: c.currentCycleId ?? null } : {};
    const hasV = 'expectedUpdatedAt' in body || 'expectedContentVersion' in body;
    if ('expectedCycleId' in body) return body;
    if (!hasV) return { ...body, expectedUpdatedAt: new Date(c._updatedAt).toISOString(), expectedContentVersion: c._contentVersion, ...cycle };
    if (c.lifecycleMode === 'managed' && body.expectedContentVersion === c._contentVersion && body.expectedUpdatedAt && new Date(body.expectedUpdatedAt).getTime() === new Date(c._updatedAt).getTime()) return { ...body, ...cycle };
    return body;
  }
  if (typeof window.fetchJson === 'function' && !window.fetchJson.__lifecycleBound) {
    const orig = window.fetchJson;
    const bound = function (method, url, body) {
      const write = !!method && !/^(GET|HEAD)$/i.test(method);
      try { if (write && body && typeof body === 'object' && !Array.isArray(body)) body = bindBody(url, body); } catch {}
      const result = orig.call(this, method, url, body);
      if (write) Promise.resolve(result).then(() => afterCaseWrite(url), () => {});   // observe only; the caller still gets the original promise
      return result;
    };
    bound.__lifecycleBound = true;
    window.fetchJson = bound;
  }

  // ── Kanban: managed cases need a real reason + versions, so a drop opens the drawer instead ──────────
  if (typeof window.v54KanbanDrop === 'function') {
    const origDrop = window.v54KanbanDrop;
    window.v54KanbanDrop = function (caseId, newStatus) {
      const c = casesList().find(x => x && x.id === caseId);
      // Records send-review / close targets belong to C2's own flow first (preview + confirmed submission, its own
      // observer / assignment / pending checks; it never writes the status). Only what C2 does not claim falls through.
      if (c && c.status !== newStatus && window.caseWorkflowUi && typeof window.caseWorkflowUi.interceptKanban === 'function'
        && window.caseWorkflowUi.interceptKanban(c, newStatus)) return Promise.resolve();
      if (c && isManaged(c) && c.status !== newStatus) {
        toast('受控案件請在案件抽屜變更狀態並寫明具體原因', 'warn');
        if (typeof openDrawer === 'function') openDrawer(c);
        return Promise.resolve();
      }
      return origDrop.apply(this, arguments);
    };
  }

  // ── approval center: typed queue for schedule / seal / resume requests (incl. archived = sealed) ───────
  let lastDelivery = 0, lastTyped = 0;
  const origBadge = typeof window.v36UpdateApprovalBadge === 'function' ? window.v36UpdateApprovalBadge : null;
  async function refreshTyped(render) {
    const a = me(); if (!a || a.role !== 'admin') return [];
    let rows = [];
    try { rows = await fetchJson('GET', '/api/cases/pending-requests/list'); } catch { return null; }
    const still = me(); if (!still || !sameId(still.id, a.id)) return null;
    lastTyped = rows.length; if (origBadge) origBadge(lastDelivery + lastTyped);
    if (render) renderTyped(rows);
    return rows;
  }
  function renderTyped(rows) {
    const wrap = document.getElementById('v36-approval-list'); if (!wrap || !wrap.parentNode) return;
    let box = document.getElementById('cl-approval-typed');
    if (!box) { box = document.createElement('section'); box.id = 'cl-approval-typed'; box.className = 'cl-root cl-queue'; wrap.parentNode.insertBefore(box, wrap.nextSibling || null); }
    box.innerHTML = `<h3 class="cl-title">改期／封存／復工申請（${rows.length}）</h3>${rows.length ? `<ul class="cl-queue-list">${rows.map(r => `<li class="cl-queue-row">
      <span class="cl-state is-pending">${esc(KIND_LABEL[r.request && r.request.kind] || '申請')}</span>
      <span class="cl-strong">${esc(r.title)}</span> <span class="cl-muted">${esc(r.id)} · ${esc(r.designer && r.designer.name || '—')} · 申請：${esc(r.request ? r.request.requestedByName : '—')} ${esc(when(r.request && r.request.createdAt))}</span>
      ${r.request ? `<div class="cl-muted">${esc(r.request.reason)}</div>` : ''}
      <button type="button" class="cl-btn" data-cl-open="${esc(r.id)}">開啟案件審核</button></li>`).join('')}</ul>` : '<p class="cl-muted">目前沒有待審的改期、封存或復工申請。</p>'}`;
    box.onclick = e => { const b = e && e.target && e.target.closest ? e.target.closest('[data-cl-open]') : null; if (b && typeof openDrawerById === 'function') openDrawerById(b.dataset.clOpen, { fresh: true }); };
  }
  if (origBadge) window.v36UpdateApprovalBadge = function (n) { lastDelivery = Number(n) || 0; origBadge(lastDelivery + lastTyped); refreshTyped(false); };
  if (typeof window.renderApproval === 'function') {
    const origRender = window.renderApproval;
    window.renderApproval = async function () { const r = await origRender.apply(this, arguments); await refreshTyped(true); return r; };
  }

  // ── openDrawer hook (outermost) ───────────────────────────────────────────────────────
  const original = window.openDrawer;
  if (typeof original === 'function') {
    window.openDrawer = function (c) {
      active = null;
      const stale = document.getElementById('d-lifecycle'); if (stale) { stale.innerHTML = ''; stale.hidden = true; }
      const result = original.apply(this, arguments);
      const gen = seqNow();
      Promise.resolve(result).then(() => onOpened(c, gen), () => {});
      return result;
    };
  }
  // ── cross-module sync: another writer (B deliveries, items, case fields…) saved this case successfully ──────
  // The D2 summary (current-cycle / cumulative outputs) and the versions D2 writes carry are now out of date.
  // With no D2 form open it re-reads quietly; with a form, an unconfirmed request or a send in flight it only marks
  // the snapshot stale (input kept; new sends wait for 「重新讀取摘要」; an unconfirmed request still resends its exact body).
  function afterCaseWrite(url) {
    const m = String(url).match(/^\/api\/cases\/([^/?]+)(?:\/([^?]*))?/);
    if (!m || /^(schedule-requests|schedule-mode|lifecycle)(\/|$)/.test(m[2] || '')) return;   // D2's own writes re-open the drawer
    invalidate(decodeURIComponent(m[1]));
  }
  function invalidate(caseId) {
    const v = active; if (!v || v.caseId !== caseId || !isCurrent(v) || (!v.life && !v.sched)) return;   // other cases' drawers are untouched
    v.writeSeq = (v.writeSeq || 0) + 1;
    if (v.panel || v.pending || v.busy) { v.stale = true; v.loadSeq = (v.loadSeq || 0) + 1; render(v); return; }   // also drops any read already in flight
    v.stale = true; v.syncing = true; load(v, { quiet: true });   // the quick re-read replaces the summary; the banner only shows if it fails
  }

  // Lifecycle state from the drawer's own GET for this case (null when not loaded / another case is shown).
  function lifeSnapshot(caseId) {
    const v = active; if (!v || !v.life || v.caseId !== caseId || !isCurrent(v)) return null;
    return { mode: v.life.mode, lifecycleStatus: v.life.lifecycleStatus ?? null, pendingRequestId: v.life.pendingRequestId ?? null, contentVersion: v.life.contentVersion };
  }
  window.caseLifecycleUi = { onOpened, bindBody, access, readDraft, lifeSnapshot, invalidate, _active: () => active, _reset: () => { active = null; memory.clear(); flashes.clear(); lastTyped = 0; lastDelivery = 0; } };
})();
