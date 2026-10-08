import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from '../lib/useFocusEffect';
import { get, post, ApiRequestError } from '../lib/api';
import type { SubscriptionInfo } from '../lib/types';
import { money, titleCase, shortDate } from '../lib/format';
import { Screen } from '../components/Kit';
import { ErrorBanner, Header, IconCircle, PButton, PCard, Pill } from '../components/Premium';
import { premium as c, premiumRadius as r } from '../lib/theme';

export default function Subscription() {
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

  if (!info) {
    return (
      <Screen style={{ padding: 22, backgroundColor: c.background }}>
        {error ? <ErrorBanner text={error} /> : <Text style={{ color: c.textSecondary }}>Loading…</Text>}
      </Screen>
    );
  }

  const sub = info.subscription;
  const healthy = sub?.status === 'active' || sub?.status === 'trialing';
  const limit = info.plan?.limits.deliveriesPerMonth || 0;
  const used = limit ? Math.min(100, Math.round((info.usage.deliveriesThisMonth / limit) * 100)) : 0;

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 14 }}>
        <Header eyebrow="Settings" eyebrowIcon="crown-outline" title="Subscription" subtitle="Your plan, usage and upgrades." />
        <ErrorBanner text={error} />

        {sub ? (
          <PCard accent>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <IconCircle icon="crown" />
              <View style={{ flex: 1 }}>
                <Text style={s.planName}>{info.plan?.name || titleCase(sub.planKey)}</Text>
                <Text style={s.meta}>{sub.cancelAtPeriodEnd ? 'Ends' : 'Renews'} {shortDate(sub.currentPeriodEnd)}</Text>
              </View>
              <Pill text={titleCase(sub.status)} tone={healthy ? 'green' : 'red'} />
            </View>

            {limit ? (
              <View style={{ marginTop: 16 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={s.meta}>Deliveries this month</Text>
                  <Text style={[s.meta, { color: c.text, fontWeight: '700' }]}>{info.usage.deliveriesThisMonth.toLocaleString()} / {limit.toLocaleString()}</Text>
                </View>
                <View style={s.track}><View style={[s.fill, { width: `${used}%` }, used >= 90 && { backgroundColor: c.danger }]} /></View>
              </View>
            ) : null}
            <Text style={[s.meta, { marginTop: 10 }]}>{info.usage.reportsThisMonth} report{info.usage.reportsThisMonth === 1 ? '' : 's'} generated this month</Text>

            {sub.cancelAtPeriodEnd ? <Text style={[s.note, { color: c.warning }]}>Your plan will not renew.</Text> : null}
            {sub.pending ? <Text style={[s.note, { color: '#7FB2FF' }]}>Upgrade to {titleCase(sub.pending.planKey)} is waiting for payment confirmation.</Text> : null}
            {sub.planKey !== 'trial' && !sub.cancelAtPeriodEnd ? (
              <PButton title="Cancel at period end" variant="secondary" onPress={cancel} loading={busy === 'cancel'} style={{ marginTop: 14 }} />
            ) : null}
          </PCard>
        ) : null}

        {info.paymentInstructions ? (
          <View style={s.info}>
            <Ionicons name="information-circle" size={18} color="#7FB2FF" />
            <Text style={{ flex: 1, color: c.textSecondary, fontSize: 13, lineHeight: 19 }}>{info.paymentInstructions}</Text>
          </View>
        ) : null}

        <Text style={s.section}>Plans</Text>
        {info.plans.filter((p) => p.key !== 'trial').map((p) => {
          const isCurrent = sub?.planKey === p.key && healthy;
          return (
            <PCard key={p.key} accent={p.key === 'pro'}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={s.planName}>{p.name}</Text>
                {isCurrent ? <Pill text="Current plan" tone="green" icon="checkmark" /> : p.key === 'pro' ? <Pill text="Best value" tone="orange" icon="star" /> : null}
              </View>
              <Text style={s.meta}>{p.limits.deliveriesPerMonth.toLocaleString()} deliveries · {p.limits.reportsPerMonth.toLocaleString()} reports per month</Text>
              {p.features.length ? (
                <View style={{ gap: 6, marginTop: 12 }}>
                  {p.features.map((f) => (
                    <View key={f} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <MaterialCommunityIcons name="check-circle" size={15} color={c.success} />
                      <Text style={{ flex: 1, color: c.text, fontSize: 13 }}>{f}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
                <PButton title={`${money(p.monthlyPrice, p.currency)}/mo`} variant="secondary" onPress={() => requestPlan(p.key as 'starter' | 'pro', 'monthly')} loading={busy === `${p.key}-monthly`} style={{ flex: 1 }} />
                <PButton title={`${money(p.annualPrice, p.currency)}/yr`} variant={p.key === 'pro' ? 'primary' : 'secondary'} onPress={() => requestPlan(p.key as 'starter' | 'pro', 'annual')} loading={busy === `${p.key}-annual`} style={{ flex: 1 }} />
              </View>
            </PCard>
          );
        })}
      </ScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  planName: { color: c.text, fontSize: 17, fontWeight: '800' },
  meta: { color: c.textSecondary, fontSize: 12, marginTop: 3 },
  note: { fontSize: 12, marginTop: 8, fontWeight: '600' },
  track: { height: 8, borderRadius: 99, backgroundColor: '#22314F', overflow: 'hidden', marginTop: 8 },
  fill: { height: '100%', borderRadius: 99, backgroundColor: c.primary },
  info: { flexDirection: 'row', gap: 10, padding: 14, borderRadius: r.large, backgroundColor: 'rgba(61,139,255,0.1)', borderWidth: 1, borderColor: 'rgba(61,139,255,0.3)' },
  section: { color: c.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', marginTop: 4 },
});
