-- CreateEnum
CREATE TYPE "Role" AS ENUM ('rider', 'owner_admin');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "RoutePreference" AS ENUM ('smart', 'nearest_first', 'shortest');

-- CreateEnum
CREATE TYPE "AreaSource" AS ENUM ('gps', 'manual');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('pending', 'in_progress', 'delivered', 'failed');

-- CreateEnum
CREATE TYPE "GeocodeStatus" AS ENUM ('pending', 'found', 'approximate', 'not_found');

-- CreateEnum
CREATE TYPE "FailureReason" AS ENUM ('customer_unavailable', 'customer_refused', 'wrong_address', 'phone_unreachable', 'business_closed', 'payment_issue', 'other');

-- CreateEnum
CREATE TYPE "RouteStatus" AS ENUM ('planned', 'active', 'completed');

-- CreateEnum
CREATE TYPE "PlanKey" AS ENUM ('trial', 'starter', 'pro');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('monthly', 'annual');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'succeeded', 'failed', 'refunded');

-- CreateEnum
CREATE TYPE "AuditStatus" AS ENUM ('success', 'failure');

-- CreateTable
CREATE TABLE "users" (
    "id" VARCHAR(24) NOT NULL,
    "fullName" VARCHAR(120) NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "routePreference" "RoutePreference" NOT NULL DEFAULT 'smart',
    "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3),
    "areaCity" VARCHAR(120),
    "areaCountry" VARCHAR(120),
    "areaCountryCode" VARCHAR(2),
    "areaLatitude" DOUBLE PRECISION,
    "areaLongitude" DOUBLE PRECISION,
    "areaSource" "AreaSource",
    "areaConfirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" VARCHAR(24) NOT NULL,
    "riderId" VARCHAR(24) NOT NULL,
    "trackingId" VARCHAR(80) NOT NULL,
    "customerName" VARCHAR(160) NOT NULL DEFAULT '',
    "customerPhone" VARCHAR(32) NOT NULL DEFAULT '',
    "addressRaw" VARCHAR(400) NOT NULL,
    "addressNormalized" TEXT,
    "addressLatitude" DOUBLE PRECISION,
    "addressLongitude" DOUBLE PRECISION,
    "addressGeocoded" BOOLEAN NOT NULL DEFAULT false,
    "addressApproximate" BOOLEAN NOT NULL DEFAULT false,
    "geocodeStatus" "GeocodeStatus" NOT NULL DEFAULT 'pending',
    "payment" JSONB,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'pending',
    "proofPhotoKey" TEXT,
    "proofPhotoUrl" TEXT,
    "proofCapturedAt" TIMESTAMP(3),
    "note" VARCHAR(1000),
    "failureReason" "FailureReason",
    "failureNote" VARCHAR(1000),
    "serviceDate" VARCHAR(10) NOT NULL,
    "routeId" VARCHAR(24),
    "stopOrder" INTEGER,
    "arrivedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routes" (
    "id" VARCHAR(24) NOT NULL,
    "riderId" VARCHAR(24) NOT NULL,
    "serviceDate" VARCHAR(10) NOT NULL,
    "preference" "RoutePreference" NOT NULL,
    "status" "RouteStatus" NOT NULL DEFAULT 'planned',
    "originLatitude" DOUBLE PRECISION,
    "originLongitude" DOUBLE PRECISION,
    "distanceKm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "durationMin" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_stops" (
    "routeId" VARCHAR(24) NOT NULL,
    "deliveryId" VARCHAR(24) NOT NULL,
    "order" INTEGER NOT NULL,
    "legDistanceKm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "legDurationMin" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "route_stops_pkey" PRIMARY KEY ("routeId","deliveryId")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" VARCHAR(24) NOT NULL,
    "riderId" VARCHAR(24) NOT NULL,
    "date" VARCHAR(10) NOT NULL,
    "summary" JSONB NOT NULL,
    "fileKey" TEXT NOT NULL,
    "fileSize" INTEGER,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" VARCHAR(24) NOT NULL,
    "key" "PlanKey" NOT NULL,
    "name" TEXT NOT NULL,
    "monthlyPrice" DOUBLE PRECISION NOT NULL,
    "annualPrice" DOUBLE PRECISION NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "deliveriesPerMonth" INTEGER NOT NULL,
    "reportsPerMonth" INTEGER NOT NULL,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" VARCHAR(24) NOT NULL,
    "userId" VARCHAR(24) NOT NULL,
    "planKey" "PlanKey" NOT NULL,
    "billingCycle" "BillingCycle" NOT NULL DEFAULT 'monthly',
    "status" "SubscriptionStatus" NOT NULL,
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "pendingPlanKey" "PlanKey",
    "pendingBillingCycle" "BillingCycle",
    "pendingPaymentId" VARCHAR(24),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" VARCHAR(24) NOT NULL,
    "userId" VARCHAR(24) NOT NULL,
    "subscriptionId" VARCHAR(24),
    "planKey" "PlanKey" NOT NULL,
    "billingCycle" "BillingCycle" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "providerRef" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" VARCHAR(24) NOT NULL,
    "userId" VARCHAR(24) NOT NULL,
    "family" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedByHash" TEXT,
    "userAgent" VARCHAR(300),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" VARCHAR(24) NOT NULL,
    "actorId" VARCHAR(24),
    "actorEmail" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "status" "AuditStatus" NOT NULL DEFAULT 'success',
    "ip" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" VARCHAR(24) NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "geocode_cache" (
    "key" TEXT NOT NULL,
    "found" BOOLEAN NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "normalized" TEXT,
    "approximate" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "geocode_cache_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_createdAt_idx" ON "users"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "deliveries_riderId_status_idx" ON "deliveries"("riderId", "status");

-- CreateIndex
CREATE INDEX "deliveries_riderId_serviceDate_idx" ON "deliveries"("riderId", "serviceDate");

-- CreateIndex
CREATE INDEX "deliveries_serviceDate_status_idx" ON "deliveries"("serviceDate", "status");

-- CreateIndex
CREATE INDEX "deliveries_routeId_idx" ON "deliveries"("routeId");

-- CreateIndex
CREATE INDEX "deliveries_createdAt_idx" ON "deliveries"("createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_riderId_trackingId_key" ON "deliveries"("riderId", "trackingId");

-- CreateIndex
CREATE INDEX "routes_riderId_status_idx" ON "routes"("riderId", "status");

-- CreateIndex
CREATE INDEX "routes_status_idx" ON "routes"("status");

-- CreateIndex
CREATE INDEX "route_stops_deliveryId_idx" ON "route_stops"("deliveryId");

-- CreateIndex
CREATE INDEX "reports_date_idx" ON "reports"("date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "reports_riderId_date_key" ON "reports"("riderId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "plans_key_key" ON "plans"("key");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_userId_key" ON "subscriptions"("userId");

-- CreateIndex
CREATE INDEX "subscriptions_planKey_idx" ON "subscriptions"("planKey");

-- CreateIndex
CREATE INDEX "subscriptions_status_idx" ON "subscriptions"("status");

-- CreateIndex
CREATE INDEX "subscriptions_createdAt_idx" ON "subscriptions"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "payments_userId_idx" ON "payments"("userId");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE INDEX "payments_createdAt_idx" ON "payments"("createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens"("family");

-- CreateIndex
CREATE INDEX "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "settings_key_key" ON "settings"("key");

-- CreateIndex
CREATE INDEX "geocode_cache_expiresAt_idx" ON "geocode_cache"("expiresAt");

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "routes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routes" ADD CONSTRAINT "routes_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
