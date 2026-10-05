import { useCallback, useState } from 'react';
import { Alert, Image, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect } from '../lib/useFocusEffect';
import { get, post, del, postFile, fileUrl, ApiRequestError } from '../lib/api';
import type { Delivery, FailureReason, Route } from '../lib/types';
import { money, FAILURE_LABELS } from '../lib/format';
import { Badge, Banner, Button, Card, Field, Screen } from '../components/Kit';
import { colors, spacing } from '../lib/theme';
import { useNav } from '../lib/nav';

const REASONS: FailureReason[] = ['customer_unavailable', 'customer_refused', 'wrong_address', 'phone_unreachable', 'business_closed', 'payment_issue', 'other'];
const STATUS_TONE: Record<Delivery['status'], 'blue' | 'green' | 'red' | 'amber'> = { pending: 'amber', in_progress: 'blue', delivered: 'green', failed: 'red' };

export default function DeliveryDetail({ id, onDone }: { id: string; onDone: () => void }) {
  const { goBack } = useNav();
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showFail, setShowFail] = useState(false);
  const [reason, setReason] = useState<FailureReason | null>(null);
  const [failNote, setFailNote] = useState('');
  const [cashConfirmed, setCashConfirmed] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await get<Delivery>(`/deliveries/${id}`);
      setDelivery(r.data);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load this delivery');
    }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try { await fn(); } catch (err) { setError(err instanceof ApiRequestError ? err.message : 'Something went wrong'); }
    finally { setBusy(false); }
  };

  const arrive = () => run(async () => setDelivery((await post<Delivery>(`/deliveries/${id}/arrive`)).data));

  const capturePhoto = async (fromCamera: boolean) => {
    const perm = fromCamera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setError('Camera/photo permission is required to attach a proof photo.'); return; }
    const result = fromCamera
      ? await ImagePicker.launchCameraAsync({ quality: 0.7, mediaTypes: ['images'] })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, mediaTypes: ['images'] });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    await run(async () => {
      const mimeType = asset.mimeType || 'image/jpeg';
      const r = await postFile<Delivery>(`/deliveries/${id}/proof`, asset.uri, 'photo', mimeType);
      setDelivery(r.data);
    });
  };

  const confirmDelivery = (cashCollected: boolean, allowSkip = false) => run(async () => {
    const body: Record<string, unknown> = {};
    if (delivery?.payment.type === 'cod') { body.cashCollected = cashCollected; if (cashCollected) body.collectedAmount = delivery.payment.codAmount; }
    if (allowSkip) body.allowSkip = true;
    setDelivery((await post<Delivery>(`/deliveries/${id}/deliver`, body)).data);
    onDone();
  });

  const deliver = async (cashCollected: boolean) => {
    if (!delivery?.routeId) { confirmDelivery(cashCollected); return; }
    try {
      const route = (await get<Route | null>('/routes/current')).data;
      const current = route?.stops.find((stop) => stop.delivery.id === delivery.id);
      const earlier = current && route
        ? route.stops.find((stop) => stop.order < current.order && (stop.delivery.status === 'pending' || stop.delivery.status === 'in_progress'))
        : null;
      if (earlier && current) {
        Alert.alert(
          'Earlier delivery still open',
          `Delivery no. ${earlier.order} (${earlier.delivery.trackingId}) is not finished. Continue with delivery no. ${current.order}?`,
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Continue anyway', style: 'destructive', onPress: () => confirmDelivery(cashCollected, true) },
          ],
        );
        return;
      }
      confirmDelivery(cashCollected);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not verify the route order');
    }
  };

  const submitFail = () => run(async () => {
    if (!reason) { setError('Choose a reason'); return; }
    await post(`/deliveries/${id}/fail`, { reason, note: failNote || undefined });
    setShowFail(false);
    onDone();
  });

  const editable = delivery?.status === 'pending';
  const removeDelivery = () => run(async () => { await del(`/deliveries/${id}`); goBack(); });

  if (!delivery) return <Screen style={{ padding: spacing(6) }}>{error ? <Banner text={error} /> : <Text style={{ color: colors.muted }}>Loading…</Text>}</Screen>;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: spacing(5) }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing(3) }}>
          <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text }}>{delivery.trackingId}</Text>
          <Badge text={delivery.status} tone={STATUS_TONE[delivery.status]} />
        </View>
        {error ? <Banner text={error} /> : null}

        <Card style={{ marginBottom: spacing(3) }}>
          <Text style={{ fontWeight: '700', color: colors.text, marginBottom: 6 }}>{delivery.customer.name}</Text>
          <Pressable onPress={() => Linking.openURL(`tel:${delivery.customer.phone}`)}><Text style={{ color: colors.primary, marginBottom: 6 }}>📞 {delivery.customer.phone}</Text></Pressable>
          <Pressable onPress={() => Linking.openURL(`https://maps.google.com/?q=${encodeURIComponent(delivery.address.raw)}`)}>
            <Text style={{ color: colors.text }}>📍 {delivery.address.raw}</Text>
          </Pressable>
          {!delivery.address.geocoded && <Text style={{ color: colors.amber, fontSize: 12, marginTop: 4 }}>{delivery.address.approximate ? 'Only an approximate area was found. Verify the full address before navigating.' : 'Location could not be found — you&apos;ll need to navigate manually.'}</Text>}
        </Card>

        <Card style={{ marginBottom: spacing(3) }}>
          <Text style={{ fontWeight: '700', color: colors.text, marginBottom: 6 }}>Payment</Text>
          {delivery.payment.type === 'prepaid' ? (
            <Text style={{ color: colors.text }}>Prepaid · Order value {money(delivery.payment.orderValue, delivery.payment.currency)}</Text>
          ) : (
            <>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>Collect {money(delivery.payment.codAmount, delivery.payment.currency)}</Text>
              <Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>{delivery.payment.collectionStatus === 'collected' ? `Collected ${money(delivery.payment.codCollectedAmount, delivery.payment.currency)}` : 'Not yet collected'}</Text>
            </>
          )}
        </Card>

        {delivery.proof?.photoUrl && (
          <Card style={{ marginBottom: spacing(3) }}>
            <Text style={{ fontWeight: '700', color: colors.text, marginBottom: 8 }}>Proof photo</Text>
            <Image source={{ uri: fileUrl(delivery.proof.photoUrl) }} style={{ width: '100%', height: 220, borderRadius: 10, backgroundColor: colors.muted2 }} resizeMode="cover" />
          </Card>
        )}

        {delivery.failure && (
          <Card style={{ marginBottom: spacing(3), backgroundColor: colors.redBg, borderColor: colors.red }}>
            <Text style={{ color: colors.red, fontWeight: '700' }}>Marked failed: {FAILURE_LABELS[delivery.failure.reason]}</Text>
            {delivery.failure.note ? <Text style={{ color: colors.red, marginTop: 4 }}>{delivery.failure.note}</Text> : null}
          </Card>
        )}

        {delivery.status === 'pending' && <Button title="Mark arrived" onPress={arrive} loading={busy} />}

        {delivery.status === 'in_progress' && !showFail && (
          <View style={{ gap: spacing(3) }}>
            {!delivery.proof && (
              <View style={{ flexDirection: 'row', gap: spacing(3) }}>
                <View style={{ flex: 1 }}><Button title="📷 Take photo" onPress={() => capturePhoto(true)} loading={busy} /></View>
                <View style={{ flex: 1 }}><Button title="🖼️ Choose photo" variant="secondary" onPress={() => capturePhoto(false)} loading={busy} /></View>
              </View>
            )}
            {delivery.payment.type === 'cod' && (
              <Pressable onPress={() => setCashConfirmed((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: colors.primary, backgroundColor: cashConfirmed ? colors.primary : '#fff' }} />
                <Text style={{ color: colors.text, flex: 1 }}>I collected {money(delivery.payment.codAmount, delivery.payment.currency)} in cash</Text>
              </Pressable>
            )}
            <Button title="Confirm delivered" onPress={() => deliver(cashConfirmed)} loading={busy} disabled={delivery.payment.type === 'cod' && !cashConfirmed} />
            <Button title="Delivery failed" variant="danger" onPress={() => setShowFail(true)} />
          </View>
        )}

        {showFail && (
          <Card>
            <Text style={{ fontWeight: '700', color: colors.text, marginBottom: spacing(2) }}>Why did this delivery fail?</Text>
            <View style={{ gap: 8, marginBottom: spacing(3) }}>
              {REASONS.map((r) => (
                <Pressable key={r} onPress={() => setReason(r)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.primary, backgroundColor: reason === r ? colors.primary : '#fff' }} />
                  <Text style={{ color: colors.text }}>{FAILURE_LABELS[r]}</Text>
                </Pressable>
              ))}
            </View>
            {reason === 'other' && <Field label="Describe the issue" value={failNote} onChangeText={setFailNote} multiline maxLength={1000} placeholder="Add a short explanation" />}
            <Button title="Submit" variant="danger" onPress={submitFail} loading={busy} disabled={!reason || (reason === 'other' && !failNote.trim())} />
            <View style={{ height: 8 }} />
            <Button title="Cancel" variant="ghost" onPress={() => setShowFail(false)} />
          </Card>
        )}

        {editable && (
          <View style={{ marginTop: spacing(5) }}>
            <Button title="Delete delivery" variant="ghost" onPress={removeDelivery} loading={busy} />
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
