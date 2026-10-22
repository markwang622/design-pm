import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run the actual browser helpers in isolation; no browser or database writes.
const root=process.env.DESIGN_PM_ROOT || new URL('../',import.meta.url).pathname;
const html=fs.readFileSync(root+'/public/index.html','utf8');
const section=(start,end)=>{
  const a=html.indexOf(start),b=html.indexOf(end,a);
  assert(a>=0&&b>a,'source section found: '+start);
  return html.slice(a,b);
};
const dates=section('function d(y, m, dd)', '// ============== Staff & domain constants');
const normalize=section('function normalizeCase(b)', 'function ymdIso(dt)');
const decorate=section('function decorateCase(c)', 'function decorateCases()');
const opener=section('const _v38OrigOpenDrawerById', '// Fix 3: Dashboard');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const fixture=(id='ARCHIVED')=>({id,title:'Archived project',requester:'',status:'closed',archived:true,goLiveDate:'2026-09-25',openDate:'2026-08-01',designer:{id:1,name:'Designer'},collaborators:[{id:2,name:'Collaborator'}],logs:[]});
function setup(getOne){
  const shown=[],messages=[],closed=[];
  const c={console,Date,Set,CASES:[{id:'ACTIVE',status:'doing',archived:false}],currentView:'unitAnalysis',currentCase:null,
    ENDED_STATUS_KEYS:new Set(['done','closed']),
    api:{cases:{getOne}},
    openDrawer(caseData){shown.push(caseData);c.currentCase=caseData;},
    openDrawerById(){},showToast(text){messages.push(text);},v92CloseDrawer(){closed.push(true);}};
  c.window=c;vm.createContext(c);vm.runInContext(dates+normalize+decorate+opener,c);
  return{c,shown,messages,closed};
}
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
await test('archived blank-unit case loads with dates and stays outside active cache',async()=>{
  const {c,shown,closed}=setup(async id=>fixture(id));await c.openDrawerById('ARCHIVED');
  assert.equal(shown.length,1);const v=shown[0];assert.equal(v.id,'ARCHIVED');assert.equal(v.unit,'');assert.equal(v.archived,true);assert.equal(v.status,'closed');
  assert(v.reviewDate instanceof Date);assert(v.proofStart instanceof Date);assert.equal(v.reviewDate.getDay(),2);assert.equal(v.proofStart.getDay(),5);
  assert.equal(v._collaboratorIds[0],2);assert.equal(c.CASES.length,1);assert.equal(closed.length,1);
});
await test('cached active case opens without an unnecessary API request',async()=>{
  let requests=0;const {c,shown}=setup(async()=>{requests++;});await c.openDrawerById('ACTIVE');assert.equal(requests,0);assert.equal(shown[0],c.CASES[0]);
});
await test('only a true 404 is described as a missing case',async()=>{
  for(const [err,pattern]of [[{status:404},/找不到案件/],[{status:403},/沒有權限/],[new Error('offline'),/無法載入/]]){
    const {c,messages,shown}=setup(async()=>{throw err;});await c.openDrawerById('ARCHIVED');assert.equal(shown.length,0);assert.equal(messages.length,1);assert.match(messages[0],pattern);
  }
  const {c,messages}=setup(async()=>{throw{status:401,authExpired:true};});await c.openDrawerById('ARCHIVED');assert.equal(messages.length,0);
});
await test('a late archived response cannot replace a newer cached active case',async()=>{
  const d=deferred(),{c,shown}=setup(()=>d.promise);const pending=c.openDrawerById('ARCHIVED');await c.openDrawerById('ACTIVE');d.resolve(fixture());await pending;assert.deepEqual(shown.map(v=>v.id),['ACTIVE']);
});
await test('a late archived response cannot replace another direct drawer selection',async()=>{
  const d=deferred(),{c,shown}=setup(()=>d.promise);const pending=c.openDrawerById('ARCHIVED');await c.openDrawer({id:'DIRECT'});d.resolve(fixture());await pending;assert.deepEqual(shown.map(v=>v.id),['DIRECT']);
});
await test('latest of two archived requests wins regardless of response order',async()=>{
  const a=deferred(),b=deferred(),{c,shown}=setup(id=>id==='OLD'?a.promise:b.promise);const old=c.openDrawerById('OLD'),next=c.openDrawerById('NEW');b.resolve(fixture('NEW'));await next;a.resolve(fixture('OLD'));await old;assert.deepEqual(shown.map(v=>v.id),['NEW']);
});
await test('navigation suppresses pending archived drawer and stale error messages',async()=>{
  for(const fail of [false,true]){
    const d=deferred(),{c,shown,messages}=setup(()=>d.promise);const pending=c.openDrawerById('ARCHIVED');c.currentView='dashboard';if(fail)d.reject({status:404});else d.resolve(fixture());await pending;assert.equal(shown.length,0);assert.equal(messages.length,0);
  }
});
console.log(JSON.stringify({passed,liveDatabase:false,caseWrites:0}));
