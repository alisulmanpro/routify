import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Image, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { KeyboardAwareScrollView, useRevealOnFocus } from '../components/KeyboardAware';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from '../lib/useFocusEffect';
import { get, del, postFile, fileUrl, ApiRequestError } from '../lib/api';
import type { Delivery, FailureReason } from '../lib/types';
import { applyStopEvent, earlierStopOf, type V2EventResult } from '../lib/v2';
import { sendStopEvent } from '../lib/v2api';
import { FAILURE_LABELS, stopCardText, timeOnly } from '../lib/format';
import { Screen } from '../components/Kit';
import { type PillTone } from '../components/Premium';
import { LightButton, LightError } from '../components/LightKit';
import ConfirmMap from '../components/scan/ConfirmMap';
import { light as c, lightRadius as lr } from '../lib/theme';
import { useNav } from '../lib/nav';

const REASONS: FailureReason[] = ['customer_unavailable', 'customer_refused', 'wrong_address', 'phone_unreachable', 'business_closed', 'other'];
export const STATUS: Record<Delivery['status'], { label: string; tone: PillTone }> = {
  pending: { label: 'Pending', tone: 'amber' },
  in_progress: { label: 'Arrived', tone: 'blue' },
  delivered: { label: 'Delivered', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' },
};

/**
 * Stop detail (design_pref "Stop detail" and "Failed delivery"): the stop's map, Eircode, address, parcel ID and notes,
 * with Delivered / Failed. The server only takes a result (or a photo) once the stop is marked arrived, so a pending
 * stop is marked arrived first, then the action runs.
 */
export default function DeliveryDetail({ id, onDone, initialStep }: { id: string; onDone: () => void; initialStep?: 'proof' | 'fail' }) {
  const { goBack, resetTo } = useNav();
  // Opened straight on Proof of delivery or Failed delivery (from Live Navigation): closing that step goes back there.
  const closeStep = (hide: () => void) => { if (initialStep) goBack(); else hide(); };
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'deliver' | 'fail' | 'photo' | 'delete' | null>(null);
  const [showFail, setShowFail] = useState(initialStep === 'fail');
  const [reason, setReason] = useState<FailureReason | null>(null);
  const [failNote, setFailNote] = useState('');
  // Delivered opens Proof of delivery (photo, note) before the stop is completed.
  const [showProof, setShowProof] = useState(initialStep === 'proof');
  const [deliverNote, setDeliverNote] = useState('');

  const load = useCallback(async () => {
    try {
      setDelivery((await get<Delivery>(`/deliveries/${id}`)).data);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load this delivery');
    }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(kind);
    setError('');
    try { await fn(); } catch (err) { setError(err instanceof ApiRequestError ? err.message : 'Something went wrong'); }
    finally { setBusy(null); }
  };

  // A photo needs the stop marked arrived first (Delivered and Failed record the arrival themselves).
  const ensureArrived = async () => {
    if (delivery?.status !== 'pending') return;
    const { stop } = await sendStopEvent(id, { type: 'arrive' });
    setDelivery((d) => (d ? applyStopEvent(d, stop) : d));
  };

  const capturePhoto = async (fromCamera: boolean) => {
    const perm = fromCamera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setError('Camera/photo permission is required to attach a proof photo.'); return; }
    const result = fromCamera
      ? await ImagePicker.launchCameraAsync({ quality: 0.7, mediaTypes: ['images'] })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, mediaTypes: ['images'] });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    await run('photo', async () => {
      await ensureArrived();
      setDelivery((await postFile<Delivery>(`/deliveries/${id}/proof`, asset.uri, 'photo', asset.mimeType || 'image/jpeg')).data);
    });
  };

  // After the last open stop the server completes the route (the event's answer says so): then Route complete, else back.
  const finish = (result: V2EventResult) => {
    if (result.route?.status === 'completed') { resetTo('RouteComplete', { routeId: result.route.id }); return; }
    onDone();
  };

  const addPhoto = () => Alert.alert('Add photo', undefined, [
    { text: 'Take photo', onPress: () => void capturePhoto(true) },
    { text: 'Choose from gallery', onPress: () => void capturePhoto(false) },
    { text: 'Cancel', style: 'cancel' },
  ]);

  // One request: the server records the arrival if needed and refuses (409) while an earlier stop is still open.
  const confirmDelivery = (allowSkip = false) => run('deliver', async () => {
    const note = deliverNote.trim();
    try {
      const result = await sendStopEvent(id, { type: 'deliver', ...(allowSkip ? { allowSkip: true } : {}), ...(note ? { note } : {}) });
      setDelivery((d) => (d ? applyStopEvent({ ...d, note: note || d.note }, result.stop) : d));
      finish(result);
    } catch (err) {
      const earlier = err instanceof ApiRequestError && err.code === 'EARLIER_STOPS_REMAIN' ? earlierStopOf(err.details) : null;
      if (!earlier) throw err;
      Alert.alert(
        'Earlier delivery still open',
        `Delivery no. ${earlier.stopOrder}${earlier.trackingId ? ` (${earlier.trackingId})` : ''} is not finished. Continue with delivery no. ${delivery?.stopOrder ?? ''}?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Continue anyway', style: 'destructive', onPress: () => confirmDelivery(true) },
        ],
      );
    }
  });

  const deliver = () => confirmDelivery();

  const submitFail = () => run('fail', async () => {
    if (!reason) { setError('Choose a reason'); return; }
    const result = await sendStopEvent(id, { type: 'fail', reason, ...(failNote.trim() ? { note: failNote.trim() } : {}) });
    setShowFail(false);
    finish(result);
  });

  const removeDelivery = () => {
    Alert.alert('Delete this delivery?', 'It will be removed from your list and any planned route.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => run('delete', async () => { await del(`/deliveries/${id}`); goBack(); }) },
    ]);
  };

  if (!delivery) {
    return (
      <Screen style={{ padding: 24, backgroundColor: c.background }}>
        <StatusBar style="dark" />
        {error ? <LightError text={error} /> : <ActivityIndicator color={c.ink} style={{ marginTop: 48 }} />}
      </Screen>
    );
  }

  const open = delivery.status === 'pending' || delivery.status === 'in_progress';
  const proof = delivery.proof?.photoUrl ? fileUrl(delivery.proof.photoUrl) : null;

  // Proof of delivery (design_pref "Proof of delivery" / "· Filled"): photo, note, then Complete delivery.
  if (showProof) {
    const { title: code } = stopCardText(delivery);
    return (
      <Screen style={{ backgroundColor: c.background }}>
        <StatusBar style="dark" />
        <KeyboardAwareScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
          <View style={[s.header, { alignItems: 'flex-start' }]}>
            <Pressable onPress={() => closeStep(() => setShowProof(false))} hitSlop={12} accessibilityLabel="Back" style={{ marginTop: 2 }}>
              <Ionicons name="arrow-back" size={26} color={c.text} />
            </Pressable>
            <View style={{ marginLeft: 18, flex: 1 }}>
              <Text style={s.title}>Proof of delivery</Text>
              <Text style={{ color: c.textSecondary, fontSize: 16, marginTop: 4 }}>{code}</Text>
            </View>
          </View>

          <Text style={s.label}>Photo</Text>
          {proof ? (
            <View style={s.proofPhoto}>
              <Image source={{ uri: proof }} style={StyleSheet.absoluteFill} resizeMode="cover" />
              <View style={s.photoChip}>
                <Ionicons name="checkmark" size={16} color={c.success} />
                <Text style={{ color: c.success, fontSize: 14, fontWeight: '600' }}>Photo added{delivery.proof?.capturedAt ? ` · ${timeOnly(delivery.proof.capturedAt)}` : ''}</Text>
              </View>
              <Pressable onPress={() => void capturePhoto(true)} disabled={!!busy} style={({ pressed }) => [s.retake, pressed && { opacity: 0.85 }]}>
                {busy === 'photo' ? <ActivityIndicator color="#fff" /> : <Ionicons name="refresh" size={18} color="#fff" />}
                <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>Retake</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={() => void capturePhoto(true)} disabled={!!busy} style={({ pressed }) => [s.takePhoto, pressed && { opacity: 0.85 }]}>
              <View style={s.takeIcon}>{busy === 'photo' ? <ActivityIndicator color={c.text} /> : <Ionicons name="camera-outline" size={28} color={c.text} />}</View>
              <Text style={{ color: c.text, fontSize: 17, fontWeight: '600', marginTop: 14 }}>Take photo</Text>
              <Text style={{ color: c.textSecondary, fontSize: 15, marginTop: 6 }}>Show the parcel at the door</Text>
            </Pressable>
          )}
          {/* Not in the design: picking a photo already taken, as the old screen allowed. */}
          <Pressable onPress={() => void capturePhoto(false)} disabled={!!busy} hitSlop={8} style={{ alignSelf: 'flex-start', marginTop: 10 }}>
            <Text style={{ color: c.link, fontSize: 15, fontWeight: '500' }}>Choose from gallery</Text>
          </Pressable>

          {/* MISSING: see missing.md — signatures can't be captured or saved yet; shown disabled at the owner's request. */}
          <View style={[s.sigHead, { opacity: 0.45 }]}>
            <Text style={[s.label, { marginTop: 0, marginBottom: 0 }]}>Signature</Text>
            <Text style={{ color: c.placeholder, fontSize: 15, fontWeight: '500' }}>Clear</Text>
          </View>
          <View style={s.signature} accessibilityState={{ disabled: true }}>
            <Text style={{ color: c.placeholder, fontSize: 16 }}>Signature isn&apos;t available yet</Text>
            <View style={s.sigLine} />
          </View>

          <Text style={s.label}>Note <Text style={{ color: c.placeholder, fontWeight: '400' }}>(optional)</Text></Text>
          <NoteField value={deliverNote} onChangeText={setDeliverNote} placeholder="e.g. Left in the porch" short />
          <LightError text={error} />
        </KeyboardAwareScrollView>

        <View style={s.footer}>
          <Pressable onPress={() => void deliver()} disabled={!!busy} style={({ pressed }) => [s.resultBtn, s.delivered, (pressed || !!busy) && { opacity: 0.85 }]}>
            {busy === 'deliver' ? <ActivityIndicator color="#fff" /> : <Ionicons name="checkmark" size={24} color="#fff" />}
            <Text style={[s.resultBtnText, { color: '#fff' }]}>Complete delivery</Text>
          </Pressable>
        </View>
      </Screen>
    );
  }

  // "Why couldn't you deliver?" (design_pref "Failed delivery"), in place of the stop while it is open.
  if (showFail) {
    const ready = !!reason && !(reason === 'other' && !failNote.trim());
    return (
      <Screen style={{ backgroundColor: c.background }}>
        <StatusBar style="dark" />
        <KeyboardAwareScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
          <View style={s.header}>
            <Pressable onPress={() => closeStep(() => setShowFail(false))} hitSlop={12} accessibilityLabel="Close">
              <Ionicons name="close" size={28} color={c.text} />
            </Pressable>
            <Text style={[s.title, { marginLeft: 18, flex: 1 }]}>Why couldn&apos;t you deliver?</Text>
          </View>

          <View style={{ marginTop: 16 }}>
            {REASONS.map((value, i) => {
              const on = reason === value;
              return (
                <Pressable key={value} onPress={() => setReason(value)} style={[s.reason, i > 0 && s.divider]} accessibilityRole="radio" accessibilityState={{ selected: on }}>
                  <View style={[s.radio, on && { borderColor: c.ink }]}>{on ? <View style={s.radioDot} /> : null}</View>
                  <Text style={s.reasonText}>{FAILURE_LABELS[value]}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={s.label}>{reason === 'other' ? 'Describe what happened' : 'Add a note'} {reason === 'other' ? null : <Text style={{ color: c.placeholder, fontWeight: '400' }}>(optional)</Text>}</Text>
          <NoteField value={failNote} onChangeText={setFailNote} placeholder="e.g. Left a card through the letterbox" />

          <Pressable onPress={addPhoto} disabled={!!busy} style={({ pressed }) => [s.photoRow, pressed && { opacity: 0.85 }]}>
            {proof ? <Image source={{ uri: proof }} style={s.photoThumb} /> : (
              <View style={s.photoIcon}>{busy === 'photo' ? <ActivityIndicator color={c.text} /> : <Ionicons name="camera-outline" size={24} color={c.text} />}</View>
            )}
            <Text style={s.photoText}>{proof ? 'Photo added' : 'Add photo'}</Text>
            <Ionicons name={proof ? 'refresh' : 'add'} size={24} color={c.textSecondary} />
          </Pressable>
          <LightError text={error} />
        </KeyboardAwareScrollView>

        <View style={s.footer}>
          <LightButton title="Confirm" onPress={() => void submitFail()} loading={busy === 'fail'} disabled={!ready || !!busy} />
        </View>
      </Screen>
    );
  }

  const { title, address } = stopCardText(delivery);
  const point = delivery.address.latitude != null && delivery.address.longitude != null ? { latitude: delivery.address.latitude, longitude: delivery.address.longitude } : null;
  const { name, phone } = delivery.customer;

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <StatusBar style="dark" />
      <KeyboardAwareScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: open ? 120 : 32 }}>
        <View style={s.header}>
          <Pressable onPress={goBack} hitSlop={12} accessibilityLabel="Back">
            <Ionicons name="arrow-back" size={26} color={c.text} />
          </Pressable>
          <Text style={[s.title, { marginLeft: 18 }]}>{delivery.stopOrder ? `Stop ${delivery.stopOrder}` : 'Stop'}</Text>
        </View>

        <View style={s.map}>
          {point ? <ConfirmMap point={point} fallback={null} style={{ flex: 1 }} /> : (
            <View style={[s.mapEmpty, { flex: 1 }]}>
              <MaterialCommunityIcons name="map-marker-off-outline" size={28} color={c.placeholder} />
              <Text style={{ color: c.textSecondary, fontSize: 14 }}>Not on the map yet</Text>
            </View>
          )}
        </View>

        <Text style={s.eircode} selectable>{title}</Text>
        {address ? <Text style={s.address} selectable>{address}</Text> : null}
        {/* Not in the design: opening the address in Google Maps, as the old screen did. */}
        <Pressable onPress={() => Linking.openURL(`https://maps.google.com/?q=${encodeURIComponent(delivery.address.raw)}`)} hitSlop={6} style={s.mapsLink}>
          <Ionicons name="open-outline" size={16} color={c.link} />
          <Text style={{ color: c.link, fontSize: 15, fontWeight: '500' }}>Open in Google Maps</Text>
        </Pressable>
        {!delivery.address.geocoded ? (
          <Text style={s.warning}>
            {delivery.address.approximate ? 'Only an approximate area was found. Verify the address before navigating.' : 'Location not found on the map. Navigate using the address.'}
          </Text>
        ) : null}

        {delivery.trackingId ? (
          <View style={s.parcel}>
            <Text style={s.parcelLabel}>Parcel ID</Text>
            {/* Long-press to copy. MISSING: see missing.md — no clipboard library for the copy button. */}
            <Text style={s.parcelId} selectable>{delivery.trackingId}</Text>
            <Pressable disabled accessibilityState={{ disabled: true }} hitSlop={8} style={{ opacity: 0.35 }}>
              <Ionicons name="copy-outline" size={22} color={c.link} />
            </Pressable>
          </View>
        ) : null}

        {/* Not in the design: the customer, when the stop has one, with a call button. */}
        {name || phone ? (
          <View style={[s.section, s.customer]}>
            <View style={{ flex: 1 }}>
              <Text style={s.sectionTitle}>Customer</Text>
              <Text style={s.body}>{name || 'No name'}{phone ? ` · ${phone}` : ''}</Text>
            </View>
            {phone ? (
              <Pressable onPress={() => Linking.openURL(`tel:${phone}`)} hitSlop={6} style={s.callBtn} accessibilityLabel="Call customer">
                <Ionicons name="call" size={18} color={c.success} />
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <View style={s.section}>
          <Text style={s.sectionTitle}>Notes</Text>
          <Text style={[s.body, !delivery.note && { color: c.placeholder }]}>{delivery.note || 'No notes for this stop.'}</Text>
        </View>

        {/* Not in the design: the result and proof photo, once the stop is done. */}
        {delivery.status === 'delivered' ? (
          <View style={[s.result, { backgroundColor: c.successBg }]}>
            <Ionicons name="checkmark-circle" size={22} color={c.success} />
            <Text style={{ color: c.success, fontSize: 16, fontWeight: '600' }}>Delivered{delivery.deliveredAt ? ` at ${timeOnly(delivery.deliveredAt)}` : ''}</Text>
          </View>
        ) : null}
        {delivery.failure ? (
          <View style={[s.result, { backgroundColor: c.dangerBg, alignItems: 'flex-start' }]}>
            <Ionicons name="close-circle" size={22} color={c.danger} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.danger, fontSize: 16, fontWeight: '600' }}>Failed: {FAILURE_LABELS[delivery.failure.reason] ?? delivery.failure.reason}{delivery.failedAt ? ` · ${timeOnly(delivery.failedAt)}` : ''}</Text>
              {delivery.failure.note ? <Text style={{ color: c.text, marginTop: 4, fontSize: 15 }}>{delivery.failure.note}</Text> : null}
            </View>
          </View>
        ) : null}

        {/* Not in the design: the proof photo, once the stop is done. */}
        {!open && proof ? <Image source={{ uri: proof }} style={s.photo} resizeMode="cover" /> : null}

        <LightError text={error} />

        {delivery.status === 'pending' ? (
          <Pressable onPress={removeDelivery} disabled={!!busy} style={{ alignItems: 'center', paddingVertical: 16 }}>
            <Text style={{ color: c.danger, fontWeight: '600', fontSize: 15 }}>Delete delivery</Text>
          </Pressable>
        ) : null}
      </KeyboardAwareScrollView>

      {open ? (
        <View style={[s.footer, { flexDirection: 'row', gap: 12 }]}>
          <Pressable onPress={() => { setError(''); setShowProof(true); }} disabled={!!busy} style={({ pressed }) => [s.resultBtn, s.delivered, (pressed || !!busy) && { opacity: 0.85 }]}>
            <Ionicons name="checkmark" size={24} color="#fff" />
            <Text style={[s.resultBtnText, { color: '#fff' }]}>Delivered</Text>
          </Pressable>
          <Pressable onPress={() => { setError(''); setShowFail(true); }} disabled={!!busy} style={({ pressed }) => [s.resultBtn, s.failed, (pressed || !!busy) && { opacity: 0.85 }]}>
            <Ionicons name="close" size={24} color={c.danger} />
            <Text style={[s.resultBtnText, { color: c.danger }]}>Failed</Text>
          </Pressable>
        </View>
      ) : null}
    </Screen>
  );
}

function NoteField({ value, onChangeText, placeholder, short }: { value: string; onChangeText: (v: string) => void; placeholder: string; short?: boolean }) {
  const reveal = useRevealOnFocus();
  return (
    <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={c.placeholder}
      multiline maxLength={1000} textAlignVertical="top" style={[s.note, short && { minHeight: 52 }]} onFocus={reveal} />
  );
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center' },
  title: { color: c.text, fontSize: 24, fontWeight: '700' },
  map: { height: 150, borderRadius: 20, overflow: 'hidden', marginTop: 24 },
  mapEmpty: { alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: c.soft },
  eircode: { color: c.text, fontSize: 34, fontWeight: '800', letterSpacing: -0.5, marginTop: 24 },
  address: { color: c.textSecondary, fontSize: 16, lineHeight: 23, marginTop: 6 },
  mapsLink: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 10 },
  warning: { color: c.warning, fontSize: 14, lineHeight: 20, marginTop: 8 },
  parcel: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 24, paddingBottom: 24, borderBottomWidth: 1, borderBottomColor: c.border },
  parcelLabel: { color: c.textSecondary, fontSize: 15 },
  parcelId: { color: c.text, fontSize: 18, fontWeight: '700', marginRight: 6 },
  section: { paddingVertical: 20, borderBottomWidth: 1, borderBottomColor: c.border },
  customer: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sectionTitle: { color: c.text, fontSize: 17, fontWeight: '600' },
  body: { color: c.textSecondary, fontSize: 16, lineHeight: 23, marginTop: 6 },
  callBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.successBg, alignItems: 'center', justifyContent: 'center' },
  result: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: lr.field, marginTop: 20 },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 12, borderRadius: 18, backgroundColor: c.soft, marginTop: 20 },
  photoIcon: { width: 44, height: 44, borderRadius: 12, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' },
  photoThumb: { width: 44, height: 44, borderRadius: 12 },
  photoText: { flex: 1, color: c.text, fontSize: 17, fontWeight: '600' },
  photo: { width: '100%', height: 220, borderRadius: 18, marginTop: 20, backgroundColor: c.soft },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14, backgroundColor: c.background, borderTopWidth: 1, borderTopColor: c.border },
  resultBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 58, borderRadius: 18 },
  delivered: { backgroundColor: '#15803D' },
  failed: { backgroundColor: c.surface, borderWidth: 2, borderColor: c.danger },
  resultBtnText: { fontSize: 18, fontWeight: '700' },
  reason: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 18 },
  divider: { borderTopWidth: 1, borderTopColor: c.border },
  reasonText: { color: c.text, fontSize: 17 },
  radio: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: c.placeholder, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: c.ink },
  label: { color: c.textLabel, fontSize: 15, fontWeight: '500', marginTop: 28, marginBottom: 10 },
  takePhoto: { alignItems: 'center', justifyContent: 'center', height: 200, borderRadius: 20, borderWidth: 2, borderStyle: 'dashed', borderColor: c.border, backgroundColor: '#FAFAFA' },
  takeIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' },
  proofPhoto: { height: 200, borderRadius: 20, overflow: 'hidden', backgroundColor: c.soft },
  photoChip: { position: 'absolute', left: 12, bottom: 12, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: c.surface },
  retake: { position: 'absolute', right: 12, bottom: 10, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999, backgroundColor: c.ink },
  sigHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 28, marginBottom: 10 },
  signature: { height: 140, borderRadius: lr.field, borderWidth: 1, borderColor: c.border, backgroundColor: '#FAFAFA', alignItems: 'center', justifyContent: 'center' },
  sigLine: { position: 'absolute', left: 20, right: 20, bottom: 28, height: 1, backgroundColor: c.border },
  note: { minHeight: 96, borderRadius: lr.field, borderWidth: 1, borderColor: c.border, paddingHorizontal: 16, paddingVertical: 14, color: c.text, fontSize: 16 },
});
