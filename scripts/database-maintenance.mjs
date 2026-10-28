import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { validateRuntimeConfig } from '../src/lib/runtimeConfig.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = '0001_legacy_baseline';
const prismaCli = path.join(root,'node_modules/prisma/build/index.js');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function fileSha(file) { const hash=crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
const quote = value => '"' + String(value).replaceAll('"','""') + '"';
const normalizedSql = sql => sql.replace(/^--.*$/gm,'').replace(/\s+/g,' ').trim();
function fail(message) { throw new Error(message); }
function connection() {
  let u; try { u = new URL(process.env.DATABASE_URL); } catch { fail('DATABASE_URL must identify a PostgreSQL database'); }
  if (!['postgresql:','postgres:'].includes(u.protocol) || !u.hostname || !u.pathname.slice(1)) fail('A PostgreSQL database is required');
  // Prisma supports socket/transport overrides that libpq interprets differently.
  // Accept only the reviewed URL form shared by both clients.
  const allowed = new Set(['schema','sslmode','connection_limit','pool_timeout','connect_timeout','socket_timeout','statement_cache_size','application_name','pgbouncer']);
  for(const key of u.searchParams.keys()) if(!allowed.has(key)) fail('Unsupported database connection parameter; target overrides and socket URLs are refused');
  for(const key of allowed) if(u.searchParams.getAll(key).length>1) fail('Duplicate database connection parameters are refused');
  if(u.searchParams.has('sslmode')&&!['disable','prefer','require','verify-ca','verify-full'].includes(u.searchParams.get('sslmode'))) fail('Unsupported database SSL mode');
  const database = decodeURIComponent(u.pathname.slice(1)), schema = u.searchParams.get('schema') || 'public';
  if (schema !== 'public') fail('This migration baseline supports the public schema only');
  return {url:u,database,schema,fingerprint:sha(JSON.stringify([u.hostname,u.port||'5432',database,schema]))};
}
function runPrisma(args) {
  const result = spawnSync(process.execPath,[prismaCli,...args],{cwd:root,encoding:'utf8',maxBuffer:10*1024*1024});
  if (result.status !== 0) fail('Prisma operation failed; inspect database connectivity and migration status (connection credentials withheld)');
  return result.stdout;
}
async function snapshot(db) {
  const {database,schema,fingerprint} = connection();
  const tables = await db.$queryRawUnsafe('SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename',schema);
  const rows = {};
  for (const {tablename} of tables) {
    const q = `${quote(schema)}.${quote(tablename)}`;
    const [value] = await db.$queryRawUnsafe(`SELECT count(*)::text AS count, md5(coalesce(string_agg(md5(row_to_json(t)::text), '' ORDER BY md5(row_to_json(t)::text)), '')) AS digest FROM ${q} t`);
    rows[tablename] = value;
  }
  const sequences = await db.$queryRawUnsafe('SELECT schemaname, sequencename, last_value::text FROM pg_sequences WHERE schemaname = $1 ORDER BY sequencename',schema);
  const [version] = await db.$queryRawUnsafe('SHOW server_version');
  return {database,schema,targetFingerprint:fingerprint,serverVersion:version.server_version,tables:rows,sequences};
}
function pgEnvironment() {
  const {url:u,database} = connection();
  // Do not inherit PGSERVICE/PGHOSTADDR/PGOPTIONS and silently route the dump to
  // a different server than the Prisma snapshot/empty-target check.
  const inherited=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PG')));
  return {...inherited,PGHOST:u.hostname,PGPORT:u.port||'5432',PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:database,
    ...(u.searchParams.has('sslmode') ? {PGSSLMODE:u.searchParams.get('sslmode')} : {})};
}
async function loadBackup(manifestPath) {
  if (!manifestPath) fail('A backup manifest path is required');
  const full = path.resolve(manifestPath), manifest = JSON.parse(fs.readFileSync(full,'utf8'));
  const archive = path.resolve(path.dirname(full),manifest.archive);
  if (path.dirname(archive)!==path.dirname(full) || !fs.existsSync(archive)) fail('Backup archive must be beside its manifest');
  if (await fileSha(archive) !== manifest.archiveSha256) fail('Backup checksum mismatch');
  if (!manifest.snapshot?.tables || !manifest.snapshot?.sequences) fail('Backup manifest is incomplete');
  return {manifest,archive};
}
async function backup(db,destination) {
  if(!destination)fail('Choose a new backup directory outside the repository');
  connection(); // Refuse ambiguous targets before creating any backup artifacts.
  const folder=path.resolve(destination);
  if(folder===root||folder.startsWith(root+path.sep))fail('Store database backups outside the Git repository');
  if(fs.existsSync(folder))fail('Backup destination already exists; choose a new directory');
  fs.mkdirSync(folder,{recursive:true,mode:0o700}); fs.chmodSync(folder,0o700);
  const before=await snapshot(db);
  const archive=path.join(folder,'database.dump'), fd=fs.openSync(archive,'wx',0o600);
  let result; try {result=spawnSync(process.env.PG_DUMP_BIN||'pg_dump',['--format=custom','--no-owner','--no-acl'],{env:pgEnvironment(),stdio:['ignore',fd,'pipe']});} finally{fs.closeSync(fd);}
  if(result.status!==0){fs.unlinkSync(archive);fail('pg_dump failed; verify the client supports the server major version');}
  const after=await snapshot(db);
  if(JSON.stringify(before)!==JSON.stringify(after)){fs.unlinkSync(archive);fail('Database changed during backup verification; retry during a quiet window');}
  const migrations=fs.readdirSync(path.join(root,'prisma/migrations')).filter(n=>/^\d/.test(n));
  const manifest={format:1,createdAt:new Date().toISOString(),archive:'database.dump',archiveSha256:await fileSha(archive),nodeVersion:process.version,prismaVersion:JSON.parse(fs.readFileSync(path.join(root,'node_modules/@prisma/client/package.json'))).version,migrations,snapshot:before};
  fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({operation:'backup',manifest:path.join(folder,'manifest.json'),tables:Object.keys(before.tables).length,verified:true}));
}
async function restoreCheck(db,manifestPath) {
  const c=connection();
  if(!['localhost','127.0.0.1','[::1]'].includes(c.url.hostname)||!/^design_pm_(?:phase3|restore|delivery_[a-z])_/.test(c.database))fail('Restore checks require a named isolated loopback database'); // REPORTS-P1-C1: per-batch delivery drill namespace (loopback + empty target still required)
  const target=await snapshot(db);if(Object.keys(target.tables).length)fail('Restore target must be empty; no data will be overwritten');
  const {manifest,archive}=await loadBackup(manifestPath);
  const fd=fs.openSync(archive,'r');let result;
  try {result=spawnSync(process.env.PG_RESTORE_BIN||'pg_restore',['--dbname',c.database,'--exit-on-error','--single-transaction','--no-owner','--no-acl'],{env:pgEnvironment(),stdio:[fd,'ignore','pipe']});}finally{fs.closeSync(fd);}
  if(result.status!==0)fail('Restore failed; the target is isolated and the source was not modified');
  const actual=await snapshot(db);
  if(JSON.stringify(actual.tables)!==JSON.stringify(manifest.snapshot.tables)||JSON.stringify(actual.sequences)!==JSON.stringify(manifest.snapshot.sequences))fail('Restored rows or sequences differ from the verified backup');
  console.log(JSON.stringify({operation:'restore-check',database:c.database,tables:Object.keys(actual.tables).length,rowsAndSequencesMatch:true,sourceUnchanged:true}));
}
async function baselineExisting(db,manifestPath,apply) {
  const now=await snapshot(db);
  if(!Object.keys(now.tables).length)fail('Empty database: use db:deploy, not baseline');
  if(now.tables._prisma_migrations)fail('Migration history already exists; inspect migrate status instead of baselining again');
  const diff=runPrisma(['migrate','diff','--from-schema-datasource','prisma/schema.prisma','--to-schema-datamodel','prisma/schema.prisma','--script']);
  const expected=fs.readFileSync(path.join(root,'prisma/legacy-upgrade-preflight.sql'),'utf8');
  if(normalizedSql(diff)!==normalizedSql(expected))fail('Existing schema differs from the reviewed legacy baseline; no migration metadata was written');
  if(!apply){console.log(JSON.stringify({operation:'baseline-preview',database:now.database,structuralMatch:true,metadataWrites:0,requires:'verified full backup and explicit --apply'}));return;}
  if(process.env.BASELINE_CONFIRM!=='BASELINE EXISTING DATABASE')fail('Explicit baseline confirmation is required');
  const {manifest}=await loadBackup(manifestPath);
  if(manifest.snapshot.targetFingerprint!==now.targetFingerprint||JSON.stringify(manifest.snapshot)!==JSON.stringify(now))fail('Backup target or data no longer match this database; take a fresh backup');
  runPrisma(['migrate','resolve','--applied',baseline]);
  console.log(JSON.stringify({operation:'baseline',baseline,metadataOnly:true,businessRowsChanged:0}));
}
async function deploy(db) {
  validateRuntimeConfig(process.env);
  const current=await snapshot(db);
  if(Object.keys(current.tables).length&&!current.tables._prisma_migrations)fail('Existing database has no migration history. Run db:baseline preview, verified backup/restore drill, then explicit baseline before deployment');
  runPrisma(['migrate','deploy']); console.log(JSON.stringify({operation:'migrate-deploy',seedExecuted:false}));
}
async function identify(db,environment,instanceId,apply) {
  if(!['demo','production','restore'].includes(environment)||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId||''))fail('Provide an environment and a unique non-secret instance UUID');
  const existing=await db.deploymentIdentity.findUnique({where:{id:1}});
  if(existing){if(existing.environment!==environment||existing.instanceId!==instanceId)fail('Database identity is already provisioned and cannot be changed');console.log(JSON.stringify({operation:'identity',alreadyProvisioned:true,environment}));return;}
  if(!apply){console.log(JSON.stringify({operation:'identity-preview',environment,writes:0}));return;}
  if(process.env.IDENTITY_CONFIRM!=='PROVISION DATABASE IDENTITY')fail('Explicit identity provisioning confirmation is required');
  await db.deploymentIdentity.create({data:{id:1,environment,instanceId}});
  console.log(JSON.stringify({operation:'identity',environment,provisioned:true}));
}
const [command,...args]=process.argv.slice(2), db=new PrismaClient();
try {
  if(command==='backup')await backup(db,args[0]);
  else if(command==='restore-check')await restoreCheck(db,args[0]);
  else if(command==='baseline')await baselineExisting(db,args.find(x=>!x.startsWith('--')),args.includes('--apply'));
  else if(command==='deploy')await deploy(db);
  else if(command==='identify')await identify(db,args[0],args[1],args.includes('--apply'));
  else fail('Usage: database-maintenance.mjs backup <new-directory> | restore-check <manifest> | baseline [manifest] [--apply] | deploy | identify <environment> <instance-id> [--apply]');
}catch(e){console.error('[database-maintenance]',e?.message?.includes('prisma')?'Database operation failed; credentials withheld':String(e.message||'Database operation failed').replaceAll(process.env.DATABASE_URL||'__no_database_url__','[database]'));process.exitCode=1;}
finally{await db.$disconnect();}
