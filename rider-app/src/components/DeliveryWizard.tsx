import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, Vibration, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { post, ApiRequestError } from '../lib/api';
import { NATIVE_BUILD_HINT, loadVoicePanel, readTextFromImage } from '../lib/optionalNative';
import { premium as c, premiumRadius as r } from '../lib/theme';
import { DARK_ON_PRIMARY, ErrorBanner, IconCircle, PButton, PCard, Pill, type McName } from './Premium';

type Mode = 'scan' | 'voice';
type FieldKey = 'address' | 'parcel' | 'name' | 'phone' | 'note';
type Step = { key: FieldKey; label: string; scanTitle: string; voiceTitle: string; hint: string; icon: McName; optional: boolean; multiline?: boolean };

const STEPS: Step[] = [
  { key: 'address', label: 'Address', scanTitle: 'Scan the delivery address', voiceTitle: 'Say the delivery address', hint: 'Point at the address on the label, then tap Read text. A QR code works too.', icon: 'map-marker-outline', optional: false, multiline: true },
  { key: 'parcel', label: 'Parcel ID', scanTitle: 'Scan the parcel ID', voiceTitle: 'Say the parcel ID', hint: 'Barcodes and QR codes are read automatically. For printed IDs, tap Read text.', icon: 'barcode-scan', optional: false },
  { key: 'name', label: 'Customer name', scanTitle: 'Customer name', voiceTitle: "Say the customer's name", hint: 'Optional. Scan or say it, or skip this step.', icon: 'account-outline', optional: true },
  { key: 'phone', label: 'Phone', scanTitle: 'Customer phone', voiceTitle: 'Say the phone number', hint: 'Optional. Scan or say it, or skip this step.', icon: 'phone-outline', optional: true },
  { key: 'note', label: 'Note', scanTitle: 'Delivery note', voiceTitle: 'Add a delivery note', hint: 'Optional, e.g. "leave at reception".', icon: 'note-text-outline', optional: true, multiline: true },
];
const REVIEW = STEPS.length;
const EMPTY: Record<FieldKey, string> = { address: '', parcel: '', name: '', phone: '', note: '' };

// Every symbology the camera supports: labels vary a lot between couriers.
const BARCODE_TYPES: BarcodeType[] = ['qr', 'code128', 'code39', 'code93', 'ean13', 'ean8', 'upc_a', 'upc_e', 'itf14', 'codabar', 'datamatrix', 'pdf417', 'aztec'];
const TWO_D = /qr|matrix|pdf417|aztec/i;
const REQUIRED_HITS = 2;
const VoicePanel = loadVoicePanel();

const PHONE_RX = /\+?\d[\d\s\-()]{7,}\d/;
/** Phone numbers have 9-15 digits; shorter digit runs on labels are usually parcel IDs. */
const isPhone = (text: string) => {
  const digits = text.match(PHONE_RX)?.[0].replace(/\D/g, '').length ?? 0;
  return digits >= 9 && digits <= 15;
};
const PARCEL_RX = /^[A-Z0-9][A-Z0-9\-_/]{4,}$/i;

/** Normalises raw input per field: IDs are compact and upper-case, phones keep only dial characters. */
function clean(key: FieldKey, raw: string) {
  const value = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  if (key === 'parcel') return unwrapCode(value).replace(/\s+/g, '').toUpperCase().slice(0, 80);
  if (key === 'phone') return (value.match(PHONE_RX)?.[0] ?? value).replace(/[^\d+\-() ]/g, '').trim().slice(0, 32);
  return value.replace(/\s+/g, ' ');
}

/** QR labels often wrap the ID in JSON or a tracking URL. */
function unwrapCode(value: string) {
  if (value.startsWith('{')) {
    try {
      const obj = JSON.parse(value);
      const id = obj.parcelId ?? obj.trackingId ?? obj.tracking_id ?? obj.tracking ?? obj.awb ?? obj.id ?? obj.orderId;
      if (id) return String(id);
    } catch { /* not JSON */ }
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const param = ['parcelId', 'trackingId', 'tracking_id', 'tracking', 'awb', 'id', 'order'].map((k) => url.searchParams.get(k)).find(Boolean);
      return param ?? url.pathname.split('/').filter(Boolean).pop() ?? value;
    } catch { /* keep raw */ }
  }
  return value;
}

