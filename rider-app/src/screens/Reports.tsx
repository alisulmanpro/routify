import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useFocusEffect } from '../lib/useFocusEffect';
import { get, post, fileUrl, ApiRequestError } from '../lib/api';
import type { HistoryDay, ReportRow, Route } from '../lib/types';
import { dayKey, fromDayKey, shortDate, toDayKey, todayKey } from '../lib/format';
import { Screen } from '../components/Kit';
import { LightButton, LightError } from '../components/LightKit';
import { light as c, lightRadius as lr } from '../lib/theme';

type Period = 'week' | 'month';
type Bar = { key: string; label: string; value: number };

const CHART_HEIGHT = 140;

/** Monday of this week, and the first of this month, as day keys. */
function periodStart(period: Period) {
  const d = new Date();
  if (period === 'month') return toDayKey(new Date(d.getFullYear(), d.getMonth(), 1));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toDayKey(d);
}

/**
 * Reports (design_pref "Reports"): this week's or month's deliveries, success rate, distance and time on route, and
 * deliveries per day (week) or per week (month). Daily PDF reports, as before, are below.
 */
export default function Reports() {
  const [period, setPeriod] = useState<Period>('week');
  const [days, setDays] = useState<HistoryDay[] | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [reportDate, setReportDate] = useState(todayKey());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [history, done, rows] = await Promise.all([
        get<HistoryDay[]>('/rider/history'),
        get<Route[]>('/routes'),
        get<ReportRow[]>('/reports'),
      ]);
      setDays(history.data);
      setRoutes(done.data);
      setReports(rows.data);
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load reports');
      setDays((d) => d ?? []);
    }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const stats = useMemo(() => {
    const from = periodStart(period);
    const to = todayKey();
    const inRange = (key: string) => key >= from && key <= to;
    const shown = (days || []).filter((d) => inRange(d.date));
    const delivered = shown.reduce((a, d) => a + d.delivered, 0);
    const finished = shown.reduce((a, d) => a + d.delivered + d.failed, 0);
    const km = shown.reduce((a, d) => a + d.distanceKm, 0);
    const minutes = routes.filter((r) => inRange(r.serviceDate)).reduce((a, r) => a + (r.summary.routeMinutes || 0), 0);
    const perDay = new Map(shown.map((d) => [d.date, d.delivered + d.failed]));

    let bars: Bar[];
    if (period === 'week') {
      bars = Array.from({ length: 7 }, (_, i) => {
        const d = fromDayKey(from);
        d.setDate(d.getDate() + i);
        const key = toDayKey(d);
        return { key, label: d.toLocaleDateString(undefined, { weekday: 'short' }), value: perDay.get(key) || 0 };
      });
    } else {
      // Weeks of the month: days 1–7, 8–14, … so every bar covers the same span.
      const first = fromDayKey(from);
      const length = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      bars = Array.from({ length: Math.ceil(length / 7) }, (_, w) => {
        let value = 0;
        for (let day = w * 7 + 1; day <= Math.min(length, w * 7 + 7); day++) {
          value += perDay.get(toDayKey(new Date(first.getFullYear(), first.getMonth(), day))) || 0;
        }
        return { key: `w${w}`, label: `${w * 7 + 1}–${Math.min(length, w * 7 + 7)}`, value };
      });
    }
    return { finished, success: finished ? Math.round((delivered / finished) * 100) : null, km, minutes, bars };
  }, [days, routes, period]);

  const generate = async () => {
    setBusy(true);
    setError('');
    try { await post('/reports/generate', { date: reportDate }); await load(); }
    catch (err) { setError(err instanceof ApiRequestError ? err.message : 'Could not generate a report for this date.'); }
    finally { setBusy(false); }
  };
  const open = (row: ReportRow) => Linking.openURL(fileUrl(row.downloadUrl)).catch(() => setError('Could not open report'));
  const shift = (by: number) => setReportDate((d) => { const x = fromDayKey(d); x.setDate(x.getDate() + by); const k = toDayKey(x); return k > todayKey() ? d : k; });

  const max = Math.max(1, ...stats.bars.map((b) => b.value));
  const hours = stats.minutes / 60;

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 32 }}
        refreshControl={<RefreshControl tintColor={c.ink} colors={[c.ink]} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
      >
        <Text style={s.title}>Reports</Text>
        <View style={s.segment}>
          {(['week', 'month'] as Period[]).map((p) => (
            <Pressable key={p} onPress={() => setPeriod(p)} style={[s.segItem, period === p && s.segOn]} accessibilityRole="tab" accessibilityState={{ selected: period === p }}>
              <Text style={[s.segText, period === p && { color: c.text }]}>{p === 'week' ? 'Week' : 'Month'}</Text>
            </Pressable>
          ))}
        </View>
        <LightError text={error} />

        {!days ? <ActivityIndicator color={c.ink} style={{ marginTop: 40 }} /> : (
          <>
            <View style={s.grid}>
              <Stat value={String(stats.finished)} label="Deliveries" />
              <Stat value={stats.success == null ? '—' : String(stats.success)} unit={stats.success == null ? undefined : '%'} label="Success rate" />
              <Stat value={String(Math.round(stats.km))} unit="km" label="Distance" />
              <Stat value={hours >= 10 || hours === 0 ? String(Math.round(hours)) : hours.toFixed(1)} unit="h" label="Time on route" />
            </View>

            <Text style={s.section}>{period === 'week' ? 'Deliveries per day' : 'Deliveries per week'}</Text>
            <View style={s.chart} accessibilityLabel={stats.bars.map((b) => `${b.label}: ${b.value}`).join(', ')}>
              {stats.bars.map((b) => {
                const h = b.value ? Math.max(6, Math.round((b.value / max) * CHART_HEIGHT)) : 0;
                return (
                  <View key={b.key} style={s.barCol}>
                    <Text style={s.barValue}>{b.value}</Text>
                    <View style={[s.bar, { height: h }, !b.value && s.barEmpty]} />
                  </View>
                );
              })}
            </View>
            <View style={s.axis} />
            <View style={{ flexDirection: 'row', gap: 2 }}>
              {stats.bars.map((b) => <Text key={b.key} style={s.barLabel} numberOfLines={1}>{b.label}</Text>)}
            </View>

            {/* MISSING: see missing.md — the server only makes daily PDFs, not one for a week or month. */}
            <LightButton title="Export PDF" variant="outline" icon={<Ionicons name="download-outline" size={22} color={c.text} />} onPress={() => {}} disabled style={{ marginTop: 28 }} />

            {/* Not in the design: the daily PDF reports, as before. */}
            <View style={s.dailyHead}>
              <Text style={[s.section, { marginTop: 0 }]}>Daily PDF reports</Text>
            </View>
            <View style={s.dateRow}>
              <Pressable onPress={() => shift(-1)} hitSlop={6} style={s.step} accessibilityLabel="Previous day"><Ionicons name="chevron-back" size={20} color={c.text} /></Pressable>
              <Text style={s.dateText}>{reportDate === todayKey() ? 'Today' : reportDate === dayKey(-1) ? 'Yesterday' : shortDate(reportDate)}</Text>
              <Pressable onPress={() => shift(1)} disabled={reportDate === todayKey()} hitSlop={6} style={[s.step, reportDate === todayKey() && { opacity: 0.35 }]} accessibilityLabel="Next day"><Ionicons name="chevron-forward" size={20} color={c.text} /></Pressable>
            </View>
            <LightButton title="Generate report for this day" onPress={() => void generate()} loading={busy} style={{ marginTop: 12 }} />
            {reports.map((row, i) => (
              <Pressable key={row.id} onPress={() => open(row)} style={({ pressed }) => [s.reportRow, i > 0 && s.divider, pressed && { opacity: 0.7 }]}>
                <Ionicons name="document-text-outline" size={22} color={c.text} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={{ color: c.text, fontSize: 16, fontWeight: '600' }}>{shortDate(row.date)}</Text>
                  <Text style={{ color: c.textSecondary, fontSize: 14, marginTop: 2 }}>{row.summary.delivered ?? 0} delivered · {row.summary.failed ?? 0} failed</Text>
                </View>
                <Text style={{ color: c.link, fontSize: 15, fontWeight: '600' }}>Open PDF</Text>
              </Pressable>
            ))}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function Stat({ value, unit, label }: { value: string; unit?: string; label: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statValue} numberOfLines={1} adjustsFontSizeToFit>{value}{unit ? <Text style={s.unit}>{unit === '%' ? '%' : ` ${unit}`}</Text> : null}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  title: { color: c.text, fontSize: 32, fontWeight: '800', letterSpacing: -0.5 },
  segment: { flexDirection: 'row', padding: 4, borderRadius: 16, backgroundColor: c.soft, marginTop: 18, marginBottom: 8 },
  segItem: { flex: 1, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: c.surface, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 2 },
  segText: { color: c.textSecondary, fontSize: 16, fontWeight: '600' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 20, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: c.border },
  stat: { width: '50%', marginBottom: 24 },
  statValue: { color: c.text, fontSize: 40, fontWeight: '800', letterSpacing: -1 },
  unit: { fontSize: 18, fontWeight: '600', color: c.textSecondary, letterSpacing: 0 },
  statLabel: { color: c.textSecondary, fontSize: 15, marginTop: 2 },
  section: { color: c.text, fontSize: 18, fontWeight: '600', marginTop: 24, marginBottom: 18 },
  chart: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: CHART_HEIGHT + 24 },
  barCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  barValue: { color: c.textLabel, fontSize: 13, fontWeight: '600', marginBottom: 6 },
  bar: { width: '70%', backgroundColor: c.link, borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  barEmpty: { height: 3, backgroundColor: c.track },
  axis: { height: 1, backgroundColor: c.border },
  barLabel: { flex: 1, textAlign: 'center', color: c.textSecondary, fontSize: 13, marginTop: 8 },
  dailyHead: { marginTop: 32, paddingTop: 24, borderTopWidth: 1, borderTopColor: c.border },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  step: { width: 44, height: 44, borderRadius: lr.field, backgroundColor: c.soft, alignItems: 'center', justifyContent: 'center' },
  dateText: { flex: 1, textAlign: 'center', color: c.text, fontSize: 16, fontWeight: '600' },
  reportRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, marginTop: 4 },
  divider: { borderTopWidth: 1, borderTopColor: c.border },
});
