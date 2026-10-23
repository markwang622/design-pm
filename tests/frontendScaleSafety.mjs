import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

// Shipped browser functions run with inert DOM, deterministic clocks and API
// doubles. Complete emitted HTML is retained; a parser cap protects the known-
// bad unbounded baseline from allocating 10,000 synthetic row trees. Passing
// bounded output is fully parsed. Event attribute strings are never executed.
process.env.TZ='Asia/Taipei';
const root=process.env.DESIGN_PM_ROOT||new URL('../',import.meta.url).pathname;
const source=fs.readFileSync(root+'/public/index.html','utf8');
const extension=fs.readFileSync(root+'/public/workbench-features.js','utf8');
function section(start,end,text=source){const a=text.indexOf(start),b=text.indexOf(end,a+start.length);assert(a>=0&&b>a,'actual source section exists: '+start);return text.slice(a,b);}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<32;i++)await Promise.resolve();};
const plain=value=>JSON.parse(JSON.stringify(value));
const decode=s=>String(s).replace(/&(?:amp|lt|gt|quot|apos|#39|#x27);/g,x=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'",'&#x27;':"'"}[x]));

function dom(){
  const all=[];
  function element(tag='div',id=''){
    const n={tagName:tag.toUpperCase(),id,style:{},dataset:{},attributes:{},children:[],parentNode:null,_value:undefined,disabled:false,checked:false,_text:'',_html:'',events:{}};
    Object.defineProperty(n,'value',{get(){
      if(n.tagName==='SELECT'){
        const options=n.querySelectorAll('option');
        if(n._value!==undefined)return options.find(x=>x.value===n._value)?.value??'';
        return (options.find(x=>x.getAttribute('selected')!==null)||options[0])?.value??'';
      }
      return n._value??(n.tagName==='TEXTAREA'?n.textContent:n.tagName==='OPTION'?n.textContent:'');
    },set:v=>{n._value=String(v??'');}});
    let classes=new Set();
    Object.defineProperty(n,'className',{get:()=>[...classes].join(' '),set:v=>classes=new Set(String(v).split(/\s+/).filter(Boolean))});
    n.classList={add(...xs){xs.forEach(x=>classes.add(x));},remove(...xs){xs.forEach(x=>classes.delete(x));},contains:x=>classes.has(x),toggle(x,v){v??=!classes.has(x);v?classes.add(x):classes.delete(x);}};
    n.setAttribute=(key,value)=>{value=String(value);n.attributes[key]=value;if(key==='id')n.id=value;else if(key==='class')n.className=value;else if(key==='value')n.value=value;else if(key==='disabled')n.disabled=true;else if(key.startsWith('data-'))n.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;};
    n.getAttribute=key=>key==='id'?n.id:key==='class'?n.className:n.attributes[key]??(key.startsWith('data-')?n.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]??null:null);
    n.removeAttribute=key=>{delete n.attributes[key];if(key==='disabled')n.disabled=false;};
    n.appendChild=child=>{child.remove();child.parentNode=n;n.children.push(child);return child;};
    n.insertBefore=(child,before)=>{child.remove();child.parentNode=n;const i=n.children.indexOf(before);if(i<0)n.children.push(child);else n.children.splice(i,0,child);return child;};
    n.remove=()=>{if(n.parentNode){const p=n.parentNode;p.children=p.children.filter(x=>x!==n);n.parentNode=null;}};
    n.replaceChildren=(...children)=>{n.children.forEach(x=>x.parentNode=null);n.children=[];n._text='';children.forEach(c=>n.appendChild(c));};
    Object.defineProperty(n,'isConnected',{get(){let p=n;while(p){if(p===document.body||p===document.head)return true;p=p.parentNode;}return false;}});
    Object.defineProperty(n,'firstChild',{get:()=>n.children[0]||null});
    Object.defineProperty(n,'firstElementChild',{get:()=>n.children[0]||null});
    Object.defineProperty(n,'textContent',{get:()=>n._text+n.children.map(x=>x.textContent).join(''),set:v=>{n.replaceChildren();n._text=String(v??'');n._html='';}});
    Object.defineProperty(n,'innerHTML',{get:()=>n._html,set:value=>{
      n.replaceChildren();n._html=String(value);const stack=[n];let last=0;
      let parsedTags=0;
      for(const m of n._html.matchAll(/<(\/?)([a-z][\w:-]*)([^>]*)>/gi)){
        if(++parsedTags>12000)break;
        stack.at(-1)._text+=decode(n._html.slice(last,m.index));last=m.index+m[0].length;
        if(m[1]){if(stack.length>1)stack.pop();continue;}
        const child=element(m[2]);
        for(const a of m[3].matchAll(/([^\s=/'"]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))child.setAttribute(a[1],decode(a[2]??a[3]??a[4]??''));
        stack.at(-1).appendChild(child);
        if(!['input','img','br','hr','meta','link'].includes(m[2].toLowerCase())&&!m[3].endsWith('/'))stack.push(child);
      }
      stack.at(-1)._text+=decode(n._html.slice(last));
    }});
    const descendants=()=>n.children.flatMap(x=>[x,...x.querySelectorAll('*')]);
    n.querySelectorAll=selector=>{
      const selectors=selector.split(',').map(s=>s.trim());
      return descendants().filter(x=>selectors.some(s=>{
        const tokens=s.split(/\s+/);let current=x;
        if(!matches(current,tokens.pop()))return false;
        while(tokens.length){const wanted=tokens.pop();current=current.parentNode;while(current&&current!==n&&!matches(current,wanted))current=current.parentNode;if(!current||current===n&&!matches(current,wanted))return false;}
        return true;
      }));
    };
    n.querySelector=selector=>n.querySelectorAll(selector)[0]||null;
    n.closest=selector=>{let current=n;while(current){if(matches(current,selector))return current;current=current.parentNode;}return null;};
    n.addEventListener=(type,fn)=>{(n.events[type]||=[]).push(fn);};
    n.click=()=>{if(n.disabled)return;let stopped=false;const event={type:'click',target:n,preventDefault(){},stopPropagation(){stopped=true;}};const returned=n.onclick?.(event);for(const fn of n.events.click||[])fn(event);let parent=n.parentNode;while(parent&&!stopped){parent.onclick?.(event);for(const fn of parent.events.click||[])fn(event);parent=parent.parentNode;}if(!stopped)document.dispatchEvent(event);return returned;};
    n.prepend=child=>n.insertBefore(child,n.firstChild);n.focus=()=>{};n.select=()=>{};n.scrollIntoView=()=>{};n.insertAdjacentElement=(_pos,child)=>n.parentNode?.appendChild(child);
    n.contains=child=>{let p=child;while(p){if(p===n)return true;p=p.parentNode;}return false;};
    n.dispatchEvent=(event)=>{event={bubbles:true,...event};event.target??=n;let stopped=false;event.preventDefault??=()=>{event.defaultPrevented=true;};event.stopPropagation??=()=>{stopped=true;};let returned;let current=n;while(current){event.currentTarget=current;const result=current['on'+event.type]?.(event);if(current===n)returned=result;for(const fn of current.events[event.type]||[])fn(event);if(stopped||event.bubbles===false)break;current=current.parentNode;}if(!stopped&&event.bubbles!==false)document.dispatchEvent(event);return returned;};
    n.click=()=>{if(n.disabled)return;return n.dispatchEvent({type:'click'});};
    n.focus=()=>{document.activeElement=n;};
    Object.defineProperty(n,'type',{get:()=>n.getAttribute('type')||''});
    all.push(n);return n;
  }
  function matches(n,s){
    if(s==='*')return true;
    for(const m of s.matchAll(/:not\(([^)]+)\)/g))if(matches(n,m[1]))return false;
    s=s.replace(/:not\([^)]+\)/g,'');
    const tag=s.match(/^[a-z][\w-]*/i);if(tag&&n.tagName!==tag[0].toUpperCase())return false;
    const id=s.match(/#([\w-]+)/);if(id&&n.id!==id[1])return false;
    for(const m of s.matchAll(/\.([\w-]+)/g))if(!n.classList.contains(m[1]))return false;
    for(const m of s.matchAll(/\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g)){const v=n.getAttribute(m[1]);if(v===null)return false;const want=m[2]??m[3]??m[4];if(want!==undefined&&v!==want)return false;}
    if(s.includes(':checked')&&!n.checked)return false;
    return true;
  }
  const document={createElement:tag=>element(tag),getElementById:id=>all.find(n=>n.id===id&&n.isConnected)||null,execCommand(){throw Error('No real clipboard fallback permitted');}};
  document.events={};document.addEventListener=(type,fn)=>{(document.events[type]||=[]).push(fn);};document.dispatchEvent=event=>{for(const fn of document.events[event.type]||[])fn(event);};
  document.body=element('body');document.head=element('head');
  document.querySelectorAll=s=>[...document.body.querySelectorAll(s),...document.head.querySelectorAll(s)];document.querySelector=s=>document.querySelectorAll(s)[0]||null;
  const seed=(id,tag='div',parent=document.body)=>parent.appendChild(element(tag,id));
  return{document,element,seed,get:id=>document.getElementById(id)};
}
function context(extra={}){
  const c={Date,console,Set,Map,Promise,URLSearchParams,crypto:webcrypto,setTimeout,clearTimeout,...extra};c.window=c;return vm.createContext(c);
}
function fakeClock(){
  let now=0,serial=0;const timers=new Map();
  return {setTimeout(fn,delay=0){const id=++serial;timers.set(id,{fn,at:now+Number(delay)});return id;},clearTimeout(id){timers.delete(id);},pending:()=>timers.size,async advance(ms){now+=ms;for(let rounds=0;rounds<100;rounds++){const due=[...timers].filter(([,t])=>t.at<=now).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0]);if(!due.length)break;for(const [id,t]of due){if(!timers.delete(id))continue;t.fn();}await flush();}}};
}
const dates=section('function d(y, m, dd)','// ============== Staff & domain constants');
const normalize=section('function normalizeCase(b)','function findStaffId');
const decorate=section('function decorateCase(c)','function decorateCases()');
const escaped=section('function escapeHtml(s)','async function v33SaveEdit');
function browser(extra={}){
  const d=dom(),clock=fakeClock(),messages=[],windowEvents=new Map(),main=d.seed('main');main.className='main';
  const c=context({document:d.document,AbortController,CustomEvent:class{constructor(type,{detail}={}){this.type=type;this.detail=detail;}},queueMicrotask:fn=>Promise.resolve().then(fn),setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,requestAnimationFrame:fn=>clock.setTimeout(fn,0),cancelAnimationFrame:clock.clearTimeout,
    ME:{id:0,name:'Admin',role:'admin'},ME_NAME:()=> 'Admin',IS_OBSERVER:()=>false,STAFF:[],CASES:[],currentCase:null,currentRole:'admin',currentView:'personal',NAV_DEF:{admin:[],designer:[]},STATUSES:[],ENDED_STATUS_KEYS:new Set(['done','closed','cancelled']),FINAL_STATUS_KEYS:new Set(['done','closed']),v58ConflictsFor:()=>[],v80NextStep:()=>'',showToast:(message,type)=>messages.push({message,type}),renderNav(){},renderStaff(){},renderHotelOverview(){},openProfileEdit(){},v33Period:'month',v33Offset:0,
    addEventListener(type,fn){if(!windowEvents.has(type))windowEvents.set(type,[]);windowEvents.get(type).push(fn);},dispatchEvent(event){for(const fn of windowEvents.get(event.type)||[])fn(event);},...extra});
  c.switchView=extra.switchView||function(v){c.currentView=v;};
  c.v95DrawerSeq=(()=>{let n=0;return {now:()=>n,bump:()=>++n};})();
  vm.runInContext(dates+normalize+decorate+escaped,c);
  return {c,d,clock,messages};
}
function rows(count){return Array.from({length:count},(_,i)=>({id:'CASE-'+String(i).padStart(5,'0'),title:'Fixture '+String(i).padStart(5,'0'),hotel:i%2?'South':'North',requester:i%2?'Operations':'Marketing',level:'C',status:'doing',designer:{id:i%3+1,name:'Designer '+(i%3+1)},collaborators:i%10===0?[{id:99,name:'Collaborator'}]:[],dispatchDate:'2026-10-01',openDate:'2026-09-01',goLiveDate:'2026-10-30'}));}
const analyticsData=workCases=>({period:{label:'October',start:'2026-10-01',end:'2026-11-01'},cases:[],perStaff:[],totals:{count:0,score:0,onTimeRate:null},workCases});
function ledgerContext(allRows,workRows=[]){
  const requests=[],opened=[];const env=browser({api:{cases:{listArchived:async()=>{requests.push('all');return allRows;},getOne:async id=>{requests.push('one:'+id);return allRows.find(r=>r.id===id);}},analytics:{get:async()=>{requests.push('analytics');return analyticsData(workRows);}}}});const {c,d}=env;
  const analytics=d.seed('analytics','div',d.get('main'));analytics.className='view';analytics.dataset.view='analytics';
  c.v33EnsureAnalyticsView=()=>{};c.openDrawer=row=>opened.push(row);c.openDrawerById=async(id,options)=>opened.push({id,options});
  vm.runInContext(extension,c);
  const openAll=async()=>{c.switchView('cases-all');await flush();return d.document.querySelector('[data-ledger]');};
  const openWork=async()=>{c.currentView='analytics';await c.renderAnalytics();await flush();return d.document.querySelector('[data-work-ledger]');};
  return {...env,requests,opened,openAll,openWork};
}
const ids=ledger=>ledger.querySelectorAll('[data-case]').map(n=>n.dataset.case);
const result=ledger=>ledger.querySelector('[data-results]');
const emittedRows=ledger=>(result(ledger)?.innerHTML.match(/class="wb-case-row"/g)||[]).length;
function pageButton(ledger,direction){return ledger.querySelectorAll('button').find(b=>{const name=(b.getAttribute('aria-label')||'')+' '+b.textContent;return direction==='next'?/下一頁|下一页|next page|›|→/i.test(name):/上一頁|上一页|previous page|‹|←/i.test(name);});}
async function page(ledger,direction){const button=pageButton(ledger,direction);assert(button,'accessible '+direction+' page button exists');assert.equal(button.disabled,false,direction+' page is enabled');await button.click();await flush();}
function change(ledger,key,value,type='change'){const input=ledger.querySelector('[data-filter="'+key+'"]');assert(input,'filter '+key+' exists');input.value=value;input.dispatchEvent({type});return input;}
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}}

