import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { useFocusEffect } from '../lib/useFocusEffect';
import { get, post, ApiRequestError } from '../lib/api';
import type { Dashboard as DashboardType, Route } from '../lib/types';
import { money, todayKey } from '../lib/format';
import { getRouteOrigin } from '../lib/location';
import { Banner, Button, Card, Screen } from '../components/Kit';
import { colors, spacing } from '../lib/theme';
import { useNav } from '../lib/nav';

const ACTION_COPY: Record<DashboardType['nextAction'], { title: string; subtitle: string; cta: string }> = {
  setup: { title: 'Add your deliveries', subtitle: 'Import a courier manifest or add stops manually to get started.', cta: 'Add deliveries' },
  start: { title: 'Ready to head out', subtitle: 'Start your route using your saved route preference.', cta: 'Start delivery' },
  continue: { title: 'Route in progress', subtitle: 'Keep working through your stops.', cta: 'Continue route' },
  complete: { title: 'All done for today', subtitle: 'Every delivery is finished. Start another delivery day when you are ready.', cta: 'Start another day' },
};

export default function Dashboard() {
  const { switchTab } = useNav();
  const [data, setData] = useState<DashboardType | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await get<DashboardType>('/rider/dashboard', { date: todayKey() });
      setData(r.data);
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load your dashboard');
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const onAction = async () => {
    if (!data) return;
    if (data.nextAction === 'setup') { switchTab('deliveries'); return; }
    if (data.nextAction === 'complete') {
      switchTab('deliveries');
      return;
    }
    if (data.nextAction === 'start') {
      try {
        const origin = await getRouteOrigin();
        const planned = await post<Route>('/routes/build', origin ? { origin } : {});
        await post<Route>(`/routes/${planned.data.id}/start`);
        switchTab('deliveries');
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Could not start a delivery route');
      }
      return;
    }
    switchTab('deliveries');
  };

  if (!data) return <Screen style={{ padding: spacing(6) }}>{error ? <Banner text={error} /> : <Text style={{ color: colors.muted }}>Loading…</Text>}</Screen>;

  const action = ACTION_COPY[data.nextAction];

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: spacing(5) }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        <Text style={{ fontSize: 13, color: colors.muted, marginBottom: 2 }}>Good to see you,</Text>
        <Text style={{ fontSize: 24, fontWeight: '800', color: colors.text, marginBottom: spacing(5) }}>{data.rider.fullName}</Text>

        {error ? <Banner text={error} /> : null}

        <Card style={{ marginBottom: spacing(4) }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 4 }}>{action.title}</Text>
          <Text style={{ fontSize: 13, color: colors.muted, marginBottom: spacing(4) }}>{action.subtitle}</Text>
          <Button title={action.cta} onPress={onAction} />
        </Card>

        <View style={{ flexDirection: 'row', gap: spacing(3), marginBottom: spacing(4) }}>
          <StatBox label="Progress" value={`${data.progressPercent}%`} />
          <StatBox label="Delivered" value={String(data.delivered)} tone="green" />
          <StatBox label="Failed" value={String(data.failed)} tone={data.failed ? 'red' : 'muted'} />
        </View>

        <Card>
          <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: spacing(3) }}>Today&apos;s totals</Text>
          <Row label="Total stops" value={String(data.total)} />
          <Row label="Prepaid" value={String(data.prepaid)} />
          <Row label="COD" value={String(data.cod)} />
          <Row label="COD expected" value={money(data.codExpected, data.currency)} />
          <Row label="COD collected" value={money(data.codCollected, data.currency)} last />
        </Card>
      </ScrollView>
    </Screen>
  );
}

function StatBox({ label, value, tone = 'blue' }: { label: string; value: string; tone?: 'blue' | 'green' | 'red' | 'muted' }) {
  const fg = { blue: colors.primary, green: colors.green, red: colors.red, muted: colors.muted }[tone];
  return (
    <Card style={{ flex: 1, alignItems: 'center', paddingVertical: spacing(4) }}>
      <Text style={{ fontSize: 20, fontWeight: '800', color: fg }}>{value}</Text>
      <Text style={{ fontSize: 12, color: colors.muted, marginTop: 2 }}>{label}</Text>
    </Card>
  );
}

function Row({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: last ? 0 : 1, borderBottomColor: colors.border }}>
      <Text style={{ color: colors.muted, fontSize: 13 }}>{label}</Text>
      <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>{value}</Text>
    </View>
  );
}
