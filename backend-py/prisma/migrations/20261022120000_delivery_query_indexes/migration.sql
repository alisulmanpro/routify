-- DropIndex: (routeId, status, stopOrder) below covers every query that used it.
DROP INDEX "deliveries_routeId_idx";

-- CreateIndex
CREATE INDEX "deliveries_riderId_createdAt_idx" ON "deliveries"("riderId", "createdAt");

-- CreateIndex
CREATE INDEX "deliveries_routeId_status_stopOrder_idx" ON "deliveries"("routeId", "status", "stopOrder");
