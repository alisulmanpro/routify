import { useCallback, useState } from 'react';
import { Alert, Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from '../components/KeyboardAware';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from '../lib/useFocusEffect';
import { get, post, del, postFile, fileUrl, ApiRequestError } from '../lib/api';
import type { Delivery, FailureReason, Route } from '../lib/types';
import { FAILURE_LABELS, stopLabel, timeOnly, todayKey } from '../lib/format';
import { Screen } from '../components/Kit';
import { ErrorBanner, IconCircle, PButton, PCard, PInput, Pill, SectionLabel, type PillTone } from '../components/Premium';
import { premium as c, premiumRadius as r } from '../lib/theme';
import { useNav } from '../lib/nav';

const REASONS: FailureReason[] = ['customer_unavailable', 'customer_refused', 'wrong_address', 'phone_unreachable', 'business_closed', 'other'];
export const STATUS: Record<Delivery['status'], { label: string; tone: PillTone }> = {
  pending: { label: 'Pending', tone: 'amber' },
  in_progress: { label: 'Arrived', tone: 'blue' },
  delivered: { label: 'Delivered', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' },
};

export default function DeliveryDetail({ id, onDone }: { id: string; onDone: () => void }) {
  const { goBack } = useNav();
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showFail, setShowFail] = useState(false);
  const [reason, setReason] = useState<FailureReason | null>(null);
  const [failNote, setFailNote] = useState('');

  const load = useCallback(async () => {
    try {
      setDelivery((await get<Delivery>(`/deliveries/${id}`)).data);
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
      setDelivery((await postFile<Delivery>(`/deliveries/${id}/proof`, asset.uri, 'photo', asset.mimeType || 'image/jpeg')).data);
    });
  };

  const confirmDelivery = (allowSkip = false) => run(async () => {
    setDelivery((await post<Delivery>(`/deliveries/${id}/deliver`, allowSkip ? { allowSkip: true } : {})).data);
    onDone();
  });

  const deliver = async () => {
    if (!delivery?.routeId) { confirmDelivery(); return; }
    try {
      const route = (await get<Route | null>('/routes/current', { date: todayKey() })).data;
      const current = route?.stops.find((stop) => stop.delivery.id === delivery.id);
      const earlier = current && route
        ? route.stops.find((stop) => stop.order < current.order && (stop.delivery.status === 'pending' || stop.delivery.status === 'in_progress'))
        : null;
      if (earlier && current) {
        Alert.alert(
          'Earlier delivery still open',
          `Delivery no. ${earlier.order} (${stopLabel(earlier.delivery)}) is not finished. Continue with delivery no. ${current.order}?`,
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Continue anyway', style: 'destructive', onPress: () => confirmDelivery(true) },
          ],
        );
        return;
      }
      confirmDelivery();
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

  const removeDelivery = () => {
    Alert.alert('Delete this delivery?', 'It will be removed from your list and any planned route.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => run(async () => { await del(`/deliveries/${id}`); goBack(); }) },
    ]);
  };

  if (!delivery) {
    return (
      <Screen style={{ padding: 22, backgroundColor: c.background }}>
        {error ? <ErrorBanner text={error} /> : <Text style={{ color: c.textSecondary }}>Loading…</Text>}
      </Screen>
    );
  }

  const status = STATUS[delivery.status];
  const { name, phone } = delivery.customer;

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <KeyboardAwareScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 14 }}>
        {/* Parcel header */}
        <PCard accent>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={s.parcelTag}><Text style={s.parcelTagText}>{delivery.trackingId ? 'Parcel ID' : 'Stop'}{delivery.stopOrder ? ` · Stop ${delivery.stopOrder}` : ''}</Text></View>
            <Pill text={status.label} tone={status.tone} />
          </View>
          <Text style={s.parcelId} selectable numberOfLines={2}>{delivery.trackingId || stopLabel(delivery)}</Text>
          {delivery.deliveredAt ? <Text style={s.meta}>Delivered at {timeOnly(delivery.deliveredAt)}</Text> : null}
          {delivery.failedAt ? <Text style={s.meta}>Failed at {timeOnly(delivery.failedAt)}</Text> : null}
        </PCard>
        <ErrorBanner text={error} />

        {/* Address */}
        <Pressable onPress={() => Linking.openURL(`https://maps.google.com/?q=${encodeURIComponent(delivery.address.raw)}`)}>
          <PCard style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <IconCircle icon="map-marker-outline" />
            <View style={{ flex: 1 }}>
              <SectionLabel style={{ marginBottom: 2 }}>Address</SectionLabel>
              <Text style={s.value}>{delivery.address.raw}</Text>
              {!delivery.address.geocoded ? (
                <Text style={{ color: c.warning, fontSize: 12, marginTop: 6, lineHeight: 17 }}>
                  {delivery.address.approximate ? 'Only an approximate area was found. Verify the address before navigating.' : 'Location not found on the map. Navigate using the address.'}
                </Text>
              ) : null}
            </View>
            <Ionicons name="open-outline" size={18} color={c.textSecondary} />
          </PCard>
        </Pressable>

        {/* Customer (optional details) */}
        {name || phone ? (
          <PCard style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <IconCircle icon="account-outline" />
            <View style={{ flex: 1 }}>
              <SectionLabel style={{ marginBottom: 2 }}>Customer</SectionLabel>
              <Text style={s.value}>{name || 'No name'}</Text>
              {phone ? <Text style={s.meta}>{phone}</Text> : null}
            </View>
            {phone ? (
              <Pressable onPress={() => Linking.openURL(`tel:${phone}`)} hitSlop={6} style={s.callBtn} accessibilityLabel="Call customer">
                <Ionicons name="call" size={18} color={c.success} />
              </Pressable>
            ) : null}
          </PCard>
        ) : null}

        {delivery.note ? (
          <PCard style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <IconCircle icon="note-text-outline" />
            <View style={{ flex: 1 }}>
              <SectionLabel style={{ marginBottom: 2 }}>Note</SectionLabel>
              <Text style={s.value}>{delivery.note}</Text>
            </View>
          </PCard>
        ) : null}

        {delivery.proof?.photoUrl ? (
          <PCard>
            <SectionLabel>Proof photo</SectionLabel>
            <Image source={{ uri: fileUrl(delivery.proof.photoUrl) }} style={s.photo} resizeMode="cover" />
          </PCard>
        ) : null}

        {delivery.failure ? (
          <View style={s.failure}>
            <MaterialCommunityIcons name="alert-circle" size={20} color={c.danger} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.danger, fontWeight: '800' }}>Failed: {FAILURE_LABELS[delivery.failure.reason] ?? delivery.failure.reason}</Text>
              {delivery.failure.note ? <Text style={{ color: c.text, marginTop: 4, fontSize: 13 }}>{delivery.failure.note}</Text> : null}
            </View>
          </View>
        ) : null}

        {/* Actions */}
        {delivery.status === 'pending' ? <PButton title="Mark arrived" icon="flag-outline" onPress={arrive} loading={busy} chevron /> : null}

        {delivery.status === 'in_progress' && !showFail ? (
          <View style={{ gap: 10 }}>
            {!delivery.proof ? (
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <PButton title="Take photo" icon="camera-outline" variant="secondary" onPress={() => capturePhoto(true)} disabled={busy} style={{ flex: 1 }} />
                <PButton title="Choose photo" icon="images-outline" variant="secondary" onPress={() => capturePhoto(false)} disabled={busy} style={{ flex: 1 }} />
              </View>
            ) : null}
            <PButton title="Confirm delivered" icon="checkmark-circle-outline" onPress={deliver} loading={busy} chevron />
            <PButton title="Delivery failed" icon="close-circle-outline" variant="danger" onPress={() => setShowFail(true)} />
          </View>
        ) : null}

        {showFail ? (
          <PCard>
            <Text style={{ color: c.text, fontSize: 16, fontWeight: '800', marginBottom: 12 }}>Why did this delivery fail?</Text>
            <View style={{ gap: 8 }}>
              {REASONS.map((value) => {
                const on = reason === value;
                return (
                  <Pressable key={value} onPress={() => setReason(value)} style={[s.reason, on && s.reasonOn]}>
                    <Text style={{ flex: 1, color: c.text, fontSize: 14, fontWeight: on ? '700' : '500' }}>{FAILURE_LABELS[value]}</Text>
                    <View style={[s.radio, on && { borderColor: c.danger }]}>{on ? <View style={s.radioDot} /> : null}</View>
                  </Pressable>
                );
              })}
            </View>
            {reason === 'other' ? <PInput icon="create-outline" value={failNote} onChangeText={setFailNote} multiline maxLength={1000} placeholder="Describe the issue" style={{ marginTop: 12 }} /> : null}
            <PButton title="Submit" icon="send-outline" variant="danger" onPress={submitFail} loading={busy} disabled={!reason || (reason === 'other' && !failNote.trim())} style={{ marginTop: 14 }} />
            <PButton title="Cancel" variant="secondary" onPress={() => setShowFail(false)} style={{ marginTop: 10 }} />
          </PCard>
        ) : null}

        {delivery.status === 'pending' ? (
          <Pressable onPress={removeDelivery} disabled={busy} style={{ alignItems: 'center', paddingVertical: 12 }}>
            <Text style={{ color: c.danger, fontWeight: '700', fontSize: 13 }}>Delete delivery</Text>
          </Pressable>
        ) : null}
      </KeyboardAwareScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  parcelTag: { backgroundColor: 'rgba(255,170,50,0.14)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: r.pill },
  parcelTagText: { color: c.primary, fontSize: 10, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
  parcelId: { color: c.text, fontSize: 24, fontWeight: '800', marginTop: 10, letterSpacing: 0.5 },
  value: { color: c.text, fontSize: 15, fontWeight: '600', lineHeight: 21 },
  meta: { color: c.textSecondary, fontSize: 13, marginTop: 3 },
  callBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(25,216,139,0.14)', alignItems: 'center', justifyContent: 'center' },
  photo: { width: '100%', height: 220, borderRadius: r.medium, backgroundColor: c.surfaceSoft },
  failure: { flexDirection: 'row', gap: 10, padding: 14, borderRadius: r.large, backgroundColor: 'rgba(255,83,104,0.1)', borderWidth: 1, borderColor: 'rgba(255,83,104,0.35)' },
  reason: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: r.medium, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceSoft },
  reasonOn: { borderColor: 'rgba(255,83,104,0.6)', backgroundColor: 'rgba(255,83,104,0.08)' },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: c.danger },
});
