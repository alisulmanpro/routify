/**
 * The /api/v2 response shapes and adapters to the app's own types, so screens keep working on `Delivery` / `Route`
 * while the app downloads only the fields they show. Pure functions (unit-tested in tests/v2.test.ts).
 */
import type { Delivery, FailureReason, Route } from './types';

export type V2Stop = {
  id: string; order: number | null; status: Delivery['status']; trackingId: string; customerName: string;
  address: Delivery['address']; legDistanceKm: number; legDurationMin: number;
  failureReason: FailureReason | null; deliveredAt: string | null; failedAt: string | null;
};
export type V2RouteSummary = Pick<Route, 'id' | 'status' | 'progress' | 'summary'> & { nextStopId: string | null };
export type V2Route = V2RouteSummary & Pick<Route, 'name' | 'serviceDate' | 'preference' | 'optimization' | 'origin' | 'distanceKm' | 'durationMin'> & {
  stops: V2Stop[];
};
export type V2Home = {
  rider: { fullName: string }; date: string;
  today: { total: number; delivered: number; failed: number; progressPercent: number };
  routes: { id: string; name: string | null; status: Route['status']; serviceDate: string; stops: number }[];
  unplanned: { date: string; count: number }[];
  leftOver: { total: number; days: { date: string; count: number }[] };
};
export type V2EventResult = { stop: V2Stop; route: V2RouteSummary | null };
export type V2BatchStop = V2Stop & { clientId: string; serviceDate: string; routeId: string | null };

/** The same flags the v1 API puts on a delivery. */
const flagsOf = (address: Delivery['address']) => [
  ...(address.geocodeStatus === 'not_found' ? ['location_not_found'] : []),
  ...(address.geocodeStatus === 'approximate' || address.approximate ? ['approximate_location'] : []),
];

/** A v2 stop as the app's Delivery. Fields v2 leaves out (phone, notes, proof) are empty: the stop details screen loads them from v1. */
export function toDelivery(stop: V2Stop, where: { serviceDate: string; routeId: string | null }): Delivery {
  return {
    id: stop.id, riderId: '', trackingId: stop.trackingId,
    customer: { name: stop.customerName, phone: '' },
    address: stop.address,
    status: stop.status,
    proof: null, note: null,
    failure: stop.failureReason ? { reason: stop.failureReason, note: null } : null,
    serviceDate: where.serviceDate, routeId: where.routeId, stopOrder: stop.order,
    arrivedAt: null, deliveredAt: stop.deliveredAt, failedAt: stop.failedAt, createdAt: '',
    flags: flagsOf(stop.address),
  };
}

/** A v2 route as the app's Route. `etag` rides along so the next load can ask "changed since?". */
export function toRoute(route: V2Route, etag?: string | null): Route & { etag?: string } {
  return {
    id: route.id, name: route.name, status: route.status, preference: route.preference, serviceDate: route.serviceDate,
    origin: route.origin, distanceKm: route.distanceKm, durationMin: route.durationMin,
    startedAt: null, completedAt: null,
    stops: route.stops.map((stop, i) => ({
      order: stop.order ?? i + 1, legDistanceKm: stop.legDistanceKm, legDurationMin: stop.legDurationMin,
      delivery: toDelivery(stop, { serviceDate: route.serviceDate, routeId: route.id }),
    })),
    progress: route.progress, currentStopId: route.nextStopId, summary: route.summary, optimization: route.optimization, newStops: 0,
    ...(etag ? { etag } : {}),
  };
}

/** A stop event's result applied to the full delivery the stop details screen shows (keeps phone, notes, photo). */
export function applyStopEvent(delivery: Delivery, stop: V2Stop): Delivery {
  return {
    ...delivery, status: stop.status, deliveredAt: stop.deliveredAt, failedAt: stop.failedAt,
    failure: stop.failureReason ? { reason: stop.failureReason, note: delivery.failure?.note ?? null } : delivery.failure,
    arrivedAt: delivery.arrivedAt ?? (stop.status !== 'pending' ? new Date().toISOString() : null),
  };
}

/** The earlier open stop named in a v2 EARLIER_STOPS_REMAIN error's details, if any. */
export function earlierStopOf(details: unknown[] | undefined): { trackingId: string; stopOrder: number } | null {
  const first = details?.[0] as { trackingId?: unknown; stopOrder?: unknown } | undefined;
  return first && typeof first.stopOrder === 'number' ? { trackingId: typeof first.trackingId === 'string' ? first.trackingId : '', stopOrder: first.stopOrder } : null;
}
