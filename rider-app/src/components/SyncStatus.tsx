import { useEffect, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { isOnline, onOnlineChange } from '../lib/api';
import { useAuth } from '../lib/auth';
import { discardItem, retryItem, syncNow, useOutbox, type OutboxItem } from '../lib/outbox';
import { LightButton } from './LightKit';
import { light as c } from '../lib/theme';

/**
 * What the phone still has to send (P4.4), on Home and the route map. Hidden while everything is synced. Tap: the list,
 * where a change the server refused can be fixed ("Deliver anyway", "Add as second parcel"), tried again or discarded.
 * Nothing leaves this list unless it was sent or the rider discarded it.
 */
export default function SyncStatus() {
  const { user } = useAuth();
  const { summary, items } = useOutbox(user?.id);
  const [online, setOnline] = useState(isOnline());
  const [open, setOpen] = useState(false);
  useEffect(() => onOnlineChange(setOnline), []);

  const { waiting, needsAttention } = summary;
  if (!waiting && !needsAttention) return null;
  const attention = needsAttention > 0;
  const text = attention ? `${needsAttention} need${needsAttention === 1 ? 's' : ''} attention`
    : summary.sending ? `Sending ${waiting}…` : `${waiting} waiting to sync${online ? '' : ' · offline'}`;

  return (
    <>
      <Pressable onPress={() => setOpen(true)} hitSlop={6} accessibilityLabel={text}
        style={({ pressed }) => [s.pill, attention ? s.pillAttention : s.pillWaiting, pressed && { opacity: 0.8 }]}>
        <Ionicons name={attention ? 'alert-circle' : online ? 'cloud-upload-outline' : 'cloud-offline-outline'} size={16} color={attention ? c.danger : c.warning} />
        <Text style={[s.pillText, { color: attention ? c.danger : c.warning }]}>{text}</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={s.card} onPress={() => {}}>
            <Text style={s.title}>Not synced yet</Text>
            <Text style={s.sub}>
              {online ? 'These changes are saved on this phone and are being sent.' : 'You are offline. These changes are saved on this phone and go out when you are back online.'}
            </Text>
            <ScrollView style={{ maxHeight: 360, alignSelf: 'stretch', marginTop: 16 }}>
              {items.map((item) => <Row key={item.id} item={item} />)}
            </ScrollView>
            {waiting ? <LightButton title="Send now" onPress={() => void syncNow()} disabled={!online || summary.sending} style={{ alignSelf: 'stretch', marginTop: 16 }} /> : null}
            <LightButton title="Close" variant="outline" onPress={() => setOpen(false)} style={{ alignSelf: 'stretch', marginTop: 10 }} />
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const KIND_TEXT: Record<OutboxItem['kind'], string> = { event: 'Stop update', create: 'New stop', proof: 'Proof photo' };

function Row({ item }: { item: OutboxItem }) {
  const failed = item.state === 'failed';
  // The fix the server's answer calls for, when there is one; otherwise just try again.
  const fix = item.code === 'EARLIER_STOPS_REMAIN' ? { title: 'Deliver anyway', patch: { allowSkip: true } }
    : item.code === 'SAME_EIRCODE_SAME_DAY' ? { title: 'Add as second parcel', patch: { secondParcel: true } }
      : { title: 'Try again', patch: {} };
  const discard = () => Alert.alert('Discard this change?', 'It will not be sent. This cannot be undone.', [
    { text: 'Keep', style: 'cancel' },
    { text: 'Discard', style: 'destructive', onPress: () => void discardItem(item) },
  ]);
  return (
    <View style={s.row}>
      <Text style={s.rowTitle} numberOfLines={2}>{item.label || KIND_TEXT[item.kind]}</Text>
      <Text style={[s.rowSub, failed && { color: c.danger }]} numberOfLines={3}>
        {failed ? item.error || 'The server refused this change.' : item.error ? `Waiting · ${item.error}` : 'Waiting'}
      </Text>
      {failed ? (
        <View style={{ flexDirection: 'row', gap: 16, marginTop: 8 }}>
          <Pressable onPress={() => void retryItem(item, fix.patch)} hitSlop={8}><Text style={s.action}>{fix.title}</Text></Pressable>
          <Pressable onPress={discard} hitSlop={8}><Text style={[s.action, { color: c.danger }]}>Discard</Text></Pressable>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, height: 32, paddingHorizontal: 12, borderRadius: 999, marginTop: 12 },
  pillWaiting: { backgroundColor: c.warningBg },
  pillAttention: { backgroundColor: c.dangerBg },
  pillText: { fontSize: 14, fontWeight: '600' },

  backdrop: { flex: 1, backgroundColor: 'rgba(24,24,27,0.45)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 420, alignItems: 'center', backgroundColor: c.surface, borderRadius: 24, paddingHorizontal: 24, paddingTop: 28, paddingBottom: 20 },
  title: { color: c.text, fontSize: 22, fontWeight: '700', textAlign: 'center' },
  sub: { color: c.textSecondary, fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 8 },
  row: { paddingVertical: 12, borderTopWidth: 1, borderTopColor: c.border },
  rowTitle: { color: c.text, fontSize: 15, fontWeight: '600' },
  rowSub: { color: c.textSecondary, fontSize: 14, marginTop: 2 },
  action: { color: c.link, fontSize: 15, fontWeight: '600' },
});