await test('10,000 matches emit at most 50 real ledger rows while retaining the full total',async()=>{
  const {openAll}=ledgerContext(rows(10000)),ledger=await openAll();assert.equal(emittedRows(ledger),50);assert.equal(ids(ledger).length,50);assert(ledger.querySelector('[data-count]').textContent.includes('10000'));assert(Buffer.byteLength(result(ledger).innerHTML)<100000,'generated visible-row markup remains bounded');
});
await test('next and previous pages preserve stable full-result ordering without gaps or duplicates',async()=>{
  const data=rows(131),{openAll}=ledgerContext(data),ledger=await openAll();assert.deepEqual(ids(ledger),data.slice(0,50).map(r=>r.id));assert.equal(pageButton(ledger,'prev')?.disabled,true);
  await page(ledger,'next');assert.deepEqual(ids(ledger),data.slice(50,100).map(r=>r.id));await page(ledger,'next');assert.deepEqual(ids(ledger),data.slice(100).map(r=>r.id));assert.equal(pageButton(ledger,'next').disabled,true);await page(ledger,'prev');assert.deepEqual(ids(ledger),data.slice(50,100).map(r=>r.id));
});
await test('filters search the entire dataset and reset pagination to the first matching page',async()=>{
  const data=rows(131);data[130].title='Needle beyond first pages';const {openAll,clock}=ledgerContext(data),ledger=await openAll();await page(ledger,'next');
  change(ledger,'q','Needle','input');await clock.advance(180);assert.deepEqual(ids(ledger),[data[130].id]);assert(!pageButton(ledger,'prev')||pageButton(ledger,'prev').disabled);assert(!pageButton(ledger,'next')||pageButton(ledger,'next').disabled);
  change(ledger,'q','','input');await clock.advance(180);change(ledger,'hotel','South');assert.deepEqual(ids(ledger),data.filter(r=>r.hotel==='South').slice(0,50).map(r=>r.id));
});
await test('date sorting happens before slicing pages and keeps missing dates last in both directions',async()=>{
  const data=rows(75);data.forEach((r,i)=>r.goLiveDate=i<5?null:'2026-10-'+String(i%28+1).padStart(2,'0'));
  const {openAll}=ledgerContext(data),ledger=await openAll();change(ledger,'sort','goLiveDate');
  const expected=direction=>data.slice().sort((a,b)=>{if(!a.goLiveDate&&b.goLiveDate)return 1;if(a.goLiveDate&&!b.goLiveDate)return -1;return (direction==='desc'?-1:1)*String(a.goLiveDate||'').localeCompare(String(b.goLiveDate||''))||a.id.localeCompare(b.id);}).map(r=>r.id);
  for(const direction of ['asc','desc']){change(ledger,'direction',direction);assert.deepEqual(ids(ledger),expected(direction).slice(0,50));await page(ledger,'next');assert.deepEqual(ids(ledger),expected(direction).slice(50));}
});
await test('collaborator, finished and invalid-date filters retain their established meanings',async()=>{
  const data=rows(131);data[130].status='closed';data[129].status='cancelled';const {openAll}=ledgerContext(data),ledger=await openAll();
  change(ledger,'staff','99');assert.deepEqual(ids(ledger),data.filter(r=>r.collaborators.some(s=>s.id===99)).map(r=>r.id));change(ledger,'staff','');change(ledger,'status','finished');assert.deepEqual(ids(ledger),[data[130].id]);
  change(ledger,'status','');change(ledger,'from','2026-10-30');change(ledger,'to','2026-10-01');assert.equal(emittedRows(ledger),0);assert.match(ledger.querySelector('[data-count]').textContent,/開始日期不能晚於結束日期/);
});
await test('full-case and analytics ledgers keep independent page and filter state',async()=>{
  const all=rows(131),work=rows(121).map(r=>({...r,id:'WORK-'+r.id}));const {openAll,openWork}=ledgerContext(all,work);let ledger=await openAll();await page(ledger,'next');const allPage=ids(ledger);
  const workLedger=await openWork();assert.deepEqual(ids(workLedger),work.slice(0,50).map(r=>r.id));change(workLedger,'hotel','South');await page(workLedger,'next');
  ledger=await openAll();assert.deepEqual(ids(ledger),allPage);assert.equal(ledger.querySelector('[data-filter="hotel"]').value,'');
});
await test('rapid search input waits 180 ms and retains the same focused input element',async()=>{
  const {openAll,clock,d}=ledgerContext(rows(131)),ledger=await openAll(),input=ledger.querySelector('[data-filter="q"]');input.focus();const before=ids(ledger);
  change(ledger,'q','Fixture 001','input');change(ledger,'q','Fixture 00130','input');await clock.advance(179);assert.deepEqual(ids(ledger),before);await clock.advance(1);assert.deepEqual(ids(ledger),['CASE-00130']);assert.equal(ledger.querySelector('[data-filter="q"]'),input);assert.equal(d.document.activeElement,input);
});
await test('IME composition never renders an intermediate query and commits one final search',async()=>{
  const data=rows(131);data[130].title='台灣館任務';const {openAll,clock}=ledgerContext(data),ledger=await openAll(),input=ledger.querySelector('[data-filter="q"]'),before=ids(ledger);
  input.dispatchEvent({type:'compositionstart'});change(ledger,'q','台','input');await clock.advance(500);assert.deepEqual(ids(ledger),before);change(ledger,'q','台灣館','input');input.dispatchEvent({type:'compositionend'});await clock.advance(180);assert.deepEqual(ids(ledger),[data[130].id]);
});
await test('clear cancels a pending debounced query and leaves the full first page stable',async()=>{
  const data=rows(131),{openAll,clock}=ledgerContext(data),ledger=await openAll();change(ledger,'q','Fixture 00130','input');await ledger.querySelector('[data-clear]').click();await flush();const stable=ids(ledger);await clock.advance(500);assert.deepEqual(stable,data.slice(0,50).map(r=>r.id));assert.deepEqual(ids(ledger),stable);assert.equal(ledger.querySelector('[data-filter="q"]').value,'');assert.equal(clock.pending(),0);
});
await test('ledger replacement cancels its old search timer and the new view keeps its own query',async()=>{
  const {openAll,clock,c}=ledgerContext(rows(131));let ledger=await openAll();change(ledger,'q','Fixture 00130','input');c.wbOpenCases({hotel:'North'});await flush();ledger=c.document.querySelector('[data-ledger]');const stable=ids(ledger);assert.equal(clock.pending(),0,'replaced ledger owns no pending search timer');await clock.advance(500);assert.deepEqual(ids(ledger),stable);assert.equal(ledger.querySelector('[data-filter="hotel"]').value,'North');
});
await test('delegated case opening calls the central fresh opener once for a nested click',async()=>{
  const {openAll,d,opened,requests}=ledgerContext(rows(131)),ledger=await openAll(),button=ledger.querySelector('[data-case]');const child=d.seed('nested-case-label','span',button);await child.click();await flush();assert.equal(opened.length,1);assert.equal(opened[0].id,button.dataset.case);assert.equal(opened[0].options?.fresh,true);assert(!requests.some(r=>r.startsWith('one:')),'ledger delegates transport and lifecycle to central opener');
});
await test('paging and repeated clearing never multiply delegated root click handlers',async()=>{
  const {openAll,opened}=ledgerContext(rows(131)),ledger=await openAll();for(let i=0;i<6;i++){await page(ledger,'next');await ledger.querySelector('[data-clear]').click();await flush();}
  const handlers=(ledger.events.click||[]).length+(typeof ledger.onclick==='function'?1:0);assert(handlers>=1&&handlers<=2,'root owns a constant number of click handlers');await ledger.querySelector('[data-case]').click();await flush();assert.equal(opened.length,1);assert(ledger.querySelectorAll('[data-case]').every(b=>!b.onclick),'rows do not allocate per-row onclick closures');
});

