import { useCallback, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import type { PurchasesPackage } from 'react-native-purchases';
import { useFocusEffect } from '../lib/useFocusEffect';
import { useNav } from '../lib/nav';
import { get, ApiRequestError } from '../lib/api';
import { queryClient } from '../lib/query';
import type { SubscriptionInfo } from '../lib/types';
import { money } from '../lib/format';
import { buy, loadStoreConfig, openStoreSubscriptions, pickStore, PREMIUM_NAME, PREMIUM_PLAN_KEY, restore, STORE_LABEL, trialAdjective, trialLabel } from '../lib/billing';
import { availableTrialDays, buyPackage, isCancelled, loadPremiumPackage, purchaseErrorMessage, restorePurchases } from '../lib/revenuecat';
import { Screen } from '../components/Kit';
import { LightButton, LightError, LightPill } from '../components/LightKit';
import { light as c } from '../lib/theme';

/** What the page sells, from whichever store this phone buys through. */
type Offer = {
  store: 'revenuecat' | 'mock';
  price: string; // "€30.00", from the store (RevenueCat) or the API's plan (test store)
  trialDays: number; // 0: no free trial for this rider
  pkg?: PurchasesPackage;
  billedTo: string;
};

type Loaded =
  | { kind: 'offer'; offer: Offer }
  | { kind: 'subscribed'; info: SubscriptionInfo }
  | { kind: 'unavailable'; text: string };

const FEATURES: { icon: React.ComponentProps<typeof MaterialCommunityIcons>['name']; text: string }[] = [
  { icon: 'map-marker-path', text: 'Route planning and optimising' },
  { icon: 'file-document-outline', text: 'Import stops from PDF and photos' },
  { icon: 'camera-outline', text: 'Proof of delivery photos' },
  { icon: 'calendar-check-outline', text: 'Daily delivery reports' },
  { icon: 'cloud-off-outline', text: 'Works offline, syncs when back online' },
  { icon: 'headset', text: 'Priority support' },
];

const errorText = (err: unknown, fallback: string) => (err instanceof ApiRequestError || err instanceof Error ? err.message : fallback);

async function loadOffer(): Promise<Loaded> {
  const [me, config] = await Promise.all([get<SubscriptionInfo>('/subscriptions/me'), loadStoreConfig()]);
  const info = me.data;
  const sub = info.subscription;
  if (sub?.storeManaged && info.store && (sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due')) {
    return { kind: 'subscribed', info };
  }
  const store = pickStore(config);
  if (store === 'revenuecat') {
    const pkg = await loadPremiumPackage();
    if (!pkg) return { kind: 'unavailable', text: `${PREMIUM_NAME} is not set up in the store yet.` };
    return { kind: 'offer', offer: { store, pkg, price: pkg.product.priceString, trialDays: await availableTrialDays(pkg), billedTo: STORE_LABEL.revenuecat } };
  }
  if (store === 'mock') {
    const plan = info.plans.find((p) => p.key === PREMIUM_PLAN_KEY);
    if (!plan) return { kind: 'unavailable', text: `${PREMIUM_NAME} is not available right now.` };
    return { kind: 'offer', offer: { store, price: money(plan.monthlyPrice, plan.currency), trialDays: config.trialEligible.mock ? config.trialDays : 0, billedTo: 'the test store' } };
  }
  return { kind: 'unavailable', text: 'In-app purchases are not available on this version of the app.' };
}

/** Routify Premium: one monthly plan with the store's free trial, on one page. Bought through Google Play / the App
 * Store via RevenueCat (the test store where RevenueCat cannot run, e.g. Expo Go). */
export default function Paywall() {
  const { goBack } = useNav();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'buy' | 'restore' | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(() => {
    setError('');
    loadOffer().then(setLoaded).catch((err) => setError(errorText(err, 'Could not load Routify Premium')));
  }, []);
  useFocusEffect(load);

  // Home's chip and the Subscription screen read the plan from the API: refresh them, then close.
  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: ['home'] });
    goBack();
  };

  const purchase = async (offer: Offer) => {
    setBusy('buy');
    setError('');
    try {
      if (offer.store === 'revenuecat') await buyPackage(offer.pkg!);
      else await buy('mock', PREMIUM_PLAN_KEY, 'monthly', { trial: offer.trialDays > 0 });
      setConfirming(false);
      await done();
    } catch (err) {
      setConfirming(false);
      if (!isCancelled(err)) setError(offer.store === 'revenuecat' ? purchaseErrorMessage(err) : errorText(err, 'The purchase did not go through'));
    } finally { setBusy(null); }
  };

  const onRestore = async (offer: Offer) => {
    setBusy('restore');
    setError('');
    try {
      const info = offer.store === 'revenuecat' ? await restorePurchases() : await restore('mock');
      const status = info.subscription?.status;
      if (status === 'active' || status === 'trialing') await done();
      else setError(`No active ${PREMIUM_NAME} subscription was found for this account.`);
    } catch (err) { setError(offer.store === 'revenuecat' ? purchaseErrorMessage(err) : errorText(err, 'Nothing to restore')); }
    finally { setBusy(null); }
  };

  const offer = loaded?.kind === 'offer' ? loaded.offer : null;

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <View style={s.topBar}>
        <Pressable onPress={goBack} hitSlop={12} accessibilityLabel="Close" style={s.close}>
          <Ionicons name="close" size={24} color={c.text} />
        </Pressable>
        {offer ? (
          <Pressable onPress={() => void onRestore(offer)} disabled={Boolean(busy)} hitSlop={10}>
            <Text style={s.restore}>{busy === 'restore' ? 'Restoring…' : 'Restore'}</Text>
          </Pressable>
        ) : null}
      </View>

      {!loaded ? (
        <View style={s.center}>
          {error ? (
            <>
              <LightError text={error} />
              <LightButton title="Try again" variant="outline" onPress={load} style={{ alignSelf: 'stretch', marginTop: 16 }} />
            </>
          ) : <ActivityIndicator color={c.link} />}
        </View>
      ) : loaded.kind === 'unavailable' ? (
        <View style={s.center}><LightError text={loaded.text} /></View>
      ) : loaded.kind === 'subscribed' ? (
        <Subscribed info={loaded.info} onManage={() => { if (loaded.info.store) void openStoreSubscriptions(loaded.info.store.store, loaded.info.store.productId).then(load); }} />
      ) : (
        <>
          <ScrollView contentContainerStyle={s.body}>
            <Hero offer={loaded.offer} />
            <LightError text={error} />
            <PlanCard offer={loaded.offer} />
            {loaded.offer.trialDays > 0 ? <TrialSteps offer={loaded.offer} /> : null}
            <Text style={s.section}>Everything in Premium</Text>
            {FEATURES.map((f) => (
              <View key={f.text} style={s.feature}>
                <MaterialCommunityIcons name={f.icon} size={22} color={c.link} />
                <Text style={s.featureText}>{f.text}</Text>
              </View>
            ))}
          </ScrollView>

          <View style={s.footer}>
            <LightButton
              title={loaded.offer.trialDays > 0 ? `Start ${trialAdjective(loaded.offer.trialDays)} free trial` : `Subscribe for ${loaded.offer.price}/month`}
              onPress={() => (loaded.offer.store === 'mock' ? setConfirming(true) : void purchase(loaded.offer))}
              loading={busy === 'buy'} disabled={busy === 'restore'} />
            <Text style={s.terms}>
              {loaded.offer.trialDays > 0 ? `Free for ${trialLabel(loaded.offer.trialDays)}, then ${loaded.offer.price}/month. ` : `${loaded.offer.price}/month. `}
              Billed through {loaded.offer.billedTo}. Renews every month until you cancel. Cancel anytime.
            </Text>
          </View>

          {loaded.offer.store === 'mock' ? (
            <TestStoreSheet visible={confirming} offer={loaded.offer} busy={busy === 'buy'} onConfirm={() => void purchase(loaded.offer)} onClose={() => setConfirming(false)} />
          ) : null}
        </>
      )}
    </Screen>
  );
}

