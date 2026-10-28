// Opt-in real PostgreSQL 17/18 drill. Every writable DB is created by this test
// under design_pm_phase3_test_* on the labelled loopback Docker fixture only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (process.env.RUN_ISOLATED_POSTGRES_TEST !== '1') throw Error('Opt in with RUN_ISOLATED_POSTGRES_TEST=1; this drill creates only task-owned isolated fixture databases');
const root=process.env.DESIGN_PM_ROOT||new URL('../',import.meta.url).pathname;
const require=createRequire(path.join(root,'package.json'));
const {PrismaClient}=require('@prisma/client');
const container=process.env.DESIGN_PM_PG_TEST_CONTAINER||'codex-design-pm-phase3-20261023';
const fixturePassword='isolated-phase3-fixture-only';
const cliFile=path.join(root,'scripts/database-maintenance.mjs');
const docker=(args,options={})=>spawnSync('docker',args,{encoding:'utf8',maxBuffer:10*1024*1024,...options});
const inspected=docker(['inspect',container,'--format','{{json .}}']);
assert.equal(inspected.status,0,'isolated fixture container must exist');
const info=JSON.parse(inspected.stdout);
assert.equal(info.Config.Labels['codex.task'],'design-pm-phase3','refuse containers without the explicit task label');
const bindings=info.NetworkSettings.Ports['5432/tcp'];
assert(bindings?.length===1&&bindings[0].HostIp==='127.0.0.1','fixture must expose one loopback-only PostgreSQL port');
const port=bindings[0].HostPort;
const versionRead=docker(['exec','-e','PGPASSWORD='+fixturePassword,container,'psql','--host','127.0.0.1','--username','postgres','--dbname','design_pm_phase3_control','-X','-t','-A','-v','ON_ERROR_STOP=1','-c',"SELECT json_build_object('number',current_setting('server_version_num'),'version',current_setting('server_version'))"]);
assert.equal(versionRead.status,0,'read actual isolated PostgreSQL server version: '+versionRead.stderr);
const actualVersion=JSON.parse(versionRead.stdout.trim()),postgresMajor=Math.floor(Number(actualVersion.number)/10000),postgresVersion=actualVersion.version;
assert([17,18].includes(postgresMajor),'isolated drill supports actual PostgreSQL 17 or 18 servers');
if(process.env.DESIGN_PM_EXPECTED_PG_MAJOR!==undefined){
  assert(/^(17|18)$/.test(process.env.DESIGN_PM_EXPECTED_PG_MAJOR),'expected PostgreSQL major must be 17 or 18');
  assert.equal(postgresMajor,Number(process.env.DESIGN_PM_EXPECTED_PG_MAJOR),'fixture server major must match the explicitly requested version');
}
const runTag=process.pid+'_'+crypto.randomBytes(4).toString('hex');
// REPORTS-P1-C1: per-batch database naming (e.g. design_pm_delivery_c). Strictly validated; default unchanged.
const basePrefix=process.env.DESIGN_PM_PG_DB_PREFIX||'design_pm_phase3_test';
assert(/^design_pm_[a-z0-9_]{1,30}$/.test(basePrefix)&&!/_$/.test(basePrefix),'database prefix must be design_pm_<lowercase>');
const prefix=basePrefix+'_'+runTag+'_';
const databases=new Set(),clients=[];
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'design-pm-pg-maintenance-'));fs.chmodSync(folder,0o700);
const checkpoint=process.env.PG_DRILL_STATE_PATH||'/Users/markwang/Documents/ChatGPT/專案管理網站/astra-review/phase3/postgres-state.json';
let passed=0,sourceDb,sourceClient,legacyManifest,currentManifest,fixtureIds,legacyBusiness,sourceBeforeRestore;
const results=[];
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const urlFor=name=>`postgresql://postgres:${fixturePassword}@127.0.0.1:${port}/${name}?schema=public`;
function own(name){assert(databases.has(name)&&name.startsWith(prefix),'refuse any DB not created and owned by this test');return name;}
function state(status,error){fs.mkdirSync(path.dirname(checkpoint),{recursive:true});fs.writeFileSync(checkpoint,JSON.stringify({status,passed,results,fixture:{container,host:'127.0.0.1',port,postgresMajor,postgresVersion,ownedDatabases:[...databases]},artifacts:folder,legacyManifest,currentManifest,error:error?String(error.message||error).replaceAll(fixturePassword,'[fixture-secret]'):undefined,scope:'Synthetic fixture only; no formal/Demo DB, SMTP, Git or external network'},null,2)+'\n');}
function createDatabase(label){
  const name=prefix+label;assert(/^[a-z0-9_]+$/.test(name)&&name.length<64);
  const r=docker(['exec','-e','PGPASSWORD='+fixturePassword,container,'createdb','--host','127.0.0.1','--username','postgres','--maintenance-db','design_pm_phase3_control',name]);
  assert.equal(r.status,0,'create isolated DB '+label+': '+r.stderr);databases.add(name);return name;
}
function db(name,{limit}={}){own(name);const client=new PrismaClient({datasources:{db:{url:urlFor(name)+(limit?'&connection_limit='+limit:'')}}});clients.push(client);return client;}
function sql(name,statement){
  own(name);const r=docker(['exec','-i','-e','PGPASSWORD='+fixturePassword,container,'psql','--host','127.0.0.1','--username','postgres','--dbname',name,'-X','-q','-v','ON_ERROR_STOP=1'],{input:statement});
  assert.equal(r.status,0,'fixture SQL failed: '+r.stderr);return r.stdout;
}
// REPORTS-P3-E1a: concurrency fixtures — a psql run that may block on locks, and a Prisma transaction held open.
function sqlAsync(name,statement){own(name);return new Promise((resolve,reject)=>{
  const child=spawn('docker',['exec','-i','-e','PGPASSWORD='+fixturePassword,container,'psql','--host','127.0.0.1','--username','postgres','--dbname',name,'-X','-q','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe']});
  let out='',err='',exited=false;child.stdout.on('data',c=>{out+=c;});child.stderr.on('data',c=>{err+=c;});child.once('error',reject);
  const p=new Promise((res,rej)=>child.once('close',code=>{exited=true;code===0?res(out):rej(Error('async fixture SQL failed: '+err));}));
  child.stdin.end(statement);resolve({done:p,exited:()=>exited});});}
