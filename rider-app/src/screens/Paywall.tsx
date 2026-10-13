import { useCallback, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from '../lib/useFocusEffect';
import { useNav } from '../lib/nav';
import { get, ApiRequestError } from '../lib/api';
import type { BillingCycle, PaidPlanKey, Plan, StoreConfig, SubscriptionInfo } from '../lib/types';
import { money } from '../lib/format';
import { annualSaving, buy, loadStoreConfig, pickStore, restore, STORE_LABEL, trialLabel } from '../lib/billing';
import { Screen } from '../components/Kit';
import { DARK_ON_PRIMARY, ErrorBanner, PButton, Pill, PRIMARY_GRADIENT, gradient, type McName } from '../components/Premium';
import { premium as c, premiumRadius as r } from '../lib/theme';

type PaidPlan = Plan & { key: PaidPlanKey };

const FEATURE_ICONS: Record<string, McName> = {
  'PDF import': 'file-document-outline', 'Route planning': 'map-marker-path', 'Daily reports': 'calendar-check-outline', 'Priority support': 'headset',
};
const errorText = (err: unknown, fallback: string) => (err instanceof ApiRequestError || err instanceof Error ? err.message : fallback);

/** The store paywall, on its own screen like WhatsApp's: choose a plan, then buy through the phone's store. */
export default function Paywall() {
  const { goBack } = useNav();
  const [info, setInfo] = useState<SubscriptionInfo | null>(null);
  const [config, setConfig] = useState<StoreConfig | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'buy' | 'restore' | null>(null);
  const [planKey, setPlanKey] = useState<PaidPlanKey>('pro');
  const [cycle, setCycle] = useState<BillingCycle>('monthly');
  const [confirming, setConfirming] = useState(false);

  useFocusEffect(useCallback(() => {
    Promise.all([get<SubscriptionInfo>('/subscriptions/me'), loadStoreConfig()])
      .then(([me, storeConfig]) => {
        setInfo(me.data);
        setConfig(storeConfig);
        const current = me.data.subscription;
        // Someone changing plan starts from the other plan, so the screen opens on a real change.
        if (current?.storeManaged && current.planKey === 'pro') setPlanKey('starter');
      })
      .catch((err) => setError(errorText(err, 'Could not load the plans')));
  }, []));

  const plans = useMemo(() => (info?.plans ?? []).filter((p): p is PaidPlan => p.key !== 'trial'), [info]);
  const selected = plans.find((p) => p.key === planKey) ?? plans[plans.length - 1];
  const store = config ? pickStore(config) : null;

  if (!info || !config) {
    return (
      <Screen style={{ padding: 22, backgroundColor: c.background }}>
        {error ? <ErrorBanner text={error} /> : <Text style={{ color: c.textSecondary }}>Loading…</Text>}
      </Screen>
    );
  }
  if (!store || !selected) {
    return (
      <Screen style={{ padding: 22, backgroundColor: c.background }}>
        <ErrorBanner text="In-app purchases are not available right now." />
      </Screen>
    );
  }

  const changing = Boolean(info.subscription?.storeManaged && info.store);
  const trial = !changing && Boolean(config.trialEligible[store]);
  const trialText = trialLabel(config.trialDays);
  const price = cycle === 'annual' ? selected.annualPrice : selected.monthlyPrice;
  const unit = cycle === 'annual' ? 'year' : 'month';
  const saving = annualSaving(selected.monthlyPrice, selected.annualPrice);
  const isCurrent = changing && info.subscription?.planKey === selected.key && info.subscription?.billingCycle === cycle;
  const features: { icon: McName; text: string }[] = [
    { icon: 'truck-fast-outline', text: `${selected.limits.deliveriesPerMonth.toLocaleString()} deliveries a month` },
    { icon: 'file-chart-outline', text: `${selected.limits.reportsPerMonth.toLocaleString()} reports a month` },
    ...selected.features.map((f) => ({ icon: FEATURE_ICONS[f] ?? 'check-circle-outline', text: f })),
  ];
  const cta = isCurrent ? 'Your current plan' : trial ? `Try for ${money(0, selected.currency)}` : changing ? `Switch to ${selected.name}` : `Subscribe for ${money(price, selected.currency)}`;

  const purchase = async () => {
    setBusy('buy');
    setError('');
    try {
      await buy(store, selected.key, cycle, { trial });
      setConfirming(false);
      goBack(); // the Subscription screen reloads and shows the new plan
    } catch (err) { setError(errorText(err, 'The purchase did not go through')); setConfirming(false); }
    finally { setBusy(null); }
  };
  const restorePurchases = async () => {
    setBusy('restore');
    setError('');
    try { await restore(store); goBack(); } catch (err) { setError(errorText(err, 'Nothing to restore')); } finally { setBusy(null); }
  };
  // Real stores show their own purchase sheet; the test store shows ours so the flow feels the same.
  const onBuy = () => (store === 'mock' ? setConfirming(true) : void purchase());

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ padding: 18, paddingTop: 4, paddingBottom: 24 }}>
        {store === 'mock' ? <Pill text="Test store · no real payment" tone="blue" icon="flask-outline" style={{ alignSelf: 'center' }} /> : null}

        <View style={{ alignItems: 'center', marginTop: 14 }}>
          <View style={s.heroIcon}><MaterialCommunityIcons name="crown" size={34} color={c.primary} /></View>
          <Text style={s.heroTitle}>
            {trial ? 'Try ' : changing ? 'Switch to ' : 'Get '}<Text style={{ color: c.primary }}>Routify {selected.name}</Text>{trial ? `\nfree for ${trialText}` : ''}
          </Text>
          <Text style={s.heroSub}>Plan routes faster and handle more drops every day</Text>
          <Text style={s.price}>{money(price, selected.currency)}/{unit} · Price may include taxes</Text>
        </View>

        <ErrorBanner text={error} />

        <View style={s.segment}>
          {plans.map((p) => (
            <Pressable key={p.key} onPress={() => setPlanKey(p.key)} style={[s.segmentItem, p.key === selected.key && s.segmentActive]}>
              <Text style={[s.segmentText, p.key === selected.key && s.segmentTextActive]}>{p.name}</Text>
            </Pressable>
          ))}
        </View>
        <View style={[s.segment, { marginTop: 8 }]}>
          {(['monthly', 'annual'] as const).map((value) => (
            <Pressable key={value} onPress={() => setCycle(value)} style={[s.segmentItem, value === cycle && s.segmentActive]}>
              <Text style={[s.segmentText, value === cycle && s.segmentTextActive]}>{value === 'monthly' ? 'Monthly' : 'Yearly'}</Text>
              {value === 'annual' && saving ? <Text style={[s.save, value === cycle && { color: DARK_ON_PRIMARY }]}>Save {saving}%</Text> : null}
            </Pressable>
          ))}
        </View>

        <View style={s.features}>
          {features.map((f, i) => (
            <View key={f.text} style={[s.featureRow, i > 0 && s.featureDivider]}>
              <MaterialCommunityIcons name={f.icon} size={20} color={c.text} />
              <Text style={s.featureText}>{f.text}</Text>
            </View>
          ))}
        </View>
      </ScrollView>

      {/* Pinned to the bottom, like the stores' own paywalls. */}
      <View style={s.footer}>
        <Text style={s.terms}>
          {trial ? `Free for ${trialText}, then ${money(price, selected.currency)}/${unit}. ` : ''}
          Charged to your {store === 'apple' ? 'Apple ID' : store === 'google' ? 'Google Play account' : 'test account'}. Renews until cancelled in {STORE_LABEL[store]}.
        </Text>
        <Pressable onPress={onBuy} disabled={Boolean(busy) || isCurrent}
          style={({ pressed }) => [s.cta, !isCurrent && gradient(PRIMARY_GRADIENT), isCurrent && s.ctaDisabled, (pressed || busy === 'buy') && { opacity: 0.85 }]}>
          <Text style={[s.ctaText, isCurrent && { color: c.textSecondary }]}>{busy === 'buy' ? 'Please wait…' : cta}</Text>
        </Pressable>
        <View style={s.footerLinks}>
          <Text style={s.cancelAnytime}>Cancel anytime.</Text>
          {!changing ? (
            <Pressable onPress={restorePurchases} disabled={Boolean(busy)} hitSlop={8}>
              <Text style={s.restore}>{busy === 'restore' ? 'Restoring…' : 'Restore purchases'}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {store === 'mock' ? (
        <MockStoreSheet visible={confirming} plan={selected} cycle={cycle} trial={trial} trialText={trialText} busy={busy === 'buy'} onConfirm={purchase} onClose={() => setConfirming(false)} />
      ) : null}
    </Screen>
  );
}

