import { useCallback, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from './useFocusEffect';
import { ApiRequestError, get } from './api';
import { useAuth } from './auth';
import { todayKey } from './format';
import { queryClient } from './query';
import { fetchHome as fetchHomeV2, fetchRoute as fetchRouteV2 } from './v2api';
import type { Dashboard, LeftOver, Route, RouteListItem } from './types';

/** Refetches when the screen comes back into view (not on the first focus: the query has just loaded then). */
export function useRefetchOnFocus(refetch: () => unknown) {
  const first = useRef(true);
  useFocusEffect(useCallback(() => {
    if (first.current) { first.current = false; return; }
    void refetch();
  }, [refetch]));
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
  };
}

/** Home's data: the saved copy at once (also after a restart), refreshed in the background and on every return to Home. */
export function useHome() {
  const { user } = useAuth();
  const date = todayKey();
  const query = useQuery({ queryKey: ['home', user?.id, date], queryFn: () => fetchHome(date), enabled: !!user });
  useRefetchOnFocus(query.refetch);
  return query;
}

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
  useRefetchOnFocus(query.refetch);
  const setRoute = useCallback((route: Route | null) => {
    client.setQueryData(key, route);
    if (route) client.setQueryData(routeKey(user?.id, route.id), route);
    // Home's counts change with the route.
    void client.invalidateQueries({ queryKey: ['home', user?.id] });
  }, [client, key, user?.id]);
  return { ...query, route: query.data ?? null, setRoute };
}
