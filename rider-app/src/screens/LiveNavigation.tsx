import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { Screen } from '../components/Kit';
import { DARK_ON_PRIMARY, Empty, ErrorBanner, PButton, type McName } from '../components/Premium';
import GoogleRouteMap, { type Coordinates, type MapStop } from '../components/GoogleRouteMap';
import { get, ApiRequestError } from '../lib/api';
import { markDelivered, openDirections } from '../lib/deliveryActions';
import { formatMinutes, stopLabel, todayKey } from '../lib/format';
import { TEST_LOCATION } from '../lib/location';
import type { Route } from '../lib/types';
import { useFocusEffect } from '../lib/useFocusEffect';
import { useNav } from '../lib/nav';
import { premium as c, premiumRadius as r } from '../lib/theme';

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
  const { navigate } = useNav();
  const { position, anchor, heading, denied } = useLivePosition();
  const [route, setRoute] = useState<Route | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [guidance, setGuidance] = useState<Guidance | null>(null);
  const [busy, setBusy] = useState(false);
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
    fetch(`https://router.project-osrm.org/route/v1/driving/${anchor.longitude},${anchor.latitude};${target.longitude},${target.latitude}?overview=full&geometries=geojson&steps=true`)
      .then((res) => { if (!res.ok) throw new Error('route'); return res.json(); })
      .then((data: { code: string; routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] }; legs: { steps: Step[] }[] }[] }) => {
        const best = data.routes?.[0];
        if (data.code !== 'Ok' || !best || id !== request.current) return;
        setGuidance({ key, path: best.geometry.coordinates.map(([longitude, latitude]) => ({ latitude, longitude })), km: best.distance / 1000, min: best.duration / 60, steps: best.legs[0]?.steps || [] });
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

  const mapStops = useMemo<MapStop[]>(() => open.flatMap((stop, i) => {
    const at = coordsOf(stop);
    return at ? [{ ...at, id: stop.delivery.id, label: String(stop.order), title: `${stop.order}. ${stopLabel(stop.delivery)}`, kind: (i === 0 ? 'next' : 'upcoming') as MapStop['kind'] }] : [];
  }), [open]);

  const delivered = async () => {
    if (!current) return;
    setBusy(true);
    try {
      if (await markDelivered(current.delivery)) { setGuidance(null); await load(); }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not mark it delivered');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Screen style={{ backgroundColor: c.background, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={c.primary} /></Screen>;
  if (!route || route.status !== 'active') {
    return (
      <Screen style={{ backgroundColor: c.background, padding: 22, justifyContent: 'center' }}>
        <ErrorBanner text={error} />
        <Empty icon="navigation-variant-outline" title="No route underway" subtitle="Start a route from its map to navigate it here." />
      </Screen>
    );
  }
  if (!current) {
    return (
      <Screen style={{ backgroundColor: c.background, padding: 22, justifyContent: 'center' }}>
        <Empty icon="flag-checkered" title="Route complete" subtitle={`${route.name || 'Your route'} is finished. Well done!`} />
      </Screen>
    );
  }

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <View style={{ flex: 1 }}>
        <GoogleRouteMap stops={mapStops} position={position} path={live?.path ?? []} order={target ? [target] : []} follow={!!position} heading={heading} style={{ height: '100%' }} />

        {/* Next manoeuvre */}
        <View style={s.banner}>
          <View style={s.turnIcon}>
            <MaterialCommunityIcons name={arrived ? 'flag-checkered' : nextTurn.icon} size={30} color={DARK_ON_PRIMARY} />
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

      {/* Current stop */}
      <View style={s.card}>
        <ErrorBanner text={error} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Text style={s.stopNo}>STOP {current.order} OF {route.stops.length}</Text>
          <Text style={{ marginLeft: 'auto', color: c.textSecondary, fontSize: 12, fontWeight: '700' }}>
            {live ? `${live.km < 1 ? `${Math.round(live.km * 1000)} m` : `${live.km.toFixed(1)} km`} · ${formatMinutes(live.min)}` : toTarget != null ? `~${distanceText(toTarget)}` : ''}
          </Text>
        </View>
        <Text style={{ color: c.text, fontSize: 17, fontWeight: '800', marginTop: 4 }} numberOfLines={1}>{stopLabel(current.delivery)}</Text>
        <Text style={{ color: c.textSecondary, fontSize: 13, marginTop: 2 }} numberOfLines={2}>{current.delivery.address.raw}</Text>
        {!target ? <Text style={{ color: c.warning, fontSize: 12, marginTop: 4 }}>This stop has no map location. Use Google Maps or set a pin on the route map.</Text> : null}

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
          <PButton title="Delivered" icon="checkmark-circle" onPress={() => void delivered()} loading={busy} variant={arrived ? 'primary' : 'secondary'} style={{ flex: 1 }} />
          <PButton title="Details" icon="document-text-outline" variant="secondary" onPress={() => navigate('DeliveryDetail', { id: current.delivery.id })} style={{ flex: 1 }} />
        </View>
        <PButton title="Voice directions in Google Maps" icon="navigate" variant="secondary" onPress={() => openDirections(current.delivery)} style={{ marginTop: 10 }} />
        {open[1] ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
            <Ionicons name="arrow-forward-circle-outline" size={14} color={c.textMuted} />
            <Text style={{ color: c.textMuted, fontSize: 12 }} numberOfLines={1}>Then: {stopLabel(open[1].delivery)}</Text>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  banner: { position: 'absolute', top: 12, left: 12, right: 64, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: r.medium, backgroundColor: 'rgba(13,22,41,0.96)', borderWidth: 1, borderColor: c.border },
  turnIcon: { width: 50, height: 50, borderRadius: 14, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  turnDistance: { color: c.primary, fontSize: 20, fontWeight: '800' },
  turnText: { color: c.text, fontSize: 15, fontWeight: '700' },
  denied: { position: 'absolute', bottom: 12, left: 12, right: 12, color: c.warning, fontSize: 12, textAlign: 'center', backgroundColor: 'rgba(13,22,41,0.9)', padding: 8, borderRadius: r.small },
  card: { padding: 16, paddingBottom: 18, backgroundColor: c.surface, borderTopWidth: 1, borderTopColor: c.border, borderTopLeftRadius: r.large, borderTopRightRadius: r.large },
  stopNo: { color: c.primary, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
});
