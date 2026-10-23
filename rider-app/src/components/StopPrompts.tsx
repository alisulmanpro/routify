import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { LightButton } from './LightKit';
import { stopCardText } from '../lib/format';
import type { Duplicate } from '../lib/duplicates';
import type { Delivery } from '../lib/types';
import { light as c } from '../lib/theme';

// The light prompts of the add-stop flow (design_pref "Already in your stops (sheet)" and "Stop added (modal)").
// The *Sheet / *Card parts draw over whatever is behind them, so Confirm stop can show them on top of its map;
// DuplicatePrompt wraps the sheet in its own modal for Add stops.

type DuplicateProps = { duplicate: Duplicate<Delivery>; onView: () => void; onOk: () => void; onAddAnyway: () => void };

/** "Already in your stops: R93 Y201 is stop #5 on this route". Nothing is added unless the rider picks "Add anyway". */
export function DuplicateSheet({ duplicate, onView, onOk, onAddAnyway }: DuplicateProps) {
  const text = stopCardText(duplicate.stop);
  const n = duplicate.index + 1;
  const line = duplicate.reason === 'distance'
    ? `Within a few metres of stop #${n} (${text.title}) on this route`
    : `${duplicate.eircode || text.title} is stop #${n} on this route`;
  return (
    <View style={s.backdrop}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onOk} accessibilityLabel="Close" />
      <View style={s.sheet} accessibilityRole="alert">
        <View style={s.grabber} />
        <View style={[s.icon, { backgroundColor: c.warningBg }]}><Ionicons name="warning-outline" size={30} color={c.warning} /></View>
        <Text style={s.title}>Already in your stops</Text>
        <Text style={s.sub} numberOfLines={2}>{line}</Text>
        <View style={s.row}>
          <LightButton title="View stop" variant="outline" onPress={onView} style={{ flex: 1 }} />
          <LightButton title="OK" onPress={onOk} style={{ flex: 1 }} />
        </View>
        <Pressable onPress={onAddAnyway} hitSlop={8} style={{ marginTop: 18 }} accessibilityHint="Adds it again, for a second parcel to the same door">
          <Text style={s.link}>Add anyway</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** The same sheet in its own modal, for Add stops (typing or the field's scan icon). */
export function DuplicatePrompt({ duplicate, onView, onAddAnyway, onCancel }: {
  duplicate: Duplicate<Delivery> | null; onView: () => void; onAddAnyway: () => void; onCancel: () => void;
}) {
  return (
    <Modal visible={!!duplicate} transparent animationType="fade" statusBarTranslucent onRequestClose={onCancel}>
      {duplicate ? <DuplicateSheet duplicate={duplicate} onView={onView} onOk={onCancel} onAddAnyway={onAddAnyway} /> : null}
    </Modal>
  );
}

/** "Stop added · R93 Y201 · Leighlinbridge": scan the next parcel, or finish and go back to Add stops. */
export function StopAddedCard({ stop, onScanNext, onDone }: { stop: Delivery; onScanNext: () => void; onDone: () => void }) {
  const { title, address } = stopCardText(stop);
  const town = townOf(address);
  return (
    <View style={[s.backdrop, { justifyContent: 'center', padding: 28 }]}>
      <View style={s.card} accessibilityRole="alert">
        <View style={[s.icon, { backgroundColor: c.successBg }]}><Ionicons name="checkmark" size={32} color={c.success} /></View>
        <Text style={s.title}>Stop added</Text>
        <Text style={s.sub} numberOfLines={1}>{town ? `${title} · ${town}` : title}</Text>
        <View style={s.row}>
          <LightButton title="Scan next" icon={<MaterialCommunityIcons name="line-scan" size={20} color={c.onInk} />} onPress={onScanNext} style={{ flex: 1 }} />
          <LightButton title="Done" variant="outline" onPress={onDone} style={{ flex: 1 }} />
        </View>
      </View>
    </View>
  );
}

/** The town of an Irish address: the part before the county ("…, Leighlinbridge, Co. Carlow"), else the last part. */
function townOf(address: string) {
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return '';
  const last = parts[parts.length - 1];
  return /^(co\.?|county)\s/i.test(last) && parts.length > 1 ? parts[parts.length - 2] : last;
}

const s = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(24,24,27,0.5)', justifyContent: 'flex-end' },
  sheet: { alignItems: 'center', backgroundColor: c.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 24, paddingTop: 10, paddingBottom: 36 },
  grabber: { width: 36, height: 4, borderRadius: 2, backgroundColor: c.track, marginBottom: 24 },
  card: { alignItems: 'center', backgroundColor: c.surface, borderRadius: 24, paddingHorizontal: 24, paddingTop: 28, paddingBottom: 24 },
  icon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  title: { color: c.text, fontSize: 22, fontWeight: '700', marginTop: 18, textAlign: 'center' },
  sub: { color: c.textSecondary, fontSize: 15, marginTop: 6, textAlign: 'center' },
  row: { flexDirection: 'row', gap: 12, alignSelf: 'stretch', marginTop: 24 },
  link: { color: c.textLabel, fontSize: 15, fontWeight: '500', textDecorationLine: 'underline' },
});