function Hero({ offer }: { offer: Offer }) {
  return (
    <View style={{ alignItems: 'center' }}>
      <View style={s.crown}><MaterialCommunityIcons name="crown" size={34} color={c.link} /></View>
      <Text style={s.title}>{PREMIUM_NAME}</Text>
      {offer.trialDays > 0 ? (
        <>
          <Text style={s.headline}>Try it free for {trialLabel(offer.trialDays)}</Text>
          <Text style={s.sub}>then {offer.price} a month. Cancel anytime.</Text>
        </>
      ) : <Text style={s.sub}>Plan routes faster and deliver more every day.</Text>}
      {offer.store === 'mock' ? <View style={{ marginTop: 12 }}><LightPill text="Test store · no real payment" tone="blue" /></View> : null}
    </View>
  );
}

function PlanCard({ offer }: { offer: Offer }) {
  return (
    <View style={s.plan}>
      <Ionicons name="checkmark-circle" size={24} color={c.link} />
      <View style={{ flex: 1 }}>
        <Text style={s.planName}>Monthly</Text>
        <Text style={s.planPrice}><Text style={s.planAmount}>{offer.price}</Text> / month</Text>
      </View>
      {offer.trialDays > 0 ? <LightPill text={`${trialLabel(offer.trialDays).toUpperCase()} FREE`} tone="green" /> : null}
    </View>
  );
}

