import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, Vibration, View } from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { KeyboardAwareScrollView, RevealingTextInput } from '../components/KeyboardAware';
import { Screen } from '../components/Kit';
import { type McName } from '../components/Premium';
import { LightButton, LightError } from '../components/LightKit';
import EircodeScanner from '../components/scan/EircodeScanner';
import BarcodeSheet from '../components/scan/BarcodeSheet';
import { DuplicatePrompt } from '../components/StopPrompts';
import ConfirmStop from '../components/scan/ConfirmStop';
import PinSheet, { type PinResult } from '../components/PinSheet';
import ImportSheet from '../components/ImportSheet';
import StopLines from '../components/StopLines';
import { get, post, del, ApiRequestError } from '../lib/api';
import { getRouteOrigin } from '../lib/location';
import { checkAddress, createStop, DuplicateStopError } from '../lib/stops';
import { findDuplicate, type Duplicate } from '../lib/duplicates';
import { NATIVE_BUILD_HINT, loadVoicePanel } from '../lib/optionalNative';
import { dayLabel, isOnlyEircode, normalizeEircodes } from '../lib/format';
import type { AddressSuggestion, Delivery } from '../lib/types';
import { useAuth } from '../lib/auth';
import { useFocusEffect } from '../lib/useFocusEffect';
import { useNav } from '../lib/nav';
import { light as c, lightRadius as lr } from '../lib/theme';

type Point = { latitude: number; longitude: number };
type Sheet = 'scan' | 'barcode' | 'pin' | 'import' | null;

const VoicePanel = loadVoicePanel();
const SUGGEST_DELAY_MS = 350;

