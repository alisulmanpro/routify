import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Delivery } from '../lib/types';
import { splitForDisplay } from '../lib/irishAddress';
import { premium as c, premiumRadius as r } from '../lib/theme';
import { DARK_ON_PRIMARY, PCard, Pill, type PillTone } from './Premium';

const STATUS: Record<Delivery['status'], { label: string; tone: PillTone }> = {
  pending: { label: 'Pending', tone: 'amber' },
  in_progress: { label: 'Arrived', tone: 'blue' },
  delivered: { label: 'Delivered', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' },
};

/** Whether the map location is verified, approximate, missing, or not looked up yet. */
function locationBadge(address: Delivery['address']): { label: string; color: string; icon: React.ComponentProps<typeof Ionicons>['name'] } {
  if (address.geocoded) return { label: 'Verified location', color: c.success, icon: 'checkmark-circle' };
  if (address.approximate || address.geocodeStatus === 'approximate') return { label: 'Approximate location', color: c.warning, icon: 'alert-circle' };
  if (address.geocodeStatus === 'not_found') return { label: 'Location not found', color: c.danger, icon: 'close-circle' };
  return { label: 'Location not checked yet', color: c.textMuted, icon: 'time-outline' };
}

/**
 * One stop: route position, recipient, address (in readable lines), Eircode, status and actions.
 * Long text wraps instead of stretching the card.
 */
export default function DeliveryCard({ delivery, stop, current, busy, onOpen, onNavigate, onDelivered }: {
  delivery: Delivery;
  /** Position on the route (1-based), or undefined when not on a route yet. */
  stop?: number;
  current?: boolean;
  busy?: boolean;
  onOpen: () => void;
  onNavigate: () => void;
  onDelivered: () => void;
}) {
  const { first, rest, eircode } = splitForDisplay(delivery.address.raw);
  const status = STATUS[delivery.status];
  const location = locationBadge(delivery.address);
  const open = delivery.status === 'pending' || delivery.status === 'in_progress';

  return (
    <PCard style={[s.card, current ? s.cardCurrent : {}]}>
      <View style={s.top}>
        <View style={[s.stop, current && s.stopCurrent]}>
          {stop ? <Text style={[s.stopText, current && { color: DARK_ON_PRIMARY }]}>{String(stop).padStart(2, '0')}</Text>
            : <Ionicons name="cube-outline" size={16} color={c.primary} />}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.label}>{stop ? (current ? 'Next stop' : `Stop ${stop}`) : 'Not on a route yet'}</Text>
          <Text style={s.recipient} numberOfLines={1}>{delivery.customer.name || 'No recipient name'}</Text>
        </View>
        <Pill text={status.label} tone={status.tone} />
      </View>

      <Pressable onPress={onOpen} style={s.body}>
        <Text style={s.label}>Address</Text>
        <Text style={s.addressMain} numberOfLines={2}>{first}</Text>
        {rest ? <Text style={s.addressRest} numberOfLines={2}>{rest}</Text> : null}

        <View style={s.chips}>
          {eircode ? (
            <View style={s.eircode}>
              <Text style={s.eircodeLabel}>EIRCODE</Text>
              <Text style={s.eircodeValue}>{eircode}</Text>
            </View>
          ) : null}
          <View style={s.location}>
            <Ionicons name={location.icon} size={13} color={location.color} />
            <Text style={{ color: location.color, fontSize: 11, fontWeight: '700' }}>{location.label}</Text>
          </View>
        </View>
        <Text style={s.parcel} numberOfLines={1}>Parcel {delivery.trackingId}{delivery.customer.phone ? ` · ${delivery.customer.phone}` : ''}</Text>
      </Pressable>

      <View style={s.actions}>
        <Action icon="navigate" label="Navigate" onPress={onNavigate} primary={current} />
        <Action icon="document-text-outline" label="Details" onPress={onOpen} />
        {open ? <Action icon="checkmark-done" label="Delivered" onPress={onDelivered} disabled={busy} /> : null}
      </View>
    </PCard>
  );
}

function Action({ icon, label, onPress, primary, disabled }: { icon: React.ComponentProps<typeof Ionicons>['name']; label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => [s.action, primary && s.actionPrimary, (pressed || disabled) && { opacity: 0.6 }]}>
      <Ionicons name={icon} size={15} color={primary ? DARK_ON_PRIMARY : c.text} />
      <Text style={[s.actionText, primary && { color: DARK_ON_PRIMARY }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: { padding: 14, gap: 12 },
  cardCurrent: { borderColor: 'rgba(255,170,50,0.5)' },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stop: { width: 40, height: 40, borderRadius: 20, backgroundColor: c.surfaceSoft, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  stopCurrent: { backgroundColor: c.primary, borderColor: c.primary },
  stopText: { color: c.text, fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'] },
  label: { color: c.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' },
  recipient: { color: c.text, fontSize: 16, fontWeight: '800', marginTop: 2 },
  body: { gap: 2 },
  addressMain: { color: c.text, fontSize: 14, fontWeight: '700', lineHeight: 20, marginTop: 2 },
  addressRest: { color: c.textSecondary, fontSize: 13, lineHeight: 18 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 8 },
  eircode: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 4, borderRadius: r.small, backgroundColor: 'rgba(255,170,50,0.12)', borderWidth: 1, borderColor: 'rgba(255,170,50,0.35)' },
  eircodeLabel: { color: c.primary, fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  eircodeValue: { color: c.text, fontSize: 13, fontWeight: '800', letterSpacing: 1, fontVariant: ['tabular-nums'] },
  location: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  parcel: { color: c.textMuted, fontSize: 11, marginTop: 6 },
  actions: { flexDirection: 'row', gap: 8, borderTopWidth: 1, borderTopColor: c.divider, paddingTop: 12 },
  action: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 38, borderRadius: r.small, backgroundColor: c.surfaceSoft, borderWidth: 1, borderColor: c.border, paddingHorizontal: 6 },
  actionPrimary: { backgroundColor: c.primary, borderColor: c.primary },
  actionText: { color: c.text, fontSize: 12, fontWeight: '800' },
});
