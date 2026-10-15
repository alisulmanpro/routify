import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useFocusEffect } from '../lib/useFocusEffect';
import { get, post, ApiRequestError } from '../lib/api';
import { openDirections as directionsTo } from '../lib/deliveryActions';
import { formatMinutes } from '../lib/format';
import type { Route } from '../lib/types';
import { Screen } from '../components/Kit';
import { DARK_ON_PRIMARY, Empty, ErrorBanner, Pill, type PillTone } from '../components/Premium';
import GoogleRouteMap, { type MapStop } from '../components/GoogleRouteMap';
import { premium as c, premiumRadius as r } from '../lib/theme';
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
// The map takes half the screen, and shrinks to a strip while the rider scrolls down the list.
const MAP_FULL = 0.5;
const MAP_SMALL = 0.2;
// How far the rider scrolls back up before the map grows again.
const GROW_AFTER_PX = 60;
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

const STEP_STATUS: Record<StepKind, { label: string; tone: PillTone }> = {
  done: { label: 'Delivered', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' },
  current: { label: 'Next', tone: 'orange' },
  upcoming: { label: 'Pending', tone: 'muted' },
};

const formatLeg = ({ km, min, road }: Leg) => {
  const distance = km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
  // Straight-line estimates are marked with ~ until the road distance is known.
  return road ? `${distance} · ${Math.max(1, Math.round(min))} min` : `~${distance}`;
};

const isOpen = (stop: Stop) => stop.delivery.status === 'pending' || stop.delivery.status === 'in_progress';
const stopName = (stop: Stop) => stop.delivery.customer.name || `Parcel ${stop.delivery.trackingId}`;
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

export default function RouteMapScreen() {
  const { navigate } = useNav();
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
  const [optimizing, setOptimizing] = useState(false);
  const autoOptimized = useRef(false);
  // The stop whose pin the rider is placing, and the map centre (where the pin will go).
  const [pinFor, setPinFor] = useState<Stop | null>(null);
  const [pinAt, setPinAt] = useState<Coordinates | null>(null);
  const [savingPin, setSavingPin] = useState(false);

  // Collapsing map: the height animates between two sizes on scroll direction, so the list itself
  // scrolls natively and the map is only resized once per change, not on every scroll frame.
  const fullHeight = Math.round(height * MAP_FULL);
  const smallHeight = Math.round(height * MAP_SMALL);
  const [mapHeight] = useState(() => new Animated.Value(fullHeight));
  const [small, setSmall] = useState(false);
  const scroll = useRef({ y: 0, up: 0, content: 0, area: 0 });
  useEffect(() => {
    Animated.timing(mapHeight, { toValue: small ? smallHeight : fullHeight, duration: 220, useNativeDriver: false }).start();
  }, [small, smallHeight, fullHeight, mapHeight]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const st = scroll.current;
    const y = e.nativeEvent.contentOffset.y;
    const dy = y - st.y;
    st.y = y;
    st.up = dy < 0 ? st.up - dy : 0;
    if (pinFor) return;
    // Shrink only when the list still overflows with the small map, or the scroll position would
    // jump back to the top and the map would grow straight back.
    if (!small && dy > 0 && y > 24 && st.content > st.area - smallHeight + 24) setSmall(true);
    else if (small && (y <= 4 || st.up > GROW_AFTER_PX)) setSmall(false);
  };

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setRoute((await get<Route | null>('/routes/current')).data);
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load the active route');
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const start = anchor || route?.origin || null;

  // Re-orders the open stops nearest-next (by road distance) from where the rider is.
  const optimize = useCallback(async (current: Route) => {
    setOptimizing(true);
    try {
      setRoute((await post<Route>(`/routes/${current.id}/optimize`, anchor ? { origin: anchor } : {})).data);
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not optimise the route');
    } finally {
      setOptimizing(false);
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
    ...ordered.map((p, i) => ({ ...p.at, id: p.stop.delivery.id, label: String(i + 1), title: `${i + 1}. ${stopName(p.stop)}`, kind: (i === 0 ? 'next' : 'upcoming') as MapStop['kind'] })),
    ...finished.flatMap((stop) => { const at = coordsOf(stop); return at ? [{ ...at, id: stop.delivery.id, label: '', title: stopName(stop), kind: (stop.delivery.status === 'delivered' ? 'done' : 'failed') as MapStop['kind'] }] : []; }),
  ], [ordered, finished]);
  const orderLine = useMemo(() => ordered.map((p) => p.at), [ordered]);

  const startPin = (stop: Stop) => {
    setSmall(false);
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
    return <Screen style={{ backgroundColor: c.background, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={c.primary} /></Screen>;
  }

  if (!route) {
    return (
      <Screen style={{ backgroundColor: c.background, padding: 22, justifyContent: 'center' }}>
        {error ? <ErrorBanner text={error} /> : null}
        <Empty icon="map-marker-path" title="No active route" subtitle="Start a route from the Deliveries tab to see it on the map." />
      </Screen>
    );
  }

  const leftKm = roadNow ? roadNow.km : legs.reduce((a, l) => a + l.km, 0);
  const total = ordered.length + unmapped.length;

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <View style={{ flex: 1 }} onLayout={(e) => { scroll.current.area = e.nativeEvent.layout.height; }}>
      {/* Top section: the map */}
      <Animated.View style={{ height: mapHeight, borderBottomWidth: 1, borderBottomColor: c.border }}>
        {mapStops.length || position || pinFor ? (
          <GoogleRouteMap
            stops={mapStops} position={position} path={roadNow?.path ?? []} order={orderLine} focus={focus} style={{ height: '100%' }}
            pinning={!!pinFor} onCenterChange={setPinAt}
          />
        ) : (
          <View style={[s.mapEmpty, { flex: 1 }]}>
            <MaterialCommunityIcons name="map-marker-off-outline" size={30} color={c.textMuted} />
            <Text style={s.muted}>None of these addresses are on the map yet.</Text>
          </View>
        )}
        {pinFor ? (
          <View style={s.pinBar}>
            <Text style={{ color: c.text, fontSize: 13, fontWeight: '700' }} numberOfLines={2}>Move the map so the pin sits on {stopName(pinFor)}</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Pressable onPress={() => setPinFor(null)} disabled={savingPin} style={({ pressed }) => [s.openBtn, { marginTop: 0 }, pressed && { opacity: 0.85 }]}>
                <Text style={{ color: c.primary, fontWeight: '800', fontSize: 12 }}>Cancel</Text>
              </Pressable>
              <Pressable onPress={() => void savePin()} disabled={savingPin || !pinAt} style={({ pressed }) => [s.openBtn, s.navBtn, { marginTop: 0 }, (pressed || savingPin) && { opacity: 0.85 }]}>
                {savingPin ? <ActivityIndicator size="small" color={DARK_ON_PRIMARY} /> : <MaterialCommunityIcons name="map-marker-check" size={14} color={DARK_ON_PRIMARY} />}
                <Text style={{ color: DARK_ON_PRIMARY, fontWeight: '800', fontSize: 12 }}>Save pin</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </Animated.View>

      {/* Bottom section: the stops as a stepper, in route order (nearest next) */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 28 }}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onContentSizeChange={(_w, h) => { scroll.current.content = h; }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={c.primary} colors={[c.primary]} />}
      >
        {error ? <ErrorBanner text={error} /> : null}

        <View style={s.summary}>
          <SummaryItem icon="flag-checkered" value={`${route.progress.done}/${route.progress.total}`} label="Stops done" />
          <SummaryItem icon="map-marker-distance" value={`${roadNow ? '' : '~'}${leftKm.toFixed(1)} km`} label="Left to drive" />
          <SummaryItem icon="clock-outline" value={roadNow ? formatMinutes(roadNow.min) : legs.some((l) => l.road) ? formatMinutes(legs.reduce((a, l) => a + l.min, 0)) : '—'} label="Remaining" />
        </View>

        {denied ? <Text style={[s.muted, { marginBottom: 12 }]}>Allow location access so the route can be optimised from where you are.</Text> : null}
        <View style={s.optimizeRow}>
          <Text style={[s.muted, { flex: 1, fontSize: 12 }]}>
            {route.optimization === 'road' ? 'Nearest stop next, by road distance.' : route.optimization === 'straight_line' ? 'Nearest stop next, by straight-line distance (road distances were unavailable).' : 'Route order as planned.'}
          </Text>
          {route.status !== 'completed' && ordered.length + unmapped.length > 1 ? (
            <Pressable onPress={() => void optimize(route)} disabled={optimizing} style={({ pressed }) => [s.optimizeBtn, (pressed || optimizing) && { opacity: 0.7 }]}>
              {optimizing ? <ActivityIndicator size="small" color={c.primary} /> : <MaterialCommunityIcons name="map-marker-path" size={14} color={c.primary} />}
              <Text style={{ color: c.primary, fontWeight: '800', fontSize: 12 }}>Optimise from here</Text>
            </Pressable>
          ) : null}
        </View>

        <Step kind="start" title={position ? 'Your location' : 'Start point'} subtitle={position ? 'Live GPS' : 'Where the route was planned from'} isFirst />

        {ordered.map((p, i) => (
          <Step
            key={p.stop.delivery.id}
            kind={i === 0 ? 'current' : 'upcoming'}
            order={i + 1}
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
      </ScrollView>
      </View>
    </Screen>
  );
}

function SummaryItem({ icon, value, label }: { icon: React.ComponentProps<typeof MaterialCommunityIcons>['name']; value: string; label: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', gap: 2 }}>
      <MaterialCommunityIcons name={icon} size={16} color={c.primary} />
      <Text style={{ color: c.text, fontSize: 15, fontWeight: '800' }}>{value}</Text>
      <Text style={{ color: c.textMuted, fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</Text>
    </View>
  );
}

type StepProps = {
  kind: StepKind | 'start' | 'finish';
  title: string;
  subtitle: string;
  order?: number;
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
function Step({ kind, title, subtitle, order, leg, warning, selected, done, isFirst, isLast, onPress, onOpen, onNavigate, onPin }: StepProps) {
  // Lines above finished stops are "travelled" and drawn solid in green; the rest stay muted.
  const travelled = kind === 'done' || kind === 'failed' || (kind === 'finish' && done);
  const lineIn = travelled ? c.success : kind === 'current' ? c.primary : c.border;
  const lineOut = kind === 'done' || kind === 'failed' || kind === 'start' ? c.success : c.border;
  const status = kind === 'start' || kind === 'finish' ? null : STEP_STATUS[kind];

  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => [s.step, selected && s.stepSelected, pressed && { opacity: 0.85 }]}>
      <View style={s.rail}>
        <View style={[s.line, { backgroundColor: isFirst ? 'transparent' : lineIn }]} />
        <StepDot kind={kind} order={order} done={done} />
        <View style={[s.line, { backgroundColor: isLast ? 'transparent' : lineOut }]} />
      </View>

      <View style={{ flex: 1, paddingVertical: 10 }}>
        {leg ? (
          <View style={s.leg}>
            <MaterialCommunityIcons name="arrow-down" size={11} color={c.textMuted} />
            <Text style={{ color: c.textMuted, fontSize: 11, fontWeight: '600' }}>{leg}</Text>
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={[s.stepTitle, kind === 'current' && { color: c.primary }]} numberOfLines={1}>{title}</Text>
          {status ? <Pill text={status.label} tone={status.tone} /> : null}
        </View>
        <Text style={[s.muted, { fontSize: 12, marginTop: 2 }]} numberOfLines={selected ? 3 : 1}>{subtitle}</Text>
        {warning ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
            <MaterialCommunityIcons name="map-marker-question-outline" size={12} color={c.warning} />
            <Text style={{ color: c.warning, fontSize: 11, fontWeight: '600' }}>{warning}</Text>
            {onPin ? (
              <Pressable onPress={onPin} hitSlop={8} style={({ pressed }) => [s.pinBtn, pressed && { opacity: 0.8 }]}>
                <MaterialCommunityIcons name="map-marker-plus-outline" size={12} color={c.primary} />
                <Text style={{ color: c.primary, fontSize: 11, fontWeight: '800' }}>Set pin</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {selected && (onOpen || onNavigate) ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {onNavigate ? (
              <Pressable onPress={onNavigate} style={({ pressed }) => [s.openBtn, s.navBtn, pressed && { opacity: 0.85 }]}>
                <Ionicons name="navigate" size={14} color={DARK_ON_PRIMARY} />
                <Text style={{ color: DARK_ON_PRIMARY, fontWeight: '800', fontSize: 12 }}>Directions</Text>
              </Pressable>
            ) : null}
            {onOpen ? (
              <Pressable onPress={onOpen} style={({ pressed }) => [s.openBtn, pressed && { opacity: 0.85 }]}>
                <Ionicons name="document-text-outline" size={15} color={c.primary} />
                <Text style={{ color: c.primary, fontWeight: '800', fontSize: 12 }}>Open delivery</Text>
                <Ionicons name="chevron-forward" size={14} color={c.primary} />
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function StepDot({ kind, order, done }: { kind: StepProps['kind']; order?: number; done?: boolean }) {
  switch (kind) {
    case 'start':
      return <View style={[s.dot, { backgroundColor: 'rgba(61,139,255,0.18)', borderColor: '#3D8BFF' }]}><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#3D8BFF' }} /></View>;
    case 'finish':
      return <View style={[s.dot, done ? { backgroundColor: c.success, borderColor: c.success } : null]}><MaterialCommunityIcons name="flag-checkered" size={13} color={done ? DARK_ON_PRIMARY : c.textSecondary} /></View>;
    case 'done':
      return <View style={[s.dot, { backgroundColor: c.success, borderColor: c.success }]}><Ionicons name="checkmark" size={14} color={DARK_ON_PRIMARY} /></View>;
    case 'failed':
      return <View style={[s.dot, { backgroundColor: c.danger, borderColor: c.danger }]}><Ionicons name="close" size={14} color="#fff" /></View>;
    case 'current':
      return <View style={s.currentHalo}><View style={[s.dot, { backgroundColor: c.primary, borderColor: '#fff', borderWidth: 2 }]}><Text style={{ color: DARK_ON_PRIMARY, fontSize: 11, fontWeight: '800' }}>{order}</Text></View></View>;
    default:
      return <View style={s.dot}><Text style={{ color: c.text, fontSize: 11, fontWeight: '800' }}>{order}</Text></View>;
  }
}

const DOT = 26;
const s = StyleSheet.create({
  mapEmpty: { alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border },
  muted: { color: c.textSecondary, fontSize: 13 },
  summary: { flexDirection: 'row', backgroundColor: c.surface, borderRadius: r.medium, borderWidth: 1, borderColor: c.border, paddingVertical: 12, marginBottom: 14 },

  step: { flexDirection: 'row', gap: 12, paddingRight: 10, borderRadius: r.small },
  stepSelected: { backgroundColor: c.surfaceSoft },
  rail: { width: DOT + 8, alignItems: 'center' },
  line: { flex: 1, width: 2, minHeight: 10 },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: c.surfaceSoft, borderWidth: 1.5, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  currentHalo: { padding: 3, borderRadius: DOT, backgroundColor: 'rgba(255,170,50,0.25)' },
  stepTitle: { flexShrink: 1, color: c.text, fontSize: 14, fontWeight: '700' },
  leg: { flexDirection: 'row', alignItems: 'center', gap: 3, marginBottom: 4 },
  navBtn: { backgroundColor: c.primary },
  optimizeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  optimizeBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderRadius: r.pill, backgroundColor: 'rgba(255,170,50,0.12)' },
  section: { color: c.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase', marginTop: 18, marginBottom: 4 },
  pinBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 6, paddingHorizontal: 8, paddingVertical: 3, borderRadius: r.pill, backgroundColor: 'rgba(255,170,50,0.14)' },
  pinBar: { position: 'absolute', left: 12, right: 12, bottom: 12, padding: 12, borderRadius: r.medium, backgroundColor: 'rgba(13,22,41,0.95)', borderWidth: 1, borderColor: c.border },
  openBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 8, paddingHorizontal: 12, paddingVertical: 7, borderRadius: r.pill, backgroundColor: 'rgba(255,170,50,0.14)' },
});
