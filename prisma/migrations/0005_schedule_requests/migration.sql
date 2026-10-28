-- REPORTS-P2-D1a: managed schedule mode (independent of deliveryMode) and immutable schedule-change requests.
-- Additive only: existing cases keep their rows and become 'legacy' through the column default.

-- AlterTable
ALTER TABLE "cases" ADD COLUMN     "pendingScheduleRequestId" TEXT,
ADD COLUMN     "scheduleBaseline" JSONB,
ADD COLUMN     "scheduleMode" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN     "scheduleModeById" INTEGER,
ADD COLUMN     "scheduleModeByName" TEXT,
ADD COLUMN     "scheduleModeFingerprint" TEXT,
ADD COLUMN     "scheduleModeReason" TEXT,
ADD COLUMN     "scheduleModeRequestId" TEXT,
ADD COLUMN     "scheduleModeSince" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "case_schedule_requests" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "requestedById" INTEGER NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reasonCategory" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "impactFrom" DATE,
    "impactTo" DATE,
    "currentSchedule" JSONB NOT NULL,
    "proposedSchedule" JSONB NOT NULL,
    "caseUpdatedAt" TIMESTAMP(3) NOT NULL,
    "caseContentVersion" INTEGER NOT NULL,
    "assignmentSnapshot" JSONB NOT NULL,
    "decision" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedById" INTEGER,
    "decidedByName" TEXT,
    "decisionReason" TEXT,
    "decisionOperationId" TEXT,
    "decisionFingerprint" TEXT,
    "approvedSchedule" JSONB,

    CONSTRAINT "case_schedule_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "case_schedule_requests_decisionOperationId_key" ON "case_schedule_requests"("decisionOperationId");

