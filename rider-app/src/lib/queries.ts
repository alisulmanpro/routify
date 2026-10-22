import { useCallback, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from './useFocusEffect';
import { ApiRequestError, get } from './api';
import { useAuth } from './auth';
import { todayKey } from './format';
import { queryClient } from './query';
import { fetchHome as fetchHomeV2, fetchRoute as fetchRouteV2 } from './v2api';
import { applyEventToRoute, type V2EventResult } from './v2';
import type { Dashboard, LeftOver, Route, RouteListItem } from './types';

/**
 * Refetches when the screen comes back into view, unless its data is still fresh: e.g. a route the app just updated
 * from a stop event's answer is not loaded again. Not on the first focus (the query has just loaded then).
 */
export function useRefetchOnFocus(refetch: () => unknown, queryKey?: readonly unknown[]) {
  const first = useRef(true);
  const keyText = queryKey ? JSON.stringify(queryKey) : null;
  useFocusEffect(useCallback(() => {
    if (first.current) { first.current = false; return; }
    if (!keyText || isStale(JSON.parse(keyText))) void refetch();
  }, [refetch, keyText]));
}

const STALE_MS = 30_000;
/** Whether a query's data is older than its staleTime or was marked out of date (read at focus time). */
function isStale(key: readonly unknown[]) {
  const state = queryClient.getQueryState(key);
  return !state || state.isInvalidated || Date.now() - state.dataUpdatedAt > STALE_MS;
}

/**
 * A stop event's answer, written into every saved copy of its route (so returning to the route costs no request), and
 * Home marked out of date (it reloads when it is next shown, not now).
 */
export function rememberStopEvent(result: V2EventResult) {
  queryClient.setQueriesData<Route | null>({ queryKey: ['route'] }, (route) => (route ? applyEventToRoute(route, result) : route));
  void queryClient.invalidateQueries({ queryKey: ['home'], refetchType: 'none' });
}

export const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiRequestError ? err.message : err instanceof TypeError ? '' : err ? fallback : '';

// ---- Home ----

/** What Home shows. `unplanned`: stops added but not planned into a route yet, counted per day. */
export type HomeData = {
  dashboard: Pick<Dashboard, 'rider' | 'date' | 'total' | 'delivered' | 'failed' | 'progressPercent'>;
  routes: Pick<RouteListItem, 'id' | 'name' | 'status' | 'serviceDate' | 'progress'>[];
  unplanned: { date: string; count: number }[];
  leftOver: LeftOver;
  /** For the "Free trial" / "Upgrade" chip. */
  planStatus: string;
};

/** GET /v2/rider/home: one request with counts only (it used to be four, one of them up to 100 whole stops). */
async function fetchHome(date: string): Promise<HomeData> {
  const home = await fetchHomeV2(date);
  return {
    dashboard: { rider: { id: '', fullName: home.rider.fullName }, date: home.date, ...home.today },
    // Home reads a route's stop count (progress.total) and status; finished routes are not listed any more.
    routes: home.routes.map((r) => ({ id: r.id, name: r.name, status: r.status, serviceDate: r.serviceDate, progress: { total: r.stops, done: 0, remaining: r.stops } })),
    unplanned: home.unplanned,
    leftOver: home.leftOver,
    planStatus: home.plan.status,
  };
}

/**
 * Home's data: the saved copy at once (also after a restart), refreshed in the background and on every return to Home.
 * Other parts of Home that only read it pass `refreshOnFocus: false`, so a return to Home is still one request.
 */
export function useHome({ refreshOnFocus = true }: { refreshOnFocus?: boolean } = {}) {
  const { user } = useAuth();
  const date = todayKey();
  const key = ['home', user?.id, date];
  const query = useQuery({ queryKey: key, queryFn: () => fetchHome(date), enabled: !!user });
  useRefetchOnFocus(refreshOnFocus ? query.refetch : noop, key);
  return query;
}

const noop = () => {};

// ---- Routes ----

async function fetchRoute(userId: string | undefined, routeId: string | undefined): Promise<Route | null> {
  // "Today's / the one underway" has no v2 endpoint; a known route comes from v2 (light, and 304 when unchanged).
  if (!routeId) return (await get<Route | null>('/routes/current', { date: todayKey() })).data;
  return fetchRouteV2(routeId, queryClient.getQueryData<Route & { etag?: string }>(routeKey(userId, routeId)));
}

export const routeKey = (userId: string | undefined, routeId: string | undefined) => ['route', userId, routeId ?? 'current'] as const;

/**
 * A route (or, without `routeId`, today's / the one underway), drawn from the saved copy first. `setRoute` puts a route
 * returned by an action (start, optimise) into the cache, so every screen showing it updates.
 */
export function useRouteData(routeId: string | undefined) {
  const { user } = useAuth();
  const client = useQueryClient();
  const key = useMemo(() => routeKey(user?.id, routeId), [user?.id, routeId]);
  const query = useQuery({ queryKey: key, queryFn: () => fetchRoute(user?.id, routeId), enabled: !!user });
  useRefetchOnFocus(query.refetch, key);
  const setRoute = useCallback((route: Route | null) => {
    client.setQueryData(key, route);
    if (route) client.setQueryData(routeKey(user?.id, route.id), route);
    // Home's counts change with the route: reload them when Home is next shown.
    void client.invalidateQueries({ queryKey: ['home', user?.id], refetchType: 'none' });
  }, [client, key, user?.id]);
  return { ...query, route: query.data ?? null, setRoute };
}
