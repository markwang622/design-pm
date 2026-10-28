// REPORTS-P3-E3: automatic initial work reports (week / month / quarter) — an in-process worker of the Node server.
//
// Off unless WORK_REPORT_SCHEDULER_ENABLED=true (validated in src/lib/runtimeConfig.js); importing this module starts
// nothing. When enabled: one tick shortly after listen, then every minute. Each tick, by the DB clock only (never the host
// time zone):
//   1. first enabled tick on a database: persist the state row (configured start date, DB-clock activation, the current
//      report_source_coverage.coverageStart as the epoch). Later ticks never rewrite it unless something changes;
//   2. refuse to run on a start-date mismatch, a paused state, a source coverage that differs from the epoch (full reset,
//      another database) or a DB clock earlier than the scheduler's own last writes — the last two pause the state once;
//   3. enqueue due periods (Taipei 00:05 of endDateExclusive = C + 5 minutes; only periods due on/after the start date,
//      at most ENQUEUE_LIMIT per kind per tick, oldest first) and advance the per-kind cursor in the SAME transaction —
//      the cursor never moves past a period whose job row is not durable. An idle tick writes nothing;
//   4. claim up to RUNS_PER_TICK jobs, one at a time: a single committed UPDATE … FOR UPDATE SKIP LOCKED sets a fresh
//      lease token (so no transaction of ours older than K stays open when settle(K) runs), then
//      workReports.generateScheduled re-checks the lease inside the publication transaction. Results are written back only
//      while the same lease token still holds the job (a stale worker never overwrites the new owner).
// Transient failures retry the same job/key with bounded exponential backoff; anything else (clock / coverage / payload /
// fingerprint problems, exhausted retries) is blocked with a code — never reported as success. Logs carry job identity,
// outcome and error codes only (no env values, credentials or report payloads). No route here publishes anything.
import crypto from 'node:crypto';
import os from 'node:os';
import { prisma } from '../lib/db.js';
import { PERIOD_KINDS, periodContaining, periodFromStart, periodInstants, nextPeriod, parseDateOnly } from '../lib/reportPeriods.js';
import { workReports as defaultService, WorkReportError, scheduledIdempotencyKey } from '../lib/workReports.js';
import { RULES_VERSION } from '../lib/workReportPayload.js';

export const DUE_DELAY_MINUTES = 5;
export const TICK_MS = 60 * 1000;
export const FIRST_TICK_MS = 15 * 1000;
export const LEASE_MS = 10 * 60 * 1000;        // well above one publication (60 s transaction + bounded settle)
export const MAX_ATTEMPTS = 6;
export const ENQUEUE_LIMIT = 12;               // per kind per tick (bounded catch-up after downtime)
export const RUNS_PER_TICK = 3;
export const START_WINDOW_DAYS = 366;          // the persisted lower bound must be within a year of activation
const ISO_US = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const ts = col => `to_char(${col} AT TIME ZONE 'UTC', '${ISO_US}')`;
const day = col => `to_char(${col}, 'YYYY-MM-DD')`;
const CURSOR = { week: 'weekCursor', month: 'monthCursor', quarter: 'quarterCursor' };
const LOG = '[work-report-scheduler]';

