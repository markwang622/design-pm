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

  function ledger(root, rows, state, prefix) {
    const hotels = [...new Set(rows.map(c=>c.hotel).filter(Boolean))].sort(window.hotelOrderCompare || ((a,b)=>a.localeCompare(b,'zh-TW'))); // v9.9: 與全站共用管理者館別順序
    const people = new Map();
    rows.forEach(c => [c.designer,...(c.collaborators||[])].filter(Boolean).forEach(s=>people.set(String(s.id),s.name)));
    // Keep a zero-result selection visible, so users can clear it.
    if (state.staff && !people.has(String(state.staff))) people.set(String(state.staff), STAFF.find(s=>String(s.id)===String(state.staff))?.name || '已選人員');
    if (state.hotel && !hotels.includes(state.hotel)) hotels.push(state.hotel);
    const fields = [['dispatchDate','派發日'],['goLiveDate','上線日'],['openDate','開單日'],['closedOn','結案日']];
    state.sort ||= 'dispatchDate'; state.direction ||= 'asc';
    root.innerHTML = `<div class="wb-filters">
      <label>搜尋<input data-filter="q" type="search" placeholder="案號、案件名稱、需求單位" value="${esc(state.q||'')}"></label>
      <label>館別<select data-filter="hotel">${options([...blank,...hotels.map(h=>[h,h])],state.hotel||'')}</select></label>
      <label>人員（含主責與協作）<select data-filter="staff">${options([...blank,...[...people].sort((a,b)=>a[1].localeCompare(b[1],'zh-TW'))],state.staff||'')}</select></label>
      <label>狀態<select data-filter="status">${options([...blank,['active','在辦案件'],['finished','已結案'],...Object.entries(statuses).filter(([k])=>k!=='done'&&k!=='closed')],state.status||'')}</select></label>
      <label>日期與排序依據<select data-filter="sort">${options(fields,state.sort)}</select></label>
      <label>日期起<input data-filter="from" type="date" value="${esc(state.from||'')}"></label>
      <label>日期迄<input data-filter="to" type="date" value="${esc(state.to||'')}"></label>
      <label>順序<select data-filter="direction">${options([['asc','舊 → 新'],['desc','新 → 舊']],state.direction)}</select></label>
      <button class="wb-button" data-clear>清除篩選</button>
    </div><p class="wb-help" data-count aria-live="polite"></p><div data-results></div>`;
    const display = () => {
      const invalidDates = state.from && state.to && state.from > state.to;
      const selected = invalidDates ? [] : rows.filter(c => {
        if (state.q && ![c.id,c.title,c.requester].join(' ').toLowerCase().includes(state.q.toLowerCase())) return false;
        if (state.hotel && c.hotel !== state.hotel) return false;
        if (state.staff && ![c.designer,...(c.collaborators||[])].filter(Boolean).some(s=>String(s.id)===String(state.staff))) return false;
        if (state.status==='active' && ['done','closed','cancelled'].includes(c.status)) return false;
        if (state.status==='finished' && !['done','closed'].includes(c.status)) return false;
        if (state.status && !['active','finished'].includes(state.status) && state.status!==c.status) return false;
        const d = c[state.sort] ? date(c[state.sort]) : '';
        return !(state.from && (!d || d < state.from)) && !(state.to && (!d || d > state.to));
      }).sort((a,b)=>{
        const x=a[state.sort],y=b[state.sort];
        if (!x && y) return 1; if (x && !y) return -1;
        const n = String(x||'').localeCompare(String(y||''));
        return (state.direction==='desc'?-n:n) || String(a.id).localeCompare(String(b.id));
      });
      root.querySelector('[data-count]').textContent = invalidDates ? '開始日期不能晚於結束日期。請調整日期。' : `顯示 ${selected.length} / ${rows.length} 件 · 含主責、協作、已結案與取消的案件；無日期者排在最後`;
      root.querySelector('[data-results]').innerHTML = selected.length ? `<div class="wb-case-table"><div class="wb-case-head"><span>案件／館別</span><span>主責／協作</span><span>狀態</span><span>派發日</span><span>上線日</span><span>結案／取消日</span></div>${selected.map(c=>`<div class="wb-case-row">
        <div><button class="wb-case-link" data-case="${esc(c.id)}">${esc(c.title||c.id)}</button><div class="wb-help">${esc(c.id)} · ${esc(c.hotel||'未指定館別')} · ${esc(c.level||'—')}<br>${esc(c.requester||'未填需求單位')}</div></div>
        <div><span class="wb-mobile-label">主責 </span>${esc(c.designer?.name||'未指派')}<div class="wb-help">${(c.collaborators||[]).length?'協作 '+c.collaborators.map(s=>esc(s.name)).join('、'):'無協作者'}</div></div>
        <div><span class="wb-status" data-status="${esc(c.status)}">${esc(statuses[c.status]||c.status)}</span>${c.archived?'<small class="wb-help"> 已封存</small>':''}</div>
        <div><span class="wb-mobile-label">派發 </span>${date(c.dispatchDate)}</div><div><span class="wb-mobile-label">上線 </span>${date(c.goLiveDate)}</div>
        <div><span class="wb-mobile-label">結束 </span>${date(c.cancelledOn||c.closedOn)}${c.endDateMissing?'<div class="wb-help">結束日待補，暫保留於明細</div>':''}</div>
      </div>`).join('')}</div>` : '<div class="wb-empty">沒有符合條件的案件。可清除篩選或調整日期範圍。</div>';
      root.querySelectorAll('[data-case]').forEach(b=>b.onclick=async()=>{
        const sequence=window.v95DrawerSeq.bump(),viewAtRequest=currentView; // v9.5: 與其他入口共用失效序號
        try {
          const raw=await api.cases.getOne(b.dataset.case);
          if(sequence!==window.v95DrawerSeq.now()||currentView!==viewAtRequest)return;
          const c=decorateCase(normalizeCase(raw)); // v9.5: 與 decorateCases/openDrawerById 共用同一份補齊邏輯
          await openDrawer(c);
        } catch(e) { showToast('無法開啟案件：'+(e.data?.message||e.message),'err'); }
      });
    };
    root.querySelectorAll('[data-filter]').forEach(input=>{
      const update=()=>{state[input.dataset.filter]=input.value; display();};
      input.addEventListener(input.type==='search'?'input':'change',update);
    });
    root.querySelector('[data-clear]').onclick=()=>{Object.keys(state).forEach(k=>delete state[k]);ledger(root,rows,state,prefix);};
    display();
  }

  function ensureExplorer() {
    let view=document.querySelector('div.view[data-view="cases-all"]');
    if (!view) { view=document.createElement('div');view.className='view';view.dataset.view='cases-all';document.querySelector('.main').appendChild(view); }
    return view;
  }
  async function renderExplorer() {
    const view=ensureExplorer(), seq=++explorerSeq;
    view.innerHTML='<div class="wb-heading"><div><h1>案件總表</h1><p class="wb-help">依館別或人員查找所有案件，直接開啟查看或更新。</p></div><button class="wb-button" data-reload>重新整理</button></div><section class="wb-surface" data-ledger>載入案件中…</section>';
    view.querySelector('[data-reload]').onclick=renderExplorer;
    // v20 F11: 成功與失敗都綁「本次序號 + 本次建立的 DOM 節點」，舊回應（含舊失敗）不得覆蓋新畫面
    const node=view.querySelector('[data-ledger]');
    const current=()=>seq===explorerSeq&&node.isConnected;
    try { const rows=await api.cases.listArchived(); if(!current())return; explorerRows=rows; ledger(node,rows,explorerState,'all'); }
    catch(e) { if(!current())return; node.textContent='載入失敗，請按「重新整理」再試。'; }
  }
  window.wbOpenCases = function(filters={}) { explorerState={...filters};switchView('cases-all'); };
  for(const role of ['admin','designer']) if(!NAV_DEF[role].some(n=>n.key==='cases-all')) NAV_DEF[role].push({key:'cases-all',label:'案件總表'});
  const originalSwitch=window.switchView;
  window.switchView=function(v){
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
    const current=()=>seq===analyticsSeq&&contentNode.isConnected;
    try {
      const data=await api.analytics.get({period:v33Period,offset:v33Offset,...(analyticsStaff?{staffId:analyticsStaff}:{})});
      if(!current())return;
      const name=STAFF.find(s=>String(s.id)===analyticsStaff)?.name;
      const completed=data.cases.filter(c=>!name || c.designerId===Number(analyticsStaff) || c.collaboratorNames.includes(name));
      labelNode.textContent=data.period.label;
      const end=new Date(new Date(data.period.end)-86400000).toISOString().slice(0,10);
      contentNode.innerHTML=`<p class="wb-help">${date(data.period.start)} ～ ${end} · 依自然週／月／季／半年／年計算</p>
        <div class="wb-metrics"><div><small>部門完成案件</small><strong>${data.totals.count}</strong></div><div><small>部門貢獻總分</small><strong>${data.totals.score.toFixed(1)}</strong></div><div><small>部門準時率</small><strong>${data.totals.onTimeRate==null?'—':Math.round(data.totals.onTimeRate*100)+'%'}</strong></div><div><small>${name?esc(name)+'參與':'部門'}期間工作</small><strong>${data.workCases.length}</strong></div></div>
        <div class="wb-analytics-grid"><section class="wb-surface"><h2>${name?esc(name)+'的完成貢獻':'已完成案件的貢獻排行'}</h2>${data.perStaff.filter(s=>s.totalCount||s.collab.count).map(s=>`<div class="wb-contribution"><strong>${esc(s.name)}</strong><span>主責 ${s.primary.count} · 協作 ${s.collab.count}</span><b>${s.totalScore.toFixed(1)} 分</b></div>`).join('')||'<p class="wb-help">本期間尚無已完成案件。</p>'}<p class="wb-help">僅計入結案日落在本期間的已結案案件。分級 × 主責 1／協作 0.4 × 提早 1.2／準時 1.1／逾期 0.8 × 急件 1.3。</p></section>
        <section class="wb-surface"><h2>本期間完成任務 · ${completed.length} 件</h2><div class="wb-completed">${completed.map(c=>`<p>${esc(c.title)}<small class="wb-help">${esc(c.designerName||'')} · 結案 ${date(c.closedOn)}</small></p>`).join('')||'<p class="wb-help">沒有符合條件的已完成案件。</p>'}</div></section></div>
        <section class="wb-surface wb-period-work"><h2>期間工作明細 · 含跨期案件</h2><p class="wb-help">派發日早於期間結束，且尚在辦理或結案／取消日落在期間開始之後。已逾期但仍在辦理的案件也會列入。結束日缺漏會標示待補，不自動省略。</p><div data-work-ledger></div></section>`;
      ledger(contentNode.querySelector('[data-work-ledger]'),data.workCases,ledgerState,'work');
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
