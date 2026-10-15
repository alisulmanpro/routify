import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ApiRequestError } from '../lib/api';
import { saveScannedLabel } from '../lib/deliveryActions';
import { findEircode, findUkPostcode } from '../lib/irishAddress';
import { composeAddress, labelKey, type FieldKey, type LabelFields } from '../lib/labelText';
import { premium as c, premiumRadius as r } from '../lib/theme';
import { ErrorBanner, PButton } from './Premium';

const ROWS: { key: Exclude<FieldKey, 'postalCode'>; label: string; required: boolean; placeholder: string }[] = [
  { key: 'name', label: 'Name', required: true, placeholder: 'Recipient name' },
  { key: 'street', label: 'Street', required: true, placeholder: 'House number and street' },
  { key: 'city', label: 'Town / city', required: true, placeholder: 'Town or city' },
  { key: 'county', label: 'County', required: false, placeholder: 'e.g. Co. Louth' },
  { key: 'country', label: 'Country', required: false, placeholder: 'e.g. Ireland' },
];

/**
 * The scanned label's result: postcode, name and address parts, with Cancel and Save. Fields the
 * scanner is unsure of (or didn't find) are marked yellow; the rider taps one to fix just that
 * field. A partly read label can still be saved.
 */
export default function LabelResult({ fields, parcelId, savedKeys, onCancel, onSaved }: {
  fields: LabelFields;
  parcelId: string;
  /** Label keys (`labelKey`) saved earlier in this scan session, to stop the same label being added twice. */
  savedKeys: Set<string>;
  onCancel: () => void;
  onSaved: (parcelId: string, key: string) => void;
}) {
  const [draft, setDraft] = useState<LabelFields>(fields);
  const [editing, setEditing] = useState<FieldKey | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const address = composeAddress(draft);
  const canSave = !!(draft.postalCode || draft.street);

  const change = (key: FieldKey, value: string) => setDraft((d) => ({ ...d, [key]: value || null, confidence: { ...d.confidence, [key]: value.trim() ? 'high' : 'missing' } }));
  const finishEdit = () => {
    // A typed postcode is tidied to the usual format ("a92edwe" → "A92 EDWE").
    if (editing === 'postalCode' && draft.postalCode) {
      const typed = draft.postalCode;
      change('postalCode', findEircode(typed) ?? findUkPostcode(typed) ?? typed.toUpperCase().trim());
    }
    setEditing(null);
  };

  const save = async () => {
    const key = labelKey(draft);
    if (savedKeys.has(key)) { setError('This address was already added in this scan session.'); return; }
    setSaving(true);
    setError('');
    try {
      await saveScannedLabel({ parcelId, name: draft.name ?? '', phone: '', address });
      onSaved(parcelId.trim().toUpperCase(), key);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save. Check your internet connection and try again.');
      setSaving(false);
    }
  };

  const postalState = draft.confidence.postalCode;
  return (
    <KeyboardAvoidingView style={s.wrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined} pointerEvents="box-none">
      <View style={s.sheet}>
        {editing === 'postalCode' ? (
          <TextInput
            style={[s.postal, s.postalInput]}
            value={draft.postalCode ?? ''}
            onChangeText={(v) => change('postalCode', v)}
            onBlur={finishEdit}
            onSubmitEditing={finishEdit}
            autoFocus
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="A92 EDWE"
            placeholderTextColor={c.textMuted}
          />
        ) : (
          <Pressable onPress={() => setEditing('postalCode')} style={[s.postalBox, postalState !== 'high' && s.warn]} accessibilityLabel="Edit postcode">
            {draft.postalCode
              ? <Text style={s.postal} selectable>{draft.postalCode}</Text>
              : <Text style={[s.postal, s.missingPostal]}>No postcode found</Text>}
            {postalState !== 'high' ? <WarnTag text={draft.postalCode ? 'Check' : 'Tap to add'} /> : <Ionicons name="create-outline" size={16} color={c.textMuted} />}
          </Pressable>
        )}

        <View style={{ marginTop: 10, gap: 6 }}>
          {ROWS.map(({ key, label, required, placeholder }) => {
            const value = draft[key];
            const state = draft.confidence[key];
            // Optional parts that simply aren't on the label stay quiet.
            if (!value && !required && editing !== key) return null;
            const flagged = state === 'low' || (state === 'missing' && required);
            return (
              <Pressable key={key} onPress={() => setEditing(key)} style={[s.row, flagged && s.warn]} accessibilityLabel={`Edit ${label}`}>
                <Text style={s.rowLabel}>{label}</Text>
                {editing === key ? (
                  <TextInput
                    style={[s.rowValue, s.rowInput]}
                    value={value ?? ''}
                    onChangeText={(v) => change(key, v)}
                    onBlur={finishEdit}
                    onSubmitEditing={finishEdit}
                    autoFocus
                    autoCapitalize={key === 'name' ? 'words' : 'characters'}
                    placeholder={placeholder}
                    placeholderTextColor={c.textMuted}
                  />
                ) : (
                  <Text style={[s.rowValue, !value && s.rowMissing]} numberOfLines={2}>{value || 'Not found — tap to add'}</Text>
                )}
                {flagged && editing !== key ? <Ionicons name="alert-circle" size={16} color={c.warning} /> : null}
              </Pressable>
            );
          })}
        </View>

        {!draft.postalCode && canSave ? <Text style={s.note}>Saving without a postcode: the map location may be less exact.</Text> : null}
        {error ? <View style={{ marginTop: 10 }}><ErrorBanner text={error} /></View> : null}
        <View style={s.buttons}>
          <PButton title="Cancel" variant="secondary" onPress={onCancel} disabled={saving} style={{ flex: 1 }} />
          <PButton title="Save" icon="checkmark" onPress={() => void save()} loading={saving} disabled={!canSave}style={{ flex: 1.3 }} />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function WarnTag({ text }: { text: string }) {
  return (
    <View style={s.warnTag}>
      <Ionicons name="alert-circle" size={13} color="#2B1A00" />
      <Text style={s.warnTagText}>{text}</Text>
    </View>
  );
}

const WARN_BG = 'rgba(255,179,64,0.12)';

const s = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, justifyContent: 'flex-end' },
  sheet: { margin: 10, padding: 16, borderRadius: r.large, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  postalBox: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: 'transparent' },
  postal: { color: c.text, fontSize: 30, fontWeight: '900', letterSpacing: 1 },
  postalInput: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: c.primary },
  missingPostal: { color: c.warning, fontSize: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, borderWidth: 1, borderColor: c.border },
  rowLabel: { width: 78, color: c.textMuted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  rowValue: { flex: 1, color: c.text, fontSize: 14, fontWeight: '600' },
  rowInput: { paddingVertical: 0 },
  rowMissing: { color: c.warning, fontWeight: '500', fontStyle: 'italic' },
  warn: { borderColor: c.warning, backgroundColor: WARN_BG },
  warnTag: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: r.pill, backgroundColor: c.warning },
  warnTagText: { color: '#2B1A00', fontSize: 11, fontWeight: '800' },
  note: { color: c.textSecondary, fontSize: 12, marginTop: 10 },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 14 },
});
