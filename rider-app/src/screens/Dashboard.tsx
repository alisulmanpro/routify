import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type DimensionValue } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { post, ApiRequestError } from '../lib/api';
import { useHome, type HomeData } from '../lib/queries';
import type { Route } from '../lib/types';
import { dayLabel, defaultRouteName, timeOnly, todayKey } from '../lib/format';
import { routeNameFor } from '../lib/routeNames';
import { getRouteOrigin } from '../lib/location';
import { Screen } from '../components/Kit';
import { LightButton, LightError, LightProgress } from '../components/LightKit';
import PlanNudge from '../components/PlanNudge';
import { useAuth } from '../lib/auth';
import { light as c } from '../lib/theme';
import { useNav } from '../lib/nav';

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning,';
  if (h < 17) return 'Good afternoon,';
  return 'Good evening,';
}

export default function Dashboard() {
  const { navigate, switchTab } = useNav();
  const { user } = useAuth();
  // Home is drawn from the saved copy at once (also after a restart or offline) and refreshed in the background.
  const home = useHome();
  const data = home.data?.dashboard ?? null;
  // Every route from today on (planned, underway or done): today's list, and the next day's card.
  const routes = home.data?.routes ?? [];
  // Stops added for today or later that aren't in a route yet (the rider left before planning them), per day.
  const unplanned = home.data?.unplanned ?? [];
  // Open stops from earlier days: offered to move to today, never removed.
  const leftOver = home.data?.leftOver ?? null;
  // No connection on the last load (the request itself failed): the last data stays on screen with an offline banner.
  const offline = home.error instanceof TypeError;
  const syncedAt = home.dataUpdatedAt ? new Date(home.dataUpdatedAt).toISOString() : null;
  const [retrying, setRetrying] = useState(false);
  const [moving, setMoving] = useState(false);
  const [actionError, setActionError] = useState('');
  const loadError = home.error instanceof ApiRequestError ? home.error.message : home.error && !offline ? 'Could not load your dashboard' : '';
  const error = actionError || loadError;
  const [refreshing, setRefreshing] = useState(false);
  const load = home.refetch;

  const retry = async () => { setRetrying(true); await load(); setRetrying(false); };

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const moveToToday = async () => {
    if (moving) return;
    setMoving(true);
    setActionError('');
    try {
      const origin = await getRouteOrigin();
      const res = await post<{ moved: number; route: Route | null }>('/routes/carry-over', { date: todayKey(), ...(origin ? { origin } : {}) });
      await load();
      if (res.data.route) navigate('RoutePreview', { routeId: res.data.route.id });
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Could not move those stops to today');
    } finally {
      setMoving(false);
    }
  };

  const header = (name: string, online: boolean) => {
    const first = name.split(' ')[0];
    return (
      <View style={s.header}>
        <View style={s.avatar}><Text style={s.avatarText}>{first.charAt(0).toUpperCase() || '—'}</Text></View>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={s.greeting} numberOfLines={1}>{greeting()} {first}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
            <View style={[s.onlineDot, !online && { backgroundColor: c.placeholder }]} />
            <Text style={[s.online, !online && { color: c.textSecondary }]}>{online ? 'Online' : 'Offline'}</Text>
          </View>
        </View>
        <PlanNudge />
        <Pressable onPress={() => switchTab('account')} hitSlop={10} style={{ marginLeft: 12 }} accessibilityLabel="Settings">
          <Ionicons name="settings-outline" size={26} color={c.text} />
        </Pressable>
      </View>
    );
  };

  // First load: grey placeholders while it loads (design_pref "State · Loading"), or "Something went wrong" with
  // Try again when it failed (design_pref "State · Error").
  if (!data) {
    const failed = !!error || offline;
    return (
      <Screen style={{ backgroundColor: c.background }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 24, paddingTop: 24, paddingBottom: 24 }}>
          {header(user?.fullName || '', !offline)}
          {failed ? (
            <View style={s.errorState}>
              <View style={s.errorCircle}>
                <Ionicons name="cloud-outline" size={110} color={c.ink} />
                <Text style={s.errorMark}>!</Text>
              </View>
              <Text style={s.emptyTitle}>Something went wrong</Text>
              <Text style={s.emptySub}>
                {offline ? "We couldn't load your routes. Check your connection and try again." : error || "We couldn't load your routes. Try again."}
              </Text>
              <LightButton title="Try again" icon={<Ionicons name="refresh" size={22} color={c.onInk} />} onPress={() => void retry()} loading={retrying} style={{ alignSelf: 'stretch', marginTop: 32 }} />
            </View>
          ) : <HomeSkeleton />}
        </ScrollView>
      </Screen>
    );
  }

  const today = todayKey();
  const todayRoutes = routes.filter((route) => route.serviceDate === today);
  const todayLoose = unplanned.find((d) => d.date === today)?.count ?? 0;
  // Today shows its progress whenever it has stops, even loose ones not yet planned into a route.
  const empty = todayRoutes.length === 0 && data.total === 0;

  // The next day with work on it: its first route, and the stops added for it that were never planned.
  const nextDay = [...routes.map((route) => route.serviceDate), ...unplanned.map((d) => d.date)].filter((key) => key > today).sort()[0];
  const nextRoute = nextDay ? routes.find((route) => route.serviceDate === nextDay && route.status !== 'completed') : undefined;
  const nextLoose = nextDay ? unplanned.find((d) => d.date === nextDay)?.count ?? 0 : 0;

  // Stops added but never confirmed: back to Add stops for that day (it lists them), to add more or review and plan.
  const continueAdding = async (date: string) => {
    const name = (await routeNameFor(date)) || defaultRouteName(date);
    navigate('AddStops', { name, date });
  };

  // Today's routes and unplanned stops first, then the next day's: the same card for each.
  const cards: { key: string; date: string; title: string; meta: string; loose?: boolean; onPress: () => void }[] = [
    // Finished routes leave Home (they are in History); they still count in "delivered today".
    ...todayRoutes.filter((route) => route.status !== 'completed').map((route) => ({ key: route.id, date: today, title: route.name || 'Route', meta: routeMeta(route), onPress: () => navigate('RoutePreview', { routeId: route.id }) })),
    ...(todayLoose ? [{ key: 'loose-today', date: today, title: stopCount(todayLoose, 'added'), meta: 'Not finished. Tap to keep adding stops', loose: true, onPress: () => void continueAdding(today) }] : []),
    ...(nextDay && nextRoute ? [{ key: nextRoute.id, date: nextDay, title: nextRoute.name || 'Route', meta: routeMeta(nextRoute), onPress: () => navigate('RoutePreview', { routeId: nextRoute.id }) }] : []),
    ...(nextDay && nextLoose ? [{ key: 'loose-next', date: nextDay, title: stopCount(nextLoose, 'added'), meta: 'Not finished. Tap to keep adding stops', loose: true, onPress: () => void continueAdding(nextDay) }] : []),
  ];

  return (
    <Screen style={{ backgroundColor: c.background }}>
      {/* design_pref "State · Offline": the last data stays, with this banner; tap it to try again. */}
      {offline ? (
        <Pressable onPress={() => void retry()} style={s.offlineBar} accessibilityLabel="You're offline. Tap to try again">
          {retrying ? <ActivityIndicator size="small" color={c.warning} /> : <Ionicons name="cloud-offline-outline" size={20} color={c.warning} />}
          {/* MISSING: see missing.md — there is no offline queue, so nothing is saved to "sync later". */}
          <Text style={s.offlineText}>You&apos;re offline — reconnect to update</Text>
        </Pressable>
      ) : null}
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 24, paddingTop: 24, paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.ink} colors={[c.ink]} />}
      >
        {header(data.rider.fullName, !offline)}

        <LightError text={error} />

        {leftOver && leftOver.total > 0 ? (
          <View style={s.leftOver}>
            <MaterialCommunityIcons name="calendar-arrow-right" size={22} color={c.warning} />
            <Text style={{ flex: 1, color: c.text, fontSize: 14, fontWeight: '500' }}>
              {leftOver.total} stop{leftOver.total === 1 ? '' : 's'} left from {leftOver.days.length === 1 ? dayLabel(leftOver.days[0].date) : 'earlier days'}. Move to today?
            </Text>
            <Pressable onPress={() => void moveToToday()} disabled={moving} style={({ pressed }) => [s.leftOverButton, (pressed || moving) && { opacity: 0.7 }]}>
              <Text style={{ color: c.onInk, fontWeight: '600', fontSize: 13 }}>{moving ? 'Moving…' : 'Move'}</Text>
            </Pressable>
          </View>
        ) : null}

        {empty ? (
          <View style={{ alignItems: 'center', paddingTop: 24 }}>
            <EmptyBox />
            <Text style={s.emptyTitle}>No route for today</Text>
            <Text style={s.emptySub}>Add your stops by scanning, typing or importing</Text>
            <LightButton title="Plan a route" onPress={() => navigate('NewRoute', { date: today })} style={{ alignSelf: 'stretch', marginTop: 32 }} />
          </View>
        ) : (
          <>
            <Text style={s.bigCount}>{data.delivered}<Text style={s.bigTotal}> / {data.total}</Text></Text>
            <Text style={s.bigSub}>delivered today{data.failed > 0 ? ` · ${data.failed} failed` : ''}</Text>
            <LightProgress progress={data.progressPercent} style={{ marginTop: 20, marginBottom: 28 }} />
            <LightButton title="New route" icon={<Ionicons name="add" size={22} color={c.onInk} />} onPress={() => navigate('NewRoute', { date: today })} />
          </>
        )}

        {/* Today's routes and the next day's, as cards; on an empty day they sit at the bottom */}
        <View style={{ gap: 10, marginTop: empty ? 'auto' : 28, paddingTop: empty ? 28 : 0 }}>
          {cards.map((card) => (
            <Pressable key={card.key} onPress={card.onPress} style={({ pressed }) => [s.nextCard, card.loose && s.unfinished, pressed && { opacity: 0.85 }]}>
              <View style={[s.nextIcon, card.loose && { backgroundColor: c.surface }]}>
                <Ionicons name={card.loose ? 'create-outline' : 'calendar-outline'} size={20} color={card.loose ? c.danger : c.link} />
              </View>
              <View style={{ flex: 1, marginLeft: 14, marginRight: 8 }}>
                <Text style={s.nextTitle} numberOfLines={1}>{dayLabel(card.date)} · {card.title}</Text>
                <Text style={s.routeMeta}>{card.meta}</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={c.placeholder} />
            </Pressable>
          ))}
        </View>
        {offline && syncedAt ? (
          <View style={s.synced}>
            <Ionicons name="time-outline" size={18} color={c.textSecondary} />
            <Text style={{ color: c.textSecondary, fontSize: 15 }}>Last synced {timeOnly(syncedAt)}</Text>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const stopCount = (n: number, suffix: string) => `${n} stop${n === 1 ? '' : 's'} ${suffix}`;

/** "7 stops · In progress" for a running route, "9 stops ready" for a planned one (finished ones aren't on Home). */
const routeMeta = (route: HomeData['routes'][number]) => {
  const stops = route.progress.total;
  if (route.status === 'active') return stopCount(stops, '· In progress');
  return stopCount(stops, 'ready');
};

/** Grey placeholders shaped like Home (count, progress, button, route rows), gently pulsing while it loads. */
function HomeSkeleton() {
  const [pulse] = useState(() => new Animated.Value(0.55));
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0.55, duration: 700, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const bone = (width: DimensionValue, height: number, extra?: object) => <View style={[s.bone, { width, height }, extra]} />;
  return (
    <Animated.View style={{ opacity: pulse }} accessibilityLabel="Loading" accessibilityRole="progressbar">
      {bone('40%', 52, { borderRadius: 14 })}
      {bone('34%', 16, { marginTop: 12 })}
      {bone('100%', 6, { marginTop: 18 })}
      {bone('100%', 56, { marginTop: 24, borderRadius: 18 })}
      {bone('27%', 18, { marginTop: 36 })}
      {[56, 50, 62, 44].map((w, i) => (
        <View key={i} style={[s.boneRow, i > 0 && { borderTopWidth: 1, borderTopColor: c.border }]}>
          <View style={{ flex: 1 }}>
            {bone(`${w}%`, 16)}
            {bone(`${w - 26}%`, 12, { marginTop: 8 })}
          </View>
          {bone(76, 24, { borderRadius: 12 })}
        </View>
      ))}
    </Animated.View>
  );
}

// Rendered at 3x from the owner's empty-state SVG; the app has no SVG support.
const EMPTY_ROUTE = require('../../assets/brand/empty-route.png');

function EmptyBox() {
  return <Image source={EMPTY_ROUTE} style={{ width: 168, height: 128 }} resizeMode="contain" accessibilityElementsHidden importantForAccessibility="no" />;
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 24 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: c.linkBg, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: c.link, fontSize: 17, fontWeight: '600' },
  greeting: { color: c.text, fontSize: 17, fontWeight: '600' },
  online: { color: c.success, fontSize: 13, fontWeight: '500' },
  onlineDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.success, marginRight: 6 },


  leftOver: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, backgroundColor: c.warningBg, marginBottom: 24 },
  leftOverButton: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: c.ink },

  bigCount: { color: c.text, fontSize: 56, fontWeight: '800', letterSpacing: -2, lineHeight: 62 },
  bigTotal: { color: c.placeholder, fontSize: 36, fontWeight: '700', letterSpacing: 0 },
  bigSub: { color: c.textSecondary, fontSize: 16, marginTop: 6 },

  emptyTitle: { color: c.text, fontSize: 22, fontWeight: '700', marginTop: 36, textAlign: 'center' },
  emptySub: { color: c.textSecondary, fontSize: 16, lineHeight: 24, marginTop: 10, textAlign: 'center', maxWidth: 280 },

  routeMeta: { color: c.textSecondary, fontSize: 14, marginTop: 4 },

  errorState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 24 },
  errorCircle: { width: 200, height: 200, borderRadius: 100, backgroundColor: c.dangerBg, alignItems: 'center', justifyContent: 'center' },
  errorMark: { position: 'absolute', top: 76, color: c.danger, fontSize: 34, fontWeight: '800' },
  offlineBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 24, paddingVertical: 12, backgroundColor: '#FEF3C7' },
  offlineText: { color: c.warning, fontSize: 15, fontWeight: '600', flex: 1 },
  synced: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 20 },
  bone: { backgroundColor: c.soft, borderRadius: 8 },
  boneRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 18, gap: 16 },
  nextCard: { flexDirection: 'row', alignItems: 'center', padding: 14, borderRadius: 16, backgroundColor: c.soft },
  // Stops added but not confirmed yet: a red outline so the rider sees this one is still in progress.
  unfinished: { borderWidth: 1.5, borderColor: c.danger, backgroundColor: c.dangerBg },
  nextIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: c.linkBg, alignItems: 'center', justifyContent: 'center' },
  nextTitle: { color: c.text, fontSize: 15, fontWeight: '600' },
});
