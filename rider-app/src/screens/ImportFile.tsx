import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ViewStyle } from 'react-native';
import { KeyboardAwareScrollView, useRevealOnFocus } from '../components/KeyboardAware';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { postFile, post, ApiRequestError } from '../lib/api';
import type { ImportDraft, ImportDraftItem } from '../lib/types';
import { Banner, Screen } from '../components/Kit';
import { premium as c, premiumRadius as r, premiumShadow } from '../lib/theme';
import { useNav } from '../lib/nav';

type Row = ImportDraftItem & { include: boolean };

// Gradients use RN's native CSS gradient support; backgroundColor is the fallback (e.g. web).
const gradient = (value: string): ViewStyle => ({ experimental_backgroundImage: value } as ViewStyle);
const FORMATS = ['PDF', 'Word', 'Excel', 'CSV'];
// Name and phone are optional now, so only flags that block or duplicate a stop are shown.
const SHOWN_FLAGS = new Set(['missing_address', 'duplicate']);

export default function ImportFile({ onCreated }: { onCreated: () => void }) {
  const { goBack } = useNav();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const pickAndUpload = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'text/csv'
      ],
      copyToCacheDirectory: false
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setBusy(true);
    setError('');
    try {
      let mimeType = asset.mimeType;
      if (!mimeType) {
        const name = asset.name.toLowerCase();
        if (name.endsWith('.pdf')) mimeType = 'application/pdf';
        else if (name.endsWith('.docx')) mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        else if (name.endsWith('.doc')) mimeType = 'application/msword';
        else if (name.endsWith('.xlsx')) mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        else if (name.endsWith('.xls')) mimeType = 'application/vnd.ms-excel';
        else if (name.endsWith('.csv')) mimeType = 'text/csv';
        else mimeType = 'application/octet-stream';
      }

      const res = await postFile<ImportDraft>('/deliveries/import/file', asset.uri, 'file', mimeType);
      setRows(res.data.items.map((item) => ({ ...item, include: !item.flags.includes('duplicate') })));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const networkFailure = err instanceof TypeError || /network request failed|network error|failed to fetch/i.test(message);
      setError(err instanceof ApiRequestError
        ? err.message
        : networkFailure
          ? 'Could not connect to the delivery server. Check that your phone and computer are on the same Wi-Fi, then try again.'
          : `File import failed: ${message || 'Unexpected error'}`);
    } finally { setBusy(false); }
  };

  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs!.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  const submit = async () => {
    const selected = (rows || []).filter((row) => row.include);
    const bad = selected.find((row) => row.address.trim().length < 5);
    if (bad) { setError(`Fix parcel ${bad.trackingId}: every included stop needs an address.`); return; }
    setBusy(true);
    setError('');
    try {
      await post('/deliveries/bulk', {
        items: selected.map((row) => ({
          trackingId: row.trackingId, customer: { name: row.customerName.trim(), phone: row.phone.trim() }, address: { raw: row.address }, note: row.note || undefined,
        })),
      });
      onCreated();
      goBack();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not import these deliveries');
    } finally { setBusy(false); }
  };

  if (!rows) {
    return (
      <Screen style={{ backgroundColor: c.background }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 22 }}>
          <FileArt />
          <Text style={s.title}>Import from file</Text>
          <Text style={s.subtitle}>Pick a courier manifest — PDF, Word or Excel. We&apos;ll pull out parcel IDs, addresses and customer details for you to review before adding them.</Text>
          <View style={s.formats}>
            {FORMATS.map((f) => <View key={f} style={s.formatChip}><Text style={s.formatText}>{f}</Text></View>)}
          </View>
          {error ? <Banner text={error} /> : null}
          <Pressable onPress={pickAndUpload} disabled={busy} style={({ pressed }) => [s.primaryBtn, (pressed || busy) && { opacity: 0.9 }]}>
            {busy ? <ActivityIndicator color={DARK_ON_PRIMARY} /> : <Ionicons name="document-outline" size={20} color={DARK_ON_PRIMARY} />}
            <Text style={s.primaryText}>{busy ? 'Reading your file…' : 'Choose file'}</Text>
            <View style={s.chevron}><Ionicons name="chevron-forward" size={16} color={DARK_ON_PRIMARY} /></View>
          </Pressable>
        </ScrollView>
      </Screen>
    );
  }

  const includedCount = rows.filter((row) => row.include).length;

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <KeyboardAwareScrollView contentContainerStyle={{ padding: 18 }}>
        <Text style={[s.title, { textAlign: 'left', marginTop: 0 }]}>Review import</Text>
        <Text style={[s.subtitle, { textAlign: 'left', paddingHorizontal: 0, marginBottom: 16 }]}>Found {rows.length} deliveries. Fix anything flagged, then add the ones you want.</Text>
        {error ? <Banner text={error} /> : null}

        <View style={{ gap: 12 }}>
          {rows.map((row, i) => (
            <View key={row.trackingId + i} style={[s.card, !row.include && { opacity: 0.5 }]}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <Text style={{ fontWeight: '700', color: c.text, fontSize: 14 }}><Text style={{ color: c.textMuted, fontWeight: '600' }}>Parcel </Text>{row.trackingId}</Text>
                <Pressable onPress={() => update(i, { include: !row.include })} hitSlop={8} style={[s.check, row.include && s.checkOn]}>
                  {row.include && <Ionicons name="checkmark" size={15} color={DARK_ON_PRIMARY} />}
                </Pressable>
              </View>
              {row.flags.some((f) => SHOWN_FLAGS.has(f)) && (
                <View style={s.flag}>
                  <MaterialCommunityIcons name="alert-circle-outline" size={14} color={c.warning} />
                  <Text style={s.flagText}>{row.flags.filter((f) => SHOWN_FLAGS.has(f)).map((f) => f.replace(/_/g, ' ')).join(' · ')}</Text>
                </View>
              )}
              <MiniInput placeholder="Address" value={row.address} onChangeText={(v) => update(i, { address: v })} multiline />
              <MiniInput placeholder="Customer name (optional)" value={row.customerName} onChangeText={(v) => update(i, { customerName: v })} />
              <MiniInput placeholder="Phone (optional)" value={row.phone} onChangeText={(v) => update(i, { phone: v })} keyboardType="phone-pad" />
            </View>
          ))}
        </View>

        <Pressable onPress={submit} disabled={busy || includedCount === 0} style={({ pressed }) => [s.primaryBtn, { marginTop: 18 }, (busy || includedCount === 0) && { opacity: 0.5 }, pressed && { opacity: 0.9 }]}>
          {busy ? <ActivityIndicator color={DARK_ON_PRIMARY} /> : <Ionicons name="add-circle-outline" size={20} color={DARK_ON_PRIMARY} />}
          <Text style={s.primaryText}>Add {includedCount} deliveries</Text>
        </Pressable>
        <Pressable onPress={() => setRows(null)} style={{ alignItems: 'center', paddingVertical: 14 }}>
          <Text style={{ color: c.textSecondary, fontWeight: '700', fontSize: 14 }}>Cancel</Text>
        </Pressable>
      </KeyboardAwareScrollView>
    </Screen>
  );
}

