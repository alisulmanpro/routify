import { Linking, Pressable, Text, View } from 'react-native';
import { colors, spacing } from '../lib/theme';
import type { RouteMapProps } from './RouteMap.native';

export default function RouteMap({ destination }: RouteMapProps) {
  const url = `https://www.openstreetmap.org/?mlat=${destination.latitude}&mlon=${destination.longitude}#map=15/${destination.latitude}/${destination.longitude}`;
  return <View style={{ height: 220, alignItems: 'center', justifyContent: 'center', gap: spacing(3), backgroundColor: colors.muted2, borderRadius: 8, padding: spacing(4) }}>
    <Text style={{ color: colors.text, textAlign: 'center' }}>OpenStreetMap preview is available in the mobile app.</Text>
    <Pressable onPress={() => Linking.openURL(url)}><Text style={{ color: colors.primary, fontWeight: '700' }}>Open this stop in OpenStreetMap</Text></Pressable>
  </View>;
}
