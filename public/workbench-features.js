/* Shared full-case explorer and period work ledger. Uses existing authenticated APIs. */
(() => {
  const esc = escapeHtml;
  let recoveryGen = 0; // v10: profile modal 開啟世代
  if (typeof window.closeProfileEdit === 'function' && !window.closeProfileEdit.__v10) { const o = window.closeProfileEdit; const w = function () { recoveryGen++; return o.apply(this, arguments); }; w.__v10 = true; window.closeProfileEdit = w; }
  const statuses = {todo:'尚未開始',wait:'等待資料／協調中',doing:'設計製作中',review:'待需求單位確認',review_done:'待主管核可',print:'製作／送印中',done:'已結案',closed:'已結案',cancelled:'已取消'};
  const date = value => value ? String(value).slice(0,10) : '—';
  const options = (values, selected) => values.map(([v,label]) => `<option value="${esc(String(v))}" ${String(v)===String(selected)?'selected':''}>${esc(label)}</option>`).join('');
  const blank = [['','全部']];
  const periodLabels = {week:'本週',month:'本月',quarter:'本季',half:'半年',year:'全年'};
  let explorerState = {}, explorerRows = [], explorerSeq = 0, analyticsSeq = 0, analyticsStaff = '';
  const ledgerState = {};

  // v30 規模：完整篩選＋穩定排序後才分頁，每頁 50 件；只產生當頁列。
  // 各 ledger 的頁碼存在自己的 state（總表 explorerState／期間 ledgerState 各自獨立）。
  const WB_PAGE_SIZE = 50, WB_SEARCH_DEBOUNCE = 180, WB_NO_HOTEL = '__none__';
  const wbLedgerTimers = new Set();
  function wbClearLedgerTimers() { wbLedgerTimers.forEach(t => clearTimeout(t)); wbLedgerTimers.clear(); }
  function wbPagerHtml(page, pages) {
    if (pages <= 1) return '';
    const btn = (nav, target, label, text, disabled) => `<button type="button" class="wb-button wb-page-btn" data-page="${target}" data-page-nav="${nav}" aria-label="${label}" ${disabled ? 'disabled' : ''}>${text}</button>`;
    return btn('first', 1, '第一頁', '«', page <= 1) + btn('prev', page - 1, '上一頁', '‹ 上一頁', page <= 1)
      + `<span class="wb-page-now" aria-current="page" tabindex="-1">第 ${page} / ${pages} 頁</span>`
      + btn('next', page + 1, '下一頁', '下一頁 ›', page >= pages) + btn('last', pages, '最後一頁', '»', page >= pages);
  }

  function ledger(root, rows, state, prefix, opts) {
    opts = opts || {};
    // 重新渲染（含清除）前，先作廢此 root 上一輪尚未觸發的搜尋計時器
    if (root.__wbTimer) { clearTimeout(root.__wbTimer); wbLedgerTimers.delete(root.__wbTimer); root.__wbTimer = null; }
    const hotels = [...new Set(rows.map(c=>c.hotel).filter(Boolean))].sort(window.hotelOrderCompare || ((a,b)=>a.localeCompare(b,'zh-TW'))); // v9.9: 與全站共用管理者館別順序
    const people = new Map();
    rows.forEach(c => [c.designer,...(c.collaborators||[])].filter(Boolean).forEach(s=>people.set(String(s.id),s.name)));
    // Keep a zero-result selection visible, so users can clear it.
    if (state.staff && !people.has(String(state.staff))) people.set(String(state.staff), STAFF.find(s=>String(s.id)===String(state.staff))?.name || '已選人員');
    if (state.hotel && state.hotel !== WB_NO_HOTEL && !hotels.includes(state.hotel)) hotels.push(state.hotel);
    // v40: 未指定館別可被選取（圖表下鑽用），只有資料中真的有缺館別或已選取時才出現
    const hotelOpts = hotels.map(h=>[h,h]);
    if (state.hotel === WB_NO_HOTEL || rows.some(c=>!c.hotel)) hotelOpts.push([WB_NO_HOTEL,'未指定館別']);
    const phases = Array.isArray(opts.phases) ? opts.phases : null;
    const fields = [['dispatchDate','派發日'],['goLiveDate','上線日'],['openDate','開單日'],['closedOn','結案日']];
    state.sort ||= 'dispatchDate'; state.direction ||= 'asc';
    root.innerHTML = `<div class="wb-filters">
      <label>搜尋<input data-filter="q" type="search" placeholder="案號、案件名稱、需求單位" value="${esc(state.q||'')}"></label>
      <label>館別<select data-filter="hotel">${options([...blank,...hotelOpts],state.hotel||'')}</select></label>
      <label>人員（含主責與協作）<select data-filter="staff">${options([...blank,...[...people].sort((a,b)=>a[1].localeCompare(b[1],'zh-TW'))],state.staff||'')}</select></label>
      ${phases?`<label>人員角色<select data-filter="role">${options([['','主責或協作'],['primary','僅主責'],['collab','僅協作']],state.role||'')}</select></label>`:''}
      <label>狀態<select data-filter="status">${options([...blank,['active','在辦案件'],['finished','已結案'],...Object.entries(statuses).filter(([k])=>k!=='done'&&k!=='closed')],state.status||'')}</select></label>
      ${phases?`<label>期間狀態<select data-filter="phase">${options([...blank,...phases],state.phase||'')}</select></label>`:''}
      <label>日期與排序依據<select data-filter="sort">${options(fields,state.sort)}</select></label>
      <label>日期起<input data-filter="from" type="date" value="${esc(state.from||'')}"></label>
      <label>日期迄<input data-filter="to" type="date" value="${esc(state.to||'')}"></label>
      <label>順序<select data-filter="direction">${options([['asc','舊 → 新'],['desc','新 → 舊']],state.direction)}</select></label>
      <button class="wb-button" data-clear>清除篩選</button>
    </div><p class="wb-help" data-count aria-live="polite" tabindex="-1"></p><nav class="wb-pager" data-pager data-pager-pos="top" aria-label="案件分頁（上）"></nav><div data-results></div><nav class="wb-pager" data-pager data-pager-pos="bottom" aria-label="案件分頁（下）"></nav>`;
    const ctx = {};
    root.__wbCtx = ctx;
    const live = () => root.__wbCtx === ctx && root.isConnected !== false;
    const haystack = rows.map(c => [c.id,c.title,c.requester].join(' ').toLowerCase());
    let memoKey = null, memoRows = [];
    const filtered = () => {
      const key = JSON.stringify([state.q||'',state.hotel||'',state.staff||'',state.status||'',state.sort,state.direction,state.from||'',state.to||'',state.role||'',state.phase||'']);
      if (key === memoKey) return memoRows;   // 只換頁時不重新篩選／排序
      const q = (state.q||'').toLowerCase();
      const picked = [];
      rows.forEach((c, i) => {
        if (q && !haystack[i].includes(q)) return;
        if (state.hotel && (state.hotel === WB_NO_HOTEL ? !!c.hotel : c.hotel !== state.hotel)) return;
        if (state.staff) {
          const sid = String(state.staff), primary = !!c.designer && String(c.designer.id) === sid, collab = (c.collaborators||[]).some(s=>s && String(s.id)===sid);
          if (state.role === 'primary' ? !primary : state.role === 'collab' ? !collab : !(primary || collab)) return;
        }
        if (state.phase && c._phase !== state.phase) return;
        // REPORTS-P2-D2: an incomplete seal keeps a working status but is not active work.
        if (state.status==='active' && (['done','closed','cancelled'].includes(c.status) || c.lifecycleStatus==='sealed_incomplete')) return;
        if (state.status==='finished' && !['done','closed'].includes(c.status)) return;
        if (state.status && !['active','finished'].includes(state.status) && state.status!==c.status) return;
        const d = c[state.sort] ? date(c[state.sort]) : '';
        if ((state.from && (!d || d < state.from)) || (state.to && (!d || d > state.to))) return;
        picked.push(c);
      });
      picked.sort((a,b)=>{
        const x=a[state.sort],y=b[state.sort];
        if (!x && y) return 1; if (x && !y) return -1;      // 缺日期一律排最後（不受順序影響）
        const n = String(x||'').localeCompare(String(y||''));
        return (state.direction==='desc'?-n:n) || String(a.id).localeCompare(String(b.id)); // 同日以案號穩定排序
      });
      memoKey = key; memoRows = picked;
      return picked;
    };
    const rowHtml = c => `<div class="wb-case-row">
        <div><button class="wb-case-link" data-case="${esc(c.id)}">${esc(c.title||c.id)}</button><div class="wb-help">${esc(c.id)} · ${esc(c.hotel||'未指定館別')} · ${esc(c.level||'—')}<br>${esc(c.requester||'未填需求單位')}</div></div>
        <div><span class="wb-mobile-label">主責 </span>${esc(c.designer?.name||'未指派')}<div class="wb-help">${(c.collaborators||[]).length?'協作 '+c.collaborators.map(s=>esc(s.name)).join('、'):'無協作者'}</div></div>
        <div><span class="wb-status" data-status="${esc(c.status)}">${esc(statuses[c.status]||c.status)}</span>${c.lifecycleStatus==='sealed_incomplete'?'<small class="wb-help"> 未完成封存</small>':c.archived?'<small class="wb-help"> 已封存</small>':''}</div>
        <div><span class="wb-mobile-label">派發 </span>${date(c.dispatchDate)}</div><div><span class="wb-mobile-label">上線 </span>${date(c.goLiveDate)}</div>
        <div><span class="wb-mobile-label">結束 </span>${date(c.cancelledOn||c.closedOn)}${c.endDateMissing?'<div class="wb-help">結束日待補，暫保留於明細</div>':''}</div>
      </div>`;
    const display = () => {
      if (!live()) return;
      const invalidDates = state.from && state.to && state.from > state.to;
      const selected = invalidDates ? [] : filtered();
      const pages = Math.max(1, Math.ceil(selected.length / WB_PAGE_SIZE));
      const page = Math.min(Math.max(1, Math.floor(Number(state.page)) || 1), pages);   // 篩選或資料變動後 clamp
      state.page = page;
      const start = (page - 1) * WB_PAGE_SIZE, slice = selected.slice(start, start + WB_PAGE_SIZE);
      const range = selected.length > WB_PAGE_SIZE ? ` · 本頁第 ${start + 1}–${start + slice.length} 件（共 ${selected.length} 件）` : '';
      root.querySelector('[data-count]').textContent = invalidDates ? '開始日期不能晚於結束日期。請調整日期。' : `顯示 ${selected.length} / ${rows.length} 件${range} · 含主責、協作、已結案與取消的案件；無日期者排在最後`;
      root.querySelector('[data-results]').innerHTML = slice.length ? `<div class="wb-case-table"><div class="wb-case-head"><span>案件／館別</span><span>主責／協作</span><span>狀態</span><span>派發日</span><span>上線日</span><span>結案／取消日</span></div>${slice.map(rowHtml).join('')}</div>` : '<div class="wb-empty">沒有符合條件的案件。可清除篩選或調整日期範圍。</div>';
      const pager = wbPagerHtml(page, pages);
      root.querySelectorAll('[data-pager]').forEach(n => { n.innerHTML = pager; n.hidden = !pager; });
      if (typeof opts.onDisplay === 'function') try { opts.onDisplay(state, selected.length); } catch {}
    };
    const goPage = (target, nav, fromBottom) => {
      state.page = target; display();
      const pos = fromBottom ? 'bottom' : 'top';
      const again = root.querySelector(`[data-pager-pos="${pos}"] [data-page-nav="${nav}"]`);
      const focusTo = again && !again.disabled ? again : root.querySelector(`[data-pager-pos="${pos}"] .wb-page-now`);
      try { focusTo?.focus?.(); } catch {}
      if (fromBottom) try { root.querySelector('[data-count]')?.scrollIntoView?.({block:'nearest'}); } catch {}
    };
    // 篩選欄位只有 8 個，各自綁定；搜尋 debounce 且等中文輸入法組字完成
    root.querySelectorAll('[data-filter]').forEach(input=>{
      const key = input.dataset.filter;
      if (key === 'q') {
        let composing = false;
        const schedule = () => {
          state.q = input.value;   // 先記住輸入值，重繪時不會倒退；畫面更新延後
          if (root.__wbTimer) { clearTimeout(root.__wbTimer); wbLedgerTimers.delete(root.__wbTimer); }
          const t = setTimeout(() => {
            wbLedgerTimers.delete(t);
            if (root.__wbTimer !== t) return;
            root.__wbTimer = null;
            state.page = 1; display();
          }, WB_SEARCH_DEBOUNCE);
          root.__wbTimer = t; wbLedgerTimers.add(t);
        };
        input.addEventListener('compositionstart', () => { composing = true; });
        input.addEventListener('compositionend', () => { composing = false; schedule(); });
        input.addEventListener('input', e => { if (composing || e?.isComposing) return; schedule(); });
      } else {
        input.addEventListener('change', () => { state[key] = input.value; state.page = 1; display(); });
      }
    });
    // root 事件委派：開案、清除、分頁（不逐列綁 click）
    root.onclick = e => {
      const t = e && e.target; if (!t || !t.closest || !live()) return;
      const open = t.closest('[data-case]');
      if (open) { openDrawerById(open.dataset.case, { fresh: true }); return; }   // v30: 走中央開案入口，總表一律 fresh GET
      const pg = t.closest('[data-page]');
      if (pg) { if (pg.disabled) return; goPage(Number(pg.dataset.page), pg.dataset.pageNav, !!t.closest('[data-pager-pos="bottom"]')); return; }
      if (t.closest('[data-clear]')) {
        Object.keys(state).forEach(k=>delete state[k]); ledger(root,rows,state,prefix,opts);
        try { root.querySelector('[data-filter="q"]')?.focus?.(); } catch {}
      }
    };
    root.onkeydown = e => {
      const t = e && e.target; if (!t || !t.closest || !t.closest('[data-pager]') || !live()) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const pages = Math.max(1, Math.ceil(filtered().length / WB_PAGE_SIZE)), page = Number(state.page) || 1;
      const target = e.key === 'ArrowLeft' ? page - 1 : page + 1;
      if (target < 1 || target > pages) return;
      e.preventDefault?.(); goPage(target, e.key === 'ArrowLeft' ? 'prev' : 'next', !!t.closest('[data-pager-pos="bottom"]'));
    };
    display();
  }

  // ═══ v40 分析圖表（原生 HTML/CSS；數字皆可點，與明細共用篩選） ═══
  const WB_PHASES=[['done','本期結案'],['active','期間在辦'],['sealed','未完成封存'],['cancelled','本期取消'],['later','期後才結束'],['missing','結束日待補']];
  const wbTime=v=>{const t=v?new Date(v).getTime():NaN;return Number.isFinite(t)?t:null;};
  // 期間明細的列：後端 workCases（跨期工作）＋完成 cohort 中不在 workCases 的案件（例如缺派發日），
  // 並標上 _phase。只有 cohort 內的案件算「本期結案」，所以圖表數字＝明細篩選後件數。
  function wbPeriodRows(data,completed){
    const start=wbTime(data.period&&data.period.start), end=wbTime(data.period&&data.period.end);
    const cohort=new Map(completed.map(c=>[String(c.id),c]));
    const phaseOf=c=>{
      if(cohort.has(String(c.id)))return 'done';
      if(c.lifecycleStatus==='sealed_incomplete')return 'sealed'; // REPORTS-P2-D2：未完成封存不是在辦也不是結案
      if(!['done','closed','cancelled'].includes(c.status))return 'active';
      const t=wbTime(c.status==='cancelled'?c.cancelledOn:c.closedOn);
      if(t==null)return 'missing';
      if(end!=null&&t>=end)return 'later';
      if(c.status==='cancelled')return (start==null||t>=start)?'cancelled':'later';
      return 'later'; // 期間內結案卻不在權威完成 cohort（理論上不會發生）：不計入「本期結案」，避免圖表與部門完成數不一致
    };
    const rows=(data.workCases||[]).map(c=>({...c,_phase:phaseOf(c)}));
    const seen=new Set(rows.map(c=>String(c.id)));
    completed.forEach(c=>{ if(seen.has(String(c.id)))return;
      const ids=Array.isArray(c.collaboratorIds)?c.collaboratorIds:[];
      rows.push({id:c.id,title:c.title,hotel:c.hotel||null,requester:c.requester||'',status:c.status||'closed',level:c.level,
        designer:c.designerId!=null?{id:c.designerId,name:c.designerName||STAFF.find(s=>String(s.id)===String(c.designerId))?.name||''}:null,
        collaborators:ids.map((id,i)=>({id,name:STAFF.find(s=>String(s.id)===String(id))?.name||(c.collaboratorNames||[])[i]||''})),
        dispatchDate:c.dispatchDate||null,openDate:c.openDate||null,goLiveDate:c.goLiveDate||null,closedOn:c.closedOn,cancelledOn:null,archived:true,_phase:'done'}); });
    return rows;
  }
  const wbDrillAttrs=o=>Object.entries(o).filter(([,v])=>v!=null&&v!=='').map(([k,v])=>` data-drill-${k}="${esc(String(v))}"`).join('');
  const wbBtn=(o,text,label,cls='wb-drill-num')=>`<button type="button" class="${cls}" data-drill${wbDrillAttrs(o)} aria-pressed="false" aria-label="${esc(label)}">${text}</button>`;
  function wbChartsHtml(rows,completed,sid){
    // 人員完成參與：主責／協作件數（同一案可計入多人），部門唯一案件另計
    const people=new Map();
    const bump=(p,k)=>{if(!p||p.id==null)return;const id=String(p.id);if(sid&&id!==sid)return;const x=people.get(id)||{id,name:STAFF.find(s=>String(s.id)===id)?.name||p.name||'（未知人員）',primary:0,collab:0};x[k]++;people.set(id,x);};
    rows.filter(c=>c._phase==='done').forEach(c=>{bump(c.designer,'primary');(c.collaborators||[]).forEach(p=>{if(!c.designer||String(p.id)!==String(c.designer.id))bump(p,'collab');});});
    const plist=[...people.values()].sort((a,b)=>(b.primary+b.collab)-(a.primary+a.collab)||a.name.localeCompare(b.name,'zh-TW'));
    const pmax=Math.max(1,...plist.map(p=>p.primary+p.collab));
    const pct=(v,m)=>Math.round(v/m*1000)/10;
    const legendP=`<div class="wb-legend" aria-hidden="true"><span><i class="wb-key wb-seg-primary"></i>主責</span><span><i class="wb-key wb-seg-collab"></i>協作（斜線）</span></div>`;
    const peopleHtml=plist.length?`<ul class="wb-bars">${plist.map(p=>`<li class="wb-bar-row">
        ${wbBtn({staff:p.id,phase:'done'},`<span class="wb-bar-name">${esc(p.name)}</span>`,`${p.name} 本期結案參與 ${p.primary+p.collab} 件，查看明細`,'wb-drill-name')}
        <span class="wb-bar-track" aria-hidden="true"><span class="wb-seg wb-seg-primary" style="width:${pct(p.primary,pmax)}%"></span><span class="wb-seg wb-seg-collab" style="width:${pct(p.collab,pmax)}%"></span></span>
        <span class="wb-bar-nums">${p.primary?wbBtn({staff:p.id,role:'primary',phase:'done'},`主責 ${p.primary}`,`${p.name} 主責完成 ${p.primary} 件`):'<span class="wb-zero">主責 0</span>'}${p.collab?wbBtn({staff:p.id,role:'collab',phase:'done'},`協作 ${p.collab}`,`${p.name} 協作完成 ${p.collab} 件`):'<span class="wb-zero">協作 0</span>'}</span>
      </li>`).join('')}</ul>`:'<p class="wb-help">本期間沒有已結案的參與紀錄。</p>';
    // 館別期間工作狀態：依管理者館別順序；未指定館別排最後
    const groups=new Map();
    rows.forEach(c=>{const h=c.hotel||WB_NO_HOTEL;const g=groups.get(h)||{h,total:0,by:{}};g.total++;g.by[c._phase]=(g.by[c._phase]||0)+1;groups.set(h,g);});
    const cmp=window.hotelOrderCompare||((a,b)=>a.localeCompare(b,'zh-TW'));
    const hlist=[...groups.values()].sort((a,b)=>a.h===WB_NO_HOTEL?1:b.h===WB_NO_HOTEL?-1:cmp(a.h,b.h));
    const hmax=Math.max(1,...hlist.map(g=>g.total));
    const hname=h=>h===WB_NO_HOTEL?'未指定館別':h;
    const legendH=`<div class="wb-legend" aria-hidden="true">${WB_PHASES.map(([k,l])=>`<span><i class="wb-key wb-ph-${k}"></i>${l}</span>`).join('')}</div>`;
    const hotelHtml=hlist.length?`<ul class="wb-bars">${hlist.map(g=>`<li class="wb-bar-row">
        ${wbBtn({hotel:g.h},`<span class="wb-bar-name">${esc(hname(g.h))}</span>`,`${hname(g.h)} 期間工作 ${g.total} 件，查看明細`,'wb-drill-name')}
        <span class="wb-bar-track" aria-hidden="true">${WB_PHASES.filter(([k])=>g.by[k]).map(([k])=>`<span class="wb-seg wb-ph-${k}" style="width:${pct(g.by[k],hmax)}%"></span>`).join('')}</span>
        <span class="wb-bar-nums">${WB_PHASES.filter(([k])=>g.by[k]).map(([k,l])=>wbBtn({hotel:g.h,phase:k},`${l} ${g.by[k]}`,`${hname(g.h)} ${l} ${g.by[k]} 件`)).join('')}</span>
      </li>`).join('')}</ul>`:'<p class="wb-help">本期間沒有工作案件。</p>';
    const uniq=completed.length;
    return `<figure class="wb-chart" data-chart="people"><figcaption><strong>人員完成參與</strong><span class="wb-help">本期結案 · 主責＋協作為參與件數（同一案可計入多人）；${sid?'此人參與完成':'部門完成依案件去重'}共 ${uniq} 件</span></figcaption>${legendP}${peopleHtml}</figure>
      <figure class="wb-chart" data-chart="hotels"><figcaption><strong>館別期間工作狀態</strong><span class="wb-help">期間明細 ${rows.length} 件依館別分組；依管理設定的館別順序</span></figcaption>${legendH}${hotelHtml}</figure>`;
  }
  function wbSyncChartPressed(node,state){
    if(!node||!node.querySelectorAll)return;
    const extra=['q','status','from','to'].some(k=>state[k]);
    node.querySelectorAll('[data-drill]').forEach(b=>{const d=b.dataset;
      const on=!extra&&['staff','role','hotel','phase'].every(k=>String(state[k]||'')===String(d['drill'+k[0].toUpperCase()+k.slice(1)]||''));
      b.setAttribute('aria-pressed',on?'true':'false');});
  }

  // v30: 與 index.html 的集中失效共用 epoch；不存在時（隔離測試）視為固定 0
  const wbEpoch = () => (typeof v30CaseEpoch === 'number' ? v30CaseEpoch : 0);
  function ensureExplorer() {
    let view=document.querySelector('div.view[data-view="cases-all"]');
    if (!view) { view=document.createElement('div');view.className='view';view.dataset.view='cases-all';document.querySelector('.main').appendChild(view); }
    return view;
  }
  async function renderExplorer() {
    const view=ensureExplorer(), seq=++explorerSeq;
    wbClearLedgerTimers(); // 頁面替換：舊搜尋計時器一律作廢
    view.innerHTML='<div class="wb-heading"><div><h1>案件總表</h1><p class="wb-help">依館別或人員查找所有案件，直接開啟查看或更新。</p></div><button class="wb-button" data-reload>重新整理</button></div><section class="wb-surface" data-ledger>載入案件中…</section>';
    view.querySelector('[data-reload]').onclick=renderExplorer;
    // v20 F11: 成功與失敗都綁「本次序號 + 本次建立的 DOM 節點」，舊回應（含舊失敗）不得覆蓋新畫面
    const node=view.querySelector('[data-ledger]');
    const epoch=wbEpoch(); // v30: 案件快取失效 epoch；舊 epoch 的回覆（含失敗）不得回填
    const current=()=>seq===explorerSeq&&node.isConnected&&epoch===wbEpoch();
    try { const rows=await api.cases.listArchived(); if(!current())return; explorerRows=rows; ledger(node,rows,explorerState,'all'); }
    catch(e) { if(!current())return; node.textContent='載入失敗，請按「重新整理」再試。'; }
  }
  // v30: 登記總表快照清除（保留篩選 explorerState/ledgerState）與可見時的單次重載
  if (typeof v30CaseCacheListeners !== 'undefined' && Array.isArray(v30CaseCacheListeners)) v30CaseCacheListeners.push(() => { explorerRows = null; });
  if (typeof v30ViewReloaders !== 'undefined' && v30ViewReloaders) { v30ViewReloaders['cases-all'] = () => renderExplorer(); v30ViewReloaders.analytics = () => window.renderAnalytics(); }
  window.wbOpenCases = function(filters={}) { explorerState={...filters};switchView('cases-all'); };
  for(const role of ['admin','designer']) if(!NAV_DEF[role].some(n=>n.key==='cases-all')) NAV_DEF[role].push({key:'cases-all',label:'案件總表'});
  const originalSwitch=window.switchView;
  window.switchView=function(v){
    wbClearLedgerTimers(); // 導航：清除任何 ledger 未觸發的搜尋計時器
    try { window.v95DrawerSeq?.bump(); } catch {} // v30: 導航使等待中的開案失效（成功與失敗回覆都會被丟棄）
    if(v==='cases-all'){
      ensureExplorer();currentView=v;document.querySelectorAll('.view').forEach(x=>x.classList.toggle('active',x.dataset.view===v));renderNav();renderExplorer();
      document.querySelector('.app')?.classList.remove('rail-open');document.getElementById('rail-toggle')?.setAttribute('aria-expanded','false');
      return;
    }
    return originalSwitch.apply(this,arguments);
  };

  window.renderAnalytics=async function(){
    v33EnsureAnalyticsView();
    const view=document.querySelector('div.view[data-view="analytics"]'), seq=++analyticsSeq;
    wbClearLedgerTimers();
    view.innerHTML=`<div class="wb-heading"><div><h1>部門產出／貢獻分析</h1><p class="wb-help">完成貢獻看交付成果；工作明細看期間內所有案件，包含跨期案件。</p></div></div>
      <div class="wb-analytics-tools"><div class="wb-periods">${Object.entries(periodLabels).map(([p,label])=>`<button class="wb-button" data-period="${p}" aria-pressed="${v33Period===p}">${label}</button>`).join('')}</div>
      <button class="wb-button" data-prev aria-label="上一期間" ${v33Offset<=-52?'disabled':''}>‹</button><strong data-period-label>載入中</strong><button class="wb-button" data-next aria-label="下一期間" ${v33Offset===0?'disabled':''}>›</button>
      <label>貢獻人員 <select id="v37-staff-select">${options([['','全體人員'],...STAFF.map(s=>[s.id,s.name+(s.active?'':'（已離職）')])],analyticsStaff)}</select></label>
      <button class="wb-button" data-refresh>重新整理</button></div><div data-analytics-content aria-live="polite">載入分析中…</div>`;
    view.querySelectorAll('[data-period]').forEach(b=>b.onclick=()=>{v33Period=b.dataset.period;v33Offset=0;renderAnalytics();});
    view.querySelector('[data-prev]').onclick=()=>{v33Offset=Math.max(-52,v33Offset-1);renderAnalytics();};
    view.querySelector('[data-next]').onclick=()=>{v33Offset=Math.min(0,v33Offset+1);renderAnalytics();};
    view.querySelector('[data-refresh]').onclick=renderAnalytics;
    view.querySelector('#v37-staff-select').onchange=e=>{analyticsStaff=e.target.value;renderAnalytics();};
    // v20 F11: 同上，success/catch 都以序號 + 本次節點守門
    const contentNode=view.querySelector('[data-analytics-content]'), labelNode=view.querySelector('[data-period-label]');
    const epoch=wbEpoch();
    const current=()=>seq===analyticsSeq&&contentNode.isConnected&&epoch===wbEpoch();
    try {
      const data=await api.analytics.get({period:v33Period,offset:v33Offset,...(analyticsStaff?{staffId:analyticsStaff}:{})});
      if(!current())return;
      const sid=analyticsStaff?String(analyticsStaff):'';
      const name=STAFF.find(s=>String(s.id)===sid)?.name;
      // v40: 完成 cohort 以後端 data.cases（結案日落在期間內）為準；參與以穩定 ID 判斷，同名不同人不混算。
      const collabIds=c=>Array.isArray(c.collaboratorIds)?c.collaboratorIds.map(String):null;
      const participates=c=>!sid||String(c.designerId)===sid||(collabIds(c)?collabIds(c).includes(sid):(!!name&&(c.collaboratorNames||[]).includes(name)));
      const completed=(data.cases||[]).filter(participates);
      labelNode.textContent=data.period.label;
      const end=new Date(new Date(data.period.end)-86400000).toISOString().slice(0,10);
      const rows=wbPeriodRows(data,completed);
      contentNode.innerHTML=`<p class="wb-help">${date(data.period.start)} ～ ${end} · 依自然週／月／季／半年／年計算</p>
        <div class="wb-metrics"><div><small>部門完成案件</small><strong>${data.totals.count}</strong></div><div><small>部門貢獻總分</small><strong>${data.totals.score.toFixed(1)}</strong></div><div><small>部門準時率</small><strong>${data.totals.onTimeRate==null?'—':Math.round(data.totals.onTimeRate*100)+'%'}</strong></div><div><small>${name?esc(name)+'參與':'部門'}期間工作</small><strong>${rows.length}</strong></div></div>
        <section class="wb-surface wb-charts-surface" aria-labelledby="wb-charts-title"><h2 id="wb-charts-title">期間圖表</h2><p class="wb-help">點數字或名稱可在下方「期間工作明細」看到同一批案件；篩選與明細共用，可用「清除篩選」還原。</p><div class="wb-charts" data-charts></div></section>
        <div class="wb-analytics-grid"><section class="wb-surface"><h2>${name?esc(name)+'的完成貢獻':'已完成案件的貢獻排行'}</h2>${(data.perStaff||[]).filter(s=>s.totalCount||s.collab.count).map(s=>`<div class="wb-contribution"><strong>${esc(s.name)}</strong><span>主責 ${s.primary.count} · 協作 ${s.collab.count}</span><b>${s.totalScore.toFixed(1)} 分</b></div>`).join('')||'<p class="wb-help">本期間尚無已完成案件。</p>'}<p class="wb-help">僅計入結案日落在本期間的已結案案件。分級 × 主責 1／協作 0.4 × 提早 1.2／準時 1.1／逾期 0.8 × 急件 1.3。</p></section>
        <section class="wb-surface"><h2>本期間完成任務 · ${completed.length} 件</h2><div class="wb-completed">${completed.map(c=>`<p>${esc(c.title)}<small class="wb-help">${esc(c.designerName||'')} · 結案 ${date(c.closedOn)}</small></p>`).join('')||'<p class="wb-help">沒有符合條件的已完成案件。</p>'}</div></section></div>
        <section class="wb-surface wb-period-work" data-period-work><h2>期間工作明細 · 含跨期案件</h2><p class="wb-help">派發日早於期間結束，且尚在辦理或結案／取消日落在期間開始之後。已逾期但仍在辦理的案件也會列入；本期結案以部門完成清單為準（含日期異常者）。結束日缺漏會標示待補，不自動省略。</p><div data-work-ledger></div></section>`;
      const workNode=contentNode.querySelector('[data-work-ledger]'), chartsNode=contentNode.querySelector('[data-charts]');
      const ledgerOpts={phases:WB_PHASES,onDisplay:()=>wbSyncChartPressed(chartsNode,ledgerState)};
      chartsNode.innerHTML=wbChartsHtml(rows,completed,sid);
      // 圖表下鑽：重設明細篩選為「同一期間＋同一 cohort」條件，保留排序方向
      chartsNode.onclick=e=>{
        const b=e&&e.target&&e.target.closest&&e.target.closest('[data-drill]');if(!b||!current())return;
        ['q','hotel','staff','role','status','from','to','phase'].forEach(k=>delete ledgerState[k]);
        const d=b.dataset;if(d.drillStaff)ledgerState.staff=d.drillStaff;if(d.drillRole)ledgerState.role=d.drillRole;if(d.drillHotel)ledgerState.hotel=d.drillHotel;if(d.drillPhase)ledgerState.phase=d.drillPhase;
        ledgerState.page=1;ledger(workNode,rows,ledgerState,'work',ledgerOpts);
        try{contentNode.querySelector('[data-period-work]')?.scrollIntoView?.({block:'start'});workNode.querySelector('[data-count]')?.focus?.();}catch{}
      };
      ledger(workNode,rows,ledgerState,'work',ledgerOpts);
    } catch(e){ if(!current())return; contentNode.textContent='分析載入失敗：'+(e.data?.message||e.message); }
  };

  const originalStaff=window.renderStaff;
  window.renderStaff=function(){
    originalStaff.apply(this,arguments);
    document.querySelectorAll('#staff-table .staff-row:not(.head)').forEach(row=>{
      const s=STAFF.find(s=>s.name===row.querySelector('.n-primary')?.textContent.trim());
      const actions=row.querySelector('.s-actions');if(!s||!actions)return;
      const b=document.createElement('button');b.className='wb-button wb-view-cases';b.textContent='案件';b.setAttribute('aria-label','查看 '+s.name+' 的所有案件');b.onclick=()=>wbOpenCases({staff:String(s.id)});actions.prepend(b);
    });
  };
  const originalHotels=window.renderHotelOverview;
  window.renderHotelOverview=async function(){
    await originalHotels.apply(this,arguments);
    document.querySelectorAll('.v81-row[data-hotel]').forEach(row=>{
      const name=row.dataset.hotel;const b=document.createElement('button');b.className='wb-button wb-hotel-cases';b.textContent='全部案件';b.setAttribute('aria-label','查看 '+name+' 的所有案件');
      b.onclick=e=>{e.stopPropagation();wbOpenCases({hotel:name});};b.onkeydown=e=>e.stopPropagation();row.firstElementChild?.appendChild(b);
    });
  };

  const originalNav=window.renderNav;
  window.renderNav=function(){ originalNav.apply(this,arguments); ensureAccountButton(); };
  function ensureAccountButton(){
    if(!ME?.id)return;
    const badge=document.getElementById('user-badge') || document.querySelector('.topbar');if(!badge||document.getElementById('wb-account'))return;
    const b=document.createElement('button');b.id='wb-account';b.className='tb-ctl';b.textContent='帳號與密碼';b.onclick=()=>openProfileEdit(STAFF.find(s=>s.id===ME.id)||ME);badge.appendChild(b);
  }
  const originalProfile=window.openProfileEdit;
  window.openProfileEdit=function(target){
    recoveryGen++; // v10: 新一次開啟，先前飛行中的 recovery 回覆全部失效
    originalProfile.apply(this,arguments);
    document.getElementById('v34-pf-pwsection').style.display='';
    const t=v34CurrentEditTarget;
    if(t?.id===ME.id){
      document.getElementById('v34-profile-title').textContent='我的帳號與密碼';
      document.getElementById('v34-pf-pwtitle').textContent='修改密碼（更新後需重新登入）';
      ['current','new','new2'].forEach(k=>document.getElementById('v34-pf-pw-'+k).setAttribute('autocomplete',k==='current'?'current-password':'new-password'));
    } else if(ME.role==='admin'){
      const section=document.getElementById('v34-pf-pw-admin');
      section.innerHTML='<input id="v34-pf-pw-reset" type="hidden" value=""><p class="wb-help">讓成員自行設定密碼。產生連結不會立刻更動密碼；新連結會取代舊連結。</p><button class="wb-button" id="wb-recovery-create">產生限時重設連結</button><div id="wb-recovery-result" role="status"></div>';
      const b=document.getElementById('wb-recovery-create');
      b.disabled=t.pendingActivation||!t.active;
      if(b.disabled)section.querySelector('p').textContent=t.pendingActivation?'帳號尚未啟用，請使用「重寄邀請」。':'離職帳號不可重設密碼。';
      b.onclick=async()=>{
        // v10: 綁定「這次點擊」的對象與開啟世代；晚到的回覆若對象/世代/節點任一不符一律丟棄，杜絕 A 的連結出現在 B 的視窗
        const targetId=t.id, targetName=t.name, targetEmail=t.email||'', gen=recoveryGen, resultNode=document.getElementById('wb-recovery-result');
        const stillValid=()=>gen===recoveryGen && v34CurrentEditTarget && v34CurrentEditTarget.id===targetId && document.getElementById('wb-recovery-result')===resultNode;
        b.disabled=true;
        try{
          const data=await fetchJson('POST','/api/auth/recovery-link/'+targetId,{});
          if(!stillValid())return;
          if(data&&data.targetId!=null&&String(data.targetId)!==String(targetId)){resultNode.textContent='回覆對象不符，已忽略，請重新產生';return;}
          if(!data||typeof data.url!=='string'){resultNode.textContent='伺服器回應異常，請重新產生';return;}
          resultNode.innerHTML='<p class="wb-help"><b>對象：'+esc(targetName)+(targetEmail?'（'+esc(targetEmail)+'）':'')+'</b></p><p class="wb-help">連結 30 分鐘內有效、僅可使用一次。請僅透過私人管道提供給該成員。</p><button class="wb-button" id="wb-copy-recovery">複製 '+esc(targetName)+' 的重設連結</button><p class="wb-help">到期：'+esc(new Date(data.expires).toLocaleString('zh-TW'))+'</p>';
          const copyBtn=document.getElementById('wb-copy-recovery');
          copyBtn.onclick=async()=>{
            if(!stillValid()){showToast('視窗已切換，請重新產生連結','err');return;}
            try{await navigator.clipboard.writeText(data.url);showToast('已複製 '+targetName+' 的重設連結，請私下提供');}catch{showToast('複製失敗，請重新產生連結後再試','err');}
          };
        }catch(e){if(stillValid())resultNode.textContent=e.data?.message||'產生失敗，請重試';}
        finally{if(stillValid())b.disabled=false;}
      };
    }
  };
  ensureAccountButton();
})();