function MockStoreSheet({ visible, plan, cycle, trial, trialText, busy, onConfirm, onClose }: {
  visible: boolean; plan: Plan; cycle: BillingCycle; trial: boolean; trialText: string; busy: boolean; onConfirm: () => void; onClose: () => void;
}) {
  const price = cycle === 'annual' ? plan.annualPrice : plan.monthlyPrice;
  const unit = cycle === 'annual' ? 'year' : 'month';
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={s.sheet}>
        <View style={s.grabber} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <MaterialCommunityIcons name="flask-outline" size={20} color="#7FB2FF" />
          <Text style={{ flex: 1, color: c.text, fontSize: 15, fontWeight: '800' }}>Test store</Text>
          <Pressable onPress={onClose} hitSlop={10}><Ionicons name="close" size={22} color={c.textSecondary} /></Pressable>
        </View>
        <View style={s.sheetRow}>
          <Text style={s.sheetLabel}>Routify {plan.name} ({cycle === 'annual' ? 'yearly' : 'monthly'})</Text>
          <Text style={s.sheetValue}>{trial ? money(0, plan.currency) : money(price, plan.currency)}</Text>
        </View>
        {trial ? <Text style={s.sheetNote}>Free for {trialText}, then {money(price, plan.currency)}/{unit}. You can cancel before the trial ends.</Text> : null}
        <Text style={s.sheetNote}>This is a test purchase. No money is charged. On a real phone this is where Google Play or the App Store asks you to confirm.</Text>
        <PButton title={trial ? 'Start free trial' : 'Subscribe'} onPress={onConfirm} loading={busy} style={{ marginTop: 16 }} />
      </View>
    </Modal>
  );
}



