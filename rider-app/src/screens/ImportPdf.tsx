import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { postFile, post, ApiRequestError } from '../lib/api';
import type { ImportDraft, ImportDraftItem } from '../lib/types';
import { Banner, Button, Card, Screen } from '../components/Kit';
import { colors, radius, spacing } from '../lib/theme';
import { useNav } from '../lib/nav';

type Row = ImportDraftItem & { include: boolean };

export default function ImportPdf({ onCreated }: { onCreated: () => void }) {
  const { goBack } = useNav();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const pickAndUpload = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: false });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setBusy(true);
    setError('');
    try {
      const r = await postFile<ImportDraft>('/deliveries/import/pdf', asset.uri, 'file', asset.mimeType || 'application/pdf');
      setRows(r.data.items.map((item) => ({ ...item, include: !item.flags.includes('duplicate') })));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const networkFailure = err instanceof TypeError || /network request failed|network error|failed to fetch/i.test(message);
      setError(err instanceof ApiRequestError
        ? err.message
        : networkFailure
          ? 'Could not connect to the delivery server. Check that your phone and computer are on the same Wi-Fi, then try again.'
          : `PDF import failed: ${message || 'Unexpected error'}`);
    } finally { setBusy(false); }
  };

  const update = (i: number, patch: Partial<Row>) => setRows((r) => r!.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  const submit = async () => {
    const selected = (rows || []).filter((r) => r.include);
    const bad = selected.find((r) => !r.paymentType || !r.address || !r.customerName || !r.phone || (r.paymentType === 'cod' && !(r.codAmount! > 0)));
    if (bad) { setError(`Fix "${bad.trackingId}" — every included row needs a customer, address, phone and payment type (with an amount for COD).`); return; }
    setBusy(true);
    setError('');
    try {
      await post('/deliveries/bulk', {
        items: selected.map((r) => ({
          trackingId: r.trackingId, customer: { name: r.customerName, phone: r.phone }, address: { raw: r.address }, note: r.note || undefined,
          payment: r.paymentType === 'prepaid' ? { type: 'prepaid', orderValue: r.orderValue ?? undefined } : { type: 'cod', codAmount: r.codAmount },
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
      <Screen style={{ padding: spacing(6), justifyContent: 'center' }}>
        <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text, marginBottom: 8, textAlign: 'center' }}>Import from PDF</Text>
        <Text style={{ fontSize: 14, color: colors.muted, marginBottom: spacing(6), textAlign: 'center' }}>Pick a courier manifest PDF. We&apos;ll pull out tracking IDs, addresses and payment details for you to review before adding them.</Text>
        {error ? <Banner text={error} /> : null}
        <Button title="Choose PDF" onPress={pickAndUpload} loading={busy} />
      </Screen>
    );
  }

  const includedCount = rows.filter((r) => r.include).length;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: spacing(5) }}>
        <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text, marginBottom: 4 }}>Review import</Text>
        <Text style={{ fontSize: 13, color: colors.muted, marginBottom: spacing(4) }}>Found {rows.length} deliveries. Fix anything flagged, then add the ones you want.</Text>
        {error ? <Banner text={error} /> : null}

        <View style={{ gap: spacing(3) }}>
          {rows.map((row, i) => (
            <Card key={row.trackingId + i} style={!row.include ? { opacity: 0.5 } : undefined}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                <Text style={{ fontWeight: '700', color: colors.text }}>{row.trackingId}</Text>
                <Pressable onPress={() => update(i, { include: !row.include })}>
                  <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: colors.primary, backgroundColor: row.include ? colors.primary : '#fff' }} />
                </Pressable>
              </View>
              {row.flags.length > 0 && <Text style={{ color: colors.amber, fontSize: 11, marginBottom: 6 }}>{row.flags.map((f) => f.replace(/_/g, ' ')).join(' · ')}</Text>}
              <MiniInput placeholder="Customer name" value={row.customerName} onChangeText={(v) => update(i, { customerName: v })} />
              <MiniInput placeholder="Phone" value={row.phone} onChangeText={(v) => update(i, { phone: v })} keyboardType="phone-pad" />
              <MiniInput placeholder="Address" value={row.address} onChangeText={(v) => update(i, { address: v })} multiline />
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 6, marginBottom: 6 }}>
                {(['prepaid', 'cod'] as const).map((t) => (
                  <Pressable key={t} onPress={() => update(i, { paymentType: t })} style={{ flex: 1, paddingVertical: 8, borderRadius: radius.sm, borderWidth: 1, alignItems: 'center', borderColor: row.paymentType === t ? colors.primary : colors.border, backgroundColor: row.paymentType === t ? colors.blueBg : '#fff' }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: row.paymentType === t ? colors.primary : colors.text }}>{t === 'prepaid' ? 'Prepaid' : 'COD'}</Text>
                  </Pressable>
                ))}
              </View>
              {row.paymentType === 'cod' && <MiniInput placeholder="Amount to collect" keyboardType="decimal-pad" value={row.codAmount != null ? String(row.codAmount) : ''} onChangeText={(v) => update(i, { codAmount: Number(v) || 0 })} />}
            </Card>
          ))}
        </View>

        <View style={{ height: spacing(4) }} />
        <Button title={`Add ${includedCount} deliveries`} onPress={submit} loading={busy} disabled={includedCount === 0} />
        <View style={{ height: 8 }} />
        <Button title="Cancel" variant="ghost" onPress={() => setRows(null)} />
      </ScrollView>
    </Screen>
  );
}

function MiniInput(props: React.ComponentProps<typeof TextInput>) {
  return <TextInput {...props} placeholderTextColor={colors.faint} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, marginBottom: 6, backgroundColor: '#fff', color: colors.text }} />;
}
