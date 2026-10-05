import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { colors, spacing } from '../lib/theme';

type Coordinates = { latitude: number; longitude: number };
type RouteStop = Coordinates & { current: boolean; name: string };
export type RouteMapProps = { destination: Coordinates; position: Coordinates | null; path: Coordinates[]; stops: RouteStop[] };

export default function RouteMap({ destination, position }: RouteMapProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mapUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (position) params.append('loc', `${position.latitude},${position.longitude}`);
    params.append('loc', `${destination.latitude},${destination.longitude}`);
    const center = position
      ? `${(position.latitude + destination.latitude) / 2},${(position.longitude + destination.longitude) / 2}`
      : `${destination.latitude},${destination.longitude}`;
    params.set('center', center);
    params.set('z', position ? '12' : '15');
    return `https://map.project-osrm.org/?${params.toString()}`;
  }, [destination.latitude, destination.longitude, position]);

  useEffect(() => {
    timeoutRef.current = setTimeout(() => setError(true), 15_000);
    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); };
  }, [mapUrl]);

  return (
    <View style={{ height: 330, borderRadius: 8, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' }}>
      <WebView source={{ uri: mapUrl }} originWhitelist={['https://*']} javaScriptEnabled domStorageEnabled
        androidLayerType="software"
        onLoadStart={() => { setLoading(true); setError(false); }}
        onLoadEnd={() => { if (timeoutRef.current) clearTimeout(timeoutRef.current); setLoading(false); }}
        onError={() => { if (timeoutRef.current) clearTimeout(timeoutRef.current); setLoading(false); setError(true); }}
        style={{ flex: 1, backgroundColor: colors.bg }} />
      {error ? <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center', padding: spacing(4) }}><Text style={{ color: colors.text, fontWeight: '700', textAlign: 'center' }}>Map tiles could not load. Check your internet connection and try again.</Text></View> : null}
      {loading && !error ? <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: colors.muted }}>Loading route map…</Text></View> : null}
    </View>
  );
}
