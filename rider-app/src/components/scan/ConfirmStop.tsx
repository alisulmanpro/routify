import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import ConfirmMap from './ConfirmMap';
import BarcodeSheet from './BarcodeSheet';
import { LightButton, LightError } from '../LightKit';
import { DuplicateSheet, StopAddedCard } from '../StopPrompts';
import { ApiRequestError } from '../../lib/api';
import { checkAddress, createStop, DuplicateStopError } from '../../lib/stops';
import { findDuplicate, type Duplicate } from '../../lib/duplicates';
import { stopCardText } from '../../lib/format';
import type { Delivery, GeocodeCheck } from '../../lib/types';
import { light as c, lightRadius as lr } from '../../lib/theme';

type Point = { latitude: number; longitude: number };

type Props = {
  /** The Eircode the scanner read; the sheet is open while it is set. */
  eircode: string | null;
  date: string;
  near: Point | null;
  existing: readonly Delivery[];
  onAdded: (stop: Delivery) => void;
  onRescan: () => void;
  onViewStop: (stop: Delivery) => void;
  onClose: () => void;
};

/**
 * Confirm stop, after the Scan button read an Eircode: the map, the Eircode and the address it belongs to. It opens
 * "Verifying location…" while the map looks the Eircode up, then "Location confirmed" and Add stop. A stop that is
 * already on the list shows "Already in your stops" first. Once added, "Stop added" offers Scan next or Done.
 */
export default function ConfirmStop(props: Props) {
  // Each scan mounts a fresh sheet, so every Eircode starts from "Verifying location…".
  return props.eircode ? <ConfirmBody key={props.eircode} {...props} eircode={props.eircode} /> : null;
}

