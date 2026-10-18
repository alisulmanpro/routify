import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, Vibration, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { KeyboardAwareScrollView, RevealingTextInput } from '../components/KeyboardAware';
import { Screen } from '../components/Kit';
import { DARK_ON_PRIMARY, ErrorBanner, Header, PButton, type McName } from '../components/Premium';
import ScanSheet, { type ScanResult } from '../components/ScanSheet';
import PinSheet, { type PinResult } from '../components/PinSheet';
import ImportSheet from '../components/ImportSheet';
import { get, post, del, ApiRequestError } from '../lib/api';
import { getRouteOrigin } from '../lib/location';
import { NATIVE_BUILD_HINT, loadVoicePanel } from '../lib/optionalNative';
import { dayLabel, stopLabel } from '../lib/format';
import type { AddressSuggestion, Delivery } from '../lib/types';
import { useAuth } from '../lib/auth';
import { useFocusEffect } from '../lib/useFocusEffect';
import { useNav } from '../lib/nav';
import { premium as c, premiumRadius as r } from '../lib/theme';

type Point = { latitude: number; longitude: number };
type Sheet = 'scan' | 'scanAddress' | 'barcode' | 'pin' | 'import' | null;
type GeocodeCheck = { found: boolean; approximate: boolean; latitude: number | null; longitude: number | null; normalized: string | null };

const VoicePanel = loadVoicePanel();
const SUGGEST_DELAY_MS = 350;

