-- REPORTS-P3-E1b: immutable work-report snapshots. Additive only; no business row and no report source row is changed.
-- A snapshot embeds everything it displays (no foreign key to deletable business rows): renaming or deleting a case never
-- changes an old report. Versions of one period (kind, startDate, rulesVersion) are 1, 2, 3 … ; a revision links to its
-- immediate predecessor (self link, NO ACTION — never cascades). Rows are never updated; DELETE only inside an explicit
-- full purge (design_pm.allow_report_purge = on, as the full reset does); TRUNCATE is always refused.
-- generatedAt is the DB clock_timestamp() at insert (never caller-supplied). Timestamps are microsecond timestamptz.
-- SQL-only behaviour (not modelled in schema.prisma): the self link, CHECKs and triggers below.
BEGIN;

CREATE TABLE "report_snapshots" (
    "id" TEXT NOT NULL,
    "periodKind" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDateExclusive" DATE NOT NULL,
    "cutoffInstant" TIMESTAMPTZ(6) NOT NULL,
    "knowledgeCutoff" TIMESTAMPTZ(6) NOT NULL,
    "observedAt" TIMESTAMPTZ(6) NOT NULL,
    "generatedAt" TIMESTAMPTZ(6) NOT NULL,
    "coverageStart" TIMESTAMPTZ(6),
    "rulesVersion" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "supersedesId" TEXT,
    "revisionReason" TEXT,
    "generatedById" INTEGER,
    "generatedByName" TEXT,
    "trigger" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadSha256" TEXT NOT NULL,
    "sourceCompleteness" TEXT NOT NULL,
    "endStateMaxEventId" BIGINT,
    "knowledgeMaxEventId" BIGINT,

    CONSTRAINT "report_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "report_snapshots_idempotencyKey_key" ON "report_snapshots"("idempotencyKey");
CREATE UNIQUE INDEX "report_snapshots_periodKind_startDate_rulesVersion_revision_key" ON "report_snapshots"("periodKind", "startDate", "rulesVersion", "revision");

ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_supersedes_fkey" FOREIGN KEY ("supersedesId") REFERENCES "report_snapshots"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_id_check" CHECK ("id" ~ '^wr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_period_check" CHECK (
  "startDate" >= DATE '2000-01-01' AND "endDateExclusive" <= DATE '2101-01-01' AND (
    ("periodKind" = 'week' AND extract(isodow FROM "startDate") = 1 AND "endDateExclusive" = "startDate" + 7)
    OR ("periodKind" = 'month' AND extract(day FROM "startDate") = 1 AND "endDateExclusive" = ("startDate" + interval '1 month')::date)
    OR ("periodKind" = 'quarter' AND extract(day FROM "startDate") = 1 AND extract(month FROM "startDate") IN (1, 4, 7, 10)
        AND "endDateExclusive" = ("startDate" + interval '3 months')::date)));
-- C is the real instant of Taipei 00:00 (UTC+8, no DST) on endDateExclusive; K ≥ C; K ≤ observedAt ≤ generatedAt.
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_cutoff_check" CHECK (
  "cutoffInstant" = (("endDateExclusive"::timestamp - interval '8 hours') AT TIME ZONE 'UTC')
  AND "knowledgeCutoff" >= "cutoffInstant" AND "observedAt" >= "knowledgeCutoff" AND "generatedAt" >= "observedAt");
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_revision_check" CHECK (
  "revision" >= 1 AND (("revision" = 1) = ("supersedesId" IS NULL)) AND (("revision" = 1) = ("revisionReason" IS NULL))
  AND ("revisionReason" IS NULL OR length(btrim("revisionReason")) BETWEEN 2 AND 500));
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_actor_check" CHECK (
  "trigger" IN ('manual', 'scheduled') AND ("trigger" = 'scheduled' OR ("generatedById" IS NOT NULL AND "generatedByName" IS NOT NULL)));
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_request_check" CHECK (
  "idempotencyKey" ~ '^[A-Za-z0-9_-]{8,100}$' AND "requestFingerprint" ~ '^[0-9a-f]{64}$' AND "rulesVersion" ~ '^[a-z0-9.-]{1,40}$');
-- IS TRUE: a missing key makes the comparison NULL, which a bare CHECK would accept. The hash format is checked here; its
-- agreement with the canonical JSON is computed and verified by the service (src/lib/workReportPayload.js).
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_payload_check" CHECK ((
  jsonb_typeof("payload") = 'object' AND "payloadSha256" ~ '^[0-9a-f]{64}$'
  AND "sourceCompleteness" IN ('insufficient', 'partial', 'complete')
  AND jsonb_typeof("payload" -> 'meta') = 'object' AND jsonb_typeof("payload" -> 'sourceCompleteness') = 'object'
  AND jsonb_typeof("payload" -> 'summary') = 'object' AND jsonb_typeof("payload" -> 'rows') = 'array'
  AND jsonb_typeof("payload" -> 'unresolved') = 'array' AND jsonb_typeof("payload" -> 'hotelOrder') = 'array'
  AND jsonb_typeof("payload" -> 'staff') = 'array'
  AND "payload" -> 'sourceCompleteness' ->> 'status' = "sourceCompleteness"
  AND "payload" -> 'meta' ->> 'rulesVersion' = "rulesVersion"
  AND jsonb_typeof("payload" -> 'meta' -> 'revision') = 'number'
  AND ("payload" -> 'meta' -> 'revision') = to_jsonb("revision")) IS TRUE);

-- Insert: generatedAt from the DB clock; a revision's parent must be the same period + rules version, exactly one
-- revision earlier, with a knowledge cutoff not later than the new one. Update never; delete only in a full purge.
CREATE FUNCTION "report_snapshots_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."generatedAt" := clock_timestamp();
    IF NEW."supersedesId" IS NOT NULL THEN
      SELECT "periodKind", "startDate", "rulesVersion", "revision", "knowledgeCutoff" INTO parent FROM "report_snapshots" WHERE "id" = NEW."supersedesId";
      IF NOT FOUND OR parent."periodKind" <> NEW."periodKind" OR parent."startDate" <> NEW."startDate" OR parent."rulesVersion" <> NEW."rulesVersion"
         OR parent."revision" <> NEW."revision" - 1 OR parent."knowledgeCutoff" > NEW."knowledgeCutoff" THEN
        RAISE EXCEPTION 'report snapshot revision must follow its immediate predecessor of the same period and rules version' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('design_pm.allow_report_purge', true), '') = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'report_snapshots are immutable (delete only in an explicit full purge)' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'report_snapshots are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "report_snapshots_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "report_snapshots"
FOR EACH ROW EXECUTE FUNCTION "report_snapshots_guard"();
CREATE TRIGGER "report_snapshots_no_truncate" BEFORE TRUNCATE ON "report_snapshots"
FOR EACH STATEMENT EXECUTE FUNCTION "report_snapshots_guard"();

COMMIT;
