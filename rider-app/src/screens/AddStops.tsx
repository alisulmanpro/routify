import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, Vibration, View } from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { KeyboardAwareScrollView, RevealingTextInput } from '../components/KeyboardAware';
import { Screen } from '../components/Kit';
import { type McName } from '../components/Premium';
import { LightButton, LightError } from '../components/LightKit';
import EircodeScanner from '../components/scan/EircodeScanner';
import EircodeSheetScan from '../components/scan/EircodeSheetScan';
import BarcodeSheet from '../components/scan/BarcodeSheet';
import { DuplicatePrompt } from '../components/StopPrompts';
import ConfirmStop from '../components/scan/ConfirmStop';
import PinSheet, { type PinResult } from '../components/PinSheet';
import ImportSheet from '../components/ImportSheet';
import StopLines from '../components/StopLines';
import { get, del, ApiRequestError } from '../lib/api';
import { getRouteOrigin } from '../lib/location';
import { checkAddress, createStop, DuplicateStopError } from '../lib/stops';
import { forgetPendingStop, outboxFor, pendingStops, refusedStops, retryRefusedStops } from '../lib/outbox';
import { findDuplicate, type Duplicate } from '../lib/duplicates';
import { NATIVE_BUILD_HINT, loadVoicePanel } from '../lib/optionalNative';
import { dayLabel, isOnlyEircode, normalizeEircodes } from '../lib/format';
import type { Delivery } from '../lib/types';
import { newPlaceSession, pickPlace, searchPlaces, type PlaceSuggestion } from '../lib/places';
import { expandForSearch, issueText, rankSuggestions, suggestionIssues } from '../lib/scan/address';
import type { PickedAddress } from '../lib/scan/photoLines';
import { voiceToAddress } from '../lib/voice';
import { useAuth } from '../lib/auth';
import { useFocusEffect } from '../lib/useFocusEffect';
import { useNav } from '../lib/nav';
import { light as c, lightRadius as lr } from '../lib/theme';

type Point = { latitude: number; longitude: number };
type Sheet = 'scan' | 'sheet' | 'barcode' | 'pin' | 'import' | null;

