-- REPORTS-P1-C1: per-case delivery mode and delivery submission evidence.
-- Additive only: existing cases keep their rows and become 'legacy' through the column default.

-- AlterTable
ALTER TABLE "cases" ADD COLUMN     "deliveryMode" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN     "deliveryModeById" INTEGER,
ADD COLUMN     "deliveryModeByName" TEXT,
ADD COLUMN     "deliveryModeFingerprint" TEXT,
ADD COLUMN     "deliveryModeReason" TEXT,
ADD COLUMN     "deliveryModeRequestId" TEXT,
ADD COLUMN     "deliveryModeSince" TIMESTAMP(3),
ADD COLUMN     "pendingDeliverySubmissionId" TEXT;

-- CreateTable
CREATE TABLE "case_delivery_submissions" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "submittedById" INTEGER NOT NULL,
    "submittedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completenessConfirmed" BOOLEAN NOT NULL,
    "caseContentVersion" INTEGER NOT NULL,
    "caseUpdatedAt" TIMESTAMP(3) NOT NULL,
    "archivePath" TEXT NOT NULL,
    "recordIds" JSONB NOT NULL,
    "recordsFingerprint" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "zeroSupport" JSONB NOT NULL,
    "itemsSnapshot" JSONB NOT NULL,
    "legacyCounts" JSONB NOT NULL,
    "decision" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedById" INTEGER,
    "decidedByName" TEXT,
    "decisionReason" TEXT,
    "decisionOperationId" TEXT,
    "decisionFingerprint" TEXT,
    "zeroSupportApproved" BOOLEAN,

    CONSTRAINT "case_delivery_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "case_delivery_submissions_decisionOperationId_key" ON "case_delivery_submissions"("decisionOperationId");

