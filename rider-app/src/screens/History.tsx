import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { useFocusEffect } from '../lib/useFocusEffect';
import { get, post, ApiRequestError } from '../lib/api';
import type { HistoryDay } from '../lib/types';
import { money, shortDate } from '../lib/format';
import { Badge, Banner, Button, Card, EmptyState, Screen } from '../components/Kit';
import { colors, spacing } from '../lib/theme';

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

  return (
    <Screen>
      <View style={{ padding: spacing(5), paddingBottom: 0 }}>
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text }}>History</Text>
        {error ? <Banner text={error} /> : null}
      </View>
      <FlatList
        data={days}
        keyExtractor={(d) => d.date}
        contentContainerStyle={{ padding: spacing(5), gap: spacing(3) }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListEmptyComponent={<EmptyState title="No history yet" subtitle="Days you've delivered on will show up here." />}
        renderItem={({ item }) => (
          <Card>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
              <Text style={{ fontWeight: '700', color: colors.text }}>{shortDate(item.date)}</Text>
              {item.hasReport && <Badge text="Report ready" tone="blue" />}
            </View>
            <Text style={{ color: colors.muted, fontSize: 13 }}>{item.delivered} delivered · {item.failed} failed · {item.total} total</Text>
            <Text style={{ color: colors.muted, fontSize: 13, marginTop: 2 }}>COD collected: {money(item.codCollected, item.currency)} · {item.distanceKm} km</Text>
            <View style={{ marginTop: spacing(3) }}>
              <Button title={item.hasReport ? 'Regenerate report' : 'Generate report'} onPress={() => generateReport(item.date)} loading={generatingDate === item.date} />
            </View>
          </Card>
        )}
      />
    </Screen>
  );
}
