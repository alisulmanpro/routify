import { Linking, Platform } from 'react-native';
import RevenueCatUI from 'react-native-purchases-ui';
import { revenueCatAvailable, syncWithServer } from './revenuecat';
import { get, post } from './api';
import type { BillingCycle, PaidPlanKey, StoreConfig, StoreName, SubscriptionInfo } from './types';

/**
 * In-app subscriptions. The plan is bought through the phone's store (Google Play on Android, the App Store on iPhone)
 * and the API verifies it with the store before activating anything.
 *
 * With RevenueCat (lib/revenuecat.ts) enabled on the API and a development/release build, purchases go through
 * RevenueCat's SDK and paywall. In Expo Go, where RevenueCat's native modules are missing, the test store is used.
 *
 * Real store purchases need the expo-iap native module, which only runs in a development build (not Expo Go).
 * Until it is added, NATIVE_STORE_READY stays false and the app buys through the server's test store ("mock"),
 * which behaves like a real store: free trial, renewals, cancellation, failed payments and refunds.
 */
const NATIVE_STORE_READY = false;
const ANDROID_PACKAGE = 'com.azaan890.routify';

const PHONE_STORE = Platform.OS === 'ios' ? 'the App Store' : 'Google Play';
export const STORE_LABEL: Record<StoreName, string> = { apple: 'the App Store', google: 'Google Play', revenuecat: PHONE_STORE, mock: 'the test store' };
/** A free-trial length: "free for 1 day" / "free for 7 days" / "free for one month". */
export const trialLabel = (days: number) => (days === 30 ? 'one month' : days === 1 ? '1 day' : `${days} days`);
/** The same length as an adjective: "your 1-day free trial" / "your one-month free trial". */
export const trialAdjective = (days: number) => (days === 30 ? 'one-month' : `${days}-day`);
/** The one plan the app sells (the API's `pro` plan, named in Admin → Plans). */
export const PREMIUM_PLAN_KEY = 'pro';
export const PREMIUM_NAME = 'Routify Premium';

export const loadStoreConfig = async () => (await get<StoreConfig>('/subscriptions/store')).data;

/** The store this phone buys through, or null when the server has no store this app can use. */
export function pickStore(config: StoreConfig): StoreName | null {
  if (config.stores.includes('revenuecat') && revenueCatAvailable()) return 'revenuecat';
  const native: StoreName | null = Platform.OS === 'ios' ? 'apple' : Platform.OS === 'android' ? 'google' : null;
  if (native && NATIVE_STORE_READY && config.stores.includes(native)) return native;
  return config.stores.includes('mock') ? 'mock' : null;
}

export async function buy(store: StoreName, planKey: PaidPlanKey, cycle: BillingCycle, opts: { trial: boolean }): Promise<SubscriptionInfo> {
  if (store === 'mock') {
    return (await post<SubscriptionInfo>('/subscriptions/purchases', { store: 'mock', productId: `${planKey}.${cycle}`, trial: opts.trial })).data;
  }
  throw new Error(`Buying through ${STORE_LABEL[store]} needs the store module in a development build.`);
}

/** "Restore purchases": the stores re-send every active subscription, and the API links it to this account again. */
export async function restore(store: StoreName): Promise<SubscriptionInfo> {
  if (store === 'mock') return (await get<SubscriptionInfo>('/subscriptions/me')).data;
  throw new Error(`Restoring from ${STORE_LABEL[store]} needs the store module in a development build.`);
}

export type MockEvent = 'renew' | 'cancel' | 'resume' | 'fail_renewal' | 'grace' | 'recover' | 'expire' | 'refund';
export const mockEvent = async (event: MockEvent) => (await post<SubscriptionInfo>('/subscriptions/mock/events', { event })).data;

/** Store subscriptions are changed and cancelled in the store itself (or RevenueCat's Customer Center), never inside the app. */
export async function openStoreSubscriptions(store: StoreName, productId?: string) {
  if (store === 'revenuecat') {
    try {
      // Customer Center: manage, cancel, restore, and (iOS) request a refund. Re-sync afterwards in case anything changed.
      await RevenueCatUI.presentCustomerCenter({ callbacks: { onRestoreCompleted: () => { void syncWithServer(); } } });
      await syncWithServer();
      return;
    } catch {
      // Customer Center unavailable (e.g. not on the RevenueCat plan that includes it): fall back to the store's own page.
      return Linking.openURL(Platform.OS === 'ios' ? 'https://apps.apple.com/account/subscriptions'
        : `https://play.google.com/store/account/subscriptions?package=${ANDROID_PACKAGE}`);
    }
  }
  if (store === 'apple') return Linking.openURL('https://apps.apple.com/account/subscriptions');
  if (store === 'google') {
    const sku = productId ? `&sku=${encodeURIComponent(productId.split(':')[0])}` : '';
    return Linking.openURL(`https://play.google.com/store/account/subscriptions?package=${ANDROID_PACKAGE}${sku}`);
  }
  return Promise.resolve();
}

