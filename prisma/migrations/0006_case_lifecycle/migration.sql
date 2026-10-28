-- REPORTS-P2-D1b: lifecycle-managed cases, work cycles (CaseCycle), incomplete-seal / same-ID resume requests and
-- per-cycle delivery attribution. Additive only: existing cases stay 'legacy'; existing deliveries keep cycleId NULL
-- (attribution unknown) — nothing is backfilled or re-linked.
-- SQL-only (not modelled in schema.prisma; behaviour defined here): the same-case composite FKs and their deferral,
-- CHECKs, partial unique indexes and triggers. Do not rebuild with db push / an unreviewed migrate diff.

-- AlterTable
ALTER TABLE "cases" ADD COLUMN     "currentCycleId" TEXT,
ADD COLUMN     "lifecycleMode" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN     "lifecycleModeById" INTEGER,
ADD COLUMN     "lifecycleModeByName" TEXT,
ADD COLUMN     "lifecycleModeFingerprint" TEXT,
ADD COLUMN     "lifecycleModeReason" TEXT,
ADD COLUMN     "lifecycleModeRequestId" TEXT,
ADD COLUMN     "lifecycleModeSince" TIMESTAMP(3),
ADD COLUMN     "lifecycleStatus" TEXT,
ADD COLUMN     "pendingLifecycleRequestId" TEXT;

-- AlterTable
ALTER TABLE "case_deliveries" ADD COLUMN     "cycleId" TEXT;

