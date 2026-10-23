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

-- The deployment marker is a singleton and must not be changed by reset scripts.
ALTER TABLE "deployment_identity" ADD CONSTRAINT "deployment_identity_singleton" CHECK ("id" = 1);
ALTER TABLE "deployment_identity" ADD CONSTRAINT "deployment_identity_environment" CHECK ("environment" IN ('production', 'demo', 'restore'));
CREATE FUNCTION "protect_deployment_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'deployment_identity is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "deployment_identity_no_change" BEFORE UPDATE OR DELETE ON "deployment_identity"
FOR EACH ROW EXECUTE FUNCTION "protect_deployment_identity"();
CREATE TRIGGER "deployment_identity_no_truncate" BEFORE TRUNCATE ON "deployment_identity"
FOR EACH STATEMENT EXECUTE FUNCTION "protect_deployment_identity"();
