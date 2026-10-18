-- Stops can be added with only an address, and riders name each route.
ALTER TABLE "deliveries" ALTER COLUMN "trackingId" DROP NOT NULL;
ALTER TABLE "routes" ADD COLUMN "name" VARCHAR(80);
