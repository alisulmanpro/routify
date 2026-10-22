import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { ActivityIndicator, Alert, AppState, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import { get, post, put, ApiRequestError } from './api';
import { TEST_LOCATION } from './location';
import { useAuth } from './auth';
import type { AddressSuggestion, ServiceArea } from './types';
import { light as c, lightRadius as lr } from './theme';
import { LightButton } from '../components/LightKit';
import ConfirmMap from '../components/scan/ConfirmMap';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const SAME_CITY_KM = 35;
const lastCheckKey = (userId: string) => `dp_area_check_${userId}`;

type Detected = Omit<ServiceArea, 'source' | 'confirmedAt'>;
type Prompt = { detected: Detected; point: { latitude: number; longitude: number } };
type ServiceAreaContextValue = { checkNow: () => Promise<void> };

const ServiceAreaContext = createContext<ServiceAreaContextValue>({ checkNow: async () => {} });
export const useServiceArea = () => useContext(ServiceAreaContext);

type Point = { latitude: number; longitude: number };
// Like Add stops' suggestions (P3.8): wait for a pause, and cancel a search a newer one replaces. Town and county names
// can be short, so this search starts at 2 characters.
const SEARCH_DELAY_MS = 500;

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
  // "Other area": the rider picks the area themselves (design_pref "Choose delivery area").
  const [choosing, setChoosing] = useState(false);
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
    // On launch (after the first screen has loaded) and whenever the app comes back to the foreground; each check is
    // skipped within CHECK_EVERY_MS of the last one. No timer while the app is open: it woke the GPS every 15 minutes.
    const first = setTimeout(() => { void runCheck(false); }, 1500);
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') void runCheck(false); });
    return () => { clearTimeout(first); sub.remove(); };
  }, [userId, runCheck]);

  // Saves the area at `point` (the server works out the town from it).
  const saveArea = async (point: Point) => {
    setSaving(true);
    try {
      await put('/rider/service-area', point);
      await refreshProfile();
      await markChecked();
      setChoosing(false);
      setPrompt(null);
    } catch (err) {
      Alert.alert('Could not switch area', err instanceof ApiRequestError ? err.message : 'Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };
  const accept = () => { if (prompt) void saveArea(prompt.point); };

  const decline = async () => {
    await markChecked();
    setChoosing(false);
    setPrompt(null);
  };

  const value = useMemo(() => ({ checkNow: () => runCheck(true) }), [runCheck]);
  const current = user?.serviceArea;

  return (
    <ServiceAreaContext.Provider value={value}>
      {children}
      {/* design_pref "Location sheet · B Map-led", then "Choose delivery area" for Other area */}
      <Modal visible={!!prompt} transparent animationType="fade" onRequestClose={() => (choosing ? setChoosing(false) : void decline())} statusBarTranslucent>
        <View style={s.backdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => (choosing ? setChoosing(false) : void decline())} accessibilityLabel="Close" />
          {prompt && !choosing ? (
            <View style={s.sheet}>
              <View style={s.grabber} />
              <View style={s.map}>
                <ConfirmMap point={prompt.point} fallback={null} style={{ flex: 1 }} />
                <View style={s.badge}><Text style={s.badgeText}>NEW LOCATION DETECTED</Text></View>
              </View>
              <Text style={s.title}>You&apos;re in <Text style={{ color: c.link }}>{prompt.detected.city}</Text></Text>
              <Text style={s.body}>
                Continue today&apos;s deliveries here? Address search will focus on this area.
                {/* Not in the design: which area it replaces. */}
                {current ? ` (Now set to ${current.city}.)` : ''}
              </Text>
              <LightButton title={`Yes, deliver in ${prompt.detected.city}`} onPress={accept} loading={saving} />
              <View style={{ flexDirection: 'row', gap: 12, marginTop: 12 }}>
                <LightButton title="Other area" variant="outline" icon={<Ionicons name="search" size={20} color={c.text} />} onPress={() => setChoosing(true)} disabled={saving} style={{ flex: 1 }} />
                <Pressable onPress={() => void decline()} disabled={saving} style={({ pressed }) => [s.notNow, pressed && { opacity: 0.85 }]}>
                  <Text style={s.notNowText}>Not now</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
          {prompt && choosing ? (
            <AreaPicker detected={prompt.detected} point={prompt.point} current={current ?? null} saving={saving} onConfirm={(point) => void saveArea(point)} />
          ) : null}
        </View>
      </Modal>
    </ServiceAreaContext.Provider>
  );
}

type Choice = { key: string; point: Point };

/**
 * Choose delivery area: the detected location, the area saved now, or a town, county or Eircode found by search
 * (the same address lookup as Add stops). Confirm saves it like "Yes, deliver in …".
 */
function AreaPicker({ detected, point, current, saving, onConfirm }: {
  detected: Detected; point: Point; current: ServiceArea | null; saving: boolean; onConfirm: (point: Point) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AddressSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<Choice>({ key: 'here', point });
  const searchId = useRef(0);

  const q = query.trim();
  useEffect(() => {
    if (q.length < 2) return;
    const id = ++searchId.current;
    const cancel = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      post<AddressSuggestion[]>('/deliveries/geocode-suggest', { query: q, ...point }, cancel.signal)
        .then((res) => { if (id === searchId.current) setResults(res.data); })
        .catch(() => { if (id === searchId.current) setResults([]); })
        .finally(() => { if (id === searchId.current) setSearching(false); });
    }, SEARCH_DELAY_MS);
    return () => { clearTimeout(timer); cancel.abort(); };
  }, [q, point]);
  const shown = q.length >= 2 ? results : [];

  const row = (key: string, icon: ComponentProps<typeof Ionicons>['name'], title: string, sub: string | null, at: Point, first = false) => {
    const on = picked.key === key;
    return (
      <Pressable key={key} onPress={() => setPicked({ key, point: at })} style={({ pressed }) => [s.row, !first && s.rowDivider, pressed && { opacity: 0.7 }]} accessibilityRole="radio" accessibilityState={{ selected: on }}>
        <View style={[s.rowIcon, key === 'here' && { backgroundColor: c.linkBg }]}>
          <Ionicons name={icon} size={20} color={key === 'here' ? c.link : c.textLabel} />
        </View>
        <View style={{ flex: 1, marginLeft: 14 }}>
          <Text style={s.rowTitle} numberOfLines={1}>{title}</Text>
          {sub ? <Text style={s.rowSub} numberOfLines={1}>{sub}</Text> : null}
        </View>
        {on ? <Ionicons name="checkmark" size={24} color={c.link} /> : null}
      </Pressable>
    );
  };

  return (
    <View style={[s.sheet, { paddingBottom: 16 }]}>
      <View style={s.grabber} />
      <Text style={[s.title, { marginTop: 0 }]}>Choose delivery area</Text>
      <View style={s.search}>
        <Ionicons name="search" size={20} color={c.textSecondary} />
        <TextInput value={query} onChangeText={setQuery} placeholder="Search town, county or Eircode area" placeholderTextColor={c.placeholder}
          style={s.searchInput} autoCorrect={false} returnKeyType="search" />
        {searching ? <ActivityIndicator size="small" color={c.textSecondary} /> : query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityLabel="Clear"><Ionicons name="close-circle" size={20} color={c.placeholder} /></Pressable>
        ) : null}
      </View>

      <View style={{ marginTop: 8 }}>
        {row('here', 'navigate-outline', 'Use current location', detected.city, point, true)}
        {/* The design lists recent areas; the app keeps none, so the area saved now is shown. MISSING: see missing.md */}
        {current && current.city.toLowerCase() !== detected.city.toLowerCase()
          ? row('saved', 'time-outline', current.city, 'Current area', { latitude: current.latitude, longitude: current.longitude })
          : null}
        {shown.map((sug, i) => row(`s${i}`, 'location-outline', sug.label, null, { latitude: sug.latitude, longitude: sug.longitude }))}
        {q.length >= 2 && !searching && !shown.length ? <Text style={[s.rowSub, { paddingVertical: 14 }]}>No places found for “{q}”.</Text> : null}
      </View>

      <View style={s.footer}>
        <LightButton title="Confirm area" onPress={() => onConfirm(picked.point)} loading={saving} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(24,24,27,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 24, paddingTop: 10, paddingBottom: 28, maxHeight: '88%' },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: c.track, marginBottom: 20 },
  map: { height: 168, borderRadius: 20, overflow: 'hidden' },
  badge: { position: 'absolute', top: 12, left: 12, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: c.surface },
  badgeText: { color: c.text, fontSize: 12, fontWeight: '700', letterSpacing: 1.2 },
  title: { color: c.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.3, marginTop: 22 },
  body: { color: c.textSecondary, fontSize: 16, lineHeight: 23, marginTop: 8, marginBottom: 24 },
  notNow: { flex: 1, minHeight: 56, borderRadius: 16, backgroundColor: c.soft, alignItems: 'center', justifyContent: 'center' },
  notNowText: { color: c.textLabel, fontSize: 16, fontWeight: '600' },
  search: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 16, borderRadius: lr.field, backgroundColor: c.soft, marginTop: 18 },
  searchInput: { flex: 1, color: c.text, fontSize: 16, paddingVertical: 12 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  rowDivider: { borderTopWidth: 1, borderTopColor: c.border },
  rowIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: c.soft, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { color: c.text, fontSize: 17, fontWeight: '500' },
  rowSub: { color: c.textSecondary, fontSize: 14, marginTop: 2 },
  footer: { marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.border },
});