const looksLikeAddress = (text: string) => text.length >= 8 && /[a-z]/i.test(text) && /\s/.test(text) && !/^https?:\/\//i.test(text);

/** Picks the OCR lines most likely to be the value for this step, so the rider usually just confirms. */
function guessLines(key: FieldKey, lines: string[]) {
  if (key === 'phone') {
    const i = lines.findIndex(isPhone);
    return i >= 0 ? [i] : [];
  }
  if (key === 'parcel') {
    const candidate = (l: string) => PARCEL_RX.test(l.replace(/\s+/g, '')) && /\d/.test(l);
    // Prefer IDs mixing letters and digits; fall back to digit-only codes that aren't phone numbers.
    let i = lines.findIndex((l) => candidate(l) && /[a-z]/i.test(l));
    if (i < 0) i = lines.findIndex((l) => candidate(l) && !isPhone(l));
    return i >= 0 ? [i] : [];
  }
  return [];
}

export default function DeliveryWizard({ mode, onCreated, onDone }: { mode: Mode; onCreated: () => void; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<Record<FieldKey, string>>(EMPTY);
  const [typing, setTyping] = useState(mode === 'voice');
  const [lines, setLines] = useState<string[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [parcelFromCode, setParcelFromCode] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const current = STEPS[step];
  const value = current ? values[current.key] : '';
  const setValue = useCallback((key: FieldKey, next: string) => setValues((v) => ({ ...v, [key]: next })), []);

  const goTo = (next: number) => {
    setStep(next);
    setSelected([]);
    setTyping(mode === 'voice');
    setNotice('');
    setError('');
    // A barcode spotted while scanning the address becomes the parcel ID suggestion.
    if (STEPS[next]?.key === 'parcel' && parcelFromCode) setValues((v) => (v.parcel ? v : { ...v, parcel: parcelFromCode }));
  };

  const next = () => {
    if (!current) return;
    const v = values[current.key].trim();
    if (current.key === 'address' && v.length < 5) { setError('Enter the full delivery address (at least 5 characters).'); return; }
    if (current.key === 'parcel' && v.length < 3) { setError('Enter the parcel ID (at least 3 characters).'); return; }
    if (current.key === 'phone' && v && !/^\+?[\d\s\-()]{5,}$/.test(v)) { setError('That phone number does not look right. Fix it or skip.'); return; }
    goTo(step + 1);
  };

  const skip = () => { if (current) setValue(current.key, ''); goTo(step + 1); };

  const toggleLine = (index: number) => {
    if (!current) return;
    const nextSel = selected.includes(index) ? selected.filter((i) => i !== index) : [...selected, index];
    setSelected(nextSel);
    const joiner = current.key === 'address' || current.key === 'note' ? ', ' : ' ';
    setValue(current.key, clean(current.key, nextSel.map((i) => lines[i]).join(joiner)));
  };

  const onLines = (found: string[]) => {
    const cleaned = found.flatMap((block) => block.split('\n')).map((l) => l.trim()).filter((l) => l.length > 1);
    if (!cleaned.length) { setNotice('No text found. Move closer, hold steady and try again.'); return; }
    // Keep earlier lines so later steps can pick from the same label without rescanning.
    const merged = [...new Set([...cleaned, ...lines])].slice(0, 40);
    setLines(merged);
    if (current) {
      const guess = guessLines(current.key, merged);
      setSelected(guess);
      if (guess.length) setValue(current.key, clean(current.key, merged[guess[0]]));
    }
    setNotice('');
  };

  const onCode = (type: string, data: string) => {
    if (!current) return;
    const text = data.trim();
    if (current.key === 'address') {
      if (TWO_D.test(type) && looksLikeAddress(text)) setValue('address', clean('address', text));
      else {
        setParcelFromCode(clean('parcel', text));
        setNotice(`Parcel ID ${clean('parcel', text)} detected. It will be filled in on the next step.`);
      }
      return;
    }
    if (current.key === 'phone') { setValue('phone', clean('phone', text)); return; }
    setValue(current.key, clean(current.key, text));
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await post('/deliveries/manual', {
        trackingId: values.parcel.trim(),
        customer: { name: values.name.trim(), phone: values.phone.trim() },
        address: { raw: values.address.trim() },
        note: values.note.trim() || undefined,
      });
      setSaved(values.parcel.trim());
      onCreated();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save this stop. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  const startNext = () => {
    setValues(EMPTY);
    setLines([]);
    setParcelFromCode('');
    setSaved(null);
    goTo(0);
  };

  if (saved) {
    return (
      <ScrollView contentContainerStyle={s.page}>
        <PCard accent style={{ alignItems: 'center', paddingVertical: 28 }}>
          <IconCircle icon="check-bold" color={c.success} bg="rgba(25,216,139,0.16)" size={72} />
          <Text style={[s.title, { textAlign: 'center', marginTop: 14 }]}>Stop saved</Text>
          <Text style={[s.hint, { textAlign: 'center' }]}>Parcel {saved} was added to your deliveries.</Text>
          <PButton title={mode === 'scan' ? 'Scan next stop' : 'Add next stop'} icon={mode === 'scan' ? 'scan-outline' : 'mic-outline'} onPress={startNext} chevron style={{ alignSelf: 'stretch', marginTop: 20 }} />
          <PButton title="Done" icon="checkmark-done" variant="secondary" onPress={onDone} style={{ alignSelf: 'stretch', marginTop: 10 }} />
        </PCard>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <Progress step={step} />

      {step === REVIEW ? (
        <Review values={values} onEdit={goTo} onSave={save} saving={saving} error={error} />
      ) : (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <IconCircle icon={current.icon} />
            <View style={{ flex: 1 }}>
              <Text style={s.title}>{mode === 'scan' ? current.scanTitle : current.voiceTitle}</Text>
              {current.optional ? <Pill text="Optional" tone="muted" /> : null}
            </View>
          </View>
          <Text style={[s.hint, { marginBottom: 14 }]}>{mode === 'scan' ? current.hint : 'Tap the microphone and speak clearly. You can correct the text before continuing.'}</Text>

          <ErrorBanner text={error} />

          {mode === 'scan' && !typing ? (
            <ScanPanel
              key={current.key}
              hasValue={!!value}
              onLines={onLines}
              onCode={onCode}
              onUnsupported={() => { setTyping(true); setNotice(`Reading printed text is unavailable here. ${NATIVE_BUILD_HINT} Barcodes and QR codes still scan; type other details.`); }}
            />
          ) : null}
          {mode === 'voice' && VoicePanel ? <VoicePanel key={current.key} onText={(t) => setValue(current.key, clean(current.key, t))} /> : null}
          {mode === 'voice' && !VoicePanel ? (
            <View style={s.notice}>
              <Ionicons name="mic-off-outline" size={16} color={c.warning} />
              <Text style={{ flex: 1, color: c.textSecondary, fontSize: 12, lineHeight: 17 }}>Voice input is unavailable here. {NATIVE_BUILD_HINT} Type the value below instead.</Text>
            </View>
          ) : null}

          {notice ? (
            <View style={s.notice}>
              <Ionicons name="information-circle" size={16} color={c.primary} />
              <Text style={{ flex: 1, color: c.textSecondary, fontSize: 12, lineHeight: 17 }}>{notice}</Text>
            </View>
          ) : null}

          {mode === 'scan' && lines.length > 0 && !typing ? (
            <View style={{ marginTop: 12 }}>
              <Text style={s.sectionLabel}>Tap the {current.label.toLowerCase()} line{current.multiline ? 's' : ''}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {lines.map((line, i) => {
                  const on = selected.includes(i);
                  return (
                    <Pressable key={`${line}-${i}`} onPress={() => toggleLine(i)} style={[s.lineChip, on && s.lineChipOn]}>
                      {on ? <Ionicons name="checkmark-circle" size={14} color={c.primary} /> : null}
                      <Text style={{ color: on ? c.primary : c.text, fontSize: 13, fontWeight: on ? '700' : '500' }}>{line}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}

          {/* The value for this step: confirmed, typed, or corrected here. */}
          {(value || typing) ? (
            <PCard style={{ marginTop: 14 }}>
              <Text style={s.sectionLabel}>{current.label}</Text>
              <TextInput
                value={value}
                onChangeText={(t) => setValue(current.key, current.key === 'parcel' ? t.toUpperCase() : t)}
                placeholder={`Type the ${current.label.toLowerCase()}`}
                placeholderTextColor={c.textMuted}
                multiline={current.multiline}
                autoCapitalize={current.key === 'parcel' ? 'characters' : current.key === 'name' ? 'words' : 'sentences'}
                keyboardType={current.key === 'phone' ? 'phone-pad' : 'default'}
                style={[s.input, current.multiline && { minHeight: 70, textAlignVertical: 'top' }]}
              />
            </PCard>
          ) : null}

          <View style={{ gap: 10, marginTop: 16 }}>
            <PButton title={step === REVIEW - 1 ? 'Review stop' : 'Next'} icon="arrow-forward" onPress={next} disabled={!current.optional && !value.trim()} chevron />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              {step > 0 ? <PButton title="Back" icon="arrow-back" variant="secondary" onPress={() => goTo(step - 1)} style={{ flex: 1 }} /> : null}
              {current.optional ? <PButton title="Skip" icon="play-skip-forward-outline" variant="secondary" onPress={skip} style={{ flex: 1 }} /> : null}
              {mode === 'scan' ? (
                <PButton title={typing ? 'Use camera' : 'Type instead'} icon={typing ? 'camera-outline' : 'create-outline'} variant="secondary" onPress={() => setTyping((t) => !t)} style={{ flex: 1 }} />
              ) : null}
            </View>
          </View>
        </>
      )}
    </ScrollView>
  );
}

function Progress({ step }: { step: number }) {
  return (
    <View style={{ marginBottom: 18 }}>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {[...STEPS, null].map((_, i) => (
          <View key={i} style={[s.progressBar, i <= step && { backgroundColor: c.primary }]} />
        ))}
      </View>
      <Text style={{ color: c.textMuted, fontSize: 11, fontWeight: '700', marginTop: 8, letterSpacing: 0.6 }}>
        {step === REVIEW ? 'REVIEW' : `STEP ${step + 1} OF ${STEPS.length}`}
      </Text>
    </View>
  );
}

function ScanPanel({ hasValue, onLines, onCode, onUnsupported }: { hasValue: boolean; onLines: (lines: string[]) => void; onCode: (type: string, data: string) => void; onUnsupported: () => void }) {
  const camera = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [ready, setReady] = useState(false);
  const [reading, setReading] = useState(false);
  const [torch, setTorch] = useState(false);
  const candidate = useRef({ value: '', hits: 0 });

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

  const onBarcode = ({ type, data }: { type: string; data: string }) => {
    const value = (data ?? '').trim();
    if (!value) return;
    // Only accept a code read identically twice, so a misread frame is never used.
    if (candidate.current.value !== value) { candidate.current = { value, hits: 1 }; return; }
    candidate.current.hits += 1;
    if (candidate.current.hits !== REQUIRED_HITS) return;
    Vibration.vibrate(40);
    onCode(type, value);
  };

  const readText = async () => {
    if (!camera.current || reading) return;
    if (Platform.OS === 'web') { onUnsupported(); return; }
    setReading(true);
    try {
      const photo = await camera.current.takePictureAsync({ quality: 0.8, skipProcessing: false });
      const found = await readTextFromImage(photo.uri);
      if (found === null) { onUnsupported(); return; }
      onLines(found);
    } catch {
      onLines([]);
    } finally {
      setReading(false);
    }
  };

  if (!permission) return <View style={[s.camera, s.center]}><ActivityIndicator color={c.primary} /></View>;
  if (!permission.granted) {
    return (
      <View style={[s.camera, s.center, { padding: 20 }]}>
        <Ionicons name="camera-outline" size={34} color={c.textMuted} />
        <Text style={{ color: c.text, fontWeight: '700', marginTop: 10 }}>Camera access needed</Text>
        <Text style={{ color: c.textSecondary, fontSize: 12, textAlign: 'center', marginTop: 4 }}>Allow the camera to scan labels, or tap Type instead.</Text>
        <PButton title="Allow camera" icon="camera" onPress={() => void requestPermission()} style={{ marginTop: 14, alignSelf: 'stretch' }} />
      </View>
    );
  }

  return (
    <View>
      <View style={[s.camera, hasValue && { height: 190 }]}>
        <CameraView
          ref={camera}
          style={StyleSheet.absoluteFill}
          facing="back"
          enableTorch={torch}
          onCameraReady={() => setReady(true)}
          barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
          onBarcodeScanned={onBarcode}
        />
        {/* Framing guide */}
        <View pointerEvents="none" style={s.frame}>
          {(['tl', 'tr', 'bl', 'br'] as const).map((k) => <View key={k} style={[s.corner, CORNER[k]]} />)}
        </View>
        <Pressable onPress={() => setTorch((t) => !t)} hitSlop={8} style={s.torch}>
          <Ionicons name={torch ? 'flash' : 'flash-outline'} size={18} color={torch ? c.primary : '#fff'} />
        </Pressable>
        {reading ? (
          <View style={[StyleSheet.absoluteFill, s.center, { backgroundColor: 'rgba(5,11,24,0.55)' }]}>
            <ActivityIndicator color={c.primary} />
            <Text style={{ color: '#fff', marginTop: 8, fontWeight: '700' }}>Reading text…</Text>
          </View>
        ) : null}
      </View>
      <Pressable onPress={readText} disabled={!ready || reading} style={({ pressed }) => [s.shutter, (!ready || reading) && { opacity: 0.6 }, pressed && { opacity: 0.85 }]}>
        <MaterialCommunityIcons name="text-recognition" size={20} color={DARK_ON_PRIMARY} />
        <Text style={{ color: DARK_ON_PRIMARY, fontWeight: '800', fontSize: 15 }}>Read text</Text>
      </Pressable>
    </View>
  );
}

function Review({ values, onEdit, onSave, saving, error }: { values: Record<FieldKey, string>; onEdit: (step: number) => void; onSave: () => void; saving: boolean; error: string }) {
  return (
    <>
      <Text style={s.title}>Review stop</Text>
      <Text style={[s.hint, { marginBottom: 14 }]}>Tap any detail to change it, then save.</Text>
      <ErrorBanner text={error} />
      <PCard style={{ paddingVertical: 4 }}>
        {STEPS.map((st, i) => (
          <Pressable key={st.key} onPress={() => onEdit(i)} style={[s.reviewRow, i > 0 && { borderTopWidth: 1, borderTopColor: c.divider }]}>
            <MaterialCommunityIcons name={st.icon} size={20} color={c.primary} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.textMuted, fontSize: 11, fontWeight: '700' }}>{st.label.toUpperCase()}</Text>
              <Text style={{ color: values[st.key] ? c.text : c.textMuted, fontSize: 14, fontWeight: values[st.key] ? '600' : '400', marginTop: 2 }}>{values[st.key] || 'Skipped'}</Text>
            </View>
            <Ionicons name="create-outline" size={18} color={c.textSecondary} />
          </Pressable>
        ))}
      </PCard>
      <PButton title="Save stop" icon="checkmark-circle-outline" onPress={onSave} loading={saving} chevron style={{ marginTop: 16 }} />
      <PButton title="Back" icon="arrow-back" variant="secondary" onPress={() => onEdit(STEPS.length - 1)} style={{ marginTop: 10 }} />
    </>
  );
}

const CORNER = {
  tl: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 14 },
  tr: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 14 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 14 },
  br: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 14 },
} as const;

const s = StyleSheet.create({
  page: { padding: 16, paddingBottom: 32 },
  title: { color: c.text, fontSize: 19, fontWeight: '800' },
  hint: { color: c.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 4 },
  sectionLabel: { color: c.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 },
  progressBar: { flex: 1, height: 4, borderRadius: 2, backgroundColor: c.surfaceSoft },

  camera: { height: 300, borderRadius: r.large, overflow: 'hidden', backgroundColor: '#000', borderWidth: 1, borderColor: c.border },
  center: { alignItems: 'center', justifyContent: 'center' },
  frame: { position: 'absolute', top: '14%', bottom: '14%', left: '8%', right: '8%' },
  corner: { position: 'absolute', width: 34, height: 34, borderColor: c.primary },
  torch: { position: 'absolute', top: 12, right: 12, width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(5,11,24,0.7)', alignItems: 'center', justifyContent: 'center' },
  shutter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 50, borderRadius: r.medium, backgroundColor: '#FFFFFF', marginTop: 12 },

  notice: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, padding: 12, borderRadius: r.small, backgroundColor: 'rgba(255,170,50,0.1)' },
  lineChip: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: r.small, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceSoft },
  lineChipOn: { borderColor: c.primary, backgroundColor: 'rgba(255,170,50,0.14)' },
  input: { color: c.text, fontSize: 16, fontWeight: '600', paddingVertical: 8, paddingHorizontal: 12, borderRadius: r.small, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceSoft },


  reviewRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
});
