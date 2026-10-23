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
const prefix='design_pm_phase3_test_'+runTag+'_';
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
function db(name){own(name);const client=new PrismaClient({datasources:{db:{url:urlFor(name)}}});clients.push(client);return client;}
function sql(name,statement){
  own(name);const r=docker(['exec','-i','-e','PGPASSWORD='+fixturePassword,container,'psql','--host','127.0.0.1','--username','postgres','--dbname',name,'-X','-q','-v','ON_ERROR_STOP=1'],{input:statement});
  assert.equal(r.status,0,'fixture SQL failed: '+r.stderr);return r.stdout;
}
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
async function noHistory(client){const[t]=await client.$queryRawUnsafe("SELECT to_regclass('public._prisma_migrations')::text AS table_name");assert.equal(t.table_name,null);}
async function test(name,fn){await fn();passed++;results.push(name);state('running');console.log('PASS '+name);}
const day=()=>new Date('2026-10-22T00:00:00Z');
async function populate(client){
  const admin=await client.staff.create({data:{name:'Isolated Admin',email:'isolated-admin@example.invalid',password:'unusable-fixture-value',role:'admin',seniority:'senior',joined:day(),sessionVersion:7,calendarVersion:3}});
  const member=await client.staff.create({data:{name:'Isolated 設計師',email:'isolated-member@example.invalid',password:'unusable-fixture-value',role:'member',seniority:'mid',joined:day(),sessionVersion:2,calendarVersion:5}});
  const former=await client.staff.create({data:{name:'Isolated Former',email:'isolated-former@example.invalid',password:'unusable-fixture-value',role:'member',seniority:'junior',joined:day(),active:false,departedOn:day()}});
  const hole=await client.staff.create({data:{name:'Isolated Sequence Hole',email:'isolated-hole@example.invalid',password:'unusable-fixture-value',seniority:'junior',joined:day()}});await client.staff.delete({where:{id:hole.id}});
  const caseId='A-2026-10-001';
  await client.case.create({data:{id:caseId,title:'Isolated relational case',requester:'Fixture requester',level:'A',status:'doing',designerId:member.id,createdById:admin.id,
    openDate:new Date('2026-10-21T00:00:00Z'),dispatchDate:day(),goLiveDate:new Date('2026-11-05T00:00:00Z'),contentVersion:9,
    collaborators:{connect:[{id:admin.id},{id:former.id}]},items:[{n:'Fixture 子項目',type:'Fixture',assigneeId:member.id,owner:member.name,logs:[{by:former.name,note:'Preserve history'}]}],
    logs:[{id:'fixture-log-one',date:'2026-10-22',by:member.name,note:'Synthetic history 文本',tag:'revise'}],deliverables:['Fixture'],note:'Synthetic fixture only'}});
  await client.case.create({data:{id:'B-2026-10-002',title:'Isolated closed case',requester:'Fixture',level:'B',status:'closed',archived:true,closedOn:day(),archivePath:'/fixture/archive',designerId:member.id,openDate:day(),dispatchDate:day(),goLiveDate:day(),contentVersion:4}});
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
    legacyBusiness=await snapshot(sourceClient,{businessOnly:true});assert.equal(legacyBusiness.tables.staff.count,'3');assert.equal(legacyBusiness.tables._collaborators.count,'2');assert.equal(legacyBusiness.tables.meeting_attendees.count,'2');await noHistory(sourceClient);
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
    const r=cli(sourceDb,['deploy']);assert.equal(r.output.seedExecuted,false);assert.deepEqual(await snapshot(sourceClient,{businessOnly:true}),legacyBusiness);
    const pk=await sourceClient.$queryRawUnsafe("SELECT conname FROM pg_constraint WHERE conrelid='public._collaborators'::regclass AND contype='p'");assert.deepEqual(pk.map(r=>r.conname),['_collaborators_AB_pkey']);
    const history=await sourceClient.$queryRawUnsafe('SELECT migration_name FROM _prisma_migrations ORDER BY migration_name');assert.deepEqual(history.map(r=>r.migration_name),['0001_legacy_baseline','0002_runtime_safety']);
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
  let restoredClient;
  await test('upgraded custom dump restores all tables migration history identity triggers and sequences exactly',async()=>{
    const r=cli(sourceDb,['backup',path.join(folder,'upgraded-backup')]);currentManifest=r.output.manifest;sourceBeforeRestore=await snapshot(sourceClient);
    const target=createDatabase('upgradedrestore');restoredClient=db(target);const restored=cli(target,['restore-check',currentManifest]);assert.equal(restored.output.rowsAndSequencesMatch,true);
    assert.deepEqual(await snapshot(restoredClient),sourceBeforeRestore);assert.deepEqual(await snapshot(sourceClient),sourceBeforeRestore);
    const identity=await restoredClient.deploymentIdentity.findUnique({where:{id:1}});assert.equal(identity.environment,'restore');await assert.rejects(restoredClient.$executeRawUnsafe('TRUNCATE deployment_identity'));
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
  await test('fresh database deploy uses reviewed migrations without automatic sample seeding',async()=>{
    const name=createDatabase('freshdeploy'),client=db(name);assert.equal(cli(name,['deploy']).output.seedExecuted,false);assert.equal(await client.staff.count(),0);assert.equal(await client.case.count(),0);assert.equal(await client.deploymentIdentity.count(),0);
    const history=await client.$queryRawUnsafe('SELECT migration_name FROM _prisma_migrations ORDER BY migration_name');assert.equal(history.length,2);
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
assert.match(process.env.EXPECTED_OWNED_DB,/^design_pm_phase3_test_[a-z0-9_]+_adminrace$/);
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
    const env={...process.env,DATABASE_URL:urlFor(name),NODE_ENV:'test',JWT_SECRET:'isolated-admin-route-concurrency-fixture-secret',APP_BASE_URL:'https://fixture.invalid',EXPECTED_FIXTURE_PORT:port,EXPECTED_OWNED_DB:name};
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
  state('complete');console.log(JSON.stringify({passed,postgresMajor,postgresVersion,fixtureDatabases:databases.size,sourceUnchangedByRestore:true,checkpoint,artifacts:folder}));
}catch(e){state('failed',e);throw e;}
finally{
  for(const client of clients)await client.$disconnect();
  for(const name of databases){own(name);const r=docker(['exec','-e','PGPASSWORD='+fixturePassword,container,'dropdb','--host','127.0.0.1','--username','postgres','--maintenance-db','design_pm_phase3_control','--if-exists','--force',name]);if(r.status!==0)console.error('Fixture cleanup failed for owned DB '+name);}
}
