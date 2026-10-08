import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { post, ApiRequestError } from '../lib/api';
import { Screen } from '../components/Kit';
import { ErrorBanner, Header, PButton, PCard, PInput, SectionLabel } from '../components/Premium';
import { premium as c } from '../lib/theme';
import { useNav } from '../lib/nav';

export default function AddManual({ onCreated }: { onCreated: () => void }) {
  const { goBack } = useNav();
  const [form, setForm] = useState({ trackingId: '', address: '', customerName: '', phone: '', note: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await post('/deliveries/manual', {
        trackingId: form.trackingId.trim(),
        customer: { name: form.customerName.trim(), phone: form.phone.trim() },
        address: { raw: form.address.trim() },
        note: form.note.trim() || undefined,
      });
      onCreated();
      goBack();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not add this delivery');
    } finally { setBusy(false); }
  };

  const valid = form.trackingId.trim().length >= 3 && form.address.trim().length >= 5;

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 14 }} keyboardShouldPersistTaps="handled">
        <Header eyebrow="New stop" eyebrowIcon="file-document-edit-outline" title="Manual entry" subtitle="Only the parcel ID and address are required." />
        <ErrorBanner text={error} />

        <PCard style={{ gap: 14 }}>
          <View>
            <SectionLabel>Parcel ID</SectionLabel>
            <PInput icon="barcode-outline" value={form.trackingId} onChangeText={(v) => set('trackingId')(v.toUpperCase())} placeholder="e.g. PK-1001" autoCapitalize="characters" />
          </View>
          <View>
            <SectionLabel>Delivery address</SectionLabel>
            <PInput icon="location-outline" value={form.address} onChangeText={set('address')} placeholder="House 12, Street 4, City" multiline />
          </View>
        </PCard>

        <PCard style={{ gap: 14 }}>
          <View>
            <SectionLabel>Customer name (optional)</SectionLabel>
            <PInput icon="person-outline" value={form.customerName} onChangeText={set('customerName')} placeholder="e.g. Nadia Khan" autoCapitalize="words" />
          </View>
          <View>
            <SectionLabel>Phone (optional)</SectionLabel>
            <PInput icon="call-outline" value={form.phone} onChangeText={set('phone')} placeholder="e.g. 0300-1111111" keyboardType="phone-pad" />
          </View>
          <View>
            <SectionLabel>Note (optional)</SectionLabel>
            <PInput icon="document-text-outline" value={form.note} onChangeText={set('note')} placeholder="Fragile, call before arriving…" multiline />
          </View>
        </PCard>

        <PButton title="Add delivery" icon="add-circle-outline" onPress={submit} loading={busy} disabled={!valid} chevron />
      </ScrollView>
    </Screen>
  );
}
