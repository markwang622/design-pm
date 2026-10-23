// Actual workload service and staff routes against synthetic, read-only Prisma.
// Query counts below are ORM calls, not assertions about Prisma's generated SQL.
import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex } from 'node:stream';
import { createRequire } from 'node:module';
const root = process.env.DESIGN_PM_ROOT || new URL('../', import.meta.url).pathname;
const require = createRequire(root + '/package.json');
const express = require('express'), cookieParser = require('cookie-parser');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'synthetic-workload-scale-tests-secret';
process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/never_connect';
for (const key of ['SMTP_HOST','SMTP_USER','SMTP_PASS']) delete process.env[key];
const { prisma } = await import(root + '/src/lib/db.js');
const { signToken } = await import(root + '/src/middleware/auth.js');
const { workloadScore, workloadScores, workloadForAll, suggestSuccessor, pickSuccessorFromRanking } = await import(root + '/src/services/workload.js');
const person = (id, overrides = {}) => ({ id, name: 'Fixture ' + id, email: `fixture-${id}@example.invalid`,
  role: 'member', seniority: 'mid', active: true, pendingActivation: false, sessionVersion: 0,
  joined: new Date('2025-01-01'), departedOn: null, roleTitle: 'Fixture title', color: null,
  activatedAt: null, activationExpires: null, password: 'synthetic-password-placeholder', ...overrides });
const assignment = (id, designerId, level = 'A', status = 'doing', collaborators = [], archived = false) => ({
  id, title: id, designerId, level, status, archived, goLiveDate: new Date('2026-11-01'),
  collaborators: collaborators.map(id => ({ id, name: 'Fixture ' + id })),
});
let staff = [], cases = [], calls;
const resetCounts = () => { calls = { staffMany: [], staffUnique: [], caseMany: [], writes: 0 }; };
function matches(row, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) return true;
    if (key === 'AND') return expected.every(part => matches(row, part));
    if (key === 'OR') return expected.some(part => matches(row, part));
    if (key === 'NOT') return !matches(row, expected);
    if (key === 'collaborators') return row.collaborators.some(p => matches(p, expected.some));
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      return Object.entries(expected).every(([op, value]) => {
        if (op === 'in') return value.includes(row[key]);
        if (op === 'notIn') return !value.includes(row[key]);
        throw Error('Unsupported fixture predicate ' + op);
      });
    }
    return expected instanceof Date ? +row[key] === +expected : row[key] === expected;
  });
}
function project(row, select) {
  if (!row) return null;
  if (!select) return structuredClone(row);
  return Object.fromEntries(Object.entries(select).map(([key, option]) => [key,
    option === true ? structuredClone(row[key]) : Array.isArray(row[key])
      ? row[key].map(value => project(value, option.select)) : project(row[key], option.select)]));
}
function ordered(rows, orderBy) {
  const orders = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  return rows.slice().sort((a,b) => {
    for (const order of orders) for (const [key,direction] of Object.entries(order)) {
      if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (direction === 'desc' ? -1 : 1);
    }
    return 0;
  });
}
for (const model of ['staff','case','notification','transferLog']) {
  for (const method of ['findUnique','findFirst','findMany','create','createMany','update','updateMany','delete','deleteMany','count','aggregate','groupBy']) {
    prisma[model][method] = async () => { calls.writes++; throw Error('Unexpected ORM access blocked: '+model+'.'+method); };
  }
}
prisma.staff.findMany = async args => { calls.staffMany.push(structuredClone(args)); return ordered(staff.filter(s=>matches(s,args?.where)),args?.orderBy).map(s=>project(s,args?.select)); };
prisma.staff.findUnique = async args => { calls.staffUnique.push(structuredClone(args)); return project(staff.find(s=>matches(s,args.where)),args.select); };
prisma.case.findMany = async args => { calls.caseMany.push(structuredClone(args)); return ordered(cases.filter(c=>matches(c,args?.where)),args?.orderBy).map(c=>project(c,args?.select)); };
for (const method of ['$connect','$transaction','$executeRaw','$executeRawUnsafe','$queryRaw','$queryRawUnsafe']) prisma[method] = async () => { throw Error('Live DB/transaction access blocked'); };
prisma.$disconnect = async () => {};
resetCounts();
const app = express(); app.use(cookieParser());
app.use('/api/staff', (await import(root + '/src/routes/staff.js')).default);
app.use((e,_req,res,_next)=>res.status(500).json({error:'fixture_handler_failure',message:e.message}));
function call(suffix='',as=1) {
  return new Promise((resolve,reject)=>{
    const socket=new Duplex({read(){},write(_data,_encoding,done){done();}});
    const req=new http.IncomingMessage(socket);req.url='/api/staff/'+suffix;req.method='GET';
    req.headers={cookie:'designpm_token='+signToken({id:as,sessionVersion:0})};
    const res=new http.ServerResponse(req);
    res.end=data=>{resolve({status:res.statusCode,data:JSON.parse(String(data))});socket.destroy();return res;};
    app.handle(req,res,e=>reject(e||Error('Route not handled')));
  });
}
// Independent pre-batching reference: two filtered case sets per person and
// final one-decimal rounding, matching the original public score definition.
const weights={SS:5,S:4,A:3,B:2,C:1,D:1};
const activeCase=c=>!c.archived&&!['done','closed','cancelled'].includes(c.status);
function referenceScore(id) {
  const owned=cases.filter(c=>activeCase(c)&&c.designerId===id);
  const collaborative=cases.filter(c=>activeCase(c)&&c.designerId!==id&&c.collaborators.some(s=>s.id===id));
  return Math.round((owned.reduce((sum,c)=>sum+(weights[c.level]??1),0)+collaborative.reduce((sum,c)=>sum+(weights[c.level]??1)*0.4,0))*10)/10;
}
function referenceRanking({excludeId,assignableOnly=false}={}) {
  return staff.filter(s=>s.active&&(!excludeId||s.id!==excludeId)&&(!assignableOnly||(!s.pendingActivation&&['admin','member'].includes(s.role))))
    .slice().sort((a,b)=>a.id-b.id).map(s=>({id:s.id,name:s.name,seniority:s.seniority,score:referenceScore(s.id)})).sort((a,b)=>a.score-b.score);
}
function referenceSuggestion(ranked,level) {
  if (!ranked.length) return null;
  const tied=ranked.filter(s=>s.score===ranked[0].score);
  if (['SS','S'].includes(level)) tied.sort((a,b)=>({senior:0,mid:1,junior:2}[a.seniority]??9)-({senior:0,mid:1,junior:2}[b.seniority]??9));
  return tied[0];
}
let passed=0;
async function test(name,fn){staff=[];cases=[];resetCounts();await fn();assert.equal(calls.writes,0);passed++;console.log('PASS '+name);}

