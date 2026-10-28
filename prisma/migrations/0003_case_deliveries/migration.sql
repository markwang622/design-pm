-- REPORTS-P1-A: additive delivery evidence. No existing row is read, rewritten or backfilled.

-- CreateTable
CREATE TABLE "case_deliveries" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "itemKey" TEXT,
    "itemName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit" TEXT NOT NULL,
    "deliveredOn" DATE NOT NULL,
    "note" TEXT,
    "recordedById" INTEGER NOT NULL,
    "recordedByName" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" INTEGER,
    "voidedByName" TEXT,
    "voidReason" TEXT,
    "voidRequestId" TEXT,

    CONSTRAINT "case_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "case_deliveries_voidRequestId_key" ON "case_deliveries"("voidRequestId");

-- CreateIndex
CREATE INDEX "case_deliveries_caseId_deliveredOn_idx" ON "case_deliveries"("caseId", "deliveredOn");

-- CreateIndex
CREATE INDEX "case_deliveries_caseId_itemKey_idx" ON "case_deliveries"("caseId", "itemKey");

-- AddForeignKey
ALTER TABLE "case_deliveries" ADD CONSTRAINT "case_deliveries_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Value rules mirrored by the API (the database stays authoritative under any client).
ALTER TABLE "case_deliveries" ADD CONSTRAINT "case_deliveries_id_format" CHECK ("id" ~ '^[A-Za-z0-9_-]{8,100}$');
ALTER TABLE "case_deliveries" ADD CONSTRAINT "case_deliveries_kind" CHECK ("kind" IN ('main', 'extension', 'support'));
ALTER TABLE "case_deliveries" ADD CONSTRAINT "case_deliveries_quantity" CHECK ("quantity" BETWEEN 0 AND 1000000);
ALTER TABLE "case_deliveries" ADD CONSTRAINT "case_deliveries_output_rule" CHECK (
  ("kind" IN ('main', 'extension') AND "quantity" >= 1)
  OR ("kind" = 'support' AND ("quantity" >= 1 OR char_length(btrim(coalesce("note", ''))) >= 4))
);
ALTER TABLE "case_deliveries" ADD CONSTRAINT "case_deliveries_unit" CHECK ("unit" IN ('件'));
ALTER TABLE "case_deliveries" ADD CONSTRAINT "case_deliveries_item_name" CHECK (char_length(btrim("itemName")) BETWEEN 1 AND 200);
ALTER TABLE "case_deliveries" ADD CONSTRAINT "case_deliveries_item_key" CHECK ("itemKey" IS NULL OR "itemKey" ~ '^[A-Za-z0-9_-]{8,64}$');
ALTER TABLE "case_deliveries" ADD CONSTRAINT "case_deliveries_note" CHECK ("note" IS NULL OR (char_length(btrim("note")) >= 1 AND char_length("note") <= 1000));
ALTER TABLE "case_deliveries" ADD CONSTRAINT "case_deliveries_recorder" CHECK (char_length(btrim("recordedByName")) >= 1);
ALTER TABLE "case_deliveries" ADD CONSTRAINT "case_deliveries_request_fingerprint" CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$');
ALTER TABLE "case_deliveries" ADD CONSTRAINT "case_deliveries_delivered_on" CHECK ("deliveredOn" >= DATE '2000-01-01');
ALTER TABLE "case_deliveries" ADD CONSTRAINT "case_deliveries_void_stamp" CHECK (
  ("voidedAt" IS NULL AND "voidedById" IS NULL AND "voidedByName" IS NULL AND "voidReason" IS NULL AND "voidRequestId" IS NULL)
  OR ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL AND char_length(btrim(coalesce("voidedByName", ''))) >= 1
      AND char_length(btrim(coalesce("voidReason", ''))) >= 2 AND "voidRequestId" ~ '^[A-Za-z0-9_-]{8,100}$')
);

-- Append-only evidence: the only permitted UPDATE is a one-time void stamp. DELETE/TRUNCATE
-- require the transaction-local purge switch used by explicit full resets (factory reset, Demo reset).
CREATE FUNCTION "protect_case_deliveries"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF coalesce(current_setting('design_pm.allow_delivery_purge', true), '') = 'on' THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'case_deliveries is append-only evidence' USING ERRCODE = '23514';
  ELSIF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('design_pm.allow_delivery_purge', true), '') = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'case_deliveries is append-only evidence' USING ERRCODE = '23514';
  END IF;
  IF OLD."voidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'voided delivery records are immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."id", NEW."caseId", NEW."itemKey", NEW."itemName", NEW."kind", NEW."quantity", NEW."unit", NEW."deliveredOn",
         NEW."note", NEW."recordedById", NEW."recordedByName", NEW."requestFingerprint", NEW."createdAt")
     IS DISTINCT FROM
     ROW(OLD."id", OLD."caseId", OLD."itemKey", OLD."itemName", OLD."kind", OLD."quantity", OLD."unit", OLD."deliveredOn",
         OLD."note", OLD."recordedById", OLD."recordedByName", OLD."requestFingerprint", OLD."createdAt") THEN
    RAISE EXCEPTION 'delivery record content is immutable; void and append a new record' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "case_deliveries_append_only" BEFORE UPDATE OR DELETE ON "case_deliveries"
FOR EACH ROW EXECUTE FUNCTION "protect_case_deliveries"();
CREATE TRIGGER "case_deliveries_no_truncate" BEFORE TRUNCATE ON "case_deliveries"
FOR EACH STATEMENT EXECUTE FUNCTION "protect_case_deliveries"();