const caseFixture=(id='ARCHIVED',extra={})=>({id,title:'Fixture '+id,hotel:'North',requester:'Marketing',designer:{id:1,name:'Designer'},collaborators:[],level:'C',status:'closed',archived:true,openDate:'2026-09-01',dispatchDate:'2026-10-01',goLiveDate:'2026-10-30',updatedAt:'2026-10-22T01:00:00.000Z',contentVersion:8,items:[],logs:[],...extra});
function openerContext(getOne){
  const shown=[],requests=[];const env=browser({currentView:'personal',api:{cases:{getOne:async id=>{requests.push(id);return getOne(id);},listArchived:async()=>[]}}});const {c,d}=env;
  const drawer=d.seed('drawer');drawer.className='drawer';const body=d.seed('drawer-body','div',drawer);body.className='drawer-body';d.seed('drawer-close','button',drawer);d.seed('d-back','button',drawer);d.seed('drawer-bg');
  c.openDrawer=row=>{shown.push(row);c.currentCase=row;drawer.classList.add('open');d.get('drawer-bg').classList.add('open');};c.openDrawerById=()=>{};c.v33EnsureAnalyticsView=()=>{};
  vm.runInContext(section('const v92CloseDrawer =','// ============== Create modal')+section('const _v38OrigOpenDrawerById','// Fix 3: Dashboard'),c);
  vm.runInContext(extension,c);return {...env,shown,requests};
}
await test('central opener keeps the existing active-cache fast path',async()=>{
  const {c,shown,requests}=openerContext(async()=>{throw Error('unexpected GET');});const active=c.decorateCase(c.normalizeCase(caseFixture('ACTIVE',{status:'doing',archived:false})));c.CASES.push(active);await c.openDrawerById('ACTIVE');assert.equal(requests.length,0);assert.equal(shown[0],active);
});
await test('fresh option fetches current active data without advancing an existing editor object',async()=>{
  const {c,shown,requests}=openerContext(async id=>caseFixture(id,{status:'doing',archived:false,contentVersion:9,updatedAt:'2026-10-22T01:01:00.000Z'}));const captured=c.decorateCase(c.normalizeCase(caseFixture('ACTIVE',{status:'doing',archived:false})));c.CASES.push(captured);await c.openDrawerById('ACTIVE',{fresh:true});assert.deepEqual(requests,['ACTIVE']);assert.equal(shown[0]._contentVersion,9);assert.equal(captured._contentVersion,8,'an old editor keeps its conservative revision');
});
await test('archived fetch can still open after its internal close and stays outside active cases',async()=>{
  const {c,shown}=openerContext(async id=>caseFixture(id));await c.openDrawerById('ARCHIVED');assert.equal(shown.length,1);assert.equal(shown[0].id,'ARCHIVED');assert(shown[0].reviewDate instanceof Date);assert(shown[0].proofStart instanceof Date);assert.equal(c.CASES.length,0);
});
for(const fail of [false,true])await test('explicit close invalidates a pending central opener '+(fail?'failure':'success'),async()=>{
  const pending=deferred(),{c,d,shown,messages}=openerContext(()=>pending.promise);const open=c.openDrawerById('ARCHIVED');d.get('drawer-close').click();if(fail)pending.reject({status:404});else pending.resolve(caseFixture());await open;assert.equal(shown.length,0);assert.equal(messages.length,0);assert.equal(d.get('drawer').classList.contains('open'),false);
});
for(const fail of [false,true])await test('navigation away and back invalidates a pending opener '+(fail?'failure':'success'),async()=>{
  const pending=deferred(),{c,shown,messages}=openerContext(()=>pending.promise);const open=c.openDrawerById('ARCHIVED');c.switchView('dashboard');c.switchView('personal');if(fail)pending.reject(Error('old unavailable'));else pending.resolve(caseFixture());await open;assert.equal(shown.length,0);assert.equal(messages.length,0);
});
await test('late old request cannot replace or report an error over the latest successful drawer',async()=>{
  for(const fail of [false,true]){const old=deferred(),{c,shown,messages}=openerContext(id=>id==='OLD'?old.promise:Promise.resolve(caseFixture(id)));const pending=c.openDrawerById('OLD');await c.openDrawerById('NEW');if(fail)old.reject({status:404});else old.resolve(caseFixture('OLD'));await pending;assert.deepEqual(shown.map(r=>r.id),['NEW']);assert.equal(messages.length,0);}
});

