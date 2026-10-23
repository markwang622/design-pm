-- AlterTable
ALTER TABLE "_collaborators" ADD CONSTRAINT "_collaborators_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "_collaborators_AB_unique";

-- CreateTable
CREATE TABLE "deployment_identity" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "environment" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_identity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deployment_identity_instanceId_key" ON "deployment_identity"("instanceId");
