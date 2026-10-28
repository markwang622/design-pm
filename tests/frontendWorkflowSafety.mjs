import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

// Execute shipped browser code with inert DOM and isolated API doubles. The DOM
// models native select defaults and disabled clicks; HTML event text is never run.
// No HTTP, real clipboard, email, password mutation, or production writes occur.
process.env.TZ = 'Asia/Taipei';
const root=process.env.DESIGN_PM_ROOT || new URL('../',import.meta.url).pathname;
const source=fs.readFileSync(root+'/public/index.html','utf8');
const extension=fs.readFileSync(root+'/public/workbench-features.js','utf8');
function section(start,end,text=source){const a=text.indexOf(start),b=text.indexOf(end,a+start.length);assert(a>=0&&b>a,'source section exists: '+start);return text.slice(a,b);}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
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
    n.click=()=>{if(n.disabled)return;let stopped=false;const event={type:'click',target:n,preventDefault(){},stopPropagation(){stopped=true;}};const returned=n.onclick?.(event);for(const fn of n.events.click||[])fn(event);let parent=n.parentNode;while(parent&&!stopped){parent.onclick?.(event);for(const fn of parent.events.click||[])fn(event);parent=parent.parentNode;}if(!stopped)document.dispatchEvent(event);return returned;};
    n.prepend=child=>n.insertBefore(child,n.firstChild);n.focus=()=>{};n.select=()=>{};n.scrollIntoView=()=>{};n.insertAdjacentElement=(_pos,child)=>n.parentNode?.appendChild(child);
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
const workflowHelpers=source.includes('function v20TaiwanToday()')?section('function v20TaiwanToday()','function daysUntil(dt)'):'';
const identityHelpers=source.includes('function v20SameId(')?section('function v20SameId(','function ADMIN_NAME()'):'';
const escaped=section('function escapeHtml(s)','async function v33SaveEdit');
const dateHelpers=section('function d(y, m, dd)','// v4.0 fix:')+section('function daysUntil(dt)','// J1:')+section('function ymdIso(dt)','function findStaffId');
function browser(d,extra={}){
  const messages=[];
  const c=context({document:d.document,ME:{id:1,name:'Designer',role:'member'},STAFF:[],CASES:[],currentRole:'designer',currentView:'personal',TODAY:new Date('2026-10-22T00:00:00+08:00'),showToast:(message,type)=>messages.push({message,type}),...extra});
  c.ME_NAME=()=>c.ME.name;c.IS_OBSERVER=()=>c.ME.role==='observer';
  vm.runInContext(dateHelpers+escaped+identityHelpers+workflowHelpers,c);
  return {c,messages};
}
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}}
const plain=value=>JSON.parse(JSON.stringify(value));

