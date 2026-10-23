-- AlterTable
ALTER TABLE "deliveries" ADD COLUMN     "clientId" VARCHAR(36);

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_riderId_clientId_key" ON "deliveries"("riderId", "clientId");

