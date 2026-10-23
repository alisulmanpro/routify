import { api, getWithEtag, newId } from './api';
import { toDelivery, toRoute, type V2BatchStop, type V2EventResult, type V2Home, type V2Route } from './v2';
import type { Delivery, FailureReason, Route } from './types';

export const fetchHome = async (date: string) => (await api<V2Home>('/v2/rider/home', { query: { date } })).data;

/** The route with its stops. With the copy we already have (`saved`), the server answers "not changed" without a body. */
export async function fetchRoute(routeId: string, saved?: (Route & { etag?: string }) | null): Promise<Route & { etag?: string }> {
  const res = await getWithEtag<V2Route>(`/v2/routes/${routeId}`, saved?.etag);
  if (res.notModified && saved) return saved;
  return toRoute(res.data!, res.etag);
}

/** The route underway, else the latest one planned for `date` or earlier (light); null when there is none. */
export async function fetchCurrentRoute(date: string): Promise<Route | null> {
  const route = (await api<V2Route | null>('/v2/routes/current', { query: { date } })).data;
  return route ? toRoute(route) : null;
}

export type StopEvent = { type: 'arrive' | 'deliver' | 'fail'; reason?: FailureReason; note?: string; allowSkip?: boolean };

/**
 * Arrive / deliver / fail in one request. The Idempotency-Key is made once per action, so the API client's automatic
 * retries after a dropped connection can never apply it twice. Deliver and fail record the arrival themselves.
 */
export async function sendStopEvent(stopId: string, event: StopEvent): Promise<V2EventResult> {
  return (await api<V2EventResult>(`/v2/stops/${stopId}/events`, { method: 'POST', body: event, headers: { 'Idempotency-Key': newId() } })).data;
}

export type NewStop = {
  trackingId?: string; address: { raw: string; normalized?: string }; serviceDate: string;
  location?: { latitude: number; longitude: number }; customer?: { name?: string; phone?: string }; note?: string;
  /** The rider confirmed another parcel for an Eircode already on that day (P4.7). */
  secondParcel?: boolean;
};

const BATCH = 500;

/**
 * Saves stops (any number, 500 per request). Each gets an id made on the phone, so a request repeated after a lost
 * answer returns the stops it already saved instead of adding them again.
 */
export async function createStops(stops: NewStop[]): Promise<Delivery[]> {
  const out: Delivery[] = [];
  for (let i = 0; i < stops.length; i += BATCH) {
    const items = stops.slice(i, i + BATCH).map((stop) => ({ ...stop, clientId: newId() }));
    const res = await api<{ stops: V2BatchStop[] }>('/v2/deliveries/batch', { method: 'POST', body: { items }, idempotent: true });
    out.push(...res.data.stops.map((s) => toDelivery(s, { serviceDate: s.serviceDate, routeId: s.routeId })));
  }
  return out;
}