function restoreContext(role,owner){
  const d=dom(),drawer=d.seed('drawer');drawer.className='drawer';const body=d.seed('drawer-body','div',drawer);body.className='drawer-body';
  for(const [id,tag] of [['drawer-close','button'],['d-back','button'],['d-log-submit','button'],['edit-field','input']])d.seed(id,tag,body);
  d.seed('drawer-bg');const requests=[];
  const {c,messages}=browser(d,{ME:{id:1,name:'Designer',role},currentRole:role==='admin'?'admin':'designer',openDrawer:async()=>{},currentCase:null,v95DrawerSeq:{now:()=>1},ENDED_STATUS_KEYS:new Set(['done','closed','cancelled']),FINAL_STATUS_KEYS:new Set(['done','closed']),isCancelled:c=>c.status==='cancelled',STATUSES:[],confirm:()=>true,api:{cases:{async uncancel(id){requests.push(id);}}},reloadAllCases:async()=>{},refreshAll(){},v90MarkSelected(){},v90MountPanel(){}});
  vm.runInContext(section('function v2Outcome(c)','function ymdIso(dt)')+section('function v71CanCancel(c)','let v71Reason =')+section('const _v37OrigOpenDrawer =','async function v37ReopenCase(c)')+section('function v71InjectDrawerBtn(c)','// 關閉抽屜／切換頁面'),c);
  return {c,d,messages,requests,row:{id:'cancelled-fixture',name:'Cancelled project',status:'cancelled',archived:true,_designerId:owner?1:2,designer:owner?'Designer':'Other',_collaboratorIds:owner?[]:[1],collaborators:owner?[]:['Designer']}};
}
for(const [role,owner,allowed] of [['admin',false,true],['member',true,true],['member',false,false],['observer',true,false]])await test('F05 cancelled restore permission for '+role+(owner?' primary':' collaborator'),async()=>{
  const {c,d,row,requests}=restoreContext(role,owner);c.currentCase=row;await c.openDrawer(row);await flush();const button=d.get('v71-restore');
  if(allowed){assert(button,'eligible user sees restore');assert.equal(button.disabled,false,'historical wrapper must preserve restore');assert.equal(button.classList.contains('v37-historical-readonly'),false);await button.click();assert.deepEqual(requests,[row.id]);}
  else {if(button){assert(button.disabled,'unauthorized restore must be unavailable');await button.click();}assert.equal(requests.length,0);}
  assert.equal(d.get('d-log-submit').disabled,true,'ordinary historical edits remain readonly');assert.equal(d.get('edit-field').disabled,true);assert.equal(d.get('drawer-close').disabled,false);
});

function basicContext(){
  const d=dom();d.seed('d-grid');const writes=[];
  const {c,messages}=browser(d,{ME:{id:1,name:'Designer',role:'admin'},HOTELS:[{name:'Active hotel',region:'North'}],REQUEST_UNITS:['Active unit'],DELIVERABLES:['PDF'],api:{cases:{async update(id,body){writes.push({id,body});}}},openDrawer(){},refreshAll(){}});
  vm.runInContext(section('function v52CanEditBasic(c)','// ═══════════════════════════════════════════════════════════════'),c);
  return {c,d,writes,messages};
}
for(const [hotel,unit] of [['Inactive hotel','Inactive unit'],['Historical renamed hotel','Historical renamed unit'],['Active hotel','Active unit']])await test('F07 title-only edit preserves '+hotel+' and its requester',async()=>{
  const {c,d,writes}=basicContext(),row={id:'A',name:'Original title',hotel,unit,contact:'Requester contact',deliverables:['PDF']};c.v52WireBasicEdit(row);
  // Do not manually populate selects: the native default comes from real options.
  d.get('v52-title').value='Updated title';await d.get('v52-save').click();
  assert.equal(writes.length,1);assert.equal(writes[0].body.title,'Updated title');
  assert.equal(writes[0].body.hotel??row.hotel,hotel);assert.equal(writes[0].body.requester??row.unit,unit);assert.equal(row.hotel,hotel);assert.equal(row.unit,unit);
});
await test('F07 selecting a new active hotel and requester still updates both',async()=>{
  const {c,d,writes}=basicContext(),row={id:'A',name:'Original title',hotel:'Inactive hotel',unit:'Inactive unit',deliverables:[]};c.v52WireBasicEdit(row);
  d.get('v52-hotel').value='Active hotel';d.get('v52-unit').value='Active unit';await d.get('v52-save').click();
  assert.equal(writes[0].body.hotel,'Active hotel');assert.equal(writes[0].body.requester,'Active unit');
});

