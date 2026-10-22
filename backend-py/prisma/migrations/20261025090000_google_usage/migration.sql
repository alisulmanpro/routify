-- CreateTable
CREATE TABLE "google_usage" (
    "day" VARCHAR(10) NOT NULL,
    "riderId" VARCHAR(24) NOT NULL,
    "api" VARCHAR(32) NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "google_usage_pkey" PRIMARY KEY ("day","riderId","api")
);

-- CreateIndex
CREATE INDEX "google_usage_riderId_day_idx" ON "google_usage"("riderId", "day");