function installFetch(c,handler){c.fetch=handler;vm.runInContext(section('const JSON_HEADERS =','window.api ='),c);}
const jsonResponse=(status,body)=>({ok:status>=200&&status<300,status,text:async()=>JSON.stringify(body)});
function seedCaseCaches(c){
  const active={id:'ACTIVE',_contentVersion:8,_updatedAt:'2026-10-22T01:00:00.000Z',items:[{n:'Captured editor data',owner:'Designer'}]};
  c.CASES=[active];c.currentCase=active;c.V59_HISTORY=[{id:'history-old'}];c.v69AllCases=[{id:'requester-old'}];c.v81AllCases=[{id:'hotel-old'}];c.v81AllCasesAt=123;
  vm.runInContext(section('function v81Invalidate()','function v81InScope'),c);return active;
}
function assertInvalidated(c){assert.equal(c.V59_HISTORY,null,'history cache invalidated');assert.equal(c.v69AllCases,null,'requester cache invalidated');assert.equal(c.v81AllCases,null,'hotel cache invalidated');assert.equal(c.v81AllCasesAt,0);}
for(const [method,url,body]of [['PATCH','/api/cases/ACTIVE/items',{items:[]}],['PATCH','/api/staff/1',{name:'Renamed designer'}],['POST','/api/staff/1/departure',{successors:{}}]])await test('confirmed '+method+' '+url+' invalidates all shared case snapshots',async()=>{
  const {c,clock}=browser(),active=seedCaseCaches(c);installFetch(c,async()=>jsonResponse(200,{id:'ACTIVE',contentVersion:9,updatedAt:'2026-10-22T01:01:00.000Z'}));await c.fetchJson(method,url,body);await flush();await clock.advance(0);assertInvalidated(c);assert.equal(c.CASES[0],active,'invalidation does not replace the canonical active list with history');
});
await test('failed writes and ordinary reads/auth/notification changes leave case caches intact',async()=>{
  for(const [method,url,body,mode]of [['GET','/api/cases?includeArchived=1',undefined,'ok'],['PATCH','/api/cases/ACTIVE',{title:'Rejected'},'error'],['POST','/api/cases/ACTIVE/cancel',{reason:'Other'},'network'],['POST','/api/auth/change-password',{},'ok'],['POST','/api/notifications/read-all',{},'ok']]){
    const {c,clock}=browser();seedCaseCaches(c);const history=c.V59_HISTORY,requester=c.v69AllCases,hotel=c.v81AllCases;
    installFetch(c,async()=>{if(mode==='network')throw Error('synthetic network');return jsonResponse(mode==='error'?409:200,mode==='error'?{error:'conflict'}:{});});
    try{await c.fetchJson(method,url,body);}catch(e){assert.notEqual(mode,'ok');}await clock.advance(0);assert.equal(c.V59_HISTORY,history);assert.equal(c.v69AllCases,requester);assert.equal(c.v81AllCases,hotel);assert.equal(c.v81AllCasesAt,123);
  }
});
await test('case invalidation never advances or overwrites the data captured by an existing editor',async()=>{
  const {c,clock}=browser(),captured=seedCaseCaches(c),before=plain(captured);installFetch(c,async()=>jsonResponse(200,{id:'ACTIVE',contentVersion:9,updatedAt:'2026-10-22T01:01:00.000Z',items:[{n:'Someone else changed this'}]}));
  const raw=await c.fetchJson('PATCH','/api/cases/ACTIVE/items',{items:[],expectedContentVersion:8});await clock.advance(0);assert.equal(raw.contentVersion,9);assert.deepEqual(plain(captured),before,'the open editor may safely conflict and require reopen');
});
for(const kind of ['history','requester'])for(const oldFailure of [false,true])await test(kind+' loader cannot repopulate an invalidated epoch after newer '+(oldFailure?'success then old failure':'success'),async()=>{
  const old=deferred(),latest=deferred();let reads=0;const {c,clock}=browser({api:{cases:{listArchived:()=>++reads===1?old.promise:latest.promise}}});seedCaseCaches(c);
  c.V59_HISTORY=null;c.v69AllCases=null;c.currentView=kind==='history'?'history':'requester';
  vm.runInContext(kind==='history'?section('async function v59LoadHistory()','function renderHistory()'):section('async function v69LoadAll()','function v69InRange'),c);
  installFetch(c,async()=>jsonResponse(200,{}));const load=()=>kind==='history'?c.v59LoadHistory():c.v69LoadAll();const first=load().catch(()=>{});await c.fetchJson('PATCH','/api/cases/ACTIVE',{title:'Changed'});await clock.advance(0);const second=load();latest.resolve([caseFixture('LATEST',{title:'Latest committed project'})]);await second;
  if(oldFailure)old.reject(Error('obsolete loader error'));else old.resolve([caseFixture('OLD',{title:'Old project'})]);await first;const cached=kind==='history'?c.V59_HISTORY:c.v69AllCases;assert(cached);assert.deepEqual(plain(cached.map(r=>r.id)),['LATEST']);
});
await test('hotel loader cannot overwrite the newer view or cache after invalidation',async()=>{
  const old=deferred(),latest=deferred();let reads=0;const {c,d,clock}=browser({HOTELS:[{name:'North',region:'North',active:true,sortOrder:1}],v80Icon:()=>'',api:{cases:{listArchived:()=>++reads===1?old.promise:latest.promise}}});
  vm.runInContext(section('const V81_LEVELS =',"NAV_DEF.admin.push({ key: 'hotels'"),c);vm.runInContext("v81Scope='all';v81OpenHotels.add('North')",c);c.currentView='hotels';
  installFetch(c,async(url,opts)=>jsonResponse(200,opts.method==='GET'?[]:{}));const first=c.renderHotelOverview();await flush();await c.fetchJson('PATCH','/api/cases/ACTIVE',{title:'Changed'});await clock.advance(0);const second=c.renderHotelOverview();await flush();latest.resolve([caseFixture('LATEST',{title:'Latest hotel project'})]);await second;old.resolve([caseFixture('OLD',{title:'Old hotel project'})]);await first;
  assert(d.get('v81-body').textContent.includes('Latest hotel project'));assert(!d.get('v81-body').textContent.includes('Old hotel project'));assert.deepEqual(plain(vm.runInContext('v81AllCases.map(r=>r.id)',c)),['LATEST']);
});
await test('a successful case mutation refreshes only the current added read view once',async()=>{
  const calls=[];const {c,clock}=browser({currentView:'history',renderHistory:()=>calls.push('history'),renderRequesterAnalytics:()=>calls.push('requester'),renderHotelOverview:()=>calls.push('hotels'),renderAnalytics:()=>calls.push('analytics'),renderApproval:()=>calls.push('approval'),renderCalendar:()=>calls.push('calendar')});seedCaseCaches(c);
  vm.runInContext(section('function refreshAll()','// ============== Email templates'),c);installFetch(c,async()=>jsonResponse(200,{}));await c.fetchJson('PATCH','/api/cases/ACTIVE',{title:'Changed'});await flush();await clock.advance(100);assert.deepEqual(calls,['history']);
});

