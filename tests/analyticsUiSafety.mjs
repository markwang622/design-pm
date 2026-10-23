import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

// Actual shipped closure and analytics functions run with inert DOM/API doubles.
// The scaffold models native input, select, disabled buttons and bubbling.
// No network, database, mail, clipboard, password or production writes occur.
// Browser viewport geometry is verified separately, not inferred by this DOM.
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

const rawCase=(extra={})=>({id:'CLOSURE-1',title:'Quarterly report',hotel:'North',requester:'Marketing',designer:{id:1,name:'Designer'},collaborators:[],status:'closed',level:'C',openDate:'2026-10-01',dispatchDate:'2026-10-02',goLiveDate:'2026-10-30',closedOn:'2026-10-23',archivePath:'/shared/delivered',logs:[],items:[],requestCount:2,outputCount:4,updatedAt:'2026-10-23T02:00:00.000Z',contentVersion:3,...extra});
function closureEnv(extra={}){
  const writes=[],opened=[],previews=[];
  const env=browser({api:{cases:{update:async(id,body)=>{writes.push({id,body:plain(body)});return rawCase(body);}}},...extra});
  const {c,d}=env;c.VACATIONS=[];c.TRIPS=[];
  for(const id of ['d-id','d-chips','d-head-due','d-head-extra','d-title','d-sub','d-collab-bar','d-grid','d-timeline-box','d-subitems','d-archive','d-closure','d-timeline','d-status','d-now-status','d-now-next','d-gate','d-log-submit','d-urgent-toggle','d-reassign','drawer','drawer-bg'])d.seed(id);
  c.exportDetail=()=>{};c.openReassign=()=>{};c.refreshAll=()=>{};c.showEmail=kind=>previews.push(kind);c.saveClosure=()=>{};
  vm.runInContext(section('function openDrawer(c)','function saveClosure(c)'),c);
  const actualDrawer=c.openDrawer;
  const draw=raw=>{const row=c.decorateCase(c.normalizeCase(raw));actualDrawer(row);return row;};
  const seedInputs=(requested='2',output='4')=>{for(const [id,value]of [['d-req-count',requested],['d-out-count',output]]){let n=d.get(id);if(!n)n=d.seed(id,'input');n.value=value;}if(!d.get('d-closure-save'))d.seed('d-closure-save','button');};
  vm.runInContext(section('// Wrap saveClosure','// Intercept the inline status-change handler'),c);
  c.openDrawer=row=>{opened.push(row);actualDrawer(row);};
  return {...env,writes,opened,previews,draw,seedInputs};
}
let passed=0,failed=0;
async function test(name,fn){if(process.env.ANALYTICS_UI_TEST_FILTER&&!name.includes(process.env.ANALYTICS_UI_TEST_FILTER))return;try{await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}}

