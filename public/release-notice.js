/* REPORTS-P2-D2 成員更新通知：每個帳號每則公告版本只在登入後出現一次。
 * - 已讀以伺服器帳號紀錄為準（POST /api/notices/:id/dismiss，身分取自登入 session）；不靠 localStorage。
 * - 「知道了」、右上角 ×、Esc、點背景都走同一個關閉流程並寫入伺服器；寫入失敗會明說「尚未儲存」並提供重試。
 * - 公告內容只來自伺服器白名單（一般成員可用的已發布功能），本模組不另存或拼接任何內容。
 * - 延遲回應若已換帳號就丟棄；可從頂端「更新紀錄」重新閱讀，不會重置已讀。
 */
(() => {
  if (window.__releaseNoticeInstalled) return;
  window.__releaseNoticeInstalled = true;
  const esc = v => (typeof escapeHtml === 'function' ? escapeHtml(v) : String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));
  const me = () => (typeof ME !== 'undefined' && ME && ME.id != null && ME.id !== 0 ? ME : null);
  let state = { userId: null, notices: [], open: null };

  async function load() {
    const a = me(); if (!a) return null;
    let data;
    try { data = await fetchJson('GET', '/api/notices'); } catch { return null; }
    const now = me(); if (!now || String(now.id) !== String(a.id)) return null;   // account changed meanwhile
    if (!data || String(data.staffId) !== String(a.id)) return null;                 // response belongs to another session
    state.userId = a.id; state.notices = Array.isArray(data && data.notices) ? data.notices : [];
    ensureEntry();
    return data;
  }
  function ensureEntry() {
    const bar = document.querySelector('.topbar'); if (!bar) return;
    let btn = document.getElementById('rn-entry');
    if (!state.notices.length) { if (btn) btn.remove(); return; }
    if (!btn) {
      btn = document.createElement('button'); btn.id = 'rn-entry'; btn.type = 'button'; btn.className = 'rn-entry'; btn.textContent = '更新紀錄';
      btn.setAttribute('aria-haspopup', 'dialog');
      const anchor = document.getElementById('create-btn'); bar.insertBefore(btn, anchor || null);
      btn.onclick = () => openNotice(state.notices[0], { reread: true, trigger: btn });
    }
  }
  function openNotice(n, { reread = false, trigger } = {}) {
    if (!n) return;
    closeDom();
    const back = trigger || document.activeElement;
    const bg = document.createElement('div'); bg.className = 'rn-bg'; bg.id = 'rn-bg';
    const dlg = document.createElement('div'); dlg.className = 'rn-dialog'; dlg.id = 'rn-dialog';
    dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-labelledby', 'rn-title');
    const others = reread && state.notices.length > 1 ? `<details class="rn-older"><summary>較早的更新</summary>${state.notices.slice(1).map(x => `<h3>${esc(x.title)}</h3><ul>${x.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`).join('')}</details>` : '';
    dlg.innerHTML = `<div class="rn-head"><h2 id="rn-title">${esc(n.title)}</h2><button type="button" class="rn-x" data-rn="close" aria-label="關閉更新通知">×</button></div>
      <ul class="rn-list">${n.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>${others}
      <p class="rn-msg" role="status" aria-live="polite"></p>
      <div class="rn-actions"><button type="button" class="rn-btn rn-primary" data-rn="close">知道了</button></div>`;
    document.body.appendChild(bg); document.body.appendChild(dlg);
    state.open = { id: n.id, userId: state.userId, reread, back, dismissedOk: reread || n.dismissed };
    const close = () => requestClose();
    bg.onclick = close;
    dlg.onclick = e => { const t = e && e.target && e.target.closest ? e.target.closest('[data-rn]') : null; if (!t) return; if (t.dataset.rn === 'close') close(); if (t.dataset.rn === 'retry') persist(); if (t.dataset.rn === 'later') closeDom(true); };
    dlg.onkeydown = e => {
      if (e.key === 'Escape') { e.preventDefault && e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;
      const f = [...dlg.querySelectorAll('button, summary')].filter(x => !x.disabled);
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault && e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault && e.preventDefault(); f[0].focus(); }
    };
    try { dlg.querySelector('.rn-primary').focus(); } catch {}
  }
  // Every close path: persist (unless this is a reread of an already dismissed notice), then close.
  async function requestClose() {
    if (!state.open) return;
    if (state.open.dismissedOk) { closeDom(true); return; }
    await persist();
  }
  async function persist() {
    const o = state.open; if (!o) return;
    // Never let a dialog opened for one account write for another: preflight here, precondition on the server.
    const actor = me(); if (!actor || String(actor.id) !== String(o.userId)) { closeDom(false); return; }
    const msg = document.querySelector('#rn-dialog .rn-msg'); if (msg) msg.textContent = '儲存中…';
    try {
      await fetchJson('POST', `/api/notices/${encodeURIComponent(o.id)}/dismiss`, { expectedStaffId: o.userId });
      const now = me(); if (!now || String(now.id) !== String(o.userId) || state.open !== o) return;   // stale
      const n = state.notices.find(x => x.id === o.id); if (n) n.dismissed = true;
      o.dismissedOk = true; closeDom(true);
      showNext();
    } catch {
      if (state.open !== o) return;
      if (msg) msg.textContent = '關閉狀態尚未儲存到伺服器（換裝置可能再出現）。';
      const acts = document.querySelector('#rn-dialog .rn-actions');
      if (acts && !acts.querySelector('[data-rn="retry"]')) {
        for (const [act, label] of [['later', '先關閉'], ['retry', '重試儲存']]) {
          const b = document.createElement('button'); b.type = 'button'; b.className = 'rn-btn'; b.setAttribute('data-rn', act); b.textContent = label;
          acts.insertBefore(b, acts.firstChild || null);
        }
      }
    }
  }
  function closeDom(restore) {
    const o = state.open;
    document.getElementById('rn-dialog')?.remove(); document.getElementById('rn-bg')?.remove();
    state.open = null;
    if (restore && o && o.back && o.back.focus) { try { o.back.focus(); } catch {} }
  }
  function showNext() { const next = state.notices.find(n => !n.dismissed); if (next) openNotice(next); }
  // After sign-in: wait for the account, then show the first undismissed notice once.
  async function start(tries = 0) {
    if (!me()) { if (tries < 40) setTimeout(() => start(tries + 1), 500); return; }
    const data = await load(); if (!data) return;
    showNext();
  }
  if (typeof document !== 'undefined' && document.readyState !== 'loading') setTimeout(() => start(), 0);
  else document.addEventListener && document.addEventListener('DOMContentLoaded', () => start());
  window.releaseNotices = { load, start, openNotice, requestClose, _state: () => state, _reset: () => { closeDom(false); state = { userId: null, notices: [], open: null }; } };
})();