// Step 2 of Add route: add stops as fast as possible. Each stop is saved straight away (for the route's day), so nothing is lost.
export default function AddStops({ name, date }: { name: string; date: string }) {
  const { navigate } = useNav();
  const { user } = useAuth();
  const addressRef = useRef<TextInput>(null);
  const [stops, setStops] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [origin, setOrigin] = useState<Point | null>(null);

  const [address, setAddress] = useState('');
  const [parcel, setParcel] = useState('');
  // The exact location the rider chose (a suggestion or a pin) for the current address text.
  const [picked, setPicked] = useState<{ label: string } & Point | null>(null);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  // Set when Add found no exact match: the rider picks a suggestion, pins it, or adds it anyway.
  const [unsure, setUnsure] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [voice, setVoice] = useState(false);
  const searchId = useRef(0);

  const area = user?.serviceArea ? { latitude: user.serviceArea.latitude, longitude: user.serviceArea.longitude } : null;

  // Stops already added but not on a route yet (e.g. the rider left this screen earlier) belong to this route too.
  const load = useCallback(async () => {
    try {
      const all: Delivery[] = [];
      for (let page = 1; page <= 3; page++) {
        const res = await get<Delivery[]>('/deliveries', { status: 'pending', date, limit: 100, page, sort: 'recent' });
        all.push(...res.data);
        if (!res.meta || page >= res.meta.pages) break;
      }
      setStops(all.filter((d) => !d.routeId).reverse());
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load your stops');
    } finally {
      setLoading(false);
    }
  }, [date]);
  useFocusEffect(useCallback(() => { void load(); void getRouteOrigin().then(setOrigin); }, [load]));

  // Suggestions follow the typing, a moment after the rider pauses. They are hidden once a location is chosen.
  const query = address.trim();
  const wantSuggestions = query.length >= 3 && !(picked && picked.label === address);
  useEffect(() => {
    if (!wantSuggestions) return;
    const id = ++searchId.current;
    const timer = setTimeout(() => {
      setSearching(true);
      const near = origin || area;
      post<AddressSuggestion[]>('/deliveries/geocode-suggest', { query, ...(near || {}) })
        .then((res) => { if (id === searchId.current) setSuggestions(res.data); })
        .catch(() => { if (id === searchId.current) setSuggestions([]); })
        .finally(() => { if (id === searchId.current) setSearching(false); });
    }, SUGGEST_DELAY_MS);
    return () => clearTimeout(timer);
    // area is derived from the user; origin changes at most once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, wantSuggestions, origin]);
  const shownSuggestions = wantSuggestions ? suggestions : [];

  const typeAddress = (text: string) => {
    setAddress(text);
    setUnsure(false);
    if (picked && text !== picked.label) setPicked(null);
  };

  const choose = (sug: AddressSuggestion) => {
    setAddress(sug.label);
    setPicked({ label: sug.label, latitude: sug.latitude, longitude: sug.longitude });
    setSuggestions([]);
    setUnsure(false);
  };

  const reset = () => {
    setAddress(''); setParcel(''); setPicked(null); setSuggestions([]); setUnsure(false); setError('');
    setTimeout(() => addressRef.current?.focus(), 50);
  };

  const save = async (raw: string, location: Point | null) => {
    const res = await post<Delivery>('/deliveries/manual', {
      trackingId: parcel.trim().toUpperCase(),
      address: { raw },
      serviceDate: date,
      ...(location ? { location } : {}),
    });
    setStops((list) => [...list, res.data]);
    Vibration.vibrate(30);
    reset();
  };

  // Adds the stop. Without a chosen suggestion the address is checked first, so riders notice typos now, not on the road.
  const add = async (anyway = false) => {
    const raw = address.trim();
    if (raw.length < 5) { setError('Enter the delivery address, a postcode, or drop a pin.'); return; }
    if (parcel.trim() && parcel.trim().length < 3) { setError('Parcel IDs are at least 3 characters. Clear it if there is none.'); return; }
    setAdding(true);
    setError('');
    try {
      if (picked && picked.label === address) { await save(raw, picked); return; }
      if (anyway) { await save(raw, null); return; }
      const near = origin || area;
      const check = (await post<GeocodeCheck>('/deliveries/geocode-check', { address: raw, ...(near || {}) })).data;
      if (check.found && !check.approximate && check.latitude != null && check.longitude != null) {
        await save(raw, { latitude: check.latitude, longitude: check.longitude });
        return;
      }
      setUnsure(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not add this stop. Check your connection and try again.');
    } finally {
      setAdding(false);
    }
  };

  const remove = (stop: Delivery) => {
    Alert.alert('Remove this stop?', stop.address.raw, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => {
        del(`/deliveries/${stop.id}`)
          .then(() => setStops((list) => list.filter((d) => d.id !== stop.id)))
          .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Could not remove this stop'));
      } },
    ]);
  };

  const onScan = (result: ScanResult) => {
    setSheet(null);
    if (result.parcel) setParcel(result.parcel);
    if (result.address) typeAddress(result.address);
  };

  const onPin = (pin: PinResult) => {
    setSheet(null);
    setAddress(pin.address);
    setPicked({ label: pin.address, latitude: pin.latitude, longitude: pin.longitude });
    setSuggestions([]);
    setUnsure(false);
  };

  const onVoice = (text: string) => {
    setVoice(false);
    typeAddress(text.trim());
  };

  const review = () => navigate('RoutePreview', { name, date, ids: stops.map((d) => d.id) });

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <KeyboardAwareScrollView contentContainerStyle={{ padding: 18, paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
        <Header eyebrow={`${name} · ${dayLabel(date)}`} eyebrowIcon="map-marker-path" title="Add stops" subtitle="Type, scan, speak or pin each address, then tap Add stop. Repeat for every stop." />

        <View style={s.modes}>
          <Mode icon="line-scan" label="Scan" onPress={() => setSheet('scan')} />
          <Mode icon="microphone-outline" label="Voice" active={voice} onPress={() => setVoice((v) => !v)} />
          <Mode icon="map-marker-plus-outline" label="Pin" onPress={() => setSheet('pin')} />
          <Mode icon="file-upload-outline" label="Import" onPress={() => setSheet('import')} />
        </View>

        {voice ? (
          <View style={s.voice}>
            {VoicePanel ? <VoicePanel compact onText={onVoice} /> : (
              <Text style={{ color: c.textSecondary, fontSize: 12, lineHeight: 17, textAlign: 'center' }}>Voice input is unavailable here. {NATIVE_BUILD_HINT}</Text>
            )}
            <Text style={{ color: c.textMuted, fontSize: 11, textAlign: 'center', marginTop: 4 }}>Say the street and number, the town, or the postcode.</Text>
          </View>
        ) : null}

        {/* Address: required. Street, place name or postcode. */}
        <View style={[s.field, picked && picked.label === address && { borderColor: c.success }]}>
          <Ionicons name={picked && picked.label === address ? 'location' : 'location-outline'} size={18} color={picked && picked.label === address ? c.success : c.primary} />
          <RevealingTextInput
            ref={addressRef} value={address} onChangeText={typeAddress} placeholder="Address, place or postcode" placeholderTextColor={c.textMuted}
            style={s.input} autoFocus multiline blurOnSubmit returnKeyType="done" onSubmitEditing={() => void add()}
          />
          {searching && wantSuggestions ? <ActivityIndicator size="small" color={c.primary} /> : address ? (
            <Pressable onPress={() => typeAddress('')} hitSlop={8}><Ionicons name="close-circle" size={18} color={c.textMuted} /></Pressable>
          ) : null}
          <Pressable onPress={() => setSheet('scanAddress')} hitSlop={8} accessibilityLabel="Scan the address"><MaterialCommunityIcons name="line-scan" size={20} color={c.primary} /></Pressable>
        </View>

        {shownSuggestions.length ? (
          <View style={s.suggestions}>
            {shownSuggestions.map((sug, i) => (
              <Pressable key={`${sug.latitude},${sug.longitude}`} onPress={() => choose(sug)} style={({ pressed }) => [s.suggestion, i > 0 && s.divider, pressed && { backgroundColor: c.surfaceSoft }]}>
                <MaterialCommunityIcons name={sug.approximate ? 'map-marker-question-outline' : 'map-marker-check-outline'} size={18} color={sug.approximate ? c.warning : c.success} />
                <Text style={{ flex: 1, color: c.text, fontSize: 13 }} numberOfLines={2}>{sug.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {unsure ? (
          <View style={s.unsure}>
            <MaterialCommunityIcons name="map-marker-alert-outline" size={18} color={c.warning} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.text, fontWeight: '700', fontSize: 13 }}>We couldn&apos;t pin this address exactly</Text>
              <Text style={{ color: c.textSecondary, fontSize: 12, marginTop: 2 }}>Pick a suggestion above, drop a pin, or add it as typed.</Text>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                <SmallButton icon="map-marker-plus-outline" label="Drop pin" onPress={() => setSheet('pin')} />
                <SmallButton icon="plus" label="Add anyway" onPress={() => void add(true)} />
              </View>
            </View>
          </View>
        ) : null}

        {/* Parcel ID: optional. */}
        <View style={[s.field, { marginTop: 10, minHeight: 46 }]}>
          <MaterialCommunityIcons name="barcode" size={18} color={c.textSecondary} />
          <RevealingTextInput value={parcel} onChangeText={setParcel} placeholder="Parcel ID (optional)" placeholderTextColor={c.textMuted}
            style={s.input} autoCapitalize="characters" autoCorrect={false} maxLength={80} returnKeyType="done" onSubmitEditing={() => void add()} />
          <Pressable onPress={() => setSheet('barcode')} hitSlop={8}><MaterialCommunityIcons name="barcode-scan" size={20} color={c.primary} /></Pressable>
        </View>

        <ErrorBanner text={error} />
        <PButton title="Add stop" icon="add-circle" onPress={() => void add()} loading={adding} disabled={address.trim().length < 5} style={{ marginTop: 12 }} />

        {/* Stops added so far */}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 24, marginBottom: 8 }}>
          <Text style={s.section}>STOPS · {stops.length}</Text>
          {loading ? <ActivityIndicator size="small" color={c.primary} style={{ marginLeft: 8 }} /> : null}
        </View>
        {!loading && !stops.length ? <Text style={{ color: c.textMuted, fontSize: 13 }}>No stops yet. Your first stop will appear here.</Text> : null}
        {stops.map((stop, i) => (
          <View key={stop.id} style={s.stop}>
            <View style={s.badge}><Text style={{ color: c.text, fontWeight: '800', fontSize: 12 }}>{i + 1}</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.text, fontWeight: '700', fontSize: 14 }} numberOfLines={1}>{stopLabel(stop)}</Text>
              <Text style={{ color: c.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={2}>{stop.address.raw}</Text>
              <LocationTag stop={stop} />
            </View>
            <Pressable onPress={() => remove(stop)} hitSlop={10}><Ionicons name="trash-outline" size={18} color={c.textMuted} /></Pressable>
          </View>
        ))}
      </KeyboardAwareScrollView>

      <View style={s.footer}>
        <PButton title={stops.length ? `Done · review ${stops.length} stop${stops.length === 1 ? '' : 's'}` : 'Add a stop to continue'} icon="checkmark-done"
          onPress={review} disabled={!stops.length} chevron />
      </View>

      <ScanSheet visible={sheet === 'scan' || sheet === 'scanAddress' || sheet === 'barcode'} mode={sheet === 'barcode' ? 'barcode' : sheet === 'scanAddress' ? 'address' : 'label'}
        onClose={() => setSheet(null)} onResult={onScan} />
      <PinSheet visible={sheet === 'pin'} position={origin} center={picked || area} onClose={() => setSheet(null)} onPick={onPin} />
      <ImportSheet visible={sheet === 'import'} date={date} onClose={() => setSheet(null)} onImported={(created) => { setSheet(null); setStops((list) => [...list, ...created]); }} />
    </Screen>
  );
}

function Mode({ icon, label, active, onPress }: { icon: McName; label: string; active?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.mode, active && s.modeOn, pressed && { opacity: 0.85 }]}>
      <MaterialCommunityIcons name={icon} size={22} color={active ? DARK_ON_PRIMARY : c.primary} />
      <Text style={{ color: active ? DARK_ON_PRIMARY : c.text, fontSize: 11, fontWeight: '800', marginTop: 4 }}>{label}</Text>
    </Pressable>
  );
}

function SmallButton({ icon, label, onPress }: { icon: McName; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.small, pressed && { opacity: 0.85 }]}>
      <MaterialCommunityIcons name={icon} size={14} color={c.primary} />
      <Text style={{ color: c.primary, fontWeight: '800', fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

function LocationTag({ stop }: { stop: Delivery }) {
  const status = stop.address.geocodeStatus;
  const [icon, color, text]: [McName, string, string] = status === 'found' ? ['map-marker-check', c.success, 'Location confirmed']
    : status === 'approximate' ? ['map-marker-question', c.warning, 'Approximate location']
      : status === 'not_found' ? ['map-marker-off', c.danger, 'Not found on the map'] : ['map-marker-outline', c.textMuted, 'Located when the route is planned'];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
      <MaterialCommunityIcons name={icon} size={12} color={color} />
      <Text style={{ color, fontSize: 11, fontWeight: '600' }}>{text}{stop.trackingId ? `  ·  ${stop.trackingId}` : ''}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  modes: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  mode: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: r.medium, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  modeOn: { backgroundColor: c.primary, borderColor: c.primary },
  voice: { marginBottom: 12, padding: 12, borderRadius: r.medium, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 54, paddingHorizontal: 14, borderRadius: r.medium, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceSoft },
  input: { flex: 1, color: c.text, fontSize: 15, paddingVertical: 12 },
  suggestions: { marginTop: 6, borderRadius: r.medium, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, overflow: 'hidden' },
  suggestion: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  divider: { borderTopWidth: 1, borderTopColor: c.divider },
  unsure: { flexDirection: 'row', gap: 10, marginTop: 8, padding: 12, borderRadius: r.medium, backgroundColor: 'rgba(255,179,64,0.1)', borderWidth: 1, borderColor: 'rgba(255,179,64,0.3)' },
  small: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 7, borderRadius: r.pill, backgroundColor: 'rgba(255,170,50,0.14)' },
  section: { color: c.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  stop: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, marginBottom: 8, borderRadius: r.medium, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  badge: { width: 28, height: 28, borderRadius: 14, backgroundColor: c.surfaceSoft, borderWidth: 1.5, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 14, backgroundColor: 'rgba(5,11,24,0.96)', borderTopWidth: 1, borderTopColor: c.border },
});
