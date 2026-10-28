-- REPORTS-P3-E1a: go-forward report source versions. Additive only; no business row is changed.
-- Every committed change to a whitelisted report source column is appended to "report_source_events" by an AFTER ROW
-- trigger (so the event id is allocated while the source row lock is held). Events carry the DB clock_timestamp() at
-- capture and the full 64-bit transaction id; a reader groups ALL visible events of a transaction, takes the latest
-- capture as the transaction's effective record time, and replays whole transactions by event id. This is the
-- "time the last report-source change of the transaction was recorded", NOT the commit time.
-- Projections list columns explicitly (no row_to_json): no password, email, activation/reset token or expiry,
-- sessionVersion or calendarVersion is ever captured. Rows with no whitelisted change append nothing.
-- History before "report_source_coverage"."coverageStart" is not reconstructable and must be reported as insufficient.
-- SQL-only behaviour (not modelled in schema.prisma): sequence CACHE 1 / NO CYCLE, CHECKs, triggers, functions.
-- One explicit transaction: tables, triggers, baseline and coverage commit together or not at all.
BEGIN;

-- ── tables ─────────────────────────────────────────────────────────────────────────────────────────
CREATE SEQUENCE "report_source_events_id_seq" AS BIGINT INCREMENT BY 1 MINVALUE 1 NO MAXVALUE START WITH 1 CACHE 1 NO CYCLE;

CREATE TABLE "report_source_events" (
    "id" BIGINT NOT NULL DEFAULT nextval('report_source_events_id_seq'),
    "capturedAt" TIMESTAMPTZ(6) NOT NULL,
    "transactionId" BIGINT NOT NULL,
    "tableName" TEXT NOT NULL,
    "rowKey" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "report_source_events_pkey" PRIMARY KEY ("id")
);
ALTER SEQUENCE "report_source_events_id_seq" OWNED BY "report_source_events"."id";
CREATE INDEX "report_source_events_transactionId_idx" ON "report_source_events"("transactionId");
CREATE INDEX "report_source_events_tableName_rowKey_idx" ON "report_source_events"("tableName", "rowKey");

ALTER TABLE "report_source_events" ADD CONSTRAINT "report_source_events_table_check" CHECK ("tableName" IN (
  'cases', '_collaborators', 'case_deliveries', 'case_cycles', 'case_lifecycle_requests', 'case_schedule_requests',
  'case_delivery_submissions', 'staff', 'hotels', 'change_logs'));
ALTER TABLE "report_source_events" ADD CONSTRAINT "report_source_events_op_check" CHECK ("op" IN ('B', 'I', 'U', 'D'));
ALTER TABLE "report_source_events" ADD CONSTRAINT "report_source_events_data_check" CHECK (jsonb_typeof("data") = 'object');
ALTER TABLE "report_source_events" ADD CONSTRAINT "report_source_events_rowkey_check" CHECK (length("rowKey") BETWEEN 1 AND 200);

CREATE TABLE "report_source_coverage" (
    "id" INTEGER NOT NULL,
    "coverageStart" TIMESTAMPTZ(6) NOT NULL,
    "baselineEventMaxId" BIGINT,
    "baselineTransactionId" BIGINT NOT NULL,

    CONSTRAINT "report_source_coverage_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "report_source_coverage" ADD CONSTRAINT "report_source_coverage_single_row" CHECK ("id" = 1);

-- ── event append: only from the capture/baseline functions; id, capture time and transaction id are never caller-supplied ──
CREATE FUNCTION "report_source_events_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocated BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF coalesce(current_setting('design_pm.report_capture', true), '') <> 'on' THEN
      RAISE EXCEPTION 'report_source_events is written only by report source capture' USING ERRCODE = '23514';
    END IF;
    IF NEW."op" = 'B' AND coalesce(current_setting('design_pm.report_baseline', true), '') <> 'on' THEN
      RAISE EXCEPTION 'baseline events are written only by report_source_baseline()' USING ERRCODE = '23514';
    END IF;
    BEGIN allocated := currval('report_source_events_id_seq');
    EXCEPTION WHEN object_not_in_prerequisite_state THEN allocated := NULL; END;
    IF allocated IS NULL OR NEW."id" IS DISTINCT FROM allocated THEN
      RAISE EXCEPTION 'report source event ids come only from the sequence default' USING ERRCODE = '23514';
    END IF;
    NEW."capturedAt" := clock_timestamp();
    NEW."transactionId" := pg_current_xact_id()::text::bigint;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('design_pm.allow_report_purge', true), '') = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'report_source_events is append-only' USING ERRCODE = '23514';
  ELSIF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'report_source_events is append-only' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'report_source_events is append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "report_source_events_append_only" BEFORE INSERT OR UPDATE OR DELETE ON "report_source_events"
