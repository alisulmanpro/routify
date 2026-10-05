import { useCallback, useState } from 'react';
import { Linking, Platform, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useFocusEffect } from '../lib/useFocusEffect';
import { get, post, ApiRequestError } from '../lib/api';
import type { Route } from '../lib/types';
import { shortDate, titleCase } from '../lib/format';
import { Badge, Banner, Button, Card, EmptyState, Screen } from '../components/Kit';
import { colors, spacing } from '../lib/theme';
import { useNav } from '../lib/nav';
import OpenStreetMapNavigation from '../components/OpenStreetMapNavigation';

export default function RouteNavigation() {
  const { navigate, switchTab } = useNav();
  const [route, setRoute] = useState<Route | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  // Keep the route preview open as the active stop advances after a delivery.
  const [inAppNavigation, setInAppNavigation] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setRoute((await get<Route | null>('/routes/current')).data);
      setError('');
      setRefreshedAt(new Date());
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load the active route');
    } finally {
      setRefreshing(false);
    }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const refreshRoute = async () => {
    if (!route) { await load(); return; }
    setRefreshing(true);
    try {
      setRoute((await post<Route>(`/routes/${route.id}/retry-geocoding`)).data);
      setError('');
      setRefreshedAt(new Date());
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not refresh route or retry address lookup');
    } finally {
      setRefreshing(false);
    }
  };

  const current = route?.stops.find((stop) => stop.delivery.id === route.currentStopId) || null;
  const openGoogleMaps = async () => {
    if (!current) return;
    const { address } = current.delivery;
    const destination = address.geocoded && address.latitude != null && address.longitude != null
      ? `${address.latitude},${address.longitude}`
      : address.raw;
    const webUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving&dir_action=navigate`;
    const navigationUrl = Platform.OS === 'android'
      ? `google.navigation:q=${encodeURIComponent(destination)}&mode=d`
      : webUrl;
    try {
      await Linking.openURL(navigationUrl);
    } catch {
      try { await Linking.openURL(webUrl); }
      catch { setError('Could not open Google Maps. Check that a maps app or browser is available.'); }
    }
  };

  if (!route) {
    return (
      <Screen style={{ padding: spacing(5) }}>
        {error ? <Banner text={error} /> : null}
        <EmptyState title="No active route" subtitle="Plan and start a route to see ordered stops and navigation here." />
        <Button title="Go to deliveries" onPress={() => switchTab('deliveries')} />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: spacing(5), gap: spacing(3) }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshRoute} />}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View>
            <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text }}>Live navigation</Text>
            <Text style={{ color: colors.muted, fontSize: 13, marginTop: 3 }}>{shortDate(route.serviceDate)} · {titleCase(route.preference)} route</Text>
          </View>
          <Badge text={route.status} tone={route.status === 'active' ? 'green' : 'blue'} />
        </View>
        {error ? <Banner text={error} /> : null}

        {current ? (
          <Card>
            <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '800', textTransform: 'uppercase' }}>Next stop · Delivery no. {current.order}</Text>
            <Text style={{ color: colors.text, fontSize: 19, fontWeight: '800', marginTop: spacing(2) }}>{current.delivery.customer.name}</Text>
            <Text style={{ color: colors.muted, marginTop: 4 }}>{current.delivery.trackingId}</Text>
            <Text style={{ color: colors.text, marginTop: spacing(3) }}>{current.delivery.address.raw}</Text>
            <View style={{ marginTop: spacing(4), gap: spacing(2) }}>
              <Button title="Get directions" onPress={openGoogleMaps} />
              {!inAppNavigation ? <Button title="Show route preview" variant="ghost" onPress={() => { setError(''); setInAppNavigation(true); }} /> : null}
              <Button title="Open delivery details" variant="secondary" onPress={() => navigate('DeliveryDetail', { id: current.delivery.id })} />
            </View>
          </Card>
        ) : (
          <Card><Text style={{ color: colors.green, fontWeight: '700' }}>All route stops are complete.</Text></Card>
        )}

        {inAppNavigation && current && (
          <Card>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing(3) }}>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>Route preview · OpenStreetMap</Text>
              <Pressable onPress={() => setInAppNavigation(false)}><Text style={{ color: colors.primary, fontWeight: '700' }}>Close</Text></Pressable>
            </View>
            {current.delivery.address.geocoded && current.delivery.address.latitude != null && current.delivery.address.longitude != null ? (
              <OpenStreetMapNavigation
                destination={{ latitude: current.delivery.address.latitude, longitude: current.delivery.address.longitude }}
                currentStopId={current.delivery.id}
                stops={route.stops}
                onError={setError}
              />
            ) : (
              <Text style={{ color: colors.amber }}>{current.delivery.address.approximate ? 'Only the general area was found, not this exact address. Verify the address and use Google Maps, or correct it before replanning.' : 'This stop has no map coordinates yet. Use Google Maps with the saved address or fix the address and replan.'}</Text>
            )}
          </Card>
        )}

        <Card>
          <Text style={{ fontSize: 15, fontWeight: '800', color: colors.text, marginBottom: spacing(3) }}>Route stops</Text>
          {route.stops.map((stop, index) => (
            <Pressable key={stop.delivery.id} onPress={() => navigate('DeliveryDetail', { id: stop.delivery.id })} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing(3), paddingVertical: spacing(3), borderTopWidth: index === 0 ? 0 : 1, borderTopColor: colors.border }}>
              <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: stop.delivery.id === route.currentStopId ? colors.primary : colors.muted2, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 12, fontWeight: '800', color: stop.delivery.id === route.currentStopId ? '#fff' : colors.text }}>{stop.order}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontWeight: '700' }}>{stop.delivery.customer.name}</Text>
                <Text style={{ color: colors.muted, fontSize: 12 }} numberOfLines={1}>{stop.delivery.address.raw}</Text>
              </View>
              <Badge text={stop.delivery.status} tone={stop.delivery.status === 'delivered' ? 'green' : stop.delivery.status === 'failed' ? 'red' : stop.delivery.status === 'in_progress' ? 'blue' : 'amber'} />
            </Pressable>
          ))}
        </Card>
        <Button title={refreshedAt ? `Retry addresses · Updated ${refreshedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Refresh route & retry addresses'} variant="ghost" onPress={refreshRoute} loading={refreshing} />
      </ScrollView>
    </Screen>
  );
}
