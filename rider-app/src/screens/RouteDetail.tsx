import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../components/Kit';
import { Empty, ErrorBanner, Header, PButton, PCard, Pill, type PillTone } from '../components/Premium';
import StopLines from '../components/StopLines';
import { get, post, ApiRequestError } from '../lib/api';
import { dayLabel, formatMinutes, todayKey } from '../lib/format';
import type { Route } from '../lib/types';
import { useFocusEffect } from '../lib/useFocusEffect';
import { useNav } from '../lib/nav';
import { premium as c, premiumRadius as r } from '../lib/theme';
import { STATUS as STOP_STATUS } from './DeliveryDetail';

export const ROUTE_STATUS: Record<Route['status'], { label: string; tone: PillTone }> = {
  planned: { label: 'Planned', tone: 'blue' },
  active: { label: 'In progress', tone: 'orange' },
  completed: { label: 'Completed', tone: 'green' },
};

/** One route from Home: its day, status and totals, every stop in order, and the way into its map and navigation. */
export default function RouteDetail({ id }: { id: string }) {
  const { navigate } = useNav();
  const [route, setRoute] = useState<Route | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  useFocusEffect(useCallback(() => {
    get<Route>(`/routes/${id}`)
      .then((res) => { setRoute(res.data); setError(''); })
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Could not load this route'))
      .finally(() => setLoading(false));
  }, [id]));

  // Same as Start route on the map: a planned route starts first, then navigation opens on it.
  const navigateRoute = async () => {
    if (!route || starting) return;
    if (route.status === 'active') { navigate('LiveNavigation'); return; }
    setStarting(true);
    setError('');
    try {
      setRoute((await post<Route>(`/routes/${route.id}/start`)).data);
      navigate('LiveNavigation');
    } catch (err) {
      setError(err instanceof ApiRequestError
        ? err.code === 'ROUTE_ACTIVE' ? 'Finish the route that is underway before starting this one.' : err.message
        : 'Could not start the route. Check your connection and try again.');
    } finally {
      setStarting(false);
    }
  };

  if (loading) return <Screen style={{ backgroundColor: c.background, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={c.primary} /></Screen>;
  if (!route) {
    return (
      <Screen style={{ backgroundColor: c.background, padding: 18 }}>
        <ErrorBanner text={error} />
        <Empty icon="map-marker-off-outline" title="Route not found" subtitle="It may have been replaced by a newer route for the same day." />
      </Screen>
    );
  }

  const status = ROUTE_STATUS[route.status];
  const later = route.serviceDate > todayKey();
  const stats = [
    { label: 'Stops', value: String(route.progress.total) },
    { label: 'Delivered', value: `${route.summary.delivered}/${route.summary.total}` },
    ...(route.distanceKm > 0 ? [{ label: 'Distance', value: `${route.distanceKm} km` }] : []),
    ...(route.durationMin > 0 ? [{ label: 'Duration', value: formatMinutes(route.durationMin) }] : []),
  ];

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 32 }}>
        <Header eyebrow={dayLabel(route.serviceDate)} eyebrowIcon="calendar-month-outline" title={route.name || 'Route'} right={<Pill text={status.label} tone={status.tone} />} />
        <ErrorBanner text={error} />

        <PCard style={{ flexDirection: 'row', paddingVertical: 14, marginTop: 4 }}>
          {stats.map((st, i) => (
            <View key={st.label} style={[{ flex: 1, alignItems: 'center' }, i > 0 && s.statDivider]}>
              <Text style={{ color: c.text, fontSize: 16, fontWeight: '800' }}>{st.value}</Text>
              <Text style={{ color: c.textSecondary, fontSize: 11, fontWeight: '600', marginTop: 2 }}>{st.label}</Text>
            </View>
          ))}
        </PCard>

        <PButton title="Open map" icon="map" variant={route.status === 'completed' ? 'primary' : 'secondary'} onPress={() => navigate('RouteMapScreen', { routeId: route.id })} chevron style={{ marginTop: 14 }} />
        {route.status !== 'completed' ? (
          <PButton
            title={route.status === 'active' ? 'Continue navigation' : later ? `Start now (planned for ${dayLabel(route.serviceDate).toLowerCase()})` : 'Start navigation'}
            icon="navigate"
            onPress={() => void navigateRoute()}
            loading={starting}
            disabled={!route.progress.remaining}
            chevron
            style={{ marginTop: 10 }}
          />
        ) : null}

        <Text style={s.section}>STOPS IN ORDER</Text>
        {route.stops.length ? route.stops.map((stop, i) => {
          const d = stop.delivery;
          const st = STOP_STATUS[d.status];
          return (
            <Pressable key={d.id} onPress={() => navigate('DeliveryDetail', { id: d.id })} style={({ pressed }) => [s.row, i > 0 && s.divider, pressed && { opacity: 0.85 }]}>
              <View style={s.badge}><Text style={{ color: c.text, fontWeight: '800', fontSize: 11 }}>{stop.order}</Text></View>
              <View style={{ flex: 1 }}>
                <StopLines stop={d} />
              </View>
              <Pill text={st.label} tone={st.tone} />
              <Ionicons name="chevron-forward" size={16} color={c.textMuted} />
            </Pressable>
          );
        }) : <Text style={{ color: c.textSecondary, fontSize: 13 }}>No stops on this route.</Text>}
      </ScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  statDivider: { borderLeftWidth: 1, borderLeftColor: c.divider },
  section: { color: c.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 22, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11 },
  divider: { borderTopWidth: 1, borderTopColor: c.divider },
  badge: { width: 26, height: 26, borderRadius: r.pill, backgroundColor: c.surfaceSoft, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
});
