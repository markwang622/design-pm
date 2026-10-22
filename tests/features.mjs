// Isolated HTTP integration tests. In-memory Prisma methods; no live DB or email.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const express=require('express'),cookieParser=require('cookie-parser'),bcrypt=require('bcryptjs');
process.env.JWT_SECRET='isolated-feature-tests-only';
delete process.env.SMTP_HOST;delete process.env.SMTP_USER;delete process.env.SMTP_PASS;
process.env.APP_BASE_URL='https://example.test';
const root=new URL('../',import.meta.url).href;
const {prisma}=await import(root+'src/lib/db.js');
const {signToken,requireAuth}=await import(root+'src/middleware/auth.js');
const {resolvePeriod,taipeiCalendarDay}=await import(root+'src/services/analytics.js');
const {workIntervalWhere}=await import(root+'src/lib/workInterval.js');
const {caseEditPermission}=await import(root+'src/lib/casePermissions.js');
const {hashToken}=await import(root+'src/lib/activation.js');
const auth=(await import(root+'src/routes/auth.js')).default;
const cases=(await import(root+'src/routes/cases.js')).default;
const staff=new Map();let writes=0;let caseRow;
function matches(row,where){return Object.entries(where).every(([k,v])=>{
  if(k==='AND')return v.every(w=>matches(row,w));if(k==='OR')return v.some(w=>matches(row,w));
  if(k==='collaborators')return row.collaborators.some(s=>matches(s,v.some));
  if(v&&typeof v==='object'&&!(v instanceof Date))return Object.entries(v).every(([op,x])=>({gt:()=>row[k]!=null&&row[k]>x,gte:()=>row[k]!=null&&row[k]>=x,lt:()=>row[k]!=null&&row[k]<x,in:()=>x.includes(row[k]),notIn:()=>!x.includes(row[k])}[op])());
  return row[k]===v;
});}
const apply=(row,data)=>{for(const[k,v]of Object.entries(data))row[k]=v?.increment?row[k]+v.increment:v;writes++;return {...row};};
prisma.staff.findUnique=async({where})=>{const row=[...staff.values()].find(s=>matches(s,where));return row?{...row}:null;};
prisma.staff.findFirst=prisma.staff.findUnique;
prisma.staff.update=async({where,data})=>apply(staff.get(where.id),data);
prisma.staff.updateMany=async({where,data})=>{const row=[...staff.values()].find(s=>matches(s,where));if(!row)return{count:0};apply(row,data);return{count:1};};
prisma.staff.findMany=async()=>[];
prisma.case.findUnique=async()=>({...caseRow});
prisma.case.update=async({data})=>{writes++;Object.assign(caseRow,data);return{...caseRow};};
prisma.changeLog.createMany=async()=>({count:0});prisma.changeLog.create=async()=>({});
const app=express();app.use(express.json(),cookieParser());app.use('/api/auth',auth);app.use('/api/cases',cases);
app.get('/check',requireAuth,(req,res)=>res.json(req.user));app.use((e,_req,res,_next)=>{console.error(e.message);res.status(500).json({error:'test_failure'});});
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const base='http://127.0.0.1:'+server.address().port;
const token=(id,version=0)=>'designpm_token='+signToken({id,role:staff.get(id).role,sessionVersion:version});
const request=async(path,method='GET',body,cookie)=>{const r=await fetch(base+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json()};};
let passed=0;const test=async(name,f)=>{await f();passed++;console.log('PASS '+name);};
try{
  const old='SeasonalBlue!826',next='SummerStudio!937';
  staff.set(1,{id:1,name:'primary',email:'primary@example.test',password:await bcrypt.hash(old,4),active:true,pendingActivation:false,role:'member',sessionVersion:0});
  staff.set(2,{id:2,name:'collab',email:'collab@example.test',password:await bcrypt.hash(old,4),active:true,pendingActivation:false,role:'member',sessionVersion:0});
  staff.set(3,{id:3,name:'observer',active:true,pendingActivation:false,role:'observer',sessionVersion:0});
  staff.set(4,{id:4,name:'other',active:true,pendingActivation:false,role:'member',sessionVersion:0});
  staff.set(5,{id:5,name:'admin',email:'admin@example.test',active:true,pendingActivation:false,role:'admin',sessionVersion:0});
  caseRow={id:'TEST',designerId:1,collaborators:[{id:2}],status:'doing',title:'before',archivePath:null};
  await test('natural period follows Taipei midnight rather than UTC day',()=>{
    const day=taipeiCalendarDay(new Date('2026-11-01T16:30:00Z'));assert.equal(day.toISOString().slice(0,10),'2026-11-02');
    assert.equal(resolvePeriod('week',0,day).start.toISOString().slice(0,10),'2026-11-02');
  });
  await test('quarter natural boundaries and previous-year offset',()=>{const w=resolvePeriod('quarter',-1,new Date('2026-01-03'));assert.equal(w.start.toISOString().slice(0,10),'2025-10-01');assert.equal(w.end.toISOString().slice(0,10),'2026-01-01');});
  await test('cross-period work includes ongoing, terminal boundary, missing end; excludes older ended/future cases',()=>{
    const win=resolvePeriod('week',0,new Date('2026-10-22'));
    const mk=(id,status,start,end)=>({id,status,dispatchDate:new Date(start),closedOn:end?new Date(end):null,cancelledOn:end?new Date(end):null,designerId:1,collaborators:[{id:2}]});
    const rows=[mk('ongoing','doing','2026-01-01'),mk('boundary','closed','2026-01-01','2026-10-19'),mk('old','closed','2026-01-01','2026-10-18'),mk('cancelled','cancelled','2026-10-20','2026-10-21'),mk('future','todo','2026-10-26'),mk('missing','closed','2026-01-01')];
    assert.deepEqual(rows.filter(c=>matches(c,workIntervalWhere(win))).map(c=>c.id),['ongoing','boundary','cancelled','missing']);
    assert.equal(rows.filter(c=>matches(c,workIntervalWhere(win,2))).length,4);assert.equal(rows.filter(c=>matches(c,workIntervalWhere(win,4))).length,0);
  });
  await test('collaborator can patch basic project information through real route',async()=>{const r=await request('/api/cases/TEST','PATCH',{title:'joint edit'},token(2));assert.equal(r.status,200);assert.equal(caseRow.title,'joint edit');});
  await test('unrelated member and observer cannot edit',async()=>{assert.equal((await request('/api/cases/TEST','PATCH',{title:'bad'},token(4))).status,403);assert.equal((await request('/api/cases/TEST','PATCH',{title:'bad'},token(3))).status,403);});
  await test('collaborator cannot change assignment or bypass approval with legacy done',async()=>{for(const patch of [{designerId:2},{collaboratorIds:[]},{status:'done',archivePath:'/a'},{status:'closed',archivePath:'/a'},{status:'cancelled'}])assert.equal((await request('/api/cases/TEST','PATCH',patch,token(2))).status,403);});
  await test('same assignment fields are accepted in existing full forms',()=>assert.equal(caseEditPermission({id:2,role:'member'},caseRow,{designerId:1,collaboratorIds:[2]}),null));
  await test('SMTP missing returns accurate unavailable status; no credential writes',async()=>{const n=writes;assert.equal((await request('/api/auth/recovery-status')).data.emailAvailable,false);assert.equal((await request('/api/auth/forgot-password','POST',{email:'primary@example.test'})).status,503);assert.equal(writes,n);});
  await test('only admin can create recovery link; trusted origin and hashed storage',async()=>{
    assert.equal((await request('/api/auth/recovery-link/1','POST',{})).status,401);
    assert.equal((await request('/api/auth/recovery-link/1','POST',{},token(2))).status,403);
    const r=await request('/api/auth/recovery-link/1','POST',{},token(5));assert.equal(r.status,200);
    const url=new URL(r.data.url);assert.equal(url.origin,'https://example.test');assert.equal(url.hash.length,65);assert.equal(staff.get(1).resetTokenHash,hashToken(url.hash.slice(1)));assert.notEqual(staff.get(1).resetTokenHash,url.hash.slice(1));
    const first=staff.get(1).resetTokenHash;await request('/api/auth/recovery-link/1','POST',{},token(5));assert.notEqual(staff.get(1).resetTokenHash,first);
  });
  await test('invalid reset token cannot update password',async()=>{const n=writes;assert.equal((await request('/api/auth/reset-password','POST',{token:'a'.repeat(64),password:next,confirmation:next})).status,410);assert.equal(writes,n);});
  await test('expired reset token and mismatched confirmation rejected',async()=>{staff.get(1).resetTokenHash=hashToken('b'.repeat(64));staff.get(1).resetExpires=new Date(Date.now()-1);assert.equal((await request('/api/auth/reset-password/check','POST',{token:'b'.repeat(64)})).status,410);assert.equal((await request('/api/auth/reset-password','POST',{token:'b'.repeat(64),password:next,confirmation:old})).status,422);});
  await test('concurrent reset is single-use and revokes old sessions',async()=>{
    staff.get(1).resetTokenHash=hashToken('c'.repeat(64));staff.get(1).resetExpires=new Date(Date.now()+60000);const cookie=token(1);
    const results=await Promise.all([1,2].map(()=>request('/api/auth/reset-password','POST',{token:'c'.repeat(64),password:next,confirmation:next})));
    assert.deepEqual(results.map(r=>r.status).sort(),[200,410]);assert.equal(staff.get(1).sessionVersion,1);assert.equal(staff.get(1).resetTokenHash,null);assert(await bcrypt.compare(next,staff.get(1).password));assert.equal((await request('/check','GET',undefined,cookie)).status,401);
  });
  await test('password change requires current password, revokes reset token and session',async()=>{
    const cookie=token(2);assert.equal((await request('/api/auth/change-password','POST',{currentPassword:'wrong',newPassword:next},cookie)).status,401);
    staff.get(2).resetTokenHash='pending';const r=await request('/api/auth/change-password','POST',{currentPassword:old,newPassword:next},cookie);assert.equal(r.status,200);assert.equal(r.data.loginRequired,true);assert.equal(staff.get(2).resetTokenHash,null);assert.equal((await request('/check','GET',undefined,cookie)).status,401);
  });
  await test('inactive account and fresh observer role enforced',async()=>{const cookie=token(4);staff.get(4).active=false;assert.equal((await request('/check','GET',undefined,cookie)).status,401);staff.get(4).active=true;staff.get(4).role='observer';assert.equal((await request('/api/cases/TEST','PATCH',{title:'bad'},cookie)).status,403);});
  console.log(JSON.stringify({passed,liveDatabase:false,emailSent:false}));
}finally{await new Promise(r=>server.close(r));await prisma.$disconnect();}
