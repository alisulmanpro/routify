import { useCallback, useMemo, useState } from 'react';
import { Alert, Platform, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useFocusEffect } from '../lib/useFocusEffect';
import { del, get, ApiRequestError } from '../lib/api';
import type { Route } from '../lib/types';
import { dayKey, fromDayKey } from '../lib/format';
import { Screen } from '../components/Kit';
import { LightError } from '../components/LightKit';
import { useNav } from '../lib/nav';
import { light as c } from '../lib/theme';

type Filter = 'all' | 'completed' | 'failures';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'completed', label: 'Completed' },
  { key: 'failures', label: 'With failures' },
];

/** "Today", "Yesterday", then "18 Oct". */
const dayHeading = (key: string) => {
  if (key === dayKey(0)) return 'Today';
  if (key === dayKey(-1)) return 'Yesterday';
  return fromDayKey(key).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

/** History (design_pref "History"): finished routes by day, newest first. Tapping one opens its summary. */
export default function History() {
  const { navigate } = useNav();
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setRoutes((await get<Route[]>('/routes')).data); setError(''); }
    catch (err) { setError(err instanceof ApiRequestError ? err.message : 'Could not load history'); setRoutes((r) => r ?? []); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const sections = useMemo(() => {
    const shown = (routes || []).filter((r) => filter === 'all' || (filter === 'failures' ? r.summary.failed > 0 : r.summary.failed === 0));
    const byDay = new Map<string, Route[]>();
    for (const r of shown) byDay.set(r.serviceDate, [...(byDay.get(r.serviceDate) || []), r]);
    return [...byDay.keys()].sort().reverse().map((key) => ({ key, title: dayHeading(key), data: byDay.get(key)! }));
  }, [routes, filter]);

  const clearHistory = async () => {
    setRefreshing(true);
    setError('');
    try { await del('/rider/history'); await load(); }
    catch (err) { setError(err instanceof ApiRequestError ? err.message : 'Could not clear history'); }
    finally { setRefreshing(false); }
  };

  const confirmClearHistory = () => {
    const message = 'This permanently removes completed deliveries, completed routes, and generated reports. Open deliveries are kept.';
    if (Platform.OS === 'web') {
      if (globalThis.confirm(message)) void clearHistory();
      return;
    }
    Alert.alert('Clear history?', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear history', style: 'destructive', onPress: () => void clearHistory() },
    ]);
  };

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <StatusBar style="dark" />
      <SectionList
        sections={sections}
        keyExtractor={(r) => r.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 28 }}
        refreshControl={<RefreshControl tintColor={c.ink} colors={[c.ink]} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListHeaderComponent={(
          <>
            <View style={s.titleRow}>
              <Text style={s.title}>History</Text>
              {/* Not in the design: clearing finished work, as before. */}
              {routes?.length ? (
                <Pressable onPress={confirmClearHistory} hitSlop={8} accessibilityLabel="Clear history">
                  <Text style={{ color: c.danger, fontSize: 15, fontWeight: '600' }}>Clear</Text>
                </Pressable>
              ) : null}
            </View>
            <View style={s.filters}>
              {FILTERS.map((f) => {
                const on = filter === f.key;
                return (
                  <Pressable key={f.key} onPress={() => setFilter(f.key)} style={[s.chip, on && s.chipOn]} accessibilityRole="tab" accessibilityState={{ selected: on }}>
                    <Text style={[s.chipText, on && { color: c.onInk }]}>{f.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <LightError text={error} />
          </>
        )}
        renderSectionHeader={({ section }) => <Text style={s.day}>{section.title}</Text>}
        renderItem={({ item, index }) => {
          const stops = item.progress.total;
          return (
            <Pressable onPress={() => navigate('RouteDetail', { id: item.id })} style={({ pressed }) => [s.row, index > 0 && s.divider, pressed && { opacity: 0.7 }]}>
              <View style={{ flex: 1, marginRight: 12 }}>
                <Text style={s.name} numberOfLines={1}>{item.name || 'Route'}</Text>
                <Text style={s.meta}>{stops} stop{stops === 1 ? '' : 's'}{item.distanceKm > 0 ? ` · ${Math.round(item.distanceKm)} km` : ''}</Text>
                <View style={s.counts}>
                  <Dot color={c.success} text={`${item.summary.delivered} delivered`} />
                  {item.summary.failed ? <Dot color={c.danger} text={`${item.summary.failed} failed`} /> : null}
                </View>
              </View>
              <Ionicons name="chevron-forward" size={22} color={c.placeholder} />
            </Pressable>
          );
        }}
        ListEmptyComponent={routes ? (
          <View style={{ alignItems: 'center', paddingTop: 48 }}>
            <MaterialCommunityIcons name="history" size={48} color={c.placeholder} />
            <Text style={{ color: c.text, fontSize: 18, fontWeight: '700', marginTop: 12 }}>{filter === 'all' ? 'No history yet' : 'Nothing here'}</Text>
            <Text style={{ color: c.textSecondary, fontSize: 15, marginTop: 6, textAlign: 'center' }}>
              {filter === 'all' ? 'Finished routes will show up here.' : filter === 'failures' ? 'No finished routes with failed stops.' : 'No routes finished without failures yet.'}
            </Text>
          </View>
        ) : null}
        SectionSeparatorComponent={() => <View style={{ height: 8 }} />}
      />
    </Screen>
  );
}

function Dot({ color, text }: { color: string; text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />
      <Text style={{ color: c.textLabel, fontSize: 15 }}>{text}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: c.text, fontSize: 32, fontWeight: '800', letterSpacing: -0.5 },
  filters: { flexDirection: 'row', gap: 10, marginTop: 18, marginBottom: 12 },
  chip: { paddingHorizontal: 18, height: 40, borderRadius: 20, backgroundColor: c.soft, justifyContent: 'center' },
  chipOn: { backgroundColor: c.ink },
  chipText: { color: c.textLabel, fontSize: 15, fontWeight: '600' },
  day: { color: c.textSecondary, fontSize: 15, fontWeight: '600', marginTop: 16, marginBottom: 2 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16 },
  divider: { borderTopWidth: 1, borderTopColor: c.border },
  name: { color: c.text, fontSize: 18, fontWeight: '600' },
  meta: { color: c.textSecondary, fontSize: 15, marginTop: 4 },
  counts: { flexDirection: 'row', gap: 18, marginTop: 8 },
});
