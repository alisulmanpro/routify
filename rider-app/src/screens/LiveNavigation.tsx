import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { Screen } from '../components/Kit';
import { type McName } from '../components/Premium';
import { LightButton, LightError } from '../components/LightKit';
import GoogleRouteMap, { type Coordinates, type MapStop } from '../components/GoogleRouteMap';
import { get, post, ApiRequestError } from '../lib/api';
import { decodePolyline } from '../lib/polyline';
import { openDirections } from '../lib/deliveryActions';
import { formatMinutes, stopCardText, stopLabel, todayKey } from '../lib/format';
import { TEST_LOCATION } from '../lib/location';
import type { Route } from '../lib/types';
import { useFocusEffect } from '../lib/useFocusEffect';
import { useNav } from '../lib/nav';
import { light as c } from '../lib/theme';

type Step = { distance: number; duration: number; name: string; maneuver: { type: string; modifier?: string } };
type Guidance = { key: string; path: Coordinates[]; km: number; min: number; steps: Step[] };
type Stop = Route['stops'][number];

// Re-fetch the road route after moving this far, so the next turn and the distances stay current.
const REROUTE_METERS = 120;
// Closer than this to the stop counts as arrived.
const ARRIVED_METERS = 60;

const metersBetween = (a: Coordinates, b: Coordinates) => {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
};
const coordsOf = (stop: Stop): Coordinates | null => {
  const { latitude, longitude } = stop.delivery.address;
  return latitude == null || longitude == null ? null : { latitude, longitude };
};
const isOpen = (stop: Stop) => stop.delivery.status === 'pending' || stop.delivery.status === 'in_progress';
const distanceText = (m: number) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`);

/** "Turn left onto High Street" from an OSRM step. */
function instruction(step: Step | undefined): { text: string; icon: McName } {
  if (!step) return { text: 'Head to the stop', icon: 'arrow-up' };
  const { type, modifier = '' } = step.maneuver;
  const onto = step.name ? ` onto ${step.name}` : '';
  const icon: McName = modifier.includes('left') ? (modifier.includes('sharp') ? 'arrow-bottom-left' : 'arrow-top-left')
    : modifier.includes('right') ? (modifier.includes('sharp') ? 'arrow-bottom-right' : 'arrow-top-right')
      : modifier === 'uturn' ? 'arrow-u-down-left' : 'arrow-up';
  if (type === 'arrive') return { text: 'Arrive at the stop', icon: 'flag-checkered' };
  if (type === 'roundabout' || type === 'rotary') return { text: `At the roundabout, take the exit${onto}`, icon: 'rotate-right' };
  if (modifier === 'uturn') return { text: `Make a U-turn${onto}`, icon };
  if (modifier === 'straight' || type === 'continue' || type === 'new name') return { text: `Continue${onto || ' straight'}`, icon: 'arrow-up' };
  if (type === 'merge') return { text: `Merge${onto}`, icon };
  if (type === 'fork') return { text: `Keep ${modifier.includes('left') ? 'left' : 'right'}${onto}`, icon };
  if (type === 'end of road' || type === 'turn' || type === 'on ramp' || type === 'off ramp') {
    const side = modifier.replace('slight ', 'slightly ').replace('sharp ', 'sharp ');
    return { text: `Turn ${side}${onto}`, icon };
  }
  return { text: `Continue${onto}`, icon };
}

/**
 * The rider's live position and heading while navigating, plus `anchor`: where the road route is fetched from.
 * The anchor only moves after REROUTE_METERS, so the route is not re-fetched on every GPS fix.
 */
function useLivePosition() {
  const [position, setPosition] = useState<Coordinates | null>(TEST_LOCATION);
  const [anchor, setAnchor] = useState<Coordinates | null>(TEST_LOCATION);
  const [heading, setHeading] = useState<number | null>(null);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    if (TEST_LOCATION) return;
    let mounted = true;
    let sub: Location.LocationSubscription | null = null;
    (async () => {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!mounted) return;
      if (!permission.granted) { setDenied(true); return; }
      const next = await Location.watchPositionAsync({ accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 5, timeInterval: 2000 }, (loc) => {
        const p = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
        setPosition(p);
        setAnchor((a) => (!a || metersBetween(a, p) >= REROUTE_METERS ? p : a));
        // Heading is only meaningful while moving.
        if (loc.coords.heading != null && loc.coords.heading >= 0 && (loc.coords.speed ?? 0) > 1) setHeading(loc.coords.heading);
      });
      if (mounted) sub = next; else next.remove();
    })().catch(() => { /* the map still shows the stops without GPS */ });
    return () => { mounted = false; sub?.remove(); };
  }, []);
  return { position, anchor, heading, denied };
}

// Turn-by-turn guidance to each stop in route order, inside the app.
export default function LiveNavigation() {
  const { navigate, resetTo } = useNav();
  const insets = useSafeAreaInsets();
  const { position, anchor, heading, denied } = useLivePosition();
  const [route, setRoute] = useState<Route | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [guidance, setGuidance] = useState<Guidance | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    try {
      setRoute((await get<Route | null>('/routes/current', { date: todayKey() })).data);
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load your route');
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const open = useMemo(() => (route?.stops || []).filter(isOpen), [route]);
  const current = open[0] || null;
  const target = current ? coordsOf(current) : null;

  const key = anchor && target && current ? `${current.delivery.id}|${anchor.latitude},${anchor.longitude}` : '';
  useEffect(() => {
    if (!anchor || !target) return;
    const id = ++request.current;
    // Re-routed by our API on our own OSRM (P6b.5): the app never calls an OSRM server itself.
    post<{ path: string | null; distanceKm: number | null; durationMin: number | null; steps: Step[] }>('/v2/navigation/route', { start: anchor, target })
      .then(({ data }) => {
        if (!data.path || id !== request.current) return;
        setGuidance({ key, path: decodePolyline(data.path), km: data.distanceKm ?? 0, min: data.durationMin ?? 0, steps: data.steps });
      })
      .catch(() => { /* a straight dashed line and the straight-line distance stay on screen */ });
    // key captures everything this request depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => () => { request.current = -1; }, []);

  const live = guidance && guidance.key === key ? guidance : null;
  const toTarget = position && target ? metersBetween(position, target) : null;
  const arrived = toTarget != null && toTarget <= ARRIVED_METERS;
  // steps[0] is "depart" from where the route was fetched; steps[1] is the next turn.
  const nextTurn = live ? instruction(live.steps[1] || live.steps[0]) : instruction(undefined);
  const toTurn = live && live.steps[0] && position ? Math.max(0, live.steps[0].distance - (anchor ? metersBetween(anchor, position) : 0)) : null;

  // Every stop: done ones grey, the one being driven to black, the rest blue (the light map's colours).
  const mapStops = useMemo<MapStop[]>(() => (route?.stops || []).flatMap((stop) => {
    const at = coordsOf(stop);
    if (!at) return [];
    const kind: MapStop['kind'] = stop.delivery.id === current?.delivery.id ? 'current' : isOpen(stop) ? 'upcoming' : stop.delivery.status === 'failed' ? 'failed' : 'done';
    return [{ ...at, id: stop.delivery.id, label: String(stop.order), title: `${stop.order}. ${stopLabel(stop.delivery)}`, kind }];
  }), [route, current]);

  // Delivered and Failed open the same Proof of delivery / Failed delivery steps as the stop's own screen; finishing
  // the last stop there opens Route complete. Coming back here reloads the route.
  const finishStop = (step: 'proof' | 'fail') => { if (current) { setGuidance(null); navigate('DeliveryDetail', { id: current.delivery.id, step }); } };

  if (loading) return <Screen style={{ backgroundColor: c.background, alignItems: 'center', justifyContent: 'center' }}><StatusBar style="dark" /><ActivityIndicator color={c.ink} /></Screen>;
  if (!route || route.status !== 'active' || !current) {
    // Finished routes have their own summary; otherwise there is nothing to navigate.
    const finished = route && route.status !== 'planned' && !current;
    return (
      <Screen style={{ backgroundColor: c.background, padding: 24, justifyContent: 'center' }}>
        <StatusBar style="dark" />
        <LightError text={error} />
        <View style={{ alignItems: 'center' }}>
          <MaterialCommunityIcons name={finished ? 'flag-checkered' : 'navigation-variant-outline'} size={48} color={c.placeholder} />
          <Text style={{ color: c.text, fontSize: 20, fontWeight: '700', marginTop: 14 }}>{finished ? 'Route complete' : 'No route underway'}</Text>
          <Text style={{ color: c.textSecondary, fontSize: 15, marginTop: 6, textAlign: 'center' }}>
            {finished ? `${route?.name || 'Your route'} is finished. Well done!` : 'Start a route from its map to navigate it here.'}
          </Text>
          {finished && route ? <LightButton title="See summary" onPress={() => resetTo('RouteComplete', { routeId: route.id })} style={{ alignSelf: 'stretch', marginTop: 24 }} /> : null}
        </View>
      </Screen>
    );
  }

  const { title, address } = stopCardText(current.delivery);
  const away = live ? `${live.km < 1 ? `${Math.round(live.km * 1000)} m` : `${live.km.toFixed(1)} km`} · ${formatMinutes(live.min)}` : toTarget != null ? `~${distanceText(toTarget)}` : '';

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <StatusBar style="dark" />
      <View style={{ flex: 1 }}>
        <GoogleRouteMap light stops={mapStops} maxStops={25} position={position} path={live?.path ?? []} order={target ? [target] : []} follow={!!position} heading={heading} style={{ height: '100%' }} />

        <View style={[s.topRow, { top: insets.top > 0 ? 12 : 16 }]}>
          <View style={s.pill}><Text style={s.pillText}>Stop {current.order} of {route.stops.length}</Text></View>
          {/* The route's stops and their status. */}
          <Pressable onPress={() => navigate('RoutePreview', { routeId: route.id })} hitSlop={8} style={s.round} accessibilityLabel="All stops">
            <Ionicons name="menu" size={26} color={c.text} />
          </Pressable>
        </View>

        {/* Not in the design: the next turn, from the in-app guidance. */}
        <View style={[s.banner, { top: (insets.top > 0 ? 12 : 16) + 60 }]}>
          <View style={s.turnIcon}>
            <MaterialCommunityIcons name={arrived ? 'flag-checkered' : nextTurn.icon} size={26} color={c.onInk} />
          </View>
          <View style={{ flex: 1 }}>
            {arrived ? <Text style={s.turnText}>You have arrived</Text> : (
              <>
                {toTurn != null ? <Text style={s.turnDistance}>{distanceText(toTurn)}</Text> : null}
                <Text style={s.turnText} numberOfLines={2}>{nextTurn.text}</Text>
              </>
            )}
          </View>
        </View>
        {denied ? <Text style={s.denied}>Allow location access for live guidance.</Text> : null}
      </View>

      {/* The stop being driven to */}
      <View style={s.card}>
        <View style={s.grabber} />
        <LightError text={error} />
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
          <View style={{ flex: 1, marginRight: 12 }}>
            <Text style={s.label}>NEXT STOP</Text>
            <Text style={s.code} numberOfLines={1}>{title}</Text>
          </View>
          <Pressable onPress={() => navigate('DeliveryDetail', { id: current.delivery.id })} hitSlop={6} style={s.details} accessibilityLabel="Stop details">
            <Ionicons name="document-text-outline" size={24} color={c.text} />
          </Pressable>
        </View>
        {address ? <Text style={s.address} numberOfLines={2}>{address}</Text> : null}
        {away ? <Text style={s.away}>{away}</Text> : null}
        {!target ? <Text style={{ color: c.warning, fontSize: 14, marginTop: 6 }}>This stop has no map location. Use Navigate or set a pin on the route map.</Text> : null}

        {/* Voice directions in Google Maps, as before. */}
        <Pressable onPress={() => openDirections(current.delivery)} style={({ pressed }) => [s.navigate, pressed && { opacity: 0.88 }]}>
          <Ionicons name="navigate-outline" size={24} color="#fff" />
          <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>Navigate</Text>
        </Pressable>
        <View style={{ flexDirection: 'row', gap: 12, marginTop: 12 }}>
          <Pressable onPress={() => finishStop('proof')} style={({ pressed }) => [s.result, s.delivered, pressed && { opacity: 0.88 }]}>
            <Ionicons name="checkmark" size={24} color="#fff" />
            <Text style={[s.resultText, { color: '#fff' }]}>Delivered</Text>
          </Pressable>
          <Pressable onPress={() => finishStop('fail')} style={({ pressed }) => [s.result, s.failed, pressed && { opacity: 0.88 }]}>
            <Ionicons name="close" size={24} color={c.danger} />
            <Text style={[s.resultText, { color: c.danger }]}>Failed</Text>
          </Pressable>
        </View>
        {open[1] ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 }}>
            <Ionicons name="arrow-forward-circle-outline" size={16} color={c.placeholder} />
            <Text style={{ color: c.textSecondary, fontSize: 14 }} numberOfLines={1}>Then: {stopLabel(open[1].delivery)}</Text>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  topRow: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pill: { paddingHorizontal: 18, height: 44, borderRadius: 22, backgroundColor: '#fff', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 4 },
  pillText: { color: c.text, fontSize: 16, fontWeight: '700' },
  round: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 4 },
  banner: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 18, backgroundColor: '#fff', shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 5 },
  turnIcon: { width: 46, height: 46, borderRadius: 12, backgroundColor: c.link, alignItems: 'center', justifyContent: 'center' },
  turnDistance: { color: c.text, fontSize: 18, fontWeight: '800' },
  turnText: { color: c.textLabel, fontSize: 15, fontWeight: '500' },
  denied: { position: 'absolute', bottom: 36, left: 16, right: 16, color: c.warning, fontSize: 13, textAlign: 'center', backgroundColor: c.warningBg, padding: 8, borderRadius: 12, overflow: 'hidden' },
  card: { marginTop: -24, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 16, backgroundColor: c.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28 },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: c.track, marginBottom: 16 },
  label: { color: c.textSecondary, fontSize: 13, fontWeight: '600', letterSpacing: 1.2 },
  code: { color: c.text, fontSize: 32, fontWeight: '800', letterSpacing: -0.5, marginTop: 4 },
  details: { width: 48, height: 48, borderRadius: 24, backgroundColor: c.soft, alignItems: 'center', justifyContent: 'center' },
  address: { color: c.textSecondary, fontSize: 16, lineHeight: 22, marginTop: 6 },
  away: { color: c.text, fontSize: 16, fontWeight: '600', marginTop: 8 },
  navigate: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, minHeight: 58, borderRadius: 18, backgroundColor: c.link, marginTop: 18 },
  result: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 58, borderRadius: 18 },
  delivered: { backgroundColor: '#15803D' },
  failed: { backgroundColor: c.surface, borderWidth: 2, borderColor: c.danger },
  resultText: { fontSize: 18, fontWeight: '700' },
});
