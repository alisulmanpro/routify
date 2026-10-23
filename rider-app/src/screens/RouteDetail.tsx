import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { Screen } from '../components/Kit';
import { LightError } from '../components/LightKit';
import GoogleRouteMap, { type MapStop } from '../components/GoogleRouteMap';
import { get, ApiRequestError } from '../lib/api';
import { fromDayKey, stopCardText, stopLabel, timeOnly } from '../lib/format';
import type { Route } from '../lib/types';
import { useFocusEffect } from '../lib/useFocusEffect';
import { useNav } from '../lib/nav';
import { light as c } from '../lib/theme';

/** A finished route from History (design_pref "Route detail"): its map, totals and every stop with the time it was done. */
export default function RouteDetail({ id }: { id: string }) {
  const { navigate, goBack } = useNav();
  const [route, setRoute] = useState<Route | null>(null);
  const [error, setError] = useState('');

  useFocusEffect(useCallback(() => {
    get<Route>(`/routes/${id}`)
      .then((res) => { setRoute(res.data); setError(''); })
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Could not load this route'));
  }, [id]));

  const mapStops = useMemo<MapStop[]>(() => {
    const stops = route?.stops || [];
    return stops.flatMap((stop, i) => {
      const { latitude, longitude } = stop.delivery.address;
      if (latitude == null || longitude == null) return [];
      const kind: MapStop['kind'] = stop.delivery.status === 'failed' ? 'failed' : i === stops.length - 1 ? 'last' : 'done';
      return [{ latitude, longitude, id: stop.delivery.id, label: String(stop.order), title: `${stop.order}. ${stopLabel(stop.delivery)}`, kind }];
    });
  }, [route]);
  const line = useMemo(() => mapStops.map(({ latitude, longitude }) => ({ latitude, longitude })), [mapStops]);

  const minutes = route?.summary.routeMinutes ?? null;

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 32 }}>
        <View style={s.header}>
          <Pressable onPress={goBack} hitSlop={12} accessibilityLabel="Back" style={{ marginTop: 3 }}>
            <Ionicons name="arrow-back" size={26} color={c.text} />
          </Pressable>
          <View style={{ flex: 1, marginLeft: 18 }}>
            <Text style={s.title} numberOfLines={2}>{route?.name || 'Route'}</Text>
            {route ? (
              <Text style={s.date}>{fromDayKey(route.serviceDate).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</Text>
            ) : null}
          </View>
        </View>
        <LightError text={error} />

        {!route ? (!error ? <ActivityIndicator color={c.ink} style={{ marginTop: 48 }} /> : null) : (
          <>
            {mapStops.length ? (
              <View style={s.map}>
                <GoogleRouteMap light stops={mapStops} position={null} path={[]} order={line} style={{ height: '100%' }} />
              </View>
            ) : null}

            <View style={s.stats}>
              <Stat value={String(route.summary.delivered)} label="Delivered" color={c.success} />
              <Stat value={String(route.summary.failed)} label="Failed" color={route.summary.failed ? c.danger : c.text} />
              <Stat value={route.distanceKm > 0 ? String(Math.round(route.distanceKm)) : '—'} unit={route.distanceKm > 0 ? 'km' : undefined} label="Distance" />
              <View style={{ flex: 1 }}>
                <Text style={s.statValue} numberOfLines={1} adjustsFontSizeToFit>
                  {minutes == null ? '—' : <>{minutes >= 60 ? <>{Math.floor(minutes / 60)}<Text style={s.unit}>h </Text></> : null}{minutes % 60}<Text style={s.unit}>m</Text></>}
                </Text>
                <Text style={s.statLabel}>Time</Text>
              </View>
            </View>

            <Text style={s.section}>Stops</Text>
            {route.stops.map((stop, i) => {
              const d = stop.delivery;
              const { title, address } = stopCardText(d);
              const at = d.deliveredAt || d.failedAt;
              const failed = d.status === 'failed';
              const done = d.status === 'delivered';
              return (
                <Pressable key={d.id} onPress={() => navigate('DeliveryDetail', { id: d.id })} style={({ pressed }) => [s.row, i > 0 && s.divider, pressed && { opacity: 0.7 }]}>
                  <View style={[s.num, failed && { backgroundColor: c.dangerBg }]}>
                    <Text style={{ color: failed ? c.danger : c.text, fontSize: 16, fontWeight: '600' }}>{stop.order}</Text>
                  </View>
                  <View style={{ flex: 1, marginLeft: 14, marginRight: 10 }}>
                    <Text style={s.code} numberOfLines={1}>{title}</Text>
                    {address ? <Text style={s.address} numberOfLines={2}>{address}</Text> : null}
                  </View>
                  {at ? <Text style={s.time}>{timeOnly(at)}</Text> : null}
                  <View style={[s.mark, { backgroundColor: failed ? c.dangerBg : done ? c.successBg : c.soft }]}>
                    <Ionicons name={failed ? 'close' : done ? 'checkmark' : 'time-outline'} size={18} color={failed ? c.danger : done ? c.success : c.textSecondary} />
                  </View>
                </Pressable>
              );
            })}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function Stat({ value, unit, label, color = c.text }: { value: string; unit?: string; label: string; color?: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={[s.statValue, { color }]} numberOfLines={1} adjustsFontSizeToFit>{value}{unit ? <Text style={s.unit}> {unit}</Text> : null}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-start' },
  title: { color: c.text, fontSize: 26, fontWeight: '700' },
  date: { color: c.textSecondary, fontSize: 16, marginTop: 4 },
  map: { height: 160, borderRadius: 20, overflow: 'hidden', marginTop: 20 },
  stats: { flexDirection: 'row', gap: 8, marginTop: 24, paddingBottom: 24, borderBottomWidth: 1, borderBottomColor: c.border },
  statValue: { color: c.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
  unit: { fontSize: 15, fontWeight: '600', color: c.textSecondary },
  statLabel: { color: c.textSecondary, fontSize: 15, marginTop: 4 },
  section: { color: c.text, fontSize: 18, fontWeight: '600', marginTop: 24, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 16 },
  divider: { borderTopWidth: 1, borderTopColor: c.border },
  num: { width: 30, height: 30, borderRadius: 15, backgroundColor: c.soft, alignItems: 'center', justifyContent: 'center' },
  code: { color: c.text, fontSize: 17, fontWeight: '700' },
  address: { color: c.textSecondary, fontSize: 15, lineHeight: 21, marginTop: 4 },
  time: { color: c.textLabel, fontSize: 15, marginRight: 10, marginTop: 4 },
  mark: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
});
