-- CreateTable
CREATE TABLE "jobs" (
    "id" VARCHAR(24) NOT NULL,
    "riderId" VARCHAR(24),
    "type" VARCHAR(32) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'queued',
    "routeId" VARCHAR(24),
    "input" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_geometries" (
    "routeId" VARCHAR(24) NOT NULL,
    "version" VARCHAR(64) NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "route_geometries_pkey" PRIMARY KEY ("routeId")
);

-- CreateIndex
CREATE INDEX "jobs_status_createdAt_idx" ON "jobs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "jobs_riderId_createdAt_idx" ON "jobs"("riderId", "createdAt");

-- CreateIndex
CREATE INDEX "jobs_routeId_status_idx" ON "jobs"("routeId", "status");