for(const status of ['done','closed'])await test('closure editor is reachable for '+status+' and displays stored zero counts',()=>{
  const {d,draw}=closureEnv();draw(rawCase({status,requestCount:0,outputCount:0}));
  assert(d.get('d-req-count'),'request count input exists for delivered case');assert(d.get('d-out-count'),'output count input exists');
  assert.equal(d.get('d-req-count').value,'0');assert.equal(d.get('d-out-count').value,'0');
  assert.equal(d.get('d-closure').querySelectorAll('.cb-value').filter(n=>n.textContent.trim()==='0').length,2,'zero is an explicit measured value');
});
for(const status of ['review_done','cancelled','doing'])await test('non-delivered '+status+' has no closure count editor',()=>{
  const {d,draw}=closureEnv();draw(rawCase({status}));assert.equal(d.get('d-req-count'),null);assert.equal(d.get('d-out-count'),null);
});
await test('saving zero counts persists the exact integer payload and survives a fresh normalize',async()=>{
  let stored=rawCase();const calls=[];
  const {c,seedInputs}=closureEnv({api:{cases:{update:async(id,body)=>{calls.push({id,body:plain(body)});stored={...stored,...body};return structuredClone(stored);},getOne:async()=>structuredClone(stored)}}});
  const row=c.decorateCase(c.normalizeCase(stored));seedInputs('0','0');await c.saveClosure(row);
  assert.equal(calls.length,1);assert.equal(calls[0].body.requestCount,0);assert.equal(calls[0].body.outputCount,0);
  const fresh=c.normalizeCase(await c.api.cases.getOne(row.id));assert.equal(fresh.requestCount,0);assert.equal(fresh.outputCount,0);
});
for(const [requested,output]of [['-1','4'],['2','-1'],['1.5','4'],['2','4.5'],['1x','4'],['2','4x'],['1000001','4'],['2','1000001'],['9007199254740992','4']])await test('invalid closure counts '+JSON.stringify([requested,output])+' do not write or mutate existing data',async()=>{
  const {c,writes,messages,seedInputs}=closureEnv();const row=c.decorateCase(c.normalizeCase(rawCase()));const before=plain(row);seedInputs(requested,output);await c.saveClosure(row);
  assert.equal(writes.length,0,'full nonnegative safe-integer validation precedes API');assert.deepEqual(plain(row),before);assert(messages.some(m=>m.type==='err'),'validation is visible');
});
await test('failed closure save keeps draft inputs and old persisted case numbers',async()=>{
  const {c,d,messages,opened,previews,seedInputs}=closureEnv({api:{cases:{update:async()=>{throw {message:'Synthetic conflict',data:{message:'Please reopen this changed case'}};}}}});
  const row=c.decorateCase(c.normalizeCase(rawCase()));seedInputs('8','13');await c.saveClosure(row);
  assert.equal(row.requestCount,2);assert.equal(row.outputCount,4);assert.equal(d.get('d-req-count').value,'8');assert.equal(d.get('d-out-count').value,'13');assert.equal(opened.length,0);assert.equal(previews.length,0);assert(messages.some(m=>m.type==='err'));
});
await test('double closure submit uses one in-flight write and unlocks after completion',async()=>{
  const pending=deferred(),calls=[];const {c,d,seedInputs}=closureEnv({api:{cases:{update:(id,body)=>{calls.push({id,body:plain(body)});return pending.promise;}}}});
  const row=c.decorateCase(c.normalizeCase(rawCase()));seedInputs('8','13');const first=c.saveClosure(row),second=c.saveClosure(row);await flush();assert.equal(calls.length,1);assert.equal(d.get('d-closure-save').disabled,true);
  pending.resolve(rawCase({requestCount:8,outputCount:13}));await Promise.all([first,second]);assert.equal(d.get('d-closure-save').disabled,false);
});


const person=(id,name)=>({id,name,role:'member',active:true,seniority:'mid'});
const completedCase=(id,extra={})=>({id,title:id,designerId:1,designerName:'Same name',collaboratorIds:[],collaboratorNames:[],hotel:'North',level:'C',urgent:false,closedOn:'2026-10-23',goLiveDate:'2026-10-30',requestCount:2,outputCount:4,score:1.2,...extra});
const reportData=(extra={})=>({period:{label:'2026-10',start:'2026-10-01',end:'2026-11-01'},cases:[],perStaff:[],totals:{count:0,score:0,onTimeRate:null},workCases:[],...extra});
function analyticsEnv(handler,staff=[],extra={}){
  const reads=[],writes=[];const env=browser({STAFF:staff,api:{analytics:{get:async q=>{reads.push(plain(q));return handler(q);}},cases:{listArchived:async()=>{throw Error('Completed report must use authoritative analytics cases');},update:async(...args)=>{writes.push(args);throw Error('Read-only charts cannot mutate cases');}}},...extra});
  const {c,d}=env;const view=d.seed('analytics','div',d.get('main'));view.className='view active';view.dataset.view='analytics';
  c.currentView='analytics';c.v33EnsureAnalyticsView=()=>{};c.openDrawerById=()=>{};
  vm.runInContext(extension,c);return {...env,reads,writes,view};
}
await test('completed personal report distinguishes same-name people by stable participation IDs',async()=>{
  const staff=[person(1,'Same name'),person(2,'Same name')];
  const cases=[completedCase('Owned by selected person'),completedCase('Owned by other same-name person',{designerId:2,collaboratorIds:[],collaboratorNames:[]}),completedCase('Selected person collaborated',{designerId:2,collaboratorIds:[1],collaboratorNames:['Same name']}),completedCase('Different person collaborated',{designerId:3,designerName:'Third',collaboratorIds:[2],collaboratorNames:['Same name']})];
  const {c,d,view}=analyticsEnv(()=>reportData({cases,totals:{count:4,score:4.8,onTimeRate:1}}),staff);
  await c.renderAnalytics();const select=d.get('v37-staff-select');assert(select,'person selector remains available');select.value='1';select.dispatchEvent({type:'change'});await flush();
  const list=view.querySelector('.wb-completed');assert(list,'completed case drilldown remains visible');assert(list.textContent.includes('Owned by selected person'));assert(list.textContent.includes('Selected person collaborated'));assert(!list.textContent.includes('Owned by other same-name person'));assert(!list.textContent.includes('Different person collaborated'),'name equality must not grant participation');
});
await test('changing period uses the API natural period and resets the relative offset',async()=>{
  const {c,reads,view}=analyticsEnv(()=>reportData());c.v33Offset=-2;await c.renderAnalytics();assert.equal(reads.at(-1).offset,-2);
  const quarter=view.querySelector('[data-period="quarter"]');assert(quarter,'quarter is a selectable natural interval');quarter.click();await flush();assert.deepEqual(reads.at(-1),{period:'quarter',offset:0});
});
await test('stale analytics failure cannot overwrite a newer completed report',async()=>{
  const old=deferred();let n=0;const {c,view}=analyticsEnv(()=>++n===1?old.promise:reportData({cases:[completedCase('Latest delivered case')],totals:{count:1,score:1.2,onTimeRate:1}}));
  const first=c.renderAnalytics();await c.renderAnalytics();old.reject(Error('Old failing request'));await first;
  assert(view.textContent.includes('Latest delivered case'));assert(!view.textContent.includes('Old failing request'));assert(!view.textContent.includes('分析載入失敗'));
});


