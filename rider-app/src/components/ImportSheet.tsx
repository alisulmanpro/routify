import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { KeyboardAwareScrollView, RevealingTextInput } from './KeyboardAware';
import { LightButton, LightError, LightPill, LightProgress } from './LightKit';
import { postFile, ApiRequestError } from '../lib/api';
import { submitStops } from '../lib/outbox';
import { checkAddress, checkAddresses } from '../lib/stops';
import { checkRow, ISSUE_LABEL, lookupText, type Accepted, type AddressCheck, type ImportIssue } from '../lib/importCheck';
import type { NewStop } from '../lib/v2api';
import type { Delivery, ImportDraft } from '../lib/types';
import { light as c, lightRadius as lr } from '../lib/theme';

type Point = { latitude: number; longitude: number };

/** A row of the file the rider still has to decide on. */
type Problem = {
  key: string; index: number; address: string; parcel: string; edited: boolean;
  issue: ImportIssue; detail: string; check: AddressCheck | null;
  state: 'open' | 'busy' | 'added' | 'skipped'; error: string;
};
type Phase =
  | { kind: 'pick' }
  | { kind: 'reading' }
  | { kind: 'checking'; done: number; total: number }
  | { kind: 'adding'; count: number }
  | { kind: 'review'; added: number; total: number };

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

type Props = {
  visible: boolean; date: string; stops: readonly Delivery[]; near: Point | null;
  /** Eircodes the rider picked from a photo of a sheet: checked and added the same way as a file's rows. */
  eircodes?: readonly string[] | null;
  onClose: () => void;
  /** Stops saved by the import (called as they are added, not only at the end). */
  onImported: (created: Delivery[]) => void;
};

/**
 * Import from a file. The rows are checked on the map first; the ones placed at the door, on the street the file
 * names and not already on the list are added at once. Every other row waits on a card that says what is wrong
 * (not found, a different street, only the area, already added) until the rider fixes, accepts or skips it.
 */
export default function ImportSheet({ visible, ...props }: Props) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={props.onClose}>
      {visible ? <ImportBody {...props} /> : null}
    </Modal>
  );
}

const toNewStop = (address: string, parcel: string, date: string, point: Point | null, normalized: string | null, secondParcel = false): NewStop => ({
  trackingId: parcel.trim().toUpperCase(),
  address: { raw: address.trim(), ...(normalized && normalized !== address.trim() ? { normalized: normalized.slice(0, 400) } : {}) },
  serviceDate: date,
  ...(point ? { location: point } : {}),
  ...(secondParcel ? { secondParcel: true } : {}),
});