function holdTx(client){
  let release;const gate=new Promise(r=>{release=r;});let ready;const opened=new Promise(r=>{ready=r;});
  const done=client.$transaction(async tx=>{await tx.$queryRawUnsafe('SELECT 1');ready(tx);await gate;},{maxWait:10000,timeout:120000});done.catch(()=>{});
  return {tx:opened,commit:async()=>{release();await done;}};
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const REPORT_SOURCE_KEYS={cases:'r."id"',_collaborators:`r."A"||':'||r."B"`,case_deliveries:'r."id"',case_cycles:'r."id"',case_lifecycle_requests:'r."id"',case_schedule_requests:'r."id"',
  case_delivery_submissions:'r."id"',staff:'r."id"::text',hotels:'r."id"::text',change_logs:'r."id"::text'};
const projectFn=t=>t==='_collaborators'?'report_project_collaborators':'report_project_'+t;
async function currentProjection(client){const out={};for(const [t,key]of Object.entries(REPORT_SOURCE_KEYS)){
  const rows=await client.$queryRawUnsafe(`SELECT ${key} AS k, ${projectFn(t)}(r) AS d FROM public.${quote(t)} r`);out[t]=Object.fromEntries(rows.filter(x=>x.d!==null).map(x=>[x.k,x.d]));}return out;}
async function reportTimes(client){const [r]=await client.$queryRawUnsafe(`SELECT to_char("coverageStart" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "coverageStart","baselineEventMaxId"::text AS "baselineEventMaxId" FROM report_source_coverage WHERE id=1`);return r;}
// Executable adapters stream archive bytes through Docker. The maintenance CLI
// still controls database/credential env and invokes this fixture's real PG binaries.
for(const [file,binary]of [['pg-dump-wrapper','pg_dump'],['pg-restore-wrapper','pg_restore']]){
  fs.writeFileSync(path.join(folder,file),`#!/bin/sh\nexec docker exec -i -e PGHOST=127.0.0.1 -e PGPORT=5432 -e "PGDATABASE=$PGDATABASE" -e "PGUSER=$PGUSER" -e "PGPASSWORD=$PGPASSWORD" '${container.replaceAll("'","'\\''")}' ${binary} "$@"\n`,{mode:0o700});
}
function cli(name,args,{expect=0,env={},url}={}){
  if(!url)own(name);
  const r=spawnSync(process.execPath,[cliFile,...args],{cwd:root,encoding:'utf8',maxBuffer:10*1024*1024,env:{...process.env,
    DATABASE_URL:url||urlFor(name),NODE_ENV:'test',APP_BASE_URL:'https://fixture.invalid',JWT_SECRET:'isolated-maintenance-calendar-fixture-secret',
    PG_DUMP_BIN:path.join(folder,'pg-dump-wrapper'),PG_RESTORE_BIN:path.join(folder,'pg-restore-wrapper'),
    BASELINE_CONFIRM:'',IDENTITY_CONFIRM:'',...env}});
  assert.equal(r.status,expect,`CLI ${args[0]} expected ${expect}: ${r.stdout}\n${r.stderr}`);
  assert(!r.stdout.includes(fixturePassword)&&!r.stderr.includes(fixturePassword),'CLI must not print DB credentials');
  const lines=r.stdout.trim().split('\n').filter(Boolean);let output;try{output=JSON.parse(lines.at(-1));}catch{}
  return {...r,output};
}
const quote=value=>'"'+String(value).replaceAll('"','""')+'"';
async function snapshot(client,{businessOnly=false}={}){
  const tables=await client.$queryRawUnsafe("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");const result={tables:{},sequences:[]};
  for(const{tablename}of tables){if(businessOnly&&['_prisma_migrations','deployment_identity'].includes(tablename))continue;
    const [row]=await client.$queryRawUnsafe(`SELECT count(*)::text AS count,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY md5(row_to_json(t)::text)),'')) AS digest FROM public.${quote(tablename)} t`);result.tables[tablename]=row;}
  result.sequences=await client.$queryRawUnsafe("SELECT schemaname,sequencename,last_value::text FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename");return result;
}
// REPORTS-P1-C1: legacy-column projection of cases (new C1 columns removed; absent keys are no-ops on a legacy DB).
const C1_CASE_COLUMNS=['deliveryMode','deliveryModeSince','deliveryModeById','deliveryModeByName','deliveryModeReason','deliveryModeRequestId','deliveryModeFingerprint','pendingDeliverySubmissionId'];
const D1A_CASE_COLUMNS=['lifecycleMode','lifecycleModeSince','lifecycleModeById','lifecycleModeByName','lifecycleModeReason','lifecycleModeRequestId','lifecycleModeFingerprint','lifecycleStatus','currentCycleId','pendingLifecycleRequestId','scheduleMode','scheduleModeSince','scheduleModeById','scheduleModeByName','scheduleModeReason','scheduleModeRequestId','scheduleModeFingerprint','scheduleBaseline','pendingScheduleRequestId'];
async function casesProjection(client){
  // REPORTS-P2-D1a: 0005 schedule columns are also additive and excluded from the legacy-column projection.
  const strip=`(row_to_json(t)::jsonb - ARRAY[${[...C1_CASE_COLUMNS,...D1A_CASE_COLUMNS].map(c=>"'"+c+"'").join(',')}])::text`;
  const [r]=await client.$queryRawUnsafe(`SELECT count(*)::text AS count,md5(coalesce(string_agg(md5(${strip}),'' ORDER BY md5(${strip})),'')) AS digest FROM public.cases t`);return r;
}
let legacyCasesProjection;
async function noHistory(client){const[t]=await client.$queryRawUnsafe("SELECT to_regclass('public._prisma_migrations')::text AS table_name");assert.equal(t.table_name,null);}
// PG_DRILL_ONLY=<regex> is a development aid for running self-contained tests only; the recorded final drill runs unfiltered.
const only=process.env.PG_DRILL_ONLY?new RegExp(process.env.PG_DRILL_ONLY):null;let skipped=0;
async function test(name,fn){if(only&&!only.test(name)){skipped++;console.log('SKIP '+name);return;}await fn();passed++;results.push(name);state('running');console.log('PASS '+name);}
const day=()=>new Date('2026-10-22T00:00:00Z');
async function populate(client){
  const admin=await client.staff.create({data:{name:'Isolated Admin',email:'isolated-admin@example.invalid',password:'unusable-fixture-value',role:'admin',seniority:'senior',joined:day(),sessionVersion:7,calendarVersion:3}});
  const member=await client.staff.create({data:{name:'Isolated 設計師',email:'isolated-member@example.invalid',password:'unusable-fixture-value',role:'member',seniority:'mid',joined:day(),sessionVersion:2,calendarVersion:5}});
  const former=await client.staff.create({data:{name:'Isolated Former',email:'isolated-former@example.invalid',password:'unusable-fixture-value',role:'member',seniority:'junior',joined:day(),active:false,departedOn:day()}});
  const hole=await client.staff.create({data:{name:'Isolated Sequence Hole',email:'isolated-hole@example.invalid',password:'unusable-fixture-value',seniority:'junior',joined:day()}});await client.staff.delete({where:{id:hole.id}});
  const caseId='A-2026-10-001';
  // REPORTS-P1-C1: the current Prisma client always writes Case.deliveryMode (client-side default), which a
  // legacy (0001) schema does not have. Seed the same two legacy rows with explicit legacy-column SQL instead.
  const items=[{n:'Fixture 子項目',type:'Fixture',assigneeId:member.id,owner:member.name,logs:[{by:former.name,note:'Preserve history'}]}];
  const logs=[{id:'fixture-log-one',date:'2026-10-22',by:member.name,note:'Synthetic history 文本',tag:'revise'}];
  await client.$executeRawUnsafe(`INSERT INTO cases (id,title,requester,level,status,"designerId","createdById","openDate","dispatchDate","goLiveDate","contentVersion",items,logs,deliverables,note,"updatedAt")
    VALUES ($1,'Isolated relational case','Fixture requester','A','doing',$2,$3,'2026-10-21'::date,'2026-10-22'::date,'2026-11-05'::date,9,$4::jsonb,$5::jsonb,$6::jsonb,'Synthetic fixture only',now())`,
    caseId,member.id,admin.id,JSON.stringify(items),JSON.stringify(logs),JSON.stringify(['Fixture']));
  await client.$executeRawUnsafe('INSERT INTO "_collaborators"("A","B") VALUES ($1,$2),($1,$3)',caseId,admin.id,former.id);
  await client.$executeRawUnsafe(`INSERT INTO cases (id,title,requester,level,status,archived,"closedOn","archivePath","designerId","openDate","dispatchDate","goLiveDate","contentVersion","updatedAt")
    VALUES ('B-2026-10-002','Isolated closed case','Fixture','B','closed',true,'2026-10-22'::date,'/fixture/archive',$1,'2026-10-22'::date,'2026-10-22'::date,'2026-10-22'::date,4,now())`,member.id);
  const meeting=await client.meeting.create({data:{title:'Isolated Taipei meeting',date:day(),startTime:'09:30',endTime:'10:30',hostId:admin.id,createdById:member.id,caseId,
    seriesId:'isolated-fixture-series',remindMinutes:30,actionItems:[{text:'Preserve action',owner:member.name,done:false}],attendees:{create:[{staffId:admin.id,response:'accepted'},{staffId:member.id,response:'pending'}]}}});
  await client.vacation.create({data:{staffId:member.id,startDate:day(),endDate:day(),note:'Fixture leave'}});
  await client.businessTrip.create({data:{staffId:member.id,startDate:day(),endDate:new Date('2026-10-23T00:00:00Z'),hotel:'Fixture Hotel',task:'Fixture trip'}});
  await client.shoot.create({data:{desc:'Fixture shoot',startDate:day(),endDate:day(),createdById:member.id}});
  await client.changeLog.create({data:{caseId,field:'status',fromValue:'todo',toValue:'doing',reason:'Fixture audit',operator:admin.name}});
  await client.transferLog.create({data:{caseId,fromName:former.name,toName:member.name,reason:'Fixture transfer',operator:admin.name}});
  await client.notification.create({data:{type:'statusChange',recipientId:member.id,subject:'Fixture notice',body:'Fixture body',relatedCaseId:caseId}});
  await client.hotel.create({data:{region:'Fixture',name:'Fixture Hotel',sortOrder:7}});
  await client.requestUnit.create({data:{name:'Fixture Unit',sortOrder:3}});
  return {admin:admin.id,member:member.id,former:former.id,sequenceHole:hole.id,caseId,meeting:meeting.id};
}
state('running');
try{
  await test('create only owned isolated legacy database and populate all synthetic business relations',async()=>{
    sourceDb=createDatabase('legacy');sql(sourceDb,fs.readFileSync(path.join(root,'prisma/migrations/0001_legacy_baseline/migration.sql'),'utf8'));sourceClient=db(sourceDb);fixtureIds=await populate(sourceClient);
    legacyBusiness=await snapshot(sourceClient,{businessOnly:true});legacyCasesProjection=await casesProjection(sourceClient);assert.equal(legacyBusiness.tables.staff.count,'3');assert.equal(legacyBusiness.tables._collaborators.count,'2');assert.equal(legacyBusiness.tables.meeting_attendees.count,'2');await noHistory(sourceClient);
  });
  await test('connection target overrides and duplicate parameters fail before any database access or dump',async()=>{
    const before=await snapshot(sourceClient),base=urlFor(sourceDb);
    for(const suffix of ['&host=%2Ftmp%2Funtrusted-socket','&port=1','&user=another_user','&service=another_target','&options=-csearch_path%3Dother']){
      const destination=path.join(folder,'refused-'+crypto.randomBytes(3).toString('hex'));
      assert.match(cli(null,['backup',destination],{expect:1,url:base+suffix}).stderr,/Unsupported database connection parameter/);
      assert(!fs.existsSync(destination),'refused URL must not create a backup directory');
    }
    assert.match(cli(null,['baseline'],{expect:1,url:base+'&schema=public'}).stderr,/Duplicate database connection parameters/);
    assert.deepEqual(await snapshot(sourceClient),before);await noHistory(sourceClient);
  });
  await test('real dump strips inherited libpq target transport and service overrides',async()=>{
    const guard=path.join(folder,'pg-dump-env-guard');
    fs.writeFileSync(guard,`#!/bin/sh\nfor key in PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS PGSSLMODE PGSSLCERT; do\n  if printenv "$key" >/dev/null; then exit 97; fi\ndone\nexec '${path.join(folder,'pg-dump-wrapper').replaceAll("'","'\\''")}' "$@"\n`,{mode:0o700});
    const before=await snapshot(sourceClient),destination=path.join(folder,'environment-guard-backup');
    const r=cli(sourceDb,['backup',destination],{env:{PG_DUMP_BIN:guard,PGHOSTADDR:'203.0.113.1',PGSERVICE:'untrusted-service',PGSERVICEFILE:'/nonexistent/service-file',PGOPTIONS:'-csearch_path=other',PGSSLMODE:'verify-full',PGSSLCERT:'/nonexistent/cert'}});
    assert.equal(r.output.verified,true);const manifest=JSON.parse(fs.readFileSync(r.output.manifest,'utf8'));
    assert.equal(manifest.archiveSha256,sha(path.join(destination,manifest.archive)));assert.deepEqual(manifest.snapshot.tables,before.tables);
    assert.deepEqual(await snapshot(sourceClient),before);await noHistory(sourceClient);
  });
  await test('baseline preview is read-only and undeclared legacy deployment refuses to auto-baseline',async()=>{
    const before=await snapshot(sourceClient);const preview=cli(sourceDb,['baseline']);assert.equal(preview.output.operation,'baseline-preview');assert.equal(preview.output.metadataWrites,0);assert.equal(preview.output.structuralMatch,true);
    assert.deepEqual(await snapshot(sourceClient),before);await noHistory(sourceClient);
    assert.match(cli(sourceDb,['deploy'],{expect:1}).stderr,/no migration history/);assert.deepEqual(await snapshot(sourceClient),before);
  });
  await test('unexpected legacy schema refuses baselining before metadata writes',async()=>{
    const name=createDatabase('badschema');sql(name,fs.readFileSync(path.join(root,'prisma/migrations/0001_legacy_baseline/migration.sql'),'utf8')+'\nALTER TABLE cases ADD COLUMN fixture_unreviewed TEXT;');
    const client=db(name),before=await snapshot(client);assert.match(cli(name,['baseline'],{expect:1}).stderr,/differs from.*legacy baseline/);await noHistory(client);assert.deepEqual(await snapshot(client),before);
  });
  await test('full legacy backup has a verified SHA256 manifest and private directory/files',async()=>{
    const destination=path.join(folder,'legacy-backup');const r=cli(sourceDb,['backup',destination]);assert.equal(r.output.verified,true);legacyManifest=r.output.manifest;
    const manifest=JSON.parse(fs.readFileSync(legacyManifest,'utf8')),archive=path.join(destination,manifest.archive);assert.equal(manifest.archiveSha256,sha(archive));assert.equal(fs.readFileSync(archive).subarray(0,5).toString(),'PGDMP');
    assert.equal(fs.statSync(destination).mode&0o777,0o700);assert.equal(fs.statSync(archive).mode&0o777,0o600);assert.equal(fs.statSync(legacyManifest).mode&0o777,0o600);
    assert.deepEqual(manifest.snapshot.tables,(await snapshot(sourceClient)).tables);assert.deepEqual(manifest.snapshot.sequences,(await snapshot(sourceClient)).sequences);
  });
  await test('restore check refuses nonloopback wrong-named nonempty and checksum-mismatched targets',async()=>{
    for(const url of [`postgresql://fixture:fixture@203.0.113.1:1/${prefix}external`,`postgresql://fixture:fixture@127.0.0.1:${port}/not_an_isolated_target`])assert.match(cli(null,['restore-check',legacyManifest],{expect:1,url}).stderr,/isolated loopback database/);
    const nonempty=createDatabase('nonempty');sql(nonempty,"CREATE TABLE fixture_guard(id integer PRIMARY KEY, note text); INSERT INTO fixture_guard VALUES(1,'keep');");const client=db(nonempty),before=await snapshot(client);
    assert.match(cli(nonempty,['restore-check',legacyManifest],{expect:1}).stderr,/must be empty/);assert.deepEqual(await snapshot(client),before);
    const corrupt=path.join(folder,'corrupt-backup');fs.mkdirSync(corrupt,{mode:0o700});const manifest=JSON.parse(fs.readFileSync(legacyManifest,'utf8'));fs.copyFileSync(path.join(path.dirname(legacyManifest),manifest.archive),path.join(corrupt,manifest.archive));fs.appendFileSync(path.join(corrupt,manifest.archive),'corruption');fs.writeFileSync(path.join(corrupt,'manifest.json'),JSON.stringify(manifest),{mode:0o600});
    const target=createDatabase('badchecksum');assert.match(cli(target,['restore-check',path.join(corrupt,'manifest.json')],{expect:1}).stderr,/checksum mismatch/);assert.deepEqual((await snapshot(db(target))).tables,{});
  });
  await test('verified full legacy archive restores every business row and sequence into a fresh isolated database',async()=>{
    const target=createDatabase('legacyrestore'),before=await snapshot(sourceClient);const r=cli(target,['restore-check',legacyManifest]);assert.equal(r.output.rowsAndSequencesMatch,true);
    assert.deepEqual(await snapshot(db(target)),before);assert.deepEqual(await snapshot(sourceClient),before);
  });
  await test('baseline apply requires explicit confirmation and a backup matching the exact target/data',async()=>{
    const before=await snapshot(sourceClient);assert.match(cli(sourceDb,['baseline',legacyManifest,'--apply'],{expect:1}).stderr,/confirmation is required/);await noHistory(sourceClient);
    assert.match(cli(sourceDb,['baseline','--apply'],{expect:1,env:{BASELINE_CONFIRM:'BASELINE EXISTING DATABASE'}}).stderr,/manifest path is required/);await noHistory(sourceClient);
    const foreign=path.join(folder,'foreign-backup');fs.mkdirSync(foreign,{mode:0o700});const m=JSON.parse(fs.readFileSync(legacyManifest,'utf8'));m.snapshot.targetFingerprint='wrong-fixture-target';fs.copyFileSync(path.join(path.dirname(legacyManifest),m.archive),path.join(foreign,m.archive));fs.writeFileSync(path.join(foreign,'manifest.json'),JSON.stringify(m),{mode:0o600});
    assert.match(cli(sourceDb,['baseline',path.join(foreign,'manifest.json'),'--apply'],{expect:1,env:{BASELINE_CONFIRM:'BASELINE EXISTING DATABASE'}}).stderr,/no longer match/);await noHistory(sourceClient);assert.deepEqual(await snapshot(sourceClient),before);
    const r=cli(sourceDb,['baseline',legacyManifest,'--apply'],{env:{BASELINE_CONFIRM:'BASELINE EXISTING DATABASE'}});assert.equal(r.output.metadataOnly,true);assert.equal(r.output.businessRowsChanged,0);
    assert.deepEqual(await snapshot(sourceClient,{businessOnly:true}),legacyBusiness);const history=await sourceClient.$queryRawUnsafe('SELECT migration_name FROM _prisma_migrations ORDER BY migration_name');assert.deepEqual(history.map(r=>r.migration_name),['0001_legacy_baseline']);
  });
  await test('migrate deploy upgrades Prisma6 join primary key and identity schema without altering business rows',async()=>{
    const r=cli(sourceDb,['deploy']);assert.equal(r.output.seedExecuted,false);
    // REPORTS-P1-A: 0003 is additive. The new evidence table arrives empty; every legacy row is unchanged.
    const upgraded=await snapshot(sourceClient,{businessOnly:true});assert.equal(upgraded.tables.case_deliveries?.count,'0');delete upgraded.tables.case_deliveries;
    // REPORTS-P1-C1: 0004 adds empty submissions and unstamped legacy columns; every pre-existing cases column is byte-identical.
    assert.equal(upgraded.tables.case_delivery_submissions?.count,'0');delete upgraded.tables.case_delivery_submissions;
    // REPORTS-P2-D1a: 0005 adds an empty schedule-request table and unstamped legacy schedule columns.
    assert.equal(upgraded.tables.case_schedule_requests?.count,'0');delete upgraded.tables.case_schedule_requests;
    // REPORTS-P2-D1b: 0006 adds empty cycle / lifecycle-request tables and unstamped legacy lifecycle columns.
    for(const t of ['case_cycles','case_lifecycle_requests','member_notice_dismissals']){assert.equal(upgraded.tables[t]?.count,'0',t);delete upgraded.tables[t];}
    const [life]=await sourceClient.$queryRawUnsafe(`SELECT count(*) FILTER (WHERE "lifecycleMode"<>'legacy' OR "lifecycleStatus" IS NOT NULL OR "currentCycleId" IS NOT NULL OR "pendingLifecycleRequestId" IS NOT NULL)::int AS stamped FROM cases`);
    assert.equal(life.stamped,0,'every existing case stays an unmanaged legacy lifecycle (no invented cycle)');
    const [sched]=await sourceClient.$queryRawUnsafe(`SELECT count(*) FILTER (WHERE "scheduleMode"<>'legacy' OR "scheduleModeSince" IS NOT NULL OR "scheduleBaseline" IS NOT NULL OR "pendingScheduleRequestId" IS NOT NULL)::int AS stamped FROM cases`);
    assert.equal(sched.stamped,0,'every existing case stays an unmanaged legacy schedule (no invented baseline)');
    const legacyCases=await casesProjection(sourceClient);assert.equal(legacyCases.count,legacyBusiness.tables.cases.count);
    const [stamps]=await sourceClient.$queryRawUnsafe(`SELECT count(*) FILTER (WHERE "deliveryMode"<>'legacy' OR "deliveryModeSince" IS NOT NULL OR "deliveryModeById" IS NOT NULL OR "deliveryModeRequestId" IS NOT NULL OR "pendingDeliverySubmissionId" IS NOT NULL)::int AS stamped FROM cases`);
    assert.equal(stamps.stamped,0,'every existing case stays an unstamped legacy case');
    // REPORTS-P2-D2: 0007 adds the first new serial sequence (empty notice dismissals); legacy sequences are unchanged.
    const noticeSeq=upgraded.sequences.find(q=>q.sequencename==='member_notice_dismissals_id_seq');assert(noticeSeq,'0007 sequence present');
    upgraded.sequences=upgraded.sequences.filter(q=>q!==noticeSeq);
    // REPORTS-P3-E1a: 0008 adds one B baseline event per existing report source row, one coverage row and its CACHE 1 sequence;
    // business rows are untouched. The fixture's only ChangeLog is a status change, which is not a report source row.
    const [srcRows]=await sourceClient.$queryRawUnsafe(`SELECT (SELECT count(*) FROM cases)+(SELECT count(*) FROM "_collaborators")+(SELECT count(*) FROM staff)+(SELECT count(*) FROM hotels)
      +(SELECT count(*) FROM change_logs WHERE field IN ('dispatchDate','copyDate','printDate','goLiveDate'))+(SELECT count(*) FROM case_deliveries)+(SELECT count(*) FROM case_cycles)
      +(SELECT count(*) FROM case_lifecycle_requests)+(SELECT count(*) FROM case_schedule_requests)+(SELECT count(*) FROM case_delivery_submissions) AS n`);
    const [baseline]=await sourceClient.$queryRawUnsafe(`SELECT count(*)::int AS n,count(*) FILTER (WHERE op<>'B')::int AS other,count(DISTINCT "transactionId")::int AS txs,
      bool_and("capturedAt"<=(SELECT "coverageStart" FROM report_source_coverage)) AS before FROM report_source_events`);
    assert.equal(baseline.n,Number(srcRows.n));assert.equal(baseline.other,0);assert.equal(baseline.txs,1,'one migration transaction');assert.equal(baseline.before,true,'coverage stamped after the baseline');
    assert.equal(upgraded.tables.report_source_coverage.count,'1');
    for(const t of ['report_source_events','report_source_coverage'])delete upgraded.tables[t];
    // REPORTS-P3-E1b: 0009 adds the empty immutable snapshot table only.
    assert.equal(upgraded.tables.report_snapshots?.count,'0');delete upgraded.tables.report_snapshots;
    // REPORTS-P3-E3: 0010 adds the empty job-run and scheduler-state tables only (nothing is scheduled until enabled).
    for(const t of ['report_job_runs','report_scheduler_state']){assert.equal(upgraded.tables[t]?.count,'0',t);delete upgraded.tables[t];}
    upgraded.sequences=upgraded.sequences.filter(q=>q.sequencename!=='report_source_events_id_seq');
    upgraded.tables.cases=legacyBusiness.tables.cases;assert.deepEqual(upgraded,legacyBusiness);
    // The legacy-column projection must hash the same rows as the pre-upgrade table (no rewrite of existing data).
    assert.deepEqual(legacyCases,legacyCasesProjection);
    const pk=await sourceClient.$queryRawUnsafe("SELECT conname FROM pg_constraint WHERE conrelid='public._collaborators'::regclass AND contype='p'");assert.deepEqual(pk.map(r=>r.conname),['_collaborators_AB_pkey']);
    const history=await sourceClient.$queryRawUnsafe('SELECT migration_name FROM _prisma_migrations ORDER BY migration_name');assert.deepEqual(history.map(r=>r.migration_name),['0001_legacy_baseline','0002_runtime_safety','0003_case_deliveries','0004_delivery_submissions','0005_schedule_requests','0006_case_lifecycle','0007_member_notice_dismissals','0008_report_sources','0009_report_snapshots','0010_report_jobs']);
    assert.equal(await sourceClient.deploymentIdentity.count(),0);assert.match(cli(sourceDb,['baseline'],{expect:1}).stderr,/history already exists/);
  });
  await test('identity provisioning is explicit and immutable across CLI and database constraints',async()=>{
    const instance=crypto.randomUUID();assert.equal(cli(sourceDb,['identify','restore',instance]).output.writes,0);assert.equal(await sourceClient.deploymentIdentity.count(),0);
    assert.match(cli(sourceDb,['identify','restore',instance,'--apply'],{expect:1}).stderr,/confirmation is required/);
    assert.equal(cli(sourceDb,['identify','restore',instance,'--apply'],{env:{IDENTITY_CONFIRM:'PROVISION DATABASE IDENTITY'}}).output.provisioned,true);
    assert.equal(cli(sourceDb,['identify','restore',instance,'--apply'],{env:{IDENTITY_CONFIRM:'PROVISION DATABASE IDENTITY'}}).output.alreadyProvisioned,true);
    assert.match(cli(sourceDb,['identify','restore',crypto.randomUUID(),'--apply'],{expect:1,env:{IDENTITY_CONFIRM:'PROVISION DATABASE IDENTITY'}}).stderr,/cannot be changed/);
    for(const statement of ["UPDATE deployment_identity SET environment='demo' WHERE id=1",'DELETE FROM deployment_identity','TRUNCATE deployment_identity'])await assert.rejects(sourceClient.$executeRawUnsafe(statement));
    await assert.rejects(sourceClient.$executeRawUnsafe("INSERT INTO deployment_identity(id,environment,\"instanceId\") VALUES(2,'restore','another-isolated-marker')"));
    assert.equal((await sourceClient.deploymentIdentity.findUnique({where:{id:1}})).instanceId,instance);
  });
  await test('REPORTS-P1-A delivery evidence enforces checks, append-only trigger and RESTRICT FK on upgraded legacy data',async()=>{
    const fingerprint='a'.repeat(64);
    const base={caseId:fixtureIds.caseId,itemName:'Fixture 主視覺',unit:'件',deliveredOn:new Date('2026-10-21T00:00:00Z'),recordedById:fixtureIds.member,recordedByName:'Isolated 設計師',requestFingerprint:fingerprint};
    await sourceClient.deliveryRecord.create({data:{...base,id:'pg-delivery-main-1',kind:'main',quantity:1}});
    await sourceClient.deliveryRecord.create({data:{...base,id:'pg-delivery-ext-3',kind:'extension',quantity:3,itemName:'Fixture 延伸'}});
    await sourceClient.deliveryRecord.create({data:{...base,id:'pg-delivery-support-0',kind:'support',quantity:0,itemName:'Fixture 協調',note:'協調館方確認尺寸'}});
    await sourceClient.deliveryRecord.create({data:{...base,id:'pg-delivery-leap-day',kind:'main',quantity:2,deliveredOn:new Date('2024-02-29T00:00:00Z')}});
    const invalid=[{kind:'revision',quantity:1},{kind:'main',quantity:-1},{kind:'main',quantity:1000001},{kind:'main',quantity:0},{kind:'extension',quantity:0,note:'有說明也不行'},
      {kind:'support',quantity:0},{kind:'support',quantity:0,note:'無'},{kind:'main',quantity:1,unit:'份'},{kind:'main',quantity:1,itemName:'   '},{kind:'main',quantity:1,id:'bad id'},
      {kind:'main',quantity:1,itemKey:'bad key!'},{kind:'main',quantity:1,deliveredOn:new Date('1999-12-31T00:00:00Z')},{kind:'main',quantity:1,recordedByName:' '},
      {kind:'main',quantity:1,voidedAt:new Date()},{kind:'main',quantity:1,caseId:'NO-SUCH-CASE'},{kind:'main',quantity:1,requestFingerprint:'not-a-sha256'}];
    for(const [i,extra]of invalid.entries())await assert.rejects(sourceClient.deliveryRecord.create({data:{...base,id:'pg-invalid-'+String(i).padStart(4,'0'),...extra}}),'reject '+JSON.stringify(extra));
    await assert.rejects(sourceClient.$executeRawUnsafe(`INSERT INTO case_deliveries(id,"caseId","itemName",kind,quantity,unit,"deliveredOn","recordedById","recordedByName","requestFingerprint") VALUES('pg-invalid-date1',$1,'x','main',1,'件','2026-02-30',1,'x',$2)`,fixtureIds.caseId,fingerprint),'PostgreSQL rejects impossible calendar dates');
    await assert.rejects(sourceClient.deliveryRecord.create({data:{...base,id:'pg-delivery-main-1',kind:'main',quantity:1}}),e=>e.code==='P2002');
    for(const statement of [`UPDATE case_deliveries SET quantity=5 WHERE id='pg-delivery-main-1'`,`UPDATE case_deliveries SET "itemName"='changed' WHERE id='pg-delivery-main-1'`,
      `UPDATE case_deliveries SET "voidedAt"=now() WHERE id='pg-delivery-main-1'`,`UPDATE case_deliveries SET "requestFingerprint"=repeat('b',64) WHERE id='pg-delivery-main-1'`,`DELETE FROM case_deliveries WHERE id='pg-delivery-main-1'`,'TRUNCATE case_deliveries'])await assert.rejects(sourceClient.$executeRawUnsafe(statement),statement);
    const stamp={voidedAt:new Date('2026-10-22T03:00:00Z'),voidedById:fixtureIds.admin,voidedByName:'Isolated Admin',voidReason:'登錄錯誤',voidRequestId:'pg-void-request-1'};
    assert.equal((await sourceClient.deliveryRecord.updateMany({where:{id:'pg-delivery-leap-day',voidedAt:null},data:stamp})).count,1);
    await assert.rejects(sourceClient.deliveryRecord.updateMany({where:{id:'pg-delivery-leap-day'},data:{voidReason:'改寫原因'}}),'a void stamp is one-time and immutable');
    await assert.rejects(sourceClient.deliveryRecord.updateMany({where:{id:'pg-delivery-main-1'},data:{...stamp,voidRequestId:'pg-void-request-1'}}),e=>e.code==='P2002');
    // ON DELETE RESTRICT is SQLSTATE 23001; Prisma 6 surfaces it without a P2003 code, so match the constraint.
    await assert.rejects(sourceClient.case.delete({where:{id:fixtureIds.caseId}}),e=>/case_deliveries_caseId_fkey/.test(e.message));
    await assert.rejects(sourceClient.$executeRawUnsafe('DELETE FROM cases WHERE id=$1',fixtureIds.caseId));
    // The scoped purge switch is transaction-local: it allows an explicit reset, then rolls back here with the transaction.
    await assert.rejects(sourceClient.$transaction(async tx=>{
      await tx.$queryRawUnsafe("SELECT set_config('design_pm.allow_delivery_purge', 'on', true)");
      assert.equal((await tx.deliveryRecord.deleteMany({where:{caseId:fixtureIds.caseId}})).count,4);
      throw Error('rollback purge drill');
    }),/rollback purge drill/);
    await assert.rejects(sourceClient.$executeRawUnsafe(`DELETE FROM case_deliveries WHERE id='pg-delivery-main-1'`),'the switch does not leak outside its transaction');
    assert.equal(await sourceClient.deliveryRecord.count(),4);
    const legacy=await sourceClient.case.findUnique({where:{id:fixtureIds.caseId}});assert.equal(legacy.requestCount,null);assert.equal(legacy.outputCount,null);assert.equal(legacy.contentVersion,9);
  });
  await test('REPORTS-P1-C1 0004 rejects every NULL/partial decision and mode stamp, keeps evidence append-only and mode one-way',async()=>{
    const hex=c=>c.repeat(64),now=new Date('2026-10-23T02:00:00Z');
    const base={caseId:fixtureIds.caseId,requestFingerprint:hex('a'),submittedById:fixtureIds.member,submittedByName:'Isolated 設計師',completenessConfirmed:true,caseContentVersion:9,caseUpdatedAt:now,
      archivePath:'/fixture/archive',recordIds:['pg-delivery-main-1'],recordsFingerprint:hex('b'),summary:[{kind:'main',unit:'件',quantity:1,records:1}],zeroSupport:[],itemsSnapshot:[],legacyCounts:{requestCount:null,outputCount:null}};
    const stamp={decision:'approved',decidedAt:now,decidedById:fixtureIds.admin,decidedByName:'Isolated Admin',decisionOperationId:'pg-decision-op-01',decisionFingerprint:hex('c'),zeroSupportApproved:false};
    await sourceClient.deliverySubmission.create({data:{...base,id:'pg-sub-pending-01'}});
    await sourceClient.deliverySubmission.create({data:{...base,id:'pg-sub-approved-1',...stamp}});
    const invalid=[
      ['approved without decisionFingerprint',{...stamp,decisionFingerprint:null}],['approved without decisionOperationId',{...stamp,decisionOperationId:null}],
      ['null decision with partial stamp',{...stamp,decision:null}],['decidedAt only',{decidedAt:now}],['fingerprint only',{decisionFingerprint:hex('d')}],['operation id only',{decisionOperationId:'pg-orphan-op-0001'}],
      ['approved without zeroSupportApproved',{...stamp,zeroSupportApproved:null}],['approved zero support without explicit approval',{...stamp,zeroSupport:[{id:'z',itemName:'協調',note:'協調館方'}],zeroSupportApproved:false}],
      ['rejected without reason',{...stamp,decision:'rejected',zeroSupportApproved:null}],['withdrawn with zeroSupportApproved',{...stamp,decision:'withdrawn',decisionReason:'更正',zeroSupportApproved:true}],
      ['unknown decision',{...stamp,decision:'maybe'}],['bad fingerprint',{...stamp,decisionFingerprint:'not-hex'}],['decidedBy missing',{...stamp,decidedById:null}],
      ['unconfirmed completeness',{completenessConfirmed:false}],['no records',{recordIds:[]}],['blank archive',{archivePath:'  '}],['bad id',{id:'bad id'}],['bad request fingerprint',{requestFingerprint:'x'}],
      ['records ids not array',{recordIds:{}}],['missing case',{caseId:'NO-SUCH-CASE'}],
    ];
    for(const [i,[label,extra]]of invalid.entries())await assert.rejects(sourceClient.deliverySubmission.create({data:{...base,id:'pg-sub-invalid-'+String(i).padStart(3,'0'),...extra}}),label);
    // Updates on the pending row: partial stamps refused, one full stamp allowed exactly once, content immutable.
    for(const [label,data]of [['decision only',{decision:'withdrawn'}],['stamp without fingerprint',{decision:'withdrawn',decidedAt:now,decidedById:fixtureIds.member,decidedByName:'x',decisionReason:'更正數量',decisionOperationId:'pg-wd-op-000001'}],
      ['stamp without operation id',{decision:'withdrawn',decidedAt:now,decidedById:fixtureIds.member,decidedByName:'x',decisionReason:'更正數量',decisionFingerprint:hex('e')}]])
      await assert.rejects(sourceClient.deliverySubmission.updateMany({where:{id:'pg-sub-pending-01'},data}),label);
    await assert.rejects(sourceClient.$executeRawUnsafe(`UPDATE case_delivery_submissions SET "archivePath"='/elsewhere' WHERE id='pg-sub-pending-01'`),'evidence immutable');
    assert.equal((await sourceClient.deliverySubmission.updateMany({where:{id:'pg-sub-pending-01',decidedAt:null},data:{decision:'withdrawn',decidedAt:now,decidedById:fixtureIds.member,decidedByName:'Isolated 設計師',decisionReason:'更正數量',decisionOperationId:'pg-wd-op-000001',decisionFingerprint:hex('e')}})).count,1);
    for(const statement of [`UPDATE case_delivery_submissions SET "decisionReason"='改寫' WHERE id='pg-sub-pending-01'`,`UPDATE case_delivery_submissions SET decision='approved' WHERE id='pg-sub-approved-1'`,
      `DELETE FROM case_delivery_submissions WHERE id='pg-sub-approved-1'`,'TRUNCATE case_delivery_submissions'])await assert.rejects(sourceClient.$executeRawUnsafe(statement),statement);
    await assert.rejects(sourceClient.deliverySubmission.create({data:{...base,id:'pg-sub-dup-op-01',...stamp}}),e=>e.code==='P2002','decision operation ids are unique');
    // Case mode stamp: records always name a real actor id; request id and fingerprint are both-or-neither.
    const legacyCase='B-2026-10-002',records={deliveryMode:'records',deliveryModeSince:now,deliveryModeById:fixtureIds.admin,deliveryModeByName:'Isolated Admin',deliveryModeReason:'測試導入'};
    for(const [label,data]of [['records without actor id',{...records,deliveryModeById:null}],['request id without fingerprint',{...records,deliveryModeRequestId:'pg-adopt-req-01'}],
      ['fingerprint without request id',{...records,deliveryModeFingerprint:hex('f')}],['records without reason',{...records,deliveryModeReason:null}],['legacy with stray stamp',{deliveryModeById:fixtureIds.admin}],
      ['unknown mode',{deliveryMode:'hybrid'}],['pending submission outside review_done',{...records,pendingDeliverySubmissionId:'pg-sub-pending-01'}]])
      await assert.rejects(sourceClient.case.update({where:{id:legacyCase},data}),label);
    await sourceClient.case.update({where:{id:legacyCase},data:records}); // new-case style stamp: both request fields null
    for(const [label,data]of [['back to legacy',{deliveryMode:'legacy',deliveryModeSince:null,deliveryModeById:null,deliveryModeByName:null,deliveryModeReason:null}],['rewrite reason',{deliveryModeReason:'改寫原因'}],['rewrite actor',{deliveryModeById:fixtureIds.member}]])
      await assert.rejects(sourceClient.case.update({where:{id:legacyCase},data}),label);
    await assert.rejects(sourceClient.case.delete({where:{id:fixtureIds.caseId}}),e=>/case_deliver(ies|y_submissions)_caseId_fkey/.test(e.message));
    await assert.rejects(sourceClient.$transaction(async tx=>{
      await tx.$queryRawUnsafe("SELECT set_config('design_pm.allow_delivery_purge', 'on', true)");
      assert.equal((await tx.deliverySubmission.deleteMany({})).count,2);throw Error('rollback submission purge drill');
    }),/rollback submission purge drill/);
    assert.equal(await sourceClient.deliverySubmission.count(),2);assert.equal((await sourceClient.case.findUnique({where:{id:legacyCase}})).deliveryMode,'records');
  });
  await test('REPORTS-P2-D1a 0005 enforces null-safe schedule stamps, one pending per case, append-only once-only decisions and one-way managed mode',async()=>{
    const hex=c=>c.repeat(64),now=new Date('2026-10-26T02:00:00Z'),caseId=fixtureIds.caseId;
    const current={dispatchDate:'2026-10-02',copyDate:'2026-10-10',printDate:null,goLiveDate:'2026-10-30'},proposed={...current,printDate:'2026-11-01',goLiveDate:'2026-11-06'};
    const baseline={...current,observedAt:now.toISOString(),source:'observed_at_adoption'};
    const managed={scheduleMode:'managed',scheduleModeSince:now,scheduleModeById:fixtureIds.admin,scheduleModeByName:'Isolated Admin',scheduleModeReason:'試行時程受控',scheduleModeRequestId:'pg-sched-adopt-01',scheduleModeFingerprint:hex('a'),scheduleBaseline:baseline};
    for(const [label,data]of [['managed without baseline',{...managed,scheduleBaseline:null}],['baseline wrong source',{...managed,scheduleBaseline:{...baseline,source:'original_promise'}}],
      ['baseline missing printDate',{...managed,scheduleBaseline:(({printDate,...b})=>b)(baseline)}],['managed without actor',{...managed,scheduleModeById:null}],['managed without request id',{...managed,scheduleModeRequestId:null}],
      ['managed without fingerprint',{...managed,scheduleModeFingerprint:null}],['blank reason',{...managed,scheduleModeReason:' '}],['legacy with stray stamp',{scheduleModeById:fixtureIds.admin}],
      ['legacy with baseline',{scheduleBaseline:baseline}],['unknown mode',{scheduleMode:'loose'}],['pending pointer on legacy',{pendingScheduleRequestId:'pg-sched-req-0001'}]])
      await assert.rejects(sourceClient.case.update({where:{id:caseId},data}),label);
    await sourceClient.case.update({where:{id:caseId},data:managed});
    const base={caseId,requestFingerprint:hex('b'),requestedById:fixtureIds.member,requestedByName:'Isolated 設計師',reasonCategory:'requester_change',reason:'需求方延後活動檔期',
      currentSchedule:current,proposedSchedule:proposed,caseUpdatedAt:now,caseContentVersion:3,assignmentSnapshot:{designerId:fixtureIds.member,collaboratorIds:[]}};
    const invalid=[['bad category',{reasonCategory:'blame'}],['short reason',{reason:'x'}],['half impact',{impactFrom:now}],['reversed impact',{impactFrom:new Date('2026-10-22'),impactTo:new Date('2026-10-20')}],
      ['schedule missing printDate',{proposedSchedule:(({printDate,...x})=>x)(proposed)}],['schedule bad date',{proposedSchedule:{...proposed,goLiveDate:'2026/11/06'}}],['schedule extra key',{proposedSchedule:{...proposed,openDate:'2026-10-01'}}],
      ['required date null',{proposedSchedule:{...proposed,goLiveDate:null}}],['no change',{proposedSchedule:current}],['bad assignment',{assignmentSnapshot:{designerId:'x',collaboratorIds:[]}}],
      ['bad id',{id:'bad id'}],['bad fingerprint',{requestFingerprint:'nope'}],['missing case',{caseId:'NO-SUCH-CASE'}]];
    for(const [i,[label,extra]]of invalid.entries())await assert.rejects(sourceClient.scheduleRequest.create({data:{...base,id:'pg-sched-bad-'+String(i).padStart(3,'0'),...extra}}),label);
    await sourceClient.scheduleRequest.create({data:{...base,id:'pg-sched-req-0001'}});
    // one undecided request per case is a database invariant (independent of the case pointer)
    await assert.rejects(sourceClient.scheduleRequest.create({data:{...base,id:'pg-sched-req-0002'}}),e=>e.code==='P2002','second pending request for the same case');
    await assert.rejects(sourceClient.$executeRawUnsafe(`INSERT INTO case_schedule_requests (id,"caseId","requestFingerprint","requestedById","requestedByName","reasonCategory",reason,"currentSchedule","proposedSchedule","caseUpdatedAt","caseContentVersion","assignmentSnapshot")
      VALUES ('pg-sched-raw-0001',$1,$2,$3,'raw','other','直接插入第二筆',$4::jsonb,$5::jsonb,now(),3,'{"designerId":1,"collaboratorIds":[]}'::jsonb)`,caseId,hex('c'),fixtureIds.member,JSON.stringify(current),JSON.stringify(proposed)),'raw SQL second pending');
    await sourceClient.case.update({where:{id:caseId},data:{pendingScheduleRequestId:'pg-sched-req-0001'}});
    const stamp={decision:'approved',decidedAt:now,decidedById:fixtureIds.admin,decidedByName:'Isolated Admin',decisionOperationId:'pg-sched-op-0001',decisionFingerprint:hex('d'),approvedSchedule:proposed};
    for(const [label,data]of [['approved without approvedSchedule',{...stamp,approvedSchedule:null}],['approved schedule differs from proposal',{...stamp,approvedSchedule:{...proposed,goLiveDate:'2026-12-01'}}],
      ['rejected without reason',{...stamp,decision:'rejected',approvedSchedule:null}],['rejected with approvedSchedule',{...stamp,decision:'rejected',decisionReason:'不同意延期'}],
      ['decision only',{decision:'withdrawn'}],['stamp without fingerprint',{...stamp,decisionFingerprint:null}],['stamp without operation id',{...stamp,decisionOperationId:null}],
      ['null decision partial stamp',{...stamp,decision:null}],['unknown decision',{...stamp,decision:'maybe'}],['decidedBy missing',{...stamp,decidedById:null}]])
      await assert.rejects(sourceClient.scheduleRequest.updateMany({where:{id:'pg-sched-req-0001'},data}),label);
    await assert.rejects(sourceClient.$executeRawUnsafe(`UPDATE case_schedule_requests SET reason='改寫原因說明' WHERE id='pg-sched-req-0001'`),'request content immutable');
    assert.equal((await sourceClient.scheduleRequest.updateMany({where:{id:'pg-sched-req-0001',decidedAt:null},data:stamp})).count,1);
    for(const statement of [`UPDATE case_schedule_requests SET "decisionReason"='改寫' WHERE id='pg-sched-req-0001'`,`UPDATE case_schedule_requests SET decision='rejected' WHERE id='pg-sched-req-0001'`,
      `DELETE FROM case_schedule_requests WHERE id='pg-sched-req-0001'`,'TRUNCATE case_schedule_requests'])await assert.rejects(sourceClient.$executeRawUnsafe(statement),statement);
    await sourceClient.case.update({where:{id:caseId},data:{pendingScheduleRequestId:null}});
    await sourceClient.scheduleRequest.create({data:{...base,id:'pg-sched-req-0003'}}); // a decided request frees the one-pending slot
    await assert.rejects(sourceClient.scheduleRequest.create({data:{...base,id:'pg-sched-dup-op-1',...stamp}}),e=>e.code==='P2002','decision operation ids are unique');
    for(const [label,data]of [['back to legacy',{scheduleMode:'legacy',scheduleModeSince:null,scheduleModeById:null,scheduleModeByName:null,scheduleModeReason:null,scheduleModeRequestId:null,scheduleModeFingerprint:null,scheduleBaseline:null}],
      ['rewrite baseline',{scheduleBaseline:{...baseline,goLiveDate:'2026-12-31'}}],['rewrite reason',{scheduleModeReason:'改寫原因'}]])
      await assert.rejects(sourceClient.case.update({where:{id:caseId},data}),label);
    assert.equal((await sourceClient.case.findUnique({where:{id:caseId}})).deliveryMode,'legacy','schedule mode is independent of delivery mode');
    await assert.rejects(sourceClient.case.delete({where:{id:caseId}}),e=>/case_(deliver(ies|y_submissions)|schedule_requests)_caseId_fkey/.test(e.message));
    await assert.rejects(sourceClient.$transaction(async tx=>{
      await tx.$queryRawUnsafe("SELECT set_config('design_pm.allow_delivery_purge', 'on', true)");
      assert.equal((await tx.scheduleRequest.deleteMany({})).count,2);throw Error('rollback schedule purge drill');
    }),/rollback schedule purge drill/);
    assert.equal(await sourceClient.scheduleRequest.count(),2);
  });
  await test('REPORTS-P2-D1b 0006 enforces commit-time cycle/request graph, locked delivery attribution, snapshot completeness and same-transaction reset',async()=>{
    const hex=c=>c.repeat(64),now=new Date('2026-10-26T04:00:00Z'),day=x=>new Date(x+'T00:00:00Z'),caseId='D1B-PG-0001',admin=fixtureIds.admin,member=fixtureIds.member;
    await sourceClient.case.create({data:{id:caseId,title:'D1b fixture',requester:'Fixture',level:'A',status:'doing',designerId:member,openDate:day('2026-10-01'),dispatchDate:day('2026-10-02'),goLiveDate:day('2026-10-30'),archivePath:'/fixture/d1b'}});
    const sched={dispatchDate:'2026-10-02',copyDate:null,printDate:null,goLiveDate:'2026-10-30'},assignment={designerId:member,designerName:'Isolated 設計師',collaborators:[]},counts={requestCount:null,outputCount:null};
    const start={source:'observed_at_adoption',attribution:'legacy_unknown',status:'doing',schedule:sched,assignment,archivePath:'/fixture/d1b',carryForwardDeliveryIds:[],legacyCounts:counts};
    const cycle1={id:'pg-cycle-000001',caseId,sequence:1,source:'adoption',startedById:admin,startedByName:'Isolated Admin',startReason:'試行生命週期管理',startRequestId:'pg-lc-adopt-0001',startSnapshot:start};
    const stamp={lifecycleMode:'managed',lifecycleModeSince:now,lifecycleModeById:admin,lifecycleModeByName:'Isolated Admin',lifecycleModeReason:'試行生命週期管理',lifecycleModeRequestId:'pg-lc-adopt-0001',lifecycleModeFingerprint:hex('a'),lifecycleStatus:'active',currentCycleId:cycle1.id};
    const tx=fn=>sourceClient.$transaction(fn);
    // incomplete / mismatched start evidence is refused
    for(const [label,snap]of [['adoption labelled resume',{...start,source:'resume_approved'}],['missing assignment',(({assignment,...x})=>x)(start)],['missing archivePath key',(({archivePath,...x})=>x)(start)],['missing legacy counts',(({legacyCounts,...x})=>x)(start)]])
      await assert.rejects(tx(async t=>{await t.caseCycle.create({data:{...cycle1,startSnapshot:snap}});await t.case.update({where:{id:caseId},data:stamp});}),label);
    // a managed stamp whose current cycle does not exist fails at commit (deferred same-case FK + graph)
    await assert.rejects(tx(async t=>{await t.case.update({where:{id:caseId},data:{...stamp,currentCycleId:'pg-cycle-missing1'}});}),'dangling current cycle');
    await tx(async t=>{await t.caseCycle.create({data:cycle1});await t.case.update({where:{id:caseId},data:stamp});}); // legal adoption
    // ending the current cycle without moving the case is a broken graph at commit
    const endBase={endedAt:now,outcome:'completed',endedById:admin,endedByName:'Isolated Admin',endReason:'案件結案',endSnapshot:{status:'closed',schedule:sched,assignment,archivePath:'/fixture/d1b',noFile:null,activeDeliveryIds:[],cycleDeliveryIds:[],legacyCounts:counts}};
    await assert.rejects(tx(async t=>{await t.caseCycle.update({where:{id:cycle1.id},data:endBase});}),'active case with an ended current cycle');
    // a sealed end without archive or no-file evidence violates the CHECK
    await assert.rejects(tx(async t=>{await t.caseCycle.update({where:{id:cycle1.id},data:{...endBase,outcome:'sealed_incomplete',endRequestId:'pg-lc-seal-00001',endSnapshot:{...endBase.endSnapshot,archivePath:null}}});}),'seal without evidence');
    // delivery in the open cycle is fine; a pending seal blocks new deliveries (locked trigger)
    const delivery=(id,extra={})=>({id,caseId,itemName:'Fixture 主視覺',kind:'main',quantity:1,unit:'件',deliveredOn:day('2026-10-21'),recordedById:member,recordedByName:'Isolated 設計師',requestFingerprint:hex('b'),cycleId:cycle1.id,...extra});
    await sourceClient.deliveryRecord.create({data:delivery('pg-d1b-dlv-0001')});
    await assert.rejects(sourceClient.deliveryRecord.create({data:delivery('pg-d1b-dlv-0002',{cycleId:null})}),'managed delivery without cycle');
    await assert.rejects(sourceClient.$executeRawUnsafe(`UPDATE case_deliveries SET "cycleId"=NULL WHERE id='pg-d1b-dlv-0001'`),'attribution immutable');
    const reqSnap={status:'doing',schedule:sched,assignment:{designerId:member,collaboratorIds:[]},archivePath:'/fixture/d1b',activeDeliveryIds:['pg-d1b-dlv-0001']};
    const seal={id:'pg-lc-seal-00001',caseId,kind:'seal',cycleId:cycle1.id,requestFingerprint:hex('c'),requestedById:member,requestedByName:'Isolated 設計師',reasonCategory:'requester_change',reason:'需求方暫停活動',archivePath:'/fixture/d1b',snapshot:reqSnap,caseUpdatedAt:now,caseContentVersion:1};
    await assert.rejects(tx(async t=>{await t.lifecycleRequest.create({data:{...seal,reasonCategory:'blame'}});await t.case.update({where:{id:caseId},data:{pendingLifecycleRequestId:seal.id}});}),'bad reason category');
    await assert.rejects(tx(async t=>{await t.lifecycleRequest.create({data:seal});}),'undecided request without the case pointer');
    await tx(async t=>{await t.lifecycleRequest.create({data:seal});await t.case.update({where:{id:caseId},data:{pendingLifecycleRequestId:seal.id}});});
    await assert.rejects(sourceClient.deliveryRecord.create({data:delivery('pg-d1b-dlv-0003')}),'delivery while a seal is pending');
    await assert.rejects(sourceClient.case.update({where:{id:caseId},data:{pendingScheduleRequestId:'pg-sched-x'}}),'two pending pointers');
    // legal seal approval: end cycle + approve request + case sealed, one transaction
    const sealEnd={...endBase,outcome:'sealed_incomplete',endReason:'未完成封存',endRequestId:seal.id,endSnapshot:{...endBase.endSnapshot,status:'doing',activeDeliveryIds:['pg-d1b-dlv-0001'],cycleDeliveryIds:['pg-d1b-dlv-0001']}};
    const decided=(op,extra={})=>({decision:'approved',decidedAt:now,decidedById:admin,decidedByName:'Isolated Admin',decisionOperationId:op,decisionFingerprint:hex('d'),...extra});
    await assert.rejects(tx(async t=>{await t.caseCycle.update({where:{id:cycle1.id},data:sealEnd});await t.case.update({where:{id:caseId},data:{lifecycleStatus:'sealed_incomplete',archived:true,pendingLifecycleRequestId:null}});}),'seal without an approved request');
    await tx(async t=>{await t.caseCycle.update({where:{id:cycle1.id},data:sealEnd});await t.lifecycleRequest.update({where:{id:seal.id},data:decided('pg-lc-op-000001')});
      await t.case.update({where:{id:caseId},data:{lifecycleStatus:'sealed_incomplete',archived:true,pendingLifecycleRequestId:null}});});
    // sealed → active without a successor cycle is refused; deliveries into the ended cycle too
    await assert.rejects(sourceClient.$executeRawUnsafe(`UPDATE cases SET "lifecycleStatus"='active', archived=false WHERE id='${caseId}'`),'unseal without resume');
    await assert.rejects(sourceClient.deliveryRecord.create({data:delivery('pg-d1b-dlv-0004')}),'delivery into a sealed cycle');
    // legal resume: request → successor cycle 2 + approved result link + case active, one transaction
    const resume={...seal,id:'pg-lc-resume-001',kind:'resume',archivePath:null,reason:'需求方確認恢復',requestFingerprint:hex('e')};
    await tx(async t=>{await t.lifecycleRequest.create({data:resume});await t.case.update({where:{id:caseId},data:{pendingLifecycleRequestId:resume.id}});});
    const cycle2={...cycle1,id:'pg-cycle-000002',sequence:2,source:'resume',startRequestId:resume.id,startSnapshot:{...start,source:'resume_approved',attribution:'cycle_tracked',resumedFromCycleId:cycle1.id,carryForwardDeliveryIds:['pg-d1b-dlv-0001']}};
    await assert.rejects(tx(async t=>{await t.caseCycle.create({data:{...cycle2,sequence:3}});await t.lifecycleRequest.update({where:{id:resume.id},data:decided('pg-lc-op-000002',{resultCycleId:cycle2.id})});
      await t.case.update({where:{id:caseId},data:{lifecycleStatus:'active',archived:false,currentCycleId:cycle2.id,pendingLifecycleRequestId:null}});}),'successor must be the next sequence');
    await assert.rejects(tx(async t=>{await t.lifecycleRequest.update({where:{id:resume.id},data:decided('pg-lc-op-000003',{resultCycleId:cycle1.id})});}),'result cycle cannot be the sealed cycle');
    await tx(async t=>{await t.caseCycle.create({data:cycle2});await t.lifecycleRequest.update({where:{id:resume.id},data:decided('pg-lc-op-000004',{resultCycleId:cycle2.id})});
      await t.case.update({where:{id:caseId},data:{lifecycleStatus:'active',archived:false,currentCycleId:cycle2.id,pendingLifecycleRequestId:null}});});
    await assert.rejects(sourceClient.caseCycle.create({data:{...cycle2,id:'pg-cycle-000003',sequence:3}}),'a second open cycle');
    await sourceClient.deliveryRecord.create({data:delivery('pg-d1b-dlv-0005',{cycleId:cycle2.id})});
    await assert.rejects(sourceClient.deliveryRecord.create({data:delivery('pg-d1b-dlv-0006',{cycleId:cycle1.id})}),'new delivery attributed to the old cycle');
    for(const statement of [`UPDATE case_cycles SET "endReason"='改寫' WHERE id='${cycle1.id}'`,`UPDATE case_cycles SET "startReason"='改寫原因' WHERE id='${cycle2.id}'`,`DELETE FROM case_cycles WHERE id='${cycle1.id}'`,
      `UPDATE case_lifecycle_requests SET reason='改寫' WHERE id='${seal.id}'`,'TRUNCATE case_lifecycle_requests'])await assert.rejects(sourceClient.$executeRawUnsafe(statement),statement);
    await assert.rejects(sourceClient.case.delete({where:{id:caseId}}),'ordinary delete refused');
    // an explicit same-transaction reset of this case's whole graph commits (reverse pointers are deferred NO ACTION)
    await tx(async t=>{await t.$queryRawUnsafe("SELECT set_config('design_pm.allow_delivery_purge', 'on', true)");
      await t.lifecycleRequest.deleteMany({where:{caseId}});await t.deliveryRecord.deleteMany({where:{caseId}});await t.caseCycle.deleteMany({where:{caseId}});await t.case.delete({where:{id:caseId}});});
    assert.equal(await sourceClient.case.count({where:{id:caseId}}),0);assert.equal(await sourceClient.caseCycle.count(),0);assert.equal(await sourceClient.lifecycleRequest.count(),0);
  });
  await test('REPORTS-P2-D2 0007 keeps one dismissal per account and notice version, validates ids and follows the account',async()=>{
    // Own freshly deployed database, so the shared upgrade/restore fixture (and its sequences) stays untouched.
    const name=createDatabase('notices'),sourceClient=db(name);assert.equal(cli(name,['deploy']).output.seedExecuted,false);
    const temp=await sourceClient.staff.create({data:{name:'Notice fixture',email:'notice.fixture@example.invalid',password:'unusable-fixture-value',role:'member',seniority:'mid',joined:new Date('2026-10-01T00:00:00Z')}});
    await sourceClient.memberNoticeDismissal.create({data:{staffId:temp.id,noticeId:'qa-synthetic-notice-v1'}});
    await assert.rejects(sourceClient.memberNoticeDismissal.create({data:{staffId:temp.id,noticeId:'qa-synthetic-notice-v1'}}),e=>e.code==='P2002','one row per account and notice');
    await sourceClient.memberNoticeDismissal.create({data:{staffId:temp.id,noticeId:'qa-synthetic-notice-v2'}}); // a new version is a new row
    await assert.rejects(sourceClient.memberNoticeDismissal.create({data:{staffId:temp.id,noticeId:'bad id!'}}),'notice id format');
    await assert.rejects(sourceClient.memberNoticeDismissal.create({data:{staffId:999999,noticeId:'qa-synthetic-notice-v1'}}),'account must exist');
    assert.equal(await sourceClient.memberNoticeDismissal.count({where:{staffId:temp.id}}),2);
    await sourceClient.staff.delete({where:{id:temp.id}});
    assert.equal(await sourceClient.memberNoticeDismissal.count({where:{staffId:temp.id}}),0,'dismissals follow the account (not business evidence)');
  });
  let restoredClient;
  await test('upgraded custom dump restores all tables migration history identity triggers and sequences exactly',async()=>{
    // REPORTS-P3-E1b: an initial version and a revision published through the real service (sources since coverage = deploy time,
    // so the ended week is an honest insufficient snapshot) are part of the backup.
    // workReports.js loads src/lib/db.js (ESM-cached for the whole drill): point it at the restore target first, which is exactly
    // what the later calendar-subscription test expects of that shared module. The service below uses an explicit client.
    const target=createDatabase('upgradedrestore');process.env.DATABASE_URL=urlFor(target);
    const WR=await import(root+'/src/lib/workReports.js'),RP=await import(root+'/src/lib/reportPeriods.js');const svc=WR.createWorkReportService({db:sourceClient});
    const [{today}]=await sourceClient.$queryRawUnsafe(`SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') AS today`);
    const lastWeek=RP.previousPeriod(RP.periodContaining('week',today)),adminUser={id:fixtureIds.admin},adminAuth={sessionVersion:7};
    const v1=await svc.generate(adminUser,adminAuth,{periodKind:'week',startDate:lastWeek.startDate,idempotencyKey:'restore-gen-0001'});assert.equal(v1.status,201);
    const v2=await svc.revise(adminUser,adminAuth,v1.snapshot.id,{reason:'備份前修訂驗證',expectedLatestRevision:1,idempotencyKey:'restore-rev-0001'});assert.equal(v2.status,201);
    const r=cli(sourceDb,['backup',path.join(folder,'upgraded-backup')]);currentManifest=r.output.manifest;sourceBeforeRestore=await snapshot(sourceClient);
    restoredClient=db(target);const restored=cli(target,['restore-check',currentManifest]);assert.equal(restored.output.rowsAndSequencesMatch,true);
    assert.deepEqual(await snapshot(restoredClient),sourceBeforeRestore);assert.deepEqual(await snapshot(sourceClient),sourceBeforeRestore);
    const identity=await restoredClient.deploymentIdentity.findUnique({where:{id:1}});assert.equal(identity.environment,'restore');await assert.rejects(restoredClient.$executeRawUnsafe('TRUNCATE deployment_identity'));
    // REPORTS-P1-A: delivery evidence, its void stamp and its append-only trigger survive backup/restore.
    assert.equal(sourceBeforeRestore.tables.case_deliveries.count,'4');
    // REPORTS-P1-C1: submissions, their stamps, the records mode and both triggers survive backup/restore.
    assert.equal(sourceBeforeRestore.tables.case_delivery_submissions.count,'2');assert.equal(await restoredClient.deliverySubmission.count({where:{decidedAt:{not:null}}}),2);
    await assert.rejects(restoredClient.$executeRawUnsafe(`DELETE FROM case_delivery_submissions WHERE id='pg-sub-approved-1'`));
    await assert.rejects(restoredClient.case.update({where:{id:'B-2026-10-002'},data:{deliveryMode:'legacy',deliveryModeSince:null,deliveryModeById:null,deliveryModeByName:null,deliveryModeReason:null}}));assert.equal(await restoredClient.deliveryRecord.count({where:{voidedAt:{not:null}}}),1);
    await assert.rejects(restoredClient.$executeRawUnsafe(`DELETE FROM case_deliveries WHERE id='pg-delivery-main-1'`));await assert.rejects(restoredClient.case.delete({where:{id:fixtureIds.caseId}}),e=>/case_deliveries_caseId_fkey/.test(e.message));
    // REPORTS-P3-E1a: report source events, coverage and the sequence restore exactly; capture and append-only guards are live after restore.
    assert(Number(sourceBeforeRestore.tables.report_source_events.count)>0);assert.equal(sourceBeforeRestore.tables.report_source_coverage.count,'1');
    assert.deepEqual(await reportTimes(restoredClient),await reportTimes(sourceClient));
    await assert.rejects(restoredClient.$executeRawUnsafe('DELETE FROM report_source_events'));await assert.rejects(restoredClient.$executeRawUnsafe('TRUNCATE cases'));
    const [restoredSeq]=await restoredClient.$queryRawUnsafe(`SELECT seqcache::int AS cache,seqcycle AS cycle FROM pg_sequence WHERE seqrelid='report_source_events_id_seq'::regclass`);assert.deepEqual(restoredSeq,{cache:1,cycle:false});
    // REPORTS-P3-E1b: both snapshot versions (microsecond times, payload, hash, version chain) restore exactly; immutability is live.
    assert.equal(sourceBeforeRestore.tables.report_snapshots.count,'2');
    const rs=WR.createWorkReportService({db:restoredClient}),ss=WR.createWorkReportService({db:sourceClient});
    const [rows]=await restoredClient.$queryRawUnsafe(`SELECT array_agg(id ORDER BY revision) AS ids FROM report_snapshots`);assert.equal(rows.ids.length,2);
    for(const id of rows.ids)assert.deepEqual(await rs.get(id),await ss.get(id));
    // REPORTS-P3-E3: report_job_runs now references snapshots, so PostgreSQL refuses a plain TRUNCATE before the trigger runs (still refused).
    for(const stmt of ['UPDATE report_snapshots SET "revisionReason"=\'x\'','DELETE FROM report_snapshots','TRUNCATE report_snapshots'])await assert.rejects(restoredClient.$executeRawUnsafe(stmt),/immutable|cannot truncate a table referenced in a foreign key/,stmt);
  });
  await test('restored relations dates JSON versions FK uniqueness and serial sequences remain operational',async()=>{
    const row=await restoredClient.case.findUnique({where:{id:fixtureIds.caseId},include:{collaborators:true,meetings:{include:{attendees:true}}}});
    assert.equal(row.contentVersion,9);assert.equal(row.items[0].n,'Fixture 子項目');assert.equal(row.logs[0].note,'Synthetic history 文本');assert.equal(row.dispatchDate.toISOString(),'2026-10-22T00:00:00.000Z');assert.equal(row.collaborators.length,2);assert.equal(row.meetings[0].startTime,'09:30');assert.equal(row.meetings[0].attendees.length,2);
    const sequence=sourceBeforeRestore.sequences.find(s=>s.sequencename==='staff_id_seq');assert.equal(Number(sequence.last_value),fixtureIds.sequenceHole);
    const next=await restoredClient.staff.create({data:{name:'Restored sequence next',email:'restored-next@example.invalid',password:'unusable-fixture-value',joined:day(),seniority:'mid'}});assert.equal(next.id,Number(sequence.last_value)+1);
    await assert.rejects(restoredClient.vacation.create({data:{staffId:999999,startDate:day(),endDate:day()}}),e=>e.code==='P2003');
    await assert.rejects(restoredClient.$executeRawUnsafe('INSERT INTO _collaborators("A","B") VALUES($1,$2)',fixtureIds.caseId,fixtureIds.admin));
    assert.equal((await restoredClient.case.updateMany({where:{id:fixtureIds.caseId,contentVersion:9},data:{contentVersion:{increment:1}}})).count,1);
    assert.equal((await restoredClient.case.updateMany({where:{id:fixtureIds.caseId,contentVersion:9},data:{contentVersion:{increment:1}}})).count,0);
  });
  await test('restored calendar subscription versions authenticate and revoke against the real isolated DB',async()=>{
    const target=[...databases].find(n=>n.endsWith('_upgradedrestore'));process.env.DATABASE_URL=urlFor(target);process.env.JWT_SECRET='isolated-maintenance-calendar-fixture-secret';process.env.APP_BASE_URL='https://fixture.invalid';process.env.NODE_ENV='test';
    const calendar=await import(root+'/src/services/calendarSubscription.js');const {prisma:calendarDb}=await import(root+'/src/lib/db.js');clients.push(calendarDb);
    const member=await restoredClient.staff.findUnique({where:{id:fixtureIds.member}});assert.equal(member.sessionVersion,2);assert.equal(member.calendarVersion,5);
    const subscription=calendar.createCalendarSubscription(member,'mine'),token=new URL(subscription.url).searchParams.get('token');assert.equal((await calendar.authenticateCalendarSubscription(token)).staffId,member.id);
    await restoredClient.staff.update({where:{id:member.id},data:{calendarVersion:{increment:1}}});assert.equal(await calendar.authenticateCalendarSubscription(token),null);assert.deepEqual(await snapshot(sourceClient),sourceBeforeRestore);
  });
  await test('REPORTS-P3-E1a whitelist capture reconstructs every source table exactly, never captures secrets, and keeps events append-only',async()=>{
    // Runs after the restore checks on the upgraded fixture, whose 0004–0007 tests already wrote submissions, schedule/lifecycle
    // requests, cycles, deliveries (incl. voids) and decisions through the live capture triggers.
    const RS=await import(root+'/src/lib/reportSources.js');
    const [seq]=await sourceClient.$queryRawUnsafe(`SELECT seqcache::int AS cache,seqcycle AS cycle FROM pg_sequence WHERE seqrelid='report_source_events_id_seq'::regclass`);assert.deepEqual(seq,{cache:1,cycle:false});
    const count=async()=>Number((await sourceClient.$queryRawUnsafe('SELECT count(*)::text AS n FROM report_source_events'))[0].n);
    // secrets: password/email/token/session/calendar changes record nothing; no event anywhere carries those keys or values
    let before=await count();
    await sourceClient.$executeRawUnsafe(`UPDATE staff SET password='secret-pass-e1a',email='secret-e1a@example.invalid',"activationTokenHash"='secret-act-e1a',"resetTokenHash"='secret-reset-e1a',
      "resetExpires"=now(),"activationExpires"=now(),"sessionVersion"="sessionVersion"+1,"calendarVersion"="calendarVersion"+1,seniority='senior',color='teal' WHERE id=$1`,fixtureIds.member);
    assert.equal(await count(),before,'no whitelisted staff column changed → no event');
    await sourceClient.$executeRawUnsafe(`UPDATE staff SET name='Isolated 設計師 改名' WHERE id=$1`,fixtureIds.member);
    const [renamed]=await sourceClient.$queryRawUnsafe(`SELECT op,data FROM report_source_events ORDER BY id DESC LIMIT 1`);assert.deepEqual(renamed,{op:'U',data:{name:'Isolated 設計師 改名'}});
    const [leak]=await sourceClient.$queryRawUnsafe(`SELECT count(*)::int AS n FROM report_source_events WHERE data ?| array['password','email','activationTokenHash','resetTokenHash','activationExpires','resetExpires','sessionVersion','calendarVersion']
      OR data::text ~ '(secret-|unusable-fixture-value|@example\.invalid)'`);assert.equal(leak.n,0,'zero secret keys or values in any event');
    // change_logs: only the four milestone fields; moving into/out of the set becomes I/D
    before=await count();
    const [cl]=await sourceClient.$queryRawUnsafe(`INSERT INTO change_logs("caseId",field,"fromValue","toValue",reason,operator) VALUES ($1,'goLiveDate','2026-11-05','2026-11-01','需求方提早上線','Isolated Admin') RETURNING id`,fixtureIds.caseId);
    const [other]=await sourceClient.$queryRawUnsafe(`INSERT INTO change_logs("caseId",field,"fromValue","toValue",reason,operator) VALUES ($1,'status','doing','wait','fixture','Isolated Admin') RETURNING id`,fixtureIds.caseId);
    await sourceClient.$executeRawUnsafe(`UPDATE change_logs SET field='copyDate' WHERE id=$1`,other.id);
    await sourceClient.$executeRawUnsafe(`UPDATE change_logs SET field='level' WHERE id=$1`,cl.id);
    const clEvents=await sourceClient.$queryRawUnsafe(`SELECT op,"rowKey" FROM report_source_events WHERE "tableName"='change_logs' ORDER BY id DESC LIMIT 3`);
    assert.deepEqual(clEvents.reverse(),[{op:'I',rowKey:String(cl.id)},{op:'I',rowKey:String(other.id)},{op:'D',rowKey:String(cl.id)}]);assert.equal(await count(),before+3);
    // hotel rename / reorder: only the changed whitelist columns (updatedAt is not a hotel source column)
    const [h]=await sourceClient.$queryRawUnsafe(`SELECT id FROM hotels ORDER BY id LIMIT 1`);
    await sourceClient.$executeRawUnsafe(`UPDATE hotels SET name='E1a 改名館',"sortOrder"=3,"updatedAt"=now() WHERE id=$1`,h.id);await sourceClient.$executeRawUnsafe(`UPDATE hotels SET "updatedAt"=now() WHERE id=$1`,h.id);
    const hotelEv=await sourceClient.$queryRawUnsafe(`SELECT op,data FROM report_source_events WHERE "tableName"='hotels' AND "rowKey"=$1 ORDER BY id DESC LIMIT 1`,String(h.id));assert.deepEqual(hotelEv,[{op:'U',data:{name:'E1a 改名館',sortOrder:3}}]);
    // collaborator link removed by a staff delete cascade is captured as a D on the real A/B key
    const temp=await sourceClient.staff.create({data:{name:'E1a cascade fixture',email:'e1a-cascade@example.invalid',password:'unusable-fixture-value',seniority:'mid',joined:day()}});
    await sourceClient.$executeRawUnsafe('INSERT INTO "_collaborators"("A","B") VALUES ($1,$2)',fixtureIds.caseId,temp.id);await sourceClient.staff.delete({where:{id:temp.id}});
    const cascade=await sourceClient.$queryRawUnsafe(`SELECT "tableName",op,"rowKey" FROM report_source_events ORDER BY id DESC LIMIT 2`);
    assert.deepEqual(cascade.map(e=>e.tableName+':'+e.op).sort(),['_collaborators:D','staff:D']);assert(cascade.some(e=>e.rowKey===fixtureIds.caseId+':'+temp.id));
    // full reconstruction at a fresh K equals the current whitelist projection of every source table
    const K=await RS.fixKnowledgeCutoff(sourceClient);
    const rebuilt=await RS.withConsistentSources(sourceClient,{knowledgeCutoff:K,settleOptions:{attempts:20,delayMs:100}},(tx,read)=>read(K));
    assert.equal(rebuilt.status,'ok');const current=await currentProjection(sourceClient);
    for(const t of Object.keys(REPORT_SOURCE_KEYS))assert.deepEqual(rebuilt.tables[t],current[t],'reconstruction = current rows: '+t);
    // the earlier 0004–0006 tests (incl. the 0006 same-transaction reset that deletes evidence) were captured live: every source
    // table has non-baseline events, and replaying those inserts, decisions, voids and deletes ends equal to the current rows
    const live=await sourceClient.$queryRawUnsafe(`SELECT "tableName" AS t,string_agg(DISTINCT op,'' ORDER BY op) AS ops FROM report_source_events WHERE op<>'B' GROUP BY 1 ORDER BY 1`);
    const ops=Object.fromEntries(live.map(r=>[r.t,r.ops]));
    for(const t of Object.keys(REPORT_SOURCE_KEYS))assert(ops[t],'live writer activity captured for '+t+': '+JSON.stringify(ops));
    for(const t of ['case_deliveries','case_cycles','case_lifecycle_requests','case_schedule_requests','case_delivery_submissions'])assert(/I/.test(ops[t])&&/U/.test(ops[t]),t+' inserts and decisions/voids captured: '+ops[t]);
    const [voided]=await sourceClient.$queryRawUnsafe(`SELECT count(*)::int AS n FROM report_source_events WHERE "tableName"='case_deliveries' AND op='U' AND data ? 'voidedAt' AND data->>'voidedAt' IS NOT NULL`);assert(voided.n>0,'a void is captured as an explicit U');
    // append-only, no manual events, guarded coverage and baseline, no TRUNCATE of any source table
    const rolled=async(label,fn)=>assert.rejects(sourceClient.$transaction(async t=>{await fn(t);}),label);
    for(const stmt of ['UPDATE report_source_events SET op=op','DELETE FROM report_source_events','TRUNCATE report_source_events','UPDATE report_source_coverage SET "baselineEventMaxId"=0','DELETE FROM report_source_coverage','TRUNCATE report_source_coverage',
      `INSERT INTO report_source_events("tableName","rowKey",op,data) VALUES ('cases','X','I','{}')`,'SELECT "report_source_baseline"()'])await assert.rejects(sourceClient.$executeRawUnsafe(stmt),stmt);
    // TRUNCATE ... CASCADE (so a foreign key cannot be what refuses it) inside a transaction that always rolls back
    for(const t of Object.keys(REPORT_SOURCE_KEYS)){
      const e=await sourceClient.$transaction(async tx=>{await tx.$executeRawUnsafe('TRUNCATE '+quote(t)+' CASCADE');throw Error('TRUNCATE succeeded');}).then(()=>null,x=>x);
      assert(e&&!/TRUNCATE succeeded/.test(e.message)&&/report source|append-only|evidence|immutable/.test(e.message),t+': '+(e&&e.message));
    }
    await rolled('manual id even with the capture flag',async t=>{await t.$queryRawUnsafe(`SELECT set_config('design_pm.report_capture','on',true)`);await t.$executeRawUnsafe(`INSERT INTO report_source_events(id,"tableName","rowKey",op,data) VALUES (999999999,'cases','X','I','{}')`);});
    await rolled('B event outside baseline',async t=>{await t.$queryRawUnsafe(`SELECT set_config('design_pm.report_capture','on',true)`);await t.$executeRawUnsafe(`INSERT INTO report_source_events("tableName","rowKey",op,data) VALUES ('cases','X','B','{}')`);});
    await rolled('old delivery purge switch cannot TRUNCATE a source',async t=>{await t.$queryRawUnsafe(`SELECT set_config('design_pm.allow_delivery_purge','on',true)`);await t.$executeRawUnsafe('TRUNCATE case_deliveries');});
    await rolled('rebaseline while old events remain',async t=>{await t.$queryRawUnsafe(`SELECT set_config('design_pm.allow_report_purge','on',true)`);await t.$executeRawUnsafe('SELECT "report_source_baseline"()');});
    const rr=sourceClient.$transaction(async t=>{await t.$queryRawUnsafe(`SELECT set_config('design_pm.allow_report_purge','on',true)`);await t.$executeRawUnsafe('DELETE FROM report_source_events');await t.$executeRawUnsafe('SELECT "report_source_baseline"()');},{isolationLevel:'RepeatableRead'});
    await assert.rejects(rr,e=>/READ COMMITTED/.test(e.message),'baseline refuses a non-read-committed caller');
    // explicit purge + rebaseline is atomic: inside it history restarts; rolled back here, nothing changed
    const keep=await count(),times=await reportTimes(sourceClient);
    await assert.rejects(sourceClient.$transaction(async t=>{await t.$queryRawUnsafe(`SELECT set_config('design_pm.allow_report_purge','on',true)`);await t.$executeRawUnsafe('DELETE FROM report_source_events');await t.$executeRawUnsafe('SELECT "report_source_baseline"()');
      const [n]=await t.$queryRawUnsafe(`SELECT count(*) FILTER (WHERE op='B')::int AS b,count(*)::int AS all FROM report_source_events`);assert.equal(n.b,n.all);throw Error('rollback fixture');}),/rollback fixture/);
    assert.equal(await count(),keep);assert.deepEqual(await reportTimes(sourceClient),times);
  });
  await test('REPORTS-P3-E1a ordering, cross-cutoff transactions, explicit null, boundary precision and settle(K) on real PostgreSQL sessions',async()=>{
    const RS=await import(root+'/src/lib/reportSources.js');
    const name=createDatabase('reportsrc');assert.equal(cli(name,['deploy']).output.seedExecuted,false);
    const c1=db(name),c2=db(name),c3=db(name);
    const owner=await c1.staff.create({data:{name:'E1a owner',email:'e1a-owner@example.invalid',password:'unusable-fixture-value',seniority:'mid',joined:day()}});
    const hotel=await c1.hotel.create({data:{region:'Fixture',name:'E1a 館',sortOrder:5}});const cid='E1A-PG-0001';
    await c1.case.create({data:{id:cid,title:'甲',requester:'Fixture',level:'A',status:'doing',designerId:owner.id,openDate:day(),dispatchDate:day(),copyDate:day(),goLiveDate:new Date('2026-11-05T00:00:00Z')}});
    const read=async(K,client=c3)=>RS.withConsistentSources(client,{knowledgeCutoff:K,settleOptions:{attempts:20,delayMs:50}},(tx,r)=>r(K));
    const actual=async()=>(await c2.case.findUnique({where:{id:cid}}));
    // 1) A BEGINs first, B updates the same row and commits, then A updates: the replay is A's value (start-time order would say B's)
    let A=holdTx(c1);let ta=await A.tx;const [aStart]=await ta.$queryRawUnsafe(`SELECT now() AS t`);
    await sleep(5);await c2.$executeRawUnsafe(`UPDATE cases SET title='乙' WHERE id=$1`,cid);
    await ta.$executeRawUnsafe(`UPDATE cases SET title='丙' WHERE id=$1`,cid);await A.commit();
    const ev=await c2.$queryRawUnsafe(`SELECT id::text,data->>'title' AS title FROM report_source_events WHERE "rowKey"=$1 AND data ? 'title' ORDER BY id DESC LIMIT 2`,cid);
    assert.deepEqual(ev.map(e=>e.title),['丙','乙'],'event ids follow the actual row order');
    let K=await RS.fixKnowledgeCutoff(c2);assert.equal((await read(K)).tables.cases[cid].title,'丙');assert.equal((await actual()).title,'丙');assert(aStart.t instanceof Date);
    // 2) row-lock wait: A holds the row, B waits, A commits, B lands last
    A=holdTx(c1);ta=await A.tx;await ta.$executeRawUnsafe(`UPDATE cases SET title='X' WHERE id=$1`,cid);
    const waiting=c2.$executeRawUnsafe(`UPDATE cases SET title='Y' WHERE id=$1`,cid);await sleep(300);await A.commit();await waiting;
    K=await RS.fixKnowledgeCutoff(c2);assert.equal((await read(K)).tables.cases[cid].title,'Y');assert.equal((await actual()).title,'Y');
    // 3) one transaction changes two entities across a cutoff C: C sees neither; settle(C) refuses while it is open; a later K sees both
    A=holdTx(c1);ta=await A.tx;await ta.$executeRawUnsafe(`UPDATE cases SET title='跨界' WHERE id=$1`,cid);
    await sleep(5);const C=await RS.fixKnowledgeCutoff(c2);await sleep(5);
    await assert.rejects(RS.settle(c2,C,{attempts:3,delayMs:20}),e=>e.code==='source_not_settled'&&e.details.reason==='open_transactions');
    await assert.rejects(read(C),e=>e.code==='source_not_settled','no snapshot is taken before settle(C)');
    await ta.$executeRawUnsafe(`UPDATE hotels SET name='跨界館' WHERE id=$1`,hotel.id);await A.commit();
    const atC=await read(C);assert.equal(atC.tables.cases[cid].title,'Y');assert.equal(atC.tables.hotels[String(hotel.id)].name,'E1a 館');
    await c2.$executeRawUnsafe(`UPDATE cases SET urgent=true WHERE id=$1`,cid);   // a transaction after C
    assert.deepEqual(await read(C),atC,'same C later: fixed result, later transactions never leak in');
    K=await RS.fixKnowledgeCutoff(c2);const atK=await read(K);assert.equal(atK.tables.cases[cid].title,'跨界');assert.equal(atK.tables.hotels[String(hotel.id)].name,'跨界館');assert.equal(atK.tables.cases[cid].urgent,true);
    // 4) idle-in-transaction that began before K blocks settle(K) (bounded), then clears after commit
    A=holdTx(c1);await A.tx;await sleep(5);K=await RS.fixKnowledgeCutoff(c2);
    await assert.rejects(RS.settle(c2,K,{attempts:2,delayMs:20}),e=>e.code==='source_not_settled'&&e.details.open>=1);await A.commit();assert.equal((await RS.settle(c2,K)).settled,true);
    // 5) two backends: explicit null and another column, both deltas kept
    const B=holdTx(c2);const tb=await B.tx;A=holdTx(c1);ta=await A.tx;
    await ta.$executeRawUnsafe(`UPDATE cases SET "copyDate"=NULL WHERE id=$1`,cid);await tb.$executeRawUnsafe(`UPDATE hotels SET "sortOrder"=9 WHERE id=$1`,hotel.id);await B.commit();await A.commit();
    const [nul]=await c2.$queryRawUnsafe(`SELECT data FROM report_source_events WHERE "rowKey"=$1 AND data ? 'copyDate' ORDER BY id DESC LIMIT 1`,cid);assert.deepEqual(nul.data,{copyDate:null});
    K=await RS.fixKnowledgeCutoff(c2);const both=await read(K);assert.equal(both.tables.cases[cid].copyDate,null);assert('copyDate' in both.tables.cases[cid]);assert.equal(both.tables.hotels[String(hotel.id)].sortOrder,9);
    // 6) boundary precision: a transaction whose effective time equals C exactly is outside [.., C); one microsecond later it is inside
    await c2.$executeRawUnsafe(`UPDATE cases SET urgent=false WHERE id=$1`,cid);
    const [last]=await c2.$queryRawUnsafe(`SELECT to_char("capturedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,"transactionId"::text AS tx,
      (SELECT count(*)::int FROM report_source_events e2 WHERE e2."transactionId"=e."transactionId") AS n FROM report_source_events e ORDER BY id DESC LIMIT 1`);assert.equal(last.n,1);
    const plusOne=at=>{const [s,us]=at.slice(0,-1).split('.');const n=Number(us)+1;return n<1e6?`${s}.${String(n).padStart(6,'0')}Z`:null;};
    assert.equal((await read(last.at)).tables.cases[cid].urgent,true,'effective time == C is excluded (half-open)');
    if(plusOne(last.at))assert.equal((await read(plusOne(last.at))).tables.cases[cid].urgent,false,'C + 1µs includes it');
    // 7) whole-snapshot equality with the live rows, and a cutoff before coverage is reported insufficient, never fabricated
    K=await RS.fixKnowledgeCutoff(c2);const full=await read(K),now=await currentProjection(c2);for(const t of Object.keys(REPORT_SOURCE_KEYS))assert.deepEqual(full.tables[t],now[t],t);
    const cov=await reportTimes(c2);const early=await RS.withConsistentSources(c3,{knowledgeCutoff:K},(tx,r)=>r('2026-01-01T00:00:00Z'));assert.deepEqual(early,{status:'insufficient',cutoff:'2026-01-01T00:00:00.000000Z',coverageStart:cov.coverageStart,tables:null});
    await assert.rejects(RS.withConsistentSources(c3,{knowledgeCutoff:'2026-01-01T00:00:00Z'},(tx,r)=>r(K)),e=>e.code==='cutoff_after_knowledge');
  });
  await test('REPORTS-P3-E1a migration baseline waits for an old writer, keeps a later write of an older transaction after coverage, and leaves 0007 business rows unchanged',async()=>{
    const RS=await import(root+'/src/lib/reportSources.js');
    const name=createDatabase('reportbaseline');
    for(const m of fs.readdirSync(path.join(root,'prisma/migrations')).filter(n=>/^000[1-7]_/.test(n)).sort())sql(name,fs.readFileSync(path.join(root,'prisma/migrations',m,'migration.sql'),'utf8'));
    const c1=db(name),c2=db(name),ids=await populate(c1);
    await c1.$executeRawUnsafe(`INSERT INTO change_logs("caseId",field,"fromValue","toValue",reason,operator) VALUES ($1,'printDate',NULL,'2026-10-30','新增送印日','Isolated Admin')`,ids.caseId);
    const beforeBusiness=await snapshot(c1,{businessOnly:true});
    const O=holdTx(c1);await O.tx;                                        // began before the migration, writes only after it
    const W=holdTx(c2);const tw=await W.tx;await tw.$executeRawUnsafe(`UPDATE cases SET title='等待中的寫入' WHERE id=$1`,ids.caseId);
    const mig=await sqlAsync(name,fs.readFileSync(path.join(root,'prisma/migrations/0008_report_sources/migration.sql'),'utf8'));
    await sleep(600);assert.equal(mig.exited(),false,'the baseline waits for the open writer');await W.commit();await mig.done;
    const [b]=await c2.$queryRawUnsafe(`SELECT data->>'title' AS title FROM report_source_events WHERE "tableName"='cases' AND "rowKey"=$1 AND op='B'`,ids.caseId);assert.equal(b.title,'等待中的寫入','baseline holds the value committed while it waited');
    const cov=await reportTimes(c2);
    const ot=await O.tx;await ot.$executeRawUnsafe(`UPDATE cases SET title='舊交易後寫' WHERE id=$1`,ids.caseId);await O.commit();
    const [late]=await c2.$queryRawUnsafe(`SELECT to_char("capturedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM report_source_events WHERE "rowKey"=$1 AND op='U' ORDER BY id DESC LIMIT 1`,ids.caseId);
    assert(late.at>cov.coverageStart,'an old transaction writing after the migration is recorded after coverage, not before it');
    const atCov=await RS.withConsistentSources(c2,{settleOptions:{attempts:20,delayMs:50}},(tx,r)=>r(cov.coverageStart));assert.equal(atCov.tables.cases[ids.caseId].title,'等待中的寫入');
    const K=await RS.fixKnowledgeCutoff(c2);const atK=await RS.withConsistentSources(c2,{knowledgeCutoff:K,settleOptions:{attempts:20,delayMs:50}},(tx,r)=>r(K));assert.equal(atK.tables.cases[ids.caseId].title,'舊交易後寫');
    const [msChange]=await c2.$queryRawUnsafe(`SELECT count(*)::int AS n FROM report_source_events WHERE "tableName"='change_logs' AND op='B' AND data->>'field'='printDate' AND data->>'reason'='新增送印日'`);assert.equal(msChange.n,1,'milestone reason baselined');
    // business rows: only the two fixture writes differ from the pre-migration digest
    // business rows: once the two fixture title writes are put back (raw SQL, no other column touched), every business table and
    // sequence is byte-identical to before 0008 — the migration itself changed no business row
    await c2.$executeRawUnsafe(`UPDATE cases SET title='Isolated relational case' WHERE id=$1`,ids.caseId);
    const after=await snapshot(c2,{businessOnly:true});for(const t of ['report_source_events','report_source_coverage'])delete after.tables[t];
    after.sequences=after.sequences.filter(q=>q.sequencename!=='report_source_events_id_seq');assert.deepEqual(after,beforeBusiness);
  });
  await test('REPORTS-P3-E1a the real factory-reset route purges old report history and rebaselines the reset data in the same transaction',async()=>{
    const RS=await import(root+'/src/lib/reportSources.js');
    const name=createDatabase('reportreset');assert.equal(cli(name,['deploy']).output.seedExecuted,false);const client=db(name);
    const admin=await client.staff.create({data:{name:'E1a reset admin',email:'e1a-reset-admin@example.invalid',password:'unusable-fixture-value',role:'admin',seniority:'senior',joined:day()}});
    const member=await client.staff.create({data:{name:'E1a reset member',email:'e1a-reset-member@example.invalid',password:'unusable-fixture-value',seniority:'mid',joined:day()}});
    await client.case.create({data:{id:'E1A-RESET-1',title:'重置前',requester:'Fixture',level:'A',status:'doing',designerId:member.id,openDate:day(),dispatchDate:day(),goLiveDate:day()}});
    // REPORTS-P3-E1b: a published snapshot exists before the reset and is purged in the same reset transaction.
    {const WR=await import(root+'/src/lib/workReports.js'),RP=await import(root+'/src/lib/reportPeriods.js');const [{today}]=await client.$queryRawUnsafe(`SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') AS today`);
      const g=await WR.createWorkReportService({db:client}).generate({id:admin.id},{sessionVersion:0},{periodKind:'month',startDate:RP.previousPeriod(RP.periodContaining('month',today)).startDate,idempotencyKey:'reset-gen-0001'});
      assert.equal(g.status,201);assert.equal(await client.reportSnapshot.count(),1);}
    const old=await reportTimes(client);await sleep(5);const beforeReset=await RS.fixKnowledgeCutoff(client);
    const harness=path.join(folder,'report-reset-route.mjs');
    fs.writeFileSync(harness,`
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const root=${JSON.stringify(root)};const require=createRequire(root+'/package.json');const express=require('express'),cookieParser=require('cookie-parser');
const target=new URL(process.env.DATABASE_URL);assert.equal(target.hostname,'127.0.0.1');assert.equal(target.pathname,'/'+process.env.EXPECTED_OWNED_DB);
const {prisma}=await import(root+'/src/lib/db.js');const {signToken}=await import(root+'/src/middleware/auth.js');
const app=express();app.use(express.json(),cookieParser());app.use('/api/admin',(await import(root+'/src/routes/admin.js')).default);
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
try{const me=await prisma.staff.findUnique({where:{id:Number(process.env.RESET_ADMIN_ID)}});
  const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/admin/factory-reset',{method:'POST',headers:{'content-type':'application/json',cookie:'designpm_token='+signToken(me)},body:JSON.stringify({confirm:'DELETE ALL DATA',adminEmail:me.email})});
  console.log(JSON.stringify({status:res.status,body:await res.json()}));}finally{server.close();await prisma.$disconnect();}
`,{mode:0o600});
    const env={...process.env,DATABASE_URL:urlFor(name),NODE_ENV:'test',JWT_SECRET:'isolated-report-reset-secret',APP_BASE_URL:'https://fixture.invalid',EXPECTED_OWNED_DB:name,RESET_ADMIN_ID:String(admin.id)};
    for(const key of Object.keys(env))if(key.startsWith('SMTP_'))delete env[key];
    const r=spawnSync(process.execPath,[harness],{cwd:root,env,encoding:'utf8',timeout:60000});assert.equal(r.status,0,(r.stdout+r.stderr).replaceAll(fixturePassword,'[fixture-secret]'));
    const out=JSON.parse(r.stdout.trim().split('\n').at(-1));assert.equal(out.status,200,JSON.stringify(out.body));
    const now=await reportTimes(client);assert(now.coverageStart>old.coverageStart&&now.coverageStart>beforeReset,'coverage restarts after the reset');
    assert.equal(await client.reportSnapshot.count(),0,'report snapshots purged by the full reset');
    const [ev]=await client.$queryRawUnsafe(`SELECT count(*)::int AS n,count(*) FILTER (WHERE op<>'B')::int AS other,count(DISTINCT "transactionId")::int AS txs FROM report_source_events`);
    assert.equal(ev.other,0,'old I/U/D history purged');assert.equal(ev.txs,1);assert.equal(ev.n,Number((await client.$queryRawUnsafe('SELECT ((SELECT count(*) FROM staff)+(SELECT count(*) FROM hotels))::int AS n'))[0].n));
    const K=await RS.fixKnowledgeCutoff(client);const rebuilt=await RS.withConsistentSources(client,{knowledgeCutoff:K,settleOptions:{attempts:20,delayMs:50}},(tx,rd)=>rd(K));
    const current=await currentProjection(client);for(const t of Object.keys(REPORT_SOURCE_KEYS))assert.deepEqual(rebuilt.tables[t],current[t],t);assert.deepEqual(rebuilt.tables.cases,{});
    const earlier=await RS.withConsistentSources(client,{knowledgeCutoff:K},(tx,rd)=>rd(beforeReset));assert.equal(earlier.status,'insufficient','pre-reset periods are not reconstructable');
  });
  await test('REPORTS-P3-E1b 0008→0009 is additive: every business table, source event, coverage row and sequence is byte-identical',async()=>{
    const name=createDatabase('snapinc');
    for(const m of fs.readdirSync(path.join(root,'prisma/migrations')).filter(n=>/^000[1-8]_/.test(n)).sort())sql(name,fs.readFileSync(path.join(root,'prisma/migrations',m,'migration.sql'),'utf8'));
    const c=db(name);await populate(c);const before=await snapshot(c);assert(Number(before.tables.report_source_events.count)>0);
    sql(name,fs.readFileSync(path.join(root,'prisma/migrations/0009_report_snapshots/migration.sql'),'utf8'));
    const after=await snapshot(c);assert.equal(after.tables.report_snapshots.count,'0');delete after.tables.report_snapshots;assert.deepEqual(after,before);
  });
  await test('REPORTS-P3-E1b snapshot table enforces period alignment, Taipei cutoff, K/observed/generated order, version chain, payload keys and immutability',async()=>{
    const name=createDatabase('snapcheck');assert.equal(cli(name,['deploy']).output.seedExecuted,false);const c=db(name);
    const okPayload=(rev=1,status='insufficient')=>({meta:{rulesVersion:'work-report.v1',revision:rev},sourceCompleteness:{status},summary:{},rows:[],unresolved:[],hotelOrder:[],staff:[]});
    const row=(o={})=>({id:'wr_'+crypto.randomUUID(),periodKind:'week',startDate:'2026-10-19',endDateExclusive:'2026-10-26',cutoffInstant:'2026-10-25T16:00:00Z',knowledgeCutoff:'2026-10-25T16:00:00Z',
      observedAt:'2026-10-25T16:00:00Z',rulesVersion:'work-report.v1',revision:1,supersedesId:null,revisionReason:null,generatedById:1,generatedByName:'Fixture admin',trigger:'manual',
      idempotencyKey:'chk-'+crypto.randomBytes(8).toString('hex'),requestFingerprint:'b'.repeat(64),payload:okPayload(),payloadSha256:'a'.repeat(64),sourceCompleteness:'insufficient',generatedAt:null,...o});
    const insert=(t,r)=>t.$executeRawUnsafe(`INSERT INTO report_snapshots (id,"periodKind","startDate","endDateExclusive","cutoffInstant","knowledgeCutoff","observedAt","rulesVersion",revision,"supersedesId","revisionReason",
      "generatedById","generatedByName",trigger,"idempotencyKey","requestFingerprint",payload,"payloadSha256","sourceCompleteness","generatedAt") VALUES ($1,$2,$3::date,$4::date,$5::timestamptz,$6::timestamptz,$7::timestamptz,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20::timestamptz)`,
      r.id,r.periodKind,r.startDate,r.endDateExclusive,r.cutoffInstant,r.knowledgeCutoff,r.observedAt,r.rulesVersion,r.revision,r.supersedesId,r.revisionReason,r.generatedById,r.generatedByName,r.trigger,
      r.idempotencyKey,r.requestFingerprint,JSON.stringify(r.payload),r.payloadSha256,r.sourceCompleteness,r.generatedAt);
    const attempt=async rows=>{try{await c.$transaction(async t=>{for(const r of rows)await insert(t,r);throw Error('fixture rollback');});}catch(e){return /fixture rollback/.test(e.message)?'ok':'rejected';}};
    const v1=row();
    const valid=[[v1],[row({periodKind:'month',startDate:'2026-09-01',endDateExclusive:'2026-10-01',cutoffInstant:'2026-09-30T16:00:00Z',knowledgeCutoff:'2026-09-30T16:00:00Z',observedAt:'2026-09-30T16:00:00Z'})],
      [row({periodKind:'quarter',startDate:'2026-07-01',endDateExclusive:'2026-10-01',cutoffInstant:'2026-09-30T16:00:00Z',knowledgeCutoff:'2026-10-01T00:00:00Z',observedAt:'2026-10-01T00:00:01Z'})],
      [v1,row({revision:2,supersedesId:v1.id,revisionReason:'期後補登',knowledgeCutoff:'2026-10-26T01:00:00Z',observedAt:'2026-10-26T01:00:00Z',payload:okPayload(2,'partial'),sourceCompleteness:'partial'})]];
    for(const rows of valid)assert.equal(await attempt(rows),'ok',JSON.stringify(rows.at(-1)));
    const bad={tuesday:{startDate:'2026-10-20',endDateExclusive:'2026-10-27',cutoffInstant:'2026-10-26T16:00:00Z',knowledgeCutoff:'2026-10-26T16:00:00Z',observedAt:'2026-10-26T16:00:00Z'},
      wrongEnd:{endDateExclusive:'2026-10-27',cutoffInstant:'2026-10-26T16:00:00Z',knowledgeCutoff:'2026-10-26T16:00:00Z',observedAt:'2026-10-26T16:00:00Z'},
      cutoffPlus1us:{cutoffInstant:'2026-10-25T16:00:00.000001Z',knowledgeCutoff:'2026-10-25T16:00:00.000001Z',observedAt:'2026-10-25T16:00:00.000001Z'},
      kBeforeC:{knowledgeCutoff:'2026-10-25T15:59:59.999999Z'},observedBeforeK:{knowledgeCutoff:'2026-10-26T00:00:00Z',observedAt:'2026-10-25T23:00:00Z'},
      futureObserved:{knowledgeCutoff:'2099-01-01T00:00:00Z',observedAt:'2099-01-01T00:00:00Z'},
      monthNotFirst:{periodKind:'month',startDate:'2026-09-02',endDateExclusive:'2026-10-02',cutoffInstant:'2026-10-01T16:00:00Z',knowledgeCutoff:'2026-10-01T16:00:00Z',observedAt:'2026-10-01T16:00:00Z'},
      quarterFeb:{periodKind:'quarter',startDate:'2026-02-01',endDateExclusive:'2026-05-01',cutoffInstant:'2026-04-30T16:00:00Z',knowledgeCutoff:'2026-04-30T16:00:00Z',observedAt:'2026-04-30T16:00:00Z'},
      rev2WithoutParent:{revision:2,revisionReason:'期後補登',payload:okPayload(2)},rev1WithReason:{revisionReason:'期後補登'},blankReason:{revision:2,supersedesId:'x',revisionReason:' ',payload:okPayload(2)},
      triggerAuto:{trigger:'auto'},manualWithoutActor:{generatedById:null},shortKey:{idempotencyKey:'short'},hashFormat:{payloadSha256:'XYZ'},badId:{id:'report-1'},
      emptyPayload:{payload:{}},noMeta:{payload:{...okPayload(),meta:undefined}},noStatus:{payload:{...okPayload(),sourceCompleteness:{}}},noRevision:{payload:{...okPayload(),meta:{rulesVersion:'work-report.v1'}}},
      revisionAsText:{payload:{...okPayload(),meta:{rulesVersion:'work-report.v1',revision:'1'}}},noRows:{payload:{...okPayload(),rows:undefined}},statusMismatch:{sourceCompleteness:'partial'},
      rulesMismatch:{rulesVersion:'work-report.v2'}};
    for(const [label,o]of Object.entries(bad))assert.equal(await attempt([row(o)]),'rejected',label);
    const chain={otherPeriod:[v1,row({periodKind:'week',startDate:'2026-10-12',endDateExclusive:'2026-10-19',cutoffInstant:'2026-10-18T16:00:00Z',knowledgeCutoff:'2026-10-26T00:00:00Z',observedAt:'2026-10-26T00:00:00Z',
        revision:2,supersedesId:v1.id,revisionReason:'錯誤期間',payload:okPayload(2)})],skipRevision:[v1,row({revision:3,supersedesId:v1.id,revisionReason:'跳號',payload:okPayload(3)})],
      kRegression:[v1,row({revision:2,supersedesId:v1.id,revisionReason:'時鐘倒退',payload:okPayload(2)}),row({revision:3,revisionReason:'時鐘倒退'})],
      duplicateRevision:[v1,row({idempotencyKey:'chk-duplicate-0001'})],duplicateKey:[v1,row({periodKind:'month',startDate:'2026-09-01',endDateExclusive:'2026-10-01',cutoffInstant:'2026-09-30T16:00:00Z',
        knowledgeCutoff:'2026-09-30T16:00:00Z',observedAt:'2026-09-30T16:00:00Z',idempotencyKey:v1.idempotencyKey})]};
    chain.kRegression[1].knowledgeCutoff='2026-10-26T00:00:00Z';chain.kRegression[1].observedAt='2026-10-26T00:00:00Z';chain.kRegression[2]=row({revision:3,supersedesId:chain.kRegression[1].id,revisionReason:'時鐘倒退',payload:okPayload(3),knowledgeCutoff:'2026-10-25T20:00:00Z',observedAt:'2026-10-26T00:00:00Z'});
    for(const [label,rows]of Object.entries(chain))assert.equal(await attempt(rows),'rejected',label);
    // committed v1: generatedAt is the DB clock (caller value ignored); UPDATE / DELETE / TRUNCATE refused; only an explicit purge deletes
    await insert(c,{...v1,generatedAt:'2000-01-01T00:00:00Z'});
    const [g]=await c.$queryRawUnsafe(`SELECT "generatedAt" > now() - interval '1 hour' AS fresh FROM report_snapshots WHERE id=$1`,v1.id);assert.equal(g.fresh,true);
    for(const stmt of [`UPDATE report_snapshots SET "payloadSha256"='${'c'.repeat(64)}'`,`UPDATE report_snapshots SET payload=payload`,'DELETE FROM report_snapshots','TRUNCATE report_snapshots','TRUNCATE report_snapshots CASCADE'])
      await assert.rejects(c.$executeRawUnsafe(stmt),/immutable|cannot truncate a table referenced in a foreign key|cannot be truncated/,stmt);   // REPORTS-P3-E3: FK from report_job_runs / its own no-truncate trigger
    await assert.rejects(c.$transaction(async t=>{await t.$queryRawUnsafe("SELECT set_config('design_pm.allow_report_purge','on',true)");assert.equal(await t.$executeRawUnsafe('DELETE FROM report_snapshots'),1);
      throw Error('purge rollback');}),/purge rollback/);
    assert.equal(await c.reportSnapshot.count(),1);
    const fk=await c.$queryRawUnsafe(`SELECT confrelid::regclass::text AS ref,confdeltype FROM pg_constraint WHERE conrelid='report_snapshots'::regclass AND contype='f'`);
    assert.deepEqual(fk,[{ref:'report_snapshots',confdeltype:'a'}],'only the self link, NO ACTION; no FK to deletable business rows');
  });
  await test('REPORTS-P3-E1b deleted-case population is anchored to [S, C): a case created and deleted only after C does not touch the old period',async()=>{
    const WR=await import(root+'/src/lib/workReports.js'),RS=await import(root+'/src/lib/reportSources.js');
    const name=createDatabase('snapdeleted');assert.equal(cli(name,['deploy']).output.seedExecuted,false);const c=db(name);
    const designer=await c.staff.create({data:{name:'E1b deleted designer',email:'e1b-deleted@example.invalid',password:'unusable-fixture-value',seniority:'mid',joined:day()}});
    const mkCase=id=>c.case.create({data:{id,title:id,requester:'Fixture',level:'A',status:'doing',designerId:designer.id,openDate:day(),dispatchDate:day(),goLiveDate:day()}});
    await mkCase('E1B-BEFORE-S');await mkCase('E1B-KEPT');await mkCase('E1B-IN-PERIOD');await sleep(5);
    const S=await RS.fixKnowledgeCutoff(c);await sleep(5);await c.case.delete({where:{id:'E1B-IN-PERIOD'}});await sleep(5);
    const C=await RS.fixKnowledgeCutoff(c);await sleep(5);await mkCase('E1B-AFTER-C');await c.case.delete({where:{id:'E1B-AFTER-C'}});await c.case.delete({where:{id:'E1B-KEPT'}});await sleep(5);
    const K=await RS.fixKnowledgeCutoff(c);
    const src=await WR.readReportSources(c,{cutoff:C,knowledgeCutoff:K,startInstant:S},async(tx,x)=>x);
    assert.equal(src.endState.status,'ok');assert.deepEqual(src.deletedCaseIds,['E1B-IN-PERIOD']);
    assert(src.endState.tables.cases['E1B-KEPT']&&!src.knowledge.tables.cases['E1B-KEPT'],'deleted after C: present at C, gone at K (kept as a row with a limitation)');
    assert.equal(await c.reportSnapshot.count(),0,'reading sources writes nothing');
  });
  await test('REPORTS-P3-E1b real router + requireAuth on actual PostgreSQL: auth, inputs, replay/conflict, revisions, races, revocation, rollback, GET without writes, stub publication',async()=>{
    const name=createDatabase('reportapi');assert.equal(cli(name,['deploy']).output.seedExecuted,false);
    const env={...process.env,DESIGN_PM_ROOT:root,DATABASE_URL:urlFor(name),NODE_ENV:'test',JWT_SECRET:'isolated-work-report-route-secret',APP_BASE_URL:'https://fixture.invalid',
      EXPECTED_FIXTURE_PORT:port,EXPECTED_OWNED_DB:name,EXPECTED_DB_PREFIX:basePrefix};
    for(const key of Object.keys(env))if(key.startsWith('SMTP_'))delete env[key];
    const outcome=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[path.join(root,'tests/workReportsRouteHarness.mjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
      child.stdout.on('data',x=>{stdout+=x;});child.stderr.on('data',x=>{stderr+=x;});
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Real work-report route fixture exceeded 180 seconds'));},180000);
      child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
    });
    assert.equal(outcome.code,0,('Isolated real work-report routes failed: '+outcome.stdout+'\n'+outcome.stderr).replaceAll(fixturePassword,'[fixture-secret]'));
    const summary=JSON.parse(outcome.stdout.trim().split('\n').at(-1));assert.equal(summary.workReportRouteScenarios,10);assert.equal(summary.productionRouterAndRequireAuth,true);assert.equal(summary.actualPostgres,true);
    const c=db(name);const [r]=await c.$queryRawUnsafe(`SELECT count(*)::int AS n,count(*) FILTER (WHERE "sourceCompleteness"='insufficient')::int AS insufficient FROM report_snapshots`);
    assert(r.n>=10&&r.insufficient===r.n-2,'every real-source snapshot of this fresh DB is insufficient; only the two stub versions are complete');
    const rows=await c.$queryRawUnsafe('SELECT id,payload,"payloadSha256" FROM report_snapshots');const P=await import(root+'/src/lib/workReportPayload.js');
    for(const x of rows)assert.equal(P.payloadSha256(x.payload),x.payloadSha256,'stored payload hashes verify after the jsonb round trip');
  });
  await test('REPORTS-P3-E3 0009→0010 is additive: business tables, source events, coverage, snapshot bytes and sequences are identical',async()=>{
    const name=createDatabase('jobinc');
    for(const m of fs.readdirSync(path.join(root,'prisma/migrations')).filter(n=>/^000[1-9]_/.test(n)).sort())sql(name,fs.readFileSync(path.join(root,'prisma/migrations',m,'migration.sql'),'utf8'));
    const c=db(name,{limit:2});const ids=await populate(c);const WR=await import(root+'/src/lib/workReports.js'),RP=await import(root+'/src/lib/reportPeriods.js');
    const [{today}]=await c.$queryRawUnsafe(`SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') AS today`);
    const g=await WR.createWorkReportService({db:c}).generate({id:ids.admin},{sessionVersion:7},{periodKind:'week',startDate:RP.previousPeriod(RP.periodContaining('week',today)).startDate,idempotencyKey:'e3-before-0010'});assert.equal(g.status,201);
    const before=await snapshot(c);assert.equal(before.tables.report_snapshots.count,'1');assert(Number(before.tables.report_source_events.count)>0);
    sql(name,fs.readFileSync(path.join(root,'prisma/migrations/0010_report_jobs/migration.sql'),'utf8'));
    const after=await snapshot(c);for(const t of ['report_job_runs','report_scheduler_state']){assert.equal(after.tables[t].count,'0');delete after.tables[t];}assert.deepEqual(after,before);
    assert.deepEqual(await WR.createWorkReportService({db:c}).get(g.snapshot.id).then(x=>x.payloadSha256),g.snapshot.payloadSha256);
  });
  await test('REPORTS-P3-E3 job and scheduler-state tables enforce alignment, 00:05 due, lease/status/snapshot consistency, final finished jobs and purge-only delete',async()=>{
    const name=createDatabase('jobcheck');assert.equal(cli(name,['deploy']).output.seedExecuted,false);const c=db(name,{limit:2});
    const WR=await import(root+'/src/lib/workReports.js'),RP=await import(root+'/src/lib/reportPeriods.js'),SCH=await import(root+'/src/services/workReportScheduler.js');
    const p=RP.periodFromStart('week','2026-10-19'),key=WR.scheduledIdempotencyKey(p);
    const job=(o={})=>({id:'wj_'+crypto.randomUUID(),epoch:1,periodKind:'week',startDate:'2026-10-19',endDateExclusive:'2026-10-26',rulesVersion:'work-report.v1',dueAt:SCH.dueInstant(p),idempotencyKey:key,
      status:'pending',attemptCount:0,maxAttempts:6,nextAttemptAt:SCH.dueInstant(p),leaseToken:null,leaseOwner:null,leaseUntil:null,snapshotId:null,lastErrorCode:null,finishedAt:null,...o});
    const insert=(t,j)=>t.$executeRawUnsafe(`INSERT INTO report_job_runs (id,epoch,"periodKind","startDate","endDateExclusive","rulesVersion","dueAt","idempotencyKey",status,"attemptCount","maxAttempts","nextAttemptAt",
      "leaseToken","leaseOwner","leaseUntil","snapshotId","lastErrorCode","finishedAt","createdAt","updatedAt") VALUES ($1,$2,$3,$4::date,$5::date,$6,$7::timestamptz,$8,$9,$10,$11,$12::timestamptz,$13,$14,$15::timestamptz,$16,$17,$18::timestamptz,'2000-01-01','2000-01-01')`,
      j.id,j.epoch,j.periodKind,j.startDate,j.endDateExclusive,j.rulesVersion,j.dueAt,j.idempotencyKey,j.status,j.attemptCount,j.maxAttempts,j.nextAttemptAt,j.leaseToken,j.leaseOwner,j.leaseUntil,j.snapshotId,j.lastErrorCode,j.finishedAt);
    const attempt=async rows=>{try{await c.$transaction(async t=>{for(const r of rows)await insert(t,r);throw Error('fixture rollback');});}catch(e){return /fixture rollback/.test(e.message)?'ok':'rejected';}};
    const lease={status:'running',leaseToken:crypto.randomUUID(),leaseOwner:'host:1',leaseUntil:'2026-10-28T00:00:00Z',attemptCount:1};
    assert.equal(await attempt([job()]),'ok');assert.equal(await attempt([job(lease)]),'ok');assert.equal(await attempt([job({status:'blocked',lastErrorCode:'source_clock_unreliable',finishedAt:'2026-10-28T00:00:00Z'})]),'ok');
    const bad={tuesday:{startDate:'2026-10-20',endDateExclusive:'2026-10-27'},dueAt0000:{dueAt:'2026-10-25T16:00:00Z'},dueWrongDay:{dueAt:'2026-10-26T16:05:00Z'},badKey:{idempotencyKey:'manual-key-0001'},
      badId:{id:'job-1'},epoch0:{epoch:0},runningNoLease:{status:'running'},pendingWithLease:{...lease,status:'pending'},halfLease:{...lease,leaseOwner:null},badOwner:{...lease,leaseOwner:'bad owner!'},
      succeededNoSnapshot:{status:'succeeded',finishedAt:'2026-10-28T00:00:00Z'},blockedNoCode:{status:'blocked',finishedAt:'2026-10-28T00:00:00Z'},blockedNoFinish:{status:'blocked',lastErrorCode:'x_y'},
      pendingFinished:{finishedAt:'2026-10-28T00:00:00Z'},overAttempts:{attemptCount:7},maxAttempts0:{maxAttempts:0,attemptCount:0},badCode:{lastErrorCode:'Bad Code'},statusDone:{status:'done'},
      fakeSnapshot:{status:'succeeded',snapshotId:'wr_00000000-0000-4000-8000-000000000001',finishedAt:'2026-10-28T00:00:00Z'},rulesBad:{rulesVersion:'Work Report'}};
    for(const [label,o]of Object.entries(bad))assert.equal(await attempt([job(o)]),'rejected',label);
    for(const [label,rows]of Object.entries({duplicatePeriod:[job(),job({idempotencyKey:key.replace(/[0-9a-f]{12}$/,'0'.repeat(12))})],duplicateKey:[job(),job({periodKind:'month',startDate:'2026-09-01',endDateExclusive:'2026-10-01',dueAt:'2026-09-30T16:05:00Z',nextAttemptAt:'2026-09-30T16:05:00Z'})]}))
      assert.equal(await attempt(rows),'rejected',label);
    // a real scheduled snapshot to finish a job against
    const admin=await c.staff.create({data:{name:'E3 check admin',email:'e3-check@example.invalid',password:'unusable-fixture-value',role:'admin',seniority:'senior',joined:day()}});void admin;
    const j=job();await insert(c,j);
    const [t]=await c.$queryRawUnsafe(`SELECT "createdAt"<>'2000-01-01'::timestamptz AND "updatedAt"="createdAt" AS db FROM report_job_runs WHERE id=$1`,j.id);assert.equal(t.db,true,'createdAt/updatedAt are the DB clock');
    for(const stmt of [`UPDATE report_job_runs SET "startDate"='2026-10-12',"endDateExclusive"='2026-10-19'`,`UPDATE report_job_runs SET "idempotencyKey"='${key.replace(/week/,'week')}x'`,`UPDATE report_job_runs SET "dueAt"="dueAt"+interval '1 minute'`,
      `UPDATE report_job_runs SET "createdAt"=now()`])await assert.rejects(c.$executeRawUnsafe(stmt),/immutable|violates/,stmt);
    for(const stmt of ['DELETE FROM report_job_runs','TRUNCATE report_job_runs','TRUNCATE report_scheduler_state'])await assert.rejects(c.$executeRawUnsafe(stmt),/kept|truncated/,stmt);
    await assert.rejects(c.$executeRawUnsafe(`INSERT INTO report_scheduler_state (id,epoch,"startDate","activatedAt","coverageStart",status,"updatedAt") VALUES (2,1,'2026-10-28',now(),now(),'active',now())`),/violates/);
    await assert.rejects(c.$executeRawUnsafe(`INSERT INTO report_scheduler_state (id,epoch,"startDate","activatedAt","coverageStart",status,"updatedAt") VALUES (1,1,'2026-10-28',now(),now(),'paused',now())`),/violates/,'paused needs a reason');
    await assert.rejects(c.$executeRawUnsafe(`INSERT INTO report_scheduler_state (id,epoch,"startDate","activatedAt","coverageStart",status,"weekCursor","updatedAt") VALUES (1,1,'2026-10-28',now(),now(),'active','2026-10-27',now())`),/violates/,'week cursor on a Monday');
    await c.$executeRawUnsafe(`INSERT INTO report_scheduler_state (id,epoch,"startDate","activatedAt","coverageStart",status,"updatedAt") VALUES (1,1,'2026-10-28','2000-01-01','2000-01-01','active','2000-01-01')`);
    const [s]=await c.$queryRawUnsafe(`SELECT "activatedAt">'2001-01-01' AND "updatedAt"="activatedAt" AS db FROM report_scheduler_state`);assert.equal(s.db,true,'activation time is the DB clock');
    await assert.rejects(c.$executeRawUnsafe('DELETE FROM report_scheduler_state'),/kept/);
    const fk=await c.$queryRawUnsafe(`SELECT confrelid::regclass::text AS ref,confdeltype FROM pg_constraint WHERE conrelid='report_job_runs'::regclass AND contype='f'`);assert.deepEqual(fk,[{ref:'report_snapshots',confdeltype:'a'}]);
    // purge deletes only inside the explicit full-purge switch (rolled back here)
    await assert.rejects(c.$transaction(async t=>{await t.$queryRawUnsafe("SELECT set_config('design_pm.allow_report_purge','on',true)");assert.equal(await t.$executeRawUnsafe('DELETE FROM report_job_runs'),1);
      assert.equal(await t.$executeRawUnsafe('DELETE FROM report_scheduler_state'),1);throw Error('purge rollback');}),/purge rollback/);
    assert.equal(await c.reportJobRun.count(),1);assert.equal(await c.reportSchedulerState.count(),1);
  });
  await test('REPORTS-P3-E3 real scheduler worker on actual PostgreSQL: activation, bounded catch-up, two workers, manual races, crash replay, stale lease, retries, blocked, CLI, status API, epochs; backup + isolated restore keeps jobs and guards',async()=>{
    const name=createDatabase('e3sched');assert.equal(cli(name,['deploy']).output.seedExecuted,false);
    const env={...process.env,DESIGN_PM_ROOT:root,DATABASE_URL:urlFor(name)+'&connection_limit=2',NODE_ENV:'test',JWT_SECRET:'isolated-work-report-scheduler-secret',APP_BASE_URL:'https://fixture.invalid',
      EXPECTED_FIXTURE_PORT:port,EXPECTED_OWNED_DB:name,EXPECTED_DB_PREFIX:basePrefix};
    for(const key of Object.keys(env))if(key.startsWith('SMTP_')||key.startsWith('WORK_REPORT_'))delete env[key];
    const outcome=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[path.join(root,'tests/workReportSchedulerHarness.mjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
      child.stdout.on('data',x=>{stdout+=x;});child.stderr.on('data',x=>{stderr+=x;});
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Real work-report scheduler fixture exceeded 300 seconds'));},300000);
      child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
    });
    assert.equal(outcome.code,0,('Isolated real work-report scheduler failed: '+outcome.stdout+'\n'+outcome.stderr).replaceAll(fixturePassword,'[fixture-secret]'));
    const summary=JSON.parse(outcome.stdout.trim().split('\n').at(-1));assert.equal(summary.workReportSchedulerScenarios,13);assert.equal(summary.actualPostgres,true);assert.equal(summary.epochs,3);
    // full backup + isolated restore: job runs, scheduler state, constraints and triggers come back exactly
    const c=db(name,{limit:2}),before=await snapshot(c);assert(Number(before.tables.report_job_runs.count)>0);assert.equal(before.tables.report_scheduler_state.count,'1');
    const backup=cli(name,['backup',path.join(folder,'e3-backup')]);const target=createDatabase('e3restore');
    const restored=cli(target,['restore-check',backup.output.manifest]);assert.equal(restored.output.rowsAndSequencesMatch,true);
    const rc=db(target,{limit:2});assert.deepEqual(await snapshot(rc),before);assert.deepEqual(await snapshot(c),before,'source unchanged');
    const SCH=await import(root+'/src/services/workReportScheduler.js');const cfg={enabled:true,startDate:null};
    const strip=x=>({...x,now:null});assert.deepEqual(strip(await SCH.readSchedulerStatus(rc,cfg)),strip(await SCH.readSchedulerStatus(c,cfg)));
    const [done]=await rc.$queryRawUnsafe(`SELECT id FROM report_job_runs WHERE status='succeeded' LIMIT 1`);
    await assert.rejects(rc.$executeRawUnsafe(`UPDATE report_job_runs SET status='pending' WHERE id=$1`,done.id),/final/);
    for(const stmt of ['DELETE FROM report_job_runs','TRUNCATE report_job_runs','DELETE FROM report_scheduler_state','DELETE FROM report_snapshots'])await assert.rejects(rc.$executeRawUnsafe(stmt),undefined,stmt);
    const [fk]=await rc.$queryRawUnsafe(`SELECT count(*)::int AS n FROM report_job_runs j LEFT JOIN report_snapshots s ON s.id=j."snapshotId" WHERE j."snapshotId" IS NOT NULL AND s.id IS NULL`);assert.equal(fk.n,0);
  });
  await test('fresh database deploy uses reviewed migrations without automatic sample seeding',async()=>{
    const name=createDatabase('freshdeploy'),client=db(name);assert.equal(cli(name,['deploy']).output.seedExecuted,false);assert.equal(await client.staff.count(),0);assert.equal(await client.case.count(),0);assert.equal(await client.deploymentIdentity.count(),0);
    const history=await client.$queryRawUnsafe('SELECT migration_name FROM _prisma_migrations ORDER BY migration_name');assert.deepEqual(history.map(r=>r.migration_name),['0001_legacy_baseline','0002_runtime_safety','0003_case_deliveries','0004_delivery_submissions','0005_schedule_requests','0006_case_lifecycle','0007_member_notice_dismissals','0008_report_sources','0009_report_snapshots','0010_report_jobs']);
    assert.equal(await client.deliveryRecord.count(),0);assert.equal(await client.deliverySubmission.count(),0);
  });
  await test('real staff routes serialize simultaneous administrator demotion and departure without losing the last login admin',async()=>{
    const name=createDatabase('adminrace');assert.equal(cli(name,['deploy']).output.seedExecuted,false);
    const harness=path.join(folder,'admin-route-concurrency.mjs');
    fs.writeFileSync(harness,`
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const root=${JSON.stringify(root)};
const require=createRequire(root+'/package.json');
const express=require('express'),cookieParser=require('cookie-parser');
const target=new URL(process.env.DATABASE_URL);
assert.equal(target.hostname,'127.0.0.1');
assert.equal(target.port,process.env.EXPECTED_FIXTURE_PORT);
assert.equal(target.pathname,'/'+process.env.EXPECTED_OWNED_DB);
assert.match(process.env.EXPECTED_OWNED_DB,new RegExp('^'+process.env.EXPECTED_DB_PREFIX+'_[a-z0-9_]+_adminrace$'));
for(const key of Object.keys(process.env))if(key.startsWith('SMTP_'))delete process.env[key];
const {prisma}=await import(root+'/src/lib/db.js');
const {requireAuth,signToken}=await import(root+'/src/middleware/auth.js');
const app=express();app.use(express.json(),cookieParser());
app.use('/api/staff',(await import(root+'/src/routes/staff.js')).default);
app.get('/api/private',requireAuth,(req,res)=>res.json({id:req.user.id,role:req.user.role}));
const unhandled=[];
app.use((error,_req,res,_next)=>{unhandled.push(error.code||error.name);res.status(500).json({error:'server_error'});});
const server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
const base='http://127.0.0.1:'+server.address().port;
const realTransaction=prisma.$transaction.bind(prisma);
let rendezvous,arrived,release,barrierTimer,backendIds,commitConflicts;
// Only pause after the real route's real predicate query has completed in both
// PostgreSQL snapshots. No staff rows, SQL result or conflict is mocked.
prisma.$transaction=(run,options)=>{
  assert.equal(options?.isolationLevel,'Serializable');
  return realTransaction(async tx=>{
    const [isolation]=await tx.$queryRawUnsafe('SHOW transaction_isolation');
    assert.equal(isolation.transaction_isolation,'serializable');
    const [backend]=await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');
    backendIds.add(backend.pid);
    const guardedStaff=new Proxy(tx.staff,{get(delegate,key){
      if(key==='findMany')return async args=>{
        const rows=await delegate.findMany(args),where=args?.where;
        if(where?.id?.not!==undefined&&where.active===true&&where.pendingActivation===false&&where.role==='admin'){
          assert.equal(rows.length,1,'both snapshots must first see the other eligible administrator');
          arrived++;if(arrived===2)release();await rendezvous;
        }
        return rows;
      };
      const value=Reflect.get(delegate,key);return typeof value==='function'?value.bind(delegate):value;
    }});
    const instrumented=new Proxy(tx,{get(client,key){if(key==='staff')return guardedStaff;const value=Reflect.get(client,key);return typeof value==='function'?value.bind(client):value;}});
    return run(instrumented);
  },{...options,maxWait:5000,timeout:10000}).catch(error=>{if(error.code==='P2034')commitConflicts++;throw error;});
};
async function call(kind,targetId,actorId){
  const departure=kind==='depart';
  const response=await fetch(base+'/api/staff/'+targetId+(departure?'/departure':''),{
    method:departure?'POST':'PATCH',signal:AbortSignal.timeout(15000),
    headers:{Cookie:'designpm_token='+signToken({id:actorId,sessionVersion:0}),'Content-Type':'application/json'},
    body:JSON.stringify(departure?{successors:{}}:{role:'member'}),
  });
  return {status:response.status,data:await response.json()};
}
let scenarios=0;
try{
  for(const kinds of [['demote','demote'],['depart','depart'],['demote','depart']]){
    await prisma.notification.deleteMany();await prisma.staff.deleteMany();
    const admins=[];
    for(let i=0;i<2;i++)admins.push(await prisma.staff.create({data:{
      name:'Isolated race admin '+i,email:'race-admin-'+i+'@example.invalid',
      password:'unusable-fixture-value',role:'admin',active:true,pendingActivation:false,
      seniority:'senior',joined:new Date('2026-10-22T00:00:00Z'),
    }}));
    arrived=0;backendIds=new Set();commitConflicts=0;
    rendezvous=new Promise((resolve,reject)=>{release=()=>{clearTimeout(barrierTimer);resolve();};barrierTimer=setTimeout(()=>reject(Error('Both real admin transactions must reach the predicate barrier')),5000);});
    try{
      // Each currently authenticated administrator removes the other one.
      const responses=await Promise.all(kinds.map((kind,i)=>call(kind,admins[1-i].id,admins[i].id)));
      assert.deepEqual(responses.map(r=>r.status).sort(),[200,409],kinds.join('/'));
      assert(['staff_conflict','write_conflict'].includes(responses.find(r=>r.status===409).data.error));
      assert.equal(arrived,2);assert.equal(backendIds.size,2,'distinct real PG sessions must overlap');
      assert.equal(commitConflicts,1,'PostgreSQL must abort one actual Serializable write-skew transaction');
      const remaining=await prisma.staff.findMany({where:{active:true,pendingActivation:false,role:'admin'}});
      assert.equal(remaining.length,1);assert.equal(await prisma.staff.count(),2);
      const rows=await prisma.staff.findMany();assert.equal(rows.filter(r=>!r.active||r.role!=='admin').length,1);
      const winner=responses.findIndex(r=>r.status===200),removed=rows.find(r=>r.id===admins[1-winner].id);
      assert.equal(kinds[winner]==='depart'?removed.active:removed.role,kinds[winner]==='depart'?false:'member');
      assert.equal(kinds[winner]==='depart'?removed.role:removed.active,kinds[winner]==='depart'?'admin':true);
      const authenticated=await fetch(base+'/api/private',{signal:AbortSignal.timeout(5000),headers:{Cookie:'designpm_token='+signToken({id:remaining[0].id,sessionVersion:0})}});
      assert.equal(authenticated.status,200);assert.equal((await authenticated.json()).role,'admin');
      assert.deepEqual(unhandled,[]);scenarios++;
    }finally{clearTimeout(barrierTimer);}
  }
  console.log(JSON.stringify({adminRouteScenarios:scenarios,actualPostgresSerializable:true,mockedRows:0,externalSMTP:false}));
}finally{prisma.$transaction=realTransaction;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await prisma.$disconnect();}
`,{mode:0o600});
    const env={...process.env,DATABASE_URL:urlFor(name),NODE_ENV:'test',JWT_SECRET:'isolated-admin-route-concurrency-fixture-secret',APP_BASE_URL:'https://fixture.invalid',EXPECTED_FIXTURE_PORT:port,EXPECTED_OWNED_DB:name,EXPECTED_DB_PREFIX:basePrefix};
    for(const key of Object.keys(env))if(key.startsWith('SMTP_'))delete env[key];
    const outcome=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[harness],{cwd:root,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
      child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Real staff route concurrency fixture exceeded 45 seconds'));},45000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
    });
    assert.equal(outcome.code,0,('Isolated real staff route concurrency failed: '+outcome.stdout+'\n'+outcome.stderr).replaceAll(fixturePassword,'[fixture-secret]'));
    const summary=JSON.parse(outcome.stdout.trim().split('\n').at(-1));assert.equal(summary.adminRouteScenarios,3);assert.equal(summary.actualPostgresSerializable,true);assert.equal(summary.mockedRows,0);assert.equal(summary.externalSMTP,false);
  });
  await test('REPORTS-P1-A real delivery routes serialize overlapping requests on actual PostgreSQL without duplicates or partial writes',async()=>{
    const name=createDatabase('deliveryrace');assert.equal(cli(name,['deploy']).output.seedExecuted,false);
    const harness=path.join(folder,'delivery-route-concurrency.mjs');
    fs.writeFileSync(harness,`
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const root=${JSON.stringify(root)};
const require=createRequire(root+'/package.json');
const express=require('express'),cookieParser=require('cookie-parser');
const target=new URL(process.env.DATABASE_URL);
assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,process.env.EXPECTED_FIXTURE_PORT);assert.equal(target.pathname,'/'+process.env.EXPECTED_OWNED_DB);
assert.match(process.env.EXPECTED_OWNED_DB,new RegExp('^'+process.env.EXPECTED_DB_PREFIX+'_[a-z0-9_]+_deliveryrace$'));
for(const key of Object.keys(process.env))if(key.startsWith('SMTP_'))delete process.env[key];
process.env.DELIVERY_RECORDS_ENABLED='1';
const {prisma}=await import(root+'/src/lib/db.js');
const {signToken}=await import(root+'/src/middleware/auth.js');
const app=express();app.use(express.json(),cookieParser());
app.use('/api/cases',(await import(root+'/src/routes/cases.js')).default);
const unhandled=[];app.use((error,_req,res,_next)=>{unhandled.push(error.code||error.name);res.status(500).json({error:'server_error'});});
const server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
const base='http://127.0.0.1:'+server.address().port;
const realTransaction=prisma.$transaction.bind(prisma);
let barrier=null,backendIds=new Set(),commitAborts=0;
// Pause both real Serializable transactions after each has read the case snapshot, so they truly overlap.
prisma.$transaction=(run,options)=>{
  if(Array.isArray(run))return realTransaction(run,options);
  assert.equal(options?.isolationLevel,'Serializable');
  return realTransaction(async tx=>{
    const [iso]=await tx.$queryRawUnsafe('SHOW transaction_isolation');assert.equal(iso.transaction_isolation,'serializable');
    const [backend]=await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');backendIds.add(backend.pid);
    const cases=new Proxy(tx.case,{get(delegate,key){
      if(key==='findUnique'&&barrier)return async args=>{const row=await delegate.findUnique(args);await barrier.arrive();return row;};
      const value=Reflect.get(delegate,key);return typeof value==='function'?value.bind(delegate):value;
    }});
    return run(new Proxy(tx,{get(client,key){if(key==='case')return cases;const value=Reflect.get(client,key);return typeof value==='function'?value.bind(client):value;}}));
  },{...options,maxWait:5000,timeout:10000}).catch(error=>{if(['P2002','P2034'].includes(error.code))commitAborts++;throw error;});
};
function twoWay(){let count=0,release,timer;const gate=new Promise((resolve,reject)=>{release=resolve;timer=setTimeout(()=>reject(Error('both transactions must reach the snapshot barrier')),5000);});
  return {arrive:async()=>{if(++count===2){clearTimeout(timer);release();}if(count<=2)await gate;},done:()=>clearTimeout(timer)};}
async function call(path,method,body,actor){
  const r=await fetch(base+'/api/cases/'+path,{method,signal:AbortSignal.timeout(15000),headers:{Cookie:'designpm_token='+signToken({id:actor,sessionVersion:0}),'Content-Type':'application/json'},body:body&&JSON.stringify(body)});
  return {status:r.status,data:await r.json()};
}
const day=s=>new Date(s+'T00:00:00Z');
const owner=await prisma.staff.create({data:{name:'Race owner',email:'race-owner@example.invalid',password:'unusable-fixture-value',role:'member',seniority:'mid',joined:day('2026-10-01')}});
const admin=await prisma.staff.create({data:{name:'Race admin',email:'race-admin@example.invalid',password:'unusable-fixture-value',role:'admin',seniority:'senior',joined:day('2026-10-01')}});
const cid='A-2026-10-777';
await prisma.case.create({data:{id:cid,title:'Race case',requester:'Fixture',level:'A',status:'doing',designerId:owner.id,openDate:day('2026-10-01'),dispatchDate:day('2026-10-02'),goLiveDate:day('2026-10-30'),contentVersion:1,
  items:[{key:'race-item-key-0001',n:'Race 主視覺',status:'doing'}]}});
const version=async()=>{const r=await prisma.case.findUnique({where:{id:cid}});return {expectedUpdatedAt:r.updatedAt.toISOString(),expectedContentVersion:r.contentVersion};};
const body=async(id,extra={})=>({id,itemName:'Race 主視覺',kind:'main',quantity:1,unit:'件',deliveredOn:'2026-10-21',...(await version()),...extra});
async function overlap(requests){barrier=twoWay();try{return await Promise.all(requests.map(fn=>fn()));}finally{barrier.done();barrier=null;}}
let scenarios=0;
try{
  // 1) identical retries overlap: exactly one row, one 201 and one replay
  let b=await body('race-identical-0001');let res=await overlap([()=>call(cid+'/deliveries','POST',b,owner.id),()=>call(cid+'/deliveries','POST',b,owner.id)]);
  assert.deepEqual(res.map(r=>r.status).sort(),[200,201]);assert.equal(res.find(r=>r.status===200).data.replayed,true);
  assert.equal(await prisma.deliveryRecord.count({where:{id:'race-identical-0001'}}),1);assert.equal((await prisma.case.findUnique({where:{id:cid}})).contentVersion,2);scenarios++;
  // 2) one id, different payloads: one stored, the other conflicts
  b=await body('race-mismatch-0001');res=await overlap([()=>call(cid+'/deliveries','POST',b,owner.id),()=>call(cid+'/deliveries','POST',{...b,quantity:7},owner.id)]);
  assert.deepEqual(res.map(r=>r.status).sort(),[201,409]);assert.equal(res.find(r=>r.status===409).data.error,'delivery_request_conflict');
  assert.equal((await prisma.deliveryRecord.findUnique({where:{id:'race-mismatch-0001'}})).quantity,res.find(r=>r.status===201).data.record.quantity);scenarios++;
  // 3) two new records from the same case version: one wins, the other gets a controlled 409 and writes nothing
  const v=await version();const before=await prisma.deliveryRecord.count();
  res=await overlap([()=>call(cid+'/deliveries','POST',{...v,id:'race-distinct-0001',itemName:'A',kind:'main',quantity:1,unit:'件',deliveredOn:'2026-10-21'},owner.id),
    ()=>call(cid+'/deliveries','POST',{...v,id:'race-distinct-0002',itemName:'B',kind:'extension',quantity:2,unit:'件',deliveredOn:'2026-10-21'},admin.id)]);
  assert.deepEqual(res.map(r=>r.status).sort(),[201,409]);assert.equal(res.find(r=>r.status===409).data.error,'edit_conflict');
  assert.equal(await prisma.deliveryRecord.count(),before+1);assert.equal((await prisma.case.findUnique({where:{id:cid}})).contentVersion,v.expectedContentVersion+1);scenarios++;
  // 4) the same void request twice: one stamp, one replay
  const voidBody={requestId:'race-void-request-1',reason:'重複登錄',...(await version())};
  res=await overlap([()=>call(cid+'/deliveries/race-identical-0001/void','POST',voidBody,owner.id),()=>call(cid+'/deliveries/race-identical-0001/void','POST',voidBody,owner.id)]);
  assert.deepEqual(res.map(r=>r.status),[200,200]);assert.equal(res.filter(r=>r.data.replayed).length,1);
  const voided=await prisma.deliveryRecord.findUnique({where:{id:'race-identical-0001'}});assert.equal(voided.voidRequestId,'race-void-request-1');assert.equal(voided.quantity,1);scenarios++;
  // 5) a delivery and an items save from the same version: exactly one applies
  const v2=await version();const items=(await prisma.case.findUnique({where:{id:cid}})).items;
  res=await Promise.all([call(cid+'/deliveries','POST',{...v2,id:'race-vs-items-001',itemKey:'race-item-key-0001',kind:'main',quantity:1,unit:'件',deliveredOn:'2026-10-21'},owner.id),
    call(cid+'/items','PATCH',{...v2,items:[...items,{n:'新增項目'}]},owner.id)]);
  assert.equal(res.filter(r=>r.status<300).length,1,JSON.stringify(res.map(r=>r.status)));assert.equal(res.filter(r=>r.status===409).length,1);scenarios++;
  // 6) evidence blocks case deletion through the real route and the real FK
  res=[await call(cid,'DELETE',undefined,admin.id)];assert.equal(res[0].status,409);assert.equal(res[0].data.error,'case_has_deliveries');assert(await prisma.case.findUnique({where:{id:cid}}));scenarios++;
  // 7) the same through the real RESTRICT FK alone (pre-check bypassed): still a controlled 409, case intact
  const realCount=prisma.deliveryRecord.count;prisma.deliveryRecord.count=async()=>0;
  try{res=[await call(cid,'DELETE',undefined,admin.id)];}finally{prisma.deliveryRecord.count=realCount;}
  assert.equal(res[0].status,409);assert.equal(res[0].data.error,'case_has_deliveries');assert(await prisma.case.findUnique({where:{id:cid}}));scenarios++;
  // REPORTS-P1-B: atomic correction under real overlap
  const fresh=async id=>{const r=await call(cid+'/deliveries','POST',await body(id),owner.id);assert.equal(r.status,201);return r.data.record;};
  const replaceBody=async(id,extra={})=>({...(await body(id)),quantity:2,note:'更正為 2 件',reason:'數量登錄錯誤',...extra});
  // 8) replace vs void of the same original: exactly one wins, one void stamp, no partial state
  let original=await fresh('race-replace-base-01');let rb=await replaceBody('race-replace-new-01');const vb={requestId:'race-replace-void-01',reason:'重複登錄',...(await version())};
  res=await overlap([()=>call(cid+'/deliveries/'+original.id+'/replace','POST',rb,owner.id),()=>call(cid+'/deliveries/'+original.id+'/void','POST',vb,owner.id)]);
  assert.equal(res.filter(r=>r.status<300).length,1,JSON.stringify(res.map(r=>[r.status,r.data.error])));assert.equal(res.filter(r=>r.status===409).length,1);
  let stamped=await prisma.deliveryRecord.findUnique({where:{id:original.id}});assert(stamped.voidedAt);
  const successor=await prisma.deliveryRecord.findUnique({where:{id:'race-replace-new-01'}});
  assert.equal(!!successor,stamped.voidRequestId==='race-replace-new-01','replacement exists iff it stamped the original');scenarios++;
  // 9) two different replacements of one original: one active successor only
  original=await fresh('race-replace-base-02');const r1=await replaceBody('race-replace-new-02a'),r2=await replaceBody('race-replace-new-02b',{quantity:5});
  res=await overlap([()=>call(cid+'/deliveries/'+original.id+'/replace','POST',r1,owner.id),()=>call(cid+'/deliveries/'+original.id+'/replace','POST',r2,admin.id)]);
  assert.deepEqual(res.map(r=>r.status).sort(),[201,409]);
  const successors=await prisma.deliveryRecord.findMany({where:{id:{in:['race-replace-new-02a','race-replace-new-02b']}}});assert.equal(successors.length,1);
  stamped=await prisma.deliveryRecord.findUnique({where:{id:original.id}});assert.equal(stamped.voidRequestId,successors[0].id);scenarios++;
  // 10) exact replace retry after a lost response replays; a changed reason conflicts; the version moved once
  original=await fresh('race-replace-base-03');const rr=await replaceBody('race-replace-new-03');
  const first=await call(cid+'/deliveries/'+original.id+'/replace','POST',rr,owner.id);assert.equal(first.status,201);const after=(await prisma.case.findUnique({where:{id:cid}})).contentVersion;
  const again=await call(cid+'/deliveries/'+original.id+'/replace','POST',rr,owner.id);assert.equal(again.status,200);assert.equal(again.data.replayed,true);
  const changed=await call(cid+'/deliveries/'+original.id+'/replace','POST',{...rr,reason:'另一個原因'},owner.id);assert.equal(changed.status,409);
  assert.equal((await prisma.case.findUnique({where:{id:cid}})).contentVersion,after);assert.equal(first.data.case.contentVersion,rr.expectedContentVersion+1);scenarios++;
  assert.deepEqual(unhandled,[]);assert(backendIds.size>=2,'distinct real PostgreSQL sessions must overlap');
  console.log(JSON.stringify({deliveryRouteScenarios:scenarios,actualPostgresSerializable:true,commitAborts,mockedRows:0,externalSMTP:false}));
}finally{prisma.$transaction=realTransaction;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await prisma.$disconnect();}
`,{mode:0o600});
    const env={...process.env,DATABASE_URL:urlFor(name),NODE_ENV:'test',JWT_SECRET:'isolated-delivery-route-concurrency-secret',APP_BASE_URL:'https://fixture.invalid',EXPECTED_FIXTURE_PORT:port,EXPECTED_OWNED_DB:name,EXPECTED_DB_PREFIX:basePrefix};
    for(const key of Object.keys(env))if(key.startsWith('SMTP_'))delete env[key];
    const outcome=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[harness],{cwd:root,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
      child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Real delivery route concurrency fixture exceeded 60 seconds'));},60000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
    });
    assert.equal(outcome.code,0,('Isolated real delivery route concurrency failed: '+outcome.stdout+'\n'+outcome.stderr).replaceAll(fixturePassword,'[fixture-secret]'));
    const summary=JSON.parse(outcome.stdout.trim().split('\n').at(-1));assert.equal(summary.deliveryRouteScenarios,10);assert.equal(summary.actualPostgresSerializable,true);assert.equal(summary.mockedRows,0);assert(summary.commitAborts>=3,'real PostgreSQL must abort the losing overlapped transactions');
  });
  await test('REPORTS-P1-C1 real workflow routes serialize overlapping submit/decide/withdraw/cancel/adopt on actual PostgreSQL',async()=>{
    const name=createDatabase('workflowrace');assert.equal(cli(name,['deploy']).output.seedExecuted,false);
    const harness=path.join(folder,'workflow-route-concurrency.mjs');
    fs.writeFileSync(harness,`
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const root=${JSON.stringify(root)};
const require=createRequire(root+'/package.json');
const express=require('express'),cookieParser=require('cookie-parser');
const target=new URL(process.env.DATABASE_URL);
assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,process.env.EXPECTED_FIXTURE_PORT);assert.equal(target.pathname,'/'+process.env.EXPECTED_OWNED_DB);
assert.match(process.env.EXPECTED_OWNED_DB,new RegExp('^'+process.env.EXPECTED_DB_PREFIX+'_[a-z0-9_]+_workflowrace$'));
for(const key of Object.keys(process.env))if(key.startsWith('SMTP_'))delete process.env[key];
process.env.DELIVERY_RECORDS_ENABLED='1';process.env.DELIVERY_WORKFLOW_ENABLED='1';
const {prisma}=await import(root+'/src/lib/db.js');
const {signToken}=await import(root+'/src/middleware/auth.js');
const app=express();app.use(express.json(),cookieParser());
app.use('/api/cases',(await import(root+'/src/routes/cases.js')).default);
const unhandled=[];app.use((error,_req,res,_next)=>{unhandled.push(error.code||error.name);res.status(500).json({error:'server_error'});});
const server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
const base='http://127.0.0.1:'+server.address().port;
const realTransaction=prisma.$transaction.bind(prisma);
let barrier=null,backendIds=new Set(),aborts=0,failAudit=false;
prisma.$transaction=(run,options)=>{
  if(Array.isArray(run))return realTransaction(run,options);
  assert.equal(options?.isolationLevel,'Serializable');
  return realTransaction(async tx=>{
    const [backend]=await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');backendIds.add(backend.pid);
    const cases=new Proxy(tx.case,{get(d,k){if(k==='findUnique'&&barrier)return async a=>{const r=await d.findUnique(a);await barrier.arrive();return r;};const v=Reflect.get(d,k);return typeof v==='function'?v.bind(d):v;}});
    const logs=new Proxy(tx.changeLog,{get(d,k){if(k==='createMany'&&failAudit)return async()=>{throw Error('Synthetic audit failure inside the real transaction');};const v=Reflect.get(d,k);return typeof v==='function'?v.bind(d):v;}});
    return run(new Proxy(tx,{get(c,k){if(k==='case')return cases;if(k==='changeLog')return logs;const v=Reflect.get(c,k);return typeof v==='function'?v.bind(c):v;}}));
  },{...options,maxWait:5000,timeout:10000}).catch(e=>{if(['P2002','P2034'].includes(e.code))aborts++;throw e;});
};
function twoWay(){let n=0,release,timer;const gate=new Promise((res,rej)=>{release=res;timer=setTimeout(()=>rej(Error('both transactions must reach the barrier')),5000);});return {arrive:async()=>{if(++n===2){clearTimeout(timer);release();}if(n<=2)await gate;},done:()=>clearTimeout(timer)};}
async function overlap(fns){barrier=twoWay();try{return await Promise.all(fns.map(f=>f()));}finally{barrier.done();barrier=null;}}
async function call(path,method,body,actor){const r=await fetch(base+'/api/cases/'+path,{method,signal:AbortSignal.timeout(15000),headers:{Cookie:'designpm_token='+signToken({id:actor,sessionVersion:0}),'Content-Type':'application/json'},body:body&&JSON.stringify(body)});return {status:r.status,data:await r.json()};}
const day=s=>new Date(s+'T00:00:00Z');
const mk=async(n,role)=>prisma.staff.create({data:{name:n,email:n.replace(/\\W/g,'').toLowerCase()+'@example.invalid',password:'unusable-fixture-value',role,seniority:'mid',joined:day('2026-10-01')}});
const owner=await mk('Race owner','member'),admin1=await mk('Race admin one','admin'),admin2=await mk('Race admin two','admin');
let n=0;const id=t=>t+'-'+String(++n).padStart(6,'0');
async function recordsCase(extra={}){const cid='R-2026-10-'+String(100+(++n)).padStart(3,'0');await prisma.case.create({data:{id:cid,title:'Workflow '+cid,requester:'Fixture',level:'A',status:'doing',designerId:owner.id,openDate:day('2026-10-01'),dispatchDate:day('2026-10-02'),goLiveDate:day('2026-10-30'),archivePath:'/shared/'+cid,
  deliveryMode:'records',deliveryModeSince:new Date(),deliveryModeById:admin1.id,deliveryModeByName:admin1.name,deliveryModeReason:'測試案件',...extra}});return cid;}
const ver=async cid=>{const r=await prisma.case.findUnique({where:{id:cid}});return {expectedUpdatedAt:r.updatedAt.toISOString(),expectedContentVersion:r.contentVersion};};
const deliver=async cid=>{const r=await call(cid+'/deliveries','POST',{id:id('dlv'),itemName:'主視覺',kind:'main',quantity:1,unit:'件',deliveredOn:'2026-10-21',...(await ver(cid))},owner.id);assert.equal(r.status,201,JSON.stringify(r.data));};
const submit=async(cid,body)=>call(cid+'/delivery-submissions','POST',body||{id:id('sub'),completenessConfirmed:true,...(await ver(cid))},owner.id);
let scenarios=0;
try{
  // 1) two admins decide the same submission at once
  let cid=await recordsCase();await deliver(cid);let sid=(await submit(cid)).data.submission.id;let v=await ver(cid);
  let res=await overlap([()=>call(cid+'/approve','POST',{decision:'approve',submissionId:sid,operationId:id('op'),...v},admin1.id),()=>call(cid+'/approve','POST',{decision:'reject',submissionId:sid,operationId:id('op'),comment:'請補件',...v},admin2.id)]);
  assert.deepEqual(res.map(r=>r.status).sort(),[200,409],JSON.stringify(res.map(r=>r.data)));
  const decided=await prisma.deliverySubmission.findUnique({where:{id:sid}});const row1=await prisma.case.findUnique({where:{id:cid}});
  assert.equal(row1.status,decided.decision==='approved'?'closed':'doing');assert.equal(row1.pendingDeliverySubmissionId,null);scenarios++;
  // 2) delivery write vs submit from the same version
  cid=await recordsCase();await deliver(cid);v=await ver(cid);
  res=await overlap([()=>call(cid+'/deliveries','POST',{id:id('dlv'),itemName:'延伸',kind:'extension',quantity:3,unit:'件',deliveredOn:'2026-10-21',...v},owner.id),()=>submit(cid,{id:id('sub'),completenessConfirmed:true,...v})]);
  assert.deepEqual(res.map(r=>r.status).sort(),[201,409]);
  const subNow=await prisma.deliverySubmission.findFirst({where:{caseId:cid}});
  if(subNow)assert.deepEqual(subNow.recordIds,(await prisma.deliveryRecord.findMany({where:{caseId:cid,voidedAt:null},orderBy:{id:'asc'}})).map(r=>r.id),'a submission never misses a record written alongside it');scenarios++;
  // 3) withdraw vs approve
  cid=await recordsCase();await deliver(cid);sid=(await submit(cid)).data.submission.id;v=await ver(cid);
  res=await overlap([()=>call(cid+'/delivery-submissions/'+sid+'/withdraw','POST',{id:id('wd'),reason:'需要更正',...v},owner.id),()=>call(cid+'/approve','POST',{decision:'approve',submissionId:sid,operationId:id('op'),...v},admin1.id)]);
  assert.deepEqual(res.map(r=>r.status).sort(),[200,409]);assert(['withdrawn','approved'].includes((await prisma.deliverySubmission.findUnique({where:{id:sid}})).decision));scenarios++;
  // 4) cancel vs approve: never an approved submission on a cancelled case
  cid=await recordsCase();await deliver(cid);sid=(await submit(cid)).data.submission.id;v=await ver(cid);
  res=await Promise.all([call(cid+'/cancel','POST',{reason:'需求方取消'},owner.id),call(cid+'/approve','POST',{decision:'approve',submissionId:sid,operationId:id('op'),...v},admin1.id)]);
  const c4=await prisma.case.findUnique({where:{id:cid}}),s4=await prisma.deliverySubmission.findUnique({where:{id:sid}});
  assert.equal(res.filter(r=>r.status===200).length,1,JSON.stringify(res.map(r=>[r.status,r.data.error])));
  assert(c4.status==='cancelled'?s4.decision==='cancelled':(c4.status==='closed'&&s4.decision==='approved'));assert.equal(c4.pendingDeliverySubmissionId,null);scenarios++;
  // 5) two admins adopt one legacy case with different operation ids
  const lid='L-2026-10-901';await prisma.case.create({data:{id:lid,title:'Legacy',requester:'Fixture',level:'B',status:'doing',designerId:owner.id,openDate:day('2026-10-01'),dispatchDate:day('2026-10-02'),goLiveDate:day('2026-10-30')}});v=await ver(lid);
  res=await overlap([()=>call(lid+'/delivery-mode/adopt','POST',{requestId:id('adopt'),reason:'試行導入',...v},admin1.id),()=>call(lid+'/delivery-mode/adopt','POST',{requestId:id('adopt'),reason:'試行導入',...v},admin2.id)]);
  assert.deepEqual(res.map(r=>r.status).sort(),[201,409]);assert.equal((await prisma.case.findUnique({where:{id:lid}})).deliveryMode,'records');scenarios++;
  // 6) identical submit retries overlap: one row, one 201, one replay
  cid=await recordsCase();await deliver(cid);const body={id:id('sub'),completenessConfirmed:true,...(await ver(cid))};
  res=await overlap([()=>submit(cid,body),()=>submit(cid,body)]);
  assert.deepEqual(res.map(r=>r.status).sort(),[200,201]);assert.equal(await prisma.deliverySubmission.count({where:{caseId:cid}}),1);scenarios++;
  // 7) an audit failure inside the real transaction rolls back submission, status and version together
  cid=await recordsCase();await deliver(cid);const before=await prisma.case.findUnique({where:{id:cid}});failAudit=true;
  const failed=await submit(cid);failAudit=false;
  assert.equal(failed.status,500);assert.equal(await prisma.deliverySubmission.count({where:{caseId:cid}}),0);
  const after=await prisma.case.findUnique({where:{id:cid}});assert.equal(after.status,'doing');assert.equal(after.contentVersion,before.contentVersion);assert.equal(after.updatedAt.getTime(),before.updatedAt.getTime());scenarios++;
  // Acceptance round 1: frozen-evidence PATCH race. Pause the route's own initial read (non-transaction
  // prisma.case.findUnique with collaborators), commit other real requests, then release the PATCH.
  const pausePatchRead=()=>{const real=prisma.case.findUnique;let release,readDone;const gate=new Promise(r=>{release=r;}),done=new Promise(r=>{readDone=r;});
    prisma.case.findUnique=async args=>{const result=await real.call(prisma.case,args);if(args?.include?.collaborators?.select?.id&&!args.include._count){prisma.case.findUnique=real;readDone();await gate;}return result;};
    return {readDone:done,release:()=>release()};};
  const auditCount=async cid=>prisma.changeLog.count({where:{caseId:cid}});
  // 8) stale archivePath PATCH vs submit + approval committed in between
  cid=await recordsCase();await deliver(cid);let pause=pausePatchRead();
  let patch=call(cid,'PATCH',{archivePath:'/tampered/path'},owner.id);await pause.readDone;
  sid=(await submit(cid)).data.submission.id;assert.equal((await call(cid+'/approve','POST',{decision:'approve',submissionId:sid,operationId:id('op'),...(await ver(cid))},admin1.id)).status,200);
  let snap=await prisma.case.findUnique({where:{id:cid}}),audits=await auditCount(cid);pause.release();let pr=await patch;
  assert.equal(pr.status,409,JSON.stringify(pr.data));const c8=await prisma.case.findUnique({where:{id:cid}});
  assert.equal(c8.archivePath,'/shared/'+cid);assert.equal(c8.archivePath,(await prisma.deliverySubmission.findUnique({where:{id:sid}})).archivePath);
  assert.equal(c8.status,'closed');assert.equal(c8.contentVersion,snap.contentVersion);assert.equal(c8.updatedAt.getTime(),snap.updatedAt.getTime());assert.equal(await auditCount(cid),audits);scenarios++;
  // 9) same-millisecond write: contentVersion moves while updatedAt stays identical
  cid=await recordsCase();await deliver(cid);pause=pausePatchRead();
  patch=call(cid,'PATCH',{archivePath:'/same/ms'},owner.id);await pause.readDone;
  await prisma.$executeRawUnsafe('UPDATE cases SET "contentVersion"="contentVersion"+1 WHERE id=$1',cid);
  pause.release();pr=await patch;assert.equal(pr.status,409);assert.equal((await prisma.case.findUnique({where:{id:cid}})).archivePath,'/shared/'+cid);scenarios++;
  // 10) evidence PATCH wins first; a submission carrying the old browser version loses
  cid=await recordsCase();await deliver(cid);const oldV=await ver(cid);
  assert.equal((await call(cid,'PATCH',{archivePath:'/shared/updated'},owner.id)).status,200);
  const c10=await prisma.case.findUnique({where:{id:cid}});assert.equal(c10.contentVersion,oldV.expectedContentVersion+1);
  const late=await submit(cid,{id:id('sub'),completenessConfirmed:true,...oldV});assert.equal(late.status,409);assert.equal(late.data.error,'edit_conflict');
  assert.equal(await prisma.deliverySubmission.count({where:{caseId:cid}}),0);scenarios++;
  // 11) legacy snapshot evidence PATCH vs one-way adoption committed in between
  const lid2='L-2026-10-902';await prisma.case.create({data:{id:lid2,title:'Legacy race',requester:'Fixture',level:'B',status:'doing',designerId:owner.id,openDate:day('2026-10-01'),dispatchDate:day('2026-10-02'),goLiveDate:day('2026-10-30'),archivePath:'/legacy/original'}});
  pause=pausePatchRead();patch=call(lid2,'PATCH',{archivePath:'/legacy/new'},owner.id);await pause.readDone;
  assert.equal((await call(lid2+'/delivery-mode/adopt','POST',{requestId:id('adopt'),reason:'試行導入',...(await ver(lid2))},admin1.id)).status,201);
  pause.release();pr=await patch;assert.equal(pr.status,409);const c11=await prisma.case.findUnique({where:{id:lid2}});
  assert.equal(c11.archivePath,'/legacy/original');assert.equal(c11.deliveryMode,'records');scenarios++;
  // Acceptance round 1: cancel authority is re-read inside the cancel transaction. Pause the route's own
  // bare initial read, change the actor's Staff row for real, then release the cancel.
  const pauseCancelRead=()=>{const real=prisma.case.findUnique;let release,readDone;const gate=new Promise(r=>{release=r;}),done=new Promise(r=>{readDone=r;});
    prisma.case.findUnique=async args=>{const result=await real.call(prisma.case,args);if(args&&!args.include&&!args.select){prisma.case.findUnique=real;readDone();await gate;}return result;};
    return {readDone:done,release:()=>release()};};
  const caseSnap=async cid=>{const r=await prisma.case.findUnique({where:{id:cid}});return JSON.stringify([r.status,r.archived,r.pendingDeliverySubmissionId,r.contentVersion,r.updatedAt.getTime(),await auditCount(cid)]);};
  // 12–14) non-owner admin demoted / disabled, or the primary disabled, after the initial read: 403, nothing written
  for(const [actorId,change,code] of [[admin2.id,{role:'member'},'forbidden'],[admin2.id,{active:false},'actor_inactive'],[owner.id,{active:false},'actor_inactive']]){
    cid=await recordsCase();await deliver(cid);sid=(await submit(cid)).data.submission.id;const before=await caseSnap(cid);
    const original=await prisma.staff.findUnique({where:{id:actorId},select:{role:true,active:true}});
    pause=pauseCancelRead();const cancel=call(cid+'/cancel','POST',{reason:'需求方取消'},actorId);await pause.readDone;
    await prisma.staff.update({where:{id:actorId},data:change});pause.release();const cr=await cancel;
    await prisma.staff.update({where:{id:actorId},data:original});
    assert.equal(cr.status,403,JSON.stringify(cr.data));assert.equal(cr.data.error,code);
    const s=await prisma.deliverySubmission.findUnique({where:{id:sid}});assert.equal(s.decidedAt,null);assert.equal(s.decision,null);
    assert.equal(await caseSnap(cid),before,'case, version and audit unchanged');scenarios++;
  }
  // 15) an admin demoted mid-request who is still the current primary may cancel; the stamp names the current actor
  cid=await recordsCase({designerId:admin1.id});
  assert.equal((await call(cid+'/deliveries','POST',{id:id('dlv'),itemName:'主視覺',kind:'main',quantity:1,unit:'件',deliveredOn:'2026-10-21',...(await ver(cid))},admin1.id)).status,201);
  sid=(await call(cid+'/delivery-submissions','POST',{id:id('sub'),completenessConfirmed:true,...(await ver(cid))},admin1.id)).data.submission.id;
  pause=pauseCancelRead();const cancel15=call(cid+'/cancel','POST',{reason:'需求方取消'},admin1.id);await pause.readDone;
  await prisma.staff.update({where:{id:admin1.id},data:{role:'member'}});pause.release();const c15=await cancel15;
  await prisma.staff.update({where:{id:admin1.id},data:{role:'admin'}});
  assert.equal(c15.status,200,JSON.stringify(c15.data));assert.equal((await prisma.case.findUnique({where:{id:cid}})).status,'cancelled');
  const s15=await prisma.deliverySubmission.findUnique({where:{id:sid}});assert.equal(s15.decision,'cancelled');assert.equal(s15.decidedById,admin1.id);assert.equal(s15.decidedByName,admin1.name);scenarios++;
  assert.deepEqual(unhandled.filter(x=>x!=='Error'),[]);assert(backendIds.size>=2);
  console.log(JSON.stringify({workflowRouteScenarios:scenarios,actualPostgresSerializable:true,aborts,mockedRows:0,externalSMTP:false}));
}finally{prisma.$transaction=realTransaction;server.closeAllConnections();await new Promise(r=>server.close(r));await prisma.$disconnect();}
`,{mode:0o600});
    const env={...process.env,DATABASE_URL:urlFor(name),NODE_ENV:'test',JWT_SECRET:'isolated-workflow-route-concurrency-secret',APP_BASE_URL:'https://fixture.invalid',EXPECTED_FIXTURE_PORT:port,EXPECTED_OWNED_DB:name,EXPECTED_DB_PREFIX:basePrefix};
    for(const key of Object.keys(env))if(key.startsWith('SMTP_'))delete env[key];
    const outcome=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[harness],{cwd:root,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
      child.stdout.on('data',c=>{stdout+=c;});child.stderr.on('data',c=>{stderr+=c;});
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Real workflow route concurrency fixture exceeded 90 seconds'));},90000);
      child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
    });
    assert.equal(outcome.code,0,('Isolated real workflow route concurrency failed: '+outcome.stdout+'\n'+outcome.stderr).replaceAll(fixturePassword,'[fixture-secret]'));
    const summary=JSON.parse(outcome.stdout.trim().split('\n').at(-1));assert.equal(summary.workflowRouteScenarios,15);assert.equal(summary.actualPostgresSerializable,true);assert.equal(summary.mockedRows,0);
  });
  await test('REPORTS-P2-D1a real schedule routes serialize overlapping decisions, PATCH, cancel and retries on actual PostgreSQL',async()=>{
    const name=createDatabase('schedulerace');assert.equal(cli(name,['deploy']).output.seedExecuted,false);
    const harness=path.join(folder,'schedule-route-concurrency.mjs');
    fs.writeFileSync(harness,`
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const root=${JSON.stringify(root)};
const require=createRequire(root+'/package.json');
const express=require('express'),cookieParser=require('cookie-parser');
const target=new URL(process.env.DATABASE_URL);
assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,process.env.EXPECTED_FIXTURE_PORT);assert.equal(target.pathname,'/'+process.env.EXPECTED_OWNED_DB);
assert.match(process.env.EXPECTED_OWNED_DB,new RegExp('^'+process.env.EXPECTED_DB_PREFIX+'_[a-z0-9_]+_schedulerace$'));
for(const key of Object.keys(process.env))if(key.startsWith('SMTP_'))delete process.env[key];
process.env.SCHEDULE_WORKFLOW_ENABLED='1';process.env.DELIVERY_RECORDS_ENABLED='1';process.env.DELIVERY_WORKFLOW_ENABLED='1';
const {prisma}=await import(root+'/src/lib/db.js');
const {signToken}=await import(root+'/src/middleware/auth.js');
const app=express();app.use(express.json(),cookieParser());
app.use('/api/cases',(await import(root+'/src/routes/cases.js')).default);
const unhandled=[];app.use((error,_req,res,_next)=>{unhandled.push(error.code||error.name);res.status(500).json({error:'server_error'});});
const server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
const base='http://127.0.0.1:'+server.address().port;
const realTransaction=prisma.$transaction.bind(prisma);
let barrier=null,aborts=0,failAudit=false;
prisma.$transaction=(run,options)=>{
  if(Array.isArray(run))return realTransaction(run,options);
  assert.equal(options?.isolationLevel,'Serializable');
  return realTransaction(async tx=>{
    const cases=new Proxy(tx.case,{get(d,k){if(k==='findUnique'&&barrier)return async a=>{const r=await d.findUnique(a);await barrier.arrive();return r;};const v=Reflect.get(d,k);return typeof v==='function'?v.bind(d):v;}});
    const logs=new Proxy(tx.changeLog,{get(d,k){if(k==='createMany'&&failAudit)return async()=>{throw Error('Synthetic audit failure inside the real transaction');};const v=Reflect.get(d,k);return typeof v==='function'?v.bind(d):v;}});
    return run(new Proxy(tx,{get(c,k){if(k==='case')return cases;if(k==='changeLog')return logs;const v=Reflect.get(c,k);return typeof v==='function'?v.bind(c):v;}}));
  },{...options,maxWait:5000,timeout:10000}).catch(e=>{if(['P2002','P2034'].includes(e.code))aborts++;throw e;});
};
function twoWay(){let n=0,release,timer;const gate=new Promise((res,rej)=>{release=res;timer=setTimeout(()=>rej(Error('both transactions must reach the barrier')),5000);});return {arrive:async()=>{if(++n===2){clearTimeout(timer);release();}if(n<=2)await gate;},done:()=>clearTimeout(timer)};}
async function overlap(fns){barrier=twoWay();try{return await Promise.all(fns.map(f=>f()));}finally{barrier.done();barrier=null;}}
async function call(path,method,body,actor){const r=await fetch(base+'/api/cases/'+path,{method,signal:AbortSignal.timeout(15000),headers:{Cookie:'designpm_token='+signToken({id:actor,sessionVersion:0}),'Content-Type':'application/json'},body:body&&JSON.stringify(body)});return {status:r.status,data:await r.json()};}
const day=s=>new Date(s+'T00:00:00Z');
const mk=async(n,role)=>prisma.staff.create({data:{name:n,email:n.replace(/\\W/g,'').toLowerCase()+'@example.invalid',password:'unusable-fixture-value',role,seniority:'mid',joined:day('2026-10-01')}});
const owner=await mk('Sched owner','member'),admin1=await mk('Sched admin one','admin'),admin2=await mk('Sched admin two','admin');
let n=0;const id=t=>t+'-'+String(++n).padStart(6,'0');
const ver=async cid=>{const r=await prisma.case.findUnique({where:{id:cid}});return {expectedUpdatedAt:r.updatedAt.toISOString(),expectedContentVersion:r.contentVersion};};
const ymd=d=>d?d.toISOString().slice(0,10):null;
async function managedCase(){const cid='S-2026-10-'+String(100+(++n)).padStart(3,'0');
  await prisma.case.create({data:{id:cid,title:'Schedule '+cid,requester:'Fixture',level:'A',status:'doing',designerId:owner.id,openDate:day('2026-10-01'),dispatchDate:day('2026-10-02'),copyDate:day('2026-10-10'),goLiveDate:day('2026-10-30')}});
  const a=await call(cid+'/schedule-mode/adopt','POST',{requestId:id('adopt'),reason:'試行時程受控管理',...(await ver(cid))},admin1.id);assert.equal(a.status,201,JSON.stringify(a.data));return cid;}
const propose=async(cid,extra={})=>call(cid+'/schedule-requests','POST',{id:id('sch'),reasonCategory:'requester_change',reason:'需求方延後活動檔期',proposedDates:{goLiveDate:'2026-11-06',printDate:'2026-11-01'},...(await ver(cid)),...extra},owner.id);
let scenarios=0;
try{
  // 1) two managers decide the same request at once: one wins, dates match the winner
  let cid=await managedCase();let rid=(await propose(cid)).data.request.id;let v=await ver(cid);
  let res=await overlap([()=>call(cid+'/schedule-requests/'+rid+'/decide','POST',{operationId:id('op'),decision:'approve',...v},admin1.id),()=>call(cid+'/schedule-requests/'+rid+'/decide','POST',{operationId:id('op'),decision:'reject',reason:'印刷廠排程無法延後',...v},admin2.id)]);
  assert.deepEqual(res.map(r=>r.status).sort(),[200,409],JSON.stringify(res.map(r=>r.data)));
  let row=await prisma.case.findUnique({where:{id:cid}}),req=await prisma.scheduleRequest.findUnique({where:{id:rid}});
  assert.equal(ymd(row.goLiveDate),req.decision==='approved'?'2026-11-06':'2026-10-30');assert.equal(ymd(row.printDate),req.decision==='approved'?'2026-11-01':null);assert.equal(row.pendingScheduleRequestId,null);scenarios++;
  // 2) identical proposal retries overlap: one row, one 201, one replay
  cid=await managedCase();const body={id:id('sch'),reasonCategory:'material_delay',reason:'素材延後提供',proposedDates:{goLiveDate:'2026-11-03'},...(await ver(cid))};
  res=await overlap([()=>call(cid+'/schedule-requests','POST',body,owner.id),()=>call(cid+'/schedule-requests','POST',body,owner.id)]);
  assert.deepEqual(res.map(r=>r.status).sort(),[200,201]);assert.equal(await prisma.scheduleRequest.count({where:{caseId:cid}}),1);scenarios++;
  // 3) two different proposals overlap: exactly one pending row (DB partial unique + pointer)
  cid=await managedCase();v=await ver(cid);
  res=await overlap([()=>call(cid+'/schedule-requests','POST',{id:id('sch'),reasonCategory:'other',reason:'第一個申請原因',proposedDates:{goLiveDate:'2026-11-04'},...v},owner.id),()=>call(cid+'/schedule-requests','POST',{id:id('sch'),reasonCategory:'other',reason:'第二個申請原因',proposedDates:{goLiveDate:'2026-11-05'},...v},admin1.id)]);
  assert.deepEqual(res.map(r=>r.status).sort(),[201,409],JSON.stringify(res.map(r=>r.data)));assert.equal(await prisma.scheduleRequest.count({where:{caseId:cid,decision:null}}),1);scenarios++;
  // 4) approval vs a stale full-payload PATCH read before it: the approved dates survive
  cid=await managedCase();rid=(await propose(cid)).data.request.id;
  const real=prisma.case.findUnique;let release,readDone;const gate=new Promise(r=>{release=r;}),done=new Promise(r=>{readDone=r;});
  prisma.case.findUnique=async args=>{const result=await real.call(prisma.case,args);if(args?.include?.collaborators?.select?.id&&!args.include._count){prisma.case.findUnique=real;readDone();await gate;}return result;};
  const stale=call(cid,'PATCH',{title:'只改標題',dispatchDate:'2026-10-02',copyDate:'2026-10-10',printDate:null,goLiveDate:'2026-10-30'},owner.id);await done;
  assert.equal((await call(cid+'/schedule-requests/'+rid+'/decide','POST',{operationId:id('op'),decision:'approve',...(await ver(cid))},admin1.id)).status,200);
  release();const sr=await stale;assert.equal(sr.status,200,JSON.stringify(sr.data));row=await prisma.case.findUnique({where:{id:cid}});
  assert.equal(row.title,'只改標題');assert.equal(ymd(row.goLiveDate),'2026-11-06');assert.equal(ymd(row.printDate),'2026-11-01');scenarios++;
  // 5) proposal vs cancel: never a pending request on a cancelled case
  cid=await managedCase();v=await ver(cid);
  res=await Promise.all([call(cid+'/schedule-requests','POST',{id:id('sch'),reasonCategory:'other',reason:'取消競爭的申請',proposedDates:{goLiveDate:'2026-11-08'},...v},owner.id),call(cid+'/cancel','POST',{reason:'需求方取消'},owner.id)]);
  row=await prisma.case.findUnique({where:{id:cid}});
  if(row.status==='cancelled'){assert.equal(row.pendingScheduleRequestId,null);assert.equal(await prisma.scheduleRequest.count({where:{caseId:cid,decision:null}}),0);}
  assert.equal(ymd(row.goLiveDate),'2026-10-30');scenarios++;
  // 6) audit failure inside the real transaction rolls back decision, dates, pointer and version together
  cid=await managedCase();rid=(await propose(cid)).data.request.id;const before=await prisma.case.findUnique({where:{id:cid}});failAudit=true;
  const failed=await call(cid+'/schedule-requests/'+rid+'/decide','POST',{operationId:id('op'),decision:'approve',...(await ver(cid))},admin1.id);failAudit=false;
  assert.equal(failed.status,500);row=await prisma.case.findUnique({where:{id:cid}});req=await prisma.scheduleRequest.findUnique({where:{id:rid}});
  assert.equal(req.decision,null);assert.equal(row.pendingScheduleRequestId,rid);assert.equal(ymd(row.goLiveDate),'2026-10-30');assert.equal(row.contentVersion,before.contentVersion);assert.equal(row.updatedAt.getTime(),before.updatedAt.getTime());scenarios++;
  // 7) a pending schedule request blocks records delivery submission on real PG
  cid=await managedCase();await prisma.case.update({where:{id:cid},data:{deliveryMode:'records',deliveryModeSince:new Date(),deliveryModeById:admin1.id,deliveryModeByName:admin1.name,deliveryModeReason:'測試案件',archivePath:'/shared/'+cid}});
  assert.equal((await call(cid+'/deliveries','POST',{id:id('dlv'),itemName:'主視覺',kind:'main',quantity:1,unit:'件',deliveredOn:'2026-10-21',...(await ver(cid))},owner.id)).status,201);
  rid=(await propose(cid)).data.request.id;
  const sub=await call(cid+'/delivery-submissions','POST',{id:id('sub'),completenessConfirmed:true,...(await ver(cid))},owner.id);assert.equal(sub.data.error,'schedule_request_pending');
  assert.equal(await prisma.deliverySubmission.count({where:{caseId:cid}}),0);scenarios++;
  assert.deepEqual(unhandled.filter(x=>x!=='Error'),[]);
  console.log(JSON.stringify({scheduleRouteScenarios:scenarios,actualPostgresSerializable:true,aborts,mockedRows:0,externalSMTP:false}));
}finally{prisma.$transaction=realTransaction;server.closeAllConnections();await new Promise(r=>server.close(r));await prisma.$disconnect();}
`,{mode:0o600});
    const env={...process.env,DATABASE_URL:urlFor(name),NODE_ENV:'test',JWT_SECRET:'isolated-schedule-route-concurrency-secret',APP_BASE_URL:'https://fixture.invalid',EXPECTED_FIXTURE_PORT:port,EXPECTED_OWNED_DB:name,EXPECTED_DB_PREFIX:basePrefix};
    for(const key of Object.keys(env))if(key.startsWith('SMTP_'))delete env[key];
    const outcome=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[harness],{cwd:root,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
      child.stdout.on('data',c=>{stdout+=c;});child.stderr.on('data',c=>{stderr+=c;});
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Real schedule route concurrency fixture exceeded 90 seconds'));},90000);
      child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
    });
    assert.equal(outcome.code,0,('Isolated real schedule route concurrency failed: '+outcome.stdout+'\n'+outcome.stderr).replaceAll(fixturePassword,'[fixture-secret]'));
    const summary=JSON.parse(outcome.stdout.trim().split('\n').at(-1));assert.equal(summary.scheduleRouteScenarios,7);assert.equal(summary.actualPostgresSerializable,true);assert.equal(summary.mockedRows,0);
  });
  state('complete');console.log(JSON.stringify({passed,skipped,postgresMajor,postgresVersion,fixtureDatabases:databases.size,sourceUnchangedByRestore:true,checkpoint,artifacts:folder}));
}catch(e){state('failed',e);throw e;}
finally{
  for(const client of clients)await client.$disconnect();
  for(const name of databases){own(name);const r=docker(['exec','-e','PGPASSWORD='+fixturePassword,container,'dropdb','--host','127.0.0.1','--username','postgres','--maintenance-db','design_pm_phase3_control','--if-exists','--force',name]);if(r.status!==0)console.error('Fixture cleanup failed for owned DB '+name);}
}
