/* REPORTS-P1-C2 送審與核可（交付明細制）：案件抽屜與主管核可清單共用同一份送審依據。
 * - 掛在最外層 openDrawer 之後（B「交付成果」之後），等既有權限與歷史唯讀 sweep 完成才渲染。
 * - 權限一律以真實登入者 ME.id／ME.role 與穩定的主責／協作者 ID 判斷；view-as 與姓名不會擴大權限。
 * - 送審、撤回、核可／退回、導入都只走 C1 專用端點，不再呼叫舊的 PATCH review_done／done／closed。
 * - 每個操作有穩定識別碼；結果不明（斷線／逾時／5xx）時保留「完全相同」的請求，必須「重新確認送出」，
 *   伺服器以同一識別碼重送回 replay，不會產生第二筆。確定被拒（4xx）時保留輸入內容。
 * - 非同步回覆綁定「原案件＋原登入者＋抽屜世代＋DOM」，切案或延遲回覆不會畫到別案；
 *   案件版本只做單調合併，不會讓舊內容拿到新版本號。
 * - 明細制案件不會因開關關閉而退回舊制：暫停時仍可檢視與撤回／退回，不能新送審、核可、導入。
 */
(() => {
  if (window.__caseWorkflowInstalled) return;
  window.__caseWorkflowInstalled = true;

  const SUBMITTABLE = new Set(['todo', 'wait', 'doing', 'review', 'print']);
  const TERMINAL = new Set(['done', 'closed', 'cancelled']);
  const SUBMIT_TARGETS = new Set(['review_done', 'done', 'closed']);
  const KIND_LABEL = { main: '主設計', extension: '延伸', support: '支援' };
  const KIND_ORDER = ['main', 'extension', 'support'];
  const STATUS_LABEL = { pending: '待主管核可', approved: '已核可', rejected: '已退回', withdrawn: '已撤回', cancelled: '已隨案件取消' };
  const STORE_PREFIX = 'dpm.workflow.v1:', STORE_INDEX = 'dpm.workflow.v1.index', MAX_DRAFTS = 20, MAX_DRAFT_BYTES = 8000;
  const MSG = {
    ambiguous: '連線不穩，無法確認是否已送出。內容已保留，請按「重新確認送出」；伺服器會以同一識別碼確認，不會產生第二筆。',
    conflict: '案件內容剛被更新（可能有人登錄交付、修改歸檔或已處理送審）。你的輸入已保留，請按「重新檢視」確認最新內容後再送出。',
    clientUpdate: '畫面版本過舊，請重新整理頁面後再操作；你的輸入已保留。',
    paused: '交付明細流程目前暫停：可檢視紀錄，撤回與退回仍可使用；暫不能新送審、核可或導入。',
    alreadySubmitted: '此案件已送主管核可（可能是你或協作者剛送出），已重新讀取。',
    closed: '這筆送審已被處理，或已不是目前待核可的版本，已重新讀取。',
    evidenceChanged: '送審後歸檔位置或交付明細已變動，不能核可；請退回讓設計師重新送審。',
    reused: '這次操作的識別碼已用於其他內容，伺服器沒有寫入。請重新讀取後再操作。',
    forbidden: '你目前沒有這個操作的權限；你的輸入已保留。',
    adminOnly: '只有在職的管理員可以執行此操作。',
    inactive: '帳號已停用或尚未啟用，無法執行此操作。',
    readOnly: '觀察者帳號為唯讀。',
    lifecyclePending: '此案件有封存／復工申請待主管決議，暫不能送審；請先等決議，或在「時程與週期」撤回申請後再送審。',
    lifecycleClosed: '案件已未完成封存或週期已結束，無法送審。',
    notRecords: '此案件為舊制，已重新讀取。',
    adoptNotAllowed: '只有未封存、在辦且未送主管核可的舊制案件可以導入，已重新讀取。',
    featureOff: '交付明細流程未啟用。',
    loadFail: '送審紀錄讀取失敗，請稍後按「重新讀取」。',
    generic: '操作失敗，你的輸入已保留，請稍後再試。',
  };

  const esc = value => (typeof escapeHtml === 'function' ? escapeHtml(value) : String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));
  const seqNow = () => (window.v95DrawerSeq && typeof window.v95DrawerSeq.now === 'function' ? window.v95DrawerSeq.now() : 0);
  const me = () => (typeof ME !== 'undefined' && ME && ME.id != null && ME.id !== 0 ? ME : null);
  const sameId = (a, b) => a != null && b != null && a !== '' && b !== '' && String(a) === String(b);
  const enc = id => encodeURIComponent(id);
  const toast = (m, t) => { try { if (typeof showToast === 'function') showToast(m, t); } catch {} };
  const newId = prefix => {
    let core;
    try { core = crypto.randomUUID(); } catch { core = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12); }
    return (prefix + '-' + core).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
  };
  const when = iso => {
    if (!iso) return '—';
    try { return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)); }
    catch { return String(iso).slice(0, 16).replace('T', ' '); }
  };
  const casesList = () => (typeof CASES !== 'undefined' && Array.isArray(CASES) ? CASES : []);
  const twinOf = c => (c ? casesList().find(x => x && x.id === c.id && x !== c) || null : null);

  // ── drafts（真實登入者 ID＋案件＋操作；sessionStorage 失敗改記憶體）─────────────
  const memoryDrafts = new Map();
  function store() {
    try { const s = window.sessionStorage; if (!s) return null; const probe = STORE_PREFIX + 'probe'; s.setItem(probe, '1'); s.removeItem(probe); return s; }
    catch { return null; }
  }
  const draftKey = (userId, caseId, op) => `${STORE_PREFIX}${userId}:${caseId}:${op}`;
  function readDraft(userId, caseId, op) {
    const key = draftKey(userId, caseId, op);
    const valid = d => (d && sameId(d.userId, userId) && d.caseId === caseId && d.op === op ? d : null);
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
      if (text.length > MAX_DRAFT_BYTES) { s.removeItem(key); return; }
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

  // ── identity / permissions ────────────────────────────────────────────────
  function access(c) {
    const actor = me();
    const readonly = !actor || actor.role === 'observer' || (typeof IS_OBSERVER === 'function' && IS_OBSERVER());
    const isAdmin = !readonly && actor.role === 'admin';
    const assigned = !!actor && !!c && (sameId(c._designerId, actor.id) || (Array.isArray(c._collaboratorIds) && c._collaboratorIds.some(x => sameId(x, actor.id))));
    return { actor, readonly, isAdmin, assigned, canSubmit: !readonly && (isAdmin || assigned), canDecide: isAdmin, canAdopt: isAdmin };
  }
  const isRecords = c => !!c && c.deliveryMode === 'records';
  const isPendingCase = c => !!c && c.status === 'review_done';

  // ── version merge（單調；不讓舊內容拿到新版本號）──────────────────────────────
  // 操作回覆只有版本＋狀態：只在「剛好前進一版」（＝只有這次操作）時蓋章，其餘交給權威重讀。
  function applyOpCase(c, opCase, extra) {
    if (!c || !opCase || !Number.isFinite(opCase.contentVersion)) return;
    for (const t of [c, twinOf(c)]) {
      if (!t || !Number.isFinite(t._contentVersion) || opCase.contentVersion !== t._contentVersion + 1) continue;
      t._updatedAt = opCase.updatedAt; t._contentVersion = opCase.contentVersion;
      if (opCase.status) t.status = opCase.status;
      Object.assign(t, extra || {});
    }
  }
  const stampMs = v => { const n = v ? new Date(v).getTime() : NaN; return Number.isFinite(n) ? n : null; };
  // 權威快照新舊以 (contentVersion, updatedAt) 一起比：非證據欄位的修改只前進 updatedAt，
  // 所以同一 contentVersion 但 updatedAt 較舊的延遲回應也必須丟棄，不可把狀態或版本戳往回蓋。
  function olderSnapshot(t, norm) {
    if (Number.isFinite(t._contentVersion) && Number.isFinite(norm._contentVersion)) {
      if (norm._contentVersion < t._contentVersion) return true;
      if (norm._contentVersion > t._contentVersion) return false;
    }
    const mine = stampMs(t._updatedAt), theirs = stampMs(norm._updatedAt);
    return mine != null && theirs != null && theirs < mine;
  }
  function mergeNormalized(t, norm) {
    if (!t || !norm || norm.id !== t.id) return false;
    if (olderSnapshot(t, norm)) return false;
    if (t.deliveryMode === 'records' && norm.deliveryMode !== 'records') norm.deliveryMode = 'records';   // 明細制單向，絕不降級
    Object.assign(t, norm);
    return true;
  }
  async function refreshCase(c) {
    if (!c || !c.id) return false;
    const actor = me(), actorId = actor ? actor.id : null;
    let raw;
    try { raw = await fetchJson('GET', `/api/cases/${enc(c.id)}`); } catch { return false; }
    if (!raw || raw.id !== c.id || typeof normalizeCase !== 'function') return false;
    const now = me(); if (!now || !sameId(now.id, actorId)) return false;   // 換人登入後到的舊讀取不合併
    let changed = false;
    for (const t of [c, twinOf(c)]) {
      if (t && mergeNormalized(t, normalizeCase(raw))) { changed = true; try { if (typeof decorateCase === 'function') decorateCase(t); } catch {} }
    }
    try { if (typeof decorateCases === 'function') decorateCases(); } catch {}
    try { if (typeof refreshAll === 'function') refreshAll(); } catch {}
    return changed;
  }

  // ── views ─────────────────────────────────────────────────────────────────
  let active = null;                       // drawer view
  const queueViews = new Map();            // caseId → queue review view
  const intents = new Map();               // `${userId}:${caseId}` → panel to open after the drawer opens
  const flashes = new Map();               // `${userId}:${caseId}` → message shown once after reopen
  const queueModes = new Map();            // caseId → deliveryMode of the last rendered approval queue
  const keyOf = (userId, caseId) => `${userId}:${caseId}`;

  function isCurrent(v) {
    if (!v || !v.root || v.root.isConnected === false) return false;
    const actor = me(); if (!actor || !sameId(actor.id, v.userId)) return false;
    if (v.kind === 'queue') return queueViews.get(v.caseId) === v;
    if (active !== v || v.gen !== seqNow()) return false;
    if (typeof currentCase !== 'undefined' && currentCase && currentCase.id !== v.caseId) return false;
    return true;
  }
  function ensureRoot() {
    let root = document.getElementById('d-workflow');
    if (root) return root;
    const anchor = document.getElementById('d-deliveries') || document.getElementById('d-archive');
    if (!anchor || !anchor.parentNode) return null;
    root = document.createElement('section');
    root.id = 'd-workflow'; root.className = 'cw-root'; root.setAttribute('aria-labelledby', 'cw-title');
    const parent = anchor.parentNode;
    const kids = Array.isArray(parent.children) ? parent.children : Array.from(parent.children || []);
    parent.insertBefore(root, kids[kids.indexOf(anchor) + 1] || null);
    return root;
  }
  function removeRoot() { const root = document.getElementById('d-workflow'); if (root) root.remove(); }

  function newView(kind, c, root, gen) {
    const actor = me();
    return { kind, c, caseId: c.id, userId: actor.id, gen, root, data: null, loading: false, loadError: '', loadSeq: 0, panel: null, preview: null,
      values: {}, errors: null, busy: false, pending: null, msg: '', msgKind: '', liveMsg: '', liveKind: '' };
  }
  function onOpened(c, gen) {
    const actor = me();
    if (!c || !c.id || !actor || gen !== seqNow()) return;
    if (typeof currentCase !== 'undefined' && currentCase && currentCase.id !== c.id) return;
    const root = ensureRoot(); if (!root) return;
    root.hidden = false;
    const v = newView('drawer', c, root, gen);
    active = v;
    const k = keyOf(v.userId, v.caseId);
    const flash = flashes.get(k); if (flash) { flashes.delete(k); v.liveMsg = flash.msg; v.liveKind = flash.kind; }
    const intent = intents.get(k); if (intent) { intents.delete(k); v.intentPanel = intent.panel; }
    applyFreeze(v);
    wire(v); render(v);
    load(v).then(() => {
      if (!isCurrent(v)) return;
      const ambiguous = findAmbiguous(v);
      if (ambiguous) openPanel(v, ambiguous.panel, ambiguous.sid, false);
      else if (v.intentPanel) { const want = v.intentPanel; v.intentPanel = null; openPanel(v, want, null, true); }
    });
  }
  function findAmbiguous(v) {
    const ops = ['adopt', 'submit'];
    const pendingSub = pendingSubmission(v);
    if (pendingSub) ops.push(`withdraw:${pendingSub.id}`, `decide:${pendingSub.id}`);
    for (const op of ops) {
      const d = readDraft(v.userId, v.caseId, op);
      if (d && d.pending && d.pending.ambiguous) return { panel: op.split(':')[0] === 'decide' ? 'review' : op.split(':')[0], sid: op.split(':')[1] || null };
    }
    return null;
  }

  async function load(v) {
    const seq = ++v.loadSeq;
    v.loading = true; v.loadError = ''; if (isCurrent(v)) render(v);
    try {
      const data = await fetchJson('GET', `/api/cases/${enc(v.caseId)}/delivery-submissions`);
      if (seq !== v.loadSeq || !isCurrent(v)) return;
      if (v.data && Number.isFinite(v.data.contentVersion) && Number.isFinite(data.contentVersion) && data.contentVersion < v.data.contentVersion) { v.loading = false; render(v); return; }
      v.data = data; v.loading = false;
      if (data.mode === 'records' && v.c && v.c.deliveryMode !== 'records' && !(Number.isFinite(v.c._contentVersion) && data.contentVersion < v.c._contentVersion)) {
        for (const t of [v.c, twinOf(v.c)]) if (t) t.deliveryMode = 'records';
      }
      reconcileSubmit(v);
      rebindDecision(v);
      if (v.kind === 'drawer') applyFreeze(v);
      render(v);
      // 本地案件比伺服器舊（例如別人剛送審）：權威重讀後重開抽屜，讓狀態選單與唯讀設定一致
      if (v.kind === 'drawer' && Number.isFinite(data.contentVersion) && Number.isFinite(v.c._contentVersion) && data.contentVersion > v.c._contentVersion
          && (data.status !== v.c.status || (data.pendingSubmissionId ?? null) !== (v.c.pendingDeliverySubmissionId ?? null))) {
        const changed = await refreshCase(v.c);
        if (changed && isCurrent(v) && typeof openDrawer === 'function') openDrawer(v.c);
      }
    } catch (e) {
      if (seq !== v.loadSeq) return;
      if (e && e.status === 404 && e.data && e.data.error === 'feature_disabled' && !isRecords(v.c)) {
        // 真正的舊制案件且明細功能未啟用：安靜隱藏本區
        if (v.kind === 'drawer' && active === v) { active = null; removeRoot(); }
        else if (isCurrent(v)) { v.loading = false; v.loadError = MSG.featureOff; render(v); }
        return;
      }
      if (!isCurrent(v)) return;
      v.loading = false; v.loadError = MSG.loadFail; render(v);
    }
  }
  // 結果不明的送審：重讀後若已看到同一識別碼的送審，視為已成功
  function reconcileSubmit(v) {
    const d = readDraft(v.userId, v.caseId, 'submit');
    if (!d || !d.pending || !v.data) return;
    const hit = (v.data.submissions || []).find(s => s.id === d.pending.body.id);
    if (!hit) return;
    clearDraft(v.userId, v.caseId, 'submit');
    if (v.panel === 'submit') { v.panel = null; v.pending = null; }
    v.liveMsg = '已確認送出：這份送審已建立，沒有重複送出。'; v.liveKind = 'ok';
    flashes.set(keyOf(v.userId, v.caseId), { msg: v.liveMsg, kind: 'ok' });   // 隨後的權威重讀若重開抽屜仍顯示
  }
  const workflow = v => (v.data && v.data.workflow) || {};
  // REPORTS-P2-D2: 受控案件的封存／復工申請待決或已非進行中時不開放新送審。以畫面實際檢視的同一快照
  // （送審清單或送審摘要讀到的列）判斷；伺服器仍會拒絕，這裡只是不提供一個注定 409 的按鈕。
  const lifecycleBlock = d => (!d || d.lifecycleMode !== 'managed' ? ''
    : d.pendingLifecycleRequestId ? MSG.lifecyclePending
    : d.lifecycleStatus && d.lifecycleStatus !== 'active' ? MSG.lifecycleClosed : '');
  const mode = v => (isRecords(v.c) || (v.data && v.data.mode === 'records') ? 'records' : 'legacy');
  function pendingSubmission(v) {
    const d = v.data; if (!d || !d.pendingSubmissionId) return null;
    return (d.submissions || []).find(s => s.id === d.pendingSubmissionId && s.status === 'pending') || null;
  }
  // REPORTS-P2-D2: the listing's own cycle id (same row read as its versions) for lifecycle-managed cases.
  const versionsOf = d => ({ expectedUpdatedAt: d.updatedAt, expectedContentVersion: d.contentVersion, ...(d.lifecycleMode === 'managed' ? { expectedCycleId: d.currentCycleId ?? null } : {}) });
  // 主管的 0 件支援核可只對勾選當下那一份（不可變的）送審 ID 有效
  const zeroOkFor = (v, sub) => !!sub && (v.values.zeroOk === true || v.values.zeroOk === 'true') && v.values.zeroOkFor === sub.id;
  // 待核可的送審換成另一份（例如 S1 退回後重送 S2）：審核／撤回的勾選與評語不沿用到新送審；
  // 若上一份的操作結果不明，保留那筆完全相同的請求供確認，不改寫、不轉套。
  function rebindDecision(v) {
    if (!v.sid || !(v.kind === 'queue' || v.panel === 'review' || v.panel === 'withdraw')) return;
    const cur = pendingSubmission(v);
    if (cur && cur.id === v.sid) return;
    if (v.pending && v.pending.ambiguous && v.pending.op && v.pending.op.endsWith(':' + v.sid)) return;
    const kind = v.panel === 'withdraw' ? 'withdraw' : 'decide';
    v.sid = cur ? cur.id : null;
    const draft = cur ? readDraft(v.userId, v.caseId, `${kind}:${cur.id}`) : null;
    v.values = draft ? { ...draft.values } : {}; v.pending = draft && draft.pending ? draft.pending : null; v.errors = null;
    if (cur) { v.msg = '目前待核可的是另一份新送審；請重新審閱下方依據，先前的勾選與評語不沿用。'; v.msgKind = 'error'; }
  }
  // 完整登錄確認只對「勾選當下看到的那一版」有效；版本變了就要重新確認
  const revKey = versions => (versions ? `${versions.expectedContentVersion}|${versions.expectedUpdatedAt}` : '');
  const confirmedFor = (v, versions) => (v.values.confirm === true || v.values.confirm === 'true') && !!versions && v.values.confirmRev === revKey(versions);

  // ── panels ────────────────────────────────────────────────────────────────
  function opFor(v, panel, sid) {
    if (panel === 'withdraw') return `withdraw:${sid}`;
    if (panel === 'review') return `decide:${sid}`;
    return panel;
  }
  function openPanel(v, panel, sid, focus = true) {
    if (!isCurrent(v) || v.busy) return;
    const a = access(v.c), sub = pendingSubmission(v);
    if (panel === 'withdraw' || panel === 'review') {
      if (!sub) { v.liveMsg = '目前沒有待核可的送審。'; v.liveKind = ''; render(v); return; }
      sid = sub.id;
      if (panel === 'review' && !a.canDecide) panel = a.canSubmit ? 'withdraw' : null;
      if (panel === 'withdraw' && !a.canSubmit) panel = null;
    }
    if (panel === 'submit' && !a.canSubmit) panel = null;
    if (panel === 'submit' && lifecycleBlock(v.data)) {
      const d0 = readDraft(v.userId, v.caseId, 'submit');
      if (!(d0 && d0.pending && d0.pending.ambiguous)) { v.liveMsg = lifecycleBlock(v.data); v.liveKind = 'error'; render(v); return; }
    }
    if (panel === 'adopt' && !a.canAdopt) panel = null;
    if (!panel) { v.liveMsg = MSG.forbidden.replace('；你的輸入已保留', ''); v.liveKind = 'error'; render(v); return; }
    v.panel = panel; v.sid = sid || null; v.errors = null; v.msg = ''; v.msgKind = '';
    const draft = readDraft(v.userId, v.caseId, opFor(v, panel, v.sid));
    v.values = draft ? { ...draft.values } : {};
    v.pending = draft && draft.pending ? draft.pending : null;
    if (v.pending && v.pending.ambiguous) { v.msg = MSG.ambiguous; v.msgKind = 'error'; }
    v.focusPanel = focus;
    if (panel === 'submit' && !(v.pending && v.pending.ambiguous)) { prepareSubmit(v); return; }
    render(v);
  }
  function closePanel(v) {
    persist(v);
    v.panel = null; v.sid = null; v.preview = null; v.errors = null; v.pending = null; v.msg = '';
    releaseArchiveLock(v);
    render(v);
  }
  function persist(v) {
    if (!v.panel) return;
    writeDraft({ userId: v.userId, caseId: v.caseId, op: opFor(v, v.panel, v.sid), values: v.values || {}, pending: v.pending || null });
  }

  // 送審前：先等歸檔位置儲存完成，再權威讀取「實際要送的」歸檔與交付明細，兩者版本一致才可送出
  async function prepareSubmit(v) {
    const c = v.c, gen = v.gen;
    v.preview = { loading: true }; render(v);
    try {
      const pendingSave = typeof v41ArchivePending !== 'undefined' && v41ArchivePending.get ? v41ArchivePending.get(c.id) : null;
      if (pendingSave && !await pendingSave) { if (isCurrent(v) && v.gen === gen) { v.preview = { error: '歸檔位置尚未儲存成功，請先處理歸檔位置後再送審。' }; render(v); } return; }
      const draft = typeof v41ArchiveDraft === 'function' ? String(v41ArchiveDraft(c) ?? '').trim() : null;
      if (draft !== null && draft !== String(c.archivePath || '').trim()) {
        const ok = typeof v41SaveArchive === 'function' ? await v41SaveArchive(c) : false;
        if (!ok) { if (isCurrent(v) && v.gen === gen) { v.preview = { error: '歸檔位置尚未儲存成功，請先處理歸檔位置後再送審。' }; render(v); } return; }
      }
      if (!isCurrent(v)) return;
      let listing = null, raw = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        listing = await fetchJson('GET', `/api/cases/${enc(c.id)}/deliveries`);
        raw = await fetchJson('GET', `/api/cases/${enc(c.id)}`);
        if (!isCurrent(v)) return;
        if (raw && listing && raw.contentVersion === listing.contentVersion && new Date(raw.updatedAt).getTime() === new Date(listing.updatedAt).getTime()) break;
        listing = null;
      }
      if (!listing) { v.preview = { error: '案件正在更新，請稍候再按「重新檢視」。' }; render(v); return; }
      if (typeof normalizeCase === 'function') for (const t of [c, twinOf(c)]) if (t) mergeNormalized(t, normalizeCase(raw));
      v.preview = { listing, archivePath: raw.archivePath ? String(raw.archivePath).trim() : '', status: raw.status, versions: versionsOf(listing) };
      if (!confirmedFor(v, v.preview.versions)) { v.values.confirm = false; delete v.values.confirmRev; persist(v); }
      lockArchive(v);
      render(v);
    } catch (e) {
      if (!isCurrent(v)) return;
      v.preview = { error: e && e.status === 404 && e.data && e.data.error === 'feature_disabled' ? MSG.featureOff : '讀取送審摘要失敗，請按「重新檢視」再試一次。' };
      render(v);
    }
  }
  // 摘要顯示期間鎖住歸檔輸入，確保送出的就是畫面上審視的內容
  function lockArchive(v) {
    if (v.kind !== 'drawer') return;
    for (const id of ['d-archive-input', 'd-archive-save']) {
      const el = document.getElementById(id);
      if (el && !el.disabled) { el.disabled = true; el.dataset.cwLock = '1'; }
    }
  }
  function releaseArchiveLock(v) {
    if (v.kind !== 'drawer' || isRecords(v.c) && isPendingCase(v.c)) return;
    for (const id of ['d-archive-input', 'd-archive-save']) {
      const el = document.getElementById(id);
      if (el && el.dataset && el.dataset.cwLock) { el.disabled = false; delete el.dataset.cwLock; }
    }
  }

  // 送審中／已核可：證據（歸檔、子案件、結案數量）唯讀並說明原因
  function applyFreeze(v) {
    if (v.kind !== 'drawer' || !isRecords(v.c)) return;
    const pending = isPendingCase(v.c), approved = v.c.status === 'closed' || v.c.status === 'done';
    if (!pending && !approved) return;
    const text = pending ? '送審期間歸檔位置、子案件、交付明細與結案數量暫停修改；如需更正請先撤回送審。' : '已核可結案：送審依據已凍結。';
    for (const id of ['d-archive-input', 'd-archive-save', 'd-req-count', 'd-out-count', 'd-closure-save']) {
      const el = document.getElementById(id); if (el) { el.disabled = true; el.classList.add('cw-frozen'); }
    }
    const fb = document.getElementById('d-archive-feedback'); if (fb && pending) fb.textContent = text;
    const panel = document.querySelector('#drawer .v43-items-panel');
    if (panel) {
      panel.querySelectorAll('input, select, textarea, button').forEach(el => { el.disabled = true; el.classList.add('cw-frozen'); });
      panel.querySelectorAll('[draggable="true"]').forEach(el => { el.setAttribute('draggable', 'false'); });
      if (!panel.querySelector('.cw-frozen-note')) {
        const note = document.createElement('p'); note.className = 'cw-frozen-note'; note.textContent = text;
        panel.insertBefore(note, panel.firstChild || null);
      }
    }
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  function chipsHtml(groups) {
    const list = (Array.isArray(groups) ? groups : []).slice().sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
    if (!list.length) return '<p class="cw-muted">沒有有效交付。</p>';
    return `<div class="cw-chips" aria-label="交付摘要（主設計、延伸、支援分開統計）">${list.map(g => `<span class="cw-chip">${esc(KIND_LABEL[g.kind] || g.kind)} <b>${esc(String(g.quantity))}</b> ${esc(g.unit || '件')}<span class="cw-sub"> · ${esc(String(g.records))} 筆</span></span>`).join('')}</div>`;
  }
  function zeroHtml(list) {
    if (!Array.isArray(list) || !list.length) return '';
    return `<div class="cw-zero"><p class="cw-label">支援工作（0 件）與說明</p><ul>${list.map(z => `<li><span class="cw-strong">${esc(z.itemName || '支援')}</span>：${esc(z.note || '（未附說明）')}</li>`).join('')}</ul></div>`;
  }
  function snapshotHtml(s, heading) {
    return `<div class="cw-snapshot" aria-label="${esc(heading || '送審依據')}">
      <p class="cw-label">${esc(heading || '送審依據（送出當下的快照，無法修改）')}</p>
      <dl class="cw-dl">
        <dt>歸檔位置</dt><dd class="cw-path">${esc(s.archivePath || '—')}</dd>
        <dt>送審</dt><dd>${esc(s.submittedByName || '—')} · ${esc(when(s.submittedAt))}</dd>
        <dt>有效交付</dt><dd>${esc(String((s.recordIds || []).length))} 筆</dd>
      </dl>
      ${chipsHtml(s.summary)}${zeroHtml(s.zeroSupport)}</div>`;
  }
  function historyHtml(v) {
    const subs = (v.data && v.data.submissions) || [];
    if (!subs.length) return '';
    return `<details class="cw-history"><summary>送審紀錄（${esc(String(subs.length))}）</summary><ol class="cw-hist-list">${subs.map(s => `<li class="cw-hist-row">
      <div class="cw-hist-line"><span class="cw-state is-${esc(s.status)}">${esc(STATUS_LABEL[s.status] || s.status)}</span><span>${esc(when(s.submittedAt))}</span><span class="cw-muted">送審：${esc(s.submittedByName || '—')}</span></div>
      ${s.decidedAt ? `<div class="cw-muted">處理：${esc(s.decidedByName || '—')} · ${esc(when(s.decidedAt))}${s.decisionReason ? `　原因：${esc(s.decisionReason)}` : ''}${s.zeroSupportApproved ? '　（已核可 0 件支援說明）' : ''}</div>` : ''}
      <div class="cw-muted cw-path">歸檔：${esc(s.archivePath || '—')}</div>${chipsHtml(s.summary)}${zeroHtml(s.zeroSupport)}</li>`).join('')}</ol></details>`;
  }
  function fieldError(v, name) { return v.errors && v.errors[name] ? `<span class="cw-error" id="cw-err-${name}">${esc(v.errors[name])}</span>` : ''; }
  function invalid(v, name) { return v.errors && v.errors[name] ? `aria-invalid="true" aria-describedby="cw-err-${name}"` : ''; }
  function msgHtml(v) {
    return `<p class="cw-msg${v.msgKind === 'error' ? ' is-error' : v.msgKind === 'ok' ? ' is-ok' : ''}" role="status" aria-live="polite">${esc(v.msg || '')}</p>`
      + (v.pageReload ? '<div class="cw-actions"><button type="button" class="cw-btn" data-act="reload-page">重新整理頁面</button></div>' : '');
  }
  function actionsHtml(v, primaryAct, primaryLabel, opts = {}) {
    const ambiguous = !!(v.pending && v.pending.ambiguous);
    const extra = opts.extra || '';
    return `<div class="cw-actions">
      <button type="button" class="cw-btn cw-btn-primary" data-act="${ambiguous ? 'reconcile' : primaryAct}" ${v.busy || (opts.disabled && !ambiguous) ? 'disabled' : ''}>${ambiguous ? '重新確認送出' : esc(primaryLabel)}</button>
      ${extra}
      <button type="button" class="cw-btn" data-act="close-panel" ${v.busy ? 'disabled' : ''}>${v.kind === 'queue' ? '收合' : '取消'}</button>
      ${opts.recheck ? `<button type="button" class="cw-btn" data-act="recheck" ${v.busy || ambiguous ? 'disabled' : ''}>重新檢視</button>` : ''}
    </div>`;
  }
  function submitHtml(v) {
    const p = v.preview || {};
    if (v.pending && v.pending.ambiguous) {
      return `<div class="cw-panel" data-cw-panel="submit" role="group" aria-labelledby="cw-panel-title"><p class="cw-panel-title" id="cw-panel-title">確認送出主管核可</p>
        <p class="cw-consequence">上次送出的結果不明。請按「重新確認送出」，伺服器會以同一識別碼確認，不會產生第二筆送審。</p>${actionsHtml(v, 'submit', '送出主管核可')}${msgHtml(v)}</div>`;
    }
    if (p.loading) return '<div class="cw-panel" data-cw-panel="submit"><p class="cw-muted" aria-busy="true">正在確認歸檔位置與交付明細…</p></div>';
    if (p.error) return `<div class="cw-panel" data-cw-panel="submit" role="group"><p class="cw-error" role="alert">${esc(p.error)}</p>${actionsHtml(v, 'recheck', '重新檢視', { recheck: false })}</div>`;
    const listing = p.listing || {}, records = (listing.records || []).filter(r => !r.voided), voided = (listing.records || []).length - records.length;
    const zero = records.filter(r => r.kind === 'support' && Number(r.quantity) === 0).map(r => ({ itemName: r.itemName, note: r.note }));
    const blockers = [];
    if (!p.archivePath) blockers.push(`<li>尚未填寫檔案歸檔位置。<button type="button" class="cw-btn cw-btn-link" data-act="goto-archive">前往填寫歸檔位置</button></li>`);
    if (!records.length) blockers.push(`<li>尚無有效交付（全部作廢視為尚未登錄）。<button type="button" class="cw-btn cw-btn-link" data-act="goto-deliveries">前往登錄交付</button></li>`);
    if (p.status && !SUBMITTABLE.has(p.status)) blockers.push('<li>案件目前狀態不能送審，請重新讀取。</li>');
    const paused = !!workflow(v).paused || workflow(v).workflowActive === false;
    if (paused) blockers.push(`<li>${esc(MSG.paused)}</li>`);
    const lifeBlocked = lifecycleBlock(listing) || lifecycleBlock(v.data);
    if (lifeBlocked) blockers.push(`<li>${esc(lifeBlocked)}</li>`);
    if (p.stale) blockers.push('<li>內容已更新，這份摘要已過期。請按「重新檢視」確認最新內容。</li>');
    const confirmed = confirmedFor(v, p.versions) && !p.stale;
    return `<div class="cw-panel" data-cw-panel="submit" role="group" aria-labelledby="cw-panel-title">
      <p class="cw-panel-title" id="cw-panel-title">送出主管核可前請確認</p>
      <dl class="cw-dl"><dt>歸檔位置</dt><dd class="cw-path">${p.archivePath ? esc(p.archivePath) : '<span class="cw-error">未填寫</span>'}</dd></dl>
      ${chipsHtml(listing.summary && listing.summary.groups)}${zeroHtml(zero)}
      ${records.length ? `<p class="cw-label">送出後成為送審依據的交付紀錄（${esc(String(records.length))} 筆，送出後無法修改）</p>
        <ul class="cw-evidence">${records.map(r => `<li><span>${esc(r.deliveredOn)}</span><span class="cw-strong">${esc(r.itemName)}</span><span class="cw-kind">${esc(KIND_LABEL[r.kind] || r.kind)}</span><span class="cw-qty">${esc(String(r.quantity))} ${esc(r.unit || '件')}</span></li>`).join('')}</ul>` : ''}
      ${voided ? `<p class="cw-muted">另有 ${esc(String(voided))} 筆已作廢紀錄不計入。</p>` : ''}
      ${blockers.length ? `<ul class="cw-blockers" role="alert">${blockers.join('')}</ul>` : ''}
      <fieldset ${v.busy ? 'disabled' : ''}><label class="cw-check"><input type="checkbox" data-f="confirm" ${confirmed ? 'checked' : ''} ${invalid(v, 'confirm')} ${blockers.length ? 'disabled' : ''}>
        <span>我已確認本案交付已完整登錄（主設計、延伸與支援工作都已登錄）</span></label>${fieldError(v, 'confirm')}</fieldset>
      ${actionsHtml(v, 'submit', '送出主管核可', { disabled: blockers.length > 0, recheck: true })}${msgHtml(v)}</div>`;
  }
  // 上一份送審（已被取代）的操作結果不明：先確認那一筆，絕不改套到新的送審
  function staleAmbiguousHtml(v, panel) {
    return `<div class="cw-panel" data-cw-panel="${panel}" role="group"><p class="cw-error" role="alert">上一份送審的操作結果不明，且目前待核可的已是另一份送審。請先按「重新確認送出」確認上一筆；確認前不會套用到新的送審。</p>
      <div class="cw-actions"><button type="button" class="cw-btn cw-btn-primary" data-act="reconcile" ${v.busy ? 'disabled' : ''}>重新確認送出</button></div>${msgHtml(v)}</div>`;
  }
  function withdrawHtml(v) {
    const ambiguous = !!(v.pending && v.pending.ambiguous);
    const current = pendingSubmission(v);
    if (ambiguous && current && v.pending.op !== `withdraw:${current.id}`) return staleAmbiguousHtml(v, 'withdraw');
    return `<div class="cw-panel" data-cw-panel="withdraw" role="group" aria-labelledby="cw-panel-title">
      <p class="cw-panel-title" id="cw-panel-title">撤回送審</p>
      <p class="cw-consequence">撤回後案件回到「設計製作中」，可更正交付或歸檔後重新送審；這次送審會保留在送審紀錄。</p>
      <fieldset ${v.busy || ambiguous ? 'disabled' : ''}><label class="cw-field">撤回原因<textarea data-f="reason" maxlength="500" rows="2" ${invalid(v, 'reason')}>${esc(v.values.reason || '')}</textarea>${fieldError(v, 'reason')}</label></fieldset>
      ${actionsHtml(v, 'withdraw', '撤回送審')}${msgHtml(v)}</div>`;
  }
  function reviewHtml(v, sub) {
    const ambiguous = !!(v.pending && v.pending.ambiguous);
    const paused = !!workflow(v).paused || workflow(v).workflowActive === false;
    const zero = Array.isArray(sub.zeroSupport) ? sub.zeroSupport.length : 0;
    if (ambiguous && v.pending.op !== `decide:${sub.id}`) return staleAmbiguousHtml(v, 'review');
    const zeroOk = zeroOkFor(v, sub);
    const pendingDecision = ambiguous && v.pending.body ? v.pending.body.decision : null;
    return `<div class="cw-panel" data-cw-panel="review" role="group" aria-labelledby="cw-panel-title-${esc(v.caseId)}">
      <p class="cw-panel-title" id="cw-panel-title-${esc(v.caseId)}">審核送審</p>
      ${snapshotHtml(sub)}
      ${paused ? `<p class="cw-banner" role="note">${esc(MSG.paused)}</p>` : ''}
      <fieldset ${v.busy || ambiguous ? 'disabled' : ''}>
        ${zero ? `<label class="cw-check"><input type="checkbox" data-f="zeroOk" ${zeroOk ? 'checked' : ''} ${invalid(v, 'zeroOk')}><span>我已審閱上列 ${esc(String(zero))} 筆 0 件支援工作的說明，並核可</span></label>${fieldError(v, 'zeroOk')}` : ''}
        <label class="cw-field">評語／退回原因（退回必填）<textarea data-f="comment" maxlength="1000" rows="2" ${invalid(v, 'comment')}>${esc(v.values.comment || '')}</textarea>${fieldError(v, 'comment')}</label>
      </fieldset>
      <div class="cw-actions">
        ${ambiguous ? `<button type="button" class="cw-btn cw-btn-primary" data-act="reconcile" ${v.busy ? 'disabled' : ''}>重新確認送出（${pendingDecision === 'reject' ? '退回' : '核可'}）</button>`
          : `<button type="button" class="cw-btn cw-btn-primary" data-act="approve" ${v.busy || paused ? 'disabled' : ''}>核可並結案</button>
             <button type="button" class="cw-btn cw-btn-danger" data-act="reject" ${v.busy ? 'disabled' : ''}>退回修改</button>`}
        <button type="button" class="cw-btn" data-act="close-panel" ${v.busy ? 'disabled' : ''}>${v.kind === 'queue' ? '收合' : '取消'}</button>
      </div>
      <p class="cw-muted">核可依據是上方送審快照；送審後歸檔或明細若有變動，只能退回。</p>${msgHtml(v)}</div>`;
  }
  function adoptHtml(v) {
    const ambiguous = !!(v.pending && v.pending.ambiguous);
    const ack = v.values.ack === true || v.values.ack === 'true';
    return `<div class="cw-panel" data-cw-panel="adopt" role="group" aria-labelledby="cw-panel-title">
      <p class="cw-panel-title" id="cw-panel-title">改用交付明細制</p>
      <p class="cw-consequence">導入後此案以交付明細送審與核可；這是單向變更，無法改回舊制。既有的舊版數量會保留。</p>
      <fieldset ${v.busy || ambiguous ? 'disabled' : ''}>
        <label class="cw-field">導入原因<textarea data-f="reason" maxlength="500" rows="2" ${invalid(v, 'reason')}>${esc(v.values.reason || '')}</textarea>${fieldError(v, 'reason')}</label>
        <label class="cw-check"><input type="checkbox" data-f="ack" ${ack ? 'checked' : ''} ${invalid(v, 'ack')}><span>我了解導入後無法改回舊制</span></label>${fieldError(v, 'ack')}
      </fieldset>
      ${actionsHtml(v, 'adopt', '確認導入')}${msgHtml(v)}</div>`;
  }

  function bodyHtml(v) {
    const c = v.c, a = access(c), data = v.data;
    if (v.loadError) return `<p class="cw-error" role="alert">${esc(v.loadError)}</p><div class="cw-actions"><button type="button" class="cw-btn" data-act="reload">重新讀取</button></div>`;
    if (!data) return '<p class="cw-muted" aria-busy="true">讀取送審紀錄中…</p>';
    const wf = workflow(v), sub = pendingSubmission(v);
    if (v.kind === 'queue') {
      if (!sub) return `<p class="cw-muted">這筆送審已被處理，或不是目前待核可的版本。</p><div class="cw-actions"><button type="button" class="cw-btn" data-act="refresh-queue">重新整理清單</button></div>`;
      if (!a.canDecide) return `<p class="cw-muted">${esc(MSG.adminOnly)}</p>${snapshotHtml(sub)}`;
      return reviewHtml(v, sub) + historyHtml(v);
    }
    let html = '';
    if (mode(v) === 'legacy') {
      html += '<p class="cw-note">舊制案件：沒有交付日期明細，沿用原本的送審方式（狀態改為「待主管核可」）。</p>';
      const eligible = !c.archived && SUBMITTABLE.has(c.status);
      if (a.canAdopt && wf.workflowActive && eligible) {
        html += v.panel === 'adopt' ? adoptHtml(v) : '<div class="cw-actions"><button type="button" class="cw-btn" data-act="open-adopt">改用交付明細制…</button></div>';
      } else if (a.canAdopt && wf.workflowActive === false && eligible) {
        html += '<p class="cw-muted">交付明細流程未啟用，暫不能導入。</p>';
      }
      return html + historyHtml(v);
    }
    if (wf.paused) html += `<p class="cw-banner" role="note">${esc(MSG.paused)}</p>`;
    if (c.deliveryModeSince) html += `<p class="cw-muted">自 ${esc(when(c.deliveryModeSince))} 由 ${esc(c.deliveryModeByName || '—')} 導入${c.deliveryModeReason ? `（${esc(c.deliveryModeReason)}）` : ''}。</p>`;
    if (sub) {
      html += `<p class="cw-state-line"><span class="cw-state is-pending">待主管核可</span> ${esc(sub.submittedByName || '—')} 於 ${esc(when(sub.submittedAt))} 送出</p>`;
      html += snapshotHtml(sub);
      html += '<p class="cw-note">送審期間歸檔位置、子案件、交付明細與結案數量暫停修改；如需更正請先撤回送審。</p>';
      if (v.panel === 'withdraw') html += withdrawHtml(v);
      else if (v.panel === 'review' && a.canDecide) html += reviewHtml(v, sub);
      else {
        const btns = [];
        if (a.canDecide) btns.push(`<button type="button" class="cw-btn cw-btn-primary" data-act="open-review">審核這份送審</button>`);
        if (a.canSubmit) btns.push(`<button type="button" class="cw-btn" data-act="open-withdraw">撤回送審…</button>`);
        html += btns.length ? `<div class="cw-actions">${btns.join('')}</div>` : `<p class="cw-muted">${a.readonly ? '觀察者為唯讀。' : '你不是此案件的主責或協作者，僅可檢視。'}</p>`;
      }
    } else if (c.status === 'closed' || c.status === 'done') {
      const approved = ((data.submissions || []).find(s => s.status === 'approved'));
      html += '<p class="cw-state-line"><span class="cw-state is-approved">已核可結案</span> 交付明細制案件核可後暫不提供重啟。</p>';
      if (approved) html += snapshotHtml(approved, `核可依據（${approved.decidedByName || '—'} · ${when(approved.decidedAt)}）`);
    } else if (!c.archived && SUBMITTABLE.has(c.status)) {
      const last = (data.submissions || [])[0];
      if (last && (last.status === 'rejected' || last.status === 'withdrawn')) {
        html += `<p class="cw-note">上次送審${esc(STATUS_LABEL[last.status])}${last.decisionReason ? `：${esc(last.decisionReason)}` : ''}。更正後可重新送審。</p>`;
      }
      if (v.panel === 'submit') html += submitHtml(v);
      else if (lifecycleBlock(data)) html += `<p class="cw-banner" role="note">${esc(lifecycleBlock(data))}</p>`;
      else if (wf.paused || wf.workflowActive === false) html += '<p class="cw-muted">流程暫停中，暫不能新送審。</p>';
      else if (a.canSubmit) html += '<div class="cw-actions"><button type="button" class="cw-btn cw-btn-primary" data-act="open-submit">送出主管核可…</button></div>';
      else html += `<p class="cw-muted">${a.readonly ? '觀察者為唯讀。' : '你不是此案件的主責或協作者，僅可檢視。'}</p>`;
    } else {
      html += '<p class="cw-muted">案件已取消或封存，無法送審。</p>';
    }
    return html + historyHtml(v);
  }
  function render(v) {
    if (!isCurrent(v)) return;
    const recordsMode = v.data || v.c ? mode(v) === 'records' : false;
    const badge = v.data || isRecords(v.c) ? `<span class="cw-badge ${recordsMode ? 'is-records' : 'is-legacy'}">${recordsMode ? '◆ 交付明細制' : '◇ 舊制'}</span>` : '';
    const head = v.kind === 'queue' ? '' : `<div class="cw-head"><h3 class="cw-title" id="cw-title">送審與核可</h3>${badge}${v.data ? `<button type="button" class="cw-btn cw-btn-quiet" data-act="reload" ${v.busy ? 'disabled' : ''}>重新讀取</button>` : ''}</div>`;
    v.root.innerHTML = `${head}<p class="cw-msg${v.liveKind === 'error' ? ' is-error' : v.liveKind === 'ok' ? ' is-ok' : ''}" role="status" aria-live="polite" data-cw-live>${esc(v.liveMsg || '')}</p>${bodyHtml(v)}`;
    if (v.refocus) {
      const f = v.refocus; v.refocus = null;
      try { const el = v.root.querySelector(`[data-f="${f}"]`) || v.root.querySelector(`[data-act="${f}"]`); el && el.focus && el.focus(); } catch {}
    } else if (v.focusPanel && v.panel && !(v.preview && v.preview.loading)) {
      v.focusPanel = false;
      try { const el = v.root.querySelector('[data-cw-panel] textarea:not([disabled]), [data-cw-panel] input:not([disabled]), [data-cw-panel] button:not([disabled])'); el && el.focus && el.focus(); } catch {}
    }
  }

  // ── events ────────────────────────────────────────────────────────────────
  function viewFor(root) {
    if (active && active.root === root) return active;
    for (const v of queueViews.values()) if (v.root === root) return v;
    return null;
  }
  function wire(v) {
    const root = v.root;
    root.onclick = e => {
      const view = viewFor(root); if (!view || !isCurrent(view)) return;
      const btn = e && e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (!btn || btn.disabled) return;
      const act = btn.dataset.act;
      if (act === 'reload') return load(view);
      if (act === 'refresh-queue') { if (typeof renderApproval === 'function') renderApproval(); return; }
      if (view.busy) return;
      if (act === 'open-submit') return openPanel(view, 'submit');
      if (act === 'open-withdraw') return openPanel(view, 'withdraw');
      if (act === 'open-review') return openPanel(view, 'review');
      if (act === 'open-adopt') return openPanel(view, 'adopt');
      if (act === 'close-panel') { if (view.kind === 'queue') return closeQueue(view); return closePanel(view); }
      if (act === 'recheck') { view.errors = null; view.msg = ''; return prepareSubmit(view); }
      if (act === 'goto-archive') return gotoArchive(view);
      if (act === 'goto-deliveries') return gotoDeliveries(view);
      if (act === 'reload-page') { try { location.reload(); } catch {} return; }
      if (act === 'submit') return doSubmit(view);
      if (act === 'withdraw') return doWithdraw(view);
      if (act === 'approve' || act === 'reject') return doDecide(view, act);
      if (act === 'adopt') return doAdopt(view);
      if (act === 'reconcile') return send(view, view.pending);
    };
    const onField = e => {
      const view = viewFor(root); if (!view || !view.panel || view.busy) return;
      if (view.pending && view.pending.ambiguous) return;   // 待確認期間內容鎖定
      const el = e && e.target; const f = el && el.dataset ? el.dataset.f : null; if (!f) return;
      view.values = view.values || {};
      view.values[f] = el.type === 'checkbox' ? !!el.checked : el.value;
      if (f === 'zeroOk') { if (view.values.zeroOk && view.sid) view.values.zeroOkFor = view.sid; else delete view.values.zeroOkFor; }
      if (f === 'confirm') { if (view.values.confirm && view.preview && view.preview.versions && !view.preview.stale) view.values.confirmRev = revKey(view.preview.versions); else delete view.values.confirmRev; }
      if (view.errors && view.errors[f]) { delete view.errors[f]; }
      persist(view);
    };
    root.oninput = onField; root.onchange = onField;
  }
  function gotoArchive(v) {
    closePanel(v);
    const input = document.getElementById('d-archive-input');
    if (input) { try { input.setAttribute('aria-invalid', 'true'); input.focus(); input.scrollIntoView && input.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {} }
    else toast('請在案件抽屜填寫檔案歸檔位置', 'err');
  }
  function gotoDeliveries(v) {
    closePanel(v);
    const btn = document.querySelector('#d-deliveries [data-act="new"]');
    if (btn && !btn.disabled) { try { btn.click(); } catch {} return; }
    const sec = document.getElementById('d-deliveries');
    if (sec) { try { sec.scrollIntoView && sec.scrollIntoView({ behavior: 'smooth', block: 'center' }); const t = sec.querySelector('#cd-title'); t && t.focus && t.focus(); } catch {} }
  }

  // ── writes ────────────────────────────────────────────────────────────────
  function fail(v, errors, msg) {
    v.errors = errors; v.msg = msg || '請修正標示的欄位。'; v.msgKind = 'error'; render(v);
    try { const first = v.root.querySelector('[aria-invalid="true"]'); first && first.focus && first.focus(); } catch {}
  }
  function doSubmit(v) {
    if (v.pending && v.pending.ambiguous) return send(v, v.pending);
    const p = v.preview;
    if (!p || !p.listing || !p.versions) return prepareSubmit(v);
    const lifeBlocked = lifecycleBlock(p.listing) || lifecycleBlock(v.data);
    if (lifeBlocked) return fail(v, null, lifeBlocked);
    if (p.stale || !confirmedFor(v, p.versions)) return fail(v, { confirm: '送審前請勾選確認交付已完整登錄。' });
    v.errors = null;
    v.pending = { op: 'submit', path: `/api/cases/${enc(v.caseId)}/delivery-submissions`, body: { id: newId('sub'), completenessConfirmed: true, ...p.versions }, ambiguous: false };
    persist(v);
    return send(v, v.pending);
  }
  function reasonError(text, label) {
    const t = String(text ?? '').trim();
    if (t.length < 2) return `請填寫${label}（至少 2 個字）`;
    if (t.length > 500) return `${label}最多 500 字`;
    return null;
  }
  function doWithdraw(v) {
    if (v.pending && v.pending.ambiguous) return send(v, v.pending);
    const sub = pendingSubmission(v); if (!sub || !v.data) { v.msg = MSG.closed; v.msgKind = 'error'; render(v); return load(v); }
    const err = reasonError(v.values.reason, '撤回原因'); if (err) return fail(v, { reason: err });
    v.pending = { op: `withdraw:${sub.id}`, path: `/api/cases/${enc(v.caseId)}/delivery-submissions/${enc(sub.id)}/withdraw`,
      body: { id: newId('wd'), reason: String(v.values.reason).trim(), ...versionsOf(v.data) }, ambiguous: false };
    v.sid = sub.id; persist(v);
    return send(v, v.pending);
  }
  function doDecide(v, act) {
    if (v.pending && v.pending.ambiguous) return send(v, v.pending);
    const sub = pendingSubmission(v); if (!sub || !v.data) { v.msg = MSG.closed; v.msgKind = 'error'; render(v); return load(v); }
    const comment = String(v.values.comment ?? '').trim();
    const zero = Array.isArray(sub.zeroSupport) ? sub.zeroSupport.length : 0;
    if (act === 'reject') {
      if (comment.length < 2) return fail(v, { comment: '退回時請填寫原因（至少 2 個字），讓設計師知道要修正什麼。' });
    } else {
      if (workflow(v).paused || workflow(v).workflowActive === false) { v.msg = MSG.paused; v.msgKind = 'error'; render(v); return; }
      if (zero && !zeroOkFor(v, sub)) return fail(v, { zeroOk: '此送審含 0 件支援工作，核可前請勾選已審閱並核可其說明。' });
    }
    if (comment.length > 1000) return fail(v, { comment: '評語最多 1000 字' });
    const body = { decision: act, submissionId: sub.id, operationId: newId('op'), ...versionsOf(v.data) };
    if (comment) body.comment = comment;
    if (act === 'approve' && zero) body.zeroSupportApproved = true;
    v.pending = { op: `decide:${sub.id}`, path: `/api/cases/${enc(v.caseId)}/approve`, body, ambiguous: false };
    v.sid = sub.id; persist(v);
    return send(v, v.pending);
  }
  function doAdopt(v) {
    if (v.pending && v.pending.ambiguous) return send(v, v.pending);
    if (!v.data) return load(v);
    const errors = {};
    const err = reasonError(v.values.reason, '導入原因'); if (err) errors.reason = err;
    if (!(v.values.ack === true || v.values.ack === 'true')) errors.ack = '請勾選確認：導入後無法改回舊制。';
    if (Object.keys(errors).length) return fail(v, errors);
    v.pending = { op: 'adopt', path: `/api/cases/${enc(v.caseId)}/delivery-mode/adopt`, body: { requestId: newId('adopt'), reason: String(v.values.reason).trim(), ...versionsOf(v.data) }, ambiguous: false };
    persist(v);
    return send(v, v.pending);
  }
  async function send(v, pending) {
    if (!pending || v.busy || !isCurrent(v)) return;
    const ctx = { v, c: v.c, userId: v.userId, caseId: v.caseId, gen: v.gen, kind: v.kind, op: pending.op, values: { ...(v.values || {}) } };
    v.busy = true; v.msg = '送出中…'; v.msgKind = ''; v.pageReload = false; render(v);
    try {
      const res = await fetchJson('POST', pending.path, pending.body);
      await onSuccess(ctx, pending, res);
    } catch (e) {
      onFailure(ctx, pending, e);
    }
  }
  const SUCCESS_TEXT = { submit: '已送出主管核可', withdraw: '已撤回送審，案件回到設計製作中，可更正後重新送審', approve: '已核可並結案', reject: '已退回修改', adopt: '已改用交付明細制' };
  async function onSuccess(ctx, pending, res) {
    clearDraft(ctx.userId, ctx.caseId, ctx.op);
    const kind = ctx.op.split(':')[0];
    const label = kind === 'decide' ? (pending.body.decision === 'reject' ? 'reject' : 'approve') : kind;
    const extra = label === 'submit' ? { pendingDeliverySubmissionId: res && res.submission ? res.submission.id : null }
      : label === 'adopt' ? { deliveryMode: 'records' } : { pendingDeliverySubmissionId: null };
    if (label === 'approve') Object.assign(extra, { archived: true });
    applyOpCase(ctx.c, res && res.case, extra);
    if (label === 'adopt') for (const t of [ctx.c, twinOf(ctx.c)]) if (t) t.deliveryMode = 'records';   // 單向事實，不受版本合併影響
    const text = SUCCESS_TEXT[label] + (res && res.replayed ? '（已確認，未重複建立）' : '');
    const v = ctx.v;
    if (isCurrent(v)) { v.busy = false; v.pending = null; v.panel = null; v.preview = null; v.values = {}; v.msg = ''; v.liveMsg = text; v.liveKind = 'ok'; render(v); }
    flashes.set(keyOf(ctx.userId, ctx.caseId), { msg: text, kind: 'ok' });
    toast('✓ ' + text);
    await refreshCase(ctx.c);
    if (ctx.kind === 'queue') {
      if (queueViews.get(ctx.caseId) === v) queueViews.delete(ctx.caseId);
      flashes.delete(keyOf(ctx.userId, ctx.caseId));
      try { if (typeof renderApproval === 'function') renderApproval(); } catch {}
      return;
    }
    // 抽屜仍停在同一案、同一登入者：重開抽屜，讓狀態、唯讀與交付成果區一致（進度與歸檔草稿保留）
    const actor = me();
    if (actor && sameId(actor.id, ctx.userId) && ctx.gen === seqNow() && (typeof currentCase === 'undefined' || !currentCase || currentCase.id === ctx.caseId)
        && document.getElementById('d-workflow') && typeof openDrawer === 'function') {
      openDrawer(ctx.c);
    } else {
      flashes.delete(keyOf(ctx.userId, ctx.caseId));
    }
  }
  function failureFor(e) {
    const status = e && e.status, code = e && e.data && e.data.error;
    if (status === 409 && (code === 'edit_conflict' || code === 'case_conflict')) return { msg: MSG.conflict, reload: true, recheck: true };
    if (status === 409 && code === 'client_update_required') return { msg: MSG.clientUpdate, page: true };
    if (status === 409 && code === 'delivery_workflow_paused') return { msg: MSG.paused, reload: true };
    if (status === 409 && code === 'already_submitted') return { msg: MSG.alreadySubmitted, reload: true, close: true };
    if (status === 409 && (code === 'submission_closed' || code === 'submission_not_pending')) return { msg: MSG.closed, reload: true, close: true };
    if (status === 404 && code === 'submission_not_found') return { msg: MSG.closed, reload: true, close: true };
    if (status === 409 && code === 'submission_evidence_changed') return { msg: MSG.evidenceChanged };
    if (status === 409 && code === 'delivery_request_conflict') return { msg: MSG.reused, reload: true };
    if (status === 409 && (code === 'not_records_mode' || code === 'already_records')) return { msg: MSG.notRecords, reload: true, close: true };
    if (status === 409 && code === 'adoption_not_allowed') return { msg: MSG.adoptNotAllowed, reload: true, close: true };
    if (status === 409 && code === 'case_locked') return { msg: '案件已結案、取消或封存，無法送審。', reload: true, close: true };
    if (status === 422 && code === 'completeness_confirmation_required') return { field: 'confirm', msg: '送審前請勾選確認交付已完整登錄。' };
    if (status === 422 && code === 'zero_support_confirmation_required') return { field: 'zeroOk', msg: e.data.message || '核可前請勾選已審閱 0 件支援工作的說明。' };
    if (status === 422 && code === 'reject_reason_required') return { field: 'comment', msg: e.data.message || '退回時請填寫原因。' };
    if (status === 422 && (code === 'archive_path_required' || code === 'deliveries_required')) return { msg: (e.data.message || '送審資料不完整') + '，請依下方提示補齊。', recheck: true };
    if (status === 403) return { msg: code === 'actor_inactive' ? MSG.inactive : code === 'read_only' ? MSG.readOnly : code === 'admin_only' ? MSG.adminOnly : MSG.forbidden };
    if (status === 404 && code === 'feature_disabled') return { msg: MSG.featureOff, reload: true };
    if (status === 400) return { msg: '內容格式不正確，你的輸入已保留。' };
    return { msg: (e && e.data && typeof e.data.message === 'string' ? e.data.message : MSG.generic) };
  }
  function onFailure(ctx, pending, e) {
    if (e && e.authExpired) { const v0 = ctx.v; if (isCurrent(v0)) { v0.busy = false; render(v0); } return; }
    const status = e && e.status;
    const ambiguous = !status || status === 0 || status >= 500 || !!(e && e.timeout);
    // 結果不明：保留「完全相同」的請求；確定被拒（4xx）：伺服器未寫入，清除待送請求、保留輸入
    const draft = readDraft(ctx.userId, ctx.caseId, ctx.op) || { userId: ctx.userId, caseId: ctx.caseId, op: ctx.op, values: ctx.values };
    draft.pending = ambiguous ? { ...pending, ambiguous: true } : null;
    writeDraft(draft);
    const v = ctx.v;
    if (!isCurrent(v)) return;
    v.busy = false; v.pending = draft.pending;
    if (ambiguous) { v.msg = MSG.ambiguous; v.msgKind = 'error'; render(v); return; }
    const f = failureFor(e);
    v.msg = f.msg; v.msgKind = 'error';
    if (f.field) { v.errors = { ...(v.errors || {}), [f.field]: f.msg }; v.refocus = f.field; }
    v.pageReload = !!f.page;
    // 送審摘要已過期：停用送出，必須「重新檢視」最新內容（不拿舊版本重送）
    if (f.recheck && v.panel === 'submit' && v.preview) { v.preview = { ...v.preview, stale: true }; v.values.confirm = false; delete v.values.confirmRev; persist(v); }
    if (f.close && v.kind !== 'queue') { v.panel = null; v.preview = null; v.liveMsg = f.msg; v.liveKind = 'error'; releaseArchiveLock(v); }
    render(v);
    if (f.reload) {
      load(v);
      if (f.close) refreshCase(ctx.c).then(changed => { if (changed && ctx.kind === 'drawer' && isCurrent(v) && typeof openDrawer === 'function') { flashes.set(keyOf(ctx.userId, ctx.caseId), { msg: f.msg, kind: 'error' }); openDrawer(ctx.c); } });
    }
  }

  // ── entry points used by the inline status select, Kanban and approval queue ──
  function panelForStatus(c, newStatus) {
    const a = access(c);
    if (isPendingCase(c)) return a.canDecide && (newStatus === 'closed' || newStatus === 'done') ? 'review' : 'withdraw';
    return 'submit';
  }
  function needsWorkflow(c, newStatus) {
    return isRecords(c) && (isPendingCase(c) || SUBMIT_TARGETS.has(newStatus));
  }
  // 抽屜狀態選單：明細制的送審／結案與待審中的改狀態一律改走送審流程，不呼叫舊 PATCH
  function interceptStatus(c, before, newStatus, sel) {
    if (!needsWorkflow(c, newStatus)) return false;
    if (sel) sel.value = before;
    const v = active;
    const panel = panelForStatus(c, newStatus);
    if (v && v.caseId === c.id && isCurrent(v)) {
      if (v.data) openPanel(v, panel, null, true);
      else v.intentPanel = panel;   // 送審紀錄讀完後再開
    }
    return true;
  }
  // 看板拖曳：在任何樂觀更新之前攔截，打開同一個送審流程
  function interceptKanban(c, newStatus) {
    if (!needsWorkflow(c, newStatus)) return false;
    const a = access(c), panel = panelForStatus(c, newStatus);
    if (panel === 'review' ? !a.canDecide : !a.canSubmit) {
      toast(a.readonly ? '觀察者帳號為唯讀，無法變更狀態' : '只有主責、協作者或管理員可以送審或撤回', 'err');
      return true;
    }
    const actor = me();
    intents.set(keyOf(actor.id, c.id), { panel });
    if (typeof openDrawer === 'function') openDrawer(c);
    return true;
  }
  // 核可清單：舊的 {decision, comment} 不能核可明細制案件，改開同一份送審依據審核
  function noteQueueRows(rows) {
    queueModes.clear();
    for (const r of rows || []) if (r && r.id) queueModes.set(r.id, r.deliveryMode === 'records' ? 'records' : 'legacy');
  }
  function isRecordsId(id) {
    if (queueModes.get(id) === 'records') return true;
    return isRecords(casesList().find(x => x && x.id === id));
  }
  function openQueueReview(id, container) {
    const actor = me(); if (!actor) return;
    const host = container || document.querySelector(`[data-c2-queue="${String(id).replace(/"/g, '')}"]`);
    if (!host) return;
    // 審核內容掛在整張卡片底部（全寬），不要擠在右側按鈕欄
    const card = (host.closest && host.closest('.card')) || host;
    let root = card.querySelector('.cw-queue-panel');
    if (!root) { root = document.createElement('div'); root.className = 'cw-root cw-queue-panel'; card.appendChild(root); }
    const prior = queueViews.get(id);
    if (prior && prior.root === root && isCurrent(prior)) { try { const el = root.querySelector('textarea, input, button'); el && el.focus && el.focus(); } catch {} return; }
    const c = casesList().find(x => x && x.id === id) || { id, deliveryMode: 'records', status: 'review_done' };
    const v = newView('queue', c, root, null);
    v.panel = 'review'; v.host = host;
    queueViews.set(id, v);
    root.hidden = false;
    const trigger = host.querySelector('[data-c2-review]'); if (trigger) trigger.setAttribute('aria-expanded', 'true');
    wire(v); render(v);
    load(v).then(() => {
      if (!isCurrent(v)) return;
      const sub = pendingSubmission(v);
      if (sub) {
        v.sid = sub.id;
        const draft = readDraft(v.userId, v.caseId, `decide:${sub.id}`);
        if (draft) { v.values = { ...draft.values }; v.pending = draft.pending || null; if (v.pending && v.pending.ambiguous) { v.msg = MSG.ambiguous; v.msgKind = 'error'; } }
      }
      v.focusPanel = true; render(v);
    });
  }
  function closeQueue(v) {
    persist(v);
    queueViews.delete(v.caseId);
    const host = v.host;
    v.root.remove();
    const trigger = host && host.querySelector ? host.querySelector('[data-c2-review]') : null;
    if (trigger) { trigger.setAttribute('aria-expanded', 'false'); try { trigger.focus(); } catch {} }
  }
  function handleLegacyDecision(id) {
    if (!isRecordsId(id)) return false;
    openQueueReview(id);
    return true;
  }
  document.addEventListener('click', e => {
    const t = e && e.target, btn = t && t.closest ? t.closest('[data-c2-review]') : null;
    if (!btn || btn.disabled) return;
    openQueueReview(btn.dataset.c2Review, btn.closest('[data-c2-queue]'));
  });

  // ── openDrawer hook (outermost, after B) ──────────────────────────────────
  const original = window.openDrawer;
  if (typeof original === 'function') {
    window.openDrawer = function (c) {
      // 先同步清空上一案的送審區，避免切案期間顯示或操作 A 案內容
      if (active) releaseArchiveLock(active);
      active = null;
      const stale = document.getElementById('d-workflow');
      if (stale) { stale.innerHTML = ''; stale.hidden = true; }
      const result = original.apply(this, arguments);
      const gen = seqNow();
      Promise.resolve(result).then(() => onOpened(c, gen), () => {});
      return result;
    };
  }
  window.caseWorkflowUi = { onOpened, interceptStatus, interceptKanban, noteQueueRows, isRecordsId, openQueueReview, handleLegacyDecision, access, readDraft,
    _active: () => active, _queue: id => queueViews.get(id), _reset: () => { active = null; queueViews.clear(); intents.clear(); flashes.clear(); queueModes.clear(); memoryDrafts.clear(); } };
})();
