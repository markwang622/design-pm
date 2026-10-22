import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const root=process.env.DESIGN_PM_ROOT || new URL('../',import.meta.url).pathname;
const require=createRequire(root+'/package.json');
const express=require('express'), cookieParser=require('cookie-parser');
process.env.JWT_SECRET='isolated-stability-test-secret';
process.env.APP_BASE_URL='https://artdesign-for-demo.zeabur.app';
const {prisma}=await import(root+'/src/lib/db.js');
const {signToken}=await import(root+'/src/middleware/auth.js');
let failModel='',protectedCalls=0,writes=0;
const user={id:1,name:'Fixture admin',email:'admin@fixture.invalid',role:'admin',active:true,pendingActivation:false,sessionVersion:0};
prisma.staff.findUnique=async args=>{
  if(args.select?.sessionVersion)return user;
  protectedCalls++;if(failModel==='staff')throw Error('simulated private DB failure');return user;
};
prisma.staff.findFirst=async()=>{protectedCalls++;if(failModel==='staff')throw Error('simulated private DB failure');return null;};
for(const name of ['staff','case','hotel','requestUnit','vacation','businessTrip','shoot','meeting','notification']){
  prisma[name].findMany=async()=>{protectedCalls++;if(failModel===name)throw Error('simulated private DB failure');return[];};
  if(name!=='staff')prisma[name].findUnique=async()=>{protectedCalls++;if(failModel===name)throw Error('simulated private DB failure');return null;};
  for(const method of ['create','update','updateMany','delete','deleteMany'])prisma[name][method]=async()=>{writes++;throw Error('unexpected write');};
}
const app=express();app.use(express.json({limit:'1kb'}),cookieParser());
const {safeRouter}=await import(root+'/src/lib/safeRouter.js');
const probe=safeRouter(),nested=safeRouter();
probe.get('/plain-promise',(_req,_res)=>Promise.reject(Error('plain promise failure')));
probe.get('/nested-arrays',[[async(_req,_res)=>{throw Error('nested array failure');}]]);
nested.get('/ok',(_req,res)=>res.json({nested:true}));probe.use('/nested',nested);
probe.get('/error-chain',(_req,_res,next)=>next(Error('first failure')));
probe.use(async function(err,_req,_res,_next){throw Error('error middleware rejection');});
app.use('/probe',probe);
for(const [url,file]of [['auth','auth'],['cases','cases'],['staff','staff'],['hotels','hotels'],['units','units'],['vacations','vacations'],['business-trips','businessTrips'],['shoots','shoots'],['meetings','meetings'],['notifications','notifications']]){
  const {default:router}=await import(root+'/src/routes/'+file+'.js');app.use('/api/'+url,router);
}
app.get('/healthz',(_req,res)=>res.json({ok:true}));
// Exercise the real application's final error middleware without starting it.
const source=fs.readFileSync(root+'/src/index.js','utf8');
const start=source.indexOf('app.use((err,'),end=source.indexOf('const PORT',start);
assert(start>=0&&end>start,'application error middleware found');
vm.runInNewContext(source.slice(start,end),{app,console:{error(){}}});
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const base='http://127.0.0.1:'+server.address().port,cookie='designpm_token='+signToken(user);
const unhandled=[];const record=e=>unhandled.push(e);process.on('unhandledRejection',record);
const call=async(path,{method='GET',body,raw,auth=true}={})=>{
  const r=await fetch(base+path,{method,signal:AbortSignal.timeout(2000),headers:{...(auth?{Cookie:cookie}:{}),...(body||raw?{'Content-Type':'application/json'}:{})},body:raw??(body?JSON.stringify(body):undefined)});
  return{status:r.status,text:await r.text()};
};
let passed=0;const test=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
try{
  await test('ordinary promise handlers and async error middleware reach the final error handler',async()=>{
    assert.equal((await call('/probe/plain-promise')).status,500);
    assert.equal((await call('/probe/error-chain')).status,500);
  });
  await test('nested handler arrays cannot leak async rejections',async()=>{assert.equal((await call('/probe/nested-arrays')).status,500);});
  await test('nested routers retain their mounted path semantics',async()=>{const r=await call('/probe/nested/ok');assert.equal(r.status,200);assert.equal(JSON.parse(r.text).nested,true);});
  for(const [path,model]of [['cases','case'],['staff','staff'],['hotels','hotel'],['units','requestUnit'],['vacations','vacation'],['business-trips','businessTrip'],['shoots','shoot'],['meetings','meeting'],['notifications','notification']]){
    await test(path+' DB failure returns 500 and the server remains responsive',async()=>{
      failModel=model;const r=await call('/api/'+path);assert.equal(r.status,500);assert(!r.text.includes('private DB failure'));failModel='';assert.equal((await call('/healthz')).status,200);assert.equal((await call('/api/'+path)).status,200);
    });
  }
  await test('login database failure is contained without leaking private details',async()=>{
    failModel='staff';const r=await call('/api/auth/login',{method:'POST',body:{email:'admin@fixture.invalid',password:'FixturePassword9'}});failModel='';assert.equal(r.status,500);assert(!r.text.includes('private DB failure'));assert.equal((await call('/healthz')).status,200);
  });
  for(const [path,method,suffix]of [['staff','PATCH',''],['hotels','PATCH',''],['units','PATCH',''],['vacations','PATCH',''],['business-trips','PATCH',''],['shoots','PATCH',''],['meetings','PATCH',''],['notifications','POST','/read']]){
    await test(path+' invalid numeric identifiers are rejected before any model access',async()=>{
      for(const id of ['abc','NaN','Infinity','0','-1','1.5','9007199254740992']){
        const before=protectedCalls;const r=await call('/api/'+path+'/'+id+suffix,{method,body:{}});assert.equal(r.status,400,id+': '+r.text);assert.equal(protectedCalls,before,'invalid '+id+' reached a model');
      }
    });
  }
  await test('string case identifiers retain their original routing semantics',async()=>{assert.equal((await call('/api/cases/C-2026-09-002')).status,404);});
  await test('malformed JSON is a bounded 400 response and subsequent requests work',async()=>{assert.equal((await call('/api/auth/login',{method:'POST',raw:'{"bad":'})).status,400);assert.equal((await call('/healthz')).status,200);});
  await test('oversized JSON is a bounded 413 response',async()=>{assert.equal((await call('/api/auth/login',{method:'POST',body:{large:'x'.repeat(2000)}})).status,413);});
  await test('error middleware delegates after headers are sent',async()=>{
    let handler;vm.runInNewContext(source.slice(start,end),{app:{use(fn){handler=fn;}},console:{error(){}}});let forwarded;const error=Error('sent');handler(error,{}, {headersSent:true,status(){throw Error('must not send twice');}},e=>{forwarded=e;});assert.equal(forwarded,error);
  });
  assert.equal(unhandled.length,0,'no unhandled rejections');assert.equal(writes,0,'no data writes');
  console.log(JSON.stringify({passed,unhandled:unhandled.length,writes,liveDatabase:false}));
}finally{process.off('unhandledRejection',record);server.closeAllConnections();await new Promise(r=>server.close(r));await prisma.$disconnect();}