/** When the trial ends and what is charged, so nobody is surprised by the first payment. */
function TrialSteps({ offer }: { offer: Offer }) {
  const steps = [
    { icon: 'lock-open-variant-outline' as const, title: 'Today', text: 'Full access to Routify Premium, free.' },
    { icon: 'bell-outline' as const, title: `After ${trialLabel(offer.trialDays)}`, text: `Your first ${offer.price} is charged, then every month.` },
    { icon: 'close-circle-outline' as const, title: 'Anytime', text: `Cancel in ${offer.billedTo} before the trial ends and pay nothing.` },
  ];
  return (
    <View style={s.steps}>
      {steps.map((step, i) => (
        <View key={step.title} style={[s.step, i > 0 && s.stepDivider]}>
          <MaterialCommunityIcons name={step.icon} size={20} color={c.textLabel} />
          <View style={{ flex: 1 }}>
            <Text style={s.stepTitle}>{step.title}</Text>
            <Text style={s.stepText}>{step.text}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function Subscribed({ info, onManage }: { info: SubscriptionInfo; onManage: () => void }) {
  const sub = info.subscription!;
  const trialing = sub.status === 'trialing';
  const ends = new Date(sub.currentPeriodEnd).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <View style={[s.body, { alignItems: 'center' }]}>
      <View style={s.crown}><MaterialCommunityIcons name="crown" size={34} color={c.link} /></View>
      <Text style={s.title}>You have {PREMIUM_NAME}</Text>
      <Text style={s.sub}>
        {sub.status === 'past_due' ? `Your last payment failed. Update it in ${info.store ? STORE_LABEL[info.store.store] : 'the store'} to keep Premium.`
          : sub.cancelAtPeriodEnd ? `Your plan ends on ${ends}.`
            : trialing ? `Your free trial ends on ${ends}, then it renews monthly.` : `Renews on ${ends}.`}
      </Text>
      {info.store?.store !== 'mock' ? <LightButton title="Manage subscription" variant="outline" onPress={onManage} style={{ alignSelf: 'stretch', marginTop: 28 }} /> : null}
    </View>
  );
}

function TestStoreSheet({ visible, offer, busy, onConfirm, onClose }: { visible: boolean; offer: Offer; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  const trial = offer.trialDays > 0;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={s.sheet}>
        <View style={s.grabber} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <MaterialCommunityIcons name="flask-outline" size={20} color={c.link} />
          <Text style={{ flex: 1, color: c.text, fontSize: 16, fontWeight: '700' }}>Test store</Text>
          <Pressable onPress={onClose} hitSlop={10}><Ionicons name="close" size={22} color={c.textSecondary} /></Pressable>
        </View>
        <View style={s.sheetRow}>
          <Text style={{ flex: 1, color: c.text, fontSize: 15, fontWeight: '600' }}>{PREMIUM_NAME} (monthly)</Text>
          <Text style={{ color: c.text, fontSize: 16, fontWeight: '700' }}>{trial ? 'Free' : offer.price}</Text>
        </View>
        {trial ? <Text style={s.sheetNote}>Free for {trialLabel(offer.trialDays)}, then {offer.price}/month.</Text> : null}
        <Text style={s.sheetNote}>A test purchase: no money is charged. On a store build, Google Play or the App Store asks you to confirm here.</Text>
        <LightButton title={trial ? 'Start free trial' : 'Subscribe'} onPress={onConfirm} loading={busy} style={{ marginTop: 18 }} />
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  close: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: c.soft },
  restore: { color: c.link, fontSize: 15, fontWeight: '600' },
  center: { flex: 1, justifyContent: 'center', padding: 24 },
  body: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 24 },

  crown: { width: 72, height: 72, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: c.linkBg },
  title: { color: c.text, fontSize: 30, fontWeight: '800', textAlign: 'center', marginTop: 16, letterSpacing: -0.5 },
  headline: { color: c.link, fontSize: 18, fontWeight: '700', textAlign: 'center', marginTop: 8 },
  sub: { color: c.textSecondary, fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 6 },

  plan: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 24, padding: 16, borderRadius: 16, borderWidth: 2, borderColor: c.link, backgroundColor: c.linkBg },
  planName: { color: c.text, fontSize: 16, fontWeight: '700' },
  planPrice: { color: c.textSecondary, fontSize: 14, marginTop: 2 },
  planAmount: { color: c.text, fontSize: 18, fontWeight: '800' },

  steps: { marginTop: 16, borderRadius: 16, borderWidth: 1, borderColor: c.border },
  step: { flexDirection: 'row', gap: 12, padding: 14 },
  stepDivider: { borderTopWidth: 1, borderTopColor: c.border },
  stepTitle: { color: c.text, fontSize: 14, fontWeight: '700' },
  stepText: { color: c.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 2 },

  section: { color: c.textSecondary, fontSize: 13, fontWeight: '600', marginTop: 24, marginBottom: 4 },
  feature: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 10 },
  featureText: { flex: 1, color: c.text, fontSize: 15 },

  footer: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 16, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.background },
  terms: { color: c.textSecondary, fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 10 },

  backdrop: { flex: 1, backgroundColor: 'rgba(24,24,27,0.45)' },
  sheet: { backgroundColor: c.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 34 },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: c.border, marginBottom: 14 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', marginTop: 16, paddingVertical: 12, borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.border },
  sheetNote: { color: c.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 10 },
});