FOR EACH ROW EXECUTE FUNCTION "report_source_events_guard"();
CREATE TRIGGER "report_source_events_no_truncate" BEFORE TRUNCATE ON "report_source_events"
FOR EACH STATEMENT EXECUTE FUNCTION "report_source_events_guard"();

CREATE FUNCTION "report_source_coverage_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'TRUNCATE' AND coalesce(current_setting('design_pm.report_baseline', true), '') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'report_source_coverage is set only by report_source_baseline()' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "report_source_coverage_guarded" BEFORE INSERT OR UPDATE OR DELETE ON "report_source_coverage"
FOR EACH ROW EXECUTE FUNCTION "report_source_coverage_guard"();
CREATE TRIGGER "report_source_coverage_no_truncate" BEFORE TRUNCATE ON "report_source_coverage"
FOR EACH STATEMENT EXECUTE FUNCTION "report_source_coverage_guard"();

CREATE FUNCTION "report_source_append"(p_table TEXT, p_key TEXT, p_op TEXT, p_data JSONB) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('design_pm.report_capture', 'on', true);
  INSERT INTO "report_source_events" ("tableName", "rowKey", "op", "data") VALUES (p_table, p_key, p_op, p_data);
  PERFORM set_config('design_pm.report_capture', 'off', true);
END;
$$;

-- old/new projection NULL = the row does not exist (or is not a report source row) on that side.
-- U keeps explicit JSON null for a column that became NULL; a key change is a D of the old key plus an I of the new.
CREATE FUNCTION "report_source_capture"(p_table TEXT, p_old_key TEXT, p_new_key TEXT, p_old JSONB, p_new JSONB) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE delta JSONB;
BEGIN
  IF p_old IS NULL AND p_new IS NULL THEN RETURN; END IF;
  IF p_old IS NULL THEN PERFORM "report_source_append"(p_table, p_new_key, 'I', p_new); RETURN; END IF;
  IF p_new IS NULL THEN PERFORM "report_source_append"(p_table, p_old_key, 'D', '{}'::jsonb); RETURN; END IF;
  IF p_old_key IS DISTINCT FROM p_new_key THEN
    PERFORM "report_source_append"(p_table, p_old_key, 'D', '{}'::jsonb);
    PERFORM "report_source_append"(p_table, p_new_key, 'I', p_new);
    RETURN;
  END IF;
  SELECT jsonb_object_agg(n.key, n.value) INTO delta FROM jsonb_each(p_new) AS n
   WHERE NOT (p_old ? n.key) OR (p_old -> n.key) IS DISTINCT FROM n.value;
  IF delta IS NOT NULL THEN PERFORM "report_source_append"(p_table, p_new_key, 'U', delta); END IF;
END;
$$;

