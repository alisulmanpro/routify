import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { post, ApiRequestError } from '../lib/api';
import { addressKey, findEircode, formatIrishAddress, isEircode } from '../lib/irishAddress';
import type { LabelRead } from '../lib/labelText';
import { premium as c, premiumRadius as r } from '../lib/theme';
import { ErrorBanner, PButton } from './Premium';

export type CheckStatus = 'idle' | 'checking' | 'found' | 'approximate' | 'notFound' | 'error';
type Check = { found: boolean; approximate: boolean; latitude: number | null; longitude: number | null; normalized: string | null };
type Draft = {
  recipient: string; building: string; street: string; area: string; city: string; county: string; eircode: string; country: string;
  address: string; phone: string; parcelId: string;
};

const draftFrom = (read: LabelRead, parcelId: string): Draft => ({
  recipient: read.name ?? read.parts?.recipient ?? '',
  building: read.parts?.building ?? '',
  street: read.parts?.street ?? '',
  area: read.parts?.area ?? '',
  city: read.parts?.city ?? '',
  county: read.parts?.county ?? '',
  eircode: read.parts?.eircode ?? '',
  country: read.parts?.country ?? '',
  address: read.address ?? '',
  phone: read.phone ?? '',
  parcelId,
});

/**
 * Confirmation screen for a scanned label: every field is editable, the address is checked on the
 * map, and nothing is saved until the rider taps Save (with an extra confirmation if the map check
 * failed). OCR output is never treated as verified.
 */