function ownershipContext(){
  const d=dom(),person={id:1,name:'Old Name',email:'person@example.invalid',roleTitle:'設計師',seniority:'mid',role:'member',active:true};
  for(const id of ['v34-pf-name','v34-pf-email','v34-pf-roleTitle','v34-pf-seniority','v34-pf-role','v34-pf-pw-current','v34-pf-pw-new','v34-pf-pw-new2'])d.seed(id,'input');
  const badge=d.seed('user-badge');d.seed('badge-text','span',badge).nodeValue='';
  const primary={id:'primary',designer:'Old Name',_designerId:1,collaborators:[],_collaboratorIds:[],archived:false,items:[{owner:'Old Name',assigneeId:1}]};
  const collab={id:'collab',designer:'Other',_designerId:2,collaborators:['Old Name'],_collaboratorIds:[1],archived:false};
  const history={...primary,id:'history',archived:true};
  const {c,messages}=browser(d,{ME:{...person},STAFF:[person],CASES:[primary,collab,history],v34CurrentEditTarget:person,v69AllCases:[{...primary,id:'analytics',items:[]}],v81AllCases:[{...collab,id:'hotel'}],currentCase:primary,normalizeStaff:s=>s,reloadAllCases:async()=>{},closeProfileEdit(){},refreshAll(){},api:{staff:{async update(id,body){return {...person,...body};}}}});
  vm.runInContext(section('// ============== Personal ==============','function renderPersonal()')+section('async function v34SaveProfile()','// ─── Inject Edit buttons'),c);
  for(const [id,value] of Object.entries({'v34-pf-name':'New Name','v34-pf-email':person.email,'v34-pf-roleTitle':person.roleTitle,'v34-pf-seniority':'mid','v34-pf-role':'member'}))d.get(id).value=value;
  return {c,d,primary,collab,history,messages};
}
await test('F08 task ownership follows IDs even when cached names are stale or collide',()=>{
  const {c}=ownershipContext();c.ME.name='Renamed already';
  c.CASES.push({id:'string-primary',designer:'Previous cached name',_designerId:'1',collaborators:[],_collaboratorIds:[],archived:false},{id:'string-collab',designer:'Other',_designerId:'2',collaborators:['Previous cached name'],_collaboratorIds:['1'],archived:false});
  c.CASES.push({id:'wrong-person-same-name',designer:c.ME.name,_designerId:8,collaborators:[],_collaboratorIds:[],archived:false});
  assert.deepEqual(plain(c.myCases().map(r=>r.id).sort()),['collab','primary','string-collab','string-primary']);
});
await test('F08 self rename preserves primary and collaborator tasks and refreshes display caches',async()=>{
  const {c}=ownershipContext();assert.equal(c.myCases().length,2);await c.v34SaveProfile();
  assert.equal(c.ME.name,'New Name');assert.equal(c.STAFF[0].name,'New Name');assert.deepEqual(plain(c.myCases().map(r=>r.id).sort()),['collab','primary']);
  assert.equal(c.CASES.find(r=>r.id==='primary').designer,'New Name');assert.deepEqual(plain(c.CASES.find(r=>r.id==='collab').collaborators),['New Name']);
  // A retained cache must be updated; dropping it is also a valid invalidation.
  if(c.v69AllCases)assert.equal(c.v69AllCases[0].designer,'New Name');
  if(c.v81AllCases)assert.deepEqual(plain(c.v81AllCases[0].collaborators),['New Name']);
});

await test('F08 successful rename reloads durable subitem revisions before refreshing case views',async()=>{
  const {c}=ownershipContext(),pending=deferred(),renderedVersions=[];let reloads=0;
  c.CASES.forEach(r=>{r._contentVersion=8;r._updatedAt='2026-10-22T01:00:00.000Z';});
  c.reloadAllCases=async()=>{reloads++;await pending.promise;c.CASES=c.CASES.map(r=>({...r,_contentVersion:9,_updatedAt:'2026-10-22T01:01:00.000Z'}));};
  c.refreshAll=()=>renderedVersions.push(c.CASES[0]._contentVersion);
  const save=c.v34SaveProfile();await flush();const started=reloads;const renderedEarly=renderedVersions.length;pending.resolve();await save;
  assert.equal(started,1,'successful rename must reload cases because the durable subitem migration increments revisions');assert.equal(renderedEarly,0,'views must wait for the new case revision');assert.equal(c.CASES[0]._contentVersion,9);assert.equal(c.CASES[0]._updatedAt,'2026-10-22T01:01:00.000Z');assert.deepEqual(renderedVersions,[9]);
});
await test('F08 staff rename conflict keeps the profile draft and shows its actual server message',async()=>{
  const {c,d,messages}=ownershipContext(),target=c.v34CurrentEditTarget;let closed=0,reloaded=0,refreshed=0;
  const detail='人員或子案件已被其他操作更新，姓名尚未變更，請重新整理後再試';
  c.closeProfileEdit=()=>{closed++;c.v34CurrentEditTarget=null;};c.reloadAllCases=async()=>{reloaded++;};c.refreshAll=()=>{refreshed++;};
  c.api.staff.update=async()=>{const error=Error('conflict');error.status=409;error.data={error:'staff_rename_conflict',message:detail};throw error;};
  await c.v34SaveProfile();assert(messages.some(m=>m.type==='err'&&m.message.includes(detail)),'a rename revision conflict must not be mislabeled Email duplicate');
  assert.equal(d.get('v34-pf-name').value,'New Name');assert.equal(d.get('v34-pf-email').value,'person@example.invalid');assert.equal(c.v34CurrentEditTarget,target);assert.equal(c.ME.name,'Old Name');assert.equal(c.STAFF[0].name,'Old Name');assert.equal(closed,0);assert.equal(reloaded,0);assert.equal(refreshed,0);
});