-- ── explicit whitelist projections (one per source table) ─────────────────────────────────────────
-- cases."updatedAt"/"createdAt" are the source row's own timestamps (for "last updated" display only); they are never
-- the system record time of an event.
CREATE FUNCTION "report_project_cases"(r "cases") RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'id', r."id", 'title', r."title", 'subTitle', r."subTitle", 'requester', r."requester", 'hotel', r."hotel",
    'level', r."level", 'category', r."category", 'status', r."status", 'urgent', r."urgent",
    'openDate', r."openDate", 'requestedOn', r."requestedOn", 'dispatchDate', r."dispatchDate", 'copyDate', r."copyDate",
    'printDate', r."printDate", 'goLiveDate', r."goLiveDate", 'closedOn', r."closedOn", 'cancelledOn', r."cancelledOn",
    'cancelReason', r."cancelReason", 'cancelStage', r."cancelStage", 'archived', r."archived", 'designerId', r."designerId",
    'deliveryMode', r."deliveryMode", 'scheduleMode', r."scheduleMode", 'scheduleBaseline', r."scheduleBaseline",
    'lifecycleMode', r."lifecycleMode", 'lifecycleStatus', r."lifecycleStatus", 'currentCycleId', r."currentCycleId",
    'pendingDeliverySubmissionId', r."pendingDeliverySubmissionId", 'pendingScheduleRequestId', r."pendingScheduleRequestId",
    'pendingLifecycleRequestId', r."pendingLifecycleRequestId", 'requestCount', r."requestCount", 'outputCount', r."outputCount",
    'items', r."items", 'logs', r."logs", 'contentVersion', r."contentVersion", 'createdAt', r."createdAt", 'updatedAt', r."updatedAt")
$$;
CREATE FUNCTION "report_project_collaborators"(r "_collaborators") RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('caseId', r."A", 'staffId', r."B")
$$;
CREATE FUNCTION "report_project_case_deliveries"(r "case_deliveries") RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'id', r."id", 'caseId', r."caseId", 'itemKey', r."itemKey", 'itemName', r."itemName", 'kind', r."kind",
    'quantity', r."quantity", 'unit', r."unit", 'deliveredOn', r."deliveredOn", 'note', r."note",
    'recordedById', r."recordedById", 'recordedByName', r."recordedByName", 'createdAt', r."createdAt", 'cycleId', r."cycleId",
    'voidedAt', r."voidedAt", 'voidedById', r."voidedById", 'voidedByName', r."voidedByName", 'voidReason', r."voidReason")
$$;
CREATE FUNCTION "report_project_case_cycles"(r "case_cycles") RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'id', r."id", 'caseId', r."caseId", 'sequence', r."sequence", 'source', r."source", 'startedAt', r."startedAt",
    'startedById', r."startedById", 'startedByName', r."startedByName", 'startReason', r."startReason",
    'startRequestId', r."startRequestId", 'startSnapshot', r."startSnapshot", 'endedAt', r."endedAt", 'outcome', r."outcome",
    'endedById', r."endedById", 'endedByName', r."endedByName", 'endReason', r."endReason", 'endRequestId', r."endRequestId",
    'endSnapshot', r."endSnapshot")
$$;
CREATE FUNCTION "report_project_case_lifecycle_requests"(r "case_lifecycle_requests") RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'id', r."id", 'caseId', r."caseId", 'kind', r."kind", 'cycleId', r."cycleId", 'requestedById', r."requestedById",
    'requestedByName', r."requestedByName", 'createdAt', r."createdAt", 'reasonCategory', r."reasonCategory", 'reason', r."reason",
    'archivePath', r."archivePath", 'noFileDeclared', r."noFileDeclared", 'noFileReason', r."noFileReason", 'snapshot', r."snapshot",
    'decision', r."decision", 'decidedAt', r."decidedAt", 'decidedById', r."decidedById", 'decidedByName', r."decidedByName",
    'decisionReason', r."decisionReason", 'resultCycleId', r."resultCycleId")
$$;
CREATE FUNCTION "report_project_case_schedule_requests"(r "case_schedule_requests") RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'id', r."id", 'caseId', r."caseId", 'requestedById', r."requestedById", 'requestedByName', r."requestedByName",
    'createdAt', r."createdAt", 'reasonCategory', r."reasonCategory", 'reason', r."reason", 'impactFrom', r."impactFrom",
    'impactTo', r."impactTo", 'currentSchedule', r."currentSchedule", 'proposedSchedule', r."proposedSchedule",
    'assignmentSnapshot', r."assignmentSnapshot", 'decision', r."decision", 'decidedAt', r."decidedAt",
    'decidedById', r."decidedById", 'decidedByName', r."decidedByName", 'decisionReason', r."decisionReason",
    'approvedSchedule', r."approvedSchedule")
