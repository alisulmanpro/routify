-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "storeTransactionId" VARCHAR(200),
ADD COLUMN     "testMode" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "storePurchaseId" VARCHAR(24);

-- CreateTable
CREATE TABLE "store_purchases" (
    "id" VARCHAR(24) NOT NULL,
    "userId" VARCHAR(24) NOT NULL,
    "store" VARCHAR(16) NOT NULL,
    "purchaseKey" VARCHAR(512) NOT NULL,
    "productId" VARCHAR(200) NOT NULL,
    "planKey" "PlanKey" NOT NULL,
    "billingCycle" "BillingCycle" NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "autoRenew" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "environment" VARCHAR(16) NOT NULL,
    "lastEventAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "store_purchases_userId_idx" ON "store_purchases"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "store_purchases_store_purchaseKey_key" ON "store_purchases"("store", "purchaseKey");

-- CreateIndex
CREATE UNIQUE INDEX "payments_storeTransactionId_key" ON "payments"("storeTransactionId");

-- AddForeignKey
ALTER TABLE "store_purchases" ADD CONSTRAINT "store_purchases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
