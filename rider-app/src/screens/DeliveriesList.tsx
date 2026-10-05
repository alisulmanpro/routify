import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { useFocusEffect } from '../lib/useFocusEffect';
import { get, post, ApiRequestError } from '../lib/api';
import type { Delivery, Route } from '../lib/types';
import { money } from '../lib/format';
import { getRouteOrigin } from '../lib/location';
import { Badge, Banner, Button, Card, EmptyState, Screen } from '../components/Kit';
import { colors, spacing } from '../lib/theme';
import { useNav } from '../lib/nav';

const STATUS_TONE: Record<Delivery['status'], 'blue' | 'green' | 'red' | 'amber'> = { pending: 'amber', in_progress: 'blue', delivered: 'green', failed: 'red' };

export default function DeliveriesList() {
  const { navigate } = useNav();
  const [route, setRoute] = useState<Route | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [filter, setFilter] = useState<'all' | 'open' | 'completed'>('all');
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
      const active = await post<Route>(`/routes/${planned.data.id}/start`);
      setRoute(active.data);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not start a delivery route');
    } finally { setBusy(false); }
  };

  const startRoute = async () => {
    if (!route) return;
    setBusy(true);
    setError('');
    try {
      const r = await post<Route>(`/routes/${route.id}/start`);
      setRoute(r.data);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not start the route');
    } finally { setBusy(false); }
  };

  const isRouteMode = route && route.status !== 'completed';
  const pendingCount = deliveries.filter((delivery) => delivery.status === 'pending' && !delivery.routeId).length;
  const unmappedCount = route?.stops.filter((stop) => !stop.delivery.address.geocoded).length || 0;
  const approximateCount = route?.stops.filter((stop) => stop.delivery.address.approximate).length || 0;
  const visibleDeliveries = deliveries.filter((delivery) => {
    if (filter === 'open') return delivery.status === 'pending' || delivery.status === 'in_progress';
    if (filter === 'completed') return delivery.status === 'delivered' || delivery.status === 'failed';
    return true;
  });
  const items: { delivery: Delivery; leg?: { legDistanceKm: number }; order?: number }[] = isRouteMode
    ? route!.stops.map((s) => ({ delivery: s.delivery, leg: s, order: s.order }))
    : visibleDeliveries.map((d) => ({ delivery: d }));

  return (
    <Screen>
      <View style={{ padding: spacing(5), paddingBottom: 0 }}>
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text }}>{isRouteMode ? "Today's route" : 'Deliveries'}</Text>
        {error ? <Banner text={error} /> : null}
      </View>

      {!isRouteMode && pendingCount > 0 && (
        <View style={{ paddingHorizontal: spacing(5), marginTop: spacing(3) }}>
          <Button title={`Start delivery (${pendingCount} stops)`} onPress={startDelivery} loading={busy} />
        </View>
      )}
      {route?.status === 'planned' && (
        <View style={{ paddingHorizontal: spacing(5), marginTop: spacing(3) }}>
          <Button title="Start delivery" onPress={startRoute} loading={busy} />
          <Text style={{ color: colors.muted, fontSize: 12, marginTop: spacing(2), textAlign: 'center' }}>Route preference: {route.preference.replace(/_/g, ' ')}</Text>
        </View>
      )}
      {route?.status === 'active' && (
        <View style={{ paddingHorizontal: spacing(5), marginTop: spacing(3) }}>
          <Card>
            <Text style={{ fontSize: 13, color: colors.muted }}>{route.progress.done} of {route.progress.total} stops done · {route.distanceKm} km planned</Text>
            <Text style={{ fontSize: 12, color: unmappedCount ? colors.amber : colors.muted, marginTop: spacing(2) }}>{route.stops.length - unmappedCount} of {route.stops.length} destinations mapped and optimized{approximateCount ? ` · ${approximateCount} approximate` : ''}{unmappedCount > approximateCount ? ` · ${unmappedCount - approximateCount} need address review` : ''}</Text>
            <View style={{ marginTop: spacing(3) }}><Button title="Live navigation" variant="secondary" onPress={() => navigate('RouteNavigation')} /></View>
          </Card>
        </View>
      )}

      <FlatList
        data={items}
        keyExtractor={(item) => item.delivery.id}
        contentContainerStyle={{ padding: spacing(5), gap: spacing(3) }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListHeaderComponent={!isRouteMode ? (
          <View style={{ flexDirection: 'row', gap: spacing(2), marginBottom: spacing(2) }}>
            {(['all', 'open', 'completed'] as const).map((value) => (
              <Pressable key={value} onPress={() => setFilter(value)} style={{ flex: 1, paddingVertical: spacing(2), borderRadius: 8, alignItems: 'center', backgroundColor: filter === value ? colors.blueBg : colors.card, borderWidth: 1, borderColor: filter === value ? colors.primary : colors.border }}>
                <Text style={{ color: filter === value ? colors.primary : colors.muted, fontSize: 12, fontWeight: '700', textTransform: 'capitalize' }}>{value}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        ListEmptyComponent={<EmptyState title={filter === 'all' ? 'Nothing here yet' : `No ${filter} deliveries`} subtitle={filter === 'all' ? 'Add deliveries manually or import a courier manifest from the + button below.' : undefined} />}
        renderItem={({ item, index }) => (
          <Pressable onPress={() => navigate('DeliveryDetail', { id: item.delivery.id })}>
            <Card>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1, marginRight: spacing(2) }}>
                  <Text style={{ fontWeight: '700', color: colors.text, fontSize: 15 }}>{item.order ? `Delivery no. ${item.order} · ` : ''}{item.delivery.trackingId}</Text>
                  <Text style={{ color: colors.muted, fontSize: 13, marginTop: 2 }}>{item.delivery.customer.name}</Text>
                  <Text style={{ color: colors.faint, fontSize: 12, marginTop: 2 }} numberOfLines={1}>{item.delivery.address.raw}</Text>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 6 }}>
                  <Badge text={item.delivery.status} tone={STATUS_TONE[item.delivery.status]} />
                  <Text style={{ fontSize: 12, fontWeight: '700', color: item.delivery.payment.type === 'cod' ? colors.amber : colors.primary }}>{item.delivery.payment.type.toUpperCase()}</Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing(2) }}>
                <Text style={{ fontSize: 12, color: colors.muted }}>{money(item.delivery.payment.type === 'cod' ? item.delivery.payment.codAmount : item.delivery.payment.orderValue, item.delivery.payment.currency)}</Text>
                {!item.delivery.address.geocoded && <Text style={{ fontSize: 11, color: colors.amber }}>{item.delivery.address.approximate ? 'Approximate area' : 'Location not found'}</Text>}
              </View>
            </Card>
          </Pressable>
        )}
      />

      <View style={{ position: 'absolute', bottom: spacing(5), right: spacing(5), flexDirection: 'row', gap: spacing(2) }}>
        <Pressable onPress={() => navigate('ImportPdf')} style={{ backgroundColor: '#fff', borderWidth: 1, borderColor: colors.primary, borderRadius: 28, width: 52, height: 52, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 20 }}>📄</Text>
        </Pressable>
        <Pressable onPress={() => navigate('AddManual')} style={{ backgroundColor: colors.primary, borderRadius: 28, width: 52, height: 52, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 26, color: '#fff', marginTop: -2 }}>+</Text>
        </Pressable>
      </View>
    </Screen>
  );
}