function ConfirmBody({ eircode, date, near, existing, onAdded, onRescan, onViewStop, onClose }: Props & { eircode: string }) {
  const insets = useSafeAreaInsets();
  const [check, setCheck] = useState<GeocodeCheck | null>(null);
  const [verifying, setVerifying] = useState(true);
  const [parcel, setParcel] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  // A stop already on the list is reported straight away, while the Eircode is still being looked up.
  const [duplicate, setDuplicate] = useState<Duplicate<Delivery> | null>(() => findDuplicate({ eircode }, existing));
  // The rider chose "Add anyway" for this Eircode (a second parcel for the same door).
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [added, setAdded] = useState<Delivery | null>(null);
  const [barcode, setBarcode] = useState(false);
  const lookup = useRef(0);

  const lookUp = () => {
    const id = ++lookup.current;
    checkAddress(eircode, near)
      .then((res) => { if (id === lookup.current) setCheck(res); })
      .catch((err) => { if (id === lookup.current) setError(err instanceof ApiRequestError ? err.message : 'Could not check this Eircode. Check your connection and try again.'); })
      .finally(() => { if (id === lookup.current) setVerifying(false); });
  };
  const verify = () => { setVerifying(true); setError(''); lookUp(); };

  // Look the Eircode up once when the sheet opens; a late answer after it closes is ignored.
  useEffect(() => {
    lookUp();
    const ref = lookup;
    return () => { ref.current++; };
    // Once per scan (the sheet is remounted for each Eircode).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const point = check?.found && check.latitude != null && check.longitude != null ? { latitude: check.latitude, longitude: check.longitude } : null;
  const address = check?.normalized ? stopCardText({ address: { raw: eircode, normalized: check.normalized, postalCode: check.postalCode } }).address : '';
  const status: { icon: ComponentProps<typeof Ionicons>['name']; text: string; fg: string; bg: string } = verifying || (!check && !error)
    ? { icon: 'time-outline', text: 'Not confirmed yet', fg: c.textLabel, bg: c.soft }
    : point && !check?.approximate ? { icon: 'checkmark', text: 'Location confirmed', fg: c.success, bg: c.successBg }
      : point ? { icon: 'help-circle-outline', text: 'Approximate location', fg: c.warning, bg: c.warningBg }
        : { icon: 'alert-circle-outline', text: error ? 'Not confirmed yet' : 'Location not found', fg: error ? c.textLabel : c.danger, bg: error ? c.soft : c.dangerBg };

  const add = async (duplicateOk = allowDuplicate) => {
    if (parcel.trim() && parcel.trim().length < 3) { setError('Parcel IDs are at least 3 characters. Clear it if there is none.'); return; }
    setAdding(true);
    setError('');
    try {
      // An Eircode is one building: its point is used even when the match is not a rooftop one. Not found: the server
      // looks it up again when the route is planned.
      const stop = await createStop({
        raw: eircode, parcel, date, location: point, normalized: check?.normalized, precise: !!point && !check?.approximate,
        existing, allowDuplicate: duplicateOk,
      });
      onAdded(stop);
      setAdded(stop);
    } catch (err) {
      if (err instanceof DuplicateStopError) { setDuplicate(err.duplicate); return; }
      setError(err instanceof ApiRequestError ? err.message : 'Could not add this stop. Check your connection and try again.');
    } finally {
      setAdding(false);
    }
  };

  const busy = verifying || (!check && !error);
  const action = busy
    ? <LightButton title="Verifying location…" variant="outline" onPress={() => {}} disabled icon={<ActivityIndicator color={c.textSecondary} />} style={s.verifying} />
    : error && !check
      ? <LightButton title="Try again" onPress={verify} />
      : <LightButton title={point ? 'Add stop' : 'Add anyway'} onPress={() => void add()} loading={adding} />;

  return (
    <Modal visible animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <StatusBar style="dark" />
      <View style={{ flex: 1, backgroundColor: c.background }}>
        <ConfirmMap point={point} fallback={near} style={{ flex: 1 }} />
        <Pressable onPress={onClose} hitSlop={10} style={[s.back, { top: insets.top + 12 }]} accessibilityLabel="Back">
          <Ionicons name="arrow-back" size={24} color={c.text} />
        </Pressable>

        <View style={[s.panel, { paddingBottom: insets.bottom + 16 }]}>
          <View style={s.grabber} />
          <Text style={s.eircode}>{eircode}</Text>
          <Text style={s.address} numberOfLines={3}>{address || (busy ? 'Looking up the address…' : 'No address found for this Eircode')}</Text>
          <View style={[s.chip, { backgroundColor: status.bg }]}>
            <Ionicons name={status.icon} size={16} color={status.fg} />
            <Text style={{ color: status.fg, fontSize: 14, fontWeight: '500' }}>{status.text}</Text>
          </View>

          <Text style={s.label}>Parcel ID <Text style={{ color: c.placeholder, fontWeight: '400' }}>(optional)</Text></Text>
          <View style={s.field}>
            <TextInput value={parcel} onChangeText={setParcel} placeholder="e.g. RTF-204871" placeholderTextColor={c.placeholder} style={s.input}
              autoCapitalize="characters" autoCorrect={false} maxLength={80} returnKeyType="done" onSubmitEditing={() => { if (!busy) void add(); }} />
            <Pressable onPress={() => setBarcode(true)} hitSlop={8} accessibilityLabel="Scan the parcel barcode">
              <MaterialCommunityIcons name="barcode-scan" size={22} color={c.link} />
            </Pressable>
          </View>

          {error ? <View style={{ marginTop: 12 }}><LightError text={error} /></View> : null}
          <View style={{ marginTop: error ? 0 : 16 }}>{action}</View>
          <Pressable onPress={onRescan} hitSlop={8} style={s.rescan} disabled={adding}>
            <MaterialCommunityIcons name="line-scan" size={20} color={c.textLabel} />
            <Text style={{ color: c.textLabel, fontSize: 16, fontWeight: '600' }}>Rescan</Text>
          </Pressable>
        </View>

        {duplicate && !added ? (
          <DuplicateSheet duplicate={duplicate}
            onView={() => onViewStop(duplicate.stop)}
            onOk={onClose}
            onAddAnyway={() => { setDuplicate(null); setAllowDuplicate(true); }} />
        ) : null}
        {added ? <StopAddedCard stop={added} onScanNext={onRescan} onDone={onClose} /> : null}
      </View>
      <BarcodeSheet visible={barcode} onClose={() => setBarcode(false)} onResult={(value) => { setBarcode(false); setParcel(value); }} />
    </Modal>
  );
}

const s = StyleSheet.create({
  back: { position: 'absolute', left: 20, width: 44, height: 44, borderRadius: 22, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 4 },
  panel: { marginTop: -28, backgroundColor: c.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 24, paddingTop: 10 },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: c.track, marginBottom: 20 },
  eircode: { color: c.text, fontSize: 34, fontWeight: '800', letterSpacing: -0.5 },
  address: { color: c.textSecondary, fontSize: 16, lineHeight: 22, marginTop: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, marginTop: 16 },
  label: { color: c.textLabel, fontSize: 15, fontWeight: '500', marginTop: 24, marginBottom: 8 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 16, borderRadius: lr.field, borderWidth: 1, borderColor: c.border },
  input: { flex: 1, color: c.text, fontSize: 16, paddingVertical: 12 },
  verifying: { backgroundColor: c.track, borderWidth: 0, opacity: 0.8 },
  rescan: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 16 },
});
