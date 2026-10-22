import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

// Execute real browser functions against inert DOM/API doubles. Synthetic HTML is
// parsed only to inspect attributes; event text is never compiled or executed.
const root=process.env.DESIGN_PM_ROOT || new URL('../',import.meta.url).pathname;
const source=fs.readFileSync(root+'/public/index.html','utf8');
const extension=fs.readFileSync(root+'/public/workbench-features.js','utf8');
const activation=fs.readFileSync(root+'/public/activate.html','utf8');
function section(start,end,text=source){
  const a=text.indexOf(start),b=text.indexOf(end,a+start.length);
  assert(a>=0&&b>a,'source section exists: '+start);
  return text.slice(a,b);
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
const decode=s=>String(s).replace(/&(?:amp|lt|gt|quot|apos|#39|#x27);/g,x=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'",'&#x27;':"'"}[x]));

function dom(){
  const all=[];
  function element(tag='div',id=''){
    const n={tagName:tag.toUpperCase(),id,style:{},dataset:{},attributes:{},children:[],parentNode:null,value:'',disabled:false,checked:false,_text:'',_html:'',events:{}};
    let classes=new Set();
    Object.defineProperty(n,'className',{get:()=>[...classes].join(' '),set:v=>classes=new Set(String(v).split(/\s+/).filter(Boolean))});
    n.classList={add(...xs){xs.forEach(x=>classes.add(x));},remove(...xs){xs.forEach(x=>classes.delete(x));},contains:x=>classes.has(x),toggle(x,v){v??=!classes.has(x);v?classes.add(x):classes.delete(x);}};
    n.setAttribute=(key,value)=>{value=String(value);n.attributes[key]=value;if(key==='id')n.id=value;else if(key==='class')n.className=value;else if(key==='value')n.value=value;else if(key==='disabled')n.disabled=true;else if(key.startsWith('data-'))n.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;};
    n.getAttribute=key=>key==='id'?n.id:key==='class'?n.className:n.attributes[key]??null;
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
      for(const m of n._html.matchAll(/<(\/?)([a-z][\w:-]*)([^>]*)>/gi)){
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
    n.click=()=>{if(n.disabled)return;const event={target:n,preventDefault(){},stopPropagation(){}};const returned=n.onclick?.(event);for(const fn of n.events.click||[])fn(event);return returned;};
    n.focus=()=>{};n.select=()=>{};n.scrollIntoView=()=>{};n.insertAdjacentElement=(_pos,child)=>n.parentNode?.appendChild(child);
    all.push(n);return n;
  }
  function matches(n,s){
    if(s==='*')return true;
    const tag=s.match(/^[a-z][\w-]*/i);if(tag&&n.tagName!==tag[0].toUpperCase())return false;
    const id=s.match(/#([\w-]+)/);if(id&&n.id!==id[1])return false;
    for(const m of s.matchAll(/\.([\w-]+)/g))if(!n.classList.contains(m[1]))return false;
    for(const m of s.matchAll(/\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g)){const v=n.getAttribute(m[1]);if(v===null)return false;const want=m[2]??m[3]??m[4];if(want!==undefined&&v!==want)return false;}
    if(s.includes(':checked')&&!n.checked)return false;
    return true;
  }
  const document={createElement:tag=>element(tag),getElementById:id=>all.find(n=>n.id===id&&n.isConnected)||null,execCommand(){throw Error('No real clipboard fallback permitted');}};
  document.body=element('body');document.head=element('head');
  document.querySelectorAll=s=>[...document.body.querySelectorAll(s),...document.head.querySelectorAll(s)];document.querySelector=s=>document.querySelectorAll(s)[0]||null;
  const seed=(id,tag='div',parent=document.body)=>parent.appendChild(element(tag,id));
  return{document,element,seed,get:id=>document.getElementById(id)};
}
function context(extra={}){
  const c={Date,console,Set,Map,Promise,URLSearchParams,crypto:webcrypto,setTimeout,clearTimeout,...extra};c.window=c;return vm.createContext(c);
}
const dates=section('function d(y, m, dd)', '// J1:');
const keys=section('function computeKeyDates(goLive)', '// ============== Staff');
const normalize=section('function normalizeCase(b)', 'function findStaffId');
const decorate=section('function decorateCase(c)', 'window.decorateCase');
const escape=section('function escapeHtml(s)', 'async function v33SaveEdit');
const oldStamp='2026-10-22T02:00:00.000Z',newStamp='2026-10-22T02:01:00.000Z',oldVersion=7,newVersion=8;
const fixture=(id='A',extra={})=>({id,title:'Fixture '+id,hotel:'Hotel',requester:'Marketing',designer:{id:1,name:'Designer'},collaborators:[],status:'doing',level:'C',openDate:'2026-10-01',dispatchDate:'2026-10-02',goLiveDate:'2026-10-30',logs:[],items:[],updatedAt:oldStamp,contentVersion:oldVersion,...extra});
function baseContext(d,extra={}){const c=context({document:d.document,STATUSES:[{key:'doing',name:'Designing'}],ENDED_STATUS_KEYS:new Set(['done','closed','cancelled']),v58ConflictsFor:()=>[],v80NextStep:()=>'',ME:{id:1,name:'Designer',role:'member'},ME_NAME:()=> 'Designer',currentRole:'designer',currentView:'personal',currentCase:null,...extra});vm.runInContext(dates+keys+normalize+decorate+escape,c);return c;}
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}}

await test('drawer renders user-controlled text and attribute values inertly without dropping the text',()=>{
  const d=dom();for(const id of ['d-id','d-chips','d-head-due','d-head-extra','d-title','d-sub','d-collab-bar','d-grid','d-timeline-box','d-subitems','d-archive','d-closure','d-timeline','d-status','d-now-status','d-now-next','d-gate','d-log-submit','d-urgent-toggle','d-reassign','drawer','drawer-bg'])d.seed(id);
  const c=baseContext(d);vm.runInContext(section('function openDrawer(c)','function saveClosure(c)'),c);
  const text='<img data-audit-marker="text" src=x onerror="neverExecute()"> & \' "';
  const attr='"><img data-audit-marker="attribute" src=x onerror="neverExecute()">';
  const row=c.decorateCase(c.normalizeCase(fixture('A',{title:attr,note:text,requester:text,designer:{id:1,name:text},collaborators:[{id:2,name:text}],archivePath:attr,items:[{n:text,type:text,owner:text}],logs:[{date:'2026-10-22',note:text,by:text}]})));
  c.openDrawer(row);
  assert.equal(d.document.querySelectorAll('[data-audit-marker]').length,0,'payload must not create elements');
  assert(d.get('d-grid').textContent.includes(text),'note remains readable');
  assert.equal(d.get('d-archive-input').value,attr,'attribute value survives as literal input text');
  assert(d.get('d-subitems').textContent.includes(text),'subitem text remains readable');
});

await test('activation identity is rendered as inert text',async()=>{
  const d=dom();for(const id of ['loading','bad','form','bad-msg','who','pw','pw2','submit','err','r-len','r-upper','r-lower','r-digit'])d.seed(id);
  const text='<img data-audit-marker="activation" src=x onerror="neverExecute()">';
  const c=context({document:d.document,location:{search:'?token=SYNTHETIC',replace(){throw Error('No navigation');}},fetch:async()=>({ok:true,json:async()=>({name:text,email:'test@example.invalid'})})});
  const scripts=[...activation.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(x=>x[1]);
  vm.runInContext(scripts.at(-1),c);await flush();
  assert.equal(d.document.querySelectorAll('[data-audit-marker]').length,0);assert(d.get('who').textContent.includes(text));
});

function logContext(request){
  const d=dom(),requests=[],messages=[];const drawer=d.seed('drawer');drawer.classList.add('open');
  for(const id of ['d-log-input','d-log-date','d-log-submit','d-timeline','d-log-tags','d-log-tagby-wrap','d-log-tagby'])d.seed(id,'div',drawer);
  let generation=0;
  const c=baseContext(d,{CASES:[],showToast:s=>messages.push(s),prompt:()=> 'Edited text',confirm:()=>true,fetchJson:async(method,url,body)=>{requests.push({method,url,body});return request(method,url,body);},api:{cases:{}},v95DrawerSeq:{now:()=>generation,bump:()=>++generation},IS_OBSERVER:()=>false});
  vm.runInContext(section('api.cases.patchLogs =','// ── B2/B3/B4:'),c);
  const open=raw=>{const row=c.decorateCase(c.normalizeCase(raw));c.currentCase=row;c.v95DrawerSeq.bump();c.v51WireLogs(row);return row;};
  d.get('d-log-date').value='2026-10-22';return {c,d,requests,messages,open};
}

await test('normalization preserves revision and legacy meeting log text/by for rendering and rewrite',()=>{
  const {c}=logContext(()=>{});const row=c.normalizeCase(fixture('A',{logs:[{id:'legacy',date:'2026-10-21',text:'Legacy meeting action',author:'Meeting author'}]}));
  assert.equal(row._updatedAt,oldStamp);assert.equal(row._contentVersion,oldVersion);assert.equal(row.logs[0].note,'Legacy meeting action');assert.equal(row.logs[0].by,'Meeting author');
  const sent=c.v51LogsForApi(row.logs);assert.equal(sent[0].note,'Legacy meeting action');assert.equal(sent[0].by,'Meeting author');
  const legacyDirect=c.v51LogsForApi([{date:'2026-10-21',text:'Raw legacy action',author:'Raw legacy author'}]);assert.equal(legacyDirect[0].note,'Raw legacy action');assert.equal(legacyDirect[0].by,'Raw legacy author');
});

await test('failed append preserves draft and existing history and never sends replacement PATCH',async()=>{
  const {d,requests,messages,open}=logContext(async()=>{throw Error('synthetic offline');});
  const row=open(fixture('A',{logs:[{date:'2026-10-21',note:'Existing history',by:'Designer'}]}));
  d.get('d-log-input').value='New entry';await d.get('d-log-submit').onclick();
  assert.equal(d.get('d-log-input').value,'New entry');assert.equal(row.logs[0].note,'Existing history');
  assert.equal(requests.length,1);assert.equal(requests[0].method,'POST');assert.equal(requests[0].url,'/api/cases/A/logs');assert.equal(requests[0].body.entry.note,'New entry');assert(requests[0].body.entry.id);assert.equal(requests[0].body.logs,undefined);assert(messages.length);
});

await test('failed append retry reuses an id only while every submitted content field is unchanged',async()=>{
  const {c,d,requests,open}=logContext(async()=>{throw Error('synthetic offline');});open(fixture('A'));
  d.get('d-log-input').value='Same note';const submit=()=>d.get('d-log-submit').onclick();
  await submit();await submit();assert.equal(requests[0].body.entry.id,requests[1].body.entry.id,'unchanged retry reuses id');
  d.get('d-log-date').value='2026-10-21';await submit();assert.notEqual(requests[2].body.entry.id,requests[1].body.entry.id,'date is part of draft identity');
  vm.runInContext("v68SelTag='revise'",c);await submit();assert.notEqual(requests[3].body.entry.id,requests[2].body.entry.id,'tag is part of draft identity');
  vm.runInContext("v68SelBy='主管'",c);await submit();assert.notEqual(requests[4].body.entry.id,requests[3].body.entry.id,'tagBy is part of draft identity');
  await submit();assert.equal(requests[5].body.entry.id,requests[4].body.entry.id,'unchanged retry after metadata edit reuses new id');
});

await test('late success cannot clear the retry identity of a newer draft for the same case',async()=>{
  const first=deferred();let calls=0;const {d,requests,open}=logContext(()=>++calls===1?first.promise:Promise.reject(Error('new draft offline')));
  open(fixture('A'));d.get('d-log-input').value='Old submission';const oldSave=d.get('d-log-submit').onclick();
  open(fixture('A'));d.get('d-log-input').value='New submission';await d.get('d-log-submit').onclick();const newId=requests[1].body.entry.id;
  first.resolve(fixture('A',{updatedAt:newStamp,contentVersion:newVersion,logs:[{...requests[0].body.entry,by:'Designer'}]}));await oldSave;
  await d.get('d-log-submit').onclick();assert.equal(requests[2].body.entry.id,newId);assert.equal(d.get('d-log-input').value,'New submission');
});

await test('append consumes the full canonical case response including existing history and revision',async()=>{
  const response=fixture('A',{updatedAt:newStamp,contentVersion:newVersion,logs:[{id:'new',date:'2026-10-22',note:'New entry',by:'Designer'},{id:'old',date:'2026-10-21',note:'Existing history',by:'Other'}]});
  const {c,d,requests,open}=logContext(async()=>response);const row=open(fixture('A'));
  d.get('d-log-input').value='New entry';await d.get('d-log-submit').onclick();
  assert.equal(requests.length,1);assert.equal(requests[0].method,'POST');assert.equal(d.get('d-log-input').value,'');assert(d.get('d-timeline').textContent.includes('Existing history'));assert.equal(c.currentCase._updatedAt,newStamp);assert.equal(c.currentCase._contentVersion,newVersion);assert.equal(c.currentCase.logs.length,2);
});

await test('append completion preserves text and tags typed after submission in the same drawer',async()=>{
  const pending=deferred();const {c,d,open}=logContext(()=>pending.promise);open(fixture('A'));
  d.get('d-log-input').value='Submitted entry';const save=d.get('d-log-submit').onclick();
  d.get('d-log-input').value='Next unsaved entry';vm.runInContext("v68SelTag='revise';v68SelBy='主管';",c);
  pending.resolve(fixture('A',{updatedAt:newStamp,contentVersion:newVersion,logs:[{id:'saved',date:'2026-10-22',note:'Submitted entry',by:'Designer'}]}));await save;
  assert.equal(d.get('d-log-input').value,'Next unsaved entry');assert.equal(vm.runInContext('v68SelTag',c),'revise');assert.equal(vm.runInContext('v68SelBy',c),'主管');
});

for(const field of ['date','tag','tagBy'])await test('append completion preserves a same-text draft when only its '+field+' changed in flight',async()=>{
  const pending=deferred();const {c,d,requests,open}=logContext(()=>pending.promise);open(fixture('A'));
  d.get('d-log-input').value='Same text';vm.runInContext("v68SelTag='revise';v68SelBy='主管'",c);
  const save=d.get('d-log-submit').onclick();
  if(field==='date')d.get('d-log-date').value='2026-10-21';
  if(field==='tag')vm.runInContext("v68SelTag='feedback'",c);
  if(field==='tagBy')vm.runInContext("v68SelBy='行銷'",c);
  pending.resolve(fixture('A',{updatedAt:newStamp,contentVersion:newVersion,logs:[{...requests[0].body.entry,by:'Designer'}]}));await save;
  assert.equal(d.get('d-log-input').value,'Same text');assert.equal(d.get('d-log-date').value,field==='date'?'2026-10-21':'2026-10-22');
  assert.equal(vm.runInContext('v68SelTag',c),field==='tag'?'feedback':'revise');assert.equal(vm.runInContext('v68SelBy',c),field==='tagBy'?'行銷':'主管');
});

await test('a response revision cannot advance a second cached case while leaving its logs or items stale',()=>{
  const {c,open}=logContext(()=>{});const prior=fixture('A',{logs:[{id:'old',date:'2026-10-21',note:'Old log',by:'Designer'}],items:[{n:'Old item'}]});
  const detached=open(prior),cached=c.decorateCase(c.normalizeCase(prior));c.CASES.push(cached);
  c.v10SyncUpdatedAt(detached,fixture('A',{updatedAt:newStamp,contentVersion:newVersion,logs:[{id:'server',date:'2026-10-22',note:'Server-added log',by:'Other'},{id:'old',date:'2026-10-21',note:'Old log',by:'Designer'}],items:[{n:'Server-edited item'}]}));
  for(const row of [detached,cached]){assert.equal(row._updatedAt,newStamp);assert.equal(row._contentVersion,newVersion);assert.equal(row.logs[0].note,'Server-added log');assert.equal(row.items[0].n,'Server-edited item');assert(row.logs[0].date instanceof Date);}
});

await test('out-of-order responses cannot roll a newer shared content revision back',()=>{
  const {c,open}=logContext(()=>{});const detached=open(fixture('A'));const latestVersion=newVersion+1;
  const cached=c.decorateCase(c.normalizeCase(fixture('A',{updatedAt:'2026-10-22T02:02:00.000Z',contentVersion:latestVersion,logs:[{id:'latest',date:'2026-10-22',note:'Latest committed log',by:'Designer'}],items:[{n:'Latest committed item'}]})));c.CASES.push(cached);
  c.v10SyncUpdatedAt(detached,fixture('A',{updatedAt:newStamp,contentVersion:newVersion,logs:[{id:'older',date:'2026-10-22',note:'Older committed log',by:'Designer'}],items:[{n:'Older committed item'}]}));
  assert.equal(cached._contentVersion,latestVersion);assert.equal(cached._updatedAt,'2026-10-22T02:02:00.000Z');assert.equal(cached.logs[0].note,'Latest committed log');assert.equal(cached.items[0].n,'Latest committed item');
});

for(const sameCase of [false,true])for(const fail of [false,true])await test('late log '+(fail?'failure':'success')+' cannot touch '+(sameCase?'a reopened generation of the same case':'a different case'),async()=>{
  const pending=deferred();const {c,d,messages,open}=logContext(()=>pending.promise);
  open(fixture('A'));d.get('d-log-input').value='A submitted';const save=d.get('d-log-submit').onclick();
  const nextId=sameCase?'A':'B';open(fixture(nextId,{logs:[{date:'2026-10-22',note:'Current timeline',by:'Designer'}]}));d.get('d-log-input').value='Current unsaved draft';d.get('d-log-submit').disabled=true;
  const priorMessages=messages.length;
  if(fail)pending.reject(Error('obsolete failure'));else pending.resolve(fixture('A',{updatedAt:newStamp,contentVersion:newVersion,logs:[{date:'2026-10-22',note:'Old response',by:'Designer'}]}));await save;
  assert.equal(d.get('d-log-input').value,'Current unsaved draft');assert(d.get('d-timeline').textContent.includes('Current timeline'));assert(!d.get('d-timeline').textContent.includes('Old response'));assert.equal(d.get('d-log-submit').disabled,true);assert.equal(messages.length,priorMessages);assert.equal(c.currentCase.id,nextId);
});

await test('log editing includes expectedUpdatedAt and a conflict preserves the existing entry',async()=>{
  const {d,requests,open}=logContext(async()=>{const e=Error('conflict');e.status=409;e.data={error:'conflict'};throw e;});
  const row=open(fixture('A',{logs:[{id:'entry',date:'2026-10-21',note:'Original entry',by:'Designer'}]}));
  const button=d.get('d-timeline').querySelector('[data-logedit]');assert(button);await button.onclick();
  assert.equal(requests.length,1);assert.equal(requests[0].method,'PATCH');assert.equal(requests[0].body.expectedUpdatedAt,oldStamp);assert.equal(requests[0].body.expectedContentVersion,oldVersion);assert.equal(row.logs[0].note,'Original entry');
});

for(const action of ['data-logedit','data-logdel'])await test('late '+action+' conflict cannot render the previous case into the current timeline',async()=>{
  const pending=deferred();const {d,messages,open}=logContext(()=>pending.promise);
  open(fixture('A',{logs:[{id:'entry',date:'2026-10-21',note:'Previous case log',by:'Designer'}]}));
  const mutation=d.get('d-timeline').querySelector('['+action+']').onclick();
  open(fixture('B',{logs:[{id:'entry-b',date:'2026-10-22',note:'Current case log',by:'Designer'}]}));
  const before=messages.length;const error=Error('old conflict');error.status=409;pending.reject(error);await mutation;
  assert(d.get('d-timeline').textContent.includes('Current case log'));assert(!d.get('d-timeline').textContent.includes('Previous case log'));assert.equal(messages.length,before);
});

await test('successful log edit advances the revision used by the next log delete',async()=>{
  const {c,d,requests,open}=logContext(async(_method,_url,body)=>fixture('A',{updatedAt:newStamp,contentVersion:newVersion,logs:body.logs}));
  const row=open(fixture('A',{logs:[{id:'entry',fromMeeting:7,date:'2026-10-21',note:'Original',by:'Designer'}]}));
  await d.get('d-timeline').querySelector('[data-logedit]').onclick();assert.equal(row._updatedAt,newStamp);assert.equal(row._contentVersion,newVersion);
  assert.equal(requests[0].body.logs[0].id,'entry');assert.equal(requests[0].body.logs[0].fromMeeting,7);
  await d.get('d-timeline').querySelector('[data-logdel]').onclick();assert.equal(requests[1].body.expectedUpdatedAt,newStamp);assert.equal(requests[1].body.expectedContentVersion,newVersion);
});

for(const fail of [false,true])await test('subitem save sends the displayed revision and '+(fail?'does not retry a conflict':'advances the revision'),async()=>{
  const {c,d,requests,open}=logContext(async(_method,_url,body)=>{if(fail){const e=Error('conflict');e.status=409;throw e;}return fixture('A',{updatedAt:newStamp,contentVersion:newVersion,items:body.items});});
  c.STAFF=[{id:1,name:'Designer',active:true,role:'member'}];c.DELIVERABLES=['PDF'];c.reloadCase=async()=>{};c.v33RenderChangeLog=()=>{};
  vm.runInContext(section('api.cases.patchItems =','// ─── v4.4: 子案件納入'),c);
  const row=open(fixture('A',{items:[{n:'Original subitem',type:'PDF',owner:'Designer',assigneeId:1,status:'尚未製作',logs:[]}]}));
  c.CASES.push(row);const body=d.seed('items-test-body');c.v43InjectSubItemsPanel(row,body);
  const input=body.querySelector('input[data-k="n"]');assert(input);input.value='Changed subitem';input.oninput({target:input});
  await body.querySelector('#v43-items-save').onclick();
  assert.equal(requests.length,1);assert.equal(requests[0].method,'PATCH');assert.equal(requests[0].url,'/api/cases/A/items');assert.equal(requests[0].body.expectedUpdatedAt,oldStamp);assert.equal(requests[0].body.expectedContentVersion,oldVersion);
  assert.equal(row._updatedAt,fail?oldStamp:newStamp);assert.equal(row._contentVersion,fail?oldVersion:newVersion);assert.equal(row.items[0].n,fail?'Original subitem':'Changed subitem');
});

await test('subitem editor keeps the revision captured when opened even if another mutation advances the case',async()=>{
  const {c,d,requests,open}=logContext(async()=>{const e=Error('stale editor');e.status=409;throw e;});
  c.STAFF=[{id:1,name:'Designer',active:true,role:'member'}];c.DELIVERABLES=['PDF'];c.reloadCase=async()=>{};c.v33RenderChangeLog=()=>{};
  vm.runInContext(section('api.cases.patchItems =','// ─── v4.4: 子案件納入'),c);
  const row=open(fixture('A',{items:[{n:'Original subitem',type:'PDF',owner:'Designer',status:'尚未製作',logs:[]}]}));c.CASES.push(row);
  const body=d.seed('items-old-editor');c.v43InjectSubItemsPanel(row,body);row._updatedAt=newStamp;row._contentVersion=newVersion;
  const input=body.querySelector('input[data-k="n"]');input.value='Old-editor change';input.oninput({target:input});await body.querySelector('#v43-items-save').onclick();
  assert.equal(requests.length,1);assert.equal(requests[0].body.expectedUpdatedAt,oldStamp);assert.equal(requests[0].body.expectedContentVersion,oldVersion);assert.equal(row.items[0].n,'Original subitem');
});

await test('hotel overview delegates archived opening to the central decorated opener',async()=>{
  const d=dom(),shown=[],requests=[];d.seed('v81-clear');const button=d.element('button');button.dataset.id='ARCHIVED';
  const c=baseContext(d,{CASES:[],v81AllCases:[],api:{cases:{getOne:async id=>{requests.push(id);return fixture(id,{status:'closed',archived:true});}}},openDrawer:r=>shown.push(r),openDrawerById(){},showToast(){},v92CloseDrawer(){}});
  vm.runInContext(section('const _v38OrigOpenDrawerById','// Fix 3: Dashboard')+section('function v81Wire(body)','NAV_DEF.admin.push'),c);
  c.v81Wire({querySelectorAll:s=>s==='.v81-open'?[button]:[]});await button.onclick({stopPropagation(){}});await flush();
  assert.equal(requests.length,1);assert.equal(shown[0].id,'ARCHIVED');assert(shown[0].reviewDate instanceof Date);assert(shown[0].proofStart instanceof Date);assert.equal(c.CASES.length,0);
});

function profileContext(){
  const d=dom(),requests=[],copied=[],messages=[];
  for(const id of ['v34-profile-title','v34-profile-bg','v34-profile-modal','v34-pf-name','v34-pf-email','v34-pf-roleTitle','v34-pf-seniority','v34-pf-role','v34-pf-role-wrap','v34-pf-pwtitle','v34-pf-pw-self','v34-pf-pw-admin','v34-pf-pw-reset','v34-pf-pwsection','v34-pf-pw-current','v34-pf-pw-new','v34-pf-pw-new2'])d.seed(id);
  const c=baseContext(d,{ME:{id:0,role:'admin'},STAFF:[],NAV_DEF:{admin:[],designer:[]},v34CurrentEditTarget:null,v34EnsureProfileModal(){},navigator:{clipboard:{async writeText(v){copied.push(v);}}},showToast:s=>messages.push(s),fetchJson(method,url,body){const task=deferred();requests.push({method,url,body,...task});return task.promise;}});
  vm.runInContext(section('function openProfileEdit(staffOrSelf)','async function v34SaveProfile')+extension,c);c.ME.id=99;
  return {c,d,requests,copied,messages};
}
for(const fail of [false,true])await test('old recovery '+(fail?'failure':'success')+' cannot replace the next target successful copy link',async()=>{
  const {c,d,requests,copied,messages}=profileContext();
  c.openProfileEdit({id:1,name:'Person A',active:true});const a=d.get('wb-recovery-create').onclick();
  c.closeProfileEdit();c.openProfileEdit({id:2,name:'Person B',active:true});const b=d.get('wb-recovery-create').onclick();
  requests[1].resolve({url:'https://example.invalid/reset#PERSON_B',expires:'2026-10-22T12:00:00Z'});await b;const before=messages.length;
  if(fail)requests[0].reject(Error('old error'));else requests[0].resolve({url:'https://example.invalid/reset#PERSON_A',expires:'2026-10-22T12:00:00Z'});await a;
  assert.equal(d.get('v34-profile-title').textContent,'編輯：Person B');const copy=d.get('wb-copy-recovery');assert(copy);await copy.click();assert.deepEqual(copied,['https://example.invalid/reset#PERSON_B']);assert.equal(messages.length,before+1);assert(!d.get('wb-recovery-result').textContent.includes('old error'));
});

await test('closing and reopening the same recovery target invalidates its outstanding response',async()=>{
  const {c,d,requests,copied}=profileContext();const target={id:1,name:'Person A',active:true};
  c.openProfileEdit(target);const a=d.get('wb-recovery-create').onclick();c.closeProfileEdit();c.openProfileEdit(target);
  requests[0].resolve({url:'https://example.invalid/reset#OLD',expires:'2026-10-22T12:00:00Z'});await a;
  const button=d.get('wb-copy-recovery');if(button)await button.click();assert.equal(copied.length,0);
});

function calendarContext(){
  const d=dom(),requests=[],copied=[],messages=[];
  const c=baseContext(d,{api:{auth:{}},confirm:()=>true,navigator:{clipboard:{async writeText(v){copied.push(v);}}},location:{origin:'https://example.invalid'},showToast:s=>messages.push(s),fetchJson(method,url,body){const task=deferred();requests.push({method,url,body,...task});return task.promise;}});
  vm.runInContext(section('api.auth.calendarSubscription =','// 註冊到 nav + switchView'),c);return {c,d,requests,copied,messages};
}
for(const fail of [false,true])await test('old calendar '+(fail?'failure':'success')+' cannot replace a new scope or restore a stale copy URL',async()=>{
  const {c,d,requests,copied}=calendarContext();c.v57ShowSubscribe();await flush();
  assert.equal(requests.length,1);assert.equal(requests[0].method,'GET');assert.match(requests[0].url,/\/api\/auth\/calendar-subscription\?scope=mine$/);
  const early=d.get('v57-sub-copy');if(early)await early.click();assert.equal(copied.length,0);
  const team=d.get('v57-sub-modal').querySelector('[data-scope="team"]');assert(team);team.click();await flush();assert.equal(requests.length,2);
  requests[1].resolve({url:'https://example.invalid/calendar#TEAM',expires:'2026-11-22T00:00:00Z',scope:'team'});await flush();
  if(fail)requests[0].reject(Error('old calendar error'));else requests[0].resolve({url:'https://example.invalid/calendar#MINE',expires:'2026-11-22T00:00:00Z',scope:'mine'});await flush();
  const button=d.get('v57-sub-copy');assert(button&&!button.disabled);await button.click();assert.deepEqual(copied,['https://example.invalid/calendar#TEAM']);assert(!d.get('v57-sub-modal').textContent.includes('old calendar error'));
});

await test('calendar request failure leaves no copyable URL',async()=>{
  const {c,d,requests,copied}=calendarContext();c.v57ShowSubscribe();await flush();assert.equal(requests.length,1);requests[0].reject(Error('synthetic unavailable'));await flush();const button=d.get('v57-sub-copy');if(button)await button.click();assert.equal(copied.length,0);assert.equal(d.get('v57-sub-url')?.value||'','');
});

await test('calendar close and reopen invalidates the old request even for the same scope',async()=>{
  const {c,d,requests,copied}=calendarContext();c.v57ShowSubscribe();await flush();d.get('v57-sub-close').click();c.v57ShowSubscribe();await flush();
  requests[1].resolve({url:'https://example.invalid/calendar#NEW',expires:'2026-11-22T00:00:00Z',scope:'mine'});await flush();requests[0].resolve({url:'https://example.invalid/calendar#OLD',expires:'2026-11-22T00:00:00Z',scope:'mine'});await flush();
  await d.get('v57-sub-copy').click();assert.deepEqual(copied,['https://example.invalid/calendar#NEW']);
});

await test('calendar revoke clears old URL immediately and stays fail-closed if revoke fails',async()=>{
  const {c,d,requests,copied}=calendarContext();c.v57ShowSubscribe();await flush();requests[0].resolve({url:'https://example.invalid/calendar#OLD',expires:'2026-11-22T00:00:00Z',scope:'mine'});await flush();
  d.get('v57-sub-revoke').click();await flush();assert.equal(requests[1].method,'POST');assert.equal(requests[1].url,'/api/auth/calendar-subscription/revoke');assert.equal(d.get('v57-sub-url').value,'');await d.get('v57-sub-copy').click();assert.equal(copied.length,0);
  requests[1].reject(Error('synthetic revoke failed'));await flush();await d.get('v57-sub-copy').click();assert.equal(copied.length,0);assert.equal(d.get('v57-sub-url').value,'');
});

for(const reopen of [false,true])await test('calendar '+(reopen?'reopen':'scope switch')+' waits for an in-flight revoke before requesting a fresh URL',async()=>{
  const {c,d,requests,copied}=calendarContext();c.v57ShowSubscribe();await flush();requests[0].resolve({url:'https://example.invalid/calendar#OLD',expires:'2026-11-22T00:00:00Z',scope:'mine'});await flush();
  d.get('v57-sub-revoke').click();await flush();assert.equal(requests.length,2);
  if(reopen){d.get('v57-sub-close').click();c.v57ShowSubscribe();}else d.get('v57-sub-modal').querySelector('[data-scope="team"]').click();await flush();
  assert.equal(requests.length,2,'a GET before revoke settles can mint a token which the pending revoke immediately invalidates');assert.equal(d.get('v57-sub-url').value,'');await d.get('v57-sub-copy').click();assert.equal(copied.length,0);
  requests[1].resolve({ok:true});await flush();assert.equal(requests.length,3);assert.equal(requests[2].method,'GET');const scope=reopen?'mine':'team';assert(requests[2].url.endsWith('scope='+scope));
  requests[2].resolve({url:'https://example.invalid/calendar#FRESH',expires:'2026-11-22T00:00:00Z',scope});await flush();await d.get('v57-sub-copy').click();assert.deepEqual(copied,['https://example.invalid/calendar#FRESH']);
});

console.log(JSON.stringify({passed,failed,liveNetwork:false,productionWrites:0,syntheticHtmlExecuted:false}));
if(failed)process.exitCode=1;
