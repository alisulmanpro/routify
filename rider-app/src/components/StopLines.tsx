import { Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { McName } from './Premium';
import { stopCardText } from '../lib/format';
import type { Delivery } from '../lib/types';
import { premium as c } from '../lib/theme';

/**
 * The text of a stop card, the same in Add stops, Review route and route details: the Eircode (bold), the place name
 * and address, then whether the stop is on the map. Without an Eircode the address is the bold title.
 */
export default function StopLines({ stop }: { stop: Delivery }) {
  const { title, address } = stopCardText(stop);
  return (
    <View>
      <Text style={{ color: c.text, fontWeight: '800', fontSize: 14 }} numberOfLines={address ? 1 : 2}>{title}</Text>
      {address ? <Text style={{ color: c.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={2}>{address}</Text> : null}
      <LocationTag stop={stop} />
    </View>
  );
}

function LocationTag({ stop }: { stop: Delivery }) {
  const { geocodeStatus: status, approximate } = stop.address;
  const [icon, color, text]: [McName, string, string] = status === 'not_found' ? ['map-marker-off', c.danger, 'Location not found']
    : approximate || status === 'approximate' ? ['map-marker-question', c.warning, 'Approximate location']
      : status === 'found' ? ['map-marker-check', c.success, 'Location confirmed'] : ['map-marker-outline', c.textMuted, 'Located when the route is planned'];
  // The parcel ID and customer, when there are any, so nothing the old title showed is lost.
  const extra = [stop.trackingId, stop.customer.name].filter(Boolean).join('  ·  ');
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
      <MaterialCommunityIcons name={icon} size={12} color={color} />
      <Text style={{ color, fontSize: 11, fontWeight: '600', flexShrink: 1 }} numberOfLines={1}>
        {text}{extra ? <Text style={{ color: c.textMuted }}>{`  ·  ${extra}`}</Text> : null}
      </Text>
    </View>
  );
}
