import { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useFocusEffect } from '../lib/useFocusEffect';
import { get, post, ApiRequestError } from '../lib/api';
import type { SubscriptionInfo } from '../lib/types';
import { money, titleCase, shortDate } from '../lib/format';
import { Badge, Banner, Button, Card, Screen } from '../components/Kit';
import { colors, spacing } from '../lib/theme';
import { useNav } from '../lib/nav';

export default function Subscription() {
  const { goBack } = useNav();
  const [info, setInfo] = useState<SubscriptionInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setInfo((await get<SubscriptionInfo>('/subscriptions/me')).data); }
    catch (err) { setError(err instanceof ApiRequestError ? err.message : 'Could not load your subscription'); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const requestPlan = async (planKey: 'starter' | 'pro', billingCycle: 'monthly' | 'annual') => {
    setBusy(`${planKey}-${billingCycle}`);
    setError('');
    try { await post('/subscriptions', { planKey, billingCycle }); await load(); }
    catch (err) { setError(err instanceof ApiRequestError ? err.message : 'Could not request this plan'); }
    finally { setBusy(null); }
  };

  const cancel = async () => {
    setBusy('cancel');
    try { await post('/subscriptions/cancel'); await load(); }
    catch (err) { setError(err instanceof ApiRequestError ? err.message : 'Could not cancel'); }
    finally { setBusy(null); }
  };

  if (!info) return <Screen style={{ padding: spacing(6) }}>{error ? <Banner text={error} /> : <Text style={{ color: colors.muted }}>Loading…</Text>}</Screen>;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: spacing(5) }}>
        <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text, marginBottom: spacing(4) }}>Subscription</Text>
        {error ? <Banner text={error} /> : null}

        {info.subscription && (
          <Card style={{ marginBottom: spacing(4) }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
              <Text style={{ fontWeight: '700', color: colors.text }}>{info.plan?.name || titleCase(info.subscription.planKey)}</Text>
              <Badge text={info.subscription.status} tone={info.subscription.status === 'active' || info.subscription.status === 'trialing' ? 'green' : 'red'} />
            </View>
            <Text style={{ color: colors.muted, fontSize: 13 }}>Renews {shortDate(info.subscription.currentPeriodEnd)}</Text>
            {info.subscription.cancelAtPeriodEnd && <Text style={{ color: colors.amber, fontSize: 12, marginTop: 4 }}>Cancels at period end</Text>}
            {info.subscription.pending && <Text style={{ color: colors.blue, fontSize: 12, marginTop: 4 }}>Upgrade to {titleCase(info.subscription.pending.planKey)} pending payment confirmation</Text>}
            <Text style={{ color: colors.muted, fontSize: 12, marginTop: 8 }}>{info.usage.deliveriesThisMonth} deliveries · {info.usage.reportsThisMonth} reports this month</Text>
            {info.subscription.planKey !== 'trial' && !info.subscription.cancelAtPeriodEnd && (
              <View style={{ marginTop: spacing(3) }}><Button title="Cancel at period end" variant="ghost" onPress={cancel} loading={busy === 'cancel'} /></View>
            )}
          </Card>
        )}

        {info.paymentInstructions ? (
          <Card style={{ marginBottom: spacing(4), backgroundColor: colors.blueBg, borderColor: colors.blue }}>
            <Text style={{ color: colors.blue, fontSize: 13 }}>{info.paymentInstructions}</Text>
          </Card>
        ) : null}

        {info.plans.filter((p) => p.key !== 'trial').map((p) => (
          <Card key={p.key} style={{ marginBottom: spacing(3) }}>
            <Text style={{ fontWeight: '700', color: colors.text, fontSize: 16 }}>{p.name}</Text>
            <Text style={{ color: colors.muted, fontSize: 13, marginBottom: 8 }}>{p.limits.deliveriesPerMonth.toLocaleString()} deliveries/mo</Text>
            <View style={{ flexDirection: 'row', gap: spacing(3) }}>
              <View style={{ flex: 1 }}><Button title={`${money(p.monthlyPrice, p.currency)}/mo`} variant="secondary" onPress={() => requestPlan(p.key as 'starter' | 'pro', 'monthly')} loading={busy === `${p.key}-monthly`} /></View>
              <View style={{ flex: 1 }}><Button title={`${money(p.annualPrice, p.currency)}/yr`} variant="secondary" onPress={() => requestPlan(p.key as 'starter' | 'pro', 'annual')} loading={busy === `${p.key}-annual`} /></View>
            </View>
          </Card>
        ))}
        <View style={{ height: spacing(4) }} />
        <Button title="Back" variant="ghost" onPress={goBack} />
      </ScrollView>
    </Screen>
  );
}