const DARK_ON_PRIMARY = '#1A1206';

function FileArt() {
  const [float] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(float, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(float, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [float]);
  const translateY = float.interpolate({ inputRange: [0, 1], outputRange: [0, -8] });

  return (
    <View style={s.art}>
      <View style={[s.glow, gradient('radial-gradient(circle at 50% 50%, rgba(255,170,50,0.38) 0%, rgba(255,170,50,0.10) 40%, rgba(5,11,24,0) 70%)')]} />
      {SPARKS.map((d) => <View key={`${d.l}-${d.t}`} style={[s.spark, { left: d.l, top: d.t, width: d.size, height: d.size, borderRadius: d.size / 2, opacity: d.o }]} />)}
      <Animated.View style={{ transform: [{ translateY }] }}>
        <View style={[s.doc, gradient('linear-gradient(145deg, #FFC56B 0%, #FFAA32 45%, #C97812 100%)')]}>
          <View style={s.docFold} />
          <View style={s.docTarget}>
            {CORNERS.map((corner, k) => <View key={k} style={[s.corner, corner]} />)}
            <Ionicons name="arrow-up" size={26} color={DARK_ON_PRIMARY} />
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

const SPARKS = [
  { l: 34, t: 40, size: 6, o: 0.9 }, { l: 196, t: 30, size: 5, o: 0.7 }, { l: 214, t: 118, size: 8, o: 0.8 },
  { l: 22, t: 140, size: 4, o: 0.6 }, { l: 168, t: 176, size: 4, o: 0.5 }, { l: 62, t: 186, size: 3, o: 0.5 },
];
const CORNERS: ViewStyle[] = [
  { top: 0, left: 0, borderTopWidth: 2, borderLeftWidth: 2, borderTopLeftRadius: 4 },
  { top: 0, right: 0, borderTopWidth: 2, borderRightWidth: 2, borderTopRightRadius: 4 },
  { bottom: 0, left: 0, borderBottomWidth: 2, borderLeftWidth: 2, borderBottomLeftRadius: 4 },
  { bottom: 0, right: 0, borderBottomWidth: 2, borderRightWidth: 2, borderBottomRightRadius: 4 },
];

function MiniInput(props: React.ComponentProps<typeof TextInput>) {
  const reveal = useRevealOnFocus();
  return <TextInput {...props} placeholderTextColor={c.textMuted} style={s.input} onFocus={(e) => { reveal(); props.onFocus?.(e); }} />;
}

const s = StyleSheet.create({
  art: { width: 240, height: 210, alignSelf: 'center', alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  glow: { position: 'absolute', width: 240, height: 210, borderRadius: 120 },
  spark: { position: 'absolute', backgroundColor: c.primary },
  doc: { width: 96, height: 118, borderRadius: 18, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-6deg' }], shadowColor: c.primary, shadowOpacity: 0.55, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 14 },
  docFold: { position: 'absolute', top: 0, right: 0, width: 26, height: 26, borderBottomLeftRadius: 10, borderTopRightRadius: 18, backgroundColor: 'rgba(255,255,255,0.35)' },
  docTarget: { width: 50, height: 50, alignItems: 'center', justifyContent: 'center' },
  corner: { position: 'absolute', width: 12, height: 12, borderColor: DARK_ON_PRIMARY },

  title: { color: c.text, fontSize: 22, fontWeight: '800', textAlign: 'center', marginTop: 4 },
  subtitle: { color: c.textSecondary, fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 8, paddingHorizontal: 6 },
  formats: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginTop: 16, marginBottom: 22 },
  formatChip: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: r.pill, backgroundColor: c.surfaceElevated, borderWidth: 1, borderColor: c.border },
  formatText: { color: c.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },

  primaryBtn: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: 18, borderRadius: r.medium, backgroundColor: '#FFFFFF', gap: 10, shadowColor: '#FFFFFF', shadowOpacity: 0.35, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 8 },
  primaryText: { flex: 1, color: DARK_ON_PRIMARY, fontSize: 15, fontWeight: '800' },
  chevron: { width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(26,18,6,0.14)', alignItems: 'center', justifyContent: 'center' },

  card: { backgroundColor: c.surface, borderRadius: r.large, borderWidth: 1, borderColor: c.border, padding: 14, ...premiumShadow },
  check: { width: 24, height: 24, borderRadius: 7, borderWidth: 2, borderColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: c.primary },
  flag: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,179,64,0.12)', borderRadius: r.small, paddingHorizontal: 10, paddingVertical: 6, marginBottom: 8 },
  flagText: { flex: 1, color: c.warning, fontSize: 11, fontWeight: '600', textTransform: 'capitalize' },
  input: { borderWidth: 1, borderColor: c.border, borderRadius: r.small, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13, marginBottom: 6, backgroundColor: c.surfaceSoft, color: c.text },
});