// Empty means unknown/unchanged, while 0 is an explicit measurement.
for(const [requested,output,expected]of [['','7',{outputCount:7}],['5','',{requestCount:5}]])await test('blank closure input omits only that field: '+JSON.stringify([requested,output]),async()=>{
  let stored=rawCase({requestCount:null,outputCount:4});const calls=[];
  const {c,seedInputs}=closureEnv({api:{cases:{update:async(id,body)=>{calls.push(plain(body));stored={...stored,...body};return structuredClone(stored);}}}});
  const row=c.decorateCase(c.normalizeCase(stored));seedInputs(requested,output);await c.saveClosure(row);
  assert.deepEqual(calls,[expected]);assert.equal(stored.requestCount,expected.requestCount??null);assert.equal(stored.outputCount,expected.outputCount??4);assert.equal(row.requestCount,stored.requestCount);assert.equal(row.outputCount,stored.outputCount);
});
await test('two blank closure inputs make no no-op request and provide readable feedback',async()=>{
  const {c,writes,messages,seedInputs}=closureEnv();const row=c.normalizeCase(rawCase());seedInputs('  ','');await c.saveClosure(row);assert.equal(writes.length,0);assert(messages.some(m=>typeof m.message==='string'&&m.message.trim()),'a visible explanation is required');assert.equal(row.requestCount,2);assert.equal(row.outputCount,4);
});
await test('closure summary keeps missing distinct from explicitly measured zero',()=>{
  const {d,draw}=closureEnv();draw(rawCase({requestCount:null,outputCount:0}));assert(d.get('d-req-count')&&d.get('d-out-count'),'delivered case exposes persisted count inputs');assert.equal(d.get('d-req-count').value,'');assert.equal(d.get('d-out-count').value,'0');const values=d.get('d-closure').querySelectorAll('.cb-value').map(n=>n.textContent.trim());assert(values.includes('—'));assert(values.includes('0'));
});
for(const role of ['observer','member'])await test('server-forbidden '+role+' closure save cannot change counts or claim success',async()=>{
  const {c,d,messages,previews,seedInputs}=closureEnv({ME:{id:88,name:'Read only',role},api:{cases:{update:async()=>{throw {status:403,message:'Forbidden',data:{message:'只有主責、協作者或管理員可修改'}};}}}});
  const row=c.normalizeCase(rawCase());seedInputs('8','13');await c.saveClosure(row);assert.equal(row.requestCount,2);assert.equal(row.outputCount,4);assert.equal(d.get('d-req-count').value,'8');assert.equal(d.get('d-out-count').value,'13');assert.equal(previews.length,0);assert(messages.some(m=>m.type==='err'&&m.message.includes('只有主責')));assert(!messages.some(m=>m.type!=='err'&&/已儲存|已寄/.test(m.message)));
});
await test('successful count save updates the active cached case without sending email',async()=>{
  const {c,previews,messages,seedInputs}=closureEnv();const row=c.normalizeCase(rawCase());const cached=c.normalizeCase(rawCase());c.CASES=[cached];seedInputs('8','13');await c.saveClosure(row);assert.equal(cached.requestCount,8);assert.equal(cached.outputCount,13);assert.equal(previews.length,0);assert(!messages.some(m=>/已寄|已通知/.test(m.message)));
});

