// REPORTS-P3-E3: the real scheduler worker + real work-report service + real routers (requireAuth) on actual PostgreSQL.
// Spawned only by tests/postgresMaintenance.mjs against a database it created (and deployed 0001–0010) on the labelled
// loopback fixture; refuses anything else. Two Prisma clients (2 + 1 connections) stand in for two server processes; the
// maintenance CLI runs as a child process (1 connection). Evidence scope:
// - every report source is real (a fresh database's ended periods are before coverage → honest insufficient snapshots);
// - test-only service wrappers simulate a process that dies right after its snapshot commit, a paused worker whose lease
//   expires, and source failures (not settled / clock unreliable). They are wired only here by factory injection.
// No clock, coverage, source event or capturedAt is forged; job rows are changed only by the scheduler, the service and the CLI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = process.env.DESIGN_PM_ROOT;
const require = createRequire(root + '/package.json');
const express = require('express'), cookieParser = require('cookie-parser'), { PrismaClient } = require('@prisma/client');
const target = new URL(process.env.DATABASE_URL);
assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.port, process.env.EXPECTED_FIXTURE_PORT); assert.equal(target.pathname, '/' + process.env.EXPECTED_OWNED_DB);
assert.match(process.env.EXPECTED_OWNED_DB, new RegExp('^' + process.env.EXPECTED_DB_PREFIX + '_[a-z0-9_]+_e3sched$'));
assert.equal(target.searchParams.get('connection_limit'), '2'); assert.equal(process.env.NODE_ENV, 'test');
for (const key of Object.keys(process.env)) if (key.startsWith('SMTP_')) delete process.env[key];
const secret = target.password;

const { prisma } = await import(root + '/src/lib/db.js');
const { signToken } = await import(root + '/src/middleware/auth.js');
const WR = await import(root + '/src/lib/workReports.js');
const RS = await import(root + '/src/lib/reportSources.js');
const RP = await import(root + '/src/lib/reportPeriods.js');
const P = await import(root + '/src/lib/workReportPayload.js');
const SCH = await import(root + '/src/services/workReportScheduler.js');
const urlB = new URL(process.env.DATABASE_URL); urlB.searchParams.set('connection_limit', '1');
const clientB = new PrismaClient({ datasources: { db: { url: urlB.toString() } } });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const [{ today }] = await prisma.$queryRawUnsafe(`SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') AS today`);
const startDate = addDays(today, -70);
process.env.WORK_REPORT_SCHEDULER_ENABLED = 'true'; process.env.WORK_REPORT_SCHEDULER_START_DATE = startDate;   // read by the status route at request time

