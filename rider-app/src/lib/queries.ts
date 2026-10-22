import { useCallback, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from './useFocusEffect';
import { ApiRequestError, get } from './api';
import { useAuth } from './auth';
import { todayKey } from './format';
import type { Dashboard, Delivery, LeftOver, Route, RouteListItem } from './types';

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

async function fetchHome(date: string): Promise<HomeData> {
  const [dash, byDate, left, later] = await Promise.all([
    get<Dashboard>('/rider/dashboard', { date }),
    get<RouteListItem[]>('/routes/by-date', { from: date }),
    get<LeftOver>('/routes/leftover', { date }),
    get<Delivery[]>('/deliveries', { status: 'pending', dateFrom: date, limit: 100, sort: 'recent' }),
  ]);
  const unplanned = new Map<string, number>();
  for (const d of later.data) if (!d.routeId) unplanned.set(d.serviceDate, (unplanned.get(d.serviceDate) || 0) + 1);
  return {
    dashboard: dash.data, routes: byDate.data, leftOver: left.data,
    unplanned: [...unplanned].map(([day, count]) => ({ date: day, count })).sort((a, b) => a.date.localeCompare(b.date)),
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

async function fetchRoute(routeId: string | undefined): Promise<Route | null> {
  return (await get<Route | null>(routeId ? `/routes/${routeId}` : '/routes/current', routeId ? undefined : { date: todayKey() })).data;
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
  const query = useQuery({ queryKey: key, queryFn: () => fetchRoute(routeId), enabled: !!user });
  useRefetchOnFocus(query.refetch);
  const setRoute = useCallback((route: Route | null) => {
    client.setQueryData(key, route);
    if (route) client.setQueryData(routeKey(user?.id, route.id), route);
    // Home's counts change with the route.
    void client.invalidateQueries({ queryKey: ['home', user?.id] });
  }, [client, key, user?.id]);
  return { ...query, route: query.data ?? null, setRoute };
}