await test('F08 self rename retains legacy owner-only subitems in actual My Tasks collection',async()=>{
  const {c}=ownershipContext();c.CASES.push({id:'legacy-subitem-case',designer:'Other',_designerId:2,collaborators:[],_collaboratorIds:[],archived:false,items:[{n:'Assigned legacy task',owner:'Old Name',assigneeId:null}]});
  vm.runInContext(section('function v44CollectMySubItems()','function v44MakeSubItemCard'),c);
  assert.deepEqual(plain(c.v44CollectMySubItems().map(r=>r.c.id).sort()),['legacy-subitem-case','primary']);await c.v34SaveProfile();
  assert.deepEqual(plain(c.v44CollectMySubItems().map(r=>r.c.id).sort()),['legacy-subitem-case','primary']);
  assert.equal(c.CASES.find(r=>r.id==='legacy-subitem-case').items[0].owner,'New Name');
});

function calendarOwnershipContext(){
  const {c,d}=ownershipContext(),opened=[];c.v57Scope='mine';c.v57Layers={project:false,meeting:true,shoot:false,leave:false};c.v61ConflictsFor=()=>[];c.v61OpenModal=()=>opened.push('meeting');
  vm.runInContext(section('const V57_COLORS =','function v57EachDay')+section('let v57AgendaClicks = [];','function v57OpenDay'),c);
  const panel=d.seed('calendar-fixture');
  const render=()=>{const events=c.v57CollectEvents();panel.innerHTML=c.v57RenderAgenda(events);return events;};
  return {c,d,panel,opened,render};
}
await test('F08 renamed meeting host and attendee remain in the actual calendar agenda by ID',async()=>{
  const {c,panel,opened,render}=calendarOwnershipContext();
  c.MEETINGS=[{id:10,title:'Owned host meeting',date:'2026-10-23',startTime:'10:00',hostId:'1',host:{id:'1',name:'Old Name'},attendees:[]},{id:11,title:'Owned attendee meeting',date:'2026-10-23',startTime:'11:00',host:{id:2,name:'Other'},attendees:[{staffId:'1',staff:{id:'1',name:'Old Name'}}]}];
  await c.v34SaveProfile();assert.equal(c.ME.name,'New Name');const events=render();assert(panel.textContent.includes('Owned host meeting'));assert(panel.textContent.includes('Owned attendee meeting'));assert.equal(events['2026-10-23'].length,2);events['2026-10-23'][0].onClick();assert.deepEqual(opened,['meeting']);
});
await test('F08 same-name different-ID meetings stay out of mine but remain visible to team',async()=>{
  const {c,panel,render}=calendarOwnershipContext();await c.v34SaveProfile();
  c.MEETINGS=[{id:20,title:'Other host same name',date:'2026-10-23',startTime:'10:00',hostId:8,host:{id:8,name:'New Name'},attendees:[]},{id:21,title:'Other attendee same name',date:'2026-10-23',startTime:'11:00',host:{id:2,name:'Other'},attendees:[{staffId:'8',staff:{id:'8',name:'New Name'}}]}];
  const mine=render();assert.equal(Object.keys(mine).length,0);assert(!panel.textContent.includes('Other host same name'));assert(!panel.textContent.includes('Other attendee same name'));
  c.v57Scope='team';const team=render();assert.equal(team['2026-10-23'].length,2);assert(panel.textContent.includes('Other host same name'));assert(panel.textContent.includes('Other attendee same name'));
});

