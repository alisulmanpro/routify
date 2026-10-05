import { useCallback, useState } from 'react';
import { FlatList, Linking, Pressable, RefreshControl, Text, View } from 'react-native';
import { useFocusEffect } from '../lib/useFocusEffect';
import { get, post, fileUrl, ApiRequestError } from '../lib/api';
import type { ReportRow } from '../lib/types';
import { money, shortDate, todayKey } from '../lib/format';
import { Banner, Button, Card, EmptyState, Field, Screen } from '../components/Kit';
import { colors, spacing } from '../lib/theme';

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
    const parsedDate = new Date(`${reportDate}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== reportDate) {
      setError('Enter a valid date in YYYY-MM-DD format.');
      return;
    }
    setBusy(true);
    setError('');
    try { await post('/reports/generate', { date: reportDate }); await load(); }
    catch (err) { setError(err instanceof ApiRequestError ? err.message : 'Could not generate a report for this date.'); }
    finally { setBusy(false); }
  };

  const open = (r: ReportRow) => Linking.openURL(fileUrl(r.downloadUrl)).catch(() => setError('Could not open report'));

  return (
    <Screen>
      <View style={{ padding: spacing(5), paddingBottom: 0 }}>
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: spacing(3) }}>Reports</Text>
        {error ? <Banner text={error} /> : null}
        <Field label="Delivery date" value={reportDate} onChangeText={setReportDate} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" maxLength={10} />
        <Button title="Generate report for this date" onPress={generateForDate} loading={busy} />
      </View>
      <FlatList
        data={reports}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ padding: spacing(5), gap: spacing(3) }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListEmptyComponent={<EmptyState title="No reports yet" subtitle="Generate a PDF report once you've completed deliveries for the day." />}
        renderItem={({ item }) => (
          <Pressable onPress={() => open(item)}>
            <Card>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontWeight: '700', color: colors.text }}>{shortDate(item.date)}</Text>
                <Text style={{ color: colors.primary, fontWeight: '600', fontSize: 13 }}>Open PDF ↗</Text>
              </View>
              <Text style={{ color: colors.muted, fontSize: 13, marginTop: 4 }}>{item.summary.delivered} delivered · {item.summary.failed} failed</Text>
              <Text style={{ color: colors.muted, fontSize: 13, marginTop: 2 }}>COD collected: {money(Number(item.summary.codCollected || 0), String(item.summary.currency || 'USD'))}</Text>
            </Card>
          </Pressable>
        )}
      />
    </Screen>
  );
}
