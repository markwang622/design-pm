import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const express=require('express'),cookieParser=require('cookie-parser');
process.env.JWT_SECRET='isolated-demo-copy-tests';process.env.APP_BASE_URL='https://artdesign-for-demo.zeabur.app';
const baseDir=new URL('../',import.meta.url).href;
const {prisma}=await import(baseDir+'src/lib/db.js');
const {Prisma}=require('@prisma/client');
const {signToken}=await import(baseDir+'src/middleware/auth.js');
const {default:router}=await import(baseDir+'src/routes/demoData.js');
let store={staff:[{id:10,name:'Existing admin',email:'admin@demo.invalid',role:'admin',active:true,pendingActivation:false,sessionVersion:0},{id:20,name:'Existing member',email:'member@demo.invalid',role:'member',active:true,pendingActivation:false,sessionVersion:0}],cases:[{id:'KEEP',title:'existing demo fixture'}],hotels:[{id:1,name:'Hotel',region:'Old',sortOrder:1,active:true}],units:[{id:1,name:'Unit',sortOrder:1,active:true}]};
let writes=0,forceFailure=false;
prisma.staff.findUnique=async({where})=>store.staff.find(s=>s.id===where.id)||null;
prisma.staff.findMany=async()=>store.staff;
prisma.staff.create=async({data})=>{writes++;const s={id:100+store.staff.length,...data};store.staff.push(s);return s;};
prisma.case.findMany=async()=>store.cases;
prisma.case.create=async({data})=>{
  if(forceFailure)throw Error('simulated insert failure');
  for(const k of ['items','logs','deliverables'])if(k in data)assert.notEqual(data[k],null,'Prisma nullable Json must use DbNull');
  writes++;store.cases.push(data);return data;
};
for(const [model,key]of [['hotel','hotels'],['requestUnit','units']]){
  prisma[model].findMany=async()=>store[key];
  prisma[model].upsert=async({where,create,update})=>{writes++;let row=store[key].find(r=>r.name===where.name);if(row)Object.assign(row,update);else{row={id:store[key].length+1,...create};store[key].push(row);}return row;};
}
prisma.$transaction=async fn=>{const snapshot=structuredClone(store);try{return await fn(prisma);}catch(e){store=snapshot;throw e;}};
const app=express();app.use(express.json({limit:'1mb'}),cookieParser());app.use('/copy',router);app.use((e,_req,res,_next)=>res.status(500).json({error:'test_failure',message:e.message}));
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
const cookie=id=>'designpm_token='+signToken({id,role:id===10?'admin':'member',sessionVersion:0});
const post=async(path,body,auth=cookie(10))=>{const r=await fetch(base+'/copy/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Cookie:auth}:{})},body:JSON.stringify(body)});return{status:r.status,data:await r.json()};};
const day='2026-10-01T00:00:00.000Z';
const payload={sourceOrigin:'https://artdesign.zeabur.app',staff:[1,2].map(id=>({id,name:'Source '+id,joined:day,seniority:'mid',active:true,departedOn:null})),hotels:[{name:'Hotel',region:'New',sortOrder:9,active:true}],units:[{name:'Unit',sortOrder:7,active:true}],cases:[{id:'KEEP',title:'must not overwrite',designerId:1},{id:'CASE-ONE',title:'Source case',designerId:1,createdById:2,collaborators:[{id:2}],level:'A',status:'doing',note:'work',openDate:day,dispatchDate:day,goLiveDate:day,items:[{n:'Child',assigneeId:2,owner:'Source 2'}],logs:[{by:'Source 1',note:'progress',date:'2026-10-01'}],deliverables:null},{id:'CASE-TWO',title:'Archived case',designerId:2,createdById:null,collaborators:[],level:'B',status:'closed',archived:true,openDate:day,dispatchDate:day,goLiveDate:day,closedOn:day,items:null,logs:null,deliverables:[]}]};
// REPORTS-P1-C1: a same-version source export (GET /api/cases) carries delivery markers; legacy cases have none.
// REPORTS-P2-D1a: the same export also carries schedule markers (legacy, no schedule requests).
// REPORTS-P2-D1b: … and lifecycle markers (legacy, no cycles or seal/resume requests).
for(const c of payload.cases)Object.assign(c,{deliveryMode:'legacy',scheduleMode:'legacy',lifecycleMode:'legacy',_count:{deliveries:0,deliverySubmissions:0,scheduleRequests:0,cycles:0,lifecycleRequests:0}});
const phrase='COPY PRODUCTION PROJECT DATA TO DEMO';let pass=0;
const test=async(name,fn)=>{await fn();pass++;console.log('PASS '+name);};
try{
  await test('disabled on production origin',async()=>{process.env.APP_BASE_URL='https://artdesign.zeabur.app';assert.equal((await post('preview',payload)).status,404);process.env.APP_BASE_URL='https://artdesign-for-demo.zeabur.app';});
  await test('requires authenticated admin',async()=>{assert.equal((await post('preview',payload,null)).status,401);assert.equal((await post('preview',payload,cookie(20))).status,403);});
  await test('rejects credentials at any depth',async()=>{const p=structuredClone(payload);p.cases[1].items[0].resetToken='do-not-copy';assert.equal((await post('preview',p)).status,400);assert.equal(writes,0);});
  await test('C1: records-mode or evidence-bearing sources are refused explicitly, never stripped into legacy',async()=>{
    for(const mutate of [c=>{c.deliveryMode='records';},c=>{c._count.deliveries=2;},c=>{c._count.deliverySubmissions=1;},c=>{c.pendingDeliverySubmissionId='sub-pending-0001';},c=>{c.deliveries=[];}]){
      const p=structuredClone(payload);mutate(p.cases[1]);const check=await post('preview',p);
      assert.equal(check.status,200);assert.equal(check.data.ok,false);assert(check.data.errors.some(e=>e.code==='delivery_records_not_supported'&&e.cases.includes(p.cases[1].id)));
      const r=await post('import',{...p,confirm:phrase,digest:check.data.digest});assert.notEqual(r.status,200);
    }
    assert.equal(writes,0);
  });
  await test('D1a: schedule-managed or schedule-history sources are refused; missing schedule markers too',async()=>{
    for(const mutate of [c=>{c.scheduleMode='managed';},c=>{c._count.scheduleRequests=1;},c=>{c.pendingScheduleRequestId='sched-pending-01';},c=>{c.scheduleBaseline={};},c=>{c.scheduleRequests=[];}]){
      const p=structuredClone(payload);mutate(p.cases[1]);const check=await post('preview',p);
      assert.equal(check.status,200);assert.equal(check.data.ok,false);assert(check.data.errors.some(e=>e.code==='schedule_history_not_supported'&&e.cases.includes(p.cases[1].id)));
      const r=await post('import',{...p,confirm:phrase,digest:check.data.digest});assert.notEqual(r.status,200);
    }
    for(const strip of [c=>{delete c.scheduleMode;},c=>{delete c._count.scheduleRequests;}]){
      const p=structuredClone(payload);strip(p.cases[1]);const check=await post('preview',p);
      assert.equal(check.data.ok,false);assert(check.data.errors.some(e=>e.code==='schedule_markers_missing'));
    }
    assert.equal(writes,0);
  });
  await test('D1b: lifecycle-managed or cycle/seal-history sources are refused; missing lifecycle markers too',async()=>{
    for(const mutate of [c=>{c.lifecycleMode='managed';},c=>{c._count.cycles=1;},c=>{c._count.lifecycleRequests=1;},c=>{c.currentCycleId='cycle-0000-0001';},c=>{c.lifecycleStatus='sealed_incomplete';},c=>{c.cycles=[];}]){
      const p=structuredClone(payload);mutate(p.cases[1]);const check=await post('preview',p);
      assert.equal(check.status,200);assert.equal(check.data.ok,false);assert(check.data.errors.some(e=>e.code==='lifecycle_history_not_supported'&&e.cases.includes(p.cases[1].id)));
      const r=await post('import',{...p,confirm:phrase,digest:check.data.digest});assert.notEqual(r.status,200);
    }
    for(const strip of [c=>{delete c.lifecycleMode;},c=>{delete c._count.cycles;},c=>{delete c._count.lifecycleRequests;}]){
      const p=structuredClone(payload);strip(p.cases[1]);const check=await post('preview',p);
      assert.equal(check.data.ok,false);assert(check.data.errors.some(e=>e.code==='lifecycle_markers_missing'));
    }
    assert.equal(writes,0);
  });
  await test('C1: sources without delivery markers cannot be classified and are refused',async()=>{
    for(const strip of [c=>{delete c.deliveryMode;},c=>{delete c._count;},c=>{c._count={deliveries:'0'};}]){
      const p=structuredClone(payload);strip(p.cases[0]);const check=await post('preview',p);
      assert.equal(check.data.ok,false);assert(check.data.errors.some(e=>e.code==='delivery_markers_missing'));
    }
    assert.equal(writes,0);
  });
  const preview=await post('preview',payload);
  await test('preview is read-only and reports skips/dictionary changes',()=>{assert.equal(preview.status,200);assert.equal(preview.data.ok,true);assert.equal(preview.data.counts.cases.import,2);assert.equal(preview.data.counts.cases.skippedExisting,1);assert.equal(preview.data.hotelsUpdate.length,1);assert.equal(writes,0);});
  await test('unknown staff reference blocks whole import',async()=>{const p=structuredClone(payload);p.cases[1].items[0].assigneeId=999;const check=await post('preview',p);assert.equal(check.data.ok,false);const r=await post('import',{...p,confirm:phrase,digest:check.data.digest});assert.equal(r.status,409);assert.equal(writes,0);});
  await test('duplicate source ids and names are rejected before writing',async()=>{const p=structuredClone(payload);p.staff[1].id=1;const r=await post('preview',p);assert.equal(r.data.ok,false);assert.equal(writes,0);});
  await test('requires confirmation and matching digest',async()=>{assert.equal((await post('import',{...payload,digest:preview.data.digest})).status,400);assert.equal((await post('import',{...payload,confirm:phrase,digest:'bad'})).status,409);assert.equal(writes,0);});
  await test('transaction rollback leaves original records unchanged',async()=>{const snapshot=JSON.stringify(store);forceFailure=true;const r=await post('import',{...payload,confirm:phrase,digest:preview.data.digest});forceFailure=false;assert.equal(r.status,500);assert.equal(JSON.stringify(store),snapshot);});
  await test('imports full case data and maps all staff links without account access',async()=>{
    const r=await post('import',{...payload,confirm:phrase,digest:preview.data.digest});assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.casesImported,2);
    assert.equal(store.cases.find(c=>c.id==='KEEP').title,'existing demo fixture');
    const one=store.staff.find(s=>s.email==='source-1@demo.invalid'),two=store.staff.find(s=>s.email==='source-2@demo.invalid');
    for(const s of [one,two]){assert.equal(s.pendingActivation,true);assert.equal(s.role,'member');assert.equal(s.activationTokenHash,null);assert.equal(s.resetTokenHash,null);assert.match(s.password,/^\$2[aby]\$12\$/);}
    const c=store.cases.find(c=>c.id==='CASE-ONE');assert.equal(c.designer.connect.id,one.id);assert.equal(c.createdBy.connect.id,two.id);assert.equal(c.collaborators.connect[0].id,two.id);assert.equal(c.items[0].assigneeId,two.id);assert.equal(c.logs[0].note,'progress');assert.equal(c.deliverables,Prisma.DbNull);
    assert.equal(store.staff[0].email,'admin@demo.invalid');assert.equal(store.hotels[0].sortOrder,9);
  });
  await test('repeat import skips existing cases and reuses aliases',async()=>{const r=await post('preview',payload);assert.equal(r.data.counts.cases.import,0);assert.equal(r.data.counts.staff.create,0);assert.equal(r.data.counts.staff.reuse,2);const result=await post('import',{...payload,confirm:phrase,digest:r.data.digest});assert.equal(result.status,200);assert.equal(result.data.casesImported,0);assert.equal(store.cases.length,3);});
  console.log(JSON.stringify({passed:pass,liveDatabase:false,emailsSent:false}));
}finally{await new Promise(r=>server.close(r));await prisma.$disconnect();}
