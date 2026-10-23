-- CreateTable
CREATE TABLE "idempotency_keys" (
    "riderId" VARCHAR(24) NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "scope" VARCHAR(120) NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'in_progress',
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("riderId","key")
);

-- CreateIndex
CREATE INDEX "idempotency_keys_expiresAt_idx" ON "idempotency_keys"("expiresAt");

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

