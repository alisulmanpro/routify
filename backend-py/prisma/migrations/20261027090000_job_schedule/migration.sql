-- P7.3: retries wait until "runAfter"; scheduled jobs (maintenance, alerts) carry a "dedupKey" so only one is queued per slot.
ALTER TABLE "jobs" ADD COLUMN "runAfter" TIMESTAMP(3);
ALTER TABLE "jobs" ADD COLUMN "dedupKey" VARCHAR(64);

CREATE UNIQUE INDEX "jobs_dedupKey_key" ON "jobs"("dedupKey");