const VoicePanel = loadVoicePanel();
// Suggestions wait for a pause in typing and a few characters: every request is a billed lookup (P3.8).
const SUGGEST_DELAY_MS = 500;
const SUGGEST_MIN_CHARS = 4;

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
  const [picked, setPicked] = useState<{ label: string; approximate?: boolean; normalized?: string | null } & Point | null>(null);
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  // One Google billing session per address typed (P5.1): renewed after a pick or when the field is cleared.
  const placeSession = useRef(newPlaceSession());
  const [searching, setSearching] = useState(false);
  // Set when Add found no exact match: the rider picks a suggestion, pins it, or adds it anyway.
  const [unsure, setUnsure] = useState(false);
  // With `unsure`: the address the map found when it is on a different street type or house number.
  const [mapFound, setMapFound] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [voice, setVoice] = useState(false);
  // Eircodes picked from a photo of a sheet: Import checks and adds them (null when Import reads a file).
  const [sheetCodes, setSheetCodes] = useState<string[] | null>(null);
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
  // The server refused stops added here (they stay on the phone): why, e.g. SUBSCRIPTION_REQUIRED without a plan.
  const [refused, setRefused] = useState<{ error: string; code: string | null } | null>(null);
  const scrollRef = useRef<FlashListRef<Delivery>>(null);

  const area = user?.serviceArea ? { latitude: user.serviceArea.latitude, longitude: user.serviceArea.longitude } : null;

  // Stops already added but not on a route yet (e.g. the rider left this screen earlier) belong to this route too.
  // Stops added offline and not sent yet (P4.1) are listed with them, flagged pending_sync.
  const load = useCallback(async () => {
    let saved: Delivery[] | null = null;
    try {
      const all: Delivery[] = [];
      for (let page = 1; page <= 3; page++) {
        const res = await get<Delivery[]>('/deliveries', { status: 'pending', date, limit: 100, page, sort: 'recent' });
        all.push(...res.data);
        if (!res.meta || page >= res.meta.pages) break;
      }
      saved = all.filter((d) => !d.routeId || (routeId != null && d.routeId === routeId)).reverse();
    } catch (err) {
      // Offline: the list on screen stays; only an answer from the server is an error worth showing.
      if (!(err instanceof TypeError)) setError(err instanceof ApiRequestError ? err.message : 'Could not load your stops');
    } finally {
      const waiting = await pendingStops(date).catch(() => []);
      setRefused(await refusedStops(date).catch(() => null));
      setStops((list) => {
        const base = saved ?? list.filter((d) => !d.flags.includes('pending_sync'));
        const ids = new Set(base.map((d) => d.id));
        return [...base, ...waiting.filter((d) => !ids.has(d.id))];
      });
      setLoading(false);
    }
  }, [date, routeId]);
  // Reload when stops waiting on the phone have been sent (they get their server ids).
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    const outbox = outboxFor(userId);
    let waiting = -1;
    return outbox.subscribe(() => {
      void outbox.summary().then((now) => {
        if (!now.sending && waiting >= 0 && now.waiting < waiting) void load();
        if (!now.sending) waiting = now.waiting;
      });
    });
  }, [userId, load]);
  // Coming back (e.g. from starting a plan): stops the server refused are sent again, then the list reloads.
  useFocusEffect(useCallback(() => { void retryRefusedStops(date).catch(() => {}).finally(() => { void load(); }); void getRouteOrigin().then(setOrigin); }, [load, date]));

  // Suggestions follow the typing, a moment after the rider pauses. They are hidden once a location is chosen.
  const query = address.trim();
  const wantSuggestions = query.length >= SUGGEST_MIN_CHARS && !(picked && picked.label === address);
  useEffect(() => {
    if (!wantSuggestions) return;
    const id = ++searchId.current;
    // A newer search cancels this one, also when it is already on its way.
    const cancel = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      const near = origin || area;
      // Places Autocomplete only (no Geocoding per keystroke, P5.2); the point is asked for once, on pick.
      // Short forms are written out for the search ("cre" → "Crescent"): the field keeps what the rider typed.
      searchPlaces(expandForSearch(query), placeSession.current, near, cancel.signal)
        .then((found) => { if (id === searchId.current) setSuggestions(found); })
        .catch(() => { if (id === searchId.current) setSuggestions([]); })
        .finally(() => { if (id === searchId.current) setSearching(false); });
    }, SUGGEST_DELAY_MS);
    return () => { clearTimeout(timer); cancel.abort(); };
    // area is derived from the user; origin changes at most once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, wantSuggestions, origin]);
  // A suggestion on a different street type ("Park" for "Grove") or house number goes to the end, marked: the rider
  // can still pick it (the label may be the one that is wrong), but never by tapping the top one without looking.
  const shownSuggestions = wantSuggestions ? rankSuggestions(query, suggestions, (sug) => sug.label) : [];

  const typeAddress = (text: string) => {
    setAddress(text);
    setUnsure(false);
    // "Add anyway" was for the previous address; a cleared field is no longer the scanned one.
    setAllowDuplicate(false);
    if (picked && text !== picked.label) setPicked(null);
  };

  const choose = async (sug: PlaceSuggestion) => {
    setAddress(sug.label);
    setSuggestions([]);
    setUnsure(false);
    try {
      setSearching(true);
      const point = await pickPlace(sug, placeSession.current);
      if (!point) { setError('Could not find that address on the map. Try another suggestion or drop a pin.'); return; }
      setPicked({ label: sug.label, latitude: point.latitude, longitude: point.longitude, approximate: point.approximate, normalized: point.normalized });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not look that address up. Check your connection and try again.');
    } finally {
      setSearching(false);
      placeSession.current = newPlaceSession();
    }
  };

  const reset = (focus = true) => {
    setAddress(''); setParcel(''); setPicked(null); setSuggestions([]); setUnsure(false); setError(''); setAllowDuplicate(false);
    placeSession.current = newPlaceSession();
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
      if (picked && picked.label === address) { await save(raw, picked, { normalized: picked.normalized, precise: !picked.approximate, duplicateOk }); return; }
      if (anyway) { await save(raw, null, { duplicateOk }); return; }
      const near = origin || area;
      const check = await checkAddress(isOnlyEircode(raw) ? raw : expandForSearch(raw), near);
      // The map found a different street type or house number ("26 Shanecastle Park" for "26 Shanecastle Grove"):
      // not saved on its own, the rider picks a suggestion, drops a pin or adds it as typed.
      const differs = !!check.normalized && suggestionIssues(raw, check.normalized).length > 0;
      // An Eircode on its own is one building: its point is used even when the map's match is not a rooftop one
      // (the stop then shows "Approximate location").
      if (check.found && !differs && (!check.approximate || isOnlyEircode(raw)) && check.latitude != null && check.longitude != null) {
        await save(raw, { latitude: check.latitude, longitude: check.longitude }, { normalized: check.normalized, precise: !check.approximate, duplicateOk });
        return;
      }
      setMapFound(differs ? check.normalized : null);
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
        // Never sent: it only has to leave the phone's outbox.
        if (stop.flags.includes('pending_sync')) {
          void forgetPendingStop(stop.id).then(() => setStops((list) => list.filter((d) => d.id !== stop.id)));
          return;
        }
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
    // An Eircode said character by character comes back in pieces ("P1 2 FY 70"): joined into one code first.
    typeAddress(normalizeEircodes(voiceToAddress(text.trim())));
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

  // The Address scan: the lines the rider tapped. One Eircode among them goes the Eircode way (the surest point);
  // otherwise the text fills the address field, where the suggestions and their street/number checks take over.
  const onAddressScanned = (picked: PickedAddress) => {
    if (picked.kind === 'eircode') { onScanned(picked.eircode); return; }
    setSheet(null);
    typeAddress(picked.text);
    addressRef.current?.blur();
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
  // Planning needs every stop on the server: stops still on the phone hold Review until they are sent.
  const unsent = stops.filter((d) => d.flags.includes('pending_sync') && !d.flags.includes('sync_failed')).length;
  const refusedCount = stops.filter((d) => d.flags.includes('sync_failed')).length;
  const needsPlan = refused?.code === 'SUBSCRIPTION_REQUIRED';
  const [retrying, setRetrying] = useState(false);
  const retryRefused = async () => {
    setRetrying(true);
    try { await retryRefusedStops(date); } finally { setRetrying(false); void load(); }
  };

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
            {shownSuggestions.map(({ item: sug, issues }, i) => (
              <Pressable key={sug.placeId ?? `${sug.latitude},${sug.longitude}`} onPress={() => void choose(sug)} style={({ pressed }) => [s.suggestion, i > 0 && s.divider, pressed && { backgroundColor: c.soft }]}>
                <MaterialCommunityIcons name={issues.length || sug.approximate ? 'map-marker-question-outline' : 'map-marker-check-outline'} size={20} color={issues.length || sug.approximate ? c.warning : c.success} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: issues.length ? c.textSecondary : c.text, fontSize: 15 }} numberOfLines={2}>{sug.label}</Text>
                  {issues.length ? <Text style={{ color: c.warning, fontSize: 13, fontWeight: '600', marginTop: 2 }}>{issues.map(issueText).join(' · ')}</Text> : null}
                </View>
              </Pressable>
            ))}
          </View>
        ) : null}

        {unsure ? (
          <View style={s.unsure}>
            <MaterialCommunityIcons name="map-marker-alert-outline" size={20} color={c.warning} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.text, fontWeight: '600', fontSize: 15 }}>{mapFound ? 'The map found a different address' : 'We couldn\u2019t pin this address exactly'}</Text>
              {mapFound ? <Text style={{ color: c.warning, fontSize: 14, marginTop: 2 }}>{mapFound}</Text> : null}
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
          <Mode icon="text-recognition" label="Sheet" onPress={() => setSheet('sheet')} />
          <Mode icon="file-download-outline" label="Import" onPress={() => { setSheetCodes(null); setSheet('import'); }} />
        </View>

        {voice ? (
          <View style={s.voice}>
            {VoicePanel ? <VoicePanel compact light onText={onVoice} /> : (
              <Text style={{ color: c.textSecondary, fontSize: 14, lineHeight: 20, textAlign: 'center' }}>Voice input is unavailable here. {NATIVE_BUILD_HINT}</Text>
            )}
            <Text style={{ color: c.textSecondary, fontSize: 13, textAlign: 'center', marginTop: 6 }}>Say the house number, street and town, or the Eircode one character at a time.</Text>
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
        {refused && refusedCount ? (
          <>
            {/* Refused by the server, not offline: say why and offer the fix. */}
            <LightError text={`${refusedCount} stop${refusedCount === 1 ? ' was' : 's were'} not saved. ${refused.error}`} />
            <LightButton title={needsPlan ? 'Start free trial' : 'Try again'} loading={retrying}
              onPress={() => (needsPlan ? navigate('Paywall') : void retryRefused())} style={{ marginTop: 10 }} />
          </>
        ) : (
          <LightButton
            title={unsent ? `Saving ${unsent} stop${unsent === 1 ? '' : 's'}… (offline)` : stops.length ? `Review ${stops.length} stop${stops.length === 1 ? '' : 's'}` : 'Add a stop to continue'}
            onPress={review} disabled={!stops.length || unsent > 0} />
        )}
      </View>

      <EircodeScanner visible={sheet === 'scan'} onEircode={onScanned} onAddress={onAddressScanned} onTypeInstead={typeInstead} onClose={() => setSheet(null)} />
      <DuplicatePrompt duplicate={duplicate?.found ?? null} onView={() => duplicate && viewStop(duplicate.found.stop)}
        onAddAnyway={() => { const next = duplicate?.addAnyway; setDuplicate(null); next?.(); }} onCancel={() => setDuplicate(null)} />
      <ConfirmStop eircode={confirming} date={date} near={origin || area} existing={stops}
        onAdded={(stop) => { setStops((list) => [...list, stop]); Vibration.vibrate(30); }}
        onRescan={() => { setConfirming(null); openScanner('batch'); }}
        onViewStop={(stop) => { setConfirming(null); viewStop(stop); }}
        onClose={() => setConfirming(null)} />
      <BarcodeSheet visible={sheet === 'barcode'} onClose={() => setSheet(null)} onResult={(value) => { setSheet(null); setParcel(value); }} />
      <PinSheet visible={sheet === 'pin'} position={origin} center={picked || area} onClose={() => setSheet(null)} onPick={onPin} />
      {/* Stops come in while the import runs; the sheet stays open until the rider has dealt with the rows it could not add. */}
      <EircodeSheetScan visible={sheet === 'sheet'} onEircodes={(codes) => { setSheetCodes(codes); setSheet('import'); }}
        onTypeInstead={typeInstead} onClose={() => setSheet(null)} />
      <ImportSheet visible={sheet === 'import'} date={date} stops={stops} near={origin || area} eircodes={sheetCodes} onClose={() => { setSheet(null); setSheetCodes(null); }}
        onImported={(created) => setStops((list) => [...list, ...created])} />
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
