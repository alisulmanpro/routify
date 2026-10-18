import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, Vibration, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { NATIVE_BUILD_HINT, hasTextReader, readTextFromImage } from '../lib/optionalNative';
import { premium as c, premiumRadius as r } from '../lib/theme';
import { DARK_ON_PRIMARY, PButton } from './Premium';

// Every symbology the camera supports: labels vary a lot between couriers.
const BARCODE_TYPES: BarcodeType[] = ['qr', 'code128', 'code39', 'code93', 'ean13', 'ean8', 'upc_a', 'upc_e', 'itf14', 'codabar', 'datamatrix', 'pdf417', 'aztec'];
// A code must read the same twice in a row, so one misread frame is never used.
const REQUIRED_HITS = 2;
// Pause between automatic text reads, so the phone stays cool and the camera stays smooth.
const READ_EVERY_MS = 900;

export type ScanResult = { address?: string; parcel?: string };
/** label: address and parcel ID together · address: the address only · barcode: the parcel ID only. */
export type ScanMode = 'label' | 'address' | 'barcode';

const PHONE = /^\+?[\d\s\-()]{7,}$/;
const CODE_LIKE = /^[A-Z0-9\-_/]{6,}$/; // tracking numbers, not words
const ADDRESS_WORD = /\b(street|st|road|rd|lane|ln|avenue|ave|block|sector|house|flat|apartment|apt|floor|town|colony|mohalla|village|near|opp|chowk|bazar|market|plaza|park|drive|dr|close|court|ct|way|place|pl|square|sq|hill|crescent)\b/i;
const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}|[AC-FHKNPRTV-Y]\d{2}\s?[0-9AC-FHKNPRTV-Y]{4}|\d{5}(-\d{4})?)\b/i;

/** Lines that read like part of an address (not a phone number, tracking code or a label caption). */
function looksLikeAddress(line: string) {
  const text = line.trim();
  if (text.length < 4 || PHONE.test(text) || CODE_LIKE.test(text.replace(/\s/g, ''))) return false;
  if (/^(to|from|ship to|deliver to|name|phone|tel|mobile|order|tracking|weight|cod|date)\b\s*:?\s*$/i.test(text)) return false;
  return ADDRESS_WORD.test(text) || POSTCODE.test(text) || /\d+.*[a-z]{3,}/i.test(text) || /,/.test(text);
}

type Props = { visible: boolean; mode?: ScanMode; onClose: () => void; onResult: (result: ScanResult) => void };

/**
 * Camera sheet for one stop. It reads continuously: barcodes and QR codes fill the parcel ID, and printed text is
 * read every moment without a button. When an address is seen, a preview slides up with its lines already picked.
 */
export default function ScanSheet({ visible, ...props }: Props) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={props.onClose}>
      {visible ? <ScanBody {...props} /> : null}
    </Modal>
  );
}

