import { useCallback, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, RefreshControl, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from '../lib/useFocusEffect';
import { del, get, post, ApiRequestError } from '../lib/api';
import type { HistoryDay } from '../lib/types';
import { shortDate } from '../lib/format';
import { Screen } from '../components/Kit';
import { Empty, ErrorBanner, Header, PButton, PCard, Pill } from '../components/Premium';
import { premium as c } from '../lib/theme';

export default function History() {
  const [days, setDays] = useState<HistoryDay[]>([]);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [generatingDate, setGeneratingDate] = useState('');

  const load = useCallback(async () => {
    try { setDays((await get<HistoryDay[]>('/rider/history')).data); setError(''); }
    catch (err) { setError(err instanceof ApiRequestError ? err.message : 'Could not load history'); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const generateReport = async (date: string) => {
    setGeneratingDate(date);
    setError('');
    try {
      await post('/reports/generate', { date });
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : `Could not generate the ${shortDate(date)} report`);
    } finally {
      setGeneratingDate('');
    }
  };

  const clearHistory = async () => {
    setRefreshing(true);
    setError('');
    try {
      await del('/rider/history');
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not clear history');
    } finally { setRefreshing(false); }
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
      <FlatList
        data={days}
        keyExtractor={(d) => d.date}
        contentContainerStyle={{ padding: 16, paddingBottom: 28, gap: 14 }}
        refreshControl={<RefreshControl tintColor={c.primary} colors={[c.primary]} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListHeaderComponent={(
          <>
            <Header
              eyebrow="Delivery desk"
              eyebrowIcon="truck-fast-outline"
              title="History"
              subtitle="Track your past deliveries and their status."
              right={days.length > 0 ? (
                <Pressable onPress={confirmClearHistory} hitSlop={8} style={({ pressed }) => [{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 99, backgroundColor: 'rgba(255,83,104,0.12)' }, pressed && { opacity: 0.8 }]}>
                  <Text style={{ color: c.danger, fontWeight: '800', fontSize: 12 }}>Clear</Text>
                </Pressable>
              ) : null}
            />
            <ErrorBanner text={error} />
          </>
        )}
        ListEmptyComponent={<Empty icon="history" title="No history yet" subtitle="Days you've delivered on will show up here." />}
        renderItem={({ item }) => <DayCard day={item} generating={generatingDate === item.date} onGenerate={() => generateReport(item.date)} />}
      />
    </Screen>
  );
}

function DayCard({ day, generating, onGenerate }: { day: HistoryDay; generating: boolean; onGenerate: () => void }) {
  const done = day.pending === 0;
  return (
    <PCard>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <MaterialCommunityIcons name="calendar-blank-outline" size={18} color={c.primary} />
          <Text style={{ color: c.text, fontSize: 17, fontWeight: '800' }}>{shortDate(day.date)}</Text>
        </View>
        {day.hasReport
          ? <Pill text="Report ready" tone="blue" icon="document-text" />
          : <Pill text={done ? 'Completed' : 'In progress'} tone={done ? 'green' : 'amber'} />}
      </View>

      <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
        <Stat label="Delivered" value={day.delivered} color={c.success} />
        <Stat label="Failed" value={day.failed} color={day.failed ? c.danger : c.textSecondary} />
        <Stat label="Total" value={day.total} color={c.text} />
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
          <MaterialCommunityIcons name="clock-outline" size={16} color={c.primary} />
          <Text style={{ color: c.textSecondary, fontSize: 13 }} numberOfLines={1}>{day.pending ? `${day.pending} not completed` : 'All stops finished'}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <MaterialCommunityIcons name="map-marker-distance" size={16} color={c.primary} />
          <Text style={{ color: c.textSecondary, fontSize: 13 }}>{day.distanceKm} km</Text>
        </View>
      </View>

      <PButton
        title={day.hasReport ? 'Regenerate report' : 'Generate report'}
        icon={day.hasReport ? 'refresh' : 'document-text-outline'}
        variant={day.hasReport ? 'secondary' : 'primary'}
        onPress={onGenerate}
        loading={generating}
        chevron
        style={{ marginTop: 14 }}
      />
    </PCard>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: c.surfaceSoft, borderRadius: 14, paddingVertical: 10, alignItems: 'center' }}>
      <Text style={{ color, fontSize: 18, fontWeight: '800' }}>{value}</Text>
      <Text style={{ color: c.textSecondary, fontSize: 11, marginTop: 1 }}>{label}</Text>
    </View>
  );
}
