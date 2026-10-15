import { Linking, Pressable, Text, View } from 'react-native';
import { premium as c } from '../lib/theme';
import type { GoogleRouteMapProps } from './GoogleRouteMap.native';

// The native Google map is mobile-only; on web, link out to Google Maps instead.
export default function GoogleRouteMap({ stops, style }: GoogleRouteMapProps) {
  const next = stops.find((s) => s.kind === 'next') || stops[0];
  return (
    <View style={[{ height: 220, alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: c.surface, padding: 16 }, style]}>
      <Text style={{ color: c.text, textAlign: 'center' }}>The route map is available in the mobile app.</Text>
      {next ? (
        <Pressable onPress={() => Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${next.latitude},${next.longitude}`)}>
          <Text style={{ color: c.primary, fontWeight: '700' }}>Open the next stop in Google Maps</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