$$;
CREATE FUNCTION "report_project_case_delivery_submissions"(r "case_delivery_submissions") RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'id', r."id", 'caseId', r."caseId", 'submittedById', r."submittedById", 'submittedByName', r."submittedByName",
    'createdAt', r."createdAt", 'archivePath', r."archivePath", 'recordIds', r."recordIds", 'summary', r."summary",
    'zeroSupport', r."zeroSupport", 'itemsSnapshot', r."itemsSnapshot", 'legacyCounts', r."legacyCounts",
    'decision', r."decision", 'decidedAt', r."decidedAt", 'decidedById', r."decidedById", 'decidedByName', r."decidedByName",
    'decisionReason', r."decisionReason", 'zeroSupportApproved', r."zeroSupportApproved")
$$;
-- Staff: identity/display only. Never email, password, activation/reset tokens or expiries, sessionVersion, calendarVersion.
CREATE FUNCTION "report_project_staff"(r "staff") RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('id', r."id", 'name', r."name", 'role', r."role", 'active', r."active", 'departedOn', r."departedOn")
$$;
CREATE FUNCTION "report_project_hotels"(r "hotels") RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('id', r."id", 'region', r."region", 'name', r."name", 'sortOrder', r."sortOrder", 'active', r."active")
$$;
-- change_logs: only the four milestone fields are a report source (the concrete reason of a managed earlier/added date
-- exists only here). Any other field is not a source row; moving into/out of the set becomes an I/D.
CREATE FUNCTION "report_project_change_logs"(r "change_logs") RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN r."field" IN ('dispatchDate', 'copyDate', 'printDate', 'goLiveDate') THEN jsonb_build_object(
    'id', r."id", 'caseId', r."caseId", 'field', r."field", 'fromValue', r."fromValue", 'toValue', r."toValue",
    'reason', r."reason", 'operator', r."operator", 'createdAt', r."createdAt") END
$$;

-- ── capture triggers ──────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION "report_capture_cases"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM "report_source_capture"('cases', NULL, NEW."id", NULL, "report_project_cases"(NEW));
  ELSIF TG_OP = 'UPDATE' THEN PERFORM "report_source_capture"('cases', OLD."id", NEW."id", "report_project_cases"(OLD), "report_project_cases"(NEW));
  ELSE PERFORM "report_source_capture"('cases', OLD."id", NULL, "report_project_cases"(OLD), NULL); END IF;
  RETURN NULL;
END;
$$;
CREATE FUNCTION "report_capture_collaborators"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM "report_source_capture"('_collaborators', NULL, NEW."A" || ':' || NEW."B", NULL, "report_project_collaborators"(NEW));
  ELSIF TG_OP = 'UPDATE' THEN PERFORM "report_source_capture"('_collaborators', OLD."A" || ':' || OLD."B", NEW."A" || ':' || NEW."B", "report_project_collaborators"(OLD), "report_project_collaborators"(NEW));
  ELSE PERFORM "report_source_capture"('_collaborators', OLD."A" || ':' || OLD."B", NULL, "report_project_collaborators"(OLD), NULL); END IF;
  RETURN NULL;
END;
$$;
CREATE FUNCTION "report_capture_case_deliveries"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM "report_source_capture"('case_deliveries', NULL, NEW."id", NULL, "report_project_case_deliveries"(NEW));
  ELSIF TG_OP = 'UPDATE' THEN PERFORM "report_source_capture"('case_deliveries', OLD."id", NEW."id", "report_project_case_deliveries"(OLD), "report_project_case_deliveries"(NEW));
  ELSE PERFORM "report_source_capture"('case_deliveries', OLD."id", NULL, "report_project_case_deliveries"(OLD), NULL); END IF;
  RETURN NULL;
END;
$$;
CREATE FUNCTION "report_capture_case_cycles"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM "report_source_capture"('case_cycles', NULL, NEW."id", NULL, "report_project_case_cycles"(NEW));
  ELSIF TG_OP = 'UPDATE' THEN PERFORM "report_source_capture"('case_cycles', OLD."id", NEW."id", "report_project_case_cycles"(OLD), "report_project_case_cycles"(NEW));
  ELSE PERFORM "report_source_capture"('case_cycles', OLD."id", NULL, "report_project_case_cycles"(OLD), NULL); END IF;
  RETURN NULL;
