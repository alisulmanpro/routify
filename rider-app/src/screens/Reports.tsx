import { useCallback, useState } from 'react';
import { FlatList, Linking, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from '../lib/useFocusEffect';
import { get, post, fileUrl, ApiRequestError } from '../lib/api';
import type { ReportRow } from '../lib/types';
import { shortDate, todayKey } from '../lib/format';
import { Screen } from '../components/Kit';
import { Empty, ErrorBanner, Header, PButton, PCard, Pill, SectionLabel } from '../components/Premium';
import { premium as c, premiumRadius as r } from '../lib/theme';

const isValidDate = (value: string) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const shiftDate = (value: string, days: number) => {
  const base = isValidDate(value) ? new Date(`${value}T00:00:00.000Z`) : new Date(`${todayKey()}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
};

export default function Reports() {
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [reportDate, setReportDate] = useState(todayKey());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setReports((await get<ReportRow[]>('/reports')).data); setError(''); }
    catch (err) { setError(err instanceof ApiRequestError ? err.message : 'Could not load reports'); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const generateForDate = async () => {
    if (!isValidDate(reportDate)) {
      setError('Enter a valid date in YYYY-MM-DD format.');
      return;
    }
    setBusy(true);
    setError('');
    try { await post('/reports/generate', { date: reportDate }); await load(); }
    catch (err) { setError(err instanceof ApiRequestError ? err.message : 'Could not generate a report for this date.'); }
    finally { setBusy(false); }
  };

  const open = (row: ReportRow) => Linking.openURL(fileUrl(row.downloadUrl)).catch(() => setError('Could not open report'));
  const isToday = reportDate === todayKey();

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <FlatList
        data={reports}
        keyExtractor={(row) => row.id}
        contentContainerStyle={{ padding: 16, paddingBottom: 28, gap: 14 }}
        refreshControl={<RefreshControl tintColor={c.primary} colors={[c.primary]} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListHeaderComponent={(
          <>
            <Header eyebrow="Delivery desk" eyebrowIcon="file-chart-outline" title="Reports" subtitle="View and generate delivery reports." />
            <ErrorBanner text={error} />

            <PCard style={{ marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <SectionLabel style={{ marginBottom: 0 }}>Delivery date</SectionLabel>
                {isToday ? <Pill text="Today" tone="orange" /> : null}
              </View>
              <View style={s.dateRow}>
                <Pressable onPress={() => setReportDate((d) => shiftDate(d, -1))} hitSlop={6} style={s.stepBtn} accessibilityLabel="Previous day">
                  <Ionicons name="chevron-back" size={18} color={c.text} />
                </Pressable>
                <View style={s.dateBox}>
                  <MaterialCommunityIcons name="calendar-month-outline" size={18} color={c.primary} />
                  <TextInput
                    value={reportDate}
                    onChangeText={setReportDate}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={c.textMuted}
                    keyboardType="numbers-and-punctuation"
                    maxLength={10}
                    style={s.dateText}
                  />
                </View>
                <Pressable onPress={() => setReportDate((d) => shiftDate(d, 1))} disabled={isToday} hitSlop={6} style={[s.stepBtn, isToday && { opacity: 0.35 }]} accessibilityLabel="Next day">
                  <Ionicons name="chevron-forward" size={18} color={c.text} />
                </Pressable>
              </View>
              <PButton title="Generate report for this date" icon="document-text-outline" onPress={generateForDate} loading={busy} chevron style={{ marginTop: 14 }} />
            </PCard>

            {reports.length > 0 ? <SectionLabel>Your reports</SectionLabel> : null}
          </>
        )}
        ListEmptyComponent={<Empty icon="file-document-outline" title="No reports yet" subtitle="Generate a PDF report once you've completed deliveries for the day." />}
        renderItem={({ item }) => (
          <PCard>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <MaterialCommunityIcons name="file-pdf-box" size={20} color={c.primary} />
                <Text style={{ color: c.text, fontSize: 17, fontWeight: '800' }}>{shortDate(item.date)}</Text>
              </View>
              <Pressable onPress={() => open(item)} hitSlop={6}>
                <Pill text="Open PDF" tone="blue" icon="open-outline" />
              </Pressable>
            </View>
            <Text style={{ color: c.textSecondary, fontSize: 13, marginTop: 10 }}>
              <Text style={{ color: c.success, fontWeight: '700' }}>{item.summary.delivered ?? 0} delivered</Text>
              {'  ·  '}
              <Text style={{ color: Number(item.summary.failed) ? c.danger : c.textSecondary, fontWeight: '700' }}>{item.summary.failed ?? 0} failed</Text>
              {item.summary.total != null ? `  ·  ${item.summary.total} total` : ''}
            </Text>
            {item.summary.distanceKm ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
                <MaterialCommunityIcons name="map-marker-distance" size={16} color={c.primary} />
                <Text style={{ color: c.textSecondary, fontSize: 13 }}>{item.summary.distanceKm} km planned</Text>
              </View>
            ) : null}
            <PButton title="View report" icon="eye-outline" variant="secondary" onPress={() => open(item)} chevron style={{ marginTop: 14 }} />
          </PCard>
        )}
      />
    </Screen>
  );
}

const s = StyleSheet.create({
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepBtn: { width: 42, height: 50, borderRadius: r.medium, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceSoft, alignItems: 'center', justifyContent: 'center' },
  dateBox: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 50, paddingHorizontal: 12, borderRadius: r.medium, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceSoft },
  dateText: { flex: 1, color: c.text, fontSize: 15, fontWeight: '700', paddingVertical: 12 },
});