-- CreateTable
CREATE TABLE "case_cycles" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedById" INTEGER NOT NULL,
    "startedByName" TEXT NOT NULL,
    "startReason" TEXT NOT NULL,
    "startRequestId" TEXT NOT NULL,
    "startSnapshot" JSONB NOT NULL,
    "endedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "endedById" INTEGER,
    "endedByName" TEXT,
    "endReason" TEXT,
    "endRequestId" TEXT,
    "endSnapshot" JSONB,

    CONSTRAINT "case_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_lifecycle_requests" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "requestedById" INTEGER NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reasonCategory" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "archivePath" TEXT,
    "noFileDeclared" BOOLEAN,
    "noFileReason" TEXT,
    "snapshot" JSONB NOT NULL,
    "caseUpdatedAt" TIMESTAMP(3) NOT NULL,
    "caseContentVersion" INTEGER NOT NULL,
    "decision" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedById" INTEGER,
    "decidedByName" TEXT,
    "decisionReason" TEXT,
    "decisionOperationId" TEXT,
    "decisionFingerprint" TEXT,
    "resultCycleId" TEXT,

    CONSTRAINT "case_lifecycle_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "case_cycles_caseId_sequence_key" ON "case_cycles"("caseId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "case_cycles_caseId_id_key" ON "case_cycles"("caseId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "case_lifecycle_requests_decisionOperationId_key" ON "case_lifecycle_requests"("decisionOperationId");

-- CreateIndex
CREATE INDEX "case_lifecycle_requests_caseId_createdAt_idx" ON "case_lifecycle_requests"("caseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "case_lifecycle_requests_caseId_id_key" ON "case_lifecycle_requests"("caseId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cases_lifecycleModeRequestId_key" ON "cases"("lifecycleModeRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "cases_currentCycleId_key" ON "cases"("currentCycleId");

-- CreateIndex
CREATE UNIQUE INDEX "cases_pendingLifecycleRequestId_key" ON "cases"("pendingLifecycleRequestId");

-- AddForeignKey
ALTER TABLE "case_cycles" ADD CONSTRAINT "case_cycles_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_lifecycle_requests" ADD CONSTRAINT "case_lifecycle_requests_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Same-case relations (composite foreign keys) ───────────────────────────────────────────────────────
-- Case → current cycle / pending request are reverse pointers: NO ACTION + DEFERRABLE INITIALLY DEFERRED, so they
-- are verified at commit and an explicit full reset can delete the whole graph in one transaction. Every child →
-- case history FK stays RESTRICT (ordinary deletion is refused).
ALTER TABLE "cases" ADD CONSTRAINT "cases_current_cycle_same_case_fkey" FOREIGN KEY ("id", "currentCycleId")
  REFERENCES "case_cycles"("caseId", "id") ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "cases" ADD CONSTRAINT "cases_pending_lifecycle_same_case_fkey" FOREIGN KEY ("id", "pendingLifecycleRequestId")
  REFERENCES "case_lifecycle_requests"("caseId", "id") ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "case_lifecycle_requests" ADD CONSTRAINT "case_lifecycle_requests_cycle_same_case_fkey" FOREIGN KEY ("caseId", "cycleId")
  REFERENCES "case_cycles"("caseId", "id") ON DELETE RESTRICT;
ALTER TABLE "case_lifecycle_requests" ADD CONSTRAINT "case_lifecycle_requests_result_cycle_same_case_fkey" FOREIGN KEY ("caseId", "resultCycleId")
  REFERENCES "case_cycles"("caseId", "id") ON DELETE RESTRICT;
ALTER TABLE "case_deliveries" ADD CONSTRAINT "case_deliveries_cycle_same_case_fkey" FOREIGN KEY ("caseId", "cycleId")
  REFERENCES "case_cycles"("caseId", "id") ON DELETE RESTRICT;

-- ── Case lifecycle mode ─────────────────────────────────────────────────────────────────────────────────
-- Legacy cases carry nothing; managed cases always carry the full adoption stamp, a current cycle and an explicit
-- lifecycle status. At most ONE pending pointer (delivery submission / schedule request / lifecycle request).
-- Null-safe throughout (explicit IS [NOT] NULL / coalesce), as in 0004/0005.
ALTER TABLE "cases" ADD CONSTRAINT "cases_lifecycle_mode" CHECK ("lifecycleMode" IN ('legacy', 'managed'));
ALTER TABLE "cases" ADD CONSTRAINT "cases_lifecycle_mode_stamp" CHECK (
  ("lifecycleMode" = 'legacy' AND "lifecycleModeSince" IS NULL AND "lifecycleModeById" IS NULL AND "lifecycleModeByName" IS NULL
     AND "lifecycleModeReason" IS NULL AND "lifecycleModeRequestId" IS NULL AND "lifecycleModeFingerprint" IS NULL
     AND "lifecycleStatus" IS NULL AND "currentCycleId" IS NULL AND "pendingLifecycleRequestId" IS NULL)
  OR ("lifecycleMode" = 'managed' AND "lifecycleModeSince" IS NOT NULL AND "lifecycleModeById" IS NOT NULL
     AND "lifecycleModeRequestId" IS NOT NULL AND "lifecycleModeFingerprint" IS NOT NULL AND "currentCycleId" IS NOT NULL
     AND "lifecycleStatus" IS NOT NULL AND "lifecycleStatus" IN ('active', 'sealed_incomplete', 'completed', 'cancelled')
     AND char_length(btrim(coalesce("lifecycleModeReason", ''))) >= 2
     AND char_length(btrim(coalesce("lifecycleModeByName", ''))) >= 1
     AND "lifecycleModeRequestId" ~ '^[A-Za-z0-9_-]{8,100}$' AND "lifecycleModeFingerprint" ~ '^[0-9a-f]{64}$')
);
ALTER TABLE "cases" ADD CONSTRAINT "cases_single_pending" CHECK (
  num_nonnulls("pendingDeliverySubmissionId", "pendingScheduleRequestId", "pendingLifecycleRequestId") <= 1
);

-- ── Snapshot shape helpers (NULL input → false; never UNKNOWN in a CHECK) ──────────────────────────────
-- Assignment: {designerId:number, collaborators:[{id,name}]} (named) or {designerId:number, collaboratorIds:[…]}.
CREATE FUNCTION "design_pm_valid_assignment"(j JSONB) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_typeof(j) = 'object' AND jsonb_typeof(j -> 'designerId') = 'number'
    AND (jsonb_typeof(j -> 'collaborators') = 'array' OR jsonb_typeof(j -> 'collaboratorIds') = 'array'), false)
$$;
-- A text-or-null key that must be PRESENT (unknown is stored explicitly as JSON null, never as a missing key).
CREATE FUNCTION "design_pm_text_or_null"(j JSONB, k TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(j ? k AND jsonb_typeof(j -> k) IN ('string', 'null'), false)
$$;
CREATE FUNCTION "design_pm_valid_legacy_counts"(j JSONB) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_typeof(j) = 'object' AND j ? 'requestCount' AND j ? 'outputCount'
    AND jsonb_typeof(j -> 'requestCount') IN ('number', 'null') AND jsonb_typeof(j -> 'outputCount') IN ('number', 'null'), false)
$$;

-- ── Cycles ──────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "case_cycles" ADD CONSTRAINT "case_cycles_start" CHECK (
  "id" ~ '^[A-Za-z0-9_-]{8,100}$' AND "sequence" >= 1 AND "startRequestId" ~ '^[A-Za-z0-9_-]{8,100}$'
  AND char_length(btrim("startedByName")) >= 1 AND char_length(btrim("startReason")) BETWEEN 2 AND 500
  AND coalesce(jsonb_typeof("startSnapshot") = 'object'
       AND (("source" = 'adoption' AND "sequence" = 1 AND "startSnapshot" ->> 'source' = 'observed_at_adoption' AND "startSnapshot" ->> 'attribution' = 'legacy_unknown')
            OR ("source" = 'resume' AND "sequence" > 1 AND "startSnapshot" ->> 'source' = 'resume_approved' AND "startSnapshot" ->> 'attribution' = 'cycle_tracked'
                AND jsonb_typeof("startSnapshot" -> 'resumedFromCycleId') = 'string'))
       AND jsonb_typeof("startSnapshot" -> 'status') = 'string'
       AND "design_pm_valid_schedule"("startSnapshot" -> 'schedule')
       AND "design_pm_valid_assignment"("startSnapshot" -> 'assignment')
       AND "design_pm_text_or_null"("startSnapshot", 'archivePath')
       AND jsonb_typeof("startSnapshot" -> 'carryForwardDeliveryIds') = 'array'
       AND "design_pm_valid_legacy_counts"("startSnapshot" -> 'legacyCounts'), false)
);
ALTER TABLE "case_cycles" ADD CONSTRAINT "case_cycles_end" CHECK (
  ("endedAt" IS NULL AND "outcome" IS NULL AND "endedById" IS NULL AND "endedByName" IS NULL AND "endReason" IS NULL
     AND "endRequestId" IS NULL AND "endSnapshot" IS NULL)
  OR ("endedAt" IS NOT NULL AND "outcome" IS NOT NULL AND "endedById" IS NOT NULL AND "endSnapshot" IS NOT NULL
     AND "outcome" IN ('sealed_incomplete', 'completed', 'cancelled')
     AND char_length(btrim(coalesce("endedByName", ''))) >= 1 AND char_length(btrim(coalesce("endReason", ''))) >= 2
     AND (("outcome" = 'sealed_incomplete' AND "endRequestId" IS NOT NULL AND "endRequestId" ~ '^[A-Za-z0-9_-]{8,100}$')
          OR ("outcome" <> 'sealed_incomplete' AND "endRequestId" IS NULL))
     AND coalesce(jsonb_typeof("endSnapshot") = 'object'
          AND jsonb_typeof("endSnapshot" -> 'status') = 'string'
          AND "design_pm_valid_schedule"("endSnapshot" -> 'schedule')
          AND "design_pm_valid_assignment"("endSnapshot" -> 'assignment')
          AND "design_pm_text_or_null"("endSnapshot", 'archivePath')
          AND "endSnapshot" ? 'noFile' AND jsonb_typeof("endSnapshot" -> 'noFile') IN ('null', 'object')
          AND jsonb_typeof("endSnapshot" -> 'activeDeliveryIds') = 'array'
          AND jsonb_typeof("endSnapshot" -> 'cycleDeliveryIds') = 'array'
          AND "design_pm_valid_legacy_counts"("endSnapshot" -> 'legacyCounts')
          -- an incomplete seal records EITHER a non-blank archive path OR an explicit no-file declaration with reason
          AND ("outcome" <> 'sealed_incomplete'
               OR (jsonb_typeof("endSnapshot" -> 'noFile') = 'object' AND ("endSnapshot" -> 'noFile') ->> 'declared' = 'true'
                   AND char_length(btrim(coalesce(("endSnapshot" -> 'noFile') ->> 'reason', ''))) >= 2)
               OR (jsonb_typeof("endSnapshot" -> 'noFile') = 'null' AND jsonb_typeof("endSnapshot" -> 'archivePath') = 'string'
                   AND char_length(btrim("endSnapshot" ->> 'archivePath')) >= 1)), false))
);
-- At most one open (not yet ended) cycle per case.
CREATE UNIQUE INDEX "case_cycles_one_open" ON "case_cycles"("caseId") WHERE "endedAt" IS NULL;

-- ── Lifecycle requests ──────────────────────────────────────────────────────────────────────────────────
-- Seal evidence is EITHER the saved non-blank archive path OR an explicit "no archivable file" declaration with its
-- own reason (manager-approved). Resume carries no archive evidence. This never relaxes C1 completion evidence.
-- reasonCategory uses the D1a categories (filing / reading only — no automatic exoneration or KPI change).
ALTER TABLE "case_lifecycle_requests" ADD CONSTRAINT "case_lifecycle_requests_content" CHECK (
  "id" ~ '^[A-Za-z0-9_-]{8,100}$' AND "requestFingerprint" ~ '^[0-9a-f]{64}$' AND "kind" IN ('seal', 'resume')
  AND "reasonCategory" IN ('requester_change', 'material_delay', 'approval_delay', 'scope_change', 'internal_capacity', 'external_vendor', 'date_correction', 'other')
  AND char_length(btrim("requestedByName")) >= 1 AND char_length(btrim("reason")) BETWEEN 2 AND 500 AND "caseContentVersion" >= 0
  AND (("kind" = 'seal' AND (
          ("archivePath" IS NOT NULL AND char_length(btrim("archivePath")) >= 1 AND "noFileDeclared" IS NULL AND "noFileReason" IS NULL)
          OR ("archivePath" IS NULL AND "noFileDeclared" IS NOT NULL AND "noFileDeclared" = true
              AND char_length(btrim(coalesce("noFileReason", ''))) BETWEEN 2 AND 500)))
       OR ("kind" = 'resume' AND "archivePath" IS NULL AND "noFileDeclared" IS NULL AND "noFileReason" IS NULL))
  AND coalesce(jsonb_typeof("snapshot") = 'object' AND jsonb_typeof("snapshot" -> 'status') = 'string'
               AND "design_pm_valid_schedule"("snapshot" -> 'schedule') AND "design_pm_valid_assignment"("snapshot" -> 'assignment')
               AND "design_pm_text_or_null"("snapshot", 'archivePath') AND jsonb_typeof("snapshot" -> 'activeDeliveryIds') = 'array', false)
);
ALTER TABLE "case_lifecycle_requests" ADD CONSTRAINT "case_lifecycle_requests_decision" CHECK (
  ("decision" IS NULL AND "decidedAt" IS NULL AND "decidedById" IS NULL AND "decidedByName" IS NULL AND "decisionReason" IS NULL
     AND "decisionOperationId" IS NULL AND "decisionFingerprint" IS NULL AND "resultCycleId" IS NULL)
  OR ("decision" IS NOT NULL AND "decidedAt" IS NOT NULL AND "decidedById" IS NOT NULL
     AND "decisionOperationId" IS NOT NULL AND "decisionFingerprint" IS NOT NULL
     AND "decision" IN ('approved', 'rejected', 'withdrawn', 'invalidated')
     AND char_length(btrim(coalesce("decidedByName", ''))) >= 1 AND "decisionOperationId" ~ '^[A-Za-z0-9_:-]{8,120}$'
     AND "decisionFingerprint" ~ '^[0-9a-f]{64}$'
     AND ("decision" = 'approved' OR char_length(btrim(coalesce("decisionReason", ''))) >= 2)
     AND (("decision" = 'approved' AND "kind" = 'resume' AND "resultCycleId" IS NOT NULL AND "resultCycleId" <> "cycleId")
          OR (NOT ("decision" = 'approved' AND "kind" = 'resume') AND "resultCycleId" IS NULL)))
);
CREATE UNIQUE INDEX "case_lifecycle_requests_one_pending" ON "case_lifecycle_requests"("caseId") WHERE "decision" IS NULL;

-- ── Append-only protection (purge only under the existing transaction-local switch) ─────────────────────
CREATE FUNCTION "protect_case_cycles"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF coalesce(current_setting('design_pm.allow_delivery_purge', true), '') = 'on' THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'case_cycles is append-only history' USING ERRCODE = '23514';
  ELSIF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('design_pm.allow_delivery_purge', true), '') = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'case_cycles is append-only history' USING ERRCODE = '23514';
  END IF;
  IF OLD."endedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'ended cycles are immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."id", NEW."caseId", NEW."sequence", NEW."source", NEW."startedAt", NEW."startedById", NEW."startedByName",
         NEW."startReason", NEW."startRequestId", NEW."startSnapshot")
     IS DISTINCT FROM
     ROW(OLD."id", OLD."caseId", OLD."sequence", OLD."source", OLD."startedAt", OLD."startedById", OLD."startedByName",
         OLD."startReason", OLD."startRequestId", OLD."startSnapshot") THEN
    RAISE EXCEPTION 'cycle start evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "case_cycles_append_only" BEFORE UPDATE OR DELETE ON "case_cycles"
