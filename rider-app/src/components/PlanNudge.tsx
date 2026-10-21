import { useCallback, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '../lib/useFocusEffect';
import { useNav } from '../lib/nav';
import { get } from '../lib/api';
import { loadStoreConfig, pickStore, trialAdjective } from '../lib/billing';
import type { StoreConfig, SubscriptionInfo } from '../lib/types';
import { LightButton } from './LightKit';
import { light as c } from '../lib/theme';

/**
 * Home's top-right "Free trial" / "Upgrade" button, shown while the rider has no working plan (new riders start without
 * one, since the free trial needs a card). Tapping it opens a sheet that leads to the paywall.
 */
export default function PlanNudge() {
  const { navigate } = useNav();
  const [status, setStatus] = useState<string | null>(null);
  const [config, setConfig] = useState<StoreConfig | null>(null);
  const [open, setOpen] = useState(false);

  useFocusEffect(useCallback(() => {
    Promise.all([get<SubscriptionInfo>('/subscriptions/me'), loadStoreConfig().catch(() => null)])
      .then(([me, storeConfig]) => { setStatus(me.data.subscription?.status ?? 'inactive'); setConfig(storeConfig); })
      .catch(() => {});
  }, []));

  if (!status || !['inactive', 'expired', 'cancelled'].includes(status)) return null;
  const store = config ? pickStore(config) : null;
  const trial = Boolean(store && config?.trialEligible[store]);
  const isNew = status === 'inactive';

  const go = () => { setOpen(false); navigate(store ? 'Paywall' : 'SubscriptionScreen'); };

  return (
    <>
      <Pressable onPress={() => setOpen(true)} hitSlop={6} style={({ pressed }) => [s.chip, pressed && { opacity: 0.8 }]} accessibilityLabel={trial ? 'Free trial' : 'Upgrade'}>
        <Ionicons name="sparkles" size={14} color={c.link} />
        <Text style={s.chipText}>{trial ? 'Free trial' : 'Upgrade'}</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setOpen(false)}>
          {/* Taps on the card itself must not close it. */}
          <Pressable style={s.card} onPress={() => {}}>
            <Pressable onPress={() => setOpen(false)} hitSlop={10} style={s.close} accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={c.textSecondary} />
            </Pressable>
            <View style={s.icon}>
              <Ionicons name={isNew ? 'sparkles' : 'alert-circle-outline'} size={26} color={c.link} />
            </View>
            <Text style={s.title}>
              {trial && config ? `Start your ${trialAdjective(config.trialDays)} free trial` : isNew ? 'Choose a plan to get started' : 'Your plan has ended'}
            </Text>
            <Text style={s.sub}>
              {isNew ? 'Add deliveries and plan routes once your plan is active.' : 'Renew to keep adding deliveries.'}
            </Text>
            <LightButton title={trial ? 'Start free trial' : 'See plans'} onPress={go} style={{ alignSelf: 'stretch', marginTop: 24 }} />
            <Pressable onPress={() => setOpen(false)} hitSlop={8} style={{ marginTop: 16 }}>
              <Text style={{ color: c.textSecondary, fontSize: 15, fontWeight: '500' }}>Not now</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 12, borderRadius: 999, backgroundColor: c.linkBg },
  chipText: { color: c.link, fontSize: 14, fontWeight: '600' },

  backdrop: { flex: 1, backgroundColor: 'rgba(24,24,27,0.45)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 400, alignItems: 'center', backgroundColor: c.surface, borderRadius: 24, paddingHorizontal: 24, paddingTop: 32, paddingBottom: 20 },
  close: { position: 'absolute', top: 14, right: 14 },
  icon: { width: 56, height: 56, borderRadius: 16, backgroundColor: c.linkBg, alignItems: 'center', justifyContent: 'center' },
  title: { color: c.text, fontSize: 22, fontWeight: '700', textAlign: 'center', marginTop: 18 },
  sub: { color: c.textSecondary, fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 8 },
});
