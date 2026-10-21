import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useFocusEffect } from '../lib/useFocusEffect';
import { get, post, ApiRequestError } from '../lib/api';
import { openDirections as directionsTo } from '../lib/deliveryActions';
import { dayLabel, formatMinutes, stopLabel, todayKey } from '../lib/format';
import type { Route } from '../lib/types';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen } from '../components/Kit';
import { LightButton, LightError, LightPill, type LightTone } from '../components/LightKit';
import GoogleRouteMap, { type MapStop } from '../components/GoogleRouteMap';
import { light as c, lightRadius as lr } from '../lib/theme';
import { useNav } from '../lib/nav';
import { TEST_LOCATION } from '../lib/location';

type Coordinates = { latitude: number; longitude: number };
type Stop = Route['stops'][number];
type StepKind = 'done' | 'failed' | 'current' | 'upcoming';
type Leg = { km: number; min: number; road: boolean };

// The public OSRM demo server rejects very long requests, so only the next stops are drawn as a road path.
const MAX_ROUTED_STOPS = 20;
// Re-request the road path only after the rider has moved this far from where it was last drawn.
const REROUTE_METERS = 300;
// The map keeps half the screen; the sheet below scrolls up over the page, carrying the map with it.
const MAP_FULL = 0.5;
// Only the native app has a map to drop a pin on.
const CAN_PIN = Platform.OS !== 'web';

const coordsOf = (stop: Stop): Coordinates | null => {
  const { latitude, longitude } = stop.delivery.address;
  return latitude == null || longitude == null ? null : { latitude, longitude };
};

/** Straight-line distance in km (haversine). */
const kmBetween = (a: Coordinates, b: Coordinates) => {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

const ROUTE_TYPE_LABEL: Record<Route['preference'], string> = { smart: 'Smartest', nearest_first: 'Nearest first', shortest: 'Most efficient' };

const STEP_STATUS: Record<StepKind, { label: string; tone: LightTone }> = {
  done: { label: 'Delivered', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' },
  current: { label: 'Next', tone: 'blue' },
  upcoming: { label: 'Pending', tone: 'muted' },
};

const formatLeg = ({ km, min, road }: Leg) => {
  const distance = km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
  // Straight-line estimates are marked with ~ until the road distance is known.
  return road ? `${distance} · ${Math.max(1, Math.round(min))} min` : `~${distance}`;
};

const isOpen = (stop: Stop) => stop.delivery.status === 'pending' || stop.delivery.status === 'in_progress';
const stopName = (stop: Stop) => stopLabel(stop.delivery);
// After planning, pins drop onto the map one by one in route order.
const REVEAL_EVERY_MS = 450;
const openDirections = (stop: Stop) => directionsTo(stop.delivery);

/**
 * The rider's live position, plus `anchor`: the point the road path and re-optimisation start from.
 * The anchor only moves after the rider has gone REROUTE_METERS, so the path isn't re-fetched constantly.
 */
function useRiderPosition() {
  const [position, setPosition] = useState<Coordinates | null>(TEST_LOCATION);
  const [anchor, setAnchor] = useState<Coordinates | null>(TEST_LOCATION);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    if (TEST_LOCATION) return;
    let mounted = true;
    let subscription: Location.LocationSubscription | null = null;
    (async () => {
      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (!mounted) return;
        if (!permission.granted) { setDenied(true); return; }
        const update = (p: Coordinates) => {
          setPosition(p);
          setAnchor((a) => (!a || kmBetween(a, p) * 1000 >= REROUTE_METERS ? p : a));
        };
        const last = await Location.getLastKnownPositionAsync();
        if (mounted && last) update({ latitude: last.coords.latitude, longitude: last.coords.longitude });
        const sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, distanceInterval: 20, timeInterval: 5000 },
          (loc) => update({ latitude: loc.coords.latitude, longitude: loc.coords.longitude }),
        );
        if (mounted) subscription = sub; else sub.remove();
      } catch {
        // The map still works without the rider's position; it just shows the stops.
      }
    })();
    return () => { mounted = false; subscription?.remove(); };
  }, []);

  return { position, anchor, denied };
}