const app = express(); app.use(express.json(), cookieParser());
app.use('/api/work-reports', (await import(root + '/src/routes/workReports.js')).default);
app.use('/api/admin', (await import(root + '/src/routes/admin.js')).default);
const unhandled = []; app.use((error, _req, res, _next) => { unhandled.push(String(error.message)); res.status(500).json({ error: 'server_error' }); });
const server = app.listen(0, '127.0.0.1'); await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const base = 'http://127.0.0.1:' + server.address().port;
async function api(path, method = 'GET', body, actor) {
  const headers = { 'Content-Type': 'application/json' };
  if (actor) headers.Cookie = 'designpm_token=' + signToken({ id: actor.id, sessionVersion: actor.sessionVersion });
  const r = await fetch(base + path, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  return { status: r.status, data: await r.json().catch(() => null) };
}
function cli(args, env = {}) {
  const u = new URL(process.env.DATABASE_URL); u.searchParams.set('connection_limit', '1');
  const r = spawnSync(process.execPath, [root + '/scripts/work-report-jobs.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL: u.toString(), DOTENV_CONFIG_PATH: '/nonexistent-e3.env', ...env } });
  assert(!(r.stdout + r.stderr).includes(secret), 'CLI never prints credentials');
  let out; try { out = JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch {}
  return { status: r.status, out, err: r.stderr };
}
const logs = [];
const quiet = { log: m => logs.push(m), warn: m => logs.push(m) };
const cfg = { enabled: true, startDate };
const worker = (o = {}) => SCH.createWorkReportScheduler({ db: o.db ?? prisma, service: o.service ?? WR.createWorkReportService({ db: o.db ?? prisma }), config: o.config ?? cfg,
  owner: o.owner, leaseMs: o.leaseMs, runsPerTick: o.runs ?? 1, enqueueLimit: o.limit ?? 0, backoff: o.backoff, log: quiet });
const JOBS = `SELECT ${SCH.JOB_COLUMNS} FROM report_job_runs`;
const jobOf = async p => (await prisma.$queryRawUnsafe(`${JOBS} WHERE "periodKind" = $1 AND "startDate" = $2::date`, p.kind, p.startDate))[0];
const snapsOf = async p => prisma.$queryRawUnsafe(`SELECT id, revision, trigger, "generatedById", "generatedByName", "idempotencyKey", "requestFingerprint", payload, "payloadSha256", "sourceCompleteness",
  to_char("cutoffInstant" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS c, to_char("knowledgeCutoff" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS k
  FROM report_snapshots WHERE "periodKind" = $1 AND "startDate" = $2::date ORDER BY revision`, p.kind, p.startDate);
const rowDigest = async (table, id) => (await prisma.$queryRawUnsafe(`SELECT md5(row_to_json(t)::text) AS d FROM ${table} t WHERE id = $1`, id))[0]?.d;
const marks = () => prisma.$queryRawUnsafe(`SELECT 'job' AS t, id, xmin::text AS x FROM report_job_runs UNION ALL SELECT 'state', id::text, xmin::text FROM report_scheduler_state ORDER BY 1, 2`);
const n = async (sql, ...a) => Number((await prisma.$queryRawUnsafe(sql, ...a))[0].n);
const asPeriod = j => RP.periodFromStart(j.periodKind, j.startDate);
const order = list => list.slice().sort((a, b) => (SCH.dueInstant(a) < SCH.dueInstant(b) ? -1 : SCH.dueInstant(a) > SCH.dueInstant(b) ? 1 : a.kind < b.kind ? -1 : 1));
const nowIso = async () => (await prisma.$queryRawUnsafe(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`))[0].now;
const planned = async (start, limit = 1000) => { const now = await nowIso(); return order(RP.PERIOD_KINDS.flatMap(k => SCH.planDue(k, { cursor: null, startDate: start, now, limit }))); };
async function waitFor(fn, ms = 30000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error('timed out waiting'); await sleep(50); } }
function checkScheduled(s, p) {
  assert.equal(s.revision, 1); assert.equal(s.trigger, 'scheduled'); assert.equal(s.generatedById, null); assert.equal(s.generatedByName, null);
  assert.equal(s.payload.meta.generatedBy, null); assert.equal(s.payload.meta.trigger, 'scheduled'); assert.equal(s.c, RP.periodInstants(p).cutoffInstant); assert.equal(s.k, s.c, 'initial version: K = C');
  assert.equal(s.idempotencyKey, WR.scheduledIdempotencyKey(p)); assert.equal(s.requestFingerprint, WR.scheduledFingerprint(p)); assert.equal(P.payloadSha256(s.payload), s.payloadSha256);
  assert.equal(s.sourceCompleteness, 'insufficient', 'periods before this fresh database\'s coverage are honestly insufficient (never zero-filled)');
}
let scenarios = 0; const done = () => { scenarios++; };
let staffSeq = 0;
const mk = (name, role) => prisma.staff.create({ data: { name, email: 'e3-staff-' + (++staffSeq) + '@example.invalid', password: 'unusable-fixture-value', role, seniority: 'mid', joined: new Date('2026-01-05T00:00:00Z') } });

try {
  const admin = await mk('E3 admin', 'admin'), member = await mk('E3 member', 'member');

  // A. disabled / out-of-window: nothing written, no state row
  assert.deepEqual(await worker({ config: { enabled: false, startDate: null } }).tick(), { state: 'disabled' });
  assert.equal((await worker({ config: { enabled: true, startDate: addDays(today, -400) } }).tick()).reason, 'start_date_out_of_range');
  assert.equal(await n('SELECT count(*)::int AS n FROM report_scheduler_state'), 0); assert.equal(await n('SELECT count(*)::int AS n FROM report_job_runs'), 0);
  done();

  // B. a manual initial version exists before the scheduler: the earliest due period
  const all1 = await planned(startDate);
  const seq = order(RP.PERIOD_KINDS.flatMap(k => all1.filter(p => p.kind === k).slice(0, 3)));
  assert(seq.length >= 6, 'enough due periods for the sequence');
  const man = await api('/api/work-reports/generate', 'POST', { periodKind: seq[0].kind, startDate: seq[0].startDate, idempotencyKey: 'e3-manual-first-0001' }, admin);
  assert.equal(man.status, 201); assert.equal(man.data.snapshot.trigger, 'manual'); assert.equal(man.data.snapshot.generatedByName, 'E3 admin');
  const manDigest = await rowDigest('report_snapshots', man.data.snapshot.id);

  // C. activation + durable enqueue (bounded: 3 per kind) — no runs
  const A = worker({ owner: 'e3-a', runs: 0, limit: 3 });
  const t1 = await A.tick(); assert.equal(t1.state, 'active'); assert.equal(t1.enqueued, seq.length); assert.deepEqual(t1.runs, []);
  const st = await SCH.readSchedulerState(prisma);
  assert.equal(st.epoch, 1); assert.equal(st.startDate, startDate); assert.equal(st.status, 'active'); assert.equal(st.stateCoverage, st.coverageStart, 'epoch = current coverage');
  assert(st.activatedAt <= st.now);
  for (const k of RP.PERIOD_KINDS) assert.equal(st[k + 'Cursor'], seq.filter(p => p.kind === k).at(-1)?.endDateExclusive ?? null, 'cursor = last durable job of its kind');
  const pending = await prisma.$queryRawUnsafe(`${JOBS} ORDER BY "dueAt", "periodKind"`);
  assert.deepEqual(pending.map(j => j.periodKind + j.startDate), seq.map(p => p.kind + p.startDate));
  for (const j of pending) {
    assert.deepEqual([j.status, j.attemptCount, j.maxAttempts, j.epoch, j.leaseToken, j.snapshotId], ['pending', 0, SCH.MAX_ATTEMPTS, 1, null, null]);
    assert.equal(j.dueAt, SCH.dueInstant(asPeriod(j))); assert.equal(j.nextAttemptAt, j.dueAt); assert.equal(j.idempotencyKey, WR.scheduledIdempotencyKey(asPeriod(j)));
  }
  assert.equal(await n('SELECT count(*)::int AS n FROM report_snapshots'), 1, 'enqueue never publishes');
  done();

  // D. manual version won → skipped_existing linked to the real manual snapshot, which is byte-identical
  const N = worker({ owner: 'e3-n', runs: 1 });
  let r = await N.tick(); assert.deepEqual(r.runs.map(x => x.outcome), ['skipped_existing']);
  let j0 = await jobOf(seq[0]); assert.deepEqual([j0.status, j0.snapshotId, j0.leaseToken, j0.lastErrorCode], ['skipped_existing', man.data.snapshot.id, null, null]);
  assert.equal(await rowDigest('report_snapshots', man.data.snapshot.id), manDigest); assert.equal((await snapsOf(seq[0])).length, 1);
  done();

  // E. a worker dies right after its snapshot commit (job still running, lease held) → after the lease expires another
  //    worker replays the SAME snapshot (same key), never a second version
  const real = WR.createWorkReportService({ db: prisma });
  let crashed = null;
  const X = worker({ owner: 'e3-crash', runs: 1, leaseMs: 1500, service: { generateScheduled: async a => { const x = await real.generateScheduled(a); crashed = x.snapshot; await new Promise(() => {}); } } });
  X.tick();
  await waitFor(() => crashed);
  let j1 = await jobOf(seq[1]); assert.deepEqual([j1.status, j1.leaseOwner, j1.snapshotId, j1.attemptCount], ['running', 'e3-crash', null, 1]);
  assert.equal((await snapsOf(seq[1])).length, 1, 'the snapshot committed before the crash');
  assert.equal((await prisma.$queryRawUnsafe(`${JOBS} WHERE status = 'running' AND "leaseUntil" > clock_timestamp()`)).length, 1, 'the dead worker still holds a live lease');
  await sleep(1700);
  r = await N.tick(); assert.deepEqual(r.runs.map(x => [x.outcome, x.snapshotId]), [['succeeded', crashed.id]]);
  j1 = await jobOf(seq[1]); assert.deepEqual([j1.status, j1.snapshotId, j1.attemptCount, j1.leaseOwner], ['succeeded', crashed.id, 2, null]);
  const s1 = await snapsOf(seq[1]); assert.equal(s1.length, 1); checkScheduled(s1[0], seq[1]);
  assert(logs.some(l => /succeeded \(replayed\)/.test(l)));
  done();

  // F. transient failure → same job/key back to pending with backoff, no snapshot, not success
  const notSettled = WR.createWorkReportService({ db: prisma, readSources: async () => { throw new RS.ReportSourceError('source_not_settled', '仍有在截止時間前開始、尚未結束的資料異動', { reason: 'open_transactions' }); } });
  r = await worker({ owner: 'e3-retry', runs: 1, service: notSettled, backoff: () => 20000 }).tick(); assert.deepEqual(r.runs.map(x => [x.outcome, x.code]), [['retry', 'source_not_settled']]);
  const j2 = await jobOf(seq[2]); const now2 = await nowIso();
  assert.deepEqual([j2.status, j2.attemptCount, j2.lastErrorCode, j2.leaseToken, j2.snapshotId, j2.idempotencyKey], ['pending', 1, 'source_not_settled', null, null, WR.scheduledIdempotencyKey(seq[2])]);
  assert(j2.nextAttemptAt > addSeconds(now2, 15), 'backoff applied'); assert.equal((await snapsOf(seq[2])).length, 0);
  done();

  // G. a paused worker whose lease expires: the new owner finishes; the stale worker writes nothing (inside the publication
  //    transaction its FOR SHARE re-check fails, and its result write needs its own token). The claim had committed before
  //    the publication snapshot (the job is visible as running inside it) — it never blocks settle(K).
  let reached, release; const atHook = new Promise(res => { reached = res; }); const gate = new Promise(res => { release = res; });
  let seenInside = null;
  const hooked = WR.createWorkReportService({ db: prisma, readSources: (db, o, fn) => WR.readReportSources(db, o, async (tx, src) => {
    seenInside = (await tx.$queryRawUnsafe(`SELECT status, "leaseOwner" FROM report_job_runs WHERE "periodKind" = $1 AND "startDate" = $2::date`, seq[3].kind, seq[3].startDate))[0];
    reached(); await gate; return fn(tx, src); }) });
  const C = worker({ owner: 'e3-stale', runs: 1, leaseMs: 1500, service: hooked });
  const cTick = C.tick();
  await atHook; assert.deepEqual(seenInside, { status: 'running', leaseOwner: 'e3-stale' });
  await sleep(1700);
  const D = worker({ owner: 'e3-d', runs: 1, db: clientB });
  r = await D.tick(); assert.deepEqual(r.runs.map(x => x.outcome), ['succeeded']);
  const dSnap = r.runs[0].snapshotId;
  release(); const cResult = await cTick;
  assert.deepEqual(cResult.runs.map(x => x.outcome), ['lease_lost']);
  const j3 = await jobOf(seq[3]); assert.deepEqual([j3.status, j3.snapshotId, j3.leaseOwner], ['succeeded', dSnap, null]);
  const s3 = await snapsOf(seq[3]); assert.equal(s3.length, 1); checkScheduled(s3[0], seq[3]);
  done();

  // H. a non-transient failure is blocked immediately with its code; the CLI retries only an explicit blocked job of the
  //    current epoch, with a concrete reason and confirmation, under the same key
  const clockBad = WR.createWorkReportService({ db: prisma, readSources: async () => { throw new RS.ReportSourceError('source_clock_unreliable', '資料庫時鐘與已記錄的來源時間不一致'); } });
  r = await worker({ owner: 'e3-f', runs: 1, service: clockBad }).tick(); assert.deepEqual(r.runs.map(x => [x.outcome, x.code]), [['blocked', 'source_clock_unreliable']]);
  let j4 = await jobOf(seq[4]); assert.deepEqual([j4.status, j4.attemptCount, j4.lastErrorCode, j4.snapshotId], ['blocked', 1, 'source_clock_unreliable', null]); assert(j4.finishedAt);
  assert.equal(cli(['retry', j4.id, '--reason', '時鐘已核對']).status, 1, 'confirmation required');
  assert.equal(cli(['retry', j4.id, '--reason', '!!'], { WORK_REPORT_JOB_CONFIRM: 'RETRY WORK REPORT JOB' }).status, 1, 'a concrete reason is required');
  assert.match(cli(['retry', j1.id, '--reason', '重試成功的工作'], { WORK_REPORT_JOB_CONFIRM: 'RETRY WORK REPORT JOB' }).err, /Only a blocked job/);
  assert.equal(cli(['retry', 'wj_not-a-job', '--reason', '格式錯誤'], { WORK_REPORT_JOB_CONFIRM: 'RETRY WORK REPORT JOB' }).status, 1);
  const rt = cli(['retry', j4.id, '--reason', '資料庫時鐘已人工核對'], { WORK_REPORT_JOB_CONFIRM: 'RETRY WORK REPORT JOB' });
  assert.equal(rt.status, 0, rt.err); assert.deepEqual([rt.out.status, rt.out.previousErrorCode, rt.out.sameIdempotencyKey], ['pending', 'source_clock_unreliable', true]);
  j4 = await jobOf(seq[4]); assert.deepEqual([j4.status, j4.attemptCount, j4.retryCount, j4.lastRetryReason, j4.finishedAt, j4.idempotencyKey], ['pending', 0, 1, '資料庫時鐘已人工核對', null, WR.scheduledIdempotencyKey(seq[4])]);
  done();

  // I. persistent transient failure → bounded attempts, then blocked (never success); stays blocked for the reinit test
  // (earlier runnable jobs — seq[4] pending again, seq[2] once its backoff passed — are claimed first and exhausted too)
  const E2 = worker({ owner: 'e3-e', runs: 3, service: notSettled, backoff: () => 0 });
  for (let i = 0; i < 40 && (await jobOf(seq[5])).status !== 'blocked'; i++) await E2.tick();
  let j5 = await jobOf(seq[5]);
  assert.deepEqual([j5.status, j5.attemptCount, j5.lastErrorCode, j5.snapshotId], ['blocked', SCH.MAX_ATTEMPTS, 'exhausted_source_not_settled', null]);
  const exhausted = await prisma.$queryRawUnsafe(`${JOBS} WHERE status = 'blocked' ORDER BY "dueAt"`);
  assert(exhausted.every(j => j.lastErrorCode === 'exhausted_source_not_settled' && j.attemptCount === j.maxAttempts && !j.snapshotId));
  for (const j of exhausted.filter(x => x.id !== j5.id)) assert.equal(cli(['retry', j.id, '--reason', '來源已穩定，重新排入'], { WORK_REPORT_JOB_CONFIRM: 'RETRY WORK REPORT JOB' }).status, 0);
  done();

  // J. status API: real admin only, read-only, no publish route
  const before = await marks();
  const sa = await api('/api/work-reports/scheduler/status', 'GET', null, admin);
  assert.equal(sa.status, 200); assert.equal(sa.data.enabled, true); assert.equal(sa.data.state.epoch, 1); assert.equal(sa.data.state.startDateMatches, true); assert.equal(sa.data.state.coverageMatches, true);
  assert(sa.data.attention.some(j => j.id === j5.id && j.status === 'blocked' && j.lastErrorCode === 'exhausted_source_not_settled'));
  assert(sa.data.attention.every(j => j.status === 'blocked' || j.attemptCount > 0)); assert.equal(sa.data.counts.blocked, 1);
  assert(sa.data.next.length === 3 && sa.data.next.every(x => x.dueAt === SCH.dueInstant(RP.periodFromStart(x.kind, x.startDate))), 'next due = first not-yet-enqueued period'); assert(!JSON.stringify(sa.data).includes('"payload"'), 'no report content in the status');
  assert.equal((await api('/api/work-reports/scheduler/status', 'GET', null, member)).status, 403);
  assert.equal((await api('/api/work-reports/scheduler/status')).status, 401);
  assert.equal((await api('/api/work-reports/scheduler/status?force=1', 'GET', null, admin)).status, 400);
  for (const path of ['/api/work-reports/scheduler/status', '/api/work-reports/scheduler/run', '/api/work-reports/scheduler']) assert.equal((await api(path, 'POST', {}, admin)).status, 404, path);
  for (const body of [{ periodKind: 'week', startDate: seq[0].startDate, idempotencyKey: 'e3-forged-0001', trigger: 'scheduled' }, { periodKind: 'week', startDate: seq[0].startDate, idempotencyKey: 'e3-forged-0002', system: true },
    { periodKind: seq[2].kind, startDate: seq[2].startDate, idempotencyKey: WR.scheduledIdempotencyKey(seq[2]) }])
    assert.equal((await api('/api/work-reports/generate', 'POST', body, admin)).status, 400, JSON.stringify(body));
  assert.deepEqual(await marks(), before, 'status reads and refused requests write nothing');
  done();

  // K. two workers (two clients) drain concurrently: every due period exactly one initial version; idle ticks write nothing
  await waitFor(async () => (await jobOf(seq[2])).nextAttemptAt <= await nowIso(), 40000);
  const WA = worker({ owner: 'e3-wa', runs: 2, limit: 3 }), WB = worker({ owner: 'e3-wb', runs: 2, limit: 3, db: clientB });
  for (let round = 0; round < 60; round++) {
    const [ra, rb] = await Promise.all([WA.tick(), WB.tick()]);
    if (!ra.enqueued && !rb.enqueued && !ra.runs.length && !rb.runs.length) break;
  }
  const allJobs = await prisma.$queryRawUnsafe(`${JOBS} ORDER BY "dueAt", "periodKind"`);
  const want = await planned(startDate);
  assert.deepEqual(allJobs.map(j => j.periodKind + j.startDate), want.map(p => p.kind + p.startDate), 'one job per due period, none missing, none extra');
  for (const j of allJobs) {
    const p = asPeriod(j), snaps = await snapsOf(p);
    if (j.periodKind + j.startDate === seq[0].kind + seq[0].startDate) continue;
    if (j.id === j5.id) { assert.equal(j.status, 'blocked'); assert.equal(snaps.length, 0); continue; }   // kept blocked for M
    assert.equal(j.status, 'succeeded', j.periodKind + j.startDate); assert.equal(snaps.length, 1); assert.equal(snaps[0].id, j.snapshotId); checkScheduled(snaps[0], p);
  }
  const [dups] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM (SELECT 1 FROM report_snapshots GROUP BY "periodKind","startDate","rulesVersion",revision HAVING count(*) > 1) d`);
  assert.equal(dups.n, 0); assert.equal(await n('SELECT count(*)::int AS n FROM report_snapshots'), allJobs.length - 1, 'one per job except the blocked one');
  const idle = await marks();
  const [ia, ib] = await Promise.all([WA.tick(), WB.tick()]); assert.deepEqual([ia.enqueued, ia.runs, ib.enqueued, ib.runs], [0, [], 0, []]);
  assert.deepEqual(await marks(), idle, 'idle ticks write no heartbeat, cursor or job row');
  done();

  // L. manual semantics unchanged next to scheduled versions: initial → 409 report_exists; revision on a scheduled version
  //    is a manual version (K = DB now) and the scheduled row is byte-identical
  const sv = (await snapsOf(seq[1]))[0], svDigest = await rowDigest('report_snapshots', sv.id);
  const dupe = await api('/api/work-reports/generate', 'POST', { periodKind: seq[1].kind, startDate: seq[1].startDate, idempotencyKey: 'e3-manual-dupe-0001' }, admin);
  assert.equal(dupe.status, 409); assert.equal(dupe.data.error, 'report_exists');
  const rev = await api(`/api/work-reports/${sv.id}/revisions`, 'POST', { reason: '期後補登確認', expectedLatestRevision: 1, idempotencyKey: 'e3-manual-rev-0001' }, admin);
  assert.equal(rev.status, 201); assert.deepEqual([rev.data.snapshot.trigger, rev.data.snapshot.generatedByName, rev.data.snapshot.supersedesId, rev.data.snapshot.revision], ['manual', 'E3 admin', sv.id, 2]);
  assert(rev.data.snapshot.knowledgeCutoff > rev.data.snapshot.cutoffInstant); assert.equal(await rowDigest('report_snapshots', sv.id), svDigest);
  const revoked = await prisma.staff.update({ where: { id: admin.id }, data: { sessionVersion: { increment: 1 } } });
  assert.equal((await api('/api/work-reports/generate', 'POST', { periodKind: 'week', startDate: seq[0].startDate, idempotencyKey: 'e3-revoked-0001' }, admin)).status, 401, 'old session revoked');
  Object.assign(admin, { sessionVersion: revoked.sessionVersion });
  done();

  // M. start-date change: mismatch refuses quietly; the CLI reinitializes explicitly (new epoch, unfinished jobs re-homed,
  //    finished jobs and their snapshots untouched); earlier periods are then scheduled under the new epoch
  const newStart = addDays(startDate, -21), finishedBefore = await prisma.$queryRawUnsafe(`SELECT id, md5(row_to_json(t)::text) AS d FROM report_job_runs t WHERE status IN ('succeeded','skipped_existing') ORDER BY id`);
  const G = worker({ owner: 'e3-g', runs: 5, limit: 20, config: { enabled: true, startDate: newStart } });
  const m0 = await marks(); assert.equal((await G.tick()).reason, 'start_date_mismatch'); assert.deepEqual(await marks(), m0);
  assert.match(cli(['reinit', '--start-date', newStart, '--reason', '起始日提前三週'], { WORK_REPORT_JOB_CONFIRM: 'REINITIALIZE WORK REPORT SCHEDULER', WORK_REPORT_SCHEDULER_START_DATE: startDate }).err, /must equal/);
  assert.equal(cli(['reinit', '--start-date', newStart, '--reason', '起始日提前三週'], { WORK_REPORT_SCHEDULER_START_DATE: newStart }).status, 1, 'confirmation required');
  const ri = cli(['reinit', '--start-date', newStart, '--reason', '起始日提前三週'], { WORK_REPORT_JOB_CONFIRM: 'REINITIALIZE WORK REPORT SCHEDULER', WORK_REPORT_SCHEDULER_START_DATE: newStart });
  assert.equal(ri.status, 0, ri.err); assert.deepEqual([ri.out.epoch, ri.out.startDate, ri.out.rehomedUnfinishedJobs], [2, newStart, 1]);
  assert.equal((await A.tick()).reason, 'start_date_mismatch', 'a server still on the old start date does nothing');
  j5 = await jobOf(seq[5]); assert.deepEqual([j5.epoch, j5.status, j5.attemptCount], [2, 'pending', 0]);
  for (let i = 0; i < 20; i++) { r = await G.tick(); if (!r.enqueued && !r.runs.length) break; }
  j5 = await jobOf(seq[5]); assert.equal(j5.status, 'succeeded'); checkScheduled((await snapsOf(seq[5]))[0], seq[5]);
  const want2 = await planned(newStart), jobs2 = await prisma.$queryRawUnsafe(`${JOBS} ORDER BY "dueAt", "periodKind"`);
  assert.deepEqual(jobs2.map(j => j.periodKind + j.startDate), want2.map(p => p.kind + p.startDate)); assert(want2.length > want.length);
  assert.deepEqual(await prisma.$queryRawUnsafe(`SELECT id, md5(row_to_json(t)::text) AS d FROM report_job_runs t WHERE id = ANY($1::text[]) ORDER BY id`, finishedBefore.map(x => x.id)), finishedBefore, 'finished jobs are final');
  await assert.rejects(prisma.$executeRawUnsafe(`UPDATE report_job_runs SET "lastErrorCode" = 'tamper' WHERE id = $1`, j1.id), /final/);
  done();

  // N. full reset (real admin route): jobs and snapshots purged in the same transaction; the scheduler pauses once on the
  //    changed coverage epoch (no further writes) until an explicit reinit, then schedules again from the start date
  const reset = await api('/api/admin/factory-reset', 'POST', { confirm: 'DELETE ALL DATA', adminEmail: admin.email }, admin);
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.equal(await n('SELECT count(*)::int AS n FROM report_job_runs'), 0); assert.equal(await n('SELECT count(*)::int AS n FROM report_snapshots'), 0);
  r = await G.tick(); assert.deepEqual(r, { state: 'paused', reason: 'coverage_epoch_changed' });
  const p0 = await marks(); r = await G.tick(); assert.equal(r.state, 'paused'); assert.deepEqual(await marks(), p0, 'a paused state is written once');
  const sp = await api('/api/work-reports/scheduler/status', 'GET', null, admin); assert.deepEqual([sp.data.state.status, sp.data.state.pausedReason, sp.data.state.coverageMatches], ['paused', 'coverage_epoch_changed', false]);
  assert.equal(cli(['retry', jobs2[0].id, '--reason', '暫停中重試'], { WORK_REPORT_JOB_CONFIRM: 'RETRY WORK REPORT JOB' }).status, 1);
  const r3 = cli(['reinit', '--start-date', newStart, '--reason', '全站重置後重新初始化'], { WORK_REPORT_JOB_CONFIRM: 'REINITIALIZE WORK REPORT SCHEDULER', WORK_REPORT_SCHEDULER_START_DATE: newStart });
  assert.equal(r3.status, 0, r3.err); assert.deepEqual([r3.out.epoch, r3.out.previousStatus, r3.out.rehomedUnfinishedJobs], [3, 'paused', 0]);
  assert.match(cli(['reinit', '--start-date', newStart, '--reason', '重複執行'], { WORK_REPORT_JOB_CONFIRM: 'REINITIALIZE WORK REPORT SCHEDULER', WORK_REPORT_SCHEDULER_START_DATE: newStart }).err, /nothing to reinitialize/);
  for (let i = 0; i < 20; i++) { r = await G.tick(); if (!r.enqueued && !r.runs.length) break; }
  const jobs3 = await prisma.$queryRawUnsafe(`${JOBS} ORDER BY "dueAt", "periodKind"`);
  assert.equal(jobs3.length, want2.length); assert(jobs3.every(j => j.epoch === 3 && j.status === 'succeeded'));
  const st3 = await SCH.readSchedulerState(prisma); assert.equal(st3.stateCoverage, st3.coverageStart);
  const status = cli(['status'], { WORK_REPORT_SCHEDULER_ENABLED: 'true', WORK_REPORT_SCHEDULER_START_DATE: newStart });
  assert.equal(status.status, 0); assert.deepEqual([status.out.state.epoch, status.out.counts.succeeded], [3, jobs3.length]);
  done();

  assert(logs.length && logs.every(l => !l.includes(secret) && !/postgres(ql)?:\/\//.test(l) && !/"rows"|"payload"/.test(l)), 'logs carry codes only');
  assert.deepEqual(unhandled, []);
  console.log(JSON.stringify({ workReportSchedulerScenarios: scenarios, actualPostgres: true, twoClients: true, productionRoutersAndRequireAuth: true, jobsFinal: jobs3.length, epochs: 3 }));
} finally {
  server.closeAllConnections(); await new Promise(r => server.close(r)); await prisma.$disconnect(); await clientB.$disconnect();
}
process.exit(0);   // the simulated crashed worker never resolves
function addSeconds(iso, s) { return new Date(Date.parse(iso) + s * 1000).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z'); }