END;
$$;
CREATE FUNCTION "report_capture_case_lifecycle_requests"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM "report_source_capture"('case_lifecycle_requests', NULL, NEW."id", NULL, "report_project_case_lifecycle_requests"(NEW));
  ELSIF TG_OP = 'UPDATE' THEN PERFORM "report_source_capture"('case_lifecycle_requests', OLD."id", NEW."id", "report_project_case_lifecycle_requests"(OLD), "report_project_case_lifecycle_requests"(NEW));
  ELSE PERFORM "report_source_capture"('case_lifecycle_requests', OLD."id", NULL, "report_project_case_lifecycle_requests"(OLD), NULL); END IF;
  RETURN NULL;
END;
$$;
CREATE FUNCTION "report_capture_case_schedule_requests"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM "report_source_capture"('case_schedule_requests', NULL, NEW."id", NULL, "report_project_case_schedule_requests"(NEW));
  ELSIF TG_OP = 'UPDATE' THEN PERFORM "report_source_capture"('case_schedule_requests', OLD."id", NEW."id", "report_project_case_schedule_requests"(OLD), "report_project_case_schedule_requests"(NEW));
  ELSE PERFORM "report_source_capture"('case_schedule_requests', OLD."id", NULL, "report_project_case_schedule_requests"(OLD), NULL); END IF;
  RETURN NULL;
END;
$$;
CREATE FUNCTION "report_capture_case_delivery_submissions"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM "report_source_capture"('case_delivery_submissions', NULL, NEW."id", NULL, "report_project_case_delivery_submissions"(NEW));
  ELSIF TG_OP = 'UPDATE' THEN PERFORM "report_source_capture"('case_delivery_submissions', OLD."id", NEW."id", "report_project_case_delivery_submissions"(OLD), "report_project_case_delivery_submissions"(NEW));
  ELSE PERFORM "report_source_capture"('case_delivery_submissions', OLD."id", NULL, "report_project_case_delivery_submissions"(OLD), NULL); END IF;
  RETURN NULL;
END;
$$;
CREATE FUNCTION "report_capture_staff"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM "report_source_capture"('staff', NULL, NEW."id"::text, NULL, "report_project_staff"(NEW));
  ELSIF TG_OP = 'UPDATE' THEN PERFORM "report_source_capture"('staff', OLD."id"::text, NEW."id"::text, "report_project_staff"(OLD), "report_project_staff"(NEW));
  ELSE PERFORM "report_source_capture"('staff', OLD."id"::text, NULL, "report_project_staff"(OLD), NULL); END IF;
  RETURN NULL;
END;
$$;
CREATE FUNCTION "report_capture_hotels"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM "report_source_capture"('hotels', NULL, NEW."id"::text, NULL, "report_project_hotels"(NEW));
  ELSIF TG_OP = 'UPDATE' THEN PERFORM "report_source_capture"('hotels', OLD."id"::text, NEW."id"::text, "report_project_hotels"(OLD), "report_project_hotels"(NEW));
  ELSE PERFORM "report_source_capture"('hotels', OLD."id"::text, NULL, "report_project_hotels"(OLD), NULL); END IF;
  RETURN NULL;
END;
$$;
CREATE FUNCTION "report_capture_change_logs"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM "report_source_capture"('change_logs', NULL, NEW."id"::text, NULL, "report_project_change_logs"(NEW));
  ELSIF TG_OP = 'UPDATE' THEN PERFORM "report_source_capture"('change_logs', OLD."id"::text, NEW."id"::text, "report_project_change_logs"(OLD), "report_project_change_logs"(NEW));
  ELSE PERFORM "report_source_capture"('change_logs', OLD."id"::text, NULL, "report_project_change_logs"(OLD), NULL); END IF;
  RETURN NULL;
END;
$$;
-- TRUNCATE would bypass row capture on tables that have no other truncate guard.
CREATE FUNCTION "report_source_no_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is a report source; delete rows instead of TRUNCATE so the change is recorded', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$;

