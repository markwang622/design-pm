import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root=process.env.DESIGN_PM_ROOT||new URL('../',import.meta.url).pathname;
const source=fs.readFileSync(root+'/public/index.html','utf8');
const a=source.indexOf('const JSON_HEADERS'),b=source.indexOf('window.api =',a);
assert(a>=0&&b>a,'actual request helper found');
function setup(fetch,observer=false){
  const timers=new Map(),messages=[],redirects=[];let calls=0,serial=0;
  const c={AbortController,JSON,console,IS_OBSERVER:()=>observer,
    fetch:async(...args)=>{calls++;return fetch(...args);},
    setTimeout(fn,delay){const id=++serial;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);},
    showToast(text){messages.push(text);},location:{replace(url){redirects.push(url);}}};
  c.window=c;vm.createContext(c);vm.runInContext(source.slice(a,b),c);
  return{c,timers,messages,redirects,calls:()=>calls};
}
const response=(status,body)=>({ok:status>=200&&status<300,status,text:async()=>body});
let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
await test('normal JSON request clears its timer and keeps cookie authentication',async()=>{
  const {c,timers}=setup(async(_url,opts)=>{assert.equal(opts.credentials,'include');assert(opts.signal);return response(200,'{"ok":true}');});
  assert.equal((await c.fetchJson('GET','/api/cases')).ok,true);assert.equal(timers.size,0);
});
await test('a hanging request times out without resending a write',async()=>{
  const {c,timers,calls}=setup((_url,opts)=>new Promise((_resolve,reject)=>opts.signal.addEventListener('abort',()=>{const e=Error('aborted');e.name='AbortError';reject(e);})));const pending=c.fetchJson('PATCH','/api/cases/ONE',{});
  const check=assert.rejects(pending,e=>e.timeout===true&&e.data.error==='timeout'&&/逾時/.test(e.message));
  assert.equal([...timers.values()][0].delay,30000);[...timers.values()][0].fn();await check;assert.equal(calls(),1);assert.equal(timers.size,0);
});
await test('timeout also bounds response-body reading',async()=>{
  let bodyStarted;const started=new Promise(resolve=>{bodyStarted=resolve;});
  const {c,timers}=setup(async(_url,opts)=>({ok:true,status:200,text:()=>new Promise((_r,reject)=>{opts.signal.addEventListener('abort',()=>{const e=Error();e.name='AbortError';reject(e);});bodyStarted();})}));
  const pending=c.fetchJson('GET','/api/cases');const check=assert.rejects(pending,e=>e.timeout===true);await started;[...timers.values()][0].fn();await check;assert.equal(timers.size,0);
});
await test('proxy HTML and malformed success payloads give bounded readable errors',async()=>{
  for(const status of [200,502]){
    const {c,timers}=setup(async()=>response(status,'<html>private upstream diagnostic</html>'));
    await assert.rejects(c.fetchJson('GET','/api/cases'),e=>e.data.error==='bad_response'&&!e.message.includes('private'));assert.equal(timers.size,0);
  }
});
await test('network failures clear their timer and do not expose internal details',async()=>{
  const {c,timers,calls}=setup(async()=>{throw Error('private network diagnostic');});await assert.rejects(c.fetchJson('GET','/api/cases'),e=>e.data.error==='network'&&!e.message.includes('private'));assert.equal(calls(),1);assert.equal(timers.size,0);
});
await test('observer write prevention occurs before starting a network request',async()=>{
  const {c,timers,calls}=setup(async()=>response(200,'{}'),true);await assert.rejects(c.fetchJson('PATCH','/api/cases/ONE',{}),e=>e.status===403);assert.equal(calls(),0);assert.equal(timers.size,0);
});
await test('expired sessions preserve the single login redirect path',async()=>{
  const {c,timers,messages,redirects}=setup(async()=>response(401,'{"error":"session_expired"}'));
  await assert.rejects(c.fetchJson('GET','/api/cases'),e=>e.authExpired===true);assert.equal(messages.length,1);assert.equal(timers.size,1);[...timers.values()][0].fn();assert.equal(redirects[0],'/login');
});
await test('wrong current password remains a form error rather than a session-expiry redirect',async()=>{
  const {c,messages,timers}=setup(async()=>response(401,'{"error":"wrong_current_password"}'));await assert.rejects(c.fetchJson('POST','/api/auth/change-password',{}),e=>e.status===401&&!e.authExpired);assert.equal(messages.length,0);assert.equal(timers.size,0);
});
await test('unserializable request data cannot leave a timeout running',async()=>{
  const {c,timers,calls}=setup(async()=>response(200,'{}'));const circular={};circular.self=circular;await assert.rejects(c.fetchJson('POST','/api/cases',circular));assert.equal(calls(),0);assert.equal(timers.size,0);
});
// Run both original template expressions against a legacy/future status.
await test('unknown status is rendered safely in the drawer and transfer templates',()=>{
  const lines=source.split('\n').filter(line=>line.includes('STATUSES.find(s=>s.key===c.status)')&&line.includes('status-${escapeHtml(c.status)}'));
  assert.equal(lines.length,2);const escapeStart=source.indexOf('function escapeHtml(s)'),escapeEnd=source.indexOf('\n}',escapeStart)+2;
  for(const line of lines){
    const expression='`'+line.match(/<span class="chip status-.*?<\/span>/)[0]+'`';let result;
    const c={STATUSES:[],c:{status:'legacy"><img src=x>',name:'Legacy',level:'C',urgent:false},capture(value){result=value;}};vm.createContext(c);vm.runInContext(source.slice(escapeStart,escapeEnd)+'\ncapture('+expression+');',c);
    assert.match(result,/legacy/);assert(!result.includes('<img'));assert(result.includes('&lt;img'));
  }
});
console.log(JSON.stringify({passed,liveNetwork:false,caseWrites:0}));
