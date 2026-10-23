import { useCallback, useState, type ComponentProps } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from '../lib/useFocusEffect';
import { useNav } from '../lib/nav';
import { get, post, ApiRequestError } from '../lib/api';
import type { StoreConfig, SubscriptionInfo } from '../lib/types';
import { money, titleCase, shortDate } from '../lib/format';
import { loadStoreConfig, mockEvent, openStoreSubscriptions, pickStore, PREMIUM_NAME, PREMIUM_PLAN_KEY, STORE_LABEL, trialLabel, type MockEvent } from '../lib/billing';
import { Screen } from '../components/Kit';
import { LightButton, LightError, LightPill, LightProgress, type LightTone } from '../components/LightKit';
import { light as c } from '../lib/theme';

type McName = ComponentProps<typeof MaterialCommunityIcons>['name'];

const errorText = (err: unknown, fallback: string) => (err instanceof ApiRequestError || err instanceof Error ? err.message : fallback);

/** The rider's Routify Premium plan and usage (light theme). Buying happens on the Paywall screen. */
export default function Subscription() {
  const { navigate, goBack } = useNav();
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

  const store = config ? pickStore(config) : null;
  const sub = info?.subscription;
  const storeManaged = Boolean(sub?.storeManaged && info?.store);
  const trial = Boolean(store && !storeManaged && config?.trialEligible[store]);
  // Manual billing (an admin confirms the payment) only when the server sells through no store at all. When it does but
  // this build cannot reach that store (e.g. RevenueCat has no key for this platform), say so instead.
  const manualMode = !store && !config?.stores.length;
  const storeUnreachable = !store && !storeManaged && Boolean(config?.stores.length);
  const live = sub && sub.status !== 'inactive';

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={s.body}>
        <Pressable onPress={goBack} hitSlop={12} accessibilityLabel="Back" style={{ alignSelf: 'flex-start' }}>
          <Ionicons name="arrow-back" size={26} color={c.text} />
        </Pressable>
        <Text style={s.title}>Subscription</Text>
        <Text style={s.subtitle}>Your plan and usage this month.</Text>
        <LightError text={error} />

        {!info ? (
          error ? null : <ActivityIndicator color={c.link} style={{ marginTop: 40 }} />
        ) : (
          <>
            {live ? (
              <CurrentPlan info={info} storeManaged={storeManaged} manualMode={manualMode} busy={busy}
                onCancel={() => run('cancel', async () => { await post('/subscriptions/cancel'); return reloadMine(); }, 'Could not cancel')}
                onManage={() => { if (info.store) void openStoreSubscriptions(info.store.store, info.store.productId).then(load); }} />
            ) : <NoPlanYet />}

            {storeManaged && info.store?.store === 'mock' ? (
              <TestStoreControls status={info.store.status} autoRenew={info.store.autoRenew} busy={busy}
                onEvent={(event) => run(`mock-${event}`, () => mockEvent(event), 'The test event failed')} />
            ) : null}

            {store && !storeManaged ? <UpgradeCard trial={trial} trialText={trialLabel(config?.trialDays ?? 1)} onOpen={() => navigate('Paywall')} /> : null}
            {storeUnreachable ? <StoreUnavailable /> : null}
            {manualMode ? (
              <ManualPremium info={info} busy={busy}
                onRequest={() => run('request', async () => { await post('/subscriptions', { planKey: PREMIUM_PLAN_KEY, billingCycle: 'monthly' }); return reloadMine(); }, 'Could not request Routify Premium')} />
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

// ---------------------------------------------------------------- current plan

const STATUS: Record<string, { text: string; tone: LightTone }> = {
  active: { text: 'Active', tone: 'green' }, trialing: { text: 'Free trial', tone: 'blue' }, past_due: { text: 'Payment issue', tone: 'amber' },
  cancelled: { text: 'Cancelled', tone: 'red' }, expired: { text: 'Expired', tone: 'red' },
};

function CurrentPlan({ info, storeManaged, manualMode, busy, onCancel, onManage }: {
  info: SubscriptionInfo; storeManaged: boolean; manualMode: boolean; busy: string | null; onCancel: () => void; onManage: () => void;
}) {
  const sub = info.subscription!;
  const limit = info.plan?.limits.deliveriesPerMonth || 0;
  const used = limit ? Math.min(100, Math.round((info.usage.deliveriesThisMonth / limit) * 100)) : 0;
  const purchase = info.store;
  const storeTrial = storeManaged && sub.status === 'trialing';
  const when = sub.cancelAtPeriodEnd ? 'Ends' : storeTrial ? 'Free trial ends' : sub.planKey === 'trial' ? 'Trial ends' : 'Renews';
  const status = STATUS[sub.status] ?? { text: titleCase(sub.status), tone: 'muted' as LightTone };
  const storeIcon: McName = purchase?.store === 'apple' ? 'apple' : purchase?.store === 'google' ? 'google-play'
    : purchase?.store === 'revenuecat' ? (Platform.OS === 'ios' ? 'apple' : 'google-play') : 'flask-outline';

  return (
    <View style={[s.card, s.cardAccent]}>
      <View style={s.cardHead}>
        <View style={s.icon}><MaterialCommunityIcons name="crown" size={24} color={c.link} /></View>
        <View style={{ flex: 1 }}>
          <Text style={s.planName}>{info.plan?.name || PREMIUM_NAME}</Text>
          <Text style={s.meta}>{when} {shortDate(sub.currentPeriodEnd)}</Text>
        </View>
        <LightPill text={status.text} tone={status.tone} />
      </View>

      {limit ? (
        <View style={{ marginTop: 18 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={s.meta}>Deliveries this month</Text>
            <Text style={[s.meta, { color: c.text, fontWeight: '600' }]}>{info.usage.deliveriesThisMonth.toLocaleString()} / {limit.toLocaleString()}</Text>
          </View>
          <LightProgress progress={used} style={{ marginTop: 8 }} />
        </View>
      ) : null}
      <Text style={[s.meta, { marginTop: 10 }]}>{info.usage.reportsThisMonth} report{info.usage.reportsThisMonth === 1 ? '' : 's'} this month</Text>

      {storeManaged && purchase ? (
        <View style={s.billedBy}>
          <MaterialCommunityIcons name={storeIcon} size={16} color={c.textSecondary} />
          <Text style={[s.meta, { flex: 1, marginTop: 0 }]}>Billed through {STORE_LABEL[purchase.store]}{purchase.autoRenew ? '' : ' · auto-renew off'}</Text>
          {purchase.testMode ? <LightPill text="Test" tone="blue" /> : null}
        </View>
      ) : null}

      {sub.status === 'past_due' ? <Text style={[s.note, { color: c.warning }]}>Your last payment failed. Update your payment method in {purchase ? STORE_LABEL[purchase.store] : 'the store'} to keep adding deliveries.</Text> : null}
      {sub.cancelAtPeriodEnd && sub.status !== 'past_due' ? <Text style={[s.note, { color: c.warning }]}>Your plan will not renew.</Text> : null}
      {sub.pending && manualMode ? <Text style={[s.note, { color: c.link }]}>{PREMIUM_NAME} is waiting for payment confirmation.</Text> : null}

      {storeManaged && purchase?.store !== 'mock' ? (
        <LightButton title="Manage subscription" variant="outline" onPress={onManage} style={{ marginTop: 16 }} />
      ) : manualMode && sub.planKey !== 'trial' && !sub.cancelAtPeriodEnd ? (
        <LightButton title="Cancel at period end" variant="outline" onPress={onCancel} loading={busy === 'cancel'} style={{ marginTop: 16 }} />
      ) : null}
    </View>
  );
}

function UpgradeCard({ trial, trialText, onOpen }: { trial: boolean; trialText: string; onOpen: () => void }) {
  return (
    <View style={s.card}>
      <View style={s.cardHead}>
        <View style={s.icon}><MaterialCommunityIcons name="crown-outline" size={24} color={c.link} /></View>
        <View style={{ flex: 1 }}>
          <Text style={s.planName}>{trial ? `Try ${PREMIUM_NAME} free for ${trialText}` : `Get ${PREMIUM_NAME}`}</Text>
          <Text style={s.meta}>Route planning, imports, proof photos, reports and priority support.</Text>
        </View>
      </View>
      <LightButton title={trial ? 'Start free trial' : `See ${PREMIUM_NAME}`} onPress={onOpen} style={{ marginTop: 16 }} />
    </View>
  );
}

function NoPlanYet() {
  return (
    <View style={s.card}>
      <View style={s.cardHead}>
        <View style={[s.icon, { backgroundColor: c.soft }]}><MaterialCommunityIcons name="crown-outline" size={24} color={c.textSecondary} /></View>
        <View style={{ flex: 1 }}>
          <Text style={s.planName}>No plan yet</Text>
          <Text style={s.meta}>Start {PREMIUM_NAME} to add deliveries, plan routes and get reports.</Text>
        </View>
        <LightPill text="Not started" />
      </View>
    </View>
  );
}

function StoreUnavailable() {
  const storeName = Platform.OS === 'ios' ? 'the App Store' : 'Google Play';
  return (
    <View style={s.card}>
      <View style={s.cardHead}>
        <View style={[s.icon, { backgroundColor: c.warningBg }]}><MaterialCommunityIcons name="store-off-outline" size={24} color={c.warning} /></View>
        <View style={{ flex: 1 }}>
          <Text style={s.planName}>Purchases unavailable</Text>
          <Text style={s.meta}>{PREMIUM_NAME} is bought through {storeName}, which this version of the app cannot reach yet. Please try again after updating the app.</Text>
        </View>
      </View>
    </View>
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
    <View style={s.card}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <MaterialCommunityIcons name="flask-outline" size={18} color={c.link} />
        <Text style={[s.planName, { fontSize: 16 }]}>Test store controls</Text>
      </View>
      <Text style={s.meta}>Simulate what Google Play and the App Store do over time.</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {TEST_EVENTS.filter((t) => t.when(status, autoRenew)).map((t) => (
          <Pressable key={t.event} onPress={() => onEvent(t.event)} disabled={Boolean(busy)}
            style={({ pressed }) => [s.chip, (pressed || busy === `mock-${t.event}`) && { opacity: 0.6 }]}>
            <Text style={s.chipText}>{busy === `mock-${t.event}` ? '…' : t.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- manual billing (no store enabled on the server)

function ManualPremium({ info, busy, onRequest }: { info: SubscriptionInfo; busy: string | null; onRequest: () => void }) {
  const plan = info.plans.find((p) => p.key === PREMIUM_PLAN_KEY);
  if (!plan) return null;
  const sub = info.subscription;
  const isCurrent = sub?.planKey === plan.key && (sub.status === 'active' || sub.status === 'trialing');
  return (
    <>
      {info.paymentInstructions ? (
        <View style={s.info}>
          <Ionicons name="information-circle" size={18} color={c.link} />
          <Text style={{ flex: 1, color: c.textLabel, fontSize: 14, lineHeight: 20 }}>{info.paymentInstructions}</Text>
        </View>
      ) : null}
      <View style={[s.card, s.cardAccent]}>
        <View style={s.cardHead}>
          <View style={s.icon}><MaterialCommunityIcons name="crown" size={24} color={c.link} /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.planName}>{plan.name}</Text>
            <Text style={s.meta}>{money(plan.monthlyPrice, plan.currency)} a month</Text>
          </View>
          {isCurrent ? <LightPill text="Current plan" tone="green" /> : null}
        </View>
        {!isCurrent ? <LightButton title={`Get ${plan.name} · ${money(plan.monthlyPrice, plan.currency)}/month`} onPress={onRequest} loading={busy === 'request'} disabled={Boolean(sub?.pending)} style={{ marginTop: 16 }} /> : null}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  body: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 32, gap: 14 },
  title: { color: c.text, fontSize: 32, fontWeight: '800', letterSpacing: -0.5, marginTop: 8 },
  subtitle: { color: c.textSecondary, fontSize: 15, marginTop: -8, marginBottom: 4 },

  card: { padding: 16, borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
  cardAccent: { borderColor: c.link, borderWidth: 1.5 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: c.linkBg },
  planName: { color: c.text, fontSize: 17, fontWeight: '700' },
  meta: { color: c.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 3 },
  note: { fontSize: 13, marginTop: 10, fontWeight: '600', lineHeight: 18 },
  billedBy: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: c.border },
  info: { flexDirection: 'row', gap: 10, padding: 14, borderRadius: 14, backgroundColor: c.linkBg },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: c.soft, borderWidth: 1, borderColor: c.border },
  chipText: { color: c.text, fontSize: 13, fontWeight: '600' },
});
