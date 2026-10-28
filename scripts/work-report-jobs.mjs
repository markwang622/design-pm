// REPORTS-P3-E3: bounded maintenance commands for scheduled work-report jobs. Never publishes a report, never accepts
// an actor, a cutoff C or a knowledge cutoff K, and never creates a job: the running server's scheduler does the work.
//   status                                           read-only JSON (state, next due periods, counts, attention list)
//   retry <job-id> --reason "<具體原因>"              one blocked job of the current epoch → pending again (same key)
//   reinit --start-date YYYY-MM-DD --reason "<原因>"  after a paused state (coverage epoch changed, clock regressed) or an
//                                                     intentional start-date change: new epoch, cursors restart, unfinished
//                                                     jobs re-homed to pending (finished jobs keep their snapshots)
// Writes require WORK_REPORT_JOB_CONFIRM ('RETRY WORK REPORT JOB' / 'REINITIALIZE WORK REPORT SCHEDULER'). Output never
// contains the connection URL or report payloads.
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { validatePostgresUrl, validateWorkReportScheduler } from '../src/lib/runtimeConfig.js';
import { reasonProblem } from '../src/lib/scheduleWorkflow.js';
import { readSchedulerStatus, startDateInWindow } from '../src/services/workReportScheduler.js';

const JOB_ID = /^wj_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function fail(message) { throw new Error(message); }
function option(args, name) { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; if (v === undefined || v.startsWith('--')) fail(`${name} needs a value`); return v; }
function reasonOf(args) {
  const reason = option(args, '--reason'); if (reason === undefined) fail('--reason "<具體原因>" is required');
  const problem = reasonProblem(reason); if (problem) fail(`reason: ${problem}`);
  return reason.trim();
}
function confirm(expected) { if (process.env.WORK_REPORT_JOB_CONFIRM !== expected) fail(`set WORK_REPORT_JOB_CONFIRM='${expected}' to confirm this write`); }

export async function status(db, config) { return { operation: 'work-report-jobs-status', ...(await readSchedulerStatus(db, config)) }; }

export async function retry(db, jobId, reason) {
  if (!JOB_ID.test(jobId || '')) fail('Provide one existing job id (wj_…) from the status output');
  return db.$transaction(async tx => {
    const [s] = await tx.$queryRawUnsafe(`SELECT "epoch", "status" FROM "report_scheduler_state" WHERE "id" = 1 FOR UPDATE`);
    if (!s) fail('The scheduler has never been enabled on this database');
    if (s.status !== 'active') fail('The scheduler is paused; reinitialize it first');
    const [j] = await tx.$queryRawUnsafe(`SELECT "id", "epoch", "status", "lastErrorCode" FROM "report_job_runs" WHERE "id" = $1 FOR UPDATE`, jobId);
    if (!j) fail('No such job');
    if (j.epoch !== s.epoch) fail('The job belongs to an earlier epoch');
    if (j.status !== 'blocked') fail(`Only a blocked job can be retried (this one is ${j.status})`);
    await tx.$executeRawUnsafe(`UPDATE "report_job_runs" SET "status" = 'pending', "attemptCount" = 0, "nextAttemptAt" = clock_timestamp(), "finishedAt" = NULL,
      "retryCount" = "retryCount" + 1, "lastRetryReason" = $2 WHERE "id" = $1`, jobId, reason);
    return { operation: 'work-report-jobs-retry', jobId, previousErrorCode: j.lastErrorCode, status: 'pending', sameIdempotencyKey: true };
  });
}

export async function reinit(db, startDate, reason, configuredStartDate) {
  const checked = validateWorkReportScheduler({ WORK_REPORT_SCHEDULER_START_DATE: startDate }).startDate;
  if (!checked) fail('--start-date YYYY-MM-DD is required');
  if (configuredStartDate && configuredStartDate !== checked) fail('--start-date must equal the WORK_REPORT_SCHEDULER_START_DATE the server runs with');
  return db.$transaction(async tx => {
    const [s] = await tx.$queryRawUnsafe(`SELECT s."epoch", s."status", to_char(s."startDate", 'YYYY-MM-DD') AS "startDate", (s."coverageStart" = c."coverageStart") AS "coverageSame",
        to_char((clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date, 'YYYY-MM-DD') AS "today"
      FROM "report_scheduler_state" s LEFT JOIN "report_source_coverage" c ON c."id" = 1 WHERE s."id" = 1 FOR UPDATE OF s`);
    if (!s) fail('The scheduler has never been enabled on this database; enabling it initializes it');
    if (s.status === 'active' && s.coverageSame && s.startDate === checked) fail('The scheduler is active with this start date; nothing to reinitialize');
    if (!startDateInWindow(checked, s.today)) fail('The start date must be within a year of today');
    const [live] = await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "report_job_runs" WHERE "status" = 'running' AND "leaseUntil" > clock_timestamp()`);
    if (live.n) fail('A job is still running under a live lease; stop the servers or wait for it to finish');
    const epoch = s.epoch + 1;
    await tx.$executeRawUnsafe(`UPDATE "report_scheduler_state" SET "epoch" = $1, "startDate" = $2::date, "activatedAt" = clock_timestamp(),
      "coverageStart" = (SELECT "coverageStart" FROM "report_source_coverage" WHERE "id" = 1), "weekCursor" = NULL, "monthCursor" = NULL, "quarterCursor" = NULL,
      "status" = 'active', "pausedReason" = NULL WHERE "id" = 1`, epoch, checked);
    const rehomed = await tx.$executeRawUnsafe(`UPDATE "report_job_runs" SET "epoch" = $1, "status" = 'pending', "attemptCount" = 0, "nextAttemptAt" = clock_timestamp(),
      "leaseToken" = NULL, "leaseOwner" = NULL, "leaseUntil" = NULL, "finishedAt" = NULL, "retryCount" = "retryCount" + 1, "lastRetryReason" = $2
      WHERE "status" IN ('pending', 'running', 'blocked')`, epoch, reason);
    return { operation: 'work-report-jobs-reinit', epoch, startDate: checked, previousStatus: s.status, rehomedUnfinishedJobs: rehomed };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [command, ...args] = process.argv.slice(2);
  const db = new PrismaClient();
  try {
    validatePostgresUrl(process.env.DATABASE_URL);
    const config = validateWorkReportScheduler(process.env);
    let out;
    if (command === 'status') out = await status(db, config);
    else if (command === 'retry') { const reason = reasonOf(args); confirm('RETRY WORK REPORT JOB'); out = await retry(db, args[0], reason); }
    else if (command === 'reinit') { const reason = reasonOf(args); confirm('REINITIALIZE WORK REPORT SCHEDULER'); out = await reinit(db, option(args, '--start-date'), reason, config.startDate); }
    else fail('Usage: work-report-jobs.mjs status | retry <job-id> --reason "<原因>" | reinit --start-date YYYY-MM-DD --reason "<原因>"');
    console.log(JSON.stringify(out));
  } catch (e) {
    const message = String(e?.message || 'Operation failed');
    console.error('[work-report-jobs]', /prisma|database url|postgres/i.test(message) && !/^(The|No|Only|A job|Provide|--|set |reason)/.test(message) ? 'Database operation failed; credentials withheld' : message.replaceAll(process.env.DATABASE_URL || '__no_database_url__', '[database]'));
    process.exitCode = 1;
  } finally { await db.$disconnect(); }
}
