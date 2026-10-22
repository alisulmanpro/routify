import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

// The Keychain (iOS) / Keystore-encrypted storage (Android) for the session and the rider's profile. The web build has
// no secure store, so it keeps using AsyncStorage (localStorage) as before.
const secure = Platform.OS !== 'web';

export const secureGet = (key: string) => (secure ? SecureStore.getItemAsync(key) : AsyncStorage.getItem(key));
export const secureSet = (key: string, value: string) => (secure ? SecureStore.setItemAsync(key, value) : AsyncStorage.setItem(key, value));
export const secureDelete = (key: string) => (secure ? SecureStore.deleteItemAsync(key) : AsyncStorage.removeItem(key));