// Step 2 of Add route: add stops as fast as possible. Each stop is saved straight away (for the route's day), so nothing is lost.
// With `routeId` (Edit stops on a planned route), that route's stops are on the list too, and Review plans it again.
export default function AddStops({ name, date, routeId }: { name: string; date: string; routeId?: string }) {
  const { navigate, goBack } = useNav();
  const { user } = useAuth();
  const addressRef = useRef<TextInput>(null);
  const [stops, setStops] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [origin, setOrigin] = useState<Point | null>(null);

  const [address, setAddress] = useState('');
  const [parcel, setParcel] = useState('');
  // The exact location the rider chose (a suggestion or a pin) for the current address text.
  const [picked, setPicked] = useState<{ label: string; approximate?: boolean } & Point | null>(null);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  // Set when Add found no exact match: the rider picks a suggestion, pins it, or adds it anyway.
  const [unsure, setUnsure] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [voice, setVoice] = useState(false);
  const searchId = useRef(0);
  // Which button opened the scanner. The scan icon in the address field only fills in the Eircode; the Scan button
  // (and Rescan / Scan next) opens Confirm stop for the Eircode it read, to add parcel after parcel.
  const scanFor = useRef<'field' | 'batch'>('batch');
  const openScanner = (mode: 'field' | 'batch') => { scanFor.current = mode; setSheet('scan'); };
  // The Eircode Confirm stop is showing (Scan button flow).
  const [confirming, setConfirming] = useState<string | null>(null);
  // A stop that is already on the list: shown instead of adding it, with an explicit "Add anyway".
  const [duplicate, setDuplicate] = useState<{ found: Duplicate<Delivery>; addAnyway: () => void } | null>(null);
  // The rider chose "Add anyway" for the address now in the field (a second parcel for the same door).
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const scrollRef = useRef<FlashListRef<Delivery>>(null);

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
      setStops(all.filter((d) => !d.routeId || (routeId != null && d.routeId === routeId)).reverse());
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load your stops');
    } finally {
      setLoading(false);
    }
  }, [date, routeId]);
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
    // "Add anyway" was for the previous address; a cleared field is no longer the scanned one.
    setAllowDuplicate(false);
    if (picked && text !== picked.label) setPicked(null);
  };

  const choose = (sug: AddressSuggestion) => {
    setAddress(sug.label);
    setPicked({ label: sug.label, latitude: sug.latitude, longitude: sug.longitude, approximate: sug.approximate });
    setSuggestions([]);
    setUnsure(false);
  };

  const reset = (focus = true) => {
    setAddress(''); setParcel(''); setPicked(null); setSuggestions([]); setUnsure(false); setError(''); setAllowDuplicate(false);
    if (focus) setTimeout(() => addressRef.current?.focus(), 50);
  };

  // `normalized` is the address the map found for what was typed (e.g. the street of a place name or an Eircode).
  // `precise` is false for an area-level point, which then never counts as "the same door" as another stop.
  const save = async (raw: string, location: Point | null, { normalized, precise = true, duplicateOk = false }: { normalized?: string | null; precise?: boolean; duplicateOk?: boolean } = {}) => {
    const stop = await createStop({ raw, parcel, date, location, normalized, precise, existing: stops, allowDuplicate: duplicateOk });
    setStops((list) => [...list, stop]);
    Vibration.vibrate(30);
    reset();
  };

  // Adds the stop. Without a chosen suggestion the address is checked first, so riders notice typos now, not on the road.
  const add = async (anyway = false, duplicateOk = allowDuplicate) => {
    // Eircodes are sent as "D01 F5P2" however they were typed ("d01f5p2", "D01-F5P2").
    const raw = normalizeEircodes(address.trim());
    if (raw.length < 5) { setError('Enter the delivery address, a postcode, or drop a pin.'); return; }
    if (parcel.trim() && parcel.trim().length < 3) { setError('Parcel IDs are at least 3 characters. Clear it if there is none.'); return; }
    setAdding(true);
    setError('');
    try {
      if (picked && picked.label === address) { await save(raw, picked, { precise: !picked.approximate, duplicateOk }); return; }
      if (anyway) { await save(raw, null, { duplicateOk }); return; }
      const near = origin || area;
      const check = await checkAddress(raw, near);
      // An Eircode on its own is one building: its point is used even when the map's match is not a rooftop one
      // (the stop then shows "Approximate location").
      if (check.found && (!check.approximate || isOnlyEircode(raw)) && check.latitude != null && check.longitude != null) {
        await save(raw, { latitude: check.latitude, longitude: check.longitude }, { normalized: check.normalized, precise: !check.approximate, duplicateOk });
        return;
      }
      setUnsure(true);
    } catch (err) {
      if (err instanceof DuplicateStopError) {
        setDuplicate({ found: err.duplicate, addAnyway: () => { setAllowDuplicate(true); void add(anyway, true); } });
        return;
      }
      setError(err instanceof ApiRequestError ? err.message : 'Could not add this stop. Check your connection and try again.');
    } finally {
      setAdding(false);
    }
  };

  const remove = useCallback((stop: Delivery) => {
    Alert.alert('Remove this stop?', stop.address.raw, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => {
        del(`/deliveries/${stop.id}`)
          .then(() => setStops((list) => list.filter((d) => d.id !== stop.id)))
          .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Could not remove this stop'));
      } },
    ]);
  }, []);

  const onPin = (pin: PinResult) => {
    setSheet(null);
    setAddress(pin.address);
    setPicked({ label: pin.address, latitude: pin.latitude, longitude: pin.longitude });
    setSuggestions([]);
    setUnsure(false);
  };

  const onVoice = (text: string) => {
    setVoice(false);
    typeAddress(normalizeEircodes(text.trim()));
  };

  // The scanner read an Eircode: the same as typing it into the address field. A stop already on the list is
  // reported straight away, before any map lookup.
  // The Scan button's scan opens Confirm stop instead, which does its own duplicate check and adding.
  const onScanned = (eircode: string) => {
    setSheet(null);
    if (scanFor.current === 'batch') { setConfirming(eircode); return; }
    const fill = () => { typeAddress(eircode); addressRef.current?.blur(); };
    const found = findDuplicate({ eircode }, stops);
    if (found) setDuplicate({ found, addAnyway: () => { fill(); setAllowDuplicate(true); } });
    else fill();
  };

  const typeInstead = () => {
    setSheet(null);
    setTimeout(() => addressRef.current?.focus(), 350);
  };

  const viewStop = (stop: Delivery) => {
    setDuplicate(null);
    const index = stops.findIndex((d) => d.id === stop.id);
    if (index >= 0) void scrollRef.current?.scrollToIndex({ index, animated: true, viewOffset: 120 });
    setHighlight(stop.id);
    setTimeout(() => setHighlight((id) => (id === stop.id ? null : id)), 2500);
  };

  const review = () => navigate('RoutePreview', { name, date, ids: stops.map((d) => d.id) });

  const located = !!picked && picked.label === address;

  return (
    <Screen style={{ backgroundColor: c.background }}>
      {/* Only the stops on screen are drawn; the form above them scrolls with the list and keeps clear of the keyboard. */}
      <FlashList
        ref={scrollRef}
        data={stops}
        keyExtractor={(stop) => stop.id}
        extraData={highlight}
        renderScrollComponent={KeyboardAwareScrollView}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 120 }}
        renderItem={({ item, index }) => <AddedStopRow stop={item} index={index} highlighted={highlight === item.id} onRemove={remove} />}
        ListHeaderComponent={<>
        <View style={s.header}>
          <Pressable onPress={goBack} hitSlop={12} accessibilityLabel="Back">
            <Ionicons name="arrow-back" size={26} color={c.text} />
          </Pressable>
          <View style={{ flex: 1, marginLeft: 18 }}>
            <Text style={s.title}>Add stops</Text>
            {/* Not in the design; kept so the rider can see which route and day the stops go to. */}
            <Text style={s.context} numberOfLines={1}>{name} · {dayLabel(date)}</Text>
          </View>
        </View>

        {/* Address: required. Eircode, street, place name or postcode. */}
        <View style={[s.field, located && { borderColor: c.success }]}>
          <Ionicons name={located ? 'location' : 'search'} size={22} color={located ? c.success : c.textSecondary} />
          <RevealingTextInput
            ref={addressRef} value={address} onChangeText={typeAddress} placeholder="Eircode or address" placeholderTextColor={c.placeholder}
            style={s.input} autoFocus multiline blurOnSubmit returnKeyType="done" onSubmitEditing={() => void add()}
          />
          {searching && wantSuggestions ? <ActivityIndicator size="small" color={c.textSecondary} /> : address ? (
            <Pressable onPress={() => typeAddress('')} hitSlop={8} accessibilityLabel="Clear"><Ionicons name="close-circle" size={20} color={c.placeholder} /></Pressable>
          ) : null}
          <Pressable onPress={() => openScanner('field')} hitSlop={8} accessibilityLabel="Scan the Eircode into this field"><MaterialCommunityIcons name="line-scan" size={24} color={c.link} /></Pressable>
        </View>

        {shownSuggestions.length ? (
          <View style={s.suggestions}>
            {shownSuggestions.map((sug, i) => (
              <Pressable key={`${sug.latitude},${sug.longitude}`} onPress={() => choose(sug)} style={({ pressed }) => [s.suggestion, i > 0 && s.divider, pressed && { backgroundColor: c.soft }]}>
                <MaterialCommunityIcons name={sug.approximate ? 'map-marker-question-outline' : 'map-marker-check-outline'} size={20} color={sug.approximate ? c.warning : c.success} />
                <Text style={{ flex: 1, color: c.text, fontSize: 15 }} numberOfLines={2}>{sug.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {unsure ? (
          <View style={s.unsure}>
            <MaterialCommunityIcons name="map-marker-alert-outline" size={20} color={c.warning} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.text, fontWeight: '600', fontSize: 15 }}>We couldn&apos;t pin this address exactly</Text>
              <Text style={{ color: c.textSecondary, fontSize: 14, marginTop: 2 }}>Pick a suggestion above, drop a pin, or add it as typed.</Text>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <SmallButton icon="map-marker-plus-outline" label="Drop pin" onPress={() => setSheet('pin')} />
                <SmallButton icon="plus" label="Add anyway" onPress={() => void add(true)} />
              </View>
            </View>
          </View>
        ) : null}

        {/* Not in the design: once an address is in the field, the optional parcel ID and Add stop appear under it. */}
        {address ? (
          <>
            <View style={[s.field, s.parcel]}>
              <MaterialCommunityIcons name="barcode" size={20} color={c.textSecondary} />
              <RevealingTextInput value={parcel} onChangeText={setParcel} placeholder="Parcel ID (optional)" placeholderTextColor={c.placeholder}
                style={s.input} autoCapitalize="characters" autoCorrect={false} maxLength={80} returnKeyType="done" onSubmitEditing={() => void add()} />
              <Pressable onPress={() => setSheet('barcode')} hitSlop={8} accessibilityLabel="Scan the parcel barcode"><MaterialCommunityIcons name="barcode-scan" size={22} color={c.link} /></Pressable>
            </View>
            <LightButton title="Add stop" icon={<Ionicons name="add" size={22} color={c.onInk} />} onPress={() => void add()} loading={adding} disabled={address.trim().length < 5} style={{ marginTop: 12 }} />
          </>
        ) : null}
        {error ? <View style={{ marginTop: 12 }}><LightError text={error} /></View> : null}

        <View style={s.modes}>
          <Mode icon="line-scan" label="Scan" onPress={() => openScanner('batch')} />
          <Mode icon="microphone-outline" label="Voice" active={voice} onPress={() => setVoice((v) => !v)} />
          <Mode icon="map-marker-outline" label="Pin" onPress={() => setSheet('pin')} />
          <Mode icon="file-download-outline" label="Import" onPress={() => setSheet('import')} />
        </View>

        {voice ? (
          <View style={s.voice}>
            {VoicePanel ? <VoicePanel compact onText={onVoice} /> : (
              <Text style={{ color: c.textSecondary, fontSize: 14, lineHeight: 20, textAlign: 'center' }}>Voice input is unavailable here. {NATIVE_BUILD_HINT}</Text>
            )}
            <Text style={{ color: c.placeholder, fontSize: 13, textAlign: 'center', marginTop: 6 }}>Say the street and number, the town, or the postcode.</Text>
          </View>
        ) : null}

        <View style={s.rule} />

        {/* Stops added so far */}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
          <Text style={s.section}>Stops · {stops.length}</Text>
          {loading ? <ActivityIndicator size="small" color={c.textSecondary} style={{ marginLeft: 10 }} /> : null}
        </View>
        {!loading && !stops.length ? <Text style={{ color: c.textSecondary, fontSize: 15, marginTop: 8 }}>No stops yet. Your first stop will appear here.</Text> : null}
        </>}
      />

      <View style={s.footer}>
        <LightButton title={stops.length ? `Review ${stops.length} stop${stops.length === 1 ? '' : 's'}` : 'Add a stop to continue'} onPress={review} disabled={!stops.length} />
      </View>

      <EircodeScanner visible={sheet === 'scan'} onEircode={onScanned} onTypeInstead={typeInstead} onClose={() => setSheet(null)} />
      <DuplicatePrompt duplicate={duplicate?.found ?? null} onView={() => duplicate && viewStop(duplicate.found.stop)}
        onAddAnyway={() => { const next = duplicate?.addAnyway; setDuplicate(null); next?.(); }} onCancel={() => setDuplicate(null)} />
      <ConfirmStop eircode={confirming} date={date} near={origin || area} existing={stops}
        onAdded={(stop) => { setStops((list) => [...list, stop]); Vibration.vibrate(30); }}
        onRescan={() => { setConfirming(null); openScanner('batch'); }}
        onViewStop={(stop) => { setConfirming(null); viewStop(stop); }}
        onClose={() => setConfirming(null)} />
      <BarcodeSheet visible={sheet === 'barcode'} onClose={() => setSheet(null)} onResult={(value) => { setSheet(null); setParcel(value); }} />
      <PinSheet visible={sheet === 'pin'} position={origin} center={picked || area} onClose={() => setSheet(null)} onPick={onPin} />
      <ImportSheet visible={sheet === 'import'} date={date} stops={stops} onClose={() => setSheet(null)} onImported={(created) => { setSheet(null); setStops((list) => [...list, ...created]); }} />
    </Screen>
  );
}

function Mode({ icon, label, active, onPress }: { icon: McName; label: string; active?: boolean; onPress: () => void }) {
  const color = active ? c.link : c.text;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.mode, pressed && { opacity: 0.6 }]} accessibilityRole="button" accessibilityState={{ selected: !!active }}>
      <MaterialCommunityIcons name={icon} size={28} color={color} />
      <Text style={{ color, fontSize: 15, fontWeight: '500', marginTop: 8 }}>{label}</Text>
    </Pressable>
  );
}

