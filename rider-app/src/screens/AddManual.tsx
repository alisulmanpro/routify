import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { post, ApiRequestError } from '../lib/api';
import { Banner, Button, Field, Screen } from '../components/Kit';
import { colors, radius, spacing } from '../lib/theme';
import { useNav } from '../lib/nav';

export default function AddManual({ onCreated }: { onCreated: () => void }) {
  const { goBack } = useNav();
  const [paymentType, setPaymentType] = useState<'prepaid' | 'cod'>('prepaid');
  const [form, setForm] = useState({ trackingId: '', customerName: '', phone: '', address: '', orderValue: '', codAmount: '', note: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await post('/deliveries/manual', {
        trackingId: form.trackingId.trim(), customer: { name: form.customerName.trim(), phone: form.phone.trim() },
        address: { raw: form.address.trim() }, note: form.note.trim() || undefined,
        payment: paymentType === 'prepaid' ? { type: 'prepaid', orderValue: form.orderValue ? Number(form.orderValue) : undefined } : { type: 'cod', codAmount: Number(form.codAmount) },
      });
      onCreated();
      goBack();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not add this delivery');
    } finally { setBusy(false); }
  };

  const valid = form.trackingId && form.customerName && form.phone && form.address && (paymentType === 'prepaid' || Number(form.codAmount) > 0);

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: spacing(5) }} keyboardShouldPersistTaps="handled">
        <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text, marginBottom: spacing(4) }}>Add delivery</Text>
        {error ? <Banner text={error} /> : null}
        <Field label="Tracking ID" value={form.trackingId} onChangeText={(v) => setForm({ ...form, trackingId: v })} placeholder="PK-1001" autoCapitalize="characters" />
        <Field label="Customer name" value={form.customerName} onChangeText={(v) => setForm({ ...form, customerName: v })} placeholder="Nadia Khan" />
        <Field label="Phone" keyboardType="phone-pad" value={form.phone} onChangeText={(v) => setForm({ ...form, phone: v })} placeholder="0300-1111111" />
        <Field label="Address" value={form.address} onChangeText={(v) => setForm({ ...form, address: v })} placeholder="House 12, Street 4, Karachi" multiline />

        <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 8 }}>Payment</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: spacing(4) }}>
          {(['prepaid', 'cod'] as const).map((t) => (
            <Pressable key={t} onPress={() => setPaymentType(t)} style={{ flex: 1, paddingVertical: 10, borderRadius: radius.sm, borderWidth: 1, alignItems: 'center', borderColor: paymentType === t ? colors.primary : colors.border, backgroundColor: paymentType === t ? colors.blueBg : '#fff' }}>
              <Text style={{ fontWeight: '700', color: paymentType === t ? colors.primary : colors.text }}>{t === 'prepaid' ? 'Prepaid' : 'Cash on delivery'}</Text>
            </Pressable>
          ))}
        </View>

        {paymentType === 'prepaid' ? (
          <Field label="Order value (optional)" keyboardType="decimal-pad" value={form.orderValue} onChangeText={(v) => setForm({ ...form, orderValue: v })} placeholder="0.00" />
        ) : (
          <Field label="Amount to collect" keyboardType="decimal-pad" value={form.codAmount} onChangeText={(v) => setForm({ ...form, codAmount: v })} placeholder="0.00" />
        )}
        <Field label="Note (optional)" value={form.note} onChangeText={(v) => setForm({ ...form, note: v })} placeholder="Fragile, call before arriving…" multiline />

        <Button title="Add delivery" onPress={submit} loading={busy} disabled={!valid} />
      </ScrollView>
    </Screen>
  );
}
