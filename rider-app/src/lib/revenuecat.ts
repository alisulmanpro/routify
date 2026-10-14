import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import Purchases, { LOG_LEVEL, PURCHASES_ERROR_CODE, type CustomerInfo, type PurchasesError } from 'react-native-purchases';
import { post } from './api';
import type { SubscriptionInfo } from './types';

/**
 * RevenueCat: one SDK for Google Play, the App Store and RevenueCat's Test Store.
 *
 * - Each rider is identified by their Routify user id (logIn on sign-in, logOut on sign-out), so purchases follow the
 *   account across devices and the API can read the same customer from RevenueCat's server.
 * - The app checks the `routify_pro` entitlement for display; the API decides access (it re-reads RevenueCat itself
 *   after every purchase and on every RevenueCat webhook), so nothing here can be tampered with to unlock the app.
 * - RevenueCat needs its native modules, which Expo Go does not include: there the app keeps the API's test store.
 */

export const ENTITLEMENT = 'routify_pro';

const KEYS = {
  test: process.env.EXPO_PUBLIC_REVENUECAT_TEST_API_KEY,
  android: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY,
  ios: process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY,
};

/** Debug builds may use the Test Store key; release builds must use the platform key (the SDK crashes on a test key). */
function apiKey(): string | undefined {
  const platformKey = Platform.OS === 'ios' ? KEYS.ios : Platform.OS === 'android' ? KEYS.android : undefined;
  return __DEV__ ? KEYS.test || platformKey : platformKey;
}

const inExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

/** True when real RevenueCat purchases can run here: a development or release build with a key for this platform. */
export const revenueCatAvailable = () => !inExpoGo && Platform.OS !== 'web' && Boolean(apiKey());

let configured = false;

/** Call once at startup. Safe to call again; does nothing where RevenueCat is unavailable. */
export function configureRevenueCat() {
  if (configured || !revenueCatAvailable()) return;
  if (__DEV__) void Purchases.setLogLevel(LOG_LEVEL.DEBUG);
  Purchases.configure({ apiKey: apiKey()! });
  configured = true;
}

/** Links purchases to the signed-in rider. RevenueCat moves any anonymous purchases onto this id. */
export async function identifyRider(userId: string) {
  if (!configured) return;
  try { await Purchases.logIn(userId); } catch (err) { if (__DEV__) console.warn('RevenueCat logIn failed', err); }
}

/** Forgets the rider on this device so the next account starts clean. */
export async function forgetRider() {
  if (!configured) return;
  try {
    if (!(await Purchases.isAnonymous())) await Purchases.logOut();
  } catch { /* already anonymous */ }
}

/** Asks the API to re-read this rider from RevenueCat and returns the updated plan. Call after any purchase or restore. */
export const syncWithServer = async () =>
  (await post<SubscriptionInfo>('/subscriptions/purchases', { store: 'revenuecat' })).data;

export const hasPro = (info: CustomerInfo | null) => Boolean(info?.entitlements.active[ENTITLEMENT]);

/** Live CustomerInfo: loads it once and follows RevenueCat's updates (renewals, restores, purchases on other devices). */
export function useCustomerInfo() {
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!configured) return;
    let alive = true;
    const listener = (info: CustomerInfo) => { if (alive) setCustomerInfo(info); };
    Purchases.getCustomerInfo().then(listener).catch((err) => alive && setError(purchaseErrorMessage(err)));
    Purchases.addCustomerInfoUpdateListener(listener);
    return () => { alive = false; Purchases.removeCustomerInfoUpdateListener(listener); };
  }, []);
  return { customerInfo, isPro: hasPro(customerInfo), error };
}

export async function restorePurchases() {
  await Purchases.restorePurchases();
  return syncWithServer();
}

const isPurchasesError = (err: unknown): err is PurchasesError => typeof err === 'object' && err !== null && 'code' in err && 'message' in err;

/** True when the rider simply backed out of the store sheet: not an error worth showing. */
export const isCancelled = (err: unknown) => isPurchasesError(err) && (err.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR || Boolean(err.userCancelled));

/** Turns RevenueCat / store errors into a sentence a rider can act on. */
export function purchaseErrorMessage(err: unknown): string {
  if (!isPurchasesError(err)) return err instanceof Error ? err.message : 'Something went wrong with the store. Please try again.';
  switch (err.code) {
    case PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR: return 'Purchase cancelled.';
    case PURCHASES_ERROR_CODE.NETWORK_ERROR: return 'No connection to the store. Check your internet and try again.';
    case PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR: return 'Your payment is pending. Your plan starts as soon as the store confirms it.';
    case PURCHASES_ERROR_CODE.PRODUCT_ALREADY_PURCHASED_ERROR: return 'You already have this plan. Tap "Restore purchases" to load it.';
    case PURCHASES_ERROR_CODE.PURCHASE_NOT_ALLOWED_ERROR: return 'Purchases are not allowed on this device or account.';
    case PURCHASES_ERROR_CODE.STORE_PROBLEM_ERROR: return 'The store had a problem. Please try again in a moment.';
    case PURCHASES_ERROR_CODE.RECEIPT_ALREADY_IN_USE_ERROR: return 'This purchase belongs to another Routify account. Sign in with that account to use it.';
    default: return err.message || 'Something went wrong with the store. Please try again.';
  }
}