FOR EACH ROW EXECUTE FUNCTION "protect_case_cycles"();
CREATE TRIGGER "case_cycles_no_truncate" BEFORE TRUNCATE ON "case_cycles"
FOR EACH STATEMENT EXECUTE FUNCTION "protect_case_cycles"();

CREATE FUNCTION "protect_case_lifecycle_requests"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF coalesce(current_setting('design_pm.allow_delivery_purge', true), '') = 'on' THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'case_lifecycle_requests is append-only history' USING ERRCODE = '23514';
  ELSIF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('design_pm.allow_delivery_purge', true), '') = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'case_lifecycle_requests is append-only history' USING ERRCODE = '23514';
  END IF;
  IF OLD."decidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'decided lifecycle requests are immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."id", NEW."caseId", NEW."kind", NEW."cycleId", NEW."requestFingerprint", NEW."requestedById", NEW."requestedByName",
         NEW."createdAt", NEW."reasonCategory", NEW."reason", NEW."archivePath", NEW."noFileDeclared", NEW."noFileReason", NEW."snapshot",
         NEW."caseUpdatedAt", NEW."caseContentVersion")
     IS DISTINCT FROM
     ROW(OLD."id", OLD."caseId", OLD."kind", OLD."cycleId", OLD."requestFingerprint", OLD."requestedById", OLD."requestedByName",
         OLD."createdAt", OLD."reasonCategory", OLD."reason", OLD."archivePath", OLD."noFileDeclared", OLD."noFileReason", OLD."snapshot",
         OLD."caseUpdatedAt", OLD."caseContentVersion") THEN
    RAISE EXCEPTION 'lifecycle request content is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "case_lifecycle_requests_append_only" BEFORE UPDATE OR DELETE ON "case_lifecycle_requests"