-- ── baseline: lock every source, then read fresh committed rows, write B events, and only then stamp coverage ──
-- Called by this migration and by the explicit admin reset (after its purge). LOCK ... SHARE ROW EXCLUSIVE waits for
-- writers already holding the tables and blocks new ones until the caller's transaction ends; each statement below runs
-- with a fresh READ COMMITTED snapshot taken after the lock, so nothing committed while waiting is missed. A caller in
-- REPEATABLE READ / SERIALIZABLE would read an older snapshot, so it is refused.
-- Once coverage exists the baseline is NOT a free re-run (that would silently push coverageStart and erase history): it is
-- allowed only inside the explicit report purge (design_pm.allow_report_purge = on) with every old event already deleted.
CREATE FUNCTION "report_source_baseline"() RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'report_source_baseline() requires READ COMMITTED (fresh snapshot after the source locks)' USING ERRCODE = '25000';
  END IF;
  LOCK TABLE "cases", "_collaborators", "case_deliveries", "case_cycles", "case_lifecycle_requests", "case_schedule_requests",
    "case_delivery_submissions", "staff", "hotels", "change_logs" IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM "report_source_coverage") AND (coalesce(current_setting('design_pm.allow_report_purge', true), '') <> 'on'
      OR EXISTS (SELECT 1 FROM "report_source_events")) THEN
    RAISE EXCEPTION 'report source history exists: rebaseline only after an explicit full report purge' USING ERRCODE = '23514';
  END IF;
  PERFORM set_config('design_pm.report_baseline', 'on', true);
  PERFORM "report_source_append"('staff', r."id"::text, 'B', "report_project_staff"(r)) FROM "staff" r ORDER BY r."id";
  PERFORM "report_source_append"('hotels', r."id"::text, 'B', "report_project_hotels"(r)) FROM "hotels" r ORDER BY r."id";
  PERFORM "report_source_append"('cases', r."id", 'B', "report_project_cases"(r)) FROM "cases" r ORDER BY r."id";
  PERFORM "report_source_append"('_collaborators', r."A" || ':' || r."B", 'B', "report_project_collaborators"(r)) FROM "_collaborators" r ORDER BY r."A", r."B";
  PERFORM "report_source_append"('case_cycles', r."id", 'B', "report_project_case_cycles"(r)) FROM "case_cycles" r ORDER BY r."id";
  PERFORM "report_source_append"('case_deliveries', r."id", 'B', "report_project_case_deliveries"(r)) FROM "case_deliveries" r ORDER BY r."id";
  PERFORM "report_source_append"('case_delivery_submissions', r."id", 'B', "report_project_case_delivery_submissions"(r)) FROM "case_delivery_submissions" r ORDER BY r."id";
  PERFORM "report_source_append"('case_schedule_requests', r."id", 'B', "report_project_case_schedule_requests"(r)) FROM "case_schedule_requests" r ORDER BY r."id";
  PERFORM "report_source_append"('case_lifecycle_requests', r."id", 'B', "report_project_case_lifecycle_requests"(r)) FROM "case_lifecycle_requests" r ORDER BY r."id";
  PERFORM "report_source_append"('change_logs', r."id"::text, 'B', "report_project_change_logs"(r)) FROM "change_logs" r
    WHERE "report_project_change_logs"(r) IS NOT NULL ORDER BY r."id";
  -- coverageStart is read from the DB clock after every baseline row was written.
  INSERT INTO "report_source_coverage" ("id", "coverageStart", "baselineEventMaxId", "baselineTransactionId")
  VALUES (1, clock_timestamp(), (SELECT max("id") FROM "report_source_events"), pg_current_xact_id()::text::bigint)
  ON CONFLICT ("id") DO UPDATE SET "coverageStart" = EXCLUDED."coverageStart", "baselineEventMaxId" = EXCLUDED."baselineEventMaxId",
    "baselineTransactionId" = EXCLUDED."baselineTransactionId";
  PERFORM set_config('design_pm.report_baseline', 'off', true);
END;
$$;

-- Take the locks first so trigger creation and the baseline see one settled state.
LOCK TABLE "cases", "_collaborators", "case_deliveries", "case_cycles", "case_lifecycle_requests", "case_schedule_requests",
  "case_delivery_submissions", "staff", "hotels", "change_logs" IN SHARE ROW EXCLUSIVE MODE;

