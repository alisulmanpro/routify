-- P7.6: per-minute request counts and latency histograms per API process, read by the worker's alerts.
CREATE TABLE "request_minutes" (
    "minute" TIMESTAMP(3) NOT NULL,
    "instance" VARCHAR(64) NOT NULL,
    "requests" INTEGER NOT NULL,
    "errors" INTEGER NOT NULL,
    "buckets" JSONB NOT NULL,

    CONSTRAINT "request_minutes_pkey" PRIMARY KEY ("minute","instance")
);

CREATE INDEX "request_minutes_minute_idx" ON "request_minutes"("minute");