await test('batched scores equal legacy and standalone scores across every weight/status/archive/participation combination',async()=>{
  staff=Array.from({length:9},(_,i)=>person(i+1));
  let id=0;
  for(const level of ['SS','S','A','B','C','D','UNKNOWN'])for(const status of ['todo','wait','doing','review','review_done','print','done','closed','cancelled'])for(const archived of [false,true]){
    cases.push(assignment('CASE-'+id++,id%9+1,level,status,[id%9+1,(id+2)%9+1,(id+2)%9+1],archived));
  }
  cases.push(assignment('OUTSIDE',99,'SS','doing',[100]));
  const before=structuredClone(cases),ids=staff.map(s=>s.id).concat([1,999]);
  const scores=await workloadScores(ids);assert.equal(calls.caseMany.length,1);assert.equal(calls.staffMany.length,0);
  assert.deepEqual([...scores.keys()],[1,2,3,4,5,6,7,8,9,999]);
  for(const id of scores.keys()){assert.equal(scores.get(id),referenceScore(id));assert.equal(await workloadScore(id),referenceScore(id));}
  assert.deepEqual(cases,before,'scoring never changes source assignments');
});
await test('empty batch performs no reads and an unrelated requested person receives zero',async()=>{
  assert.deepEqual([...await workloadScores([])],[]);assert.equal(calls.caseMany.length,0);
  cases=[assignment('OTHER',2,'SS','doing',[3])];assert.equal((await workloadScores([1])).get(1),0);assert.equal(calls.caseMany.length,1);
  const query=calls.caseMany[0];assert.deepEqual(query.select,{level:true,designerId:true,collaborators:{select:{id:true}}});
  assert(matches(cases[0],query.where)===false,'query restricts participation to requested IDs');
});
await test('workloadForAll preserves default roles, eligibility, exclusion, exact output shape and stable score ordering',async()=>{
  staff=[person(6,{seniority:'junior'}),person(4,{active:false}),person(2,{role:'observer'}),person(5,{role:'admin',seniority:'senior'}),person(3,{pendingActivation:true}),person(1)];
  cases=[assignment('OPEN',1,'A','doing',[5]),assignment('OLD',6,'SS','cancelled',[2])];
  for(const options of [{},{excludeId:1},{assignableOnly:true},{excludeId:1,assignableOnly:true}]){
    resetCounts();assert.deepEqual(await workloadForAll(options),referenceRanking(options));
    assert.equal(calls.staffMany.length,1);assert.equal(calls.caseMany.length,1);
  }
});
await test('empty roster skips the case read without changing empty result shape',async()=>{
  staff=[person(1,{active:false})];assert.deepEqual(await workloadForAll(),[]);assert.equal(calls.staffMany.length,1);assert.equal(calls.caseMany.length,0);
});
await test('batched roster query count stays fixed as staff and cases grow',async()=>{
  for(const count of [1,40,200]){
    staff=Array.from({length:count},(_,i)=>person(count-i,{seniority:['junior','mid','senior'][i%3]}));
    cases=Array.from({length:count*5},(_,i)=>assignment('SCALE-'+i,i%count+1,['SS','S','A','B','C','D'][i%6],i%7?'doing':'cancelled',[(i+2)%count+1]));
    resetCounts();assert.deepEqual(await workloadForAll(),referenceRanking());assert.equal(calls.staffMany.length,1);assert.equal(calls.caseMany.length,1);
  }
});
await test('pure successor selection preserves low-score priority and SS/S seniority ties without queries or mutation',async()=>{
  staff=[person(8,{seniority:'mystery'}),person(5,{seniority:'senior'}),person(3,{seniority:'senior'}),person(2,{seniority:'junior'}),person(1,{seniority:'mid'})];
  cases=[];const ranked=await workloadForAll(),before=structuredClone(ranked);resetCounts();
  for(const level of ['SS','S','A','B','C','D','UNKNOWN'])assert.deepEqual(pickSuccessorFromRanking(ranked,level),referenceSuggestion(ranked,level));
  assert.equal(pickSuccessorFromRanking(ranked,'A').id,1);assert.equal(pickSuccessorFromRanking(ranked,'SS').id,3);assert.deepEqual(ranked,before);
  assert.equal(calls.caseMany.length,0);assert.equal(calls.staffMany.length,0);
  const low=[{id:2,name:'Junior',seniority:'junior',score:0},{id:3,name:'Senior',seniority:'senior',score:0.4}];assert.equal(pickSuccessorFromRanking(low,'SS').id,2);
  assert.equal(pickSuccessorFromRanking([],'SS'),null);
});
await test('public suggestion still loads one eligible ranking and returns null when none are available',async()=>{
  staff=[person(1),person(2,{role:'observer'}),person(3,{pendingActivation:true}),person(4,{active:false}),person(5,{role:'admin',seniority:'senior'}),person(6,{seniority:'junior'})];
  for(const level of ['SS','S','A']){resetCounts();const ranked=referenceRanking({excludeId:1,assignableOnly:true});assert.deepEqual(await suggestSuccessor({excludeId:1,level}),referenceSuggestion(ranked,level));assert.equal(calls.staffMany.length,1);assert.equal(calls.caseMany.length,1);}
  staff=staff.filter(s=>s.id<5);resetCounts();assert.equal(await suggestSuccessor({excludeId:1,level:'A'}),null);assert.equal(calls.staffMany.length,1);assert.equal(calls.caseMany.length,0);
});
await test('staff list keeps active/default and includeInactive contracts with one workload read',async()=>{
  staff=[person(1,{role:'admin'}),person(2,{role:'observer'}),person(3,{pendingActivation:true}),person(4,{active:false})];
  cases=[assignment('MEMBER',1,'S','doing',[2,4]),assignment('FORMER',4,'A','doing',[3])];
  for(const suffix of ['','?includeInactive=1']){
    resetCounts();const result=await call(suffix);assert.equal(result.status,200);
    const wanted=ordered(staff.filter(s=>suffix||s.active),[{active:'desc'},{id:'asc'}]);assert.deepEqual(result.data.map(s=>s.id),wanted.map(s=>s.id));
    for(const row of result.data){assert.equal(row.workload,referenceScore(row.id));assert(!('password'in row));assert.equal(typeof row.pendingActivation,'boolean');}
    assert.equal(calls.staffMany.length,1);assert.equal(calls.staffUnique.length,1);assert.equal(calls.caseMany.length,1);
  }
  resetCounts();const ranked=await call('workload');assert.equal(ranked.status,200);assert.deepEqual(ranked.data,referenceRanking());assert.equal(calls.caseMany.length,1);
});
function previewFixtures(openCount,staffCount){
  staff=Array.from({length:staffCount},(_,i)=>person(i+1,{role:i===0?'admin':'member',seniority:i%2?'junior':'senior'}));
  staff.push(person(staffCount+1,{role:'observer'}),person(staffCount+2,{pendingActivation:true}),person(staffCount+3,{active:false}));
  cases=Array.from({length:openCount},(_,i)=>assignment('LEAVER-'+i,2,['SS','S','A','B','C','D'][i%6],'doing',i%2?[3]:[]));
  for(const status of ['done','closed','cancelled'])cases.push(assignment('TERMINAL-'+status,2,'A',status));
  cases.push(assignment('ARCHIVED-OPEN',2,'A','doing',[],true),assignment('COLLAB',3,'B','doing',[2]),assignment('OLD-COLLAB',3,'S','closed',[2]));
}
await test('departure preview reuses one ranking across all cases and keeps response/eligibility/tie-breaks exact',async()=>{
  for(const [openCount,staffCount]of [[1,3],[25,40],[100,80]]){
    previewFixtures(openCount,staffCount);const ranked=referenceRanking({excludeId:2,assignableOnly:true});resetCounts();
    const result=await call('2/departure-preview');assert.equal(result.status,200,JSON.stringify(result));
    assert.deepEqual(Object.keys(result.data),['leaver','toArchive','toTransfer','toRemoveCollab']);assert.equal(result.data.toTransfer.length,openCount);
    assert.deepEqual(result.data.toArchive.map(c=>c.id),['TERMINAL-done','TERMINAL-closed','TERMINAL-cancelled']);assert.deepEqual(result.data.toRemoveCollab.map(c=>c.id),['COLLAB']);
    for(const row of result.data.toTransfer){const source=cases.find(c=>c.id===row.id);assert.deepEqual(row.suggestion,referenceSuggestion(ranked,source.level));assert.deepEqual(row.collaborators,source.collaborators);}
    assert.equal(calls.caseMany.length,4,'three departure reads plus one shared score read');assert.equal(calls.staffMany.length,1,'one candidate roster for entire preview');assert.equal(calls.staffUnique.length,2,'authentication and leaver lookup');
    const normal=result.data.toTransfer.filter(c=>!['SS','S'].includes(c.level));if(normal.length>1)assert(normal.every(c=>c.suggestion.id===normal[0].suggestion.id),'suggestions do not project allocations');
  }
});
await test('preview with no open cases skips candidate/workload reads and retains historical participation',async()=>{
  previewFixtures(0,3);const result=await call('2/departure-preview');assert.equal(result.status,200);assert.deepEqual(result.data.toTransfer,[]);
  assert.equal(result.data.toArchive.length,3);assert.deepEqual(result.data.toRemoveCollab.map(c=>c.id),['COLLAB']);assert.equal(calls.caseMany.length,3);assert.equal(calls.staffMany.length,0);
});
await test('preview with no eligible successor returns null per case without a score query',async()=>{
  staff=[person(1,{role:'admin',pendingActivation:true}),person(2),person(3,{role:'observer'}),person(4,{active:false})];
  // Use the leaver as an authenticated admin to exclude that only eligible ID.
  staff[1].role='admin';cases=[assignment('OPEN',2,'SS','doing')];const result=await call('2/departure-preview',2);assert.equal(result.status,200);
  assert.equal(result.data.toTransfer[0].suggestion,null);assert.equal(calls.caseMany.length,3);assert.equal(calls.staffMany.length,1);
});
await test('preview authorization and missing leaver still stop before workload computation',async()=>{
  staff=[person(1,{role:'admin'}),person(2)];assert.equal((await call('1/departure-preview',2)).status,403);assert.equal(calls.caseMany.length,0);assert.equal(calls.staffMany.length,0);
  resetCounts();assert.equal((await call('999/departure-preview',1)).status,404);assert.equal(calls.caseMany.length,0);assert.equal(calls.staffMany.length,0);
});
console.log(JSON.stringify({passed,liveDatabase:false,network:false,queryCounts:'Prisma ORM calls; SQL relation loading not measured'}));