function formContext(kind,{now='2026-10-22T01:00:00+08:00',pageDate='2026-10-21T00:00:00+08:00'}={}){
  const d=dom(),requests=[];let clock=now;
  class TestDate extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return new Date(clock).getTime();}}
  const apiCreate=body=>{const task=deferred();requests.push({body,...task});return task.promise;};
  const {c,messages}=browser(d,{Date:TestDate,TODAY:new TestDate(pageDate),HOTELS:[{name:'Hotel'}],VACATIONS:[],TRIPS:[],SHOOTS:[],MEETINGS:[],STAFF:[{id:1,name:'Designer',active:true,role:'member'}],CASES:[{id:'A',name:'Project',archived:false}],VACATION_TYPE_LABEL:{annual:'Annual leave'},V55_MODE_LABEL:{'in-house':'In house',outsource:'Outsource'},V61_TYPE_LABEL:{internal:'Internal'},V61_WD:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],v65TripTab:'active',v65ShootTab:'active',v65MeetingTab:'active',v65TripEnded:()=>false,v65ShootEnded:()=>false,v65MeetingEnded:()=>false,v40LoadAvailability:async()=>{},v55LoadShoots:async()=>{},v61LoadMeetings:async()=>{},v40CloseAvailabilityModal(){},v55CloseModal(){},v61CloseModal(){},v55EditId:null,v61EditId:null,v61PrefillCase:null,v61DraftActions:[],v61ConflictsFor:()=>[],v61DayKind:()=>({bad:false}),v61RenderActions(){},v61SuggestSlots(){},confirm:()=>true,api:{vacations:{create:apiCreate},businessTrips:{create:apiCreate},shoots:{create:apiCreate,update(){throw Error('unexpected update');}},meetings:{create:apiCreate,update(){throw Error('unexpected update');}}}});
  let modal,render,saveId;
  if(kind==='vacation'||kind==='trip'){
    modal=d.seed('v40-avail-modal');vm.runInContext(section('async function v40RenderAvailabilityModal(modal)','window.v40DeleteVacation'),c);render=()=>c.v40RenderAvailabilityModal(modal);saveId=kind==='vacation'?'v40-vac-add':'v40-trip-add';
  }else if(kind==='shoot'){
    modal=d.seed('v55-shoot-modal');vm.runInContext(section('async function v55RenderModal()','// v6.6: 拍攝「進行中'),c);render=()=>c.v55RenderModal();saveId='v55-save';
  }else{
    modal=d.seed('v61-modal');vm.runInContext(section('async function v61RenderModal()','// v6.5: 會議封存/已結束'),c);render=()=>c.v61RenderModal();saveId='v61-save';
  }
  const fill=()=>{
    if(kind==='vacation')d.get('v40-vac-note').value='Leave fixture';
    if(kind==='trip')d.get('v40-trip-task').value='Site visit';
    if(kind==='shoot')d.get('v55-desc').value='Fixture shoot';
    if(kind==='meeting')d.get('v61-title').value='Fixture meeting';
  };
  return {c,d,modal,messages,requests,render,saveId,fill,setClock:v=>clock=v};
}
for(const kind of ['shoot','vacation','trip','meeting'])for(const fail of [false,true])await test('F09 '+kind+' synchronously locks duplicate creates and unlocks after '+(fail?'failure':'success'),async()=>{
  const {d,requests,render,saveId,fill}=formContext(kind);await render();fill();const button=d.get(saveId);const first=button.click(),second=button.click();
  const locked=button.disabled;
  // Switching a modal tab can replace its button while the first save is pending.
  // The new button must still share the in-flight submission lock.
  await render();fill();const third=d.get(saveId).click();const inFlightCount=requests.length;
  if(fail)requests.forEach(r=>r.reject(Error('synthetic unavailable')));else requests.forEach(r=>r.resolve({seriesCount:1,conflicts:[]}));
  await Promise.all([first,second,third]);await flush();
  assert.equal(inFlightCount,1,'two browser clicks before settlement create only once');assert.equal(locked,true,'button locks before the first await');assert.equal(d.get(saveId).disabled,false,'current form is usable after settlement');
  if(fail){assert.equal(d.get(kind==='shoot'?'v55-desc':kind==='meeting'?'v61-title':kind==='trip'?'v40-trip-task':'v40-vac-note').value,kind==='shoot'?'Fixture shoot':kind==='meeting'?'Fixture meeting':kind==='trip'?'Site visit':'Leave fixture');const retry=d.get(saveId).click();assert.equal(requests.length,2);requests[1].resolve({seriesCount:1,conflicts:[]});await retry;await flush();}
});
for(const kind of ['shoot','meeting','trip'])await test('F09 '+kind+' validation leaves a usable form without a write',async()=>{
  const {d,requests,render,saveId,messages}=formContext(kind);await render();await d.get(saveId).click();assert.equal(requests.length,0);assert.equal(d.get(saveId).disabled,false);assert(messages.some(m=>m.type==='err'));
});
for(const kind of ['vacation','trip','shoot','meeting'])await test('F10 '+kind+' defaults use Taipei current date across midnight',async()=>{
  const {d,render,setClock}=formContext(kind);await render();const ids=kind==='vacation'?['v40-vac-start','v40-vac-end']:kind==='trip'?['v40-trip-start','v40-trip-end']:kind==='shoot'?['v55-start','v55-end']:['v61-date'];
  for(const id of ids)assert.equal(d.get(id).value,'2026-10-22','01:00 Taipei must not use UTC yesterday or stale page TODAY');
  setClock('2026-10-23T01:00:00+08:00');await render();for(const id of ids)assert.equal(d.get(id).value,'2026-10-23','reopening next day must use a fresh clock');
});

