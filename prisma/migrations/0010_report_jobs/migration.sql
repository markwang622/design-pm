-- REPORTS-P3-E3: scheduled initial work reports — durable job runs + one scheduler state row. Additive only: 0001–0009,
-- business rows, report source events/coverage and report snapshots are not changed. Both tables start empty; nothing is
-- scheduled until the server runs with WORK_REPORT_SCHEDULER_ENABLED=true (the first enabled tick writes the state row
-- with the configured start date, the DB clock and the current report_source_coverage.coverageStart as its epoch).
-- A job is one logical (periodKind, startDate, rulesVersion) initial version: a stable idempotency key, status, attempts,
-- next attempt, lease (token/owner/until), the snapshot it produced or found, and the last error code. Timestamps are the
-- DB clock (triggers), never caller-supplied. A finished job (succeeded / skipped_existing) is final; identity columns
-- never change; DELETE only inside the explicit full purge (design_pm.allow_report_purge = on); TRUNCATE always refused.
-- SQL-only behaviour (not modelled in schema.prisma): CHECKs, the snapshot foreign key and the triggers below.
BEGIN;

CREATE TABLE "report_scheduler_state" (
    "id" INTEGER NOT NULL,
    "epoch" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "activatedAt" TIMESTAMPTZ(6) NOT NULL,
    "coverageStart" TIMESTAMPTZ(6) NOT NULL,
    "weekCursor" DATE,
    "monthCursor" DATE,
    "quarterCursor" DATE,
    "status" TEXT NOT NULL,
    "pausedReason" TEXT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "report_scheduler_state_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "report_job_runs" (
    "id" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "periodKind" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDateExclusive" DATE NOT NULL,
    "rulesVersion" TEXT NOT NULL,
    "dueAt" TIMESTAMPTZ(6) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL,
    "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL,
    "leaseToken" TEXT,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMPTZ(6),
    "snapshotId" TEXT,
    "lastErrorCode" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastRetryReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "finishedAt" TIMESTAMPTZ(6),

    CONSTRAINT "report_job_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "report_job_runs_idempotencyKey_key" ON "report_job_runs"("idempotencyKey");
CREATE UNIQUE INDEX "report_job_runs_periodKind_startDate_rulesVersion_key" ON "report_job_runs"("periodKind", "startDate", "rulesVersion");
CREATE INDEX "report_job_runs_status_nextAttemptAt_idx" ON "report_job_runs"("status", "nextAttemptAt");

-- A finished job links to a real snapshot. NO ACTION: a snapshot cannot be purged while a job still points at it
-- (the full reset deletes job runs first, in the same purge transaction).
ALTER TABLE "report_job_runs" ADD CONSTRAINT "report_job_runs_snapshot_fkey" FOREIGN KEY ("snapshotId") REFERENCES "report_snapshots"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "report_scheduler_state" ADD CONSTRAINT "report_scheduler_state_check" CHECK ((
  "id" = 1 AND "epoch" >= 1 AND "startDate" >= DATE '2000-01-01' AND "startDate" < DATE '2101-01-01'
  AND "status" IN ('active', 'paused') AND (("status" = 'paused') = ("pausedReason" IS NOT NULL))
  AND ("pausedReason" IS NULL OR "pausedReason" ~ '^[a-z_]{3,60}$')
  AND ("weekCursor" IS NULL OR extract(isodow FROM "weekCursor") = 1)
  AND ("monthCursor" IS NULL OR extract(day FROM "monthCursor") = 1)
  AND ("quarterCursor" IS NULL OR (extract(day FROM "quarterCursor") = 1 AND extract(month FROM "quarterCursor") IN (1, 4, 7, 10)))) IS TRUE);

ALTER TABLE "report_job_runs" ADD CONSTRAINT "report_job_runs_id_check" CHECK ("id" ~ '^wj_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
-- Same alignment as report_snapshots; due = Taipei 00:05 of endDateExclusive (C + 5 minutes).
ALTER TABLE "report_job_runs" ADD CONSTRAINT "report_job_runs_period_check" CHECK ((
  "startDate" >= DATE '2000-01-01' AND "endDateExclusive" <= DATE '2101-01-01' AND "epoch" >= 1 AND (
    ("periodKind" = 'week' AND extract(isodow FROM "startDate") = 1 AND "endDateExclusive" = "startDate" + 7)
    OR ("periodKind" = 'month' AND extract(day FROM "startDate") = 1 AND "endDateExclusive" = ("startDate" + interval '1 month')::date)
    OR ("periodKind" = 'quarter' AND extract(day FROM "startDate") = 1 AND extract(month FROM "startDate") IN (1, 4, 7, 10)
        AND "endDateExclusive" = ("startDate" + interval '3 months')::date))
  AND "dueAt" = (("endDateExclusive"::timestamp - interval '8 hours' + interval '5 minutes') AT TIME ZONE 'UTC')
  AND "rulesVersion" ~ '^[a-z0-9.-]{1,40}$' AND "idempotencyKey" ~ '^sched-(week|month|quarter)-[0-9]{8}-[0-9a-f]{12}$') IS TRUE);
ALTER TABLE "report_job_runs" ADD CONSTRAINT "report_job_runs_state_check" CHECK ((
  "status" IN ('pending', 'running', 'succeeded', 'skipped_existing', 'blocked')
  AND ("leaseToken" IS NULL) = ("leaseOwner" IS NULL) AND ("leaseToken" IS NULL) = ("leaseUntil" IS NULL)
  AND (("status" = 'running') = ("leaseToken" IS NOT NULL))
  AND ("leaseToken" IS NULL OR "leaseToken" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  AND ("leaseOwner" IS NULL OR "leaseOwner" ~ '^[A-Za-z0-9_.:-]{1,80}$')
  AND (("status" IN ('succeeded', 'skipped_existing')) = ("snapshotId" IS NOT NULL))
  AND (("status" IN ('succeeded', 'skipped_existing', 'blocked')) = ("finishedAt" IS NOT NULL))
  AND ("status" <> 'blocked' OR "lastErrorCode" IS NOT NULL)
  AND ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[a-z0-9_]{2,60}$')
  AND "maxAttempts" BETWEEN 1 AND 20 AND "attemptCount" BETWEEN 0 AND "maxAttempts" AND "retryCount" >= 0
  AND ("lastRetryReason" IS NULL OR length(btrim("lastRetryReason")) BETWEEN 2 AND 500)) IS TRUE);

CREATE FUNCTION "report_job_runs_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := clock_timestamp(); NEW."updatedAt" := NEW."createdAt";
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD."status" IN ('succeeded', 'skipped_existing') THEN
      RAISE EXCEPTION 'a finished report job is final' USING ERRCODE = '23514';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."periodKind" IS DISTINCT FROM OLD."periodKind" OR NEW."startDate" IS DISTINCT FROM OLD."startDate"
       OR NEW."endDateExclusive" IS DISTINCT FROM OLD."endDateExclusive" OR NEW."rulesVersion" IS DISTINCT FROM OLD."rulesVersion"
       OR NEW."dueAt" IS DISTINCT FROM OLD."dueAt" OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'report job identity is immutable' USING ERRCODE = '23514';
    END IF;
    NEW."updatedAt" := clock_timestamp();
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('design_pm.allow_report_purge', true), '') = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'report job runs are kept (delete only in an explicit full purge)' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'report job runs cannot be truncated' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "report_job_runs_guarded" BEFORE INSERT OR UPDATE OR DELETE ON "report_job_runs"
FOR EACH ROW EXECUTE FUNCTION "report_job_runs_guard"();
CREATE TRIGGER "report_job_runs_no_truncate" BEFORE TRUNCATE ON "report_job_runs"
FOR EACH STATEMENT EXECUTE FUNCTION "report_job_runs_guard"();

CREATE FUNCTION "report_scheduler_state_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    NEW."updatedAt" := clock_timestamp();
    IF TG_OP = 'INSERT' THEN NEW."activatedAt" := NEW."updatedAt"; END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('design_pm.allow_report_purge', true), '') = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'report scheduler state is kept (delete only in an explicit full purge)' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'report scheduler state cannot be truncated' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "report_scheduler_state_guarded" BEFORE INSERT OR UPDATE OR DELETE ON "report_scheduler_state"
FOR EACH ROW EXECUTE FUNCTION "report_scheduler_state_guard"();
CREATE TRIGGER "report_scheduler_state_no_truncate" BEFORE TRUNCATE ON "report_scheduler_state"
FOR EACH STATEMENT EXECUTE FUNCTION "report_scheduler_state_guard"();

COMMIT;
