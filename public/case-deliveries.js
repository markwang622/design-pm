/* REPORTS-P1-B 交付成果：案件抽屜內登錄、更正、作廢交付明細。
 * - 掛在最外層 openDrawer 之後，等 v36／v37 權限與歷史唯讀 sweep 完成才渲染；本區自行判斷可寫狀態。
 * - 伺服器 404 feature_disabled → 安靜移除本區，既有抽屜照常運作。
 * - 每個非同步回覆綁定「原案件＋原登入者＋抽屜世代」，切換案件後不會把 A 的結果畫進 B。
 * - 草稿依「真實登入者 ID＋案件＋操作（含更正對象）」保存；sessionStorage 失敗時改用記憶體。
 * - 結果不明（斷線／逾時／5xx）時保留完全相同的請求並鎖定內容，必須先重新確認，避免第二筆。
 */
(() => {
  if (window.__caseDeliveriesInstalled) return;
  window.__caseDeliveriesInstalled = true;

  const KINDS = [['main', '主設計'], ['extension', '延伸'], ['support', '支援']];
  const KIND_LABEL = Object.fromEntries(KINDS);
  const LOCKED_STATUSES = new Set(['review_done', 'done', 'closed', 'cancelled']);
  const MAX_QTY = 1000000;
  const STORE_PREFIX = 'dpm.delivery.v1:', STORE_INDEX = 'dpm.delivery.v1.index', MAX_DRAFTS = 20, MAX_DRAFT_BYTES = 8000;
  const MSG = {
    saved: '交付已儲存', corrected: '更正已儲存，原紀錄已保留', voided: '已作廢，原紀錄已保留',
    conflict: '資料已更新，你的內容已保留。請重新整理明細後再儲存。',
    ambiguous: '連線不穩，無法確認是否已儲存。內容已保留，請按「重新確認送出」；確認前不會建立第二筆。',
    locked: '案件已送核可、結案、取消或封存，無法再登錄或更正交付。內容已保留。',
    forbidden: '你目前沒有此案件的交付登錄權限，內容已保留。',
    inactive: '帳號已停用或尚未啟用，無法登錄交付。',
    gone: '這筆交付已被作廢、更正或不存在，請重新整理明細。',
    reused: '這次送出的識別碼已用於其他內容，原紀錄未更動。請重新整理明細後再儲存。',
    loadFail: '交付明細讀取失敗。請稍後按「重新讀取」。',
    generic: '儲存失敗，內容已保留。請稍後再試。',
  };
  const FIELD_LABEL = { itemName: '交付品名', kind: '類別', quantity: '數量', deliveredOn: '交付日期', note: '說明', reason: '原因', itemKey: '子案件' };

  const esc = value => (typeof escapeHtml === 'function' ? escapeHtml(value) : String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));
  const seqNow = () => (window.v95DrawerSeq && typeof window.v95DrawerSeq.now === 'function' ? window.v95DrawerSeq.now() : 0);
  const me = () => (typeof ME !== 'undefined' && ME && ME.id != null ? ME : null);
  const sameId = (a, b) => a != null && b != null && a !== '' && b !== '' && String(a) === String(b);
  const todayTaipei = () => {
    try { if (typeof v20TaiwanToday === 'function') return v20TaiwanToday(); } catch {}
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
    catch { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }
  };
  const newId = prefix => {
    let core;
    try { core = crypto.randomUUID(); } catch { core = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12); }
    return (prefix + '-' + core).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
  };

  // ── drafts ────────────────────────────────────────────────────────────────
  const memoryDrafts = new Map();
  function store() {
    try { const s = window.sessionStorage; if (!s) return null; const probe = STORE_PREFIX + 'probe'; s.setItem(probe, '1'); s.removeItem(probe); return s; }
    catch { return null; }
  }
  const draftKey = (userId, caseId, op) => `${STORE_PREFIX}${userId}:${caseId}:${op}`;
  function readDraft(userId, caseId, op) {
    const key = draftKey(userId, caseId, op);
    const valid = d => d && sameId(d.userId, userId) && d.caseId === caseId && d.op === op ? d : null;
    const s = store();
    if (s) { try { const d = valid(JSON.parse(s.getItem(key) || 'null')); if (d) return d; } catch {} }
    return valid(memoryDrafts.get(key)) || null;
  }
  function writeDraft(draft) {
    const key = draftKey(draft.userId, draft.caseId, draft.op);
    draft.ts = Date.now();
    memoryDrafts.set(key, JSON.parse(JSON.stringify(draft)));
    const s = store(); if (!s) return;
    try {
      const text = JSON.stringify(draft);
      if (text.length > MAX_DRAFT_BYTES) { s.removeItem(key); return; }   // 過大只留在記憶體
      s.setItem(key, text);
      let index = [];
      try { index = JSON.parse(s.getItem(STORE_INDEX) || '[]'); } catch {}
      index = (Array.isArray(index) ? index : []).filter(k => k !== key); index.push(key);
      while (index.length > MAX_DRAFTS) { try { s.removeItem(index.shift()); } catch {} }
      s.setItem(STORE_INDEX, JSON.stringify(index));
    } catch {}
  }
  function clearDraft(userId, caseId, op) {
    const key = draftKey(userId, caseId, op);
    memoryDrafts.delete(key);
    const s = store(); if (!s) return;
    try { s.removeItem(key); const index = JSON.parse(s.getItem(STORE_INDEX) || '[]'); s.setItem(STORE_INDEX, JSON.stringify((Array.isArray(index) ? index : []).filter(k => k !== key))); } catch {}
  }

  // ── validation (mirrors the server) ───────────────────────────────────────
  function meaningfulNote(note) {
    const text = String(note ?? '').trim();
    if (text.length < 4) return false;
    try { if (/^[\s\p{P}\p{S}\d]+$/u.test(text)) return false; } catch { if (/^[\s\d\-_.,;:!?/\\|—–·。，、；：！？]+$/.test(text)) return false; }
    return !/^(n\/?a|none|null|tbd|todo|test|無|沒有|略|同上|待補|不適用)$/i.test(text);
  }
  function realDate(text) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(text || ''))) return false;
    const d = new Date(text + 'T00:00:00Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === text;
  }
  function validate(values, op) {
    const errors = {};
    const name = String(values.itemName ?? '').trim();
    if (op !== 'void') {
      if (!name) errors.itemName = '請填寫交付品名';
      else if (name.length > 200) errors.itemName = '交付品名最多 200 字';
      const qText = String(values.quantity ?? '').trim();
      if (!/^\d{1,7}$/.test(qText) || Number(qText) > MAX_QTY) errors.quantity = '數量請填 0 到 1,000,000 的整數';
      else if (Number(qText) === 0 && values.kind !== 'support') errors.quantity = '主設計與延伸至少 1 件；沒有設計產出請選「支援」並說明';
      else if (Number(qText) === 0 && !meaningfulNote(values.note)) errors.note = '數量為 0 時，請具體說明做了什麼（至少 4 個字）';
      if (!KIND_LABEL[values.kind]) errors.kind = '請選擇類別';
      if (!realDate(values.deliveredOn)) errors.deliveredOn = '請填有效的交付日期';
      else if (values.deliveredOn > todayTaipei()) errors.deliveredOn = '交付日期不可晚於今天';
      else if (values.deliveredOn < '2000-01-01') errors.deliveredOn = '交付日期不可早於 2000-01-01';
      if (String(values.note ?? '').length > 1000) errors.note = '說明最多 1000 字';
    }
    if (op !== 'new') {
      const reason = String(values.reason ?? '').trim();
      if (reason.length < 2) errors.reason = op === 'void' ? '請填寫作廢原因（至少 2 個字）' : '請填寫更正原因（至少 2 個字）';
      else if (reason.length > 500) errors.reason = '原因最多 500 字';
    }
    return Object.keys(errors).length ? errors : null;
  }

  // ── permissions (true signed-in identity, never view-as or names) ─────────
  function lockReason(c) {
    if (!c) return 'missing';
    if (c.archived || LOCKED_STATUSES.has(c.status)) return 'locked';
    // REPORTS-P2-D2: lifecycle-managed — a pending seal/resume request or a non-active cycle freezes deliveries.
    if (c.lifecycleMode === 'managed' && (c.pendingLifecycleRequestId || (c.lifecycleStatus && c.lifecycleStatus !== 'active'))) return 'lifecycle';
    const actor = me();
    if (!actor || actor.role === 'observer' || (typeof IS_OBSERVER === 'function' && IS_OBSERVER())) return 'readonly';
    if (actor.role === 'admin') return null;
    const assigned = sameId(c._designerId, actor.id) || (Array.isArray(c._collaboratorIds) && c._collaboratorIds.some(x => sameId(x, actor.id)));
    return assigned ? null : 'unassigned';
  }
  const READONLY_TEXT = {
    locked: '案件已送核可、結案、取消或封存，交付明細僅供檢視。',
    readonly: '觀察者為唯讀，交付明細僅供檢視。',
    unassigned: '你不是此案件的主責或協作者，交付明細僅供檢視。',
    lifecycle: '封存／復工申請待決或案件已封存，交付明細暫停修改。',
  };

  // ── view state ────────────────────────────────────────────────────────────
  let featureOff = false, active = null;
  function ensureRoot() {
    let root = document.getElementById('d-deliveries');
    if (root) return root;
    const anchor = document.getElementById('d-archive');
    if (!anchor || !anchor.parentNode) return null;
    root = document.createElement('section');
    root.id = 'd-deliveries'; root.className = 'cd-root'; root.setAttribute('aria-labelledby', 'cd-title');
    const parent = anchor.parentNode;
    const next = anchor.nextElementSibling !== undefined ? anchor.nextElementSibling
      : (Array.isArray(parent.children) ? parent.children[parent.children.indexOf(anchor) + 1] || null : null);
    parent.insertBefore(root, next || null);
    return root;
  }
  function removeRoot() { const root = document.getElementById('d-deliveries'); if (root) root.remove(); }
  function isCurrent(v) {
    if (!v || active !== v || v.gen !== seqNow() || !v.root || v.root.isConnected === false) return false;
    if (typeof currentCase !== 'undefined' && currentCase && currentCase.id !== v.caseId) return false;
    const actor = me(); return !!actor && sameId(actor.id, v.userId);
  }

  function onOpened(c, gen) {
    if (featureOff) { removeRoot(); return; }
    const actor = me();
    if (!c || !c.id || !actor || gen !== seqNow()) return;
    if (typeof currentCase !== 'undefined' && currentCase && currentCase.id !== c.id) return;
    const root = ensureRoot(); if (!root) return;
    root.hidden = false;
    const v = { c, caseId: c.id, userId: actor.id, gen, root, data: null, loadError: '', mode: null, target: null, values: null, errors: null, busy: false, msg: '', msgKind: '', liveMsg: '' };
    active = v;
    // 有結果不明的待確認請求時，直接展開該表單強制先確認
    for (const op of ['new']) { const d = readDraft(v.userId, v.caseId, op); if (d && d.pending && d.pending.ambiguous) openForm(v, 'new', null, false); }
    wire(v); render(v); load(v);
  }

  async function load(v) {
    v.loadError = ''; v.loading = true; if (isCurrent(v)) render(v);
    try {
      const data = await fetchJson('GET', `/api/cases/${encodeURIComponent(v.caseId)}/deliveries`);
      if (!isCurrent(v)) return;
      v.data = data; v.loading = false;
      // 已作廢的紀錄不能再更正／作廢：清掉對應的舊草稿，避免殘留
      for (const r of data.records || []) if (r.voided) { clearDraft(v.userId, v.caseId, `fix:${r.id}`); clearDraft(v.userId, v.caseId, `void:${r.id}`); }
      if (v.mode && v.mode !== 'new' && !(data.records || []).some(r => r.id === v.target && !r.voided)) {
        const d = readDraft(v.userId, v.caseId, opKey(v.mode, v.target));
        if (!(d && d.pending && d.pending.ambiguous)) { v.mode = null; v.target = null; }
      }
      render(v);
    } catch (e) {
      if (e && e.status === 404 && e.data && e.data.error === 'feature_disabled') { featureOff = true; if (active === v) { active = null; removeRoot(); } return; }
      if (!isCurrent(v)) return;
      v.loading = false; v.loadError = MSG.loadFail; render(v);
    }
  }

  const opKey = (mode, target) => (mode === 'new' ? 'new' : `${mode}:${target}`);
  function defaultValues(v, mode, record) {
    const items = keyedItems(v.c);
    if (mode === 'fix' && record) {
      return { itemKey: record.itemKey && items.some(i => i.key === record.itemKey) ? record.itemKey : '', itemName: record.itemName, kind: record.kind,
        quantity: String(record.quantity), deliveredOn: record.deliveredOn, note: record.note || '', reason: '', autoName: false, autoQty: false };
    }
    if (mode === 'void') return { reason: '' };
    return { itemKey: '', itemName: v.c.name || '', kind: 'main', quantity: '1', deliveredOn: todayTaipei(), note: '', autoName: true, autoQty: true };
  }
  function openForm(v, mode, target, focus = true) {
    const op = opKey(mode, target);
    const draft = readDraft(v.userId, v.caseId, op);
    const record = target && v.data ? (v.data.records || []).find(r => r.id === target) : null;
    v.mode = mode; v.target = target; v.errors = null; v.msg = ''; v.msgKind = '';
    v.values = draft ? { ...draft.values } : defaultValues(v, mode, record);
    v.pending = draft ? draft.pending || null : null;
    if (v.pending && v.pending.ambiguous) { v.msg = MSG.ambiguous; v.msgKind = 'error'; }
    v.focusField = focus;
  }
  function persist(v) {
    if (!v.mode) return;
    writeDraft({ userId: v.userId, caseId: v.caseId, op: opKey(v.mode, v.target), values: v.values, pending: v.pending || null });
  }
  const keyedItems = c => (Array.isArray(c && c.items) ? c.items : []).filter(it => it && typeof it === 'object' && typeof it.key === 'string' && it.key && String(it.n ?? '').trim());

  // ── rendering ─────────────────────────────────────────────────────────────
  function summaryHtml(data) {
    const s = data.summary || {};
    const groups = Array.isArray(s.groups) ? s.groups : [];
    let html = '';
    if (s.status === 'recorded' && groups.length) {
      html += `<div class="cd-summary" aria-label="交付摘要">${groups.map(g => `<span class="cd-chip">${esc(KIND_LABEL[g.kind] || g.kind)} <b>${esc(String(g.quantity))}</b> ${esc(g.unit)}<span class="cd-help-inline"> · ${esc(String(g.records))} 筆</span></span>`).join('')}</div>`;
      if (s.zeroSupportRecords) html += `<p class="cd-unknown">其中 ${esc(String(s.zeroSupportRecords))} 筆為支援工作（0 件，已附說明）。</p>`;
    } else {
      html += '<p class="cd-unknown">尚未登錄交付明細（未知，不代表 0 件）。</p>';
    }
    const legacy = data.legacy || {};
    const parts = [];
    if (legacy.outputCount != null) parts.push(`設計產出 <b>${esc(String(legacy.outputCount))}</b>`);
    if (legacy.requestCount != null) parts.push(`需求 <b>${esc(String(legacy.requestCount))}</b>`);
    if (parts.length) html += `<p class="cd-legacy">舊版總量，尚無交付日期明細：${parts.join('、')}</p>`;
    return html;
  }
  function rowHtml(r, canMutate, v) {
    const busyHere = v.mode && v.target === r.id;
    const actions = canMutate && !r.voided ? `<div class="cd-actions">
        <button type="button" class="cd-btn" data-act="fix" data-rid="${esc(r.id)}" aria-label="更正 ${esc(r.itemName)}" ${busyHere ? 'aria-expanded="true"' : ''}>更正</button>
        <button type="button" class="cd-btn cd-btn-danger" data-act="void" data-rid="${esc(r.id)}" aria-label="作廢 ${esc(r.itemName)}">作廢</button></div>` : '';
    const state = r.voided ? `<span class="cd-void-badge">已作廢</span>` : '';
    return `<li class="cd-row${r.voided ? ' is-void' : ''}" data-record="${esc(r.id)}">
      <div class="cd-row-main">
        <div class="cd-row-line"><span>${esc(r.deliveredOn)}</span><span class="cd-row-name">${esc(r.itemName)}</span><span class="cd-kind">${esc(KIND_LABEL[r.kind] || r.kind)}</span><span class="cd-qty">${esc(String(r.quantity))} ${esc(r.unit)}</span>${state}</div>
        <div class="cd-row-meta">登錄：${esc(r.recordedByName || '—')}${r.voided ? ` · 作廢：${esc(r.voidedByName || '—')}，原因：${esc(r.voidReason || '—')}` : ''}</div>
        ${r.note ? `<div class="cd-row-note">說明：${esc(r.note)}</div>` : ''}
      </div>${actions}</li>`;
  }
  function fieldError(v, name) { return v.errors && v.errors[name] ? `<span class="cd-hint cd-field-error" id="cd-err-${name}" style="color:var(--dk-red,#9A2E2E)">${esc(v.errors[name])}</span>` : ''; }
  function invalid(v, name) { return v.errors && v.errors[name] ? `aria-invalid="true" aria-describedby="cd-err-${name}"` : ''; }
  function formHtml(v, canMutate) {
    if (!v.mode || !canMutate && !(v.pending && v.pending.ambiguous)) return '';
    const values = v.values || {};
    const ambiguous = !!(v.pending && v.pending.ambiguous);
    const locked = v.busy || ambiguous;
    const disabled = locked ? 'disabled' : '';
    if (v.mode === 'void') {
      return `<div class="cd-form" data-cd-form="void" role="group" aria-labelledby="cd-form-title">
        <p class="cd-form-title" id="cd-form-title">作廢這筆交付</p>
        <p class="cd-consequence">作廢後原紀錄會保留並標示「已作廢」，不再計入交付摘要；無法復原。若只是數字或內容有誤，請改用「更正」。</p>
        <fieldset ${disabled}><label class="cd-field">作廢原因<input data-f="reason" maxlength="500" value="${esc(values.reason || '')}" ${invalid(v, 'reason')}>${fieldError(v, 'reason')}</label></fieldset>
        <div class="cd-form-actions">
          <button type="button" class="cd-btn cd-btn-primary" data-act="${ambiguous ? 'reconcile' : 'save'}" ${v.busy ? 'disabled' : ''}>${ambiguous ? '重新確認送出' : '作廢這筆交付'}</button>
          <button type="button" class="cd-btn" data-act="cancel">取消</button>
        </div>
        <p class="cd-msg${v.msgKind === 'error' ? ' is-error' : ''}" role="status" aria-live="polite">${esc(v.msg || '')}</p></div>`;
    }
    const items = keyedItems(v.c);
    const fix = v.mode === 'fix';
    return `<div class="cd-form" data-cd-form="${v.mode}" role="group" aria-labelledby="cd-form-title">
      <p class="cd-form-title" id="cd-form-title">${fix ? '更正交付（原紀錄會保留並標示已作廢）' : '新增交付'}</p>
      <fieldset ${disabled}><div class="cd-grid">
        ${items.length ? `<label class="cd-field">子案件（選填）<select data-f="itemKey"><option value="">不指定（整案）</option>${items.map(it => `<option value="${esc(it.key)}" ${values.itemKey === it.key ? 'selected' : ''}>${esc(it.n)}</option>`).join('')}</select></label>` : ''}
        <label class="cd-field${items.length ? '' : ' cd-wide'}">交付品名<input data-f="itemName" maxlength="200" value="${esc(values.itemName || '')}" ${invalid(v, 'itemName')}>${fieldError(v, 'itemName')}</label>
        <label class="cd-field">類別<select data-f="kind" ${invalid(v, 'kind')}>${KINDS.map(([k, l]) => `<option value="${k}" ${values.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select>${fieldError(v, 'kind')}</label>
        <label class="cd-field">數量（件）<input data-f="quantity" inputmode="numeric" autocomplete="off" value="${esc(values.quantity ?? '')}" ${invalid(v, 'quantity')}>${fieldError(v, 'quantity')}</label>
        <label class="cd-field">交付日期<input type="date" data-f="deliveredOn" max="${esc(todayTaipei())}" value="${esc(values.deliveredOn || '')}" ${invalid(v, 'deliveredOn')}>${fieldError(v, 'deliveredOn')}</label>
        <label class="cd-field cd-wide">說明<textarea data-f="note" maxlength="1000" placeholder="例如：提供版面諮詢，未新增設計檔案" ${invalid(v, 'note')}>${esc(values.note || '')}</textarea><span class="cd-hint">支援工作數量為 0 時必填具體說明。</span>${fieldError(v, 'note')}</label>
        ${fix ? `<label class="cd-field cd-wide">更正原因<input data-f="reason" maxlength="500" value="${esc(values.reason || '')}" ${invalid(v, 'reason')}>${fieldError(v, 'reason')}</label>` : ''}
      </div></fieldset>
      <div class="cd-form-actions">
        <button type="button" class="cd-btn cd-btn-primary" data-act="${ambiguous ? 'reconcile' : 'save'}" ${v.busy ? 'disabled' : ''}>${ambiguous ? '重新確認送出' : (fix ? '儲存更正' : '儲存交付')}</button>
        <button type="button" class="cd-btn" data-act="cancel">取消</button>
        <button type="button" class="cd-btn cd-discard" data-act="discard" ${locked ? 'disabled' : ''}>捨棄草稿</button>
      </div>
      <p class="cd-msg${v.msgKind === 'error' ? ' is-error' : ''}" role="status" aria-live="polite">${esc(v.msg || '')}</p></div>`;
  }
  function render(v) {
    if (!isCurrent(v)) return;
    const reason = lockReason(v.c), canMutate = !reason && !!v.data;
    const data = v.data;
    let body = '';
    if (v.loadError) body = `<p class="cd-status" role="alert">${esc(v.loadError)}</p><button type="button" class="cd-btn" data-act="reload">重新讀取</button>`;
    else if (!data) body = '<p class="cd-status" aria-busy="true">讀取交付明細中…</p>';
    else {
      body = summaryHtml(data);
      if (reason) body += `<p class="cd-readonly">${esc(READONLY_TEXT[reason] || '交付明細僅供檢視。')}</p>`;
      if (v.mode === 'new') body += formHtml(v, canMutate);
      const records = Array.isArray(data.records) ? data.records : [];
      if (records.length) {
        body += `<ul class="cd-list" aria-label="交付紀錄">${records.map(r => rowHtml(r, canMutate, v) + (v.mode && v.mode !== 'new' && v.target === r.id ? `<li class="cd-inline-form">${formHtml(v, canMutate)}</li>` : '')).join('')}</ul>`;
      }
    }
    const newLabel = readDraft(v.userId, v.caseId, 'new') && v.mode !== 'new' ? '新增交付（有草稿）' : '新增交付';
    v.root.innerHTML = `<div class="cd-head"><h3 class="cd-title" id="cd-title">交付成果</h3>
        ${data ? '<button type="button" class="cd-btn" data-act="reload">重新整理明細</button>' : ''}
        ${data && canMutate && v.mode !== 'new' ? `<button type="button" class="cd-btn cd-btn-primary" data-act="new" aria-expanded="false">${newLabel}</button>` : ''}</div>
      <p class="cd-help">交付一次登錄一次，主設計與延伸分開統計。</p>
      <p class="cd-msg${v.liveKind === 'error' ? ' is-error' : v.liveKind === 'ok' ? ' is-ok' : ''}" role="status" aria-live="polite" data-cd-live>${esc(v.liveMsg || '')}</p>
      ${body}`;
    if (v.refocus) {
      const f = v.refocus; v.refocus = null;
      try { const el = v.root.querySelector(`[data-f="${f}"]`); el && el.focus && el.focus(); } catch {}
    } else if (v.focusField) {
      v.focusField = false;
      const first = v.root.querySelector('[data-cd-form] input:not([disabled]), [data-cd-form] select:not([disabled])');
      try { first && first.focus && first.focus(); } catch {}
    }
  }

  // ── events ────────────────────────────────────────────────────────────────
  function wire(v) {
    const root = v.root;
    root.onclick = e => {
      const view = active; if (!view || view.root !== root || !isCurrent(view)) return;
      const btn = e && e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (!btn || btn.disabled) return;
      const act = btn.dataset.act, rid = btn.dataset.rid || null;
      if (act === 'reload') return load(view);
      if (act === 'new' || act === 'fix' || act === 'void') {
        if (view.busy) return;
        if (lockReason(view.c)) return;
        openForm(view, act, act === 'new' ? null : rid); view.liveMsg = ''; render(view); return;
      }
      if (act === 'cancel') { persist(view); const back = view.mode; view.mode = null; view.target = null; view.errors = null; view.busy = false; render(view); focusAct(view, back === 'new' ? 'new' : null); return; }
      if (act === 'discard') {
        if (view.busy || (view.pending && view.pending.ambiguous)) return;
        clearDraft(view.userId, view.caseId, opKey(view.mode, view.target)); view.mode = null; view.target = null; view.errors = null; view.pending = null;
        view.liveMsg = '已捨棄草稿'; view.liveKind = ''; render(view); focusAct(view, 'new'); return;
      }
      if (act === 'save') return save(view);
      if (act === 'reconcile') return send(view, view.pending);
    };
    const onField = e => {
      const view = active; if (!view || view.root !== root || !view.mode || view.busy) return;
      const el = e && e.target; const f = el && el.dataset ? el.dataset.f : null; if (!f || !view.values) return;
      if (view.pending && view.pending.ambiguous) return;   // 待確認期間內容鎖定
      const values = view.values; values[f] = el.value;
      if (f === 'itemName') values.autoName = false;
      if (f === 'quantity') values.autoQty = false;
      if (f === 'itemKey' && values.autoName !== false) { const it = keyedItems(view.c).find(i => i.key === el.value); values.itemName = it ? String(it.n).trim() : (view.c.name || ''); view.refocus = f; render(view); }
      if (f === 'kind' && values.autoQty !== false) { values.quantity = el.value === 'support' ? '0' : '1'; view.refocus = f; render(view); }
      persist(view);
    };
    root.oninput = onField; root.onchange = onField;
    root.onkeydown = e => {
      if (!e || e.key !== 'Enter' || !e.target || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON') return;
      if (e.target.dataset && e.target.dataset.f) { if (e.preventDefault) e.preventDefault(); const view = active; if (view && view.root === root && isCurrent(view)) save(view); }
    };
  }
  function focusAct(v, act) {
    try { const el = act ? v.root.querySelector(`[data-act="${act}"]`) : v.root.querySelector('#cd-title'); el && el.focus && el.focus(); } catch {}
  }

  // ── writes ────────────────────────────────────────────────────────────────
  // REPORTS-P2-D2: on a lifecycle-managed case the cycle id travels with the versions FROM THE SAME snapshot
  // (case cache or the listing read), never spliced from a different read.
  const withCycle = (versions, snap) => (snap && snap.lifecycleMode === 'managed' ? { ...versions, expectedCycleId: snap.currentCycleId ?? null } : versions);
  function expectedVersion(v) {
    const d = v.data || {}, c = v.c || {};
    const cv = Number.isFinite(c._contentVersion) ? c._contentVersion : null;
    if (cv != null && c._updatedAt && (d.contentVersion == null || cv > d.contentVersion)) return withCycle({ expectedUpdatedAt: new Date(c._updatedAt).toISOString(), expectedContentVersion: cv }, c);
    return withCycle({ expectedUpdatedAt: d.updatedAt, expectedContentVersion: d.contentVersion }, d);
  }
  function buildRequest(v) {
    const values = v.values, base = `/api/cases/${encodeURIComponent(v.caseId)}/deliveries`;
    if (v.mode === 'void') return { path: `${base}/${encodeURIComponent(v.target)}/void`, body: { requestId: newId('void'), reason: String(values.reason).trim(), ...expectedVersion(v) } };
    const body = { id: newId(v.mode === 'fix' ? 'fix' : 'dlv'), itemName: String(values.itemName).trim(), kind: values.kind, quantity: Number(String(values.quantity).trim()),
      unit: '件', deliveredOn: values.deliveredOn, note: String(values.note ?? '').trim() || null, ...expectedVersion(v) };
    if (values.itemKey) body.itemKey = values.itemKey;
    if (v.mode === 'fix') return { path: `${base}/${encodeURIComponent(v.target)}/replace`, body: { ...body, reason: String(values.reason).trim() } };
    return { path: base, body };
  }
  function save(v) {
    if (!isCurrent(v) || !v.mode || v.busy) return;
    if (lockReason(v.c)) { v.msg = MSG.locked; v.msgKind = 'error'; render(v); return; }
    if (v.pending && v.pending.ambiguous) return send(v, v.pending);
    const errors = validate(v.values, v.mode);
    if (errors) {
      v.errors = errors; v.msg = '請修正標示的欄位後再儲存。'; v.msgKind = 'error'; render(v);
      try { const first = v.root.querySelector('[aria-invalid="true"]'); first && first.focus && first.focus(); } catch {}
      return;
    }
    v.errors = null;
    v.pending = { ...buildRequest(v), mode: v.mode, target: v.target, ambiguous: false };
    persist(v);
    return send(v, v.pending);
  }
  async function send(v, pending) {
    if (!pending || v.busy) return;
    const ctx = { v, c: v.c, userId: v.userId, caseId: v.caseId, op: opKey(pending.mode, pending.target), mode: pending.mode };
    v.busy = true; v.msg = '儲存中…'; v.msgKind = ''; render(v);
    try {
      const res = await fetchJson('POST', pending.path, pending.body);
      onSuccess(ctx, res);
    } catch (e) {
      onFailure(ctx, pending, e);
    }
  }
  function onSuccess(ctx, res) {
    const caseVersion = res && res.case;
    // 只合併權威版本欄位（單調）；不碰 logs/items 或其他抽屜草稿
    if (caseVersion) {
      let synced = false;
      try { if (typeof v10SyncUpdatedAt === 'function') { v10SyncUpdatedAt(ctx.c, { id: ctx.caseId, updatedAt: caseVersion.updatedAt, contentVersion: caseVersion.contentVersion }); synced = true; } } catch {}
      if (!synced) {   // 後援：同樣的單調規則，只動版本戳
        const apply = t => { if (!t || (Number.isFinite(t._contentVersion) && caseVersion.contentVersion < t._contentVersion)) return; t._updatedAt = caseVersion.updatedAt; t._contentVersion = caseVersion.contentVersion; };
        apply(ctx.c);
        try { const twin = (typeof CASES !== 'undefined' && Array.isArray(CASES)) ? CASES.find(x => x.id === ctx.caseId) : null; if (twin && twin !== ctx.c) apply(twin); } catch {}
      }
    }
    clearDraft(ctx.userId, ctx.caseId, ctx.op);
    const v = ctx.v;
    if (!isCurrent(v)) return;
    v.busy = false; v.pending = null; v.mode = null; v.target = null; v.errors = null; v.msg = '';
    v.liveMsg = ctx.mode === 'fix' ? MSG.corrected : ctx.mode === 'void' ? MSG.voided : MSG.saved; v.liveKind = 'ok';
    render(v); focusAct(v, 'new'); load(v);
  }
  function failureMessage(e) {
    const status = e && e.status, code = e && e.data && e.data.error;
    if (status === 409 && (code === 'edit_conflict' || code === 'case_conflict')) return MSG.conflict;
    if (status === 409 && code === 'case_locked') return MSG.locked;
    if (status === 409 && code === 'delivery_already_voided') return MSG.gone;
    if (status === 409 && code === 'delivery_request_conflict') return MSG.reused;
    if (status === 403) return code === 'actor_inactive' ? MSG.inactive : MSG.forbidden;
    if (status === 404) return MSG.gone;
    if (status === 400 && e.data && Array.isArray(e.data.issues)) {
      const fields = [...new Set(e.data.issues.map(i => FIELD_LABEL[i.path && i.path[0]]).filter(Boolean))];
      return `欄位格式不正確${fields.length ? '：' + fields.join('、') : ''}，內容已保留。`;
    }
    if (status === 422 && e.data && typeof e.data.message === 'string') return e.data.message + '，內容已保留。';
    return MSG.generic;
  }
  function onFailure(ctx, pending, e) {
    const status = e && e.status;
    const ambiguous = !status || status === 0 || status >= 500 || (e && e.timeout);
    const draft = readDraft(ctx.userId, ctx.caseId, ctx.op) || { userId: ctx.userId, caseId: ctx.caseId, op: ctx.op, values: ctx.v.values };
    // 結果不明：保留「完全相同」的請求；確定被拒（4xx）：伺服器未儲存，清除待送請求、保留內容
    draft.pending = ambiguous ? { ...pending, ambiguous: true } : null;
    writeDraft(draft);
    const v = ctx.v;
    if (!isCurrent(v)) return;
    v.busy = false; v.pending = draft.pending;
    v.msg = ambiguous ? MSG.ambiguous : failureMessage(e); v.msgKind = 'error';
    render(v);
  }

  // ── openDrawer hook (outermost) ───────────────────────────────────────────
  const original = window.openDrawer;
  if (typeof original === 'function') {
    window.openDrawer = function (c) {
      // 先同步清空並隱藏上一案的交付區，避免切案期間顯示或操作 A 案內容
      active = null;
      const stale = document.getElementById('d-deliveries');
      if (stale) { stale.innerHTML = ''; stale.hidden = true; }
      const result = original.apply(this, arguments);
      const gen = seqNow();
      Promise.resolve(result).then(() => onOpened(c, gen), () => {});
      return result;
    };
  }
  window.caseDeliveriesUi = { onOpened, validate, meaningfulNote, lockReason, readDraft, _active: () => active, _reset: () => { featureOff = false; active = null; memoryDrafts.clear(); } };
})();