export default function LabelReview({ read, parcelId, savedKeys, position, onStatus, onRetry, onSaved }: {
  read: LabelRead;
  parcelId: string;
  /** Address keys saved earlier in this scan session, to stop the same label being added twice. */
  savedKeys: Set<string>;
  position: { latitude: number; longitude: number } | null;
  onStatus: (status: CheckStatus) => void;
  onRetry: () => void;
  onSaved: (parcelId: string, key: string) => void;
}) {
  const irish = !!read.parts;
  const [draft, setDraft] = useState<Draft>(() => draftFrom(read, parcelId));
  const [status, setStatus] = useState<CheckStatus>('idle');
  const [check, setCheck] = useState<Check | null>(null);
  const [checkedFor, setCheckedFor] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const address = irish ? formatIrishAddress({ ...draft, country: draft.country || null }) : draft.address.trim().replace(/\s+/g, ' ');
  const stale = checkedFor !== address;
  const set = (key: keyof Draft) => (value: string) => setDraft((d) => ({ ...d, [key]: value }));

  const setBoth = useCallback((next: CheckStatus) => { setStatus(next); onStatus(next); }, [onStatus]);

  const runCheck = useCallback(async (value: string) => {
    if (value.length < 5) return;
    setBoth('checking');
    setCheckedFor(value);
    try {
      const result = (await post<Check>('/deliveries/geocode-check', { address: value, ...(position ?? {}) })).data;
      if (!mounted.current) return;
      setCheck(result);
      setBoth(!result.found ? 'notFound' : result.approximate ? 'approximate' : 'found');
    } catch (err) {
      if (!mounted.current) return;
      setCheck(null);
      setError(err instanceof ApiRequestError ? err.message : 'Could not check the address. Check your internet connection.');
      setBoth('error');
    }
  }, [position, setBoth]);

  // Check the scanned address once when the sheet opens; after edits the rider taps "Check again".
  const firstCheck = useRef(address);
  useEffect(() => { void runCheck(firstCheck.current); }, [runCheck]);

  const eircodeProblem = irish && draft.eircode.trim() && !isEircode(draft.eircode) ? 'Eircode format looks wrong (e.g. D06 YP22).' : '';
  const missing = irish
    ? [!draft.street.trim() && 'street', !(draft.city.trim() || draft.county.trim() || draft.eircode.trim()) && 'town or Eircode'].filter(Boolean)
    : [address.length < 8 && 'address'].filter(Boolean);
  const parcelProblem = draft.parcelId.trim().length < 3 ? 'Parcel ID needs at least 3 characters.' : '';

  const doSave = async () => {
    setSaving(true);
    setError('');
    try {
      await post('/deliveries/manual', {
        trackingId: draft.parcelId.trim().toUpperCase(),
        customer: { name: draft.recipient.trim(), phone: draft.phone.trim() },
        address: { raw: address },
      });
      onSaved(draft.parcelId.trim().toUpperCase(), addressKey(address));
    } catch (err) {
      if (mounted.current) setError(err instanceof ApiRequestError ? err.message : 'Could not save. Check your internet connection and try again.');
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const save = () => {
    setError('');
    if (missing.length) { setError(`Add the ${missing.join(' and ')} before saving.`); return; }
    if (eircodeProblem) { setError(eircodeProblem); return; }
    if (parcelProblem) { setError(parcelProblem); return; }
    if (savedKeys.has(addressKey(address))) { setError('This address was already added in this scan session.'); return; }
    if (stale) { void runCheck(address); return; }
    if (status === 'notFound' || status === 'error') {
      Alert.alert(
        'Location not verified',
        status === 'notFound' ? 'This address was not found on the map. It will be added without a map location and left out of route optimisation.' : 'The address could not be checked right now. Save it anyway?',
        [{ text: 'Edit address', style: 'cancel' }, { text: 'Save anyway', style: 'destructive', onPress: () => void doSave() }],
      );
      return;
    }
    void doSave();
  };

  const confidence = read.parts?.confidence ?? (read.address ? 0.5 : 0);

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={s.wrap} pointerEvents="box-none">
      <View style={s.sheet}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Ionicons name={confidence >= 0.8 ? 'checkmark-circle' : 'alert-circle'} size={20} color={confidence >= 0.8 ? c.success : c.warning} />
            <Text style={s.title}>{confidence >= 0.8 ? 'Check the details' : 'Some details may be missing'}</Text>
          </View>
          {read.parts?.issues.length ? <Text style={[s.meta, { color: c.warning }]}>{read.parts.issues.join(' · ')}. Fix or fill in below.</Text> : null}

          <Field label="Recipient" value={draft.recipient} onChange={set('recipient')} autoCapitalize="words" />
          {irish ? (
            <>
              {draft.building ? <Field label="Apartment / building" value={draft.building} onChange={set('building')} /> : null}
              <Field label="Street" value={draft.street} onChange={set('street')} />
              <Field label="Area" value={draft.area} onChange={set('area')} />
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1.3 }}><Field label="Town / city" value={draft.city} onChange={set('city')} /></View>
                <View style={{ flex: 1 }}>
                  <Field label="Eircode" value={draft.eircode} autoCapitalize="characters"
                    onChange={(v) => set('eircode')(findEircode(v) ?? v.toUpperCase())}
                    hint={draft.eircode ? (isEircode(draft.eircode) ? 'Format OK' : 'Check format') : 'Missing'}
                    hintColor={draft.eircode && isEircode(draft.eircode) ? c.success : c.warning} />
                </View>
              </View>
              {draft.county ? <Field label="County" value={draft.county} onChange={set('county')} /> : null}
            </>
          ) : (
            <Field label="Address" value={draft.address} onChange={set('address')} multiline />
          )}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Field label="Parcel ID" value={draft.parcelId} onChange={(v) => set('parcelId')(v.toUpperCase())} autoCapitalize="characters" /></View>
            <View style={{ flex: 1 }}><Field label="Phone" value={draft.phone} onChange={set('phone')} keyboardType="phone-pad" /></View>
          </View>

          <MapCheck status={stale && status !== 'checking' ? 'idle' : status} check={check} onCheck={() => void runCheck(address)} />

          <Pressable onPress={() => setShowRaw((v) => !v)} hitSlop={6}>
            <Text style={{ color: c.textSecondary, fontSize: 12, fontWeight: '700' }}>{showRaw ? 'Hide scanned text' : 'Show scanned text'}</Text>
          </Pressable>
          {showRaw ? <Text selectable style={s.raw}>{read.rawLines.join('\n') || '(no text)'}</Text> : null}

          {error ? <ErrorBanner text={error} /> : null}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
            <PButton title="Retry scan" icon="refresh" variant="secondary" onPress={onRetry} disabled={saving} style={{ flex: 1 }} />
            <PButton title={stale ? 'Check & save' : 'Save'} icon="checkmark" onPress={save} loading={saving} disabled={status === 'checking'} style={{ flex: 1.3 }} />
          </View>
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

function MapCheck({ status, check, onCheck }: { status: CheckStatus; check: Check | null; onCheck: () => void }) {
  const view: Record<CheckStatus, { icon: React.ComponentProps<typeof Ionicons>['name']; color: string; text: string }> = {
    idle: { icon: 'map-outline', color: c.textSecondary, text: 'Address changed — check it on the map.' },
    checking: { icon: 'map-outline', color: c.textSecondary, text: 'Checking the address on the map…' },
    found: { icon: 'location', color: c.success, text: `Found: ${check?.normalized ?? 'on the map'}` },
    approximate: { icon: 'locate-outline', color: c.warning, text: `Only the area matched: ${check?.normalized ?? ''}. Confirm with the customer.` },
    notFound: { icon: 'close-circle', color: c.danger, text: 'Address not found on the map. Check the street and Eircode.' },
    error: { icon: 'cloud-offline-outline', color: c.danger, text: 'Could not check the address (network).' },
  };
  const v = view[status];
  return (
    <View style={[s.check, { borderColor: v.color }]}>
      {status === 'checking' ? <ActivityIndicator size="small" color={c.primary} /> : <Ionicons name={v.icon} size={18} color={v.color} />}
      <Text style={{ flex: 1, color: v.color, fontSize: 12, fontWeight: '600' }}>{v.text}</Text>
      {status !== 'checking' && status !== 'found' ? (
        <Pressable onPress={onCheck} hitSlop={6}><Text style={{ color: c.primary, fontWeight: '800', fontSize: 12 }}>{status === 'idle' ? 'Check' : 'Check again'}</Text></Pressable>
      ) : null}
    </View>
  );
}

function Field({ label, value, onChange, hint, hintColor, multiline, autoCapitalize = 'sentences', keyboardType = 'default' }: {
  label: string; value: string; onChange: (v: string) => void; hint?: string; hintColor?: string; multiline?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters'; keyboardType?: 'default' | 'phone-pad';
}) {
  return (
    <View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={s.label}>{label}</Text>
        {hint ? <Text style={[s.label, { color: hintColor ?? c.textMuted }]}>{hint}</Text> : null}
      </View>
      <TextInput value={value} onChangeText={onChange} multiline={multiline} autoCapitalize={autoCapitalize} keyboardType={keyboardType}
        placeholder={`Add ${label.toLowerCase()}`} placeholderTextColor={c.textMuted}
        style={[s.input, multiline && { minHeight: 64, textAlignVertical: 'top' }]} />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, bottom: 0, top: 0, justifyContent: 'flex-end' },
  sheet: { maxHeight: '78%', margin: 10, borderRadius: r.large, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  title: { color: c.text, fontSize: 16, fontWeight: '800' },
  meta: { color: c.textSecondary, fontSize: 12 },
  label: { color: c.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 },
  input: { minHeight: 42, borderRadius: r.small, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceSoft, color: c.text, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: r.small, borderWidth: 1, backgroundColor: c.surfaceSoft },
  raw: { color: c.textSecondary, fontSize: 11, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), backgroundColor: c.background, padding: 10, borderRadius: r.small },
});
