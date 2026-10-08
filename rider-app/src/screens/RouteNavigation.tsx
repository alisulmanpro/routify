import { useCallback, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from '../lib/useFocusEffect';
import { get, post, ApiRequestError } from '../lib/api';
import type { Delivery, Route } from '../lib/types';
import { Banner, Screen } from '../components/Kit';
import { premium as c, premiumRadius as r, premiumShadow } from '../lib/theme';
import { useNav } from '../lib/nav';
import OpenStreetMapNavigation from '../components/OpenStreetMapNavigation';

// Gradients use RN's native CSS gradient support; backgroundColor is the fallback (e.g. web).
const gradient = (value: string): ViewStyle => ({ experimental_backgroundImage: value } as ViewStyle);
const DARK_ON_PRIMARY = '#1A1206';

const STATUS_STYLE: Record<Delivery['status'], { fg: string; bg: string; label: string }> = {
  pending: { fg: c.warning, bg: 'rgba(255,179,64,0.14)', label: 'Pending' },
  in_progress: { fg: c.purpleSoft, bg: 'rgba(139,124,255,0.16)', label: 'In progress' },
  delivered: { fg: c.success, bg: 'rgba(25,216,139,0.14)', label: 'Delivered' },
  failed: { fg: c.danger, bg: 'rgba(255,83,104,0.14)', label: 'Failed' },
};

export default function RouteNavigation() {
  const { navigate, switchTab, resetTab } = useNav();
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
    // Approximate coordinates only point at the general area, so let Google search the full address instead.
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
      <Screen style={{ backgroundColor: c.background, padding: 22, justifyContent: 'center' }}>
        {error ? <Banner text={error} /> : null}
        <View style={{ alignItems: 'center' }}>
          <View style={[s.emptyIcon, { width: 72, height: 72, borderRadius: 36 }]}>
            <MaterialCommunityIcons name="map-marker-path" size={34} color={c.primary} />
          </View>
          <Text style={[s.cardTitle, { fontSize: 18, marginTop: 14 }]}>No active route</Text>
          <Text style={[s.muted, { textAlign: 'center', marginTop: 6, marginBottom: 20 }]}>All caught up. Head back to your dashboard or add more deliveries to plan a new route.</Text>
        </View>
        {/* This screen lives in the Deliveries tab, so reset that stack before leaving it. */}
        <Pressable onPress={() => { resetTab('deliveries'); switchTab('home'); }} style={({ pressed }) => [s.primaryBtn, gradient(PRIMARY_GRADIENT), pressed && { opacity: 0.9 }]}>
          <Ionicons name="home-outline" size={18} color={DARK_ON_PRIMARY} />
          <Text style={s.primaryText}>Go home</Text>
          <Ionicons name="chevron-forward" size={18} color={DARK_ON_PRIMARY} />
        </Pressable>
        <Pressable onPress={() => { resetTab('deliveries'); navigate('AddDelivery'); }} style={({ pressed }) => [s.secondaryBtn, pressed && { opacity: 0.85 }]}>
          <Ionicons name="add-circle-outline" size={18} color={c.primary} />
          <Text style={[s.secondaryText, { textAlign: 'left' }]}>Add more</Text>
          <Ionicons name="chevron-forward" size={18} color={c.textSecondary} />
        </Pressable>
      </Screen>
    );
  }

  const address = current?.delivery.address;
  const hasCoords = !!address && address.latitude != null && address.longitude != null;
  const status = current ? STATUS_STYLE[current.delivery.status] : null;

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 28 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshRoute} tintColor={c.primary} colors={[c.primary]} />}
      >
        {error ? <Banner text={error} /> : null}

        {current && status ? (
          <View style={[s.card, s.nextCard, gradient('linear-gradient(160deg, #16223A 0%, #0D1629 70%)')]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={s.nextLabel}>
                <Text style={s.nextLabelText}>Next stop · Delivery no. {current.order}</Text>
              </View>
              <StatusPill status={current.delivery.status} />
            </View>
            <Text style={s.customer} numberOfLines={1}>{current.delivery.customer.name || `Parcel ${current.delivery.trackingId}`}</Text>
            {current.delivery.customer.name ? <Text style={s.muted}>Parcel {current.delivery.trackingId}</Text> : null}
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 10 }}>
              <Ionicons name="location" size={16} color={c.primary} style={{ marginTop: 1 }} />
              <Text style={s.address}>{current.delivery.address.raw}</Text>
            </View>

            <Pressable onPress={openGoogleMaps} style={({ pressed }) => [s.primaryBtn, { marginTop: 16 }, gradient(PRIMARY_GRADIENT), pressed && { opacity: 0.9 }]}>
              <Ionicons name="navigate-outline" size={18} color={DARK_ON_PRIMARY} />
              <Text style={[s.primaryText, { textAlign: 'center' }]}>Get directions</Text>
              <Ionicons name="chevron-forward" size={18} color={DARK_ON_PRIMARY} />
            </Pressable>
            <Pressable onPress={() => navigate('DeliveryDetail', { id: current.delivery.id })} style={({ pressed }) => [s.secondaryBtn, pressed && { opacity: 0.85 }]}>
              <Ionicons name="document-text-outline" size={18} color={c.text} />
              <Text style={s.secondaryText}>Open delivery details</Text>
              <Ionicons name="chevron-forward" size={18} color={c.textSecondary} />
            </Pressable>
            {!inAppNavigation ? (
              <Pressable onPress={() => { setError(''); setInAppNavigation(true); }} style={{ alignItems: 'center', paddingTop: 12 }}>
                <Text style={{ color: c.primary, fontWeight: '700', fontSize: 13 }}>Show route preview</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <View style={[s.card, { flexDirection: 'row', alignItems: 'center', gap: 12 }]}>
            <View style={[s.emptyIcon, { backgroundColor: 'rgba(25,216,139,0.16)' }]}>
              <Ionicons name="checkmark-done" size={22} color={c.success} />
            </View>
            <Text style={[s.cardTitle, { flex: 1 }]}>All route stops are complete.</Text>
          </View>
        )}

        {inAppNavigation && current ? (
          <View style={s.card}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <Text style={[s.cardTitle, { flex: 1 }]}>Route preview</Text>
              <View style={s.osmChip}>
                <MaterialCommunityIcons name="map-outline" size={12} color={c.textSecondary} />
                <Text style={{ color: c.textSecondary, fontSize: 10, fontWeight: '700' }}>OpenStreetMap</Text>
              </View>
              <Pressable onPress={() => setInAppNavigation(false)} hitSlop={8} style={{ marginLeft: 10 }}>
                <Text style={{ color: c.primary, fontWeight: '800', fontSize: 12 }}>Close</Text>
              </Pressable>
            </View>
            {hasCoords ? (
              <OpenStreetMapNavigation
                destination={{ latitude: address!.latitude!, longitude: address!.longitude! }}
                approximate={!address!.geocoded}
                currentStopId={current.delivery.id}
                stops={route.stops}
                onError={setError}
              />
            ) : (
              <View style={s.mapEmpty}>
                <View style={s.emptyIcon}>
                  <MaterialCommunityIcons name="map-marker-off-outline" size={26} color={c.primary} />
                </View>
                <Text style={[s.cardTitle, { fontSize: 14, marginTop: 10 }]}>Map not available</Text>
                <Text style={[s.muted, { textAlign: 'center', marginTop: 4, fontSize: 12 }]}>We couldn&apos;t find this address on the map yet. Use Get directions, or pull down to retry the address lookup.</Text>
              </View>
            )}
          </View>
        ) : null}

        <View style={s.card}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
            <Text style={[s.cardTitle, { flex: 1 }]}>Route stops</Text>
            <Text style={s.muted}>{route.progress.done} of {route.progress.total} done</Text>
          </View>
          {route.stops.map((stop, index) => {
            const isCurrent = stop.delivery.id === route.currentStopId;
            return (
              <Pressable key={stop.delivery.id} onPress={() => navigate('DeliveryDetail', { id: stop.delivery.id })} style={({ pressed }) => [s.stopRow, index > 0 && s.stopDivider, pressed && { opacity: 0.85 }]}>
                <View style={[s.stopNum, isCurrent && s.stopNumCurrent]}>
                  <Text style={{ fontSize: 12, fontWeight: '800', color: isCurrent ? DARK_ON_PRIMARY : c.text }}>{stop.order}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: c.text, fontWeight: '700', fontSize: 14 }} numberOfLines={1}>{stop.delivery.customer.name || `Parcel ${stop.delivery.trackingId}`}</Text>
                  <Text style={[s.muted, { fontSize: 12 }]} numberOfLines={1}>{stop.delivery.address.raw}</Text>
                </View>
                <StatusPill status={stop.delivery.status} />
                <Ionicons name="chevron-forward" size={16} color={c.textMuted} />
              </Pressable>
            );
          })}
        </View>

        <Pressable onPress={refreshRoute} disabled={refreshing} style={({ pressed }) => [s.refreshBtn, pressed && { opacity: 0.85 }]}>
          {refreshing ? <ActivityIndicator size="small" color={c.primary} /> : <Ionicons name="refresh" size={16} color={c.primary} />}
          <Text style={{ color: c.primary, fontWeight: '700', fontSize: 13 }}>
            {refreshedAt ? `Retry addresses · Updated ${refreshedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Refresh route & retry addresses'}
          </Text>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}

const PRIMARY_GRADIENT = 'linear-gradient(100deg, #C97812 0%, #FFAA32 100%)';

function StatusPill({ status }: { status: Delivery['status'] }) {
  const st = STATUS_STYLE[status];
  return (
    <View style={[s.pill, { backgroundColor: st.bg }]}>
      <View style={[s.pillDot, { backgroundColor: st.fg }]} />
      <Text style={{ color: st.fg, fontSize: 11, fontWeight: '700' }}>{st.label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: c.surface, borderRadius: r.large, borderWidth: 1, borderColor: c.border, padding: 16, ...premiumShadow },
  nextCard: { borderColor: 'rgba(255,170,50,0.35)' },
  nextLabel: { backgroundColor: 'rgba(255,170,50,0.14)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: r.pill, flexShrink: 1, marginRight: 8 },
  nextLabelText: { color: c.primary, fontSize: 10, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
  customer: { color: c.text, fontSize: 20, fontWeight: '800', marginTop: 12 },
  address: { flex: 1, color: c.text, fontSize: 13, lineHeight: 19 },
  muted: { color: c.textSecondary, fontSize: 13 },
  cardTitle: { color: c.text, fontSize: 15, fontWeight: '800' },

  primaryBtn: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 50, paddingHorizontal: 16, borderRadius: r.medium, backgroundColor: c.primary, shadowColor: c.primary, shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 6 },
  primaryText: { flex: 1, color: DARK_ON_PRIMARY, fontSize: 15, fontWeight: '800' },
  secondaryBtn: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 16, marginTop: 10, borderRadius: r.medium, backgroundColor: c.surfaceSoft, borderWidth: 1, borderColor: c.border },
  secondaryText: { flex: 1, color: c.text, fontSize: 14, fontWeight: '700', textAlign: 'center' },

  osmChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: r.pill, backgroundColor: c.surfaceSoft, borderWidth: 1, borderColor: c.border },
  mapEmpty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 28, paddingHorizontal: 18, borderRadius: r.medium, borderWidth: 1, borderStyle: 'dashed', borderColor: c.border, backgroundColor: c.surfaceSoft },
  emptyIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(255,170,50,0.14)', alignItems: 'center', justifyContent: 'center' },

  stopRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  stopDivider: { borderTopWidth: 1, borderTopColor: c.divider },
  stopNum: { width: 30, height: 30, borderRadius: 15, backgroundColor: c.surfaceSoft, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  stopNumCurrent: { backgroundColor: c.primary, borderColor: c.primary },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 4, borderRadius: r.pill },
  pillDot: { width: 6, height: 6, borderRadius: 3 },

  refreshBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12 },
});
