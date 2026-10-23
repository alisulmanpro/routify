import { Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { McName } from './Premium';
import { stopCardText } from '../lib/format';
import type { Delivery } from '../lib/types';
import { light as l, premium as c } from '../lib/theme';

/**
 * The text of a stop card, the same in Add stops, Review route and route details: the Eircode (bold), the place name
 * and address, then whether the stop is on the map. Without an Eircode the address is the bold title.
 * `light` draws it for the light design_pref screens (Add stops); without it, it keeps the dark premium look.
 */
export default function StopLines({ stop, light = false }: { stop: Delivery; light?: boolean }) {
  const { title, address } = stopCardText(stop);
  const t = light ? LIGHT : DARK;
  return (
    <View>
      <Text style={{ color: t.text, fontWeight: light ? '700' : '800', fontSize: light ? 17 : 14 }} numberOfLines={address ? 1 : 2}>{title}</Text>
      {address ? <Text style={{ color: t.secondary, fontSize: light ? 15 : 12, lineHeight: light ? 21 : undefined, marginTop: light ? 4 : 2 }} numberOfLines={2}>{address}</Text> : null}
      <LocationTag stop={stop} light={light} />
    </View>
  );
}

const DARK = { text: c.text, secondary: c.textSecondary, muted: c.textMuted, danger: c.danger, warning: c.warning, success: c.success };
const LIGHT = { text: l.text, secondary: l.textSecondary, muted: l.placeholder, danger: l.danger, warning: l.warning, success: l.success };

function LocationTag({ stop, light }: { stop: Delivery; light: boolean }) {
  const t = light ? LIGHT : DARK;
  const { geocodeStatus: status, approximate } = stop.address;
  const [icon, color, text]: [McName, string, string] = status === 'not_found' ? ['map-marker-off', t.danger, 'Location not found']
    : approximate || status === 'approximate' ? ['map-marker-question', t.warning, 'Approximate location']
      : status === 'found' ? [light ? 'check' : 'map-marker-check', t.success, 'Location confirmed'] : ['map-marker-outline', t.muted, 'Located when the route is planned'];
  // The parcel ID and customer, when there are any, so nothing the old title showed is lost.
  const extra = [stop.trackingId, stop.customer.name].filter(Boolean).join('  ·  ');
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: light ? 6 : 4, marginTop: light ? 8 : 4 }}>
      <MaterialCommunityIcons name={icon} size={light ? 15 : 12} color={color} />
      <Text style={{ color, fontSize: light ? 14 : 11, fontWeight: light ? '500' : '600', flexShrink: 1 }} numberOfLines={1}>
        {text}{extra ? <Text style={{ color: t.muted }}>{`  ·  ${extra}`}</Text> : null}
      </Text>
    </View>
  );
}
