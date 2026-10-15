-- How each route's stop order was optimised ("road" or "straight_line").
ALTER TABLE "routes" ADD COLUMN "optimization" VARCHAR(20);
