import { useCallback, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from '../lib/useFocusEffect';
import { del, get, post, ApiRequestError } from '../lib/api';
import type { Delivery, Route } from '../lib/types';
import { titleCase } from '../lib/format';
import { getRouteOrigin } from '../lib/location';
import { Screen } from '../components/Kit';
import { DARK_ON_PRIMARY, Empty, ErrorBanner, Header, PButton, PCard, Pill, type PillTone } from '../components/Premium';
import { premium as c } from '../lib/theme';
import { useNav } from '../lib/nav';

const STATUS: Record<Delivery['status'], { label: string; tone: PillTone }> = {
  pending: { label: 'Pending', tone: 'amber' },
  in_progress: { label: 'Arrived', tone: 'blue' },
  delivered: { label: 'Delivered', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' },
};

export default function DeliveriesList() {
  const { navigate } = useNav();
  const [route, setRoute] = useState<Route | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);

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

            {route?.status === 'planned' ? (
              <PCard accent>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={s.cardTitle}>Route planned</Text>
                  <Pill text={titleCase(route.preference)} tone="orange" icon="git-network-outline" />
                </View>
                <Text style={s.meta}>{route.stops.length} stops · {route.distanceKm} km · about {route.durationMin} min</Text>
                <PButton title="Start delivery" icon="play" onPress={startRoute} loading={busy} chevron style={{ marginTop: 14 }} />
              </PCard>
            ) : null}

            {route?.status === 'active' ? (
              <PCard accent>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={s.cardTitle}>{route.progress.done} of {route.progress.total} stops done</Text>
                  <Text style={{ color: c.primary, fontWeight: '800' }}>{progress}%</Text>
                </View>
                <View style={s.track}><View style={[s.fill, { width: `${progress}%` }]} /></View>
                <Text style={s.meta}>{route.distanceKm} km planned</Text>
                <Text style={[s.meta, unmappedCount ? { color: c.warning } : null]}>
                  {route.stops.length - unmappedCount} of {route.stops.length} destinations mapped
                  {approximateCount ? ` · ${approximateCount} approximate` : ''}
                  {unmappedCount > approximateCount ? ` · ${unmappedCount - approximateCount} need address review` : ''}
                </Text>
                <PButton title="Live navigation" icon="navigate" variant="secondary" onPress={() => navigate('RouteNavigation')} chevron style={{ marginTop: 14 }} />
              </PCard>
            ) : null}

            {items.length > 0 ? <Text style={s.section}>{isRouteMode ? 'Remaining stops' : 'Open deliveries'}</Text> : null}
          </View>
        )}
        ListEmptyComponent={<Empty icon="package-variant" title="No open deliveries" subtitle="Tap + to scan, speak, type or import your stops. Finished stops are in History." />}
        renderItem={({ item }) => {
          const d = item.delivery;
          const st = STATUS[d.status];
          return (
            <Pressable onPress={() => navigate('DeliveryDetail', { id: d.id })} style={({ pressed }) => [pressed && { opacity: 0.88 }]}>
              <PCard style={{ flexDirection: 'row', gap: 12, paddingVertical: 14 }}>
                <View style={[s.num, item.order === route?.stops.find((stop) => stop.delivery.id === route.currentStopId)?.order && s.numCurrent]}>
                  {item.order ? <Text style={s.numText}>{item.order}</Text> : <MaterialCommunityIcons name="package-variant-closed" size={16} color={c.primary} />}
                </View>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <Text style={s.parcel} numberOfLines={1}>{d.trackingId}</Text>
                    <Pill text={st.label} tone={st.tone} />
                  </View>
                  {d.customer.name ? <Text style={s.customer} numberOfLines={1}>{d.customer.name}</Text> : null}
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 4, marginTop: 4 }}>
                    <Ionicons name="location-outline" size={13} color={c.textMuted} style={{ marginTop: 2 }} />
                    <Text style={s.address} numberOfLines={2}>{d.address.raw}</Text>
                  </View>
                  {!d.address.geocoded && d.address.geocodeStatus !== 'pending' ? (
                    <Text style={{ color: c.warning, fontSize: 11, marginTop: 4, fontWeight: '600' }}>{d.address.approximate ? 'Approximate area' : 'Location not found'}</Text>
                  ) : null}
                </View>
              </PCard>
            </Pressable>
          );
        }}
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
  num: { width: 34, height: 34, borderRadius: 17, backgroundColor: c.surfaceSoft, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  numCurrent: { backgroundColor: c.primary, borderColor: c.primary },
  numText: { color: c.text, fontSize: 13, fontWeight: '800' },
  parcel: { flex: 1, color: c.text, fontSize: 15, fontWeight: '800' },
  customer: { color: c.textSecondary, fontSize: 13, marginTop: 2 },
  address: { flex: 1, color: c.textMuted, fontSize: 12, lineHeight: 17 },
  fab: { position: 'absolute', right: 20, bottom: 20, width: 60, height: 60, borderRadius: 30, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', shadowColor: '#FFFFFF', shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 10 },
});