// Mounted fresh each time the sheet opens, so it always starts at "Choose file".
function ImportBody({ date, stops, near, eircodes, onClose, onImported }: Omit<Props, 'visible'>) {
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>(eircodes?.length ? { kind: 'checking', done: 0, total: eircodes.length } : { kind: 'pick' });
  const [problems, setProblems] = useState<Problem[]>([]);
  const [error, setError] = useState('');
  // Stops saved during this import, for the duplicate check of rows fixed later.
  const saved = useRef<Delivery[]>([]);
  const added = (created: Delivery[]) => { saved.current = [...saved.current, ...created]; onImported(created); };

  /** Checks rows on the map, adds the good ones at once and keeps the rest for the rider. */
  const addRows = async (items: { index: number; address: string; parcel: string }[]) => {
    // 1. Every address on the map (only the ones long enough to look up).
    setPhase({ kind: 'checking', done: 0, total: items.length });
    const askable = items.filter((item) => item.address.length >= 5);
    let checks: AddressCheck[] = [];
    try {
      checks = await checkAddresses(askable.map((item) => lookupText(item.address)), near, (done) => setPhase({ kind: 'checking', done, total: askable.length }));
    } catch (err) {
      // The check itself failed (offline, daily limit): nothing is added; every row says why and can be checked again.
      setError(err instanceof ApiRequestError ? err.message : 'Could not check the addresses. Check your connection, then check each one again.');
    }
    const checkOf = new Map(askable.map((item, i) => [item.index, checks[i] ?? null]));

    // 2. Sort the rows, in file order, so a repeat is caught against the rows before it.
    const accepted: (Accepted & { parcel: string })[] = [];
    const waiting: Problem[] = [];
    for (const item of items) {
      const verdict = checkRow(item.address, checkOf.get(item.index) ?? null, stops, accepted);
      if (verdict.status === 'ready') {
        accepted.push({ id: `row-${item.index}`, raw: item.address, normalized: verdict.normalized, eircode: verdict.eircode, point: verdict.point, precise: verdict.precise, parcel: item.parcel });
      } else {
        waiting.push({ key: `row-${item.index}`, index: item.index, address: item.address, parcel: item.parcel, edited: false,
          issue: verdict.issue, detail: verdict.detail, check: verdict.check, state: 'open', error: '' });
      }
    }

    // 3. The good rows are added at once. If the server refuses the batch (e.g. a parcel ID already used), they are
    // added one by one so only the refused rows wait for the rider.
    setPhase({ kind: 'adding', count: accepted.length });
    let addedCount = 0;
    if (accepted.length) {
      const news = accepted.map((row) => toNewStop(row.raw, row.parcel, date, row.point, row.normalized));
      try {
        added(await submitStops(news));
        addedCount = accepted.length;
      } catch {
        for (let i = 0; i < accepted.length; i += 1) {
          try {
            added(await submitStops([news[i]]));
            addedCount += 1;
          } catch (err) {
            const row = accepted[i];
            waiting.push({ key: row.id, index: Number(row.id.slice(4)), address: row.raw, parcel: row.parcel, edited: false, issue: 'lookup_failed',
              detail: err instanceof ApiRequestError ? err.message : 'Could not save this stop.', check: null, state: 'open', error: '' });
          }
        }
      }
    }
    setProblems(waiting.sort((a, b) => a.index - b.index));
    setPhase({ kind: 'review', added: addedCount, total: items.length });
  };

  const run = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: [...Object.values(MIME_BY_EXT)], copyToCacheDirectory: true });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const ext = asset.name.split('.').pop()?.toLowerCase() || '';
    setError('');
    setPhase({ kind: 'reading' });
    try {
      const draft = (await postFile<ImportDraft>('/deliveries/import/file', asset.uri, 'file', asset.mimeType || MIME_BY_EXT[ext] || 'application/octet-stream', asset.name)).data;
      const items = draft.items.map((item, index) => ({ index, address: item.address.trim(), parcel: item.trackingId.trim() }));
      if (!items.length) { setError('No addresses were found in this file. Check it has one address per line or row.'); setPhase({ kind: 'pick' }); return; }
      await addRows(items);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not read this file. Check your connection and try again.');
      setPhase({ kind: 'pick' });
    }
  };

  // Eircodes from a photo: no file to read, straight to the check (once, when the sheet opens).
  const fromPhoto = useRef(eircodes);
  useEffect(() => {
    const codes = fromPhoto.current;
    if (!codes?.length) return;
    addRows(codes.map((code, index) => ({ index, address: code, parcel: '' }))).catch((err) => {
      setError(err instanceof ApiRequestError ? err.message : 'Could not add these stops. Check your connection and try again.');
      setPhase({ kind: 'review', added: 0, total: codes.length });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once for the codes the sheet opened with
  }, []);

  const patch = useCallback((key: string, change: Partial<Problem>) => setProblems((list) => list.map((p) => (p.key === key ? { ...p, ...change } : p))), []);

  // Every row added in this import, as stops, for the duplicate check of a row fixed now.
  const known = () => [...stops, ...saved.current];

  const save = async (p: Problem, point: Point | null, normalized: string | null, secondParcel = false) => {
    added(await submitStops([toNewStop(p.address, p.parcel, date, point, normalized, secondParcel)]));
    patch(p.key, { state: 'added', error: '' });
  };

  /** Check again (after an edit, or a failed lookup): added at once when the map now places it at the door. */
  const recheck = async (p: Problem) => {
    patch(p.key, { state: 'busy', error: '' });
    try {
      const check = p.address.trim().length >= 5 ? await checkAddress(lookupText(p.address), near) : null;
      const verdict = checkRow(p.address, check, known(), []);
      if (verdict.status === 'ready') { await save(p, verdict.point, verdict.normalized); return; }
      patch(p.key, { state: 'open', issue: verdict.issue, detail: verdict.detail, check: verdict.check, edited: false });
    } catch (err) {
      patch(p.key, { state: 'open', error: err instanceof ApiRequestError ? err.message : 'Could not check this address. Check your connection.' });
    }
  };

  /** The rider's call: the map's address (area or other street), or a second parcel for a stop already added. */
  const accept = async (p: Problem) => {
    patch(p.key, { state: 'busy', error: '' });
    try {
      const point = p.check?.found && p.check.latitude != null && p.check.longitude != null ? { latitude: p.check.latitude, longitude: p.check.longitude } : null;
      await save(p, point, p.check?.normalized ?? null, p.issue === 'duplicate');
    } catch (err) {
      patch(p.key, { state: 'open', error: err instanceof ApiRequestError ? err.message : 'Could not add this stop.' });
    }
  };

  const open = problems.filter((p) => p.state === 'open' || p.state === 'busy').length;
  const fixedCount = problems.filter((p) => p.state === 'added').length;

  return (
    <View style={{ flex: 1, backgroundColor: c.background, paddingTop: insets.top + 8 }}>
      <StatusBar style="dark" />
      <View style={s.header}>
        <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close"><Ionicons name="arrow-back" size={26} color={c.text} /></Pressable>
        <Text style={s.title}>{eircodes?.length ? 'Add from photo' : 'Import stops'}</Text>
      </View>

      {phase.kind === 'pick' ? (
        <View style={[s.center, { paddingBottom: insets.bottom + 24 }]}>
          <View style={s.art}><MaterialCommunityIcons name="file-document-multiple-outline" size={44} color={c.link} /></View>
          <Text style={s.lead}>Add a whole list of stops from a file</Text>
          <Text style={s.body}>A courier manifest or a list with one address per line. Every address is checked on the map: the ones it finds are added straight away, the rest are shown for you to fix.</Text>
          <View style={s.formats}>{FORMATS.map((f) => <LightPill key={f} text={f} />)}</View>
          <LightError text={error} />
          <LightButton title="Choose file" icon={<Ionicons name="document-outline" size={20} color={c.onInk} />} onPress={() => void run()} style={{ alignSelf: 'stretch', marginTop: 16 }} />
        </View>
      ) : phase.kind === 'reading' || phase.kind === 'checking' || phase.kind === 'adding' ? (
        <View style={s.center}>
          <View style={s.art}><MaterialCommunityIcons name={phase.kind === 'reading' ? 'file-search-outline' : phase.kind === 'checking' ? 'map-search-outline' : 'playlist-plus'} size={44} color={c.link} /></View>
          <Text style={s.lead}>{phase.kind === 'reading' ? 'Reading your file…' : phase.kind === 'checking' ? 'Checking the addresses on the map…' : `Adding ${phase.count} stops…`}</Text>
          {phase.kind === 'checking' ? (
            <>
              <LightProgress progress={phase.total ? (phase.done / phase.total) * 100 : 0} style={{ alignSelf: 'stretch', marginTop: 20 }} />
              <Text style={[s.body, { marginTop: 10 }]}>{phase.done} of {phase.total}</Text>
            </>
          ) : null}
        </View>
      ) : (
        <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: insets.bottom + 120 }}>
          <View style={s.summary}>
            <Summary icon="check-circle" tone={c.success} value={phase.added + fixedCount} label="added" />
            <Summary icon="alert-circle" tone={open ? c.warning : c.textSecondary} value={open} label={open === 1 ? 'needs a fix' : 'need a fix'} />
            <Summary icon="file-document-outline" tone={c.textSecondary} value={phase.total} label={eircodes?.length ? 'picked' : 'in the file'} />
          </View>
          <LightError text={error} />
          {problems.length ? (
            <>
              <Text style={s.section}>Check these before they are added</Text>
              <Text style={[s.body, { textAlign: 'left', marginBottom: 12 }]}>Fix the address and check again, use what the map found, or skip the stop.</Text>
              <View style={{ gap: 12 }}>
                {problems.map((p) => <ProblemCard key={p.key} p={p} onEdit={patch} onRecheck={recheck} onAccept={accept} />)}
              </View>
            </>
          ) : (
            <View style={[s.center, { flex: 0, paddingTop: 32 }]}>
              <View style={[s.art, { backgroundColor: c.successBg }]}><Ionicons name="checkmark" size={44} color={c.success} /></View>
              <Text style={s.lead}>All {phase.added} stops added</Text>
              <Text style={s.body}>Every address was found on the map.</Text>
            </View>
          )}
        </KeyboardAwareScrollView>
      )}

      {phase.kind === 'review' ? (
        <View style={[s.footer, { paddingBottom: insets.bottom + 14 }]}>
          <LightButton title={open ? `Done · ${open} not added` : 'Done'} onPress={onClose} />
        </View>
      ) : null}
    </View>
  );
}