CREATE TRIGGER "report_capture" AFTER INSERT OR UPDATE OR DELETE ON "cases" FOR EACH ROW EXECUTE FUNCTION "report_capture_cases"();
CREATE TRIGGER "report_capture" AFTER INSERT OR UPDATE OR DELETE ON "_collaborators" FOR EACH ROW EXECUTE FUNCTION "report_capture_collaborators"();
CREATE TRIGGER "report_capture" AFTER INSERT OR UPDATE OR DELETE ON "case_deliveries" FOR EACH ROW EXECUTE FUNCTION "report_capture_case_deliveries"();
CREATE TRIGGER "report_capture" AFTER INSERT OR UPDATE OR DELETE ON "case_cycles" FOR EACH ROW EXECUTE FUNCTION "report_capture_case_cycles"();
CREATE TRIGGER "report_capture" AFTER INSERT OR UPDATE OR DELETE ON "case_lifecycle_requests" FOR EACH ROW EXECUTE FUNCTION "report_capture_case_lifecycle_requests"();
CREATE TRIGGER "report_capture" AFTER INSERT OR UPDATE OR DELETE ON "case_schedule_requests" FOR EACH ROW EXECUTE FUNCTION "report_capture_case_schedule_requests"();
CREATE TRIGGER "report_capture" AFTER INSERT OR UPDATE OR DELETE ON "case_delivery_submissions" FOR EACH ROW EXECUTE FUNCTION "report_capture_case_delivery_submissions"();
CREATE TRIGGER "report_capture" AFTER INSERT OR UPDATE OR DELETE ON "staff" FOR EACH ROW EXECUTE FUNCTION "report_capture_staff"();
CREATE TRIGGER "report_capture" AFTER INSERT OR UPDATE OR DELETE ON "hotels" FOR EACH ROW EXECUTE FUNCTION "report_capture_hotels"();
CREATE TRIGGER "report_capture" AFTER INSERT OR UPDATE OR DELETE ON "change_logs" FOR EACH ROW EXECUTE FUNCTION "report_capture_change_logs"();
CREATE TRIGGER "report_source_no_truncate" BEFORE TRUNCATE ON "cases" FOR EACH STATEMENT EXECUTE FUNCTION "report_source_no_truncate"();
CREATE TRIGGER "report_source_no_truncate" BEFORE TRUNCATE ON "_collaborators" FOR EACH STATEMENT EXECUTE FUNCTION "report_source_no_truncate"();
CREATE TRIGGER "report_source_no_truncate" BEFORE TRUNCATE ON "staff" FOR EACH STATEMENT EXECUTE FUNCTION "report_source_no_truncate"();
CREATE TRIGGER "report_source_no_truncate" BEFORE TRUNCATE ON "hotels" FOR EACH STATEMENT EXECUTE FUNCTION "report_source_no_truncate"();
CREATE TRIGGER "report_source_no_truncate" BEFORE TRUNCATE ON "change_logs" FOR EACH STATEMENT EXECUTE FUNCTION "report_source_no_truncate"();
-- The evidence tables' older guards allow TRUNCATE under design_pm.allow_delivery_purge; as report sources they are now
-- refused unconditionally too (the explicit admin reset deletes rows, which is captured, then purges and rebaselines).
CREATE TRIGGER "report_source_no_truncate" BEFORE TRUNCATE ON "case_deliveries" FOR EACH STATEMENT EXECUTE FUNCTION "report_source_no_truncate"();
CREATE TRIGGER "report_source_no_truncate" BEFORE TRUNCATE ON "case_cycles" FOR EACH STATEMENT EXECUTE FUNCTION "report_source_no_truncate"();
CREATE TRIGGER "report_source_no_truncate" BEFORE TRUNCATE ON "case_lifecycle_requests" FOR EACH STATEMENT EXECUTE FUNCTION "report_source_no_truncate"();
CREATE TRIGGER "report_source_no_truncate" BEFORE TRUNCATE ON "case_schedule_requests" FOR EACH STATEMENT EXECUTE FUNCTION "report_source_no_truncate"();
CREATE TRIGGER "report_source_no_truncate" BEFORE TRUNCATE ON "case_delivery_submissions" FOR EACH STATEMENT EXECUTE FUNCTION "report_source_no_truncate"();

SELECT "report_source_baseline"();

COMMIT;
