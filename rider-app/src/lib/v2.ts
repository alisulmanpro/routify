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
  /** The subscription status, as /subscriptions/me reports it ("inactive" without one). */
  plan: { status: string };
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

/**
 * A stop event's result applied to a saved route: the stop's status, the route's progress and status, and what is next.
 * So going back to the route after delivering needs no reload (the event's answer already says all that).
 */
export function applyEventToRoute<R extends Route>(route: R, result: V2EventResult): R {
  if (!route.stops.some((s) => s.delivery.id === result.stop.id)) return route;
  return {
    ...route,
    stops: route.stops.map((s) => (s.delivery.id === result.stop.id ? { ...s, delivery: applyStopEvent(s.delivery, result.stop) } : s)),
    ...(result.route && result.route.id === route.id
      ? { status: result.route.status, progress: result.route.progress, summary: result.route.summary, currentStopId: result.route.nextStopId }
      : {}),
    // The saved ETag described the route before this change.
    etag: undefined,
  };
}

const OPEN_STATUSES: Delivery['status'][] = ['pending', 'in_progress'];

/**
 * An event saved on the phone but not sent yet (offline), applied to the saved route so the screens show it at once:
 * the stop's status, the counts, what is next, and "completed" once nothing is open. Replaced by the server's answer
 * when the event goes out.
 */
export function applyLocalEvent<R extends Route>(route: R, stopId: string, event: { type: 'arrive' | 'deliver' | 'fail'; reason?: FailureReason; at: string }): R {
  if (!route.stops.some((s) => s.delivery.id === stopId)) return route;
  const status: Delivery['status'] = event.type === 'arrive' ? 'in_progress' : event.type === 'deliver' ? 'delivered' : 'failed';
  const stops = route.stops.map((s) => {
    if (s.delivery.id !== stopId) return s;
    const d = s.delivery;
    if (event.type === 'arrive' && d.status !== 'pending') return s;
    return {
      ...s,
      delivery: {
        ...d, status,
        arrivedAt: d.arrivedAt ?? event.at,
        deliveredAt: status === 'delivered' ? event.at : null,
        failedAt: status === 'failed' ? event.at : null,
        failure: status === 'failed' ? { reason: event.reason ?? 'other', note: null } : null,
      },
    };
  });
  const count = (st: Delivery['status']) => stops.filter((s) => s.delivery.status === st).length;
  const open = stops.filter((s) => OPEN_STATUSES.includes(s.delivery.status));
  const done = stops.length - open.length;
  return {
    ...route,
    stops,
    status: route.status === 'active' && !open.length ? 'completed' : route.status,
    progress: { total: stops.length, done, remaining: stops.length - done },
    summary: { ...route.summary, total: stops.length, delivered: count('delivered'), failed: count('failed'), pending: open.length },
    currentStopId: open[0]?.delivery.id ?? null,
  };
}
