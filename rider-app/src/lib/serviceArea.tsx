import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, AppState, Modal, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { get, put, ApiRequestError } from './api';
import { TEST_LOCATION } from './location';
import { useAuth } from './auth';
import type { ServiceArea } from './types';
import { premium as c, premiumRadius as r, premiumShadow } from './theme';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const POLL_MS = 15 * 60 * 1000;
const SAME_CITY_KM = 35;
const lastCheckKey = (userId: string) => `dp_area_check_${userId}`;

type Detected = Omit<ServiceArea, 'source' | 'confirmedAt'>;
type Prompt = { detected: Detected; point: { latitude: number; longitude: number } };
type ServiceAreaContextValue = { checkNow: () => Promise<void> };

const ServiceAreaContext = createContext<ServiceAreaContextValue>({ checkNow: async () => {} });
export const useServiceArea = () => useContext(ServiceAreaContext);

const gradient = (value: string): ViewStyle => ({ experimental_backgroundImage: value } as ViewStyle);

function distanceKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

const sameCity = (a: Detected, b: ServiceArea | null) => !!b && a.countryCode === b.countryCode
  && (a.city.toLowerCase() === b.city.toLowerCase() || distanceKm(a, b) < SAME_CITY_KM);

async function currentPoint(askPermission: boolean) {
  if (TEST_LOCATION) return TEST_LOCATION;
  let permission = await Location.getForegroundPermissionsAsync();
  if (!permission.granted && askPermission && permission.canAskAgain) permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted) return null;
  const recent = await Location.getLastKnownPositionAsync({ maxAge: 10 * 60 * 1000 });
  const fix = recent || await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  return { latitude: fix.coords.latitude, longitude: fix.coords.longitude };
}

/**
 * Checks where the rider is on launch and every 6 hours. When they are in a different city
 * from their saved one, it asks before switching, because address lookups are scoped to it.
 */
export function ServiceAreaProvider({ children }: { children: ReactNode }) {
  const { user, refreshProfile } = useAuth();
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [saving, setSaving] = useState(false);
  const running = useRef(false);
  const userRef = useRef(user);
  useEffect(() => { userRef.current = user; }, [user]);

  const markChecked = useCallback(async () => {
    if (userRef.current) await AsyncStorage.setItem(lastCheckKey(userRef.current.id), String(Date.now())).catch(() => {});
  }, []);

  const runCheck = useCallback(async (manual: boolean) => {
    const rider = userRef.current;
    if (!rider || running.current) return;
    if (!manual) {
      const last = Number(await AsyncStorage.getItem(lastCheckKey(rider.id)).catch(() => null)) || 0;
      if (Date.now() - last < CHECK_EVERY_MS) return;
    }
    running.current = true;
    try {
      const point = await currentPoint(true);
      if (!point) {
        if (manual) Alert.alert('Location is off', 'Allow location access to detect your city, or type your city below.');
        return;
      }
      const { data: detected } = await get<Detected>('/rider/service-area/detect', point);
      if (sameCity(detected, rider.serviceArea)) {
        await markChecked();
        if (manual) Alert.alert('All set', `You're delivering in ${detected.city}, ${detected.country}.`);
        return;
      }
      setPrompt({ detected, point });
    } catch (err) {
      // A failed background check retries on the next launch; only a manual check reports it.
      if (manual) Alert.alert('Could not detect your city', err instanceof ApiRequestError ? err.message : 'Check your connection and try again.');
    } finally {
      running.current = false;
    }
  }, [markChecked]);

  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    // Give the first screen a moment to load before asking for location on launch.
    const first = setTimeout(() => { void runCheck(false); }, 1500);
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') void runCheck(false); });
    const timer = setInterval(() => { if (AppState.currentState === 'active') void runCheck(false); }, POLL_MS);
    return () => { clearTimeout(first); sub.remove(); clearInterval(timer); };
  }, [userId, runCheck]);

  const accept = async () => {
    if (!prompt) return;
    setSaving(true);
    try {
      await put('/rider/service-area', prompt.point);
      await refreshProfile();
      await markChecked();
      setPrompt(null);
    } catch (err) {
      Alert.alert('Could not switch city', err instanceof ApiRequestError ? err.message : 'Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  const decline = async () => {
    await markChecked();
    setPrompt(null);
  };

  const value = useMemo(() => ({ checkNow: () => runCheck(true) }), [runCheck]);
  const current = user?.serviceArea;

  return (
    <ServiceAreaContext.Provider value={value}>
      {children}
      <Modal visible={!!prompt} transparent animationType="fade" onRequestClose={decline} statusBarTranslucent>
        <View style={s.backdrop}>
          {prompt ? (
            <View style={s.sheet}>
              <View style={[s.iconWrap, gradient('radial-gradient(circle at 50% 50%, rgba(255,170,50,0.35) 0%, rgba(255,170,50,0.08) 70%)')]}>
                <MaterialCommunityIcons name="map-marker-radius" size={34} color={c.primary} />
              </View>
              <Text style={s.eyebrow}>New location detected</Text>
              <Text style={s.title}>We detected you in{'\n'}<Text style={{ color: c.primary }}>{prompt.detected.city}, {prompt.detected.country}</Text></Text>
              <Text style={s.body}>
                Do you want to continue today&apos;s deliveries in {prompt.detected.city}?
                {current ? ` Your deliveries are currently set to ${current.city}.` : ''} Addresses will be searched in the city you choose.
              </Text>
              <Pressable onPress={accept} disabled={saving} style={({ pressed }) => [s.primaryBtn, (pressed || saving) && { opacity: 0.9 }]}>
                {saving ? <ActivityIndicator color="#1A1206" /> : <Text style={s.primaryText}>Yes, deliver in {prompt.detected.city}</Text>}
              </Pressable>
              <Pressable onPress={decline} disabled={saving} style={({ pressed }) => [s.secondaryBtn, pressed && { opacity: 0.85 }]}>
                <Text style={s.secondaryText}>{current ? `No, keep ${current.city}` : 'Not now'}</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </Modal>
    </ServiceAreaContext.Provider>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(2,6,14,0.78)', alignItems: 'center', justifyContent: 'center', padding: 22 },
  sheet: { width: '100%', maxWidth: 420, backgroundColor: c.surface, borderRadius: r.xlarge, borderWidth: 1, borderColor: c.border, padding: 22, alignItems: 'center', ...premiumShadow },
  iconWrap: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,170,50,0.14)', marginBottom: 14 },
  eyebrow: { color: c.primary, fontSize: 11, fontWeight: '800', letterSpacing: 1.1, textTransform: 'uppercase' },
  title: { color: c.text, fontSize: 20, fontWeight: '800', textAlign: 'center', lineHeight: 27, marginTop: 6 },
  body: { color: c.textSecondary, fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 10, marginBottom: 20 },
  primaryBtn: { alignSelf: 'stretch', minHeight: 52, borderRadius: r.medium, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  primaryText: { color: '#1A1206', fontSize: 15, fontWeight: '800' },
  secondaryBtn: { alignSelf: 'stretch', minHeight: 48, borderRadius: r.medium, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceSoft, alignItems: 'center', justifyContent: 'center', marginTop: 10, paddingHorizontal: 16 },
  secondaryText: { color: c.text, fontSize: 14, fontWeight: '700' },
});