function workbenchContext(){
  const d=dom(),main=d.seed('main');main.className='main';const analytics=d.seed('analytics','div',main);analytics.className='view';analytics.dataset.view='analytics';const requests=[];
  const request=kind=>{const task=deferred();requests.push({kind,...task});return task.promise;};
  const {c,messages}=browser(d,{ME:{id:0,name:'Admin',role:'admin'},NAV_DEF:{admin:[],designer:[]},v33Period:'month',v33Offset:0,v33EnsureAnalyticsView(){},renderNav(){},switchView(v){c.currentView=v;},renderStaff(){},renderHotelOverview(){},openProfileEdit(){},api:{cases:{listArchived:()=>request('ledger')},analytics:{get:()=>request('analytics')}}});
  vm.runInContext(extension,c);return {c,d,requests,messages};
}
const analyticsData=()=>({period:{label:'Newest period',start:'2026-10-01',end:'2026-11-01'},cases:[],perStaff:[],totals:{count:0,score:0,onTimeRate:null},workCases:[]});
const ledgerData=()=>[{id:'LATEST',title:'Latest project',hotel:'Hotel',requester:'Marketing',designer:{id:1,name:'Designer'},collaborators:[],status:'doing'}];
for(const kind of ['ledger','analytics'])for(const lateFailure of [false,true])await test('F11 older '+kind+' '+(lateFailure?'failure':'success')+' cannot overwrite latest success',async()=>{
  const {c,d,requests}=workbenchContext();let first,second;
  if(kind==='analytics'){c.currentView='analytics';first=c.renderAnalytics();c.v33Offset=-1;second=c.renderAnalytics();}else{c.wbOpenCases();c.wbOpenCases();}
  assert.equal(requests.length,2);requests[1].resolve(kind==='analytics'?analyticsData():ledgerData());if(second)await second;await flush();
  const selector=kind==='analytics'?'[data-analytics-content]':'[data-ledger]',marker=kind==='analytics'?'部門完成案件':'Latest project';assert(d.document.querySelector(selector).textContent.includes(marker));
  if(lateFailure)requests[0].reject(Error('Obsolete request failed'));else requests[0].resolve(kind==='analytics'?{...analyticsData(),period:{label:'Old period',start:'2026-09-01',end:'2026-10-01'},totals:{count:999,score:999,onTimeRate:null}}:[]);
  if(first)await first;await flush();const content=d.document.querySelector(selector).textContent;assert(content.includes(marker),'latest rendered result remains visible');assert(!content.includes('Obsolete request failed'));if(kind==='analytics')assert.equal(d.document.querySelector('[data-period-label]').textContent,'Newest period');
});
for(const kind of ['ledger','analytics'])await test('F11 current '+kind+' failure remains visible and retry can succeed',async()=>{
  const {c,d,requests}=workbenchContext();let pending;
  if(kind==='analytics'){c.currentView='analytics';pending=c.renderAnalytics();}else c.wbOpenCases();requests[0].reject(Error('Current unavailable'));if(pending)await pending;await flush();const selector=kind==='analytics'?'[data-analytics-content]':'[data-ledger]';assert.match(d.document.querySelector(selector).textContent,/失敗/);
  const retry=d.document.querySelector(kind==='analytics'?'[data-refresh]':'[data-reload]').click();requests[1].resolve(kind==='analytics'?analyticsData():ledgerData());await retry;await flush();assert(d.document.querySelector(selector).textContent.includes(kind==='analytics'?'部門完成案件':'Latest project'));
});

