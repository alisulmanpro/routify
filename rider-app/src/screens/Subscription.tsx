import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from '../lib/useFocusEffect';
import { useNav } from '../lib/nav';
import { get, post, ApiRequestError } from '../lib/api';
import type { BillingCycle, PaidPlanKey, StoreConfig, SubscriptionInfo } from '../lib/types';
import { money, titleCase, shortDate } from '../lib/format';
import { loadStoreConfig, mockEvent, openStoreSubscriptions, pickStore, STORE_LABEL, trialLabel, type MockEvent } from '../lib/billing';
import { Screen } from '../components/Kit';
import { ErrorBanner, Header, IconCircle, PButton, PCard, Pill } from '../components/Premium';
import { premium as c, premiumRadius as r } from '../lib/theme';

const errorText = (err: unknown, fallback: string) => (err instanceof ApiRequestError || err instanceof Error ? err.message : fallback);

/** The rider's current plan and usage. Choosing or changing a plan happens on the separate Paywall screen. */
export default function Subscription() {
  const { navigate } = useNav();
  const [info, setInfo] = useState<SubscriptionInfo | null>(null);
  const [config, setConfig] = useState<StoreConfig | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [me, storeConfig] = await Promise.all([get<SubscriptionInfo>('/subscriptions/me'), loadStoreConfig().catch(() => null)]);
      setInfo(me.data);
      setConfig(storeConfig);
    } catch (err) { setError(errorText(err, 'Could not load your subscription')); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const run = async (key: string, action: () => Promise<SubscriptionInfo | void>, fallback: string) => {
    setBusy(key);
    setError('');
    try {
      const next = await action();
      if (next) setInfo(next);
      setConfig(await loadStoreConfig().catch(() => config));
    } catch (err) { setError(errorText(err, fallback)); }
    finally { setBusy(null); }
  };
  const reloadMine = async () => (await get<SubscriptionInfo>('/subscriptions/me')).data;

  if (!info) {
    return (
      <Screen style={{ padding: 22, backgroundColor: c.background }}>
        {error ? <ErrorBanner text={error} /> : <Text style={{ color: c.textSecondary }}>Loading…</Text>}
      </Screen>
    );
  }

  const store = config ? pickStore(config) : null;
  const sub = info.subscription;
  const storeManaged = Boolean(sub?.storeManaged && info.store);
  const trial = Boolean(store && !storeManaged && config?.trialEligible[store]);

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 14 }}>
        <Header eyebrow="Settings" eyebrowIcon="crown-outline" title="Subscription" subtitle="Your plan, usage and upgrades." />
        <ErrorBanner text={error} />

        {sub && sub.status === 'inactive' ? <NoPlanYet /> : null}
        {sub && sub.status !== 'inactive' ? (
          <CurrentPlan info={info} storeManaged={storeManaged} manualMode={!store} busy={busy}
            onCancel={() => run('cancel', async () => { await post('/subscriptions/cancel'); return reloadMine(); }, 'Could not cancel')}
            onManage={() => info.store && openStoreSubscriptions(info.store.store, info.store.productId)}
            onChangePlan={() => navigate('Paywall')} />
        ) : null}

        {storeManaged && info.store?.store === 'mock' ? (
          <TestStoreControls status={info.store.status} autoRenew={info.store.autoRenew} busy={busy}
            onEvent={(event) => run(`mock-${event}`, () => mockEvent(event), 'The test event failed')} />
        ) : null}

        {store && !storeManaged ? <UpgradeCard trial={trial} trialText={trialLabel(config?.trialDays ?? 14)} onOpen={() => navigate('Paywall')} /> : null}

        {!store ? (
          <ManualPlans info={info} busy={busy}
            onRequest={(key, cycle) => run(`${key}-${cycle}`, async () => { await post('/subscriptions', { planKey: key, billingCycle: cycle }); return reloadMine(); }, 'Could not request this plan')} />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

// ---------------------------------------------------------------- current plan

function CurrentPlan({ info, storeManaged, manualMode, busy, onCancel, onManage, onChangePlan }: {
  info: SubscriptionInfo; storeManaged: boolean; manualMode: boolean; busy: string | null;
  onCancel: () => void; onManage: () => void; onChangePlan: () => void;
}) {
  const sub = info.subscription!;
  const healthy = sub.status === 'active' || sub.status === 'trialing';
  const limit = info.plan?.limits.deliveriesPerMonth || 0;
  const used = limit ? Math.min(100, Math.round((info.usage.deliveriesThisMonth / limit) * 100)) : 0;
  const purchase = info.store;
  const storeTrial = storeManaged && sub.status === 'trialing';
  const when = sub.cancelAtPeriodEnd ? 'Ends' : storeTrial ? 'Free trial ends' : sub.planKey === 'trial' ? 'Trial ends' : 'Renews';

  return (
    <PCard accent>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <IconCircle icon="crown" />
        <View style={{ flex: 1 }}>
          <Text style={s.planName}>{info.plan?.name || titleCase(sub.planKey)}{sub.planKey !== 'trial' ? <Text style={s.cycle}>  · {titleCase(sub.billingCycle)}</Text> : null}</Text>
          <Text style={s.meta}>{when} {shortDate(sub.currentPeriodEnd)}</Text>
        </View>
        <Pill text={sub.status === 'past_due' ? 'Payment issue' : titleCase(sub.status)} tone={healthy ? 'green' : sub.status === 'past_due' ? 'amber' : 'red'} />
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

      {storeManaged && purchase ? (
        <View style={s.billedBy}>
          <MaterialCommunityIcons name={purchase.store === 'apple' ? 'apple' : purchase.store === 'google' ? 'google-play' : 'flask-outline'} size={15} color={c.textSecondary} />
          <Text style={{ flex: 1, color: c.textSecondary, fontSize: 12 }}>Billed through {STORE_LABEL[purchase.store]}{purchase.autoRenew ? '' : ' · auto-renew off'}</Text>
          {purchase.testMode ? <Pill text="Test" tone="blue" /> : null}
        </View>
      ) : null}

      {sub.status === 'past_due' ? <Text style={[s.note, { color: c.warning }]}>Your last payment failed. Update your payment method in {purchase ? STORE_LABEL[purchase.store] : 'the store'} to keep adding deliveries.</Text> : null}
      {sub.cancelAtPeriodEnd && sub.status !== 'past_due' ? <Text style={[s.note, { color: c.warning }]}>Your plan will not renew.</Text> : null}
      {sub.pending && manualMode ? <Text style={[s.note, { color: '#7FB2FF' }]}>Upgrade to {titleCase(sub.pending.planKey)} is waiting for payment confirmation.</Text> : null}

      {storeManaged ? (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
          <PButton title="Change plan" variant="secondary" onPress={onChangePlan} style={{ flex: 1 }} />
          {purchase?.store !== 'mock' ? <PButton title="Manage" icon="open-outline" variant="secondary" onPress={onManage} style={{ flex: 1 }} /> : null}
        </View>
      ) : manualMode && sub.planKey !== 'trial' && !sub.cancelAtPeriodEnd ? (
        <PButton title="Cancel at period end" variant="secondary" onPress={onCancel} loading={busy === 'cancel'} style={{ marginTop: 14 }} />
      ) : null}
    </PCard>
  );
}

function UpgradeCard({ trial, trialText, onOpen }: { trial: boolean; trialText: string; onOpen: () => void }) {
  return (
    <PCard>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <IconCircle icon="rocket-launch-outline" />
        <View style={{ flex: 1 }}>
          <Text style={s.planName}>{trial ? `Try Pro free for ${trialText}` : 'Choose a plan'}</Text>
          <Text style={s.meta}>More deliveries, more reports and priority support.</Text>
        </View>
      </View>
      <PButton title={trial ? 'See plans & start free trial' : 'See plans'} icon="sparkles-outline" onPress={onOpen} chevron style={{ marginTop: 14 }} />
    </PCard>
  );
}

function NoPlanYet() {
  return (
    <PCard>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <IconCircle icon="crown-outline" color={c.textSecondary} bg="rgba(170,182,207,0.12)" />
        <View style={{ flex: 1 }}>
          <Text style={s.planName}>No plan yet</Text>
          <Text style={s.meta}>Start a plan to add deliveries, plan routes and get reports.</Text>
        </View>
        <Pill text="Not started" tone="muted" />
      </View>
    </PCard>
  );
}

// ---------------------------------------------------------------- test store controls

const TEST_EVENTS: { event: MockEvent; label: string; when: (status: string, autoRenew: boolean) => boolean }[] = [
  { event: 'renew', label: 'Renew now', when: (st) => st !== 'past_due' },
  { event: 'cancel', label: 'Turn off auto-renew', when: (st, auto) => auto && st !== 'past_due' },
  { event: 'resume', label: 'Turn on auto-renew', when: (st, auto) => !auto && st !== 'past_due' },
  { event: 'fail_renewal', label: 'Payment fails', when: (st) => st === 'active' },
  { event: 'grace', label: 'Grace period', when: (st) => st === 'active' },
  { event: 'recover', label: 'Payment recovers', when: (st) => st === 'past_due' || st === 'grace' },
  { event: 'refund', label: 'Refund', when: () => true },
  { event: 'expire', label: 'Expire', when: () => true },
];

function TestStoreControls({ status, autoRenew, busy, onEvent }: { status: string; autoRenew: boolean; busy: string | null; onEvent: (event: MockEvent) => void }) {
  return (
    <PCard>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <MaterialCommunityIcons name="flask-outline" size={16} color="#7FB2FF" />
        <Text style={{ color: c.text, fontSize: 14, fontWeight: '800' }}>Test store controls</Text>
      </View>
      <Text style={[s.meta, { marginTop: 4 }]}>Simulate what Google Play and the App Store do over time.</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {TEST_EVENTS.filter((t) => t.when(status, autoRenew)).map((t) => (
          <Pressable key={t.event} onPress={() => onEvent(t.event)} disabled={Boolean(busy)}
            style={({ pressed }) => [s.chip, (pressed || busy === `mock-${t.event}`) && { opacity: 0.6 }]}>
            <Text style={s.chipText}>{busy === `mock-${t.event}` ? '…' : t.label}</Text>
          </Pressable>
        ))}
      </View>
    </PCard>
  );
}

// ---------------------------------------------------------------- manual billing (no store enabled on the server)

function ManualPlans({ info, busy, onRequest }: { info: SubscriptionInfo; busy: string | null; onRequest: (key: PaidPlanKey, cycle: BillingCycle) => void }) {
  const sub = info.subscription;
  const healthy = sub?.status === 'active' || sub?.status === 'trialing';
  return (
    <>
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
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
              <PButton title={`${money(p.monthlyPrice, p.currency)}/mo`} variant="secondary" onPress={() => onRequest(p.key as PaidPlanKey, 'monthly')} loading={busy === `${p.key}-monthly`} style={{ flex: 1 }} />
              <PButton title={`${money(p.annualPrice, p.currency)}/yr`} variant={p.key === 'pro' ? 'primary' : 'secondary'} onPress={() => onRequest(p.key as PaidPlanKey, 'annual')} loading={busy === `${p.key}-annual`} style={{ flex: 1 }} />
            </View>
          </PCard>
        );
      })}
    </>
  );
}

const s = StyleSheet.create({
  planName: { color: c.text, fontSize: 17, fontWeight: '800' },
  cycle: { color: c.textSecondary, fontSize: 13, fontWeight: '600' },
  meta: { color: c.textSecondary, fontSize: 12, marginTop: 3 },
  note: { fontSize: 12, marginTop: 8, fontWeight: '600', lineHeight: 17 },
  track: { height: 8, borderRadius: 99, backgroundColor: '#22314F', overflow: 'hidden', marginTop: 8 },
  fill: { height: '100%', borderRadius: 99, backgroundColor: c.primary },
  billedBy: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.divider },
  info: { flexDirection: 'row', gap: 10, padding: 14, borderRadius: r.large, backgroundColor: 'rgba(61,139,255,0.1)', borderWidth: 1, borderColor: 'rgba(61,139,255,0.3)' },
  section: { color: c.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', marginTop: 4 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: r.pill, backgroundColor: c.surfaceSoft, borderWidth: 1, borderColor: c.border },
  chipText: { color: c.text, fontSize: 12, fontWeight: '700' },
});
