-- AlterTable
ALTER TABLE "deliveries" ADD COLUMN     "lastEventAt" TIMESTAMP(3),
ADD COLUMN     "secondParcel" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "stop_events" (
    "id" VARCHAR(24) NOT NULL,
    "riderId" VARCHAR(24) NOT NULL,
    "deliveryId" VARCHAR(24) NOT NULL,
    "routeId" VARCHAR(24),
    "type" VARCHAR(16) NOT NULL,
    "outcome" VARCHAR(16) NOT NULL,
    "fromStatus" VARCHAR(16) NOT NULL,
    "toStatus" VARCHAR(16) NOT NULL,
    "reason" VARCHAR(40),
    "note" VARCHAR(1000),
    "at" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" VARCHAR(8) NOT NULL,
    "idempotencyKey" VARCHAR(128),

    CONSTRAINT "stop_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deleted_deliveries" (
    "id" VARCHAR(24) NOT NULL,
    "riderId" VARCHAR(24) NOT NULL,
    "routeId" VARCHAR(24),
    "reason" VARCHAR(20) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deleted_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stop_events_deliveryId_at_idx" ON "stop_events"("deliveryId", "at");

-- CreateIndex
CREATE INDEX "stop_events_riderId_receivedAt_idx" ON "stop_events"("riderId", "receivedAt");

-- CreateIndex
CREATE INDEX "deleted_deliveries_riderId_deletedAt_idx" ON "deleted_deliveries"("riderId", "deletedAt");

-- CreateIndex
CREATE INDEX "deleted_deliveries_routeId_deletedAt_idx" ON "deleted_deliveries"("routeId", "deletedAt");

-- AddForeignKey
ALTER TABLE "stop_events" ADD CONSTRAINT "stop_events_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deleted_deliveries" ADD CONSTRAINT "deleted_deliveries_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