/** Today's route (or the one underway), or the route `routeId` (e.g. tomorrow's, planned the night before). */
export default function RouteMapScreen({ reveal = false, routeId }: { reveal?: boolean; routeId?: string }) {
  const { navigate, goBack } = useNav();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const { position, anchor, denied } = useRiderPosition();
  const [route, setRoute] = useState<Route | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [road, setRoad] = useState<{ key: string; path: Coordinates[]; legs: Leg[]; km: number; min: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<Coordinates | null>(null);
  const routeRequest = useRef(0);
  const autoOptimized = useRef(false);
  // The stop whose pin the rider is placing, and the map centre (where the pin will go).
  const [pinFor, setPinFor] = useState<Stop | null>(null);
  const [pinAt, setPinAt] = useState<Coordinates | null>(null);
  const [savingPin, setSavingPin] = useState(false);
  const [starting, setStarting] = useState(false);
  // How many numbered pins are on the map while they drop in; null once all are shown.
  const [revealed, setRevealed] = useState<number | null>(reveal ? 0 : null);

  // The map never changes size (resizing it while scrolling made it jump): the whole page scrolls instead.
  const mapHeight = Math.round(height * MAP_FULL);
  const page = useRef<ScrollView>(null);
  // While a finger is on the map, drags move the map, not the page.
  const [onMap, setOnMap] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setRoute((await get<Route | null>(routeId ? `/routes/${routeId}` : '/routes/current', routeId ? undefined : { date: todayKey() })).data);
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load the active route');
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [routeId]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const start = anchor || route?.origin || null;

  // Re-orders the open stops nearest-next (by road distance) from where the rider is.
  const optimize = useCallback(async (current: Route) => {
    try {
      setRoute((await post<Route>(`/routes/${current.id}/optimize`, anchor ? { origin: anchor } : {})).data);
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not optimise the route');
    }
  }, [anchor]);

  // Stops added since planning are pulled in automatically, once per visit.
  useEffect(() => {
    if (!route || !route.newStops || autoOptimized.current || route.status === 'completed') return;
    autoOptimized.current = true;
    const timer = setTimeout(() => void optimize(route), 0);
    return () => clearTimeout(timer);
  }, [route, optimize]);

  // Open stops in the route's optimised order; open stops without coordinates are listed after them.
  const { ordered, unmapped, finished } = useMemo(() => {
    const stops = route?.stops || [];
    return {
      ordered: stops.filter(isOpen).flatMap((stop) => { const at = coordsOf(stop); return at ? [{ stop, at }] : []; }),
      unmapped: stops.filter((stop) => isOpen(stop) && !coordsOf(stop)),
      finished: stops.filter((stop) => !isOpen(stop)),
    };
  }, [route]);

  const routeKey = start ? `${start.latitude},${start.longitude}|${ordered.slice(0, MAX_ROUTED_STOPS).map((p) => p.stop.delivery.id).join(',')}` : '';

  // Road path and per-stop road distances through the stops in this order (OSRM, free, no API key).
  useEffect(() => {
    const targets = ordered.slice(0, MAX_ROUTED_STOPS);
    if (!start || !targets.length) return;
    const request = ++routeRequest.current;
    const coords = [start, ...targets.map((t) => t.at)].map((p) => `${p.longitude},${p.latitude}`).join(';');
    fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`)
      .then((res) => { if (!res.ok) throw new Error('route'); return res.json(); })
      .then((data: { code: string; routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] }; legs: { distance: number; duration: number }[] }[] }) => {
        const best = data.routes?.[0];
        if (data.code !== 'Ok' || !best || request !== routeRequest.current) return;
        setRoad({
          key: routeKey,
          path: best.geometry.coordinates.map(([longitude, latitude]) => ({ latitude, longitude })),
          legs: best.legs.map((l) => ({ km: l.distance / 1000, min: l.duration / 60, road: true })),
          km: best.distance / 1000,
          min: best.duration / 60,
        });
      })
      .catch(() => { /* straight-line estimates and a dashed line stay on screen */ });
    // routeKey captures everything the request depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);

  useEffect(() => () => { routeRequest.current = -1; }, []);

  // Road data only counts while it matches the current order.
  const roadNow = road && road.key === routeKey ? road : null;
  // Road legs from the live path when available; otherwise the route's own planned legs.
  const legs: Leg[] = ordered.map((p, i) => roadNow?.legs[i]
    ?? (p.stop.legDistanceKm > 0 ? { km: p.stop.legDistanceKm, min: p.stop.legDurationMin, road: route?.optimization === 'road' } : { km: kmBetween(i === 0 ? start ?? p.at : ordered[i - 1].at, p.at), min: 0, road: false }));

  const mapStops = useMemo<MapStop[]>(() => [
    ...ordered.map((p, i) => ({ ...p.at, id: p.stop.delivery.id, label: String(i + 1), title: `${i + 1}. ${stopName(p.stop)}`, kind: (i === 0 ? 'next' : i === ordered.length - 1 ? 'last' : 'upcoming') as MapStop['kind'] })),
    ...finished.flatMap((stop) => { const at = coordsOf(stop); return at ? [{ ...at, id: stop.delivery.id, label: '', title: stopName(stop), kind: (stop.delivery.status === 'delivered' ? 'done' : 'failed') as MapStop['kind'] }] : []; }),
  ], [ordered, finished]);
  const orderLine = useMemo(() => ordered.map((p) => p.at), [ordered]);

  // Pins still dropping in; null once every pin is on the map.
  const revealing = revealed != null && revealed < mapStops.length ? revealed : null;
  useEffect(() => {
    if (revealing == null || loading) return;
    const timer = setTimeout(() => setRevealed((n) => (n == null ? n : n + 1)), revealing === 0 ? 700 : REVEAL_EVERY_MS);
    return () => clearTimeout(timer);
  }, [revealing, loading]);

  const startRoute = async () => {
    if (!route) return;
    setStarting(true);
    try {
      setRoute((await post<Route>(`/routes/${route.id}/start`)).data);
      setError('');
      navigate('LiveNavigation');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not start the route');
    } finally {
      setStarting(false);
    }
  };

  const startPin = (stop: Stop) => {
    // Placing a pin needs the map in view.
    page.current?.scrollTo({ y: 0, animated: true });
    setPinFor(stop);
    const at = coordsOf(stop) || position || route?.origin || ordered[0]?.at || null;
    setPinAt(at);
    if (at) setFocus({ ...at });
  };

  // Saves the pin, then re-orders the open stops so the pinned stop takes its nearest-next place.
  const savePin = async () => {
    if (!pinFor || !pinAt || !route) return;
    setSavingPin(true);
    try {
      await post(`/deliveries/${pinFor.delivery.id}/location`, pinAt);
      setPinFor(null);
      if (route.status === 'completed') await load();
      else await optimize(route);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save the pin');
    } finally {
      setSavingPin(false);
    }
  };

  const select = (stop: Stop) => {
    setSelectedId((id) => (id === stop.delivery.id ? null : stop.delivery.id));
    const at = coordsOf(stop);
    if (at) setFocus({ ...at });
  };

  if (loading) {
    return <Screen style={{ backgroundColor: c.background, alignItems: 'center', justifyContent: 'center' }}><StatusBar style="dark" /><ActivityIndicator color={c.ink} /></Screen>;
  }

  if (!route) {
    return (
      <Screen style={{ backgroundColor: c.background, padding: 24, justifyContent: 'center' }}>
        <StatusBar style="dark" />
        <LightError text={error} />
        <View style={{ alignItems: 'center' }}>
          <MaterialCommunityIcons name="map-marker-path" size={48} color={c.placeholder} />
          <Text style={{ color: c.text, fontSize: 20, fontWeight: '700', marginTop: 14 }}>No active route</Text>
          <Text style={{ color: c.textSecondary, fontSize: 15, marginTop: 6, textAlign: 'center' }}>Tap New route on Home to create one.</Text>
        </View>
      </Screen>
    );
  }

  const leftKm = roadNow ? roadNow.km : legs.reduce((a, l) => a + l.km, 0);
  const total = ordered.length + unmapped.length;
  const planned = route.status === 'planned';
  const timeLeft = roadNow ? formatMinutes(roadNow.min) : legs.some((l) => l.road) ? formatMinutes(legs.reduce((a, l) => a + l.min, 0)) : route.durationMin > 0 && planned ? formatMinutes(route.durationMin) : '—';
  // Before the start: the whole route, like the design. Underway: what is left. Finished: what was done.
  const stats = route.status === 'completed'
    ? [{ value: `${route.progress.done}/${route.progress.total}`, label: 'stops done' }, { value: `${route.distanceKm} km`, label: 'distance' }, { value: '—', label: 'remaining' }]
    : [
      { value: String(planned ? route.progress.total : total), label: planned ? 'stops' : 'stops left' },
      { value: `${roadNow ? '' : '~'}${leftKm < 10 ? leftKm.toFixed(1) : Math.round(leftKm)} km`, label: planned ? 'distance' : 'left to drive' },
      { value: timeLeft, label: planned ? 'est. time' : 'remaining' },
    ];

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <StatusBar style="dark" />
      <View style={{ flex: 1 }}>
      <ScrollView
        ref={page}
        style={{ flex: 1 }}
        scrollEnabled={!pinFor && !onMap}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={c.ink} colors={[c.ink]} />}
      >
      {/* Top: the map, always the same height */}
      <View style={{ height: mapHeight }} onTouchStart={() => setOnMap(true)} onTouchEnd={() => setOnMap(false)} onTouchCancel={() => setOnMap(false)}>
        {mapStops.length || position || pinFor ? (
          <GoogleRouteMap
            light stops={mapStops} position={position} path={roadNow?.path ?? []} order={orderLine} focus={focus} style={{ height: '100%' }}
            pinning={!!pinFor} onCenterChange={setPinAt} reveal={revealing ?? undefined}
          />
        ) : (
          <View style={[s.mapEmpty, { flex: 1 }]}>
            <MaterialCommunityIcons name="map-marker-off-outline" size={30} color={c.placeholder} />
            <Text style={s.muted}>None of these addresses are on the map yet.</Text>
          </View>
        )}
        {pinFor ? (
          <View style={s.pinBar}>
            <Text style={{ color: c.text, fontSize: 15, fontWeight: '600' }} numberOfLines={2}>Move the map so the pin sits on {stopName(pinFor)}</Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
              <LightButton title="Cancel" variant="outline" onPress={() => setPinFor(null)} disabled={savingPin} style={{ flex: 1, minHeight: 46 }} />
              <LightButton title="Save pin" onPress={() => void savePin()} loading={savingPin} disabled={!pinAt} style={{ flex: 1, minHeight: 46 }} />
            </View>
          </View>
        ) : null}
      </View>

      {/* Bottom sheet: totals and the main buttons (as designed), then the stops in route order */}
      <View style={s.sheet}>
        <View style={s.grabber} />
        <LightError text={error} />

        <View style={s.stats}>
          {stats.map((st) => (
            <View key={st.label} style={{ flex: 1 }}>
              <Text style={s.statValue} numberOfLines={1} adjustsFontSizeToFit>{st.value}</Text>
              <Text style={s.statLabel}>{st.label}</Text>
            </View>
          ))}
        </View>

        {planned ? (
          <LightButton
            title={route.serviceDate > todayKey() ? `Start now (planned for ${dayLabel(route.serviceDate).toLowerCase()})` : 'Start route'}
            icon={<Ionicons name="navigate-outline" size={22} color={c.onInk} />}
            onPress={() => void startRoute()} loading={starting} disabled={revealing != null} style={{ marginTop: 24 }} />
        ) : route.status === 'active' && total ? (
          <LightButton title="Start navigation" icon={<Ionicons name="navigate-outline" size={22} color={c.onInk} />} onPress={() => navigate('LiveNavigation')} style={{ marginTop: 24 }} />
        ) : null}
        {planned ? (
          // Add stops with this route's stops on the list: add or remove, then Review plans the route again with them.
          // A started route can't be planned again, so it has no Edit stops.
          <Pressable onPress={() => navigate('AddStops', { name: route.name || 'Route', date: route.serviceDate, routeId: route.id })} hitSlop={8} style={s.edit}>
            <Text style={s.editText}>Edit stops</Text>
          </Pressable>
        ) : null}

        {/* Not in the design: everything below is the existing route list, kept and restyled. */}
        <View style={s.divider} />
        <Text style={s.routeName} numberOfLines={1}>{route.name || 'Your route'}</Text>
        <Text style={[s.muted, { marginTop: 2, marginBottom: 14 }]}>
          {revealing != null ? `Placing stop ${revealing + 1} of ${mapStops.length}…` : `${dayLabel(route.serviceDate)} · ${ROUTE_TYPE_LABEL[route.preference]} · ${planned ? 'Not started' : route.status === 'active' ? 'In progress' : 'Completed'}`}
        </Text>

        {denied ? <Text style={[s.muted, { marginBottom: 12 }]}>Allow location access so your position shows on the map.</Text> : null}
        <Text style={[s.muted, { fontSize: 13, marginBottom: 10 }]}>
          {route.optimization === 'road' ? 'Ordered using road distances and times.' : route.optimization === 'straight_line' ? 'Ordered by straight-line distance (road distances were unavailable).' : 'Route order as planned.'}
        </Text>

        <Step kind="start" title={position ? 'Your location' : 'Start point'} subtitle={position ? 'Live GPS' : 'Where the route was planned from'} isFirst />

        {ordered.map((p, i) => (
          <Step
            key={p.stop.delivery.id}
            kind={i === 0 ? 'current' : 'upcoming'}
            order={i + 1}
            last={i === ordered.length - 1 && !unmapped.length}
            leg={formatLeg(legs[i])}
            title={stopName(p.stop)}
            subtitle={p.stop.delivery.address.raw}
            warning={!p.stop.delivery.address.geocoded ? 'Approximate location' : null}
            selected={i === 0 || selectedId === p.stop.delivery.id}
            onPress={() => select(p.stop)}
            onPin={CAN_PIN && !p.stop.delivery.address.geocoded ? () => startPin(p.stop) : undefined}
            onOpen={() => navigate('DeliveryDetail', { id: p.stop.delivery.id })}
            onNavigate={() => openDirections(p.stop)}
          />
        ))}
        {unmapped.map((stop, i) => (
          <Step
            key={stop.delivery.id}
            kind="upcoming"
            order={ordered.length + i + 1}
            title={stopName(stop)}
            subtitle={stop.delivery.address.raw}
            warning={stop.delivery.address.geocodeStatus === 'pending' ? 'Not looked up yet' : 'Location not found'}
            selected={selectedId === stop.delivery.id}
            onPress={() => select(stop)}
            onPin={CAN_PIN ? () => startPin(stop) : undefined}
            onOpen={() => navigate('DeliveryDetail', { id: stop.delivery.id })}
            onNavigate={() => openDirections(stop)}
          />
        ))}

        <Step kind="finish" title="Route complete" subtitle={`${total} stop${total === 1 ? '' : 's'} to go`} done={total === 0} isLast />

        {finished.length ? (
          <>
            <Text style={s.section}>Completed</Text>
            {finished.map((stop, i) => (
              <Step
                key={stop.delivery.id}
                kind={stop.delivery.status === 'delivered' ? 'done' : 'failed'}
                title={stopName(stop)}
                subtitle={stop.delivery.address.raw}
                selected={selectedId === stop.delivery.id}
                isFirst={i === 0}
                isLast={i === finished.length - 1}
                onPress={() => select(stop)}
                onOpen={() => navigate('DeliveryDetail', { id: stop.delivery.id })}
              />
            ))}
          </>
        ) : null}
      </View>
      </ScrollView>
      {/* Fixed over the page, so it stays put while the sheet scrolls */}
      <Pressable onPress={goBack} hitSlop={10} style={[s.back, { top: insets.top > 0 ? 12 : 16 }]} accessibilityLabel="Back">
        <Ionicons name="arrow-back" size={24} color={c.text} />
      </Pressable>
      </View>
    </Screen>
  );
}

type StepProps = {
  kind: StepKind | 'start' | 'finish';
  title: string;
  subtitle: string;
  order?: number;
  /** The final stop: its dot is black, like its pin on the map. */
  last?: boolean;
  leg?: string | null;
  warning?: string | null;
  selected?: boolean;
  done?: boolean;
  isFirst?: boolean;
  isLast?: boolean;
  onPress?: () => void;
  onOpen?: () => void;
  onNavigate?: () => void;
  onPin?: () => void;
};

// One row of the stepper: a line coming in from above, the dot, and a line going out below.
function Step({ kind, title, subtitle, order, last, leg, warning, selected, done, isFirst, isLast, onPress, onOpen, onNavigate, onPin }: StepProps) {
  // Lines above finished stops are "travelled" and drawn solid in green; the rest stay muted.
  const travelled = kind === 'done' || kind === 'failed' || (kind === 'finish' && done);
  const lineIn = travelled ? c.success : kind === 'current' ? c.link : c.border;
  const lineOut = kind === 'done' || kind === 'failed' || kind === 'start' ? c.success : c.border;
  const status = kind === 'start' || kind === 'finish' ? null : STEP_STATUS[kind];

  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => [s.step, selected && s.stepSelected, pressed && { opacity: 0.85 }]}>
      <View style={s.rail}>
        <View style={[s.line, { backgroundColor: isFirst ? 'transparent' : lineIn }]} />
        <StepDot kind={kind} order={order} done={done} last={last} />
        <View style={[s.line, { backgroundColor: isLast ? 'transparent' : lineOut }]} />
      </View>

      <View style={{ flex: 1, paddingVertical: 10 }}>
        {leg ? (
          <View style={s.leg}>
            <MaterialCommunityIcons name="arrow-down" size={12} color={c.placeholder} />
            <Text style={{ color: c.textSecondary, fontSize: 12, fontWeight: '500' }}>{leg}</Text>
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={[s.stepTitle, kind === 'current' && { color: c.link }]} numberOfLines={1}>{title}</Text>
          {status ? <LightPill text={status.label} tone={status.tone} /> : null}
        </View>
        <Text style={[s.muted, { fontSize: 14, marginTop: 3 }]} numberOfLines={selected ? 3 : 1}>{subtitle}</Text>
        {warning ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
            <MaterialCommunityIcons name="map-marker-question-outline" size={14} color={c.warning} />
            <Text style={{ color: c.warning, fontSize: 13, fontWeight: '500' }}>{warning}</Text>
            {onPin ? (
              <Pressable onPress={onPin} hitSlop={8} style={({ pressed }) => [s.pinBtn, pressed && { opacity: 0.8 }]}>
                <MaterialCommunityIcons name="map-marker-plus-outline" size={14} color={c.link} />
                <Text style={{ color: c.link, fontSize: 13, fontWeight: '600' }}>Set pin</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {selected && (onOpen || onNavigate) ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {onNavigate ? (
              <Pressable onPress={onNavigate} style={({ pressed }) => [s.openBtn, s.navBtn, pressed && { opacity: 0.85 }]}>
                <Ionicons name="navigate" size={15} color={c.onInk} />
                <Text style={{ color: c.onInk, fontWeight: '600', fontSize: 13 }}>Directions</Text>
              </Pressable>
            ) : null}
            {onOpen ? (
              <Pressable onPress={onOpen} style={({ pressed }) => [s.openBtn, pressed && { opacity: 0.85 }]}>
                <Ionicons name="document-text-outline" size={16} color={c.text} />
                <Text style={{ color: c.text, fontWeight: '600', fontSize: 13 }}>Open delivery</Text>
                <Ionicons name="chevron-forward" size={14} color={c.textSecondary} />
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function StepDot({ kind, order, done, last }: { kind: StepProps['kind']; order?: number; done?: boolean; last?: boolean }) {
  switch (kind) {
    case 'start':
      return <View style={[s.dot, { backgroundColor: c.linkBg, borderColor: c.link }]}><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.link }} /></View>;
    case 'finish':
      return <View style={[s.dot, done ? { backgroundColor: c.success, borderColor: c.success } : null]}><MaterialCommunityIcons name="flag-checkered" size={13} color={done ? c.onInk : c.textSecondary} /></View>;
    case 'done':
      return <View style={[s.dot, { backgroundColor: c.success, borderColor: c.success }]}><Ionicons name="checkmark" size={14} color={c.onInk} /></View>;
    case 'failed':
      return <View style={[s.dot, { backgroundColor: c.danger, borderColor: c.danger }]}><Ionicons name="close" size={14} color={c.onInk} /></View>;
    case 'current':
      return <View style={s.currentHalo}><View style={[s.dot, { backgroundColor: c.link, borderColor: '#fff', borderWidth: 2 }]}><Text style={{ color: c.onInk, fontSize: 12, fontWeight: '700' }}>{order}</Text></View></View>;
    default:
      return last
        ? <View style={[s.dot, { backgroundColor: c.ink, borderColor: c.ink }]}><Text style={{ color: c.onInk, fontSize: 12, fontWeight: '700' }}>{order}</Text></View>
        : <View style={[s.dot, { backgroundColor: c.link, borderColor: c.link }]}><Text style={{ color: c.onInk, fontSize: 12, fontWeight: '700' }}>{order}</Text></View>;
  }
}

const DOT = 26;
const s = StyleSheet.create({
  mapEmpty: { alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: c.soft },
  muted: { color: c.textSecondary, fontSize: 14 },
  back: { position: 'absolute', left: 20, width: 44, height: 44, borderRadius: 22, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 4 },
  sheet: { marginTop: -24, backgroundColor: c.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 24, paddingTop: 10, paddingBottom: 28 },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: c.track, marginBottom: 20 },
  stats: { flexDirection: 'row', gap: 12 },
  statValue: { color: c.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
  statLabel: { color: c.textSecondary, fontSize: 15, marginTop: 2 },
  edit: { alignItems: 'center', paddingVertical: 16 },
  editText: { color: c.textLabel, fontSize: 16, fontWeight: '600' },
  divider: { height: 1, backgroundColor: c.border, marginTop: 4, marginBottom: 18 },
  routeName: { color: c.text, fontSize: 18, fontWeight: '700' },

  step: { flexDirection: 'row', gap: 12, paddingRight: 10, borderRadius: lr.field },
  stepSelected: { backgroundColor: c.soft },
  rail: { width: DOT + 8, alignItems: 'center' },
  line: { flex: 1, width: 2, minHeight: 10 },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: c.soft, borderWidth: 1.5, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  currentHalo: { padding: 3, borderRadius: DOT, backgroundColor: 'rgba(37,99,235,0.18)' },
  stepTitle: { flexShrink: 1, color: c.text, fontSize: 16, fontWeight: '600' },
  leg: { flexDirection: 'row', alignItems: 'center', gap: 3, marginBottom: 4 },
  navBtn: { backgroundColor: c.ink, borderColor: c.ink },
  section: { color: c.textSecondary, fontSize: 13, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase', marginTop: 20, marginBottom: 6 },
  pinBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 6, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: c.linkBg },
  pinBar: { position: 'absolute', left: 16, right: 16, bottom: 36, padding: 16, borderRadius: 20, backgroundColor: '#fff', shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  openBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 10, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
});
