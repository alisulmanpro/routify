import { PermissionsAndroid, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { Camera } from 'expo-camera';

// The permissions asked for on onboarding, one screen each. Every feature still asks again itself when it needs one
// (scanning, the route map, navigation), so "Not now" here never blocks anything.

export type PermissionStep = 'location' | 'camera' | 'notifications';
export type PermissionState = { granted: boolean; canAskAgain: boolean };

export const PERMISSION_STEPS: PermissionStep[] = ['location', 'camera', 'notifications'];

const GRANTED: PermissionState = { granted: true, canAskAgain: true };

/**
 * Notifications are asked with React Native's own Android API (no notifications library is installed). Android 12
 * and older grant them at install. iOS needs expo-notifications, so the step is skipped there for now.
 */
export const notificationsSupported = Platform.OS === 'android';

export async function checkPermission(step: PermissionStep): Promise<PermissionState> {
  try {
    if (step === 'location') return pick(await Location.getForegroundPermissionsAsync());
    if (step === 'camera') return pick(await Camera.getCameraPermissionsAsync());
    if (Platform.OS !== 'android' || Platform.Version < 33) return GRANTED;
    return { granted: await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS), canAskAgain: true };
  } catch (err) {
    console.warn(`[permissions] check ${step} failed`, err);
    return { granted: false, canAskAgain: true };
  }
}

export async function requestPermission(step: PermissionStep): Promise<PermissionState> {
  try {
    if (step === 'location') return pick(await Location.requestForegroundPermissionsAsync());
    if (step === 'camera') return pick(await Camera.requestCameraPermissionsAsync());
    if (Platform.OS !== 'android' || Platform.Version < 33) return GRANTED;
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    return { granted: result === PermissionsAndroid.RESULTS.GRANTED, canAskAgain: result !== PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN };
  } catch (err) {
    console.warn(`[permissions] request ${step} failed`, err);
    return { granted: false, canAskAgain: true };
  }
}

const pick = (p: { granted: boolean; canAskAgain: boolean }): PermissionState => ({ granted: p.granted, canAskAgain: p.canAskAgain });

// Onboarding shows once per device, after the first sign-in.
const KEY = 'dp_onboarding_done_v1';

export async function onboardingDone(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(KEY)) === '1';
  } catch {
    return true;
  }
}

export async function finishOnboarding(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, '1');
  } catch { /* shows again next launch at worst */ }
}