const s = StyleSheet.create({
  heroIcon: { width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,170,50,0.14)', borderWidth: 1, borderColor: 'rgba(255,170,50,0.35)' },
  heroTitle: { color: c.text, fontSize: 22, fontWeight: '800', textAlign: 'center', marginTop: 14, lineHeight: 29 },
  heroSub: { color: c.textSecondary, fontSize: 13, textAlign: 'center', marginTop: 6 },
  price: { color: c.textMuted, fontSize: 12, textAlign: 'center', marginTop: 6, marginBottom: 4 },
  segment: { flexDirection: 'row', backgroundColor: c.surfaceSoft, borderRadius: r.pill, padding: 4, marginTop: 16 },
  segmentItem: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 9, borderRadius: r.pill },
  segmentActive: { backgroundColor: c.primary },
  segmentText: { color: c.textSecondary, fontSize: 13, fontWeight: '700' },
  segmentTextActive: { color: DARK_ON_PRIMARY },
  save: { color: c.success, fontSize: 10, fontWeight: '800', marginTop: 1 },
  features: { marginTop: 16, borderRadius: r.large, borderWidth: 1, borderColor: c.border, overflow: 'hidden', backgroundColor: c.surface },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 13 },
  featureDivider: { borderTopWidth: 1, borderTopColor: c.divider },
  featureText: { flex: 1, color: c.text, fontSize: 14, fontWeight: '600' },

  footer: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 14, borderTopWidth: 1, borderTopColor: c.divider, backgroundColor: c.background },
  terms: { color: c.textMuted, fontSize: 11, lineHeight: 16, textAlign: 'center' },
  cta: { marginTop: 10, borderRadius: r.pill, paddingVertical: 14, alignItems: 'center', backgroundColor: c.primary },
  ctaDisabled: { backgroundColor: c.surfaceSoft },
  ctaText: { color: DARK_ON_PRIMARY, fontSize: 16, fontWeight: '800' },
  footerLinks: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 16, marginTop: 10 },
  cancelAnytime: { color: c.textSecondary, fontSize: 12 },
  restore: { color: c.primary, fontSize: 12, fontWeight: '700' },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { backgroundColor: c.surfaceElevated, borderTopLeftRadius: r.xlarge, borderTopRightRadius: r.xlarge, padding: 20, paddingBottom: 34, borderWidth: 1, borderColor: c.border },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: c.border, marginBottom: 14 },
  sheetRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, paddingVertical: 12, borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.divider },
  sheetLabel: { color: c.text, fontSize: 14, fontWeight: '600', flex: 1 },
  sheetValue: { color: c.text, fontSize: 15, fontWeight: '800' },
  sheetNote: { color: c.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 10 },
});
