import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Screen } from '../components/Kit';
import { DARK_ON_PRIMARY, ErrorBanner, Header, PButton, type McName } from '../components/Premium';
import GoogleRouteMap, { type MapStop } from '../components/GoogleRouteMap';
import StopLines from '../components/StopLines';
import { get, post, ApiRequestError } from '../lib/api';
import { getRouteOrigin } from '../lib/location';
import { dayLabel, stopLabel } from '../lib/format';
import { forgetRouteName } from '../lib/routeNames';
import type { Delivery, Route, RoutePreference } from '../lib/types';
import { useAuth } from '../lib/auth';
import { useFocusEffect } from '../lib/useFocusEffect';
import { useNav } from '../lib/nav';
import { premium as c, premiumRadius as r } from '../lib/theme';

export const ROUTE_TYPES: { key: RoutePreference; title: string; text: string; icon: McName }[] = [
  { key: 'smart', title: 'Smartest', text: 'Least total driving time. Stops at the same address are done together.', icon: 'lightbulb-on-outline' },
  { key: 'nearest_first', title: 'Nearest first', text: 'Always drive to the closest stop next.', icon: 'map-marker-radius-outline' },
  { key: 'shortest', title: 'Most efficient', text: 'The shortest total distance for the whole route.', icon: 'chart-timeline-variant' },
];

// Step 3 of Add route: check every stop, choose how the route is ordered, then plan it.
export default function RoutePreview({ name, date, ids }: { name: string; date: string; ids: string[] }) {
  const { goBack, resetTo } = useNav();
  const { user } = useAuth();
  const [stops, setStops] = useState<Delivery[] | null>(null);
  const [preference, setPreference] = useState<RoutePreference>(user?.routePreference || 'smart');
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState('');

  useFocusEffect(useCallback(() => {
    const wanted = new Set(ids);
    (async () => {
      try {
        const all: Delivery[] = [];
        for (let page = 1; page <= 3; page++) {
          const res = await get<Delivery[]>('/deliveries', { status: 'pending', date, limit: 100, page, sort: 'recent' });
          all.push(...res.data);
          if (!res.meta || page >= res.meta.pages) break;
        }
        const byId = new Map(all.map((d) => [d.id, d]));
        setStops(ids.flatMap((id) => (wanted.has(id) && byId.get(id) ? [byId.get(id)!] : [])));
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Could not load your stops');
        setStops([]);
      }
    })();
  }, [ids, date]));

  const mapStops = useMemo<MapStop[]>(() => (stops || []).flatMap((d, i) => (d.address.latitude != null && d.address.longitude != null
    ? [{ id: d.id, latitude: d.address.latitude, longitude: d.address.longitude, label: String(i + 1), title: stopLabel(d), kind: 'upcoming' as const }] : [])), [stops]);
  const unlocated = (stops || []).filter((d) => d.address.geocodeStatus !== 'found').length;

  const plan = async () => {
    if (!stops?.length) return;
    setPlanning(true);
    setError('');
    try {
      const origin = await getRouteOrigin();
      const built = await post<Route>('/routes/build', { name, date, preference, deliveryIds: stops.map((d) => d.id), ...(origin ? { origin } : {}) });
      void forgetRouteName(date);
      // The map drops the numbered pins in route order. Back from there returns Home, not to this form.
      resetTo('RouteMapScreen', { reveal: true, routeId: built.data.id });
    } catch (err) {
      setError(err instanceof ApiRequestError
        ? err.code === 'ROUTE_ACTIVE' ? 'Finish your current route first. Your new stops are saved and will be here.' : err.message
        : 'Could not plan the route. Check your connection and try again.');
    } finally {
      setPlanning(false);
    }
  };

  if (!stops) return <Screen style={{ backgroundColor: c.background, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={c.primary} /></Screen>;

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 120 }}>
        <Header eyebrow={`${name} · ${dayLabel(date)}`} eyebrowIcon="map-marker-path" title="Review route" subtitle={`${stops.length} stop${stops.length === 1 ? '' : 's'}. Check them, then choose how to order the route.`} />

        {mapStops.length ? (
          <View style={s.map}>
            <GoogleRouteMap stops={mapStops} position={null} path={[]} order={[]} style={{ height: '100%' }} />
          </View>
        ) : null}
        {unlocated ? (
          <View style={s.note}>
            <MaterialCommunityIcons name="map-marker-question-outline" size={16} color={c.warning} />
            <Text style={{ flex: 1, color: c.textSecondary, fontSize: 12, lineHeight: 17 }}>
              {unlocated} stop{unlocated === 1 ? ' is' : 's are'} not pinned exactly yet. They are looked up when the route is planned; you can set a pin on the map afterwards.
            </Text>
          </View>
        ) : null}

        <Text style={s.section}>ALL STOPS</Text>
        {stops.map((d, i) => (
          <View key={d.id} style={[s.row, i > 0 && s.divider]}>
            <View style={s.badge}><Text style={{ color: c.text, fontWeight: '800', fontSize: 11 }}>{i + 1}</Text></View>
            <View style={{ flex: 1 }}>
              <StopLines stop={d} />
            </View>
          </View>
        ))}
        <Pressable onPress={goBack} style={({ pressed }) => [s.edit, pressed && { opacity: 0.8 }]}>
          <Ionicons name="create-outline" size={16} color={c.primary} />
          <Text style={{ color: c.primary, fontWeight: '800', fontSize: 13 }}>Add or remove stops</Text>
        </Pressable>

        <Text style={[s.section, { marginTop: 22 }]}>ROUTE TYPE</Text>
        {ROUTE_TYPES.map((t) => {
          const on = preference === t.key;
          return (
            <Pressable key={t.key} onPress={() => setPreference(t.key)} style={({ pressed }) => [s.type, on && s.typeOn, pressed && { opacity: 0.9 }]}>
              <View style={[s.typeIcon, on && { backgroundColor: c.primary }]}>
                <MaterialCommunityIcons name={t.icon} size={20} color={on ? DARK_ON_PRIMARY : c.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.text, fontWeight: '800', fontSize: 15 }}>{t.title}</Text>
                <Text style={{ color: c.textSecondary, fontSize: 12, marginTop: 2, lineHeight: 17 }}>{t.text}</Text>
              </View>
              <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={20} color={on ? c.primary : c.textMuted} />
            </Pressable>
          );
        })}
        <ErrorBanner text={error} />
      </ScrollView>

      <View style={s.footer}>
        <PButton title={planning ? 'Planning your route…' : 'Plan route on the map'} icon="map" onPress={() => void plan()} loading={planning} disabled={!stops.length} chevron />
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  map: { height: 200, borderRadius: r.large, overflow: 'hidden', borderWidth: 1, borderColor: c.border, marginBottom: 12 },
  note: { flexDirection: 'row', gap: 8, padding: 12, borderRadius: r.small, backgroundColor: 'rgba(255,179,64,0.1)', marginBottom: 12 },
  section: { color: c.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  divider: { borderTopWidth: 1, borderTopColor: c.divider },
  badge: { width: 24, height: 24, borderRadius: 12, backgroundColor: c.surfaceSoft, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  edit: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: r.pill, backgroundColor: 'rgba(255,170,50,0.12)' },
  type: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, marginBottom: 10, borderRadius: r.medium, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  typeOn: { borderColor: c.primary, backgroundColor: 'rgba(255,170,50,0.08)' },
  typeIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,170,50,0.14)', alignItems: 'center', justifyContent: 'center' },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 14, backgroundColor: 'rgba(5,11,24,0.96)', borderTopWidth: 1, borderTopColor: c.border },
});
