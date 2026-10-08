import { useCallback, useEffect, useState, type ComponentProps } from 'react';
import { Animated, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from '../lib/useFocusEffect';
import { get, post, ApiRequestError } from '../lib/api';
import type { Dashboard as DashboardType, Route } from '../lib/types';
import { todayKey } from '../lib/format';
import { getRouteOrigin } from '../lib/location';
import { Banner, Screen } from '../components/Kit';
import { PButton } from '../components/Premium';
import { BRAND_MARK } from './Login';
import { premium as c, premiumRadius as r, premiumShadow } from '../lib/theme';
import { useNav } from '../lib/nav';

type McIcon = ComponentProps<typeof MaterialCommunityIcons>['name'];

// Gradients use RN's native CSS gradient support; backgroundColor is the fallback (e.g. web).
const gradient = (value: string): ViewStyle => ({ experimental_backgroundImage: value } as ViewStyle);

const ACTION_HINT: Record<DashboardType['nextAction'], string> = {
  setup: 'No stops yet. Tap to add deliveries',
  start: 'Ready to go. Tap to start your route',
  continue: 'Route in progress. Keep going!',
  complete: 'You’re all caught up!',
};

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning,';
  if (h < 17) return 'Good afternoon,';
  return 'Good evening,';
}

export default function Dashboard() {
  const { switchTab, navigate } = useNav();
  const [planning, setPlanning] = useState(false);
  const [data, setData] = useState<DashboardType | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await get<DashboardType>('/rider/dashboard', { date: todayKey() });
      setData(res.data);
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load your dashboard');
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const onAction = async () => {
    if (!data || starting) return;
    if (data.nextAction === 'start') {
      setStarting(true);
      try {
        const origin = await getRouteOrigin();
        const planned = await post<Route>('/routes/build', origin ? { origin } : {});
        await post<Route>(`/routes/${planned.data.id}/start`);
        switchTab('deliveries');
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Could not start a delivery route');
      } finally {
        setStarting(false);
      }
      return;
    }
    switchTab('deliveries');
  };

  // Plans (but does not start) a route from today's open stops, then shows it in Deliveries.
  const planRoute = async () => {
    if (!data || planning) return;
    if (data.routeStatus === 'planned') { switchTab('deliveries'); return; }
    if (data.pending === 0) { navigate('AddDelivery'); return; }
    setPlanning(true);
    setError('');
    try {
      const origin = await getRouteOrigin();
      await post<Route>('/routes/build', origin ? { origin } : {});
      switchTab('deliveries');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not plan a route');
    } finally {
      setPlanning(false);
    }
  };

  if (!data) {
    return (
      <Screen style={{ padding: 22, backgroundColor: c.background }}>
        {error ? <Banner text={error} /> : <Text style={{ color: c.textSecondary }}>Loading…</Text>}
      </Screen>
    );
  }

  const firstName = data.rider.fullName.split(' ')[0];
  const onTrack = data.failed === 0;
  const hasActiveRoute = data.routeStatus === 'active';

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 12, paddingBottom: 28 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} colors={[c.primary]} />}
      >
        {/* Header */}
        <View style={s.header}>
          <View style={s.avatarRing}>
            <View style={s.avatar}>
              <Image source={BRAND_MARK} style={{ width: 34, height: 32 }} resizeMode="contain" accessibilityLabel="Routify" />
            </View>
          </View>
          <View style={{ flex: 1, marginLeft: 14 }}>
            <Text style={s.greeting}>{greeting()}</Text>
            <Text style={s.name} numberOfLines={1}>{firstName}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
              <Text style={s.role}>Rider  •  </Text>
              <View style={s.onlineDot} />
              <Text style={s.role}>Online</Text>
            </View>
          </View>
        </View>

        {error ? <Banner text={error} /> : null}

        <HeroCard />

        {/* Today's deliveries */}
        <Pressable onPress={onAction} style={({ pressed }) => [s.todayCard, pressed && { opacity: 0.92 }]}>
          <View style={s.todayRing}>
            <MaterialCommunityIcons name="cube-outline" size={28} color={c.text} />
          </View>
          <View style={{ flex: 1, marginLeft: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[s.label, { color: '#B4B0FF', flexShrink: 1 }]} numberOfLines={1}>Today&apos;s deliveries</Text>
              <View style={[s.statusPill, !onTrack && { backgroundColor: 'rgba(255,179,64,0.16)' }]}>
                <View style={[s.statusDot, !onTrack && { backgroundColor: c.warning }]} />
                <Text style={[s.statusText, !onTrack && { color: c.warning }]} numberOfLines={1}>{onTrack ? 'On Track' : 'Attention'}</Text>
              </View>
            </View>
            <Text style={s.todayCount}>
              {data.delivered}<Text style={s.todayTotal}> / {data.total}</Text>
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={s.todayHint} numberOfLines={1}>{starting ? 'Starting your route…' : ACTION_HINT[data.nextAction]}</Text>
              <Ionicons name="chevron-forward" size={18} color={c.text} />
            </View>
          </View>
        </Pressable>

        {/* Plan route: only when no route is underway */}
        {!hasActiveRoute ? (
          <PButton
            title={data.routeStatus === 'planned' ? 'View planned route' : data.pending > 0 ? `Plan route · ${data.pending} stop${data.pending === 1 ? '' : 's'}` : 'Plan route · add deliveries'}
            icon={data.pending > 0 ? 'git-network-outline' : 'add-circle-outline'}
            onPress={planRoute}
            loading={planning}
            chevron
            style={{ marginBottom: 16 }}
          />
        ) : null}

        {/* Stats */}
        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 16 }}>
          <StatCard
            flex={1.1}
            icon="map-marker-path"
            iconStyle={[{ backgroundColor: c.purple }, gradient('linear-gradient(135deg, #3B2FC9 0%, #7B5CFF 100%)')]}
            label="Progress"
            value={`${data.progressPercent}%`}
          >
            <ProgressBar progress={data.progressPercent} color={c.purpleSoft} style={{ marginTop: 12 }} />
          </StatCard>
          <StatCard icon="check-bold" iconStyle={{ backgroundColor: '#0F7A4E' }} iconColor="#3FF0A5" label="Delivered" value={String(data.delivered)} />
          <StatCard icon="close-thick" iconStyle={{ backgroundColor: '#7A1E31' }} iconColor="#FF5C74" label="Failed" value={String(data.failed)} />
        </View>

        {/* Route completion */}
        <Pressable onPress={() => switchTab('deliveries')} style={({ pressed }) => [s.card, s.routeCard, pressed && { opacity: 0.9 }]}>
          <View style={s.routeIcon}>
            <MaterialCommunityIcons name="map-marker-path" size={24} color={c.primary} />
          </View>
          <View style={{ flex: 1, marginLeft: 16, marginRight: 12 }}>
            <Text style={s.routeTitle}>Route completion</Text>
            <Text style={s.routeValue}>{data.progressPercent}%</Text>
            <ProgressBar progress={data.progressPercent} color={c.primary} style={{ marginTop: 8 }} />
          </View>
          <Ionicons name="chevron-forward" size={22} color={c.text} />
        </Pressable>

        {/* Totals */}
        <View style={[s.card, { paddingVertical: 18, paddingHorizontal: 18 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
            <Ionicons name="stats-chart" size={17} color={c.primary} />
            <Text style={[s.label, { color: c.primary, marginLeft: 8, fontSize: 12 }]}>Today&apos;s totals</Text>
          </View>
          <TotalRow icon="map-marker" label="Total stops" value={String(data.total)} />
          <TotalRow icon="clock-outline" label="Still to deliver" value={String(data.pending)} />
          <TotalRow icon="check-circle-outline" label="Delivered" value={String(data.delivered)} />
          <TotalRow icon="close-circle-outline" label="Failed" value={String(data.failed)} />
          <TotalRow icon="map-marker-distance" label="Route distance" value={hasActiveRoute ? `${data.distanceKm} km` : '—'} />
        </View>
      </ScrollView>
    </Screen>
  );
}

function HeroCard() {
  return (
    <View style={[s.hero, gradient('linear-gradient(100deg, #0D1629 0%, #141A2B 45%, #3A2A1A 75%, #6B4316 100%)')]}>
      {/* Illustration — sunset glow, skyline, route and rider */}
      <View style={s.heroArt} pointerEvents="none">
        <View style={[StyleSheet.absoluteFill, gradient('radial-gradient(circle at 72% 38%, rgba(255,190,90,0.75) 0%, rgba(255,150,40,0.35) 28%, rgba(13,22,41,0) 62%)')]} />
        {[{ l: 18, w: 16, h: 58 }, { l: 38, w: 12, h: 82 }, { l: 54, w: 18, h: 66 }, { l: 120, w: 14, h: 74 }, { l: 138, w: 20, h: 96 }, { l: 162, w: 12, h: 60 }].map((b) => (
          <View key={b.l} style={[s.building, { left: b.l, width: b.w, height: b.h }]} />
        ))}
        <View style={[s.road, gradient('linear-gradient(0deg, rgba(5,11,24,0.95) 0%, rgba(5,11,24,0) 100%)')]} />
        {ROUTE_DOTS.map(([x, y]) => <View key={`${x}-${y}`} style={[s.routeDot, { left: x, top: y }]} />)}
        <Ionicons name="location" size={30} color={c.primary} style={{ position: 'absolute', left: 4, top: 70 }} />
        <Ionicons name="location" size={22} color={c.primary} style={{ position: 'absolute', left: 74, top: 38 }} />
        <Ionicons name="location-outline" size={18} color="rgba(255,170,50,0.75)" style={{ position: 'absolute', left: 116, top: 6 }} />
        <View style={s.rider}>
          <View style={s.riderBox}>
            <MaterialCommunityIcons name="package-variant-closed" size={24} color={c.primary} />
          </View>
          <MaterialCommunityIcons name="moped" size={64} color="#05070D" style={{ marginTop: -10 }} />
          <View style={s.tailLight} />
        </View>
      </View>
      <View style={[StyleSheet.absoluteFill, gradient('linear-gradient(90deg, rgba(13,22,41,0.95) 0%, rgba(13,22,41,0.6) 40%, rgba(13,22,41,0) 60%)')]} pointerEvents="none" />

      <View style={{ maxWidth: '62%' }}>
        <Text style={[s.label, { color: c.primary }]}>Keep going 👑</Text>
        <Text style={s.heroTitle}>Deliver more,</Text>
        <Text style={[s.heroTitle, { color: c.primary }]}>earn more!</Text>
        <Text style={s.heroSub}>Small steps today,{'\n'}big goals tomorrow.</Text>
      </View>
    </View>
  );
}

const ROUTE_DOTS: [number, number][] = [[18, 100], [28, 104], [38, 103], [48, 98], [56, 90], [64, 82], [74, 72], [84, 64], [92, 58], [100, 50], [106, 40], [112, 30]];

function StatCard({ icon, iconStyle, iconColor = '#fff', label, value, flex = 1, children }: {
  icon: McIcon; iconStyle: ViewStyle | ViewStyle[]; iconColor?: string; label: string; value: string; flex?: number; children?: React.ReactNode;
}) {
  return (
    <View style={[s.card, { flex, paddingVertical: 14, paddingHorizontal: 12, marginBottom: 0 }]}>
      <View style={[s.statIcon, iconStyle]}>
        <MaterialCommunityIcons name={icon} size={18} color={iconColor} />
      </View>
      <Text style={s.statLabel} numberOfLines={1}>{label}</Text>
      <Text style={s.statValue}>{value}</Text>
      {children}
    </View>
  );
}

function TotalRow({ icon, label, value }: { icon: McIcon; label: string; value: string }) {
  return (
    <View style={s.totalRow}>
      <MaterialCommunityIcons name={icon} size={18} color={c.primary} style={{ width: 26 }} />
      <Text style={s.totalLabel}>{label}</Text>
      <Text style={s.totalValue}>{value}</Text>
    </View>
  );
}

function ProgressBar({ progress, color, style }: { progress: number; color: string; style?: ViewStyle }) {
  const [value] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(value, { toValue: Math.max(0, Math.min(progress, 100)), duration: 650, useNativeDriver: false }).start();
  }, [progress, value]);
  const width = value.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] });
  return (
    <View style={[{ height: 8, backgroundColor: '#22314F', borderRadius: 99, overflow: 'hidden' }, style]}>
      <Animated.View style={{ width, height: '100%', borderRadius: 99, backgroundColor: color }} />
    </View>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 18 },
  avatarRing: { width: 54, height: 54, borderRadius: 27, borderWidth: 2, borderColor: 'rgba(139,124,255,0.55)', padding: 3 },
  avatar: { flex: 1, borderRadius: 24, backgroundColor: '#14113F', alignItems: 'center', justifyContent: 'center' },
  greeting: { color: c.textSecondary, fontSize: 13, fontWeight: '500' },
  name: { color: c.text, fontSize: 20, fontWeight: '800', marginTop: 1 },
  role: { color: c.textSecondary, fontSize: 12, fontWeight: '600' },
  onlineDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.success, marginRight: 6 },

  label: { fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },

  hero: { minHeight: 128, borderRadius: r.large, padding: 16, marginBottom: 14, overflow: 'hidden', backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, justifyContent: 'center', ...premiumShadow },
  heroArt: { position: 'absolute', right: 0, top: 0, bottom: 0, width: '58%' },
  heroTitle: { color: c.text, fontSize: 21, fontWeight: '800', lineHeight: 25 },
  heroSub: { color: c.textSecondary, fontSize: 12, lineHeight: 16, marginTop: 6 },
  building: { position: 'absolute', bottom: 34, backgroundColor: 'rgba(40,30,30,0.55)', borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  road: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 44 },
  routeDot: { position: 'absolute', width: 4, height: 4, borderRadius: 2, backgroundColor: c.primary },
  rider: { position: 'absolute', right: 14, bottom: 4, alignItems: 'center' },
  riderBox: { width: 46, height: 40, borderRadius: 6, backgroundColor: '#0A0D16', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#1E2333' },
  tailLight: { position: 'absolute', bottom: 22, width: 14, height: 5, borderRadius: 3, backgroundColor: '#FF4D2E', shadowColor: '#FF4D2E', shadowOpacity: 0.9, shadowRadius: 8, elevation: 6 },

  todayCard: { flexDirection: 'row', alignItems: 'center', padding: 14, minHeight: 88, borderRadius: r.large, marginBottom: 16, borderWidth: 1.5, borderColor: '#4F4BC9', backgroundColor: '#1F2163', ...gradient('linear-gradient(120deg, #1C1F5C 0%, #26267A 100%)'), ...premiumShadow },
  todayRing: { width: 52, height: 52, borderRadius: 26, borderWidth: 3, borderColor: c.success, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(5,11,24,0.25)' },
  todayCount: { color: c.text, fontSize: 24, fontWeight: '800', marginTop: 2 },
  todayTotal: { color: c.purpleSoft, fontSize: 17, fontWeight: '800' },
  todayHint: { flex: 1, color: '#E1DEFF', fontSize: 12, fontWeight: '500', marginRight: 6 },
  statusPill: { flexDirection: 'row', alignItems: 'center', marginLeft: 'auto', backgroundColor: 'rgba(25,216,139,0.18)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: r.pill },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.success, marginRight: 5 },
  statusText: { color: c.success, fontSize: 11, fontWeight: '700' },

  card: { backgroundColor: c.surface, borderRadius: r.large, borderWidth: 1, borderColor: c.border, marginBottom: 16, ...premiumShadow },
  statIcon: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  statLabel: { color: c.textSecondary, fontSize: 12, fontWeight: '600' },
  statValue: { color: c.text, fontSize: 18, fontWeight: '800', marginTop: 2 },

  routeCard: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  routeIcon: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#2A1E10', alignItems: 'center', justifyContent: 'center' },
  routeTitle: { color: c.text, fontSize: 13, fontWeight: '700' },
  routeValue: { color: c.text, fontSize: 17, fontWeight: '800', marginTop: 2 },

  totalRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.divider },
  totalLabel: { flex: 1, color: c.textSecondary, fontSize: 13, fontWeight: '500', marginLeft: 6 },
  totalValue: { color: c.text, fontSize: 13, fontWeight: '800' },
});