// Mounted fresh each time the sheet opens, so every scan starts empty.
function ScanBody({ mode = 'label', onClose, onResult }: Omit<Props, 'visible'>) {
  const camera = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [ready, setReady] = useState(false);
  const [torch, setTorch] = useState(false);
  const [parcel, setParcel] = useState('');
  const [lines, setLines] = useState<string[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  // Reading stops while the preview is up, and starts again on "Scan again".
  const [paused, setPaused] = useState(false);
  const candidate = useRef({ value: '', hits: 0 });
  const [slide] = useState(() => new Animated.Value(0));
  const wantText = mode !== 'barcode' && hasTextReader && Platform.OS !== 'web';

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

  const showPreview = useCallback((found: string[]) => {
    setLines(found);
    setPicked(found.flatMap((l, i) => (looksLikeAddress(l) ? [i] : [])));
    setPaused(true);
    Vibration.vibrate(40);
    Animated.timing(slide, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [slide]);

  const scanAgain = () => {
    Animated.timing(slide, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
      setLines([]);
      setPicked([]);
      setPaused(false);
    });
  };

  // Automatic text reading: a silent photo, read on the phone, about once a second until an address shows up.
  useEffect(() => {
    if (!wantText || !ready || paused) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled || !camera.current) return;
      try {
        const photo = await camera.current.takePictureAsync({ quality: 0.6, shutterSound: false });
        const found = ((await readTextFromImage(photo.uri)) || []).map((l) => l.trim()).filter((l) => l.length > 1);
        if (!cancelled && found.some(looksLikeAddress)) { showPreview(found.slice(0, 30)); return; }
      } catch {
        // A frame that could not be read; try the next one.
      }
      if (!cancelled) timer = setTimeout(() => void tick(), READ_EVERY_MS);
    };
    timer = setTimeout(() => void tick(), 600);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [wantText, ready, paused, showPreview]);

  const onBarcode = ({ type, data }: { type: string; data: string }) => {
    const raw = (data ?? '').trim();
    if (raw.length < 3) return;
    if (candidate.current.value !== raw) { candidate.current = { value: raw, hits: 1 }; return; }
    candidate.current.hits += 1;
    if (candidate.current.hits !== REQUIRED_HITS) return;
    // A QR code can carry the whole address.
    const qrAddress = /qr|matrix|aztec|pdf417/i.test(type) && raw.split(/[\n,]/).filter(Boolean).length > 1 && looksLikeAddress(raw);
    if (mode !== 'barcode' && qrAddress) { showPreview(raw.split(/\n/).map((l) => l.trim()).filter(Boolean)); return; }
    const value = raw.replace(/\s+/g, '').toUpperCase().slice(0, 80);
    if (mode === 'barcode') { Vibration.vibrate(40); onResult({ parcel: value }); return; }
    if (mode === 'label' && value !== parcel) { Vibration.vibrate(40); setParcel(value); }
  };

  const toggle = (i: number) => setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]));
  const address = [...picked].sort((a, b) => a - b).map((i) => lines[i]).join(', ');
  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [420, 0] });

  const title = mode === 'barcode' ? 'Scan parcel ID' : mode === 'address' ? 'Scan address' : 'Scan label';
  const status = mode === 'barcode' ? 'Point at the barcode or QR code'
    : wantText ? (parcel && mode === 'label' ? `Parcel ${parcel} · now looking for the address…` : 'Looking for an address…')
      : `Reading printed text is unavailable here. ${NATIVE_BUILD_HINT}${mode === 'label' ? ' Barcodes still scan.' : ''}`;

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {!permission ? <View style={[StyleSheet.absoluteFill, s.center]}><ActivityIndicator color={c.primary} /></View> : !permission.granted ? (
        <View style={[StyleSheet.absoluteFill, s.center, { padding: 24, backgroundColor: c.background }]}>
          <Ionicons name="camera-outline" size={34} color={c.textMuted} />
          <Text style={{ color: c.text, fontWeight: '700', marginTop: 10 }}>Camera access needed</Text>
          <PButton title="Allow camera" icon="camera" onPress={() => void requestPermission()} style={{ marginTop: 14, alignSelf: 'stretch' }} />
        </View>
      ) : (
        <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" enableTorch={torch} onCameraReady={() => setReady(true)}
          barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }} onBarcodeScanned={paused ? undefined : onBarcode} />
      )}

      {/* Framing guide */}
      <View pointerEvents="none" style={s.frame}>
        {(['tl', 'tr', 'bl', 'br'] as const).map((k) => <View key={k} style={[s.corner, CORNER[k]]} />)}
      </View>

      <View style={[s.top, { paddingTop: Platform.OS === 'ios' ? 54 : 18 }]}>
        <Text style={s.title}>{title}</Text>
        <Pressable onPress={() => setTorch((t) => !t)} hitSlop={8} style={s.round}>
          <Ionicons name={torch ? 'flash' : 'flash-outline'} size={18} color={torch ? c.primary : '#fff'} />
        </Pressable>
        <Pressable onPress={onClose} hitSlop={10} style={s.round}><Ionicons name="close" size={20} color="#fff" /></Pressable>
      </View>

      {!paused ? (
        <View style={s.status}>
          {wantText || mode === 'barcode' ? <ActivityIndicator size="small" color={c.primary} /> : <MaterialCommunityIcons name="information-outline" size={16} color={c.warning} />}
          <Text style={{ flex: 1, color: '#fff', fontSize: 13, fontWeight: '600' }}>{status}</Text>
          {mode === 'label' && parcel && !wantText ? (
            <Pressable onPress={() => onResult({ parcel })} style={s.useSmall}><Text style={{ color: DARK_ON_PRIMARY, fontWeight: '800', fontSize: 12 }}>Use</Text></Pressable>
          ) : null}
        </View>
      ) : null}

      {/* Preview: slides up once an address is read */}
      <Animated.View pointerEvents={paused ? 'auto' : 'none'} style={[s.sheet, { transform: [{ translateY }] }]}>
        <View style={s.grabber} />
        {mode === 'label' ? (
          <View style={s.parcelRow}>
            <MaterialCommunityIcons name="barcode-scan" size={16} color={parcel ? c.success : c.textMuted} />
            <Text style={{ flex: 1, color: parcel ? c.text : c.textMuted, fontWeight: '700', fontSize: 13 }}>{parcel ? `Parcel ID ${parcel}` : 'No parcel ID (optional)'}</Text>
          </View>
        ) : null}
        <Text style={s.label}>ADDRESS</Text>
        <Text style={{ color: address ? c.text : c.textMuted, fontSize: 15, fontWeight: '700', lineHeight: 21 }}>{address || 'Tap the lines below that are the address'}</Text>
        <ScrollView style={{ maxHeight: 170, marginTop: 10 }} contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {lines.map((line, i) => {
            const on = picked.includes(i);
            return (
              <Pressable key={`${i}-${line}`} onPress={() => toggle(i)} style={[s.chip, on && s.chipOn]}>
                <Ionicons name={on ? 'checkmark-circle' : 'add-circle-outline'} size={14} color={on ? c.primary : c.textMuted} />
                <Text style={{ color: on ? c.primary : c.text, fontSize: 12, flexShrink: 1 }}>{line}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
          <PButton title="Scan again" icon="refresh" variant="secondary" onPress={scanAgain} style={{ flex: 1 }} />
          <PButton title="Use" icon="checkmark" onPress={() => onResult({ address: address || undefined, parcel: mode === 'label' ? parcel || undefined : undefined })}
            disabled={!address} style={{ flex: 1 }} />
        </View>
      </Animated.View>
    </View>
  );
}

const CORNER = {
  tl: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 14 },
  tr: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 14 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 14 },
  br: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 14 },
} as const;