-- CreateIndex
CREATE INDEX "case_delivery_submissions_caseId_createdAt_idx" ON "case_delivery_submissions"("caseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "cases_deliveryModeRequestId_key" ON "cases"("deliveryModeRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "cases_pendingDeliverySubmissionId_key" ON "cases"("pendingDeliverySubmissionId");

-- AddForeignKey
ALTER TABLE "case_delivery_submissions" ADD CONSTRAINT "case_delivery_submissions_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Case mode rules. Records cases always carry who (real staff id + name snapshot), when and why;
-- legacy cases carry no stamp. Every alternative is null-safe: a CHECK that evaluates to UNKNOWN
-- would be accepted by PostgreSQL, so nullable columns are tested with explicit IS [NOT] NULL.
ALTER TABLE "cases" ADD CONSTRAINT "cases_delivery_mode" CHECK ("deliveryMode" IN ('legacy', 'records'));
ALTER TABLE "cases" ADD CONSTRAINT "cases_delivery_mode_stamp" CHECK (
  ("deliveryMode" = 'legacy' AND "deliveryModeSince" IS NULL AND "deliveryModeById" IS NULL AND "deliveryModeByName" IS NULL
     AND "deliveryModeReason" IS NULL AND "deliveryModeRequestId" IS NULL AND "deliveryModeFingerprint" IS NULL AND "pendingDeliverySubmissionId" IS NULL)
  OR ("deliveryMode" = 'records' AND "deliveryModeSince" IS NOT NULL AND "deliveryModeById" IS NOT NULL
     AND char_length(btrim(coalesce("deliveryModeReason", ''))) >= 2
     AND char_length(btrim(coalesce("deliveryModeByName", ''))) >= 1
     AND (("deliveryModeRequestId" IS NULL AND "deliveryModeFingerprint" IS NULL)
          OR ("deliveryModeRequestId" IS NOT NULL AND "deliveryModeFingerprint" IS NOT NULL
              AND "deliveryModeRequestId" ~ '^[A-Za-z0-9_-]{8,100}$' AND "deliveryModeFingerprint" ~ '^[0-9a-f]{64}$')))
);
ALTER TABLE "cases" ADD CONSTRAINT "cases_pending_delivery_submission" CHECK (
  "pendingDeliverySubmissionId" IS NULL OR ("deliveryMode" = 'records' AND "status" = 'review_done')
);

-- Submission values mirrored by the API.
ALTER TABLE "case_delivery_submissions" ADD CONSTRAINT "case_delivery_submissions_id_format" CHECK ("id" ~ '^[A-Za-z0-9_-]{8,100}$');
ALTER TABLE "case_delivery_submissions" ADD CONSTRAINT "case_delivery_submissions_fingerprints" CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$' AND "recordsFingerprint" ~ '^[0-9a-f]{64}$');
ALTER TABLE "case_delivery_submissions" ADD CONSTRAINT "case_delivery_submissions_confirmed" CHECK ("completenessConfirmed" = true);
ALTER TABLE "case_delivery_submissions" ADD CONSTRAINT "case_delivery_submissions_archive" CHECK (char_length(btrim("archivePath")) >= 1);
ALTER TABLE "case_delivery_submissions" ADD CONSTRAINT "case_delivery_submissions_submitter" CHECK (char_length(btrim("submittedByName")) >= 1 AND "caseContentVersion" >= 0);
ALTER TABLE "case_delivery_submissions" ADD CONSTRAINT "case_delivery_submissions_evidence" CHECK (
  jsonb_typeof("recordIds") = 'array' AND jsonb_array_length("recordIds") >= 1 AND jsonb_typeof("summary") = 'array'
  AND jsonb_typeof("zeroSupport") = 'array' AND jsonb_typeof("itemsSnapshot") = 'array' AND jsonb_typeof("legacyCounts") = 'object'
);
ALTER TABLE "case_delivery_submissions" ADD CONSTRAINT "case_delivery_submissions_decision" CHECK (
  ("decision" IS NULL AND "decidedAt" IS NULL AND "decidedById" IS NULL AND "decidedByName" IS NULL AND "decisionReason" IS NULL
     AND "decisionOperationId" IS NULL AND "decisionFingerprint" IS NULL AND "zeroSupportApproved" IS NULL)
  OR ("decision" IS NOT NULL AND "decidedAt" IS NOT NULL AND "decidedById" IS NOT NULL
     AND "decisionOperationId" IS NOT NULL AND "decisionFingerprint" IS NOT NULL
     AND "decision" IN ('approved', 'rejected', 'withdrawn', 'cancelled')
     AND char_length(btrim(coalesce("decidedByName", ''))) >= 1 AND "decisionOperationId" ~ '^[A-Za-z0-9_:-]{8,120}$'
     AND "decisionFingerprint" ~ '^[0-9a-f]{64}$'
     AND ("decision" = 'approved' OR char_length(btrim(coalesce("decisionReason", ''))) >= 2)
     AND (("decision" = 'approved' AND "zeroSupportApproved" IS NOT NULL) OR ("decision" <> 'approved' AND "zeroSupportApproved" IS NULL))
     AND ("decision" <> 'approved' OR jsonb_array_length("zeroSupport") = 0 OR "zeroSupportApproved" = true))
);

-- Submission evidence is append-only: the only permitted UPDATE is the one-time decision stamp.
-- DELETE/TRUNCATE follow the same transaction-local purge switch as case_deliveries (full resets only).
CREATE FUNCTION "protect_case_delivery_submissions"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF coalesce(current_setting('design_pm.allow_delivery_purge', true), '') = 'on' THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'case_delivery_submissions is append-only evidence' USING ERRCODE = '23514';
  ELSIF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('design_pm.allow_delivery_purge', true), '') = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'case_delivery_submissions is append-only evidence' USING ERRCODE = '23514';
  END IF;
  IF OLD."decidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'decided delivery submissions are immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."id", NEW."caseId", NEW."requestFingerprint", NEW."submittedById", NEW."submittedByName", NEW."createdAt",
         NEW."completenessConfirmed", NEW."caseContentVersion", NEW."caseUpdatedAt", NEW."archivePath", NEW."recordIds",
         NEW."recordsFingerprint", NEW."summary", NEW."zeroSupport", NEW."itemsSnapshot", NEW."legacyCounts")
     IS DISTINCT FROM
     ROW(OLD."id", OLD."caseId", OLD."requestFingerprint", OLD."submittedById", OLD."submittedByName", OLD."createdAt",
         OLD."completenessConfirmed", OLD."caseContentVersion", OLD."caseUpdatedAt", OLD."archivePath", OLD."recordIds",
         OLD."recordsFingerprint", OLD."summary", OLD."zeroSupport", OLD."itemsSnapshot", OLD."legacyCounts") THEN
    RAISE EXCEPTION 'delivery submission evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "case_delivery_submissions_append_only" BEFORE UPDATE OR DELETE ON "case_delivery_submissions"
FOR EACH ROW EXECUTE FUNCTION "protect_case_delivery_submissions"();
CREATE TRIGGER "case_delivery_submissions_no_truncate" BEFORE TRUNCATE ON "case_delivery_submissions"
FOR EACH STATEMENT EXECUTE FUNCTION "protect_case_delivery_submissions"();

-- Records mode is one-way and its adoption stamp cannot be rewritten.
CREATE FUNCTION "protect_case_delivery_mode"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."deliveryMode" = 'records' AND (
       NEW."deliveryMode" IS DISTINCT FROM OLD."deliveryMode"
       OR NEW."deliveryModeSince" IS DISTINCT FROM OLD."deliveryModeSince"
       OR NEW."deliveryModeById" IS DISTINCT FROM OLD."deliveryModeById"
       OR NEW."deliveryModeByName" IS DISTINCT FROM OLD."deliveryModeByName"
       OR NEW."deliveryModeReason" IS DISTINCT FROM OLD."deliveryModeReason"
       OR NEW."deliveryModeRequestId" IS DISTINCT FROM OLD."deliveryModeRequestId"
       OR NEW."deliveryModeFingerprint" IS DISTINCT FROM OLD."deliveryModeFingerprint") THEN
    RAISE EXCEPTION 'records delivery mode is one-way and its adoption stamp is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "cases_delivery_mode_one_way" BEFORE UPDATE ON "cases"
FOR EACH ROW EXECUTE FUNCTION "protect_case_delivery_mode"();