// ── pure planning ──────────────────────────────────────────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
function addMinutes(isoUs, minutes) {
  const t = new Date(Date.parse(isoUs) + minutes * 60000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}.000000Z`;
}
// Taipei 00:05 of endDateExclusive (C is Taipei 00:00 — the report itself still uses C, never the run time).
export const dueInstant = period => addMinutes(periodInstants(period).cutoffInstant, DUE_DELAY_MINUTES);
function shiftDay(dateStr, days) { const { y, m, d } = parseDateOnly(dateStr); const t = new Date(Date.UTC(y, m - 1, d + days)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; }
// The first period due on/after startDate (its endDateExclusive ≥ startDate).
export const firstScheduledPeriod = (kind, startDate) => periodContaining(kind, shiftDay(startDate, -1));
// Periods of one kind that are due at `now` (microsecond ISO from the DB clock), starting after the cursor (the
// endDateExclusive of the last enqueued period) or at the first scheduled period; at most `limit`, oldest first.
export function planDue(kind, { cursor, startDate, now, limit = ENQUEUE_LIMIT }) {
  let p = cursor ? periodFromStart(kind, cursor) : firstScheduledPeriod(kind, startDate);
  const out = [];
  while (out.length < limit && dueInstant(p) <= now) { out.push(p); p = nextPeriod(p); }
  return out;
}
// The next period (not yet enqueued) of a kind and its due instant.
export function nextDue(kind, { cursor, startDate }) {
  const p = cursor ? periodFromStart(kind, cursor) : firstScheduledPeriod(kind, startDate);
  return { kind, startDate: p.startDate, endDateExclusive: p.endDateExclusive, label: p.label, dueAt: dueInstant(p) };
}
export function startDateInWindow(startDate, today) {
  const diff = (Date.parse(startDate + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000;
  return Math.abs(diff) <= START_WINDOW_DAYS;
}
// 1, 2, 4, 8, 16 … minutes, capped at one hour.
export const backoffMs = attempt => Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** Math.max(0, attempt - 1));

const TRANSIENT = new Set(['source_not_settled', 'report_timeout', 'report_conflict', 'period_not_ended', 'db_unavailable', 'unexpected_error']);
const DB_UNAVAILABLE = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028']);
// → { kind: 'transient' | 'blocked' | 'lease_lost', code }
export function classifyFailure(e) {
  if (e instanceof WorkReportError) {
    if (e.code === 'lease_lost') return { kind: 'lease_lost', code: e.code };
    return { kind: TRANSIENT.has(e.code) ? 'transient' : 'blocked', code: /^[a-z0-9_]{2,50}$/.test(e.code) ? e.code : 'report_error' };
  }
  if (DB_UNAVAILABLE.has(e?.code) || /PrismaClientInitializationError|PrismaClientRustPanicError/.test(e?.name || '')
    || /ECONNREFUSED|ECONNRESET|Connection terminated|Can't reach database/i.test(String(e?.message || ''))) return { kind: 'transient', code: 'db_unavailable' };
  return { kind: 'transient', code: 'unexpected_error' };
}
const safeCode = e => (e instanceof WorkReportError ? e.code : e?.code && /^[A-Za-z0-9_]{2,20}$/.test(e.code) ? e.code : 'unexpected_error');

// ── database ───────────────────────────────────────────────────────────────────────────────────────────────────
const STATE_SQL = `SELECT ${ts('clock_timestamp()')} AS "now", to_char((clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date, 'YYYY-MM-DD') AS "today",
    ${ts('c."coverageStart"')} AS "coverageStart", s."epoch", ${day('s."startDate"')} AS "startDate", ${ts('s."activatedAt"')} AS "activatedAt",
    ${ts('s."coverageStart"')} AS "stateCoverage", ${day('s."weekCursor"')} AS "weekCursor", ${day('s."monthCursor"')} AS "monthCursor",
    ${day('s."quarterCursor"')} AS "quarterCursor", s."status", s."pausedReason", ${ts('s."updatedAt"')} AS "stateUpdatedAt",
    (SELECT ${ts('max(j."updatedAt")')} FROM "report_job_runs" j) AS "lastJobWrite"
  FROM (SELECT 1) one LEFT JOIN "report_source_coverage" c ON c."id" = 1 LEFT JOIN "report_scheduler_state" s ON s."id" = 1`;
const jobColumns = (a = '') => `${a}"id", ${a}"epoch", ${a}"periodKind", ${day(a + '"startDate"')} AS "startDate", ${day(a + '"endDateExclusive"')} AS "endDateExclusive",
  ${a}"rulesVersion", ${ts(a + '"dueAt"')} AS "dueAt", ${a}"idempotencyKey", ${a}"status", ${a}"attemptCount", ${a}"maxAttempts", ${ts(a + '"nextAttemptAt"')} AS "nextAttemptAt",
  ${a}"leaseToken", ${a}"leaseOwner", ${ts(a + '"leaseUntil"')} AS "leaseUntil", ${a}"snapshotId", ${a}"lastErrorCode", ${a}"retryCount", ${a}"lastRetryReason",
  ${ts(a + '"createdAt"')} AS "createdAt", ${ts(a + '"updatedAt"')} AS "updatedAt", ${ts(a + '"finishedAt"')} AS "finishedAt"`;
export const JOB_COLUMNS = jobColumns();
export const readSchedulerState = async db => (await db.$queryRawUnsafe(STATE_SQL))[0];

// Read-only status for the admin page and the maintenance CLI.
export async function readSchedulerStatus(db, config) {
  const st = await readSchedulerState(db);
  const initialized = st.epoch != null;
  const base = { enabled: !!config.enabled, configuredStartDate: config.startDate ?? null, now: st.now, rulesVersion: RULES_VERSION, initialized };
  if (!initialized) return { ...base, state: null, next: [], counts: {}, recent: [] };
  const counts = Object.fromEntries((await db.$queryRawUnsafe(`SELECT "status", count(*)::int AS n FROM "report_job_runs" WHERE "epoch" = $1 GROUP BY "status"`, st.epoch)).map(r => [r.status, r.n]));
  const recent = await db.$queryRawUnsafe(`SELECT ${JOB_COLUMNS} FROM "report_job_runs" ORDER BY "dueAt" DESC, "periodKind" LIMIT 8`);
  const attention = await db.$queryRawUnsafe(`SELECT ${JOB_COLUMNS} FROM "report_job_runs" WHERE "epoch" = $1 AND ("status" = 'blocked' OR ("status" = 'pending' AND "attemptCount" > 0))
    ORDER BY "dueAt", "periodKind" LIMIT 8`, st.epoch);
  const label = j => periodFromStart(j.periodKind, j.startDate).label;
  const job = j => ({ id: j.id, periodKind: j.periodKind, startDate: j.startDate, label: label(j), dueAt: j.dueAt, status: j.status, attemptCount: j.attemptCount,
    maxAttempts: j.maxAttempts, nextAttemptAt: j.status === 'pending' ? j.nextAttemptAt : null, lastErrorCode: j.lastErrorCode, snapshotId: j.snapshotId, finishedAt: j.finishedAt,
    epoch: j.epoch });
  return { ...base, state: { status: st.status, pausedReason: st.pausedReason, epoch: st.epoch, startDate: st.startDate, activatedAt: st.activatedAt,
      startDateMatches: st.startDate === config.startDate, coverageMatches: st.stateCoverage === st.coverageStart },
    next: PERIOD_KINDS.map(kind => nextDue(kind, { cursor: st[CURSOR[kind]], startDate: st.startDate })), counts, recent: recent.map(job), attention: attention.map(job) };
}

export function createWorkReportScheduler({ db = prisma, service = defaultService, config, owner = `${os.hostname().replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'host'}:${process.pid}`,
  leaseMs = LEASE_MS, maxAttempts = MAX_ATTEMPTS, runsPerTick = RUNS_PER_TICK, enqueueLimit = ENQUEUE_LIMIT, backoff = backoffMs, log = console } = {}) {
  if (!config || typeof config.enabled !== 'boolean') throw new Error('scheduler config required');
  const leaseOwner = String(owner).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80) || 'worker';
  let running = false, timer = null, boot = null, last = null, lastNotice = null;
  const notice = msg => { if (msg !== lastNotice) { lastNotice = msg; log.warn(`${LOG} ${msg}`); } };   // repeated idle conditions log once

  async function pause(st, reason) {
    const n = await db.$executeRawUnsafe(`UPDATE "report_scheduler_state" SET "status" = 'paused', "pausedReason" = $1 WHERE "id" = 1 AND "status" = 'active' AND "epoch" = $2`, reason, st.epoch);
    if (n) log.warn(`${LOG} paused epoch=${st.epoch} reason=${reason} (reinitialize explicitly with scripts/work-report-jobs.mjs)`);
    return { state: 'paused', reason };
  }

  async function enqueue(st, due) {
    return db.$transaction(async tx => {
      const [s] = await tx.$queryRawUnsafe(`SELECT "epoch", "status", ${day('"weekCursor"')} AS "weekCursor", ${day('"monthCursor"')} AS "monthCursor",
        ${day('"quarterCursor"')} AS "quarterCursor" FROM "report_scheduler_state" WHERE "id" = 1 FOR UPDATE`);
      if (!s || s.epoch !== st.epoch || s.status !== 'active' || PERIOD_KINDS.some(k => s[CURSOR[k]] !== st[CURSOR[k]])) return 0;   // another worker moved first
      let inserted = 0;
      for (const p of due) {
        inserted += await tx.$executeRawUnsafe(`INSERT INTO "report_job_runs" ("id", "epoch", "periodKind", "startDate", "endDateExclusive", "rulesVersion", "dueAt",
            "idempotencyKey", "status", "attemptCount", "maxAttempts", "nextAttemptAt", "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4::date, $5::date, $6, $7::timestamptz, $8, 'pending', 0, $9, $7::timestamptz, clock_timestamp(), clock_timestamp()) ON CONFLICT DO NOTHING`,
          'wj_' + crypto.randomUUID(), st.epoch, p.kind, p.startDate, p.endDateExclusive, RULES_VERSION, dueInstant(p), scheduledIdempotencyKey(p), maxAttempts);
      }
      const cursor = Object.fromEntries(PERIOD_KINDS.map(k => [k, st[CURSOR[k]]]));
      for (const p of due) cursor[p.kind] = p.endDateExclusive;
      await tx.$executeRawUnsafe(`UPDATE "report_scheduler_state" SET "weekCursor" = $1::date, "monthCursor" = $2::date, "quarterCursor" = $3::date WHERE "id" = 1`,
        cursor.week, cursor.month, cursor.quarter);
      return inserted;
    }, { timeout: 15000 });
  }

  async function claim(epoch) {
    // expired leases whose attempts are used up: blocked (writes nothing when there are none)
    await db.$executeRawUnsafe(`UPDATE "report_job_runs" SET "status" = 'blocked', "lastErrorCode" = 'exhausted_lease_expired', "leaseToken" = NULL, "leaseOwner" = NULL,
      "leaseUntil" = NULL, "finishedAt" = clock_timestamp() WHERE "epoch" = $1 AND "status" = 'running' AND "leaseUntil" <= clock_timestamp() AND "attemptCount" >= "maxAttempts"`, epoch);
    const [job] = await db.$queryRawUnsafe(`WITH c AS (
        SELECT "id" FROM "report_job_runs" WHERE "epoch" = $1 AND "attemptCount" < "maxAttempts"
          AND (("status" = 'pending' AND "nextAttemptAt" <= clock_timestamp()) OR ("status" = 'running' AND "leaseUntil" <= clock_timestamp()))
          AND EXISTS (SELECT 1 FROM "report_scheduler_state" s WHERE s."id" = 1 AND s."status" = 'active' AND s."epoch" = $1)
        ORDER BY "dueAt", "periodKind" LIMIT 1 FOR UPDATE SKIP LOCKED)
      UPDATE "report_job_runs" j SET "status" = 'running', "leaseToken" = $2, "leaseOwner" = $3, "leaseUntil" = clock_timestamp() + make_interval(secs => $4::double precision / 1000),
        "attemptCount" = j."attemptCount" + 1 FROM c WHERE j."id" = c."id" RETURNING ${jobColumns('j.')}`,
      epoch, crypto.randomUUID(), leaseOwner, leaseMs);
    return job ?? null;
  }
  const settleJob = (job, sql, ...args) => db.$executeRawUnsafe(`UPDATE "report_job_runs" SET ${sql}, "leaseToken" = NULL, "leaseOwner" = NULL, "leaseUntil" = NULL
    WHERE "id" = $1 AND "leaseToken" = $2 AND "status" = 'running'`, job.id, job.leaseToken, ...args);
  const tag = job => `${job.periodKind} ${job.startDate} attempt=${job.attemptCount}/${job.maxAttempts}`;

  async function runJob(job) {
    let result;
    try { result = await service.generateScheduled({ jobId: job.id, leaseToken: job.leaseToken }); }
    catch (e) {
      const c = classifyFailure(e);
      if (c.kind === 'lease_lost') { log.warn(`${LOG} job ${tag(job)} lease lost; nothing written`); return { id: job.id, outcome: 'lease_lost' }; }
      if (c.kind === 'transient' && job.attemptCount < job.maxAttempts) {
        const n = await settleJob(job, `"status" = 'pending', "lastErrorCode" = $3, "nextAttemptAt" = clock_timestamp() + make_interval(secs => $4::double precision / 1000)`, c.code, backoff(job.attemptCount));
        log.warn(`${LOG} job ${tag(job)} retry later code=${c.code}${n ? '' : ' (lease lost)'}`);
        return { id: job.id, outcome: 'retry', code: c.code };
      }
      const code = c.kind === 'transient' ? `exhausted_${c.code}` : c.code;
      const n = await settleJob(job, `"status" = 'blocked', "lastErrorCode" = $3, "finishedAt" = clock_timestamp()`, code);
      log.warn(`${LOG} job ${tag(job)} blocked code=${code}${n ? '' : ' (lease lost)'}`);
      return { id: job.id, outcome: 'blocked', code };
    }
    const n = await settleJob(job, `"status" = $3, "snapshotId" = $4, "lastErrorCode" = NULL, "finishedAt" = clock_timestamp()`, result.outcome, result.snapshot.id);
    log.log(`${LOG} job ${tag(job)} ${result.outcome}${result.replayed ? ' (replayed)' : ''}${n ? '' : ' (lease lost after publish; the next owner replays the same snapshot)'}`);
    return { id: job.id, outcome: n ? result.outcome : 'lease_lost', snapshotId: result.snapshot.id };
  }

  async function tickOnce() {
    let st = await readSchedulerState(db);
    if (!st.coverageStart) { notice('report source coverage missing; nothing scheduled'); return { state: 'blocked', reason: 'source_coverage_missing' }; }
    if (st.epoch == null) {
      if (!startDateInWindow(config.startDate, st.today)) { notice('WORK_REPORT_SCHEDULER_START_DATE is more than a year from today; nothing scheduled'); return { state: 'blocked', reason: 'start_date_out_of_range' }; }
      const n = await db.$executeRawUnsafe(`INSERT INTO "report_scheduler_state" ("id", "epoch", "startDate", "activatedAt", "coverageStart", "status", "updatedAt")
        SELECT 1, 1, $1::date, clock_timestamp(), c."coverageStart", 'active', clock_timestamp() FROM "report_source_coverage" c WHERE c."id" = 1 ON CONFLICT ("id") DO NOTHING`, config.startDate);
      if (n) log.log(`${LOG} activated epoch=1 start=${config.startDate}`);
      st = await readSchedulerState(db);
    }
    if (st.startDate !== config.startDate) { notice(`configured start date differs from the persisted start date ${st.startDate}; nothing scheduled`); return { state: 'blocked', reason: 'start_date_mismatch' }; }
    if (st.status !== 'active') { notice(`paused reason=${st.pausedReason}`); return { state: 'paused', reason: st.pausedReason }; }
    if (st.now < st.activatedAt || st.now < st.stateUpdatedAt || (st.lastJobWrite && st.now < st.lastJobWrite)) return pause(st, 'clock_regressed');
    if (st.stateCoverage !== st.coverageStart) return pause(st, 'coverage_epoch_changed');
    lastNotice = null;
    const due = PERIOD_KINDS.flatMap(kind => planDue(kind, { cursor: st[CURSOR[kind]], startDate: st.startDate, now: st.now, limit: enqueueLimit }));
    const enqueued = due.length ? await enqueue(st, due) : 0;
    if (enqueued) log.log(`${LOG} enqueued ${enqueued} job(s)`);
    const runs = [];
    for (let i = 0; i < runsPerTick; i++) {
      const job = await claim(st.epoch);
      if (!job) break;
      runs.push(await runJob(job));
    }
    return { state: 'active', epoch: st.epoch, enqueued, runs };
  }

  async function tick() {
    if (!config.enabled) return { state: 'disabled' };
    if (running) return { state: 'busy' };
    running = true;
    try { last = await tickOnce(); return last; }
    catch (e) { last = { state: 'error', code: safeCode(e) }; log.warn(`${LOG} tick failed code=${last.code}`); return last; }   // never crashes the server
    finally { running = false; }
  }

  return {
    tick,
    lastTick: () => last,
    start() {
      if (!config.enabled) { log.log(`${LOG} disabled (WORK_REPORT_SCHEDULER_ENABLED is not true)`); return false; }
      if (timer) return true;
      boot = setTimeout(tick, FIRST_TICK_MS); boot.unref?.();
      timer = setInterval(tick, TICK_MS); timer.unref?.();
      log.log(`${LOG} started (every ${TICK_MS / 1000}s, start=${config.startDate})`);
      return true;
    },
    stop() { clearTimeout(boot); clearInterval(timer); boot = timer = null; },
  };
}

export function startWorkReportScheduler(config) {
  try { const s = createWorkReportScheduler({ config }); s.start(); return s; }
  catch (e) { console.warn(`${LOG} not started code=${safeCode(e)}`); return null; }
}
