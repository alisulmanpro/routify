import { Linking, Platform } from 'react-native';
import { get, post } from './api';
import type { BillingCycle, PaidPlanKey, StoreConfig, StoreName, SubscriptionInfo } from './types';

/**
 * In-app subscriptions. The plan is bought through the phone's store (Google Play on Android, the App Store on iPhone)
 * and the receipt is sent to the API, which verifies it with the store before activating anything.
 *
 * Real store purchases need the expo-iap native module, which only runs in a development build (not Expo Go).
 * Until it is added, NATIVE_STORE_READY stays false and the app buys through the server's test store ("mock"),
 * which behaves like a real store: free trial, renewals, cancellation, failed payments and refunds.
 */
const NATIVE_STORE_READY = false;
const ANDROID_PACKAGE = 'com.azaan890.routify';

export const STORE_LABEL: Record<StoreName, string> = { apple: 'the App Store', google: 'Google Play', mock: 'the test store' };
/** The free-trial length the admin chose (7, 14 or 30 days): "free for 7 days" / "free for one month". */
export const trialLabel = (days: number) => (days === 30 ? 'one month' : `${days} days`);
/** The same length as an adjective: "your 7-day free trial" / "your one-month free trial". */
export const trialAdjective = (days: number) => (days === 30 ? 'one-month' : `${days}-day`);

export const loadStoreConfig = async () => (await get<StoreConfig>('/subscriptions/store')).data;

/** The store this phone buys through, or null when the server has no store this app can use. */
export function pickStore(config: StoreConfig): StoreName | null {
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

/** Store subscriptions are changed and cancelled in the store itself, never inside the app. */
export function openStoreSubscriptions(store: StoreName, productId?: string) {
  if (store === 'apple') return Linking.openURL('https://apps.apple.com/account/subscriptions');
  if (store === 'google') {
    const sku = productId ? `&sku=${encodeURIComponent(productId.split(':')[0])}` : '';
    return Linking.openURL(`https://play.google.com/store/account/subscriptions?package=${ANDROID_PACKAGE}${sku}`);
  }
  return Promise.resolve();
}

/** How much cheaper a year is than twelve months, as a whole percentage. */
export const annualSaving = (monthly: number, annual: number) => (monthly > 0 ? Math.max(0, Math.round((1 - annual / (monthly * 12)) * 100)) : 0);