const s = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  top: { position: 'absolute', left: 0, right: 0, top: 0, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 12, backgroundColor: 'rgba(5,11,24,0.55)' },
  title: { flex: 1, color: '#fff', fontSize: 18, fontWeight: '800' },
  round: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(5,11,24,0.7)', alignItems: 'center', justifyContent: 'center' },
  frame: { position: 'absolute', top: '20%', bottom: '32%', left: '8%', right: '8%' },
  corner: { position: 'absolute', width: 38, height: 38, borderColor: c.primary },
  status: { position: 'absolute', left: 16, right: 16, bottom: 36, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: r.medium, backgroundColor: 'rgba(13,22,41,0.92)', borderWidth: 1, borderColor: c.border },
  useSmall: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: r.pill, backgroundColor: c.primary },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 18, paddingBottom: 28, backgroundColor: c.surface, borderTopLeftRadius: r.xlarge, borderTopRightRadius: r.xlarge, borderTopWidth: 1, borderColor: c.border },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: c.border, marginBottom: 12 },
  parcelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: r.small, backgroundColor: c.surfaceSoft, marginBottom: 12 },
  label: { color: c.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%', paddingHorizontal: 10, paddingVertical: 7, borderRadius: r.small, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceSoft },
  chipOn: { borderColor: c.primary, backgroundColor: 'rgba(255,170,50,0.14)' },
});