function SmallButton({ icon, label, onPress }: { icon: McName; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.small, pressed && { opacity: 0.85 }]}>
      <MaterialCommunityIcons name={icon} size={16} color={c.text} />
      <Text style={{ color: c.text, fontWeight: '600', fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}

/** One added stop. Memoised: adding a stop or typing above does not redraw the rows already there. */
const AddedStopRow = memo(function AddedStopRow({ stop, index, highlighted, onRemove }: {
  stop: Delivery; index: number; highlighted: boolean; onRemove: (stop: Delivery) => void;
}) {
  return (
    <View style={[s.stop, index > 0 && s.stopDivider, highlighted && s.stopHighlight]}>
      <View style={s.badge}><Text style={{ color: c.text, fontWeight: '600', fontSize: 16 }}>{index + 1}</Text></View>
      <View style={{ flex: 1, marginLeft: 14, marginRight: 8 }}>
        <StopLines stop={stop} light />
      </View>
      <Pressable onPress={() => onRemove(stop)} hitSlop={10} accessibilityLabel="Remove stop"><Ionicons name="trash-outline" size={22} color={c.textSecondary} /></Pressable>
    </View>
  );
});

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 24 },
  title: { color: c.text, fontSize: 24, fontWeight: '700' },
  context: { color: c.textSecondary, fontSize: 13, marginTop: 2 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 16, borderRadius: lr.field, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
  parcel: { marginTop: 10, minHeight: 48 },
  input: { flex: 1, color: c.text, fontSize: 17, paddingVertical: 12 },
  suggestions: { marginTop: 8, borderRadius: lr.field, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, overflow: 'hidden' },
  suggestion: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  divider: { borderTopWidth: 1, borderTopColor: c.border },
  unsure: { flexDirection: 'row', gap: 10, marginTop: 10, padding: 14, borderRadius: lr.field, backgroundColor: c.warningBg },
  small: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  modes: { flexDirection: 'row', marginTop: 24 },
  mode: { flex: 1, alignItems: 'center', paddingVertical: 4 },
  voice: { marginTop: 16, padding: 14, borderRadius: lr.field, backgroundColor: c.soft },
  rule: { height: 1, backgroundColor: c.border, marginTop: 24, marginBottom: 24 },
  section: { color: c.text, fontSize: 19, fontWeight: '600' },
  stop: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 18 },
  stopDivider: { borderTopWidth: 1, borderTopColor: c.border },
  stopHighlight: { backgroundColor: c.linkBg, marginHorizontal: -12, paddingHorizontal: 12, borderRadius: 12 },
  badge: { width: 28, height: 28, borderRadius: 14, backgroundColor: c.soft, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 24, paddingTop: 12, paddingBottom: 14, backgroundColor: c.background, borderTopWidth: 1, borderTopColor: c.border },
});
