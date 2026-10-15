import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { useFocusEffect } from '../lib/useFocusEffect';
import { useNav } from '../lib/nav';
import { get } from '../lib/api';
import { loadStoreConfig, pickStore, trialAdjective } from '../lib/billing';
import type { StoreConfig, SubscriptionInfo } from '../lib/types';
import { IconCircle, PButton, PCard } from './Premium';
import { premium as c } from '../lib/theme';

/** Shown on Home while the rider has no working plan: new riders start without one, since the free trial needs a card. */
export default function PlanNudge() {
  const { navigate } = useNav();
  const [status, setStatus] = useState<string | null>(null);
  const [config, setConfig] = useState<StoreConfig | null>(null);

  useFocusEffect(useCallback(() => {
    Promise.all([get<SubscriptionInfo>('/subscriptions/me'), loadStoreConfig().catch(() => null)])
      .then(([me, storeConfig]) => { setStatus(me.data.subscription?.status ?? 'inactive'); setConfig(storeConfig); })
      .catch(() => {});
  }, []));

  if (!status || !['inactive', 'expired', 'cancelled'].includes(status)) return null;
  const store = config ? pickStore(config) : null;
  const trial = Boolean(store && config?.trialEligible[store]);
  const isNew = status === 'inactive';

  return (
    <PCard accent style={{ marginBottom: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <IconCircle icon={isNew ? 'rocket-launch-outline' : 'alert-circle-outline'} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.text, fontSize: 15, fontWeight: '800' }}>
            {trial && config ? `Start your ${trialAdjective(config.trialDays)} free trial` : isNew ? 'Choose a plan to get started' : 'Your plan has ended'}
          </Text>
          <Text style={{ color: c.textSecondary, fontSize: 12, marginTop: 3, lineHeight: 17 }}>
            {isNew ? 'Add deliveries and plan routes once your plan is active.' : 'Renew to keep adding deliveries.'}
          </Text>
        </View>
      </View>
      <PButton title={trial ? 'Start free trial' : 'See plans'} icon="sparkles-outline" onPress={() => navigate(store ? 'Paywall' : 'SubscriptionScreen')} chevron style={{ marginTop: 14 }} />
    </PCard>
  );
}