function csvContext(){
  const d=dom(),writes=[];for(const id of ['v34-csv-filename','v34-csv-clear','v34-csv-result','v34-csv-preview','v34-csv-tbody','v34-csv-rowcount','v34-csv-selected','v34-csv-issues'])d.seed(id);d.seed('v34-csv-submit','button');
  const {c,messages}=browser(d,{STAFF:[{id:1,name:'Designer',active:true},{id:2,name:'Known collaborator',active:true}],v34CsvRows:[],reloadAllCases:async()=>{},refreshAll(){},api:{cases:{async bulkImport(body){writes.push(body);return {summary:{total:body.rows.length,created:body.rows.length,failed:0},errors:[]};}}}});
  vm.runInContext(section('function v34ParseCsv(text)','// Hook switchView for \'import\''),c);
  const load=csv=>c.v34HandleCsvFile({target:{files:[{name:'fixture.csv',size:csv.length,text:async()=>csv}]}});
  return {c,d,writes,messages,load};
}
await test('F12 all canonical CSV statuses survive normalization and import unchanged',async()=>{
  const {c,load,writes}=csvContext(),statuses=['todo','wait','doing','review','review_done','print','done','closed','cancelled'];
  await load('title,designerName,status,cancelReason,cancelStage,cancelledOn\n'+statuses.map(status=>'Fixture '+status+',Designer,'+status+(status==='cancelled'?',需求方取消,doing,2026-10-22':',,,')).join('\n'));
  assert.deepEqual(plain(c.v34CsvRows.map(r=>r.status)),statuses);assert(c.v34CsvRows.every(r=>!r._skip&&r._issues.length===0));await c.v34SubmitImport();assert.equal(writes.length,1);assert.deepEqual(plain(writes[0].rows.map(r=>r.status)),statuses);assert.equal(writes[0].rows.at(-1).cancelReason,'需求方取消');assert.equal(writes[0].rows.at(-1).cancelStage,'doing');assert.equal(writes[0].rows.at(-1).cancelledOn,'2026-10-22');
});
await test('F12 unknown CSV status is shown as an issue and defaults to unselected',async()=>{
  const {c,d,load,writes}=csvContext();await load('title,designerName,status\nFixture,Designer,unexpected_status');const row=c.v34CsvRows[0];
  assert.notEqual(row.status,'todo','unknown status must never silently reopen a case');assert(row._issues.length,'unknown status requires preview validation');assert(row._skip);assert.match(d.get('v34-csv-tbody').textContent,/unexpected_status/);assert.equal(d.get('v34-csv-selected').textContent,'0');await c.v34SubmitImport();assert.equal(writes.length,0);
  const checkbox=d.get('v34-csv-tbody').querySelector('.v34-csv-skip');checkbox.checked=true;checkbox.onchange();await c.v34SubmitImport();assert.equal(writes.length,0,'explicitly selecting an invalid status cannot bypass validation');
});
await test('D8 unknown collaborator is a visible validation issue and is not silently imported',async()=>{
  const {c,d,load,writes}=csvContext();await load('title,designerName,collaboratorNames,status\nFixture,Designer,Known collaborator;Missing person,doing');const row=c.v34CsvRows[0];
  assert(row._issues.some(s=>s.includes('Missing person')),'unknown collaborator name is explained');assert(row._skip);assert(d.get('v34-csv-tbody').textContent.includes('Missing person'));await c.v34SubmitImport();assert.equal(writes.length,0);
  const checkbox=d.get('v34-csv-tbody').querySelector('.v34-csv-skip');checkbox.checked=true;checkbox.onchange();await c.v34SubmitImport();assert.equal(writes.length,0,'explicitly selecting an unknown collaborator cannot drop that person and import the row');
});
await test('D8/F12 editing the designer cannot erase unrelated CSV validation issues',async()=>{
  const {c,d,load}=csvContext();await load('title,designerName,collaboratorNames,status\nFixture,Designer,Missing person,unexpected_status');const input=d.get('v34-csv-tbody').querySelector('.v34-csv-designer');input.value='Designer';input.onchange();const row=c.v34CsvRows[0];
  assert(row._issues.some(s=>s.includes('Missing person')));assert(row._issues.some(s=>s.includes('unexpected_status')));assert(row._skip);
});
await test('D8 known collaborator names remain in a benign selected import',async()=>{
  const {c,load,writes}=csvContext();await load('title,designerName,collaboratorNames,status\nFixture,Designer,Known collaborator,doing');assert.equal(c.v34CsvRows[0]._issues.length,0);assert.equal(c.v34CsvRows[0]._skip,false);await c.v34SubmitImport();assert.deepEqual(plain(writes[0].rows[0].collaboratorNames),['Known collaborator']);
});
for(const status of ['constructor','toString','__proto__'])await test('F12 inherited object key '+status+' is rejected before the real JSON request boundary',async()=>{
  const {c,d,load}=csvContext(),wire=[];c.AbortController=AbortController;
  c.fetch=async(url,opts)=>{wire.push({url,body:JSON.parse(opts.body)});return {ok:true,status:200,text:async()=>JSON.stringify({summary:{total:1,created:1,failed:0},created:[{rowIndex:0,id:'synthetic',title:'Fixture',designer:'Designer'}],errors:[]})};};
  // The shipped adapter performs JSON.stringify. fetch above is an inert recorder.
  vm.runInContext(section('const JSON_HEADERS =','window.api ='),c);
  c.api.cases.bulkImport=body=>c.fetchJson('POST','/api/cases/bulk-import',body);
  await load('title,designerName,status\nFixture,Designer,'+status);const row=c.v34CsvRows[0];
  await c.v34SubmitImport();
  assert.equal(wire.length,0,'unknown '+status+' reached the JSON wire: '+JSON.stringify(wire));
  assert(row._issues.some(s=>s.includes(status)),'preview must identify the unknown status');assert(row._skip);assert(d.get('v34-csv-tbody').textContent.includes(status));
});
console.log(JSON.stringify({passed,failed,sourceRoot:root,liveNetwork:false,productionWrites:0,syntheticPayloadExecuted:false,benignHandlerCallbacksExercised:true}));
if(failed)process.exitCode=1;
