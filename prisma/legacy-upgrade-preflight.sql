-- AlterTable
ALTER TABLE "_collaborators" ADD CONSTRAINT "_collaborators_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "_collaborators_AB_unique";

-- AlterTable
ALTER TABLE "cases" ADD COLUMN     "currentCycleId" TEXT,
ADD COLUMN     "deliveryMode" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN     "deliveryModeById" INTEGER,
ADD COLUMN     "deliveryModeByName" TEXT,
ADD COLUMN     "deliveryModeFingerprint" TEXT,
ADD COLUMN     "deliveryModeReason" TEXT,
ADD COLUMN     "deliveryModeRequestId" TEXT,
ADD COLUMN     "deliveryModeSince" TIMESTAMP(3),
ADD COLUMN     "lifecycleMode" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN     "lifecycleModeById" INTEGER,
ADD COLUMN     "lifecycleModeByName" TEXT,
ADD COLUMN     "lifecycleModeFingerprint" TEXT,
ADD COLUMN     "lifecycleModeReason" TEXT,
ADD COLUMN     "lifecycleModeRequestId" TEXT,
ADD COLUMN     "lifecycleModeSince" TIMESTAMP(3),
ADD COLUMN     "lifecycleStatus" TEXT,
ADD COLUMN     "pendingDeliverySubmissionId" TEXT,
ADD COLUMN     "pendingLifecycleRequestId" TEXT,
ADD COLUMN     "pendingScheduleRequestId" TEXT,
ADD COLUMN     "scheduleBaseline" JSONB,
ADD COLUMN     "scheduleMode" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN     "scheduleModeById" INTEGER,
ADD COLUMN     "scheduleModeByName" TEXT,
ADD COLUMN     "scheduleModeFingerprint" TEXT,
ADD COLUMN     "scheduleModeReason" TEXT,
ADD COLUMN     "scheduleModeRequestId" TEXT,
ADD COLUMN     "scheduleModeSince" TIMESTAMP(3);

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
    "cycleId" TEXT,

    CONSTRAINT "case_deliveries_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "member_notice_dismissals" (
    "id" SERIAL NOT NULL,
    "staffId" INTEGER NOT NULL,
    "noticeId" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_notice_dismissals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_source_events" (
    "id" BIGSERIAL NOT NULL,
    "capturedAt" TIMESTAMPTZ(6) NOT NULL,
    "transactionId" BIGINT NOT NULL,
    "tableName" TEXT NOT NULL,
    "rowKey" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "report_source_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_source_coverage" (
    "id" INTEGER NOT NULL,
    "coverageStart" TIMESTAMPTZ(6) NOT NULL,
    "baselineEventMaxId" BIGINT,
    "baselineTransactionId" BIGINT NOT NULL,

    CONSTRAINT "report_source_coverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
CREATE TABLE "deployment_identity" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "environment" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_identity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "case_deliveries_voidRequestId_key" ON "case_deliveries"("voidRequestId");

-- CreateIndex
CREATE INDEX "case_deliveries_caseId_deliveredOn_idx" ON "case_deliveries"("caseId", "deliveredOn");

-- CreateIndex
CREATE INDEX "case_deliveries_caseId_itemKey_idx" ON "case_deliveries"("caseId", "itemKey");

-- CreateIndex
CREATE UNIQUE INDEX "case_delivery_submissions_decisionOperationId_key" ON "case_delivery_submissions"("decisionOperationId");

-- CreateIndex
CREATE INDEX "case_delivery_submissions_caseId_createdAt_idx" ON "case_delivery_submissions"("caseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "case_schedule_requests_decisionOperationId_key" ON "case_schedule_requests"("decisionOperationId");

-- CreateIndex
CREATE INDEX "case_schedule_requests_caseId_createdAt_idx" ON "case_schedule_requests"("caseId", "createdAt");

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
CREATE UNIQUE INDEX "member_notice_dismissals_staffId_noticeId_key" ON "member_notice_dismissals"("staffId", "noticeId");

-- CreateIndex
CREATE INDEX "report_source_events_transactionId_idx" ON "report_source_events"("transactionId");

-- CreateIndex
CREATE INDEX "report_source_events_tableName_rowKey_idx" ON "report_source_events"("tableName", "rowKey");

-- CreateIndex
CREATE UNIQUE INDEX "report_snapshots_idempotencyKey_key" ON "report_snapshots"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "report_snapshots_periodKind_startDate_rulesVersion_revision_key" ON "report_snapshots"("periodKind", "startDate", "rulesVersion", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "report_job_runs_idempotencyKey_key" ON "report_job_runs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "report_job_runs_status_nextAttemptAt_idx" ON "report_job_runs"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "report_job_runs_periodKind_startDate_rulesVersion_key" ON "report_job_runs"("periodKind", "startDate", "rulesVersion");

-- CreateIndex
CREATE UNIQUE INDEX "deployment_identity_instanceId_key" ON "deployment_identity"("instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "cases_deliveryModeRequestId_key" ON "cases"("deliveryModeRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "cases_pendingDeliverySubmissionId_key" ON "cases"("pendingDeliverySubmissionId");

-- CreateIndex
CREATE UNIQUE INDEX "cases_scheduleModeRequestId_key" ON "cases"("scheduleModeRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "cases_pendingScheduleRequestId_key" ON "cases"("pendingScheduleRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "cases_lifecycleModeRequestId_key" ON "cases"("lifecycleModeRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "cases_currentCycleId_key" ON "cases"("currentCycleId");

-- CreateIndex
CREATE UNIQUE INDEX "cases_pendingLifecycleRequestId_key" ON "cases"("pendingLifecycleRequestId");

-- AddForeignKey
ALTER TABLE "case_deliveries" ADD CONSTRAINT "case_deliveries_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_delivery_submissions" ADD CONSTRAINT "case_delivery_submissions_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_schedule_requests" ADD CONSTRAINT "case_schedule_requests_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_cycles" ADD CONSTRAINT "case_cycles_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_lifecycle_requests" ADD CONSTRAINT "case_lifecycle_requests_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_notice_dismissals" ADD CONSTRAINT "member_notice_dismissals_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