function reportFixture(){
  const staff=[person(1,'Owner'),person(2,'Collaborator'),person(3,'Former')];staff[2].active=false;
  const a=completedCase('DELIVERED-A',{designerName:'Owner',collaboratorIds:[2],collaboratorNames:['Collaborator'],hotel:'North',dispatchDate:'2026-10-02'});
  const b=completedCase('DELIVERED-B',{designerId:2,designerName:'Collaborator',collaboratorIds:[1],collaboratorNames:['Owner'],hotel:'South',dispatchDate:'2026-10-04'});
  const odd=completedCase('DELIVERED-ODD-DATE',{designerId:3,designerName:'Former',hotel:null,dispatchDate:'2026-11-10'});
  const asWork=x=>({id:x.id,title:x.title,hotel:x.hotel,requester:'Marketing',level:'C',status:'closed',designer:{id:x.designerId,name:x.designerName},collaborators:x.collaboratorIds.map((id,i)=>({id,name:x.collaboratorNames[i]})),openDate:'2026-10-01',dispatchDate:x.dispatchDate,goLiveDate:x.goLiveDate,closedOn:x.closedOn,archived:true});
  const work=[asWork(a),asWork(b),asWork(completedCase('ACTIVE',{designerName:'Owner',hotel:'North',dispatchDate:'2026-09-02',closedOn:null})),asWork(completedCase('CANCELLED',{designerId:2,designerName:'Collaborator',hotel:'North',dispatchDate:'2026-09-02',closedOn:null})),asWork(completedCase('LATER',{designerId:2,designerName:'Collaborator',hotel:'South',dispatchDate:'2026-09-02',closedOn:'2026-11-03'})),asWork(completedCase('MISSING-END',{designerId:2,designerName:'Collaborator',hotel:'South',dispatchDate:'2026-09-02',closedOn:null})),asWork(completedCase('NOT-IN-COMPLETION-COHORT',{designerName:'Owner',hotel:'North',dispatchDate:'2026-10-01'}))];
  Object.assign(work[2],{status:'doing',archived:false});Object.assign(work[3],{status:'cancelled',cancelledOn:'2026-10-10'});work[5].endDateMissing=true;
  return {staff,a,b,odd,data:reportData({cases:[a,b,odd],workCases:work,totals:{count:3,score:3.6,onTimeRate:1}})};
}
function chart(view,kind){const n=view.querySelector('[data-chart="'+kind+'"]');assert(n,kind+' chart exists in the actual renderer');return n;}
const ledger=view=>view.querySelector('[data-work-ledger]');
const shownIds=view=>ledger(view).querySelectorAll('[data-case]').map(n=>n.dataset.case);
function drill(view,kind,fields){const buttons=chart(view,kind).querySelectorAll('[data-drill]');const button=buttons.find(b=>Object.entries(fields).every(([k,v])=>String(b.dataset['drill'+k[0].toUpperCase()+k.slice(1)]||'')===String(v)));assert(button,'accessible '+kind+' drill button '+JSON.stringify(fields));return button;}
const visibleCount=view=>Number(ledger(view).querySelector('[data-count]').textContent.match(/^顯示 (\d+)/)?.[1]);
const field=(view,key)=>ledger(view).querySelector('[data-filter="'+key+'"]');
function changeField(view,key,value,type='change'){const n=field(view,key);assert(n,key+' filter exists');n.value=value;n.dispatchEvent({type});return n;}
await test('authoritative completion cases include a date-anomaly case missing from workCases',async()=>{
  const f=reportFixture(),{c,view}=analyticsEnv(()=>f.data,f.staff);await c.renderAnalytics();const people=chart(view,'people');assert(people.textContent.includes('共 3 件'));assert(shownIds(view).includes(f.odd.id));assert.equal(visibleCount(view),8);assert.equal(shownIds(view).filter(id=>id===f.a.id).length,1,'overlap between completion and work cohorts stays one row');
  drill(view,'people',{staff:'3',phase:'done',role:''}).click();assert.deepEqual(shownIds(view),[f.odd.id]);assert.equal(field(view,'phase').value,'done');
});
await test('person bars keep department unique cases separate from primary and collaborator participation',async()=>{
  const f=reportFixture(),{c,view}=analyticsEnv(()=>f.data,f.staff);await c.renderAnalytics();const people=chart(view,'people');assert(people.querySelector('figcaption').textContent.includes('共 3 件'));assert.equal(people.querySelectorAll('.wb-bar-row').length,3);
  for(const id of ['1','2']){assert.equal(drill(view,'people',{staff:id,role:'primary',phase:'done'}).textContent.trim(),'主責 1');assert.equal(drill(view,'people',{staff:id,role:'collab',phase:'done'}).textContent.trim(),'協作 1');}
  assert.equal(drill(view,'people',{staff:'3',role:'primary',phase:'done'}).textContent.trim(),'主責 1');
});
await test('cancelled, future completion and work-only closed records are excluded from completed person bars',async()=>{
  const f=reportFixture(),{c,view}=analyticsEnv(()=>f.data,f.staff);await c.renderAnalytics();drill(view,'people',{staff:'2',phase:'done',role:''}).click();assert.deepEqual(shownIds(view).sort(),[f.a.id,f.b.id].sort());assert.equal(visibleCount(view),2);
});
await test('every chart count drills into exactly the advertised cohort and number of unique cases',async()=>{
  const f=reportFixture(),{c,view,reads,writes}=analyticsEnv(()=>f.data,f.staff);await c.renderAnalytics();
  const buttons=view.querySelectorAll('[data-charts] [data-drill]');assert(buttons.length>10,'real person and hotel controls are present');
  for(const button of buttons){const expected=Number([...button.getAttribute('aria-label').matchAll(/(\d+) 件/g)].at(-1)?.[1]);assert(Number.isFinite(expected),'each drill exposes its count');button.click();assert.equal(visibleCount(view),expected,button.getAttribute('aria-label'));assert.equal(new Set(shownIds(view)).size,expected);assert.equal(button.getAttribute('aria-pressed'),'true');}
  assert.equal(reads.length,1,'drilling uses the same fetched cohort');assert.equal(writes.length,0,'chart interactions are read-only');
});
await test('chart drilling resets conflicting text/date filters and preserves sorting',async()=>{
  const f=reportFixture(),{c,clock,view}=analyticsEnv(()=>f.data,f.staff);await c.renderAnalytics();changeField(view,'q','does not exist','input');await clock.advance(180);changeField(view,'from','2026-12-01');changeField(view,'sort','closedOn');changeField(view,'direction','desc');assert.equal(visibleCount(view),0);
  drill(view,'people',{staff:'1',role:'collab',phase:'done'}).click();assert.deepEqual(shownIds(view),[f.b.id]);assert.equal(field(view,'q').value,'');assert.equal(field(view,'from').value,'');assert.equal(field(view,'sort').value,'closedOn');assert.equal(field(view,'direction').value,'desc');
});
await test('hotel chart follows configured ordering and keeps missing hotel as a drillable last group',async()=>{
  const f=reportFixture(),order=['South','North'],{c,view}=analyticsEnv(()=>f.data,f.staff,{hotelOrderCompare:(a,b)=>order.indexOf(a)-order.indexOf(b)});await c.renderAnalytics();const hotels=chart(view,'hotels');const names=hotels.querySelectorAll('.wb-drill-name').map(n=>n.textContent.trim());assert.deepEqual(names,['South','North','未指定館別']);assert(hotels.querySelector('figcaption').textContent.includes('8 件'));
  const missing=hotels.querySelectorAll('.wb-drill-name').find(n=>n.textContent==='未指定館別');missing.click();assert.deepEqual(shownIds(view),[f.odd.id]);assert.equal(field(view,'hotel').querySelectorAll('option').find(o=>o.value===field(view,'hotel').value)?.textContent,'未指定館別');
});
await test('hotel phases separately drill cancellation, ongoing, later completion and missing end dates',async()=>{
  const f=reportFixture(),{c,view}=analyticsEnv(()=>f.data,f.staff);await c.renderAnalytics();
  for(const [hotel,phase,expected]of [['North','cancelled',['CANCELLED']],['North','active',['ACTIVE']],['South','later',['LATER']],['South','missing',['MISSING-END']],['North','done',[f.a.id]]]){drill(view,'hotels',{hotel,phase}).click();assert.deepEqual(shownIds(view),expected);assert.equal(visibleCount(view),1);}
});
await test('same-name people remain separate in both person bars and chart drilldowns',async()=>{
  const staff=[person(1,'Same name'),person(2,'Same name')],cases=[completedCase('OWNER-ONE',{designerId:1,collaboratorIds:[2],collaboratorNames:['Same name']}),completedCase('ONLY-OTHER-COLLABORATED',{designerId:3,designerName:'Third',collaboratorIds:[2],collaboratorNames:['Same name']})];
  const {c,d,view}=analyticsEnv(()=>reportData({cases,totals:{count:2,score:2.4,onTimeRate:1}}),staff);await c.renderAnalytics();assert(chart(view,'people').querySelectorAll('.wb-drill-name').some(n=>n.dataset.drillStaff==='1'));drill(view,'people',{staff:'1',phase:'done',role:''}).click();assert.deepEqual(shownIds(view),['OWNER-ONE']);
  d.get('v37-staff-select').value='1';d.get('v37-staff-select').dispatchEvent({type:'change'});await flush();assert.deepEqual(chart(view,'people').querySelectorAll('.wb-drill-name').map(n=>n.dataset.drillStaff),['1']);assert(!view.querySelector('.wb-completed').textContent.includes('ONLY-OTHER-COLLABORATED'));
});
await test('empty report has readable chart states and no invented zero bars or NaN widths',async()=>{
  const {c,view}=analyticsEnv(()=>reportData());await c.renderAnalytics();for(const kind of ['people','hotels']){const fig=chart(view,kind);assert.equal(fig.querySelectorAll('[data-drill]').length,0);assert(fig.textContent.includes('沒有'));}assert.equal(visibleCount(view),0);assert(!view.innerHTML.includes('NaN'));assert(!view.innerHTML.includes('Infinity'));
});
await test('chart labels, attributes and long names remain inert literal text',async()=>{
  const name='設計師'.repeat(60)+' \'"><img data-ui-probe="person" onerror="neverRunAnalyticsProbe()"> &',hotel='館別'.repeat(60)+' \'"><img data-ui-probe="hotel"> &',title='案件 \'"><img data-ui-probe="title"> &';
  const staff=[person(1,name)],cases=[completedCase('QUOTED',{title,designerName:name,hotel})];const {c,d,view}=analyticsEnv(()=>reportData({cases,totals:{count:1,score:1.2,onTimeRate:1}}),staff);await c.renderAnalytics();assert.equal(d.document.querySelectorAll('[data-ui-probe]').length,0,'HTML strings never create attacker elements');assert(chart(view,'people').textContent.includes(name));assert(chart(view,'hotels').textContent.includes(hotel));assert(view.querySelector('.wb-completed').textContent.includes(title));drill(view,'hotels',{hotel,phase:'done'}).click();assert.deepEqual(shownIds(view),['QUOTED']);assert.equal(field(view,'hotel').value,hotel);
});
for(const staleError of [false,true])await test('rapid period changes keep only latest chart data after old '+(staleError?'failure':'success'),async()=>{
  const pending=new Map();const {c,view}=analyticsEnv(q=>{const d=deferred();pending.set(q.period,d);return d.promise;});const old=c.renderAnalytics();view.querySelector('[data-period="quarter"]').click();await flush();view.querySelector('[data-period="week"]').click();await flush();
  pending.get('week').resolve(reportData({period:{label:'LATEST WEEK',start:'2026-10-19',end:'2026-10-26'},cases:[completedCase('LATEST')],totals:{count:1,score:1.2,onTimeRate:1}}));await flush();pending.get('quarter').resolve(reportData({cases:[completedCase('OLD QUARTER')]}));if(staleError)pending.get('month').reject(Error('OLD FAILURE'));else pending.get('month').resolve(reportData({cases:[completedCase('OLD MONTH')]}));await old;await flush();assert.deepEqual(shownIds(view),['LATEST']);assert.equal(view.querySelector('[data-period-label]').textContent,'LATEST WEEK');assert(!view.textContent.includes('OLD'));
});
for(const staleError of [false,true])await test('an invalidated cache epoch cannot restore old charts after '+(staleError?'failure':'success'),async()=>{
  const old=deferred();let n=0;const {c,view}=analyticsEnv(()=>++n===1?old.promise:reportData({cases:[completedCase('NEW EPOCH')],totals:{count:1,score:1.2,onTimeRate:1}}),[],{v30CaseEpoch:0});const first=c.renderAnalytics();c.v30CaseEpoch=1;await c.renderAnalytics();if(staleError)old.reject(Error('STALE EPOCH'));else old.resolve(reportData({cases:[completedCase('STALE EPOCH')]}));await first;assert.deepEqual(shownIds(view),['NEW EPOCH']);assert(!view.textContent.includes('STALE EPOCH'));
});
await test('a detached old chart cannot apply its filters to a newly loaded report',async()=>{
  const f=reportFixture();let n=0;const {c,view}=analyticsEnv(()=>++n===1?f.data:reportData({cases:[completedCase('NEW REPORT')],totals:{count:1,score:1.2,onTimeRate:1}}),f.staff);await c.renderAnalytics();const old=drill(view,'people',{staff:'3',phase:'done',role:''});await c.renderAnalytics();old.click();assert.deepEqual(shownIds(view),['NEW REPORT']);assert.equal(field(view,'staff').value,'');
});