function epochWorkbenchContext(){
  const reads=[];const task=kind=>{const d=deferred();reads.push({kind,...d});return d.promise;};
  const env=browser({api:{cases:{listArchived:()=>task('all')},analytics:{get:()=>task('analytics')}}});const {c,d}=env;
  const analytics=d.seed('analytics','div',d.get('main'));analytics.className='view';analytics.dataset.view='analytics';c.v33EnsureAnalyticsView=()=>{};c.openDrawerById=async()=>{};
  // Load the actual coordinator with the actual adapter before extension hooks
  // register their invalidation and visible-view callbacks.
  installFetch(c,async()=>jsonResponse(200,{}));vm.runInContext(extension,c);return {...env,reads};
}
for(const kind of ['all','analytics'])for(const fail of [false,true])await test('workbench '+kind+' ignores pre-invalidation '+(fail?'errors':'rows')+' before its scheduled current-epoch reload',async()=>{
  const {c,d,clock,reads}=epochWorkbenchContext();let initial;if(kind==='all')c.switchView('cases-all');else{c.currentView='analytics';initial=c.renderAnalytics();}assert.equal(reads.length,1);
  await c.fetchJson('PATCH','/api/cases/ACTIVE',{title:'Changed'});
  if(fail)reads[0].reject(Error('Obsolete epoch failure'));else reads[0].resolve(kind==='all'?[caseFixture('OLD',{title:'Obsolete epoch title'})]:analyticsData([caseFixture('OLD',{title:'Obsolete epoch title'})]));if(initial)await initial;await flush();
  const selector=kind==='all'?'[data-ledger]':'[data-analytics-content]';assert(!d.document.querySelector(selector).textContent.includes('Obsolete epoch'),'invalidated response cannot paint while replacement is still pending');
  await clock.advance(100);assert.equal(reads.length,2,'the visible ledger reloads once for the new epoch');reads[1].resolve(kind==='all'?[caseFixture('LATEST',{title:'Latest epoch title'})]:analyticsData([caseFixture('LATEST',{title:'Latest epoch title'})]));await flush();assert(d.document.querySelector(selector).textContent.includes('Latest epoch title'));
});
await test('case invalidation preserves filters, clamps a removed last page, and coalesces visible reloads',async()=>{
  const {c,d,clock,reads}=epochWorkbenchContext();c.switchView('cases-all');reads[0].resolve(rows(131));await flush();let ledger=d.document.querySelector('[data-ledger]');change(ledger,'hotel','South');await page(ledger,'next');assert(ids(ledger).some(id=>id==='CASE-00101'));
  await c.fetchJson('PATCH','/api/cases/ACTIVE',{title:'Changed once'});await c.fetchJson('PATCH','/api/cases/ACTIVE',{title:'Changed twice'});await clock.advance(100);assert.equal(reads.length,2,'same-turn writes share one visible reload');const latest=rows(21);reads[1].resolve(latest);await flush();ledger=d.document.querySelector('[data-ledger]');assert.equal(ledger.querySelector('[data-filter="hotel"]').value,'South');assert.deepEqual(ids(ledger),latest.filter(r=>r.hotel==='South').map(r=>r.id));assert(!pageButton(ledger,'prev')||pageButton(ledger,'prev').disabled);
});
await test('pager keyboard arrows change pages while row keyboard arrows leave the page untouched',async()=>{
  const {openAll}=ledgerContext(rows(131)),ledger=await openAll(),next=pageButton(ledger,'next');assert(next,'keyboard paging control exists');next.dispatchEvent({type:'keydown',key:'ArrowRight'});assert.equal(ids(ledger)[0],'CASE-00050');const before=ids(ledger);ledger.querySelector('[data-case]').dispatchEvent({type:'keydown',key:'ArrowRight'});assert.deepEqual(ids(ledger),before);
});

console.log(JSON.stringify({passed,failed,sourceRoot:root,liveNetwork:false,productionWrites:0,syntheticPayloadExecuted:false}));
if(failed)process.exitCode=1;