-- CreateIndex
CREATE INDEX "case_schedule_requests_caseId_createdAt_idx" ON "case_schedule_requests"("caseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "cases_scheduleModeRequestId_key" ON "cases"("scheduleModeRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "cases_pendingScheduleRequestId_key" ON "cases"("pendingScheduleRequestId");

-- AddForeignKey
ALTER TABLE "case_schedule_requests" ADD CONSTRAINT "case_schedule_requests_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A schedule snapshot is exactly the four parent milestones {dispatchDate, copyDate, printDate, goLiveDate}:
-- dispatch/goLive are required calendar dates; copyDate/printDate are a date or JSON null (null = unknown /
-- not set, never invented). NULL input yields false (never UNKNOWN in a CHECK).
CREATE FUNCTION "design_pm_valid_schedule"(j JSONB) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(
    jsonb_typeof(j) = 'object'
    AND (SELECT count(*) FROM jsonb_object_keys(j)) = 4
    AND j ? 'dispatchDate' AND j ? 'copyDate' AND j ? 'printDate' AND j ? 'goLiveDate'
    AND jsonb_typeof(j -> 'dispatchDate') = 'string' AND (j ->> 'dispatchDate') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND jsonb_typeof(j -> 'goLiveDate') = 'string' AND (j ->> 'goLiveDate') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND (jsonb_typeof(j -> 'copyDate') = 'null'
         OR (jsonb_typeof(j -> 'copyDate') = 'string' AND (j ->> 'copyDate') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
    AND (jsonb_typeof(j -> 'printDate') = 'null'
         OR (jsonb_typeof(j -> 'printDate') = 'string' AND (j ->> 'printDate') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')),
    false)
$$;

-- Case schedule mode. Managed cases always carry who (real staff id + name), when, why, the stable
-- adoption request and the baseline observed at adoption; legacy cases carry none of it.
-- Every alternative is null-safe (explicit IS [NOT] NULL / coalesce), as in 0004.
ALTER TABLE "cases" ADD CONSTRAINT "cases_schedule_mode" CHECK ("scheduleMode" IN ('legacy', 'managed'));
ALTER TABLE "cases" ADD CONSTRAINT "cases_schedule_mode_stamp" CHECK (
  ("scheduleMode" = 'legacy' AND "scheduleModeSince" IS NULL AND "scheduleModeById" IS NULL AND "scheduleModeByName" IS NULL
     AND "scheduleModeReason" IS NULL AND "scheduleModeRequestId" IS NULL AND "scheduleModeFingerprint" IS NULL
     AND "scheduleBaseline" IS NULL AND "pendingScheduleRequestId" IS NULL)
  OR ("scheduleMode" = 'managed' AND "scheduleModeSince" IS NOT NULL AND "scheduleModeById" IS NOT NULL
     AND "scheduleModeRequestId" IS NOT NULL AND "scheduleModeFingerprint" IS NOT NULL AND "scheduleBaseline" IS NOT NULL
     AND char_length(btrim(coalesce("scheduleModeReason", ''))) >= 2
     AND char_length(btrim(coalesce("scheduleModeByName", ''))) >= 1
     AND "scheduleModeRequestId" ~ '^[A-Za-z0-9_-]{8,100}$' AND "scheduleModeFingerprint" ~ '^[0-9a-f]{64}$'
     AND coalesce(jsonb_typeof("scheduleBaseline") = 'object' AND "scheduleBaseline" ->> 'source' = 'observed_at_adoption'
                  AND jsonb_typeof("scheduleBaseline" -> 'observedAt') = 'string'
                  AND "design_pm_valid_schedule"(("scheduleBaseline" - 'observedAt') - 'source'), false))
);

-- Request values mirrored by the API.
ALTER TABLE "case_schedule_requests" ADD CONSTRAINT "case_schedule_requests_id_format" CHECK ("id" ~ '^[A-Za-z0-9_-]{8,100}$');
ALTER TABLE "case_schedule_requests" ADD CONSTRAINT "case_schedule_requests_fingerprint" CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$');
ALTER TABLE "case_schedule_requests" ADD CONSTRAINT "case_schedule_requests_requester" CHECK (char_length(btrim("requestedByName")) >= 1 AND "caseContentVersion" >= 0);
ALTER TABLE "case_schedule_requests" ADD CONSTRAINT "case_schedule_requests_reason" CHECK (
  "reasonCategory" IN ('requester_change', 'material_delay', 'approval_delay', 'scope_change', 'internal_capacity', 'external_vendor', 'date_correction', 'other')
  AND char_length(btrim("reason")) BETWEEN 2 AND 500
);
ALTER TABLE "case_schedule_requests" ADD CONSTRAINT "case_schedule_requests_impact" CHECK (
  ("impactFrom" IS NULL AND "impactTo" IS NULL) OR ("impactFrom" IS NOT NULL AND "impactTo" IS NOT NULL AND "impactFrom" <= "impactTo")
);
ALTER TABLE "case_schedule_requests" ADD CONSTRAINT "case_schedule_requests_schedules" CHECK (
  "design_pm_valid_schedule"("currentSchedule") AND "design_pm_valid_schedule"("proposedSchedule")
  AND "currentSchedule" IS DISTINCT FROM "proposedSchedule"
  AND coalesce(jsonb_typeof("assignmentSnapshot") = 'object' AND jsonb_typeof("assignmentSnapshot" -> 'designerId') = 'number'
               AND jsonb_typeof("assignmentSnapshot" -> 'collaboratorIds') = 'array', false)
);
ALTER TABLE "case_schedule_requests" ADD CONSTRAINT "case_schedule_requests_decision" CHECK (
  ("decision" IS NULL AND "decidedAt" IS NULL AND "decidedById" IS NULL AND "decidedByName" IS NULL AND "decisionReason" IS NULL
     AND "decisionOperationId" IS NULL AND "decisionFingerprint" IS NULL AND "approvedSchedule" IS NULL)
  OR ("decision" IS NOT NULL AND "decidedAt" IS NOT NULL AND "decidedById" IS NOT NULL
     AND "decisionOperationId" IS NOT NULL AND "decisionFingerprint" IS NOT NULL
     AND "decision" IN ('approved', 'rejected', 'withdrawn', 'invalidated')
     AND char_length(btrim(coalesce("decidedByName", ''))) >= 1 AND "decisionOperationId" ~ '^[A-Za-z0-9_:-]{8,120}$'
     AND "decisionFingerprint" ~ '^[0-9a-f]{64}$'
     AND ("decision" = 'approved' OR char_length(btrim(coalesce("decisionReason", ''))) >= 2)
     AND (("decision" = 'approved' AND "approvedSchedule" IS NOT NULL AND "design_pm_valid_schedule"("approvedSchedule")
           AND "approvedSchedule" = "proposedSchedule")
          OR ("decision" <> 'approved' AND "approvedSchedule" IS NULL)))
);

-- At most one undecided request per case, enforced by the database itself (the UNIQUE on the case pointer
-- only prevents pointer reuse; this index prevents a second pending row for the same case).
CREATE UNIQUE INDEX "case_schedule_requests_one_pending" ON "case_schedule_requests"("caseId") WHERE "decision" IS NULL;

-- Requests are append-only: the only permitted UPDATE is the one-time decision stamp.
-- DELETE/TRUNCATE follow the same transaction-local purge switch as the delivery evidence (full resets only).
CREATE FUNCTION "protect_case_schedule_requests"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF coalesce(current_setting('design_pm.allow_delivery_purge', true), '') = 'on' THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'case_schedule_requests is append-only history' USING ERRCODE = '23514';
  ELSIF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('design_pm.allow_delivery_purge', true), '') = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'case_schedule_requests is append-only history' USING ERRCODE = '23514';
  END IF;
  IF OLD."decidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'decided schedule requests are immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."id", NEW."caseId", NEW."requestFingerprint", NEW."requestedById", NEW."requestedByName", NEW."createdAt",
         NEW."reasonCategory", NEW."reason", NEW."impactFrom", NEW."impactTo", NEW."currentSchedule", NEW."proposedSchedule",
         NEW."caseUpdatedAt", NEW."caseContentVersion", NEW."assignmentSnapshot")
     IS DISTINCT FROM
     ROW(OLD."id", OLD."caseId", OLD."requestFingerprint", OLD."requestedById", OLD."requestedByName", OLD."createdAt",
         OLD."reasonCategory", OLD."reason", OLD."impactFrom", OLD."impactTo", OLD."currentSchedule", OLD."proposedSchedule",
         OLD."caseUpdatedAt", OLD."caseContentVersion", OLD."assignmentSnapshot") THEN
    RAISE EXCEPTION 'schedule request content is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "case_schedule_requests_append_only" BEFORE UPDATE OR DELETE ON "case_schedule_requests"
FOR EACH ROW EXECUTE FUNCTION "protect_case_schedule_requests"();
CREATE TRIGGER "case_schedule_requests_no_truncate" BEFORE TRUNCATE ON "case_schedule_requests"
FOR EACH STATEMENT EXECUTE FUNCTION "protect_case_schedule_requests"();

-- Managed schedule mode is one-way; its adoption stamp and observed baseline cannot be rewritten.
CREATE FUNCTION "protect_case_schedule_mode"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."scheduleMode" = 'managed' AND (
       NEW."scheduleMode" IS DISTINCT FROM OLD."scheduleMode"
       OR NEW."scheduleModeSince" IS DISTINCT FROM OLD."scheduleModeSince"
       OR NEW."scheduleModeById" IS DISTINCT FROM OLD."scheduleModeById"
       OR NEW."scheduleModeByName" IS DISTINCT FROM OLD."scheduleModeByName"
       OR NEW."scheduleModeReason" IS DISTINCT FROM OLD."scheduleModeReason"
       OR NEW."scheduleModeRequestId" IS DISTINCT FROM OLD."scheduleModeRequestId"
       OR NEW."scheduleModeFingerprint" IS DISTINCT FROM OLD."scheduleModeFingerprint"
       OR NEW."scheduleBaseline" IS DISTINCT FROM OLD."scheduleBaseline") THEN
    RAISE EXCEPTION 'managed schedule mode is one-way and its adoption stamp is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "cases_schedule_mode_one_way" BEFORE UPDATE ON "cases"
FOR EACH ROW EXECUTE FUNCTION "protect_case_schedule_mode"();
