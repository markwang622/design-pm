-- REPORTS-P2-D2: per-account release-notice dismissals (one row per account and notice version). Additive only.

-- CreateTable
CREATE TABLE "member_notice_dismissals" (
    "id" SERIAL NOT NULL,
    "staffId" INTEGER NOT NULL,
    "noticeId" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_notice_dismissals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "member_notice_dismissals_staffId_noticeId_key" ON "member_notice_dismissals"("staffId", "noticeId");

-- AddForeignKey
ALTER TABLE "member_notice_dismissals" ADD CONSTRAINT "member_notice_dismissals_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Notice ids are stable version ids from the server-side whitelist module.
ALTER TABLE "member_notice_dismissals" ADD CONSTRAINT "member_notice_dismissals_notice_id" CHECK ("noticeId" ~ '^[A-Za-z0-9_-]{4,80}$');