// Exercise the real post-render permission wrappers with controls nested inside
// the drawer, unlike the base-renderer fixtures above. Only isolated API doubles
// are called; historical state/status/archive/log controls must stay read-only.
function historicalClosureEnv(who){
  const env=closureEnv({ME:who,ME_NAME:()=>who.name});const {c,d}=env;
  // Native tag types matter: the real readonly sweeps select interactive tags.
  for(const [id,tag]of [['d-status','select'],['d-urgent-toggle','button'],['d-log-submit','button'],['d-reassign','button']]){d.get(id).remove();d.seed(id,tag);}
  const drawer=d.get('drawer');drawer.className='drawer';const body=d.seed('actual-drawer-body','div',drawer);body.className='drawer-body';const details=d.seed('d-more','details',body);
  for(const id of ['d-archive','d-closure'])details.appendChild(d.get(id));
  for(const id of ['d-status','d-urgent-toggle','d-log-submit','d-reassign'])body.appendChild(d.get(id));
  for(const id of ['drawer-close','d-back'])d.seed(id,'button',drawer);
  c.v37ReopenCase=()=>{};
  vm.runInContext(section('function v20SameId','// 任何人改名後'),c);
  vm.runInContext(section('function v36CanWriteCase(c)','// ─── 歷史案件 view'),c);
  vm.runInContext(section('// (#歷史) Drawer:','async function v37ReopenCase(c)'),c);
  return env;
}
const historicalViewers=[
  ['admin',{id:9,name:'Admin',role:'admin'},true],
  ['primary',{id:1,name:'Designer',role:'member'},true],
  ['collaborator',{id:2,name:'Collaborator',role:'member'},true],
  ['observer',{id:1,name:'Designer',role:'observer'},false],
  ['unrelated member',{id:88,name:'Unrelated',role:'member'},false],
  ['different ID with owner name',{id:88,name:'Designer',role:'member'},false],
];
for(const status of ['done','closed'])for(const [label,who,writable]of historicalViewers)await test('historical closure controls '+status+' for '+label+' preserve all other readonly controls',async()=>{
  const {c,d,writes}=historicalClosureEnv(who);const row=c.decorateCase(c.normalizeCase(rawCase({status,archived:true,collaborators:[{id:2,name:'Collaborator'}]})));
  await c.openDrawer(row);
  for(const id of ['d-req-count','d-out-count','d-closure-save']){const node=d.get(id);assert(node,id+' rendered through the wrapped opener');assert.equal(node.disabled,!writable,id+' write permission');if(writable){assert.equal(node.classList.contains('v37-historical-readonly'),false,id+' is exempt from historical readonly CSS');assert.equal(node.classList.contains('v36-readonly'),false,id+' is exempt from unauthorized CSS only when permitted');}}
  for(const id of ['d-status','d-archive-input','d-urgent-toggle','d-log-submit','d-reassign','d-closure-export']){const node=d.get(id);assert(node,id+' still exists');assert.equal(node.disabled,true,id+' historical behavior remains read-only');}
  d.get('d-req-count').value='7';d.get('d-out-count').value='9';await d.get('d-closure-save').click();await flush();assert.equal(writes.length,writable?1:0,'only an authorized native button click writes');if(writable)assert.deepEqual(writes[0].body,{requestCount:7,outputCount:9});
});

console.log(JSON.stringify({passed,failed,sourceRoot:root,liveNetwork:false,productionWrites:0,viewportMeasured:false}));
if(failed)process.exitCode=1;