FOR EACH ROW EXECUTE FUNCTION "protect_case_lifecycle_requests"();
CREATE TRIGGER "case_lifecycle_requests_no_truncate" BEFORE TRUNCATE ON "case_lifecycle_requests"
FOR EACH STATEMENT EXECUTE FUNCTION "protect_case_lifecycle_requests"();

-- ── Case lifecycle mode is one-way; transitions are limited ─────────────────────────────────────────────
-- active → sealed_incomplete | completed | cancelled; sealed_incomplete → active only with a NEW current cycle
-- (approved resume); completed / cancelled are final in D1b. The current cycle pointer changes only on resume.
CREATE FUNCTION "protect_case_lifecycle_mode"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."lifecycleMode" = 'managed' THEN
    IF NEW."lifecycleMode" IS DISTINCT FROM OLD."lifecycleMode"
       OR NEW."lifecycleModeSince" IS DISTINCT FROM OLD."lifecycleModeSince"
       OR NEW."lifecycleModeById" IS DISTINCT FROM OLD."lifecycleModeById"
       OR NEW."lifecycleModeByName" IS DISTINCT FROM OLD."lifecycleModeByName"
       OR NEW."lifecycleModeReason" IS DISTINCT FROM OLD."lifecycleModeReason"
       OR NEW."lifecycleModeRequestId" IS DISTINCT FROM OLD."lifecycleModeRequestId"
       OR NEW."lifecycleModeFingerprint" IS DISTINCT FROM OLD."lifecycleModeFingerprint" THEN
      RAISE EXCEPTION 'managed lifecycle mode is one-way and its adoption stamp is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW."lifecycleStatus" IS DISTINCT FROM OLD."lifecycleStatus" AND NOT (
         (OLD."lifecycleStatus" = 'active' AND NEW."lifecycleStatus" IN ('sealed_incomplete', 'completed', 'cancelled'))
         OR (OLD."lifecycleStatus" = 'sealed_incomplete' AND NEW."lifecycleStatus" = 'active' AND NEW."currentCycleId" IS DISTINCT FROM OLD."currentCycleId")) THEN
      RAISE EXCEPTION 'lifecycle status transition % → % is not allowed', OLD."lifecycleStatus", NEW."lifecycleStatus" USING ERRCODE = '23514';
    END IF;
    IF NEW."currentCycleId" IS DISTINCT FROM OLD."currentCycleId"
       AND NOT (OLD."lifecycleStatus" = 'sealed_incomplete' AND NEW."lifecycleStatus" = 'active') THEN
      RAISE EXCEPTION 'the current cycle changes only on an approved resume' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "cases_lifecycle_mode_one_way" BEFORE UPDATE ON "cases"
