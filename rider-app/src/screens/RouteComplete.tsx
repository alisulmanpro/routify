import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { Screen } from '../components/Kit';
import { LightButton, LightError } from '../components/LightKit';
import { get, ApiRequestError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { FAILURE_LABELS, stopCardText } from '../lib/format';
import type { Route } from '../lib/types';
import { useFocusEffect } from '../lib/useFocusEffect';
import { useNav } from '../lib/nav';
import { light as c } from '../lib/theme';

/** Shown once the last stop of a route is delivered or failed (design_pref "Route complete"). */
export default function RouteComplete({ routeId }: { routeId: string }) {
  const { navigate, resetTab, switchTab } = useNav();
  const { user } = useAuth();
  const [route, setRoute] = useState<Route | null>(null);
  const [error, setError] = useState('');

  useFocusEffect(useCallback(() => {
    get<Route>(`/routes/${routeId}`)
      .then((res) => { setRoute(res.data); setError(''); })
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Could not load this route'));
  }, [routeId]));

  const home = () => { resetTab('home'); switchTab('home'); };
  const firstName = user?.fullName.split(' ')[0] || '';
  const failed = route ? route.stops.filter((stop) => stop.delivery.status === 'failed') : [];
  const minutes = route?.summary.routeMinutes ?? null;

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 56, paddingBottom: 120 }}>
        <View style={s.badge}><Ionicons name="checkmark" size={56} color={c.success} /></View>
        <Text style={s.title}>Route complete!</Text>
        <Text style={s.sub}>Great work today{firstName ? `, ${firstName}` : ''}</Text>
        <LightError text={error} />

        {route ? (
          <>
            <View style={s.stats}>
              <Stat value={String(route.summary.delivered)} label="Delivered" color={c.success} />
              <Stat value={String(route.summary.failed)} label="Failed" color={route.summary.failed ? c.danger : c.text} />
              <Stat value={route.distanceKm > 0 ? String(Math.round(route.distanceKm)) : '—'} unit={route.distanceKm > 0 ? 'km' : undefined} label="Distance" />
              {minutes != null ? (
                <View style={{ flex: 1, alignItems: 'center' }}>
                  <Text style={s.statValue} numberOfLines={1} adjustsFontSizeToFit>
                    {minutes >= 60 ? <>{Math.floor(minutes / 60)}<Text style={s.unit}>h </Text></> : null}{minutes % 60}<Text style={s.unit}>m</Text>
                  </Text>
                  <Text style={s.statLabel}>Time</Text>
                </View>
              ) : <Stat value="—" label="Time" />}
            </View>

            {failed.length ? (
              <View style={s.section}>
                <Text style={s.sectionTitle}>{failed.length === 1 ? 'Failed stop' : 'Failed stops'}</Text>
                {failed.map((stop) => {
                  const d = stop.delivery;
                  const { title, address } = stopCardText(d);
                  return (
                    <Pressable key={d.id} onPress={() => navigate('DeliveryDetail', { id: d.id })} style={({ pressed }) => [s.row, pressed && { opacity: 0.7 }]}>
                      <View style={s.num}><Text style={{ color: c.danger, fontSize: 16, fontWeight: '700' }}>{stop.order}</Text></View>
                      <View style={{ flex: 1, marginLeft: 14, marginRight: 8 }}>
                        <Text style={s.code} numberOfLines={1}>{title}</Text>
                        {address ? <Text style={s.address} numberOfLines={2}>{address}</Text> : null}
                        {d.failure ? (
                          <View style={s.reason}><Text style={{ color: c.danger, fontSize: 14, fontWeight: '500' }}>{FAILURE_LABELS[d.failure.reason] ?? d.failure.reason}</Text></View>
                        ) : null}
                      </View>
                      <Ionicons name="chevron-forward" size={20} color={c.placeholder} />
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
          </>
        ) : !error ? <ActivityIndicator color={c.ink} style={{ marginTop: 32 }} /> : null}
      </ScrollView>

      <View style={s.footer}>
        <LightButton title="Back to home" onPress={home} />
      </View>
    </Screen>
  );
}

function Stat({ value, unit, label, color = c.text }: { value: string; unit?: string; label: string; color?: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Text style={[s.statValue, { color }]} numberOfLines={1} adjustsFontSizeToFit>{value}{unit ? <Text style={s.unit}> {unit}</Text> : null}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  badge: { alignSelf: 'center', width: 96, height: 96, borderRadius: 48, backgroundColor: c.successBg, alignItems: 'center', justifyContent: 'center' },
  title: { color: c.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.5, textAlign: 'center', marginTop: 28 },
  sub: { color: c.textSecondary, fontSize: 17, textAlign: 'center', marginTop: 8, marginBottom: 12 },
  stats: { flexDirection: 'row', gap: 6, marginTop: 28, paddingBottom: 28, borderBottomWidth: 1, borderBottomColor: c.border },
  statValue: { color: c.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  unit: { fontSize: 15, fontWeight: '600', color: c.textSecondary },
  statLabel: { color: c.textSecondary, fontSize: 15, marginTop: 4 },
  section: { marginTop: 24 },
  sectionTitle: { color: c.text, fontSize: 18, fontWeight: '600', marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 14 },
  num: { width: 30, height: 30, borderRadius: 15, backgroundColor: c.dangerBg, alignItems: 'center', justifyContent: 'center' },
  code: { color: c.text, fontSize: 17, fontWeight: '700' },
  address: { color: c.textSecondary, fontSize: 15, lineHeight: 21, marginTop: 4 },
  reason: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: c.dangerBg, marginTop: 8 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 24, paddingTop: 12, paddingBottom: 14, backgroundColor: c.background },
});
