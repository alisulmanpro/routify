import { useCallback, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import DeliveryCard from '../components/DeliveryCard';
import { markDelivered, openDirections } from '../lib/deliveryActions';
import { useFocusEffect } from '../lib/useFocusEffect';
import { del, get, post, ApiRequestError } from '../lib/api';
import type { Delivery, Route } from '../lib/types';
import { formatMinutes, titleCase } from '../lib/format';
import { getRouteOrigin } from '../lib/location';
import { Screen } from '../components/Kit';
import { DARK_ON_PRIMARY, Empty, ErrorBanner, Header, PButton, PCard, Pill } from '../components/Premium';
import { premium as c } from '../lib/theme';
import { useNav } from '../lib/nav';

const OPEN = (d: Delivery) => d.status === 'pending' || d.status === 'in_progress';

function Stat({ value, label, tone }: { value: string; label: string; tone?: string }) {
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text style={[s.statValue, tone ? { color: tone } : null]} numberOfLines={1}>{value}</Text>
      <Text style={s.statLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

export default function DeliveriesList() {
  const { navigate } = useNav();
  const [route, setRoute] = useState<Route | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [marking, setMarking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [routeRes, listRes] = await Promise.all([
        get<Route | null>('/routes/current'),
        get<Delivery[]>('/deliveries', { sort: 'recent', limit: 100 }),
      ]);
      setRoute(routeRes.data);
      setDeliveries(listRes.data);
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load deliveries');
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const startDelivery = async () => {
    setBusy(true);
    setError('');
    try {
      const origin = await getRouteOrigin();
      const planned = await post<Route>('/routes/build', origin ? { origin } : {});
      setRoute((await post<Route>(`/routes/${planned.data.id}/start`)).data);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not start a delivery route');
    } finally { setBusy(false); }
  };

  const optimizeRoute = async () => {
    if (!route) return;
    setBusy(true);
    setError('');
    try {
      const origin = await getRouteOrigin();
      setRoute((await post<Route>(`/routes/${route.id}/optimize`, origin ? { origin } : {})).data);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not optimise the route');
    } finally { setBusy(false); }
  };

  const deliver = async (d: Delivery) => {
    setError('');
    try {
      setMarking(d.id);
      if (await markDelivered(d)) await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not mark the delivery as delivered');
    } finally { setMarking(null); }
  };

  const startRoute = async () => {
    if (!route) return;
    setBusy(true);
    setError('');
    try {
      setRoute((await post<Route>(`/routes/${route.id}/start`)).data);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not start the route');
    } finally { setBusy(false); }
  };

  const clearDeliveries = async () => {
    setBusy(true);
    setError('');
    try {
      await del('/deliveries');
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not clear deliveries');
    } finally { setBusy(false); }
  };

  const confirmClearDeliveries = () => {
    const message = 'This permanently removes all open deliveries and any route that has not started. Completed deliveries stay in History.';
    if (Platform.OS === 'web') {
      if (globalThis.confirm(message)) void clearDeliveries();
      return;
    }
    Alert.alert('Clear open deliveries?', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear deliveries', style: 'destructive', onPress: () => void clearDeliveries() },
    ]);
  };

  const isRouteMode = !!route && route.status !== 'completed';
  const pendingCount = deliveries.filter((d) => d.status === 'pending' && !d.routeId).length;
  const unmappedCount = route?.stops.filter((stop) => !stop.delivery.address.geocoded).length || 0;
  const approximateCount = route?.stops.filter((stop) => stop.delivery.address.approximate).length || 0;
  const openDeliveries = deliveries.filter((d) => d.status === 'pending' || d.status === 'in_progress');
  const items: { delivery: Delivery; order?: number }[] = isRouteMode
    ? route!.stops.filter((stop) => stop.delivery.status === 'pending' || stop.delivery.status === 'in_progress').map((stop) => ({ delivery: stop.delivery, order: stop.order }))
    : openDeliveries.map((d) => ({ delivery: d }));
  const progress = route?.progress.total ? Math.round((route.progress.done / route.progress.total) * 100) : 0;
  // What is left to drive: the legs into stops that are still open.
  const openStops = route?.stops.filter((stop) => OPEN(stop.delivery)) ?? [];
  const remainingKm = route?.status === 'planned' ? route.distanceKm : openStops.reduce((sum, stop) => sum + stop.legDistanceKm, 0);
  const remainingMin = route?.status === 'planned' ? route.durationMin : openStops.reduce((sum, stop) => sum + stop.legDurationMin, 0);
  const currentId = route?.currentStopId;

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.delivery.id}
        contentContainerStyle={{ padding: 16, paddingBottom: 100, gap: 12 }}
        refreshControl={<RefreshControl tintColor={c.primary} colors={[c.primary]} refreshing={refreshing} onRefresh={onRefresh} />}
        ListHeaderComponent={(
          <View style={{ gap: 12, marginBottom: 2 }}>
            <Header
              eyebrow="Delivery desk"
              eyebrowIcon="truck-fast-outline"
              title={isRouteMode ? "Today's route" : 'Deliveries'}
              subtitle={isRouteMode ? undefined : `${openDeliveries.length} open stop${openDeliveries.length === 1 ? '' : 's'}`}
              right={!isRouteMode && deliveries.some((d) => d.status === 'pending') ? (
                <Pressable onPress={confirmClearDeliveries} disabled={busy} hitSlop={8} style={s.clear}>
                  <Text style={{ color: c.danger, fontWeight: '800', fontSize: 12 }}>Clear</Text>
                </Pressable>
              ) : null}
            />
            <ErrorBanner text={error} />

            {!isRouteMode && pendingCount > 0 ? (
              <PButton title={`Start delivery · ${pendingCount} stop${pendingCount === 1 ? '' : 's'}`} icon="navigate-outline" onPress={startDelivery} loading={busy} chevron />
            ) : null}

            {isRouteMode && route ? (
              <PCard accent>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <Text style={s.cardTitle}>{route.status === 'planned' ? 'Route planned' : 'Route in progress'}</Text>
                  {route.optimization === 'road'
                    ? <Pill text="Optimised · road time" tone="green" icon="git-network-outline" />
                    : route.optimization === 'straight_line'
                      ? <Pill text="Estimate · straight line" tone="amber" icon="git-network-outline" />
                      : <Pill text={titleCase(route.preference)} tone="orange" icon="git-network-outline" />}
                </View>
                <View style={s.stats}>
                  <Stat value={String(route.progress.total)} label="Total" />
                  <Stat value={String(route.progress.done)} label="Completed" tone={c.success} />
                  <Stat value={String(route.progress.remaining)} label="Remaining" tone={c.primary} />
                </View>
                <View style={s.stats}>
                  <Stat value={`${remainingKm.toFixed(1)} km`} label={route.status === 'planned' ? 'Driving distance' : 'Distance left'} />
                  <Stat value={formatMinutes(remainingMin)} label={route.status === 'planned' ? 'Travel time' : 'Time left'} />
                  <Stat value={`${progress}%`} label="Progress" />
                </View>
                <View style={s.track}><View style={[s.fill, { width: `${progress}%` }]} /></View>
                {unmappedCount ? (
                  <Text style={[s.meta, { color: c.warning }]}>
                    {route.stops.length - unmappedCount} of {route.stops.length} stops verified on the map
                    {approximateCount ? ` · ${approximateCount} approximate` : ''}
                    {unmappedCount > approximateCount ? ` · ${unmappedCount - approximateCount} not found (left out of optimisation)` : ''}
                  </Text>
                ) : null}
                {route.newStops ? (
                  <View style={s.newStops}>
                    <Ionicons name="add-circle" size={16} color={c.primary} />
                    <Text style={{ flex: 1, color: c.text, fontSize: 12, fontWeight: '600' }}>{route.newStops} new stop{route.newStops === 1 ? '' : 's'} not in this route yet</Text>
                  </View>
                ) : null}
                {route.status === 'planned' ? <PButton title="Start delivery" icon="play" onPress={startRoute} loading={busy} chevron style={{ marginTop: 14 }} /> : null}
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                  <PButton title="Route map" icon="map" variant="secondary" onPress={() => navigate('RouteMapScreen')} style={{ flex: 1 }} />
                  <PButton title={route.newStops ? 'Add & optimise' : 'Re-optimise'} icon="git-network-outline" variant="secondary" onPress={optimizeRoute} loading={busy} style={{ flex: 1 }} />
                </View>
              </PCard>
            ) : null}

            {items.length > 0 ? <Text style={s.section}>{isRouteMode ? 'Remaining stops' : 'Open deliveries'}</Text> : null}
          </View>
        )}
        ListEmptyComponent={<Empty icon="package-variant" title="No open deliveries" subtitle="Tap + to scan, speak, type or import your stops. Finished stops are in History." />}
        renderItem={({ item }) => (
          <DeliveryCard
            delivery={item.delivery}
            stop={item.order}
            current={!!currentId && item.delivery.id === currentId}
            busy={marking === item.delivery.id}
            onOpen={() => navigate('DeliveryDetail', { id: item.delivery.id })}
            onNavigate={() => openDirections(item.delivery)}
            onDelivered={() => void deliver(item.delivery)}
          />
        )}
      />

      <Pressable onPress={() => navigate('AddDelivery')} accessibilityLabel="Add deliveries" style={({ pressed }) => [s.fab, pressed && { opacity: 0.9 }]}>
        <Ionicons name="add" size={30} color={DARK_ON_PRIMARY} />
      </Pressable>
    </Screen>
  );
}

const s = StyleSheet.create({
  clear: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 99, backgroundColor: 'rgba(255,83,104,0.12)' },
  cardTitle: { color: c.text, fontSize: 15, fontWeight: '800' },
  meta: { color: c.textSecondary, fontSize: 12, marginTop: 6 },
  section: { color: c.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', marginTop: 6 },
  track: { height: 8, borderRadius: 99, backgroundColor: '#22314F', overflow: 'hidden', marginTop: 10 },
  fill: { height: '100%', borderRadius: 99, backgroundColor: c.primary },
  stats: { flexDirection: 'row', gap: 10, marginTop: 12 },
  statValue: { color: c.text, fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statLabel: { color: c.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase', marginTop: 2 },
  newStops: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, padding: 10, borderRadius: 12, backgroundColor: 'rgba(255,170,50,0.1)' },
  fab: { position: 'absolute', right: 20, bottom: 20, width: 60, height: 60, borderRadius: 30, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', shadowColor: '#FFFFFF', shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 10 },
});