FOR EACH ROW EXECUTE FUNCTION "protect_case_lifecycle_mode"();

-- ── Commit-time graph integrity (deferred constraint triggers) ──────────────────────────────────────────
-- A legal transaction may be temporarily inconsistent (e.g. adoption inserts cycle 1 before stamping the case);
-- at COMMIT every touched case's FINAL graph must hold. A case deleted in the same transaction (explicit full reset)
-- is skipped — its children cannot survive it (RESTRICT FKs). Nothing here depends on the purge switch.
CREATE FUNCTION "design_pm_check_lifecycle_graph"(cid TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE c RECORD; cur RECORD; bad TEXT;
BEGIN
  SELECT * INTO c FROM "cases" WHERE "id" = cid;
  IF NOT FOUND THEN RETURN; END IF;
  IF c."lifecycleMode" <> 'managed' THEN
    IF EXISTS (SELECT 1 FROM "case_cycles" WHERE "caseId" = cid) OR EXISTS (SELECT 1 FROM "case_lifecycle_requests" WHERE "caseId" = cid) THEN
      RAISE EXCEPTION 'case % has lifecycle history but is not lifecycle-managed', cid USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;
  SELECT * INTO cur FROM "case_cycles" WHERE "id" = c."currentCycleId" AND "caseId" = cid;
  IF NOT FOUND THEN RAISE EXCEPTION 'case % current cycle is missing', cid USING ERRCODE = '23514'; END IF;
  -- current cycle state matches the lifecycle status; it is the latest cycle and the only open one
  IF (c."lifecycleStatus" = 'active' AND cur."endedAt" IS NOT NULL)
     OR (c."lifecycleStatus" <> 'active' AND (cur."endedAt" IS NULL OR cur."outcome" IS DISTINCT FROM c."lifecycleStatus")) THEN
    RAISE EXCEPTION 'case % lifecycle status % does not match its current cycle', cid, c."lifecycleStatus" USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "case_cycles" WHERE "caseId" = cid AND ("sequence" > cur."sequence" OR ("endedAt" IS NULL AND "id" <> cur."id"))) THEN
    RAISE EXCEPTION 'case % current cycle is not its latest / only open cycle', cid USING ERRCODE = '23514';
  END IF;
  -- cycle sequence has no gaps
  IF (SELECT count(*) FROM "case_cycles" WHERE "caseId" = cid) <> cur."sequence" THEN
    RAISE EXCEPTION 'case % cycle sequence has gaps', cid USING ERRCODE = '23514';
  END IF;
  -- pending pointer ⇔ the single undecided request, for the current cycle, of the kind the status allows
  IF c."pendingLifecycleRequestId" IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM "case_lifecycle_requests" r WHERE r."id" = c."pendingLifecycleRequestId" AND r."caseId" = cid
                   AND r."decision" IS NULL AND r."cycleId" = c."currentCycleId"
                   AND ((c."lifecycleStatus" = 'active' AND r."kind" = 'seal') OR (c."lifecycleStatus" = 'sealed_incomplete' AND r."kind" = 'resume'))) THEN
      RAISE EXCEPTION 'case % pending lifecycle pointer is inconsistent', cid USING ERRCODE = '23514';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM "case_lifecycle_requests" WHERE "caseId" = cid AND "decision" IS NULL AND "id" IS DISTINCT FROM c."pendingLifecycleRequestId") THEN
    RAISE EXCEPTION 'case % has an undecided lifecycle request that is not its pending pointer', cid USING ERRCODE = '23514';
  END IF;
  -- every sealed cycle ↔ exactly its approved seal request (and matching archive / no-file evidence)
  SELECT y."id" INTO bad FROM "case_cycles" y WHERE y."caseId" = cid AND y."outcome" = 'sealed_incomplete' AND NOT EXISTS (
    SELECT 1 FROM "case_lifecycle_requests" r WHERE r."id" = y."endRequestId" AND r."caseId" = cid AND r."kind" = 'seal'
      AND r."decision" = 'approved' AND r."cycleId" = y."id"
      AND ((r."noFileDeclared" IS NOT NULL AND r."noFileDeclared" = true AND (y."endSnapshot" -> 'noFile') ->> 'reason' = r."noFileReason")
           OR (r."noFileDeclared" IS NULL AND jsonb_typeof(y."endSnapshot" -> 'noFile') = 'null' AND y."endSnapshot" ->> 'archivePath' = r."archivePath"))) LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'sealed cycle % has no matching approved seal request', bad USING ERRCODE = '23514'; END IF;
  SELECT r."id" INTO bad FROM "case_lifecycle_requests" r WHERE r."caseId" = cid AND r."kind" = 'seal' AND r."decision" = 'approved' AND NOT EXISTS (
    SELECT 1 FROM "case_cycles" y WHERE y."id" = r."cycleId" AND y."outcome" = 'sealed_incomplete' AND y."endRequestId" = r."id") LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'approved seal request % did not seal its cycle', bad USING ERRCODE = '23514'; END IF;
  -- every resumed cycle ↔ exactly its approved resume request: successor of a sealed cycle, next sequence
  SELECT y."id" INTO bad FROM "case_cycles" y WHERE y."caseId" = cid AND y."source" = 'resume' AND NOT EXISTS (
    SELECT 1 FROM "case_lifecycle_requests" r JOIN "case_cycles" p ON p."id" = r."cycleId"
    WHERE r."id" = y."startRequestId" AND r."caseId" = cid AND r."kind" = 'resume' AND r."decision" = 'approved' AND r."resultCycleId" = y."id"
      AND p."caseId" = cid AND p."outcome" = 'sealed_incomplete' AND p."sequence" + 1 = y."sequence"
      AND y."startSnapshot" ->> 'resumedFromCycleId' = p."id") LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'resumed cycle % has no matching approved resume request', bad USING ERRCODE = '23514'; END IF;
  SELECT r."id" INTO bad FROM "case_lifecycle_requests" r WHERE r."caseId" = cid AND r."kind" = 'resume' AND r."decision" = 'approved' AND NOT EXISTS (
    SELECT 1 FROM "case_cycles" y WHERE y."id" = r."resultCycleId" AND y."source" = 'resume' AND y."startRequestId" = r."id") LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'approved resume request % has no successor cycle', bad USING ERRCODE = '23514'; END IF;