function Summary({ icon, tone, value, label }: { icon: 'check-circle' | 'alert-circle' | 'file-document-outline'; tone: string; value: number; label: string }) {
  return (
    <View style={s.stat}>
      <MaterialCommunityIcons name={icon} size={20} color={tone} />
      <Text style={{ color: c.text, fontSize: 22, fontWeight: '700', marginTop: 4 }}>{value}</Text>
      <Text style={{ color: c.textSecondary, fontSize: 13 }}>{label}</Text>
    </View>
  );
}

const ACCEPT_LABEL: Partial<Record<ImportIssue, string>> = { different: 'Use map address', approximate: 'Use the area', duplicate: 'Add anyway' };

/** One row that was not added: what is wrong, the address to fix, and the rider's choices. */
const ProblemCard = memo(function ProblemCard({ p, onEdit, onRecheck, onAccept }: {
  p: Problem; onEdit: (key: string, change: Partial<Problem>) => void; onRecheck: (p: Problem) => void; onAccept: (p: Problem) => void;
}) {
  if (p.state === 'added' || p.state === 'skipped') {
    return (
      <View style={[s.card, s.cardDone]}>
        <Ionicons name={p.state === 'added' ? 'checkmark-circle' : 'remove-circle-outline'} size={20} color={p.state === 'added' ? c.success : c.textSecondary} />
        <Text style={{ flex: 1, color: c.textSecondary, fontSize: 14 }} numberOfLines={1}>{p.address || `Row ${p.index + 1}`}</Text>
        <Text style={{ color: p.state === 'added' ? c.success : c.textSecondary, fontSize: 13, fontWeight: '600' }}>{p.state === 'added' ? 'Added' : 'Skipped'}</Text>
        {p.state === 'skipped' ? <Pressable onPress={() => onEdit(p.key, { state: 'open' })} hitSlop={8}><Text style={s.link}>Undo</Text></Pressable> : null}
      </View>
    );
  }
  const busy = p.state === 'busy';
  const acceptLabel = ACCEPT_LABEL[p.issue];
  // Once the address is edited, the map's old answer no longer applies: only Check again.
  const canAccept = !!acceptLabel && !p.edited && (p.issue === 'duplicate' || !!p.check?.found);
  return (
    <View style={s.card}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Text style={{ flex: 1, color: c.textSecondary, fontSize: 13, fontWeight: '600' }}>Row {p.index + 1}</Text>
        <LightPill text={ISSUE_LABEL[p.issue]} tone={p.issue === 'duplicate' ? 'blue' : 'amber'} />
      </View>
      <Text style={{ color: c.textLabel, fontSize: 14, lineHeight: 20, marginBottom: 10 }}>{p.detail}</Text>
      <RevealingTextInput value={p.address} onChangeText={(v) => onEdit(p.key, { address: v, edited: true })} placeholder="Address or Eircode"
        placeholderTextColor={c.placeholder} multiline style={s.input} editable={!busy} />
      <RevealingTextInput value={p.parcel} onChangeText={(v) => onEdit(p.key, { parcel: v })} placeholder="Parcel ID (optional)"
        placeholderTextColor={c.placeholder} autoCapitalize="characters" autoCorrect={false} style={[s.input, { marginTop: 8 }]} editable={!busy} />
      {p.error ? <View style={{ marginTop: 8 }}><LightError text={p.error} /></View> : null}
      <View style={s.actions}>
        <LightButton title="Check again" variant={canAccept ? 'outline' : 'solid'} loading={busy} onPress={() => onRecheck(p)} style={s.action} />
 {canAccept && acceptLabel ? <LightButton title={acceptLabel} variant="solid" disabled={busy} onPress={() => onAccept(p)} style={s.action} /> : null}
      </View>
      <Pressable onPress={() => onEdit(p.key, { state: 'skipped' })} disabled={busy} hitSlop={8} style={{ alignSelf: 'center', marginTop: 10 }}>
        <Text style={s.link}>Skip this stop</Text>
      </Pressable>
    </View>
  );
});

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 18, paddingHorizontal: 24, paddingBottom: 16 },
  title: { color: c.text, fontSize: 24, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  art: { width: 96, height: 96, borderRadius: 48, backgroundColor: c.linkBg, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  lead: { color: c.text, fontSize: 19, fontWeight: '600', textAlign: 'center' },
  body: { color: c.textSecondary, fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 8 },
  formats: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 20, marginBottom: 8 },
  summary: { flexDirection: 'row', gap: 10, marginBottom: 20 },
  stat: { flex: 1, padding: 12, borderRadius: lr.field, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
  section: { color: c.text, fontSize: 18, fontWeight: '600', marginTop: 4 },
  card: { padding: 16, borderRadius: lr.field, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
  cardDone: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, backgroundColor: c.soft },
  input: { borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15, color: c.text, backgroundColor: c.surface },
  actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  action: { flex: 1, minHeight: 46 },
  link: { color: c.link, fontSize: 14, fontWeight: '600' },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 24, paddingTop: 12, backgroundColor: c.background, borderTopWidth: 1, borderTopColor: c.border },
});
