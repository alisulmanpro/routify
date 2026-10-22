import { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { KeyboardAwareScrollView, RevealingTextInput } from './KeyboardAware';
import { postFile, ApiRequestError } from '../lib/api';
import { submitStops } from '../lib/outbox';
import { findDuplicate } from '../lib/duplicates';
import { findEircode } from '../lib/format';
import type { Delivery, ImportDraft, ImportDraftItem } from '../lib/types';
import { premium as c, premiumRadius as r } from '../lib/theme';
import { DARK_ON_PRIMARY, ErrorBanner, PButton } from './Premium';

type Row = ImportDraftItem & { include: boolean };

/**
 * Rows start unticked when they repeat a stop already on the list or an earlier row of the file (same Eircode), so
 * nothing is added twice unless the rider ticks it again on purpose.
 */
function toRows(items: ImportDraftItem[], stops: readonly Delivery[]): Row[] {
  const seen = new Set<string>();
  return items.map((item) => {
    const code = findEircode(item.address);
    const repeat = !!code && (seen.has(code) || !!findDuplicate({ eircode: code }, stops));
    if (code) seen.add(code);
    const flags = repeat && !item.flags.includes('duplicate') ? [...item.flags, 'duplicate'] : item.flags;
    return { ...item, flags, include: !flags.includes('duplicate') && item.address.trim().length >= 5 };
  });
}

const FORMATS = ['PDF', 'Word', 'Excel', 'CSV', 'TXT'];
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  txt: 'text/plain',
};

/** Reads a manifest or a plain address list, lets the rider check the stops, then adds them in one go. */
type Props = { visible: boolean; date: string; stops: readonly Delivery[]; onClose: () => void; onImported: (created: Delivery[]) => void };

export default function ImportSheet({ visible, ...props }: Props) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={props.onClose}>
      {visible ? <ImportBody {...props} /> : null}
    </Modal>
  );
}

// Mounted fresh each time the sheet opens, so it always starts at "Choose file".
function ImportBody({ date, stops, onClose, onImported }: Omit<Props, 'visible'>) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pick = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: [...Object.values(MIME_BY_EXT)], copyToCacheDirectory: true });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const ext = asset.name.split('.').pop()?.toLowerCase() || '';
    setBusy(true);
    setError('');
    try {
      const res = await postFile<ImportDraft>('/deliveries/import/file', asset.uri, 'file', asset.mimeType || MIME_BY_EXT[ext] || 'application/octet-stream', asset.name);
      setRows(toRows(res.data.items, stops));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not read this file. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs!.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  const add = async () => {
    const chosen = (rows || []).filter((row) => row.include);
    const bad = chosen.findIndex((row) => row.address.trim().length < 5);
    if (bad >= 0) { setError(`Stop ${bad + 1} needs a full address (or untick it).`); return; }
    setBusy(true);
    setError('');
    try {
      // Through the outbox: one request per 500 stops, each with the phone's own id (a retry never imports a stop twice);
      // offline they are kept on the phone and sent later.
      onImported(await submitStops(chosen.map((row) => ({ trackingId: row.trackingId.trim(), address: { raw: row.address.trim() }, serviceDate: date }))));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not add these stops');
    } finally {
      setBusy(false);
    }
  };

  const count = rows?.filter((row) => row.include).length ?? 0;

  return (
    <View style={{ flex: 1, backgroundColor: c.background, paddingTop: Platform.OS === 'ios' ? 50 : 16 }}>
      <View style={s.top}>
        <Text style={s.title}>{rows ? `Review ${rows.length} stops` : 'Import from file'}</Text>
        <Pressable onPress={onClose} hitSlop={10} style={s.close}><Ionicons name="close" size={20} color={c.text} /></Pressable>
      </View>

      <KeyboardAwareScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
        <ErrorBanner text={error} />
        {!rows ? (
          <View style={{ alignItems: 'center', paddingTop: 30 }}>
            <View style={s.art}><MaterialCommunityIcons name="file-upload-outline" size={44} color={c.primary} /></View>
            <Text style={[s.hint, { textAlign: 'center', marginTop: 16 }]}>Pick a courier manifest or a list with one address per line. You can check every stop before it is added.</Text>
            <View style={s.formats}>{FORMATS.map((f) => <View key={f} style={s.formatChip}><Text style={s.formatText}>{f}</Text></View>)}</View>
            <PButton title={busy ? 'Reading your file…' : 'Choose file'} icon="document-outline" onPress={() => void pick()} loading={busy} style={{ alignSelf: 'stretch' }} />
          </View>
        ) : (
          <>
            <Text style={[s.hint, { marginBottom: 12 }]}>Untick anything you don&apos;t want. Parcel IDs are optional.</Text>
            <View style={{ gap: 10 }}>
              {rows.map((row, i) => (
                <View key={`${i}-${row.trackingId}`} style={[s.card, !row.include && { opacity: 0.5 }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <Text style={{ flex: 1, color: c.textMuted, fontWeight: '800', fontSize: 11 }}>STOP {i + 1}{row.flags.includes('duplicate') ? ' · ALREADY ADDED' : ''}</Text>
                    <Pressable onPress={() => update(i, { include: !row.include })} hitSlop={8} style={[s.check, row.include && s.checkOn]}>
                      {row.include ? <Ionicons name="checkmark" size={15} color={DARK_ON_PRIMARY} /> : null}
                    </Pressable>
                  </View>
                  <RevealingTextInput value={row.address} onChangeText={(v) => update(i, { address: v })} placeholder="Address" placeholderTextColor={c.textMuted} multiline style={s.input} />
                  <RevealingTextInput value={row.trackingId} onChangeText={(v) => update(i, { trackingId: v })} placeholder="Parcel ID (optional)" placeholderTextColor={c.textMuted} autoCapitalize="characters" style={s.input} />
                </View>
              ))}
            </View>
            <PButton title={`Add ${count} stop${count === 1 ? '' : 's'}`} icon="add-circle-outline" onPress={() => void add()} loading={busy} disabled={!count} style={{ marginTop: 16 }} />
            <PButton title="Choose another file" icon="document-outline" variant="secondary" onPress={() => void pick()} disabled={busy} style={{ marginTop: 10 }} />
          </>
        )}
      </KeyboardAwareScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8 },
  title: { flex: 1, color: c.text, fontSize: 18, fontWeight: '800' },
  close: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.surfaceSoft, alignItems: 'center', justifyContent: 'center' },
  hint: { color: c.textSecondary, fontSize: 13, lineHeight: 19 },
  art: { width: 96, height: 96, borderRadius: 48, backgroundColor: 'rgba(255,170,50,0.12)', alignItems: 'center', justifyContent: 'center' },
  formats: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 16, marginBottom: 22 },
  formatChip: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: r.pill, backgroundColor: c.surfaceElevated, borderWidth: 1, borderColor: c.border },
  formatText: { color: c.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  card: { backgroundColor: c.surface, borderRadius: r.medium, borderWidth: 1, borderColor: c.border, padding: 12 },
  check: { width: 24, height: 24, borderRadius: 7, borderWidth: 2, borderColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: c.primary },
  input: { borderWidth: 1, borderColor: c.border, borderRadius: r.small, paddingHorizontal: 12, paddingVertical: 9, fontSize: 13, marginBottom: 6, backgroundColor: c.surfaceSoft, color: c.text },
});
