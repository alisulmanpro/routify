-- At most one active route per rider, enforced by the database (start() also checks it under the rider's lock).
-- Prisma 5 cannot express a partial index in schema.prisma, so it lives only here; see the note on model Route.
-- This fails if a rider already has two active routes; the dev branch (copy of production, 2026-10-22) had none.
CREATE UNIQUE INDEX "routes_one_active_per_rider" ON "routes"("riderId") WHERE "status" = 'active';
