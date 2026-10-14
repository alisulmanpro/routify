import { useRef, useState } from 'react';
import { View } from 'react-native';
import RevenueCatUI from 'react-native-purchases-ui';
import { hasPro, isCancelled, purchaseErrorMessage, syncWithServer } from '../lib/revenuecat';
import { ErrorBanner } from './Premium';

/**
 * RevenueCat's paywall (designed in the RevenueCat dashboard, using the current offering). After a purchase or restore
 * the API re-reads the rider from RevenueCat, so the plan is active on the server before the screen closes.
 */
export default function RevenueCatPaywall({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState('');
  const closed = useRef(false);
  const syncing = useRef<Promise<void> | null>(null);
  // onDismiss also fires right after a successful purchase: close exactly once, and only after the API has the new plan.
  const close = () => { if (!closed.current) { closed.current = true; onDone(); } };
  const dismiss = () => { if (syncing.current) void syncing.current.then(close); else close(); };

  const syncThenClose = () => {
    syncing.current = syncWithServer()
      .then(close)
      .catch(() => setError('Your purchase went through, but we could not update your plan yet. Open Subscription again in a moment.'));
  };

  return (
    <View style={{ flex: 1 }}>
      {error ? <View style={{ padding: 16 }}><ErrorBanner text={error} /></View> : null}
      <RevenueCatUI.Paywall
        style={{ flex: 1 }}
        options={{ displayCloseButton: true }}
        onPurchaseCompleted={syncThenClose}
        onRestoreCompleted={({ customerInfo }) => {
          if (hasPro(customerInfo)) syncThenClose();
          else setError('No active Routify Pro subscription was found for this store account.');
        }}
        onPurchaseError={({ error: err }) => { if (!isCancelled(err)) setError(purchaseErrorMessage(err)); }}
        onRestoreError={({ error: err }) => setError(purchaseErrorMessage(err))}
        onDismiss={dismiss}
      />
    </View>
  );
}