END;
$$;
CREATE FUNCTION "design_pm_lifecycle_graph_trigger"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'cases' THEN
    IF TG_OP <> 'DELETE' THEN PERFORM "design_pm_check_lifecycle_graph"(NEW."id"); END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN PERFORM "design_pm_check_lifecycle_graph"(OLD."caseId"); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM "design_pm_check_lifecycle_graph"(NEW."caseId"); END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "cases_lifecycle_graph" AFTER INSERT OR UPDATE ON "cases" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."lifecycleMode" = 'managed') EXECUTE FUNCTION "design_pm_lifecycle_graph_trigger"();
CREATE CONSTRAINT TRIGGER "case_cycles_lifecycle_graph" AFTER INSERT OR UPDATE OR DELETE ON "case_cycles" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "design_pm_lifecycle_graph_trigger"();
CREATE CONSTRAINT TRIGGER "case_lifecycle_requests_lifecycle_graph" AFTER INSERT OR UPDATE OR DELETE ON "case_lifecycle_requests" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "design_pm_lifecycle_graph_trigger"();

-- ── Delivery attribution ────────────────────────────────────────────────────────────────────────────────
-- A new delivery on a managed case must belong to that case's current OPEN cycle while the lifecycle is active and
-- no seal/resume request is pending; a legacy case's deliveries carry no cycle. The case row is locked (FOR UPDATE),
-- so the insert is mutually exclusive with any concurrent lifecycle write. The attribution never changes.
CREATE FUNCTION "protect_case_delivery_cycle"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."cycleId" IS DISTINCT FROM OLD."cycleId" THEN
      RAISE EXCEPTION 'delivery cycle attribution is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT "lifecycleMode", "lifecycleStatus", "currentCycleId", "pendingLifecycleRequestId" INTO c FROM "cases" WHERE "id" = NEW."caseId" FOR UPDATE;
  IF c."lifecycleMode" = 'managed' THEN
    IF NEW."cycleId" IS NULL OR NEW."cycleId" IS DISTINCT FROM c."currentCycleId" OR c."lifecycleStatus" IS DISTINCT FROM 'active'
       OR c."pendingLifecycleRequestId" IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM "case_cycles" WHERE "id" = NEW."cycleId" AND "caseId" = NEW."caseId" AND "endedAt" IS NULL) THEN
      RAISE EXCEPTION 'a delivery on a lifecycle-managed case must belong to its current open cycle with no pending seal/resume' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."cycleId" IS NOT NULL THEN
    RAISE EXCEPTION 'a legacy case delivery carries no cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "case_deliveries_cycle_attribution" BEFORE INSERT OR UPDATE ON "case_deliveries"
FOR EACH ROW EXECUTE FUNCTION "protect_case_delivery_cycle"();
