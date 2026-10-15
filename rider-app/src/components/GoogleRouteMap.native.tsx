import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { premium as c } from '../lib/theme';

export type Coordinates = { latitude: number; longitude: number };
export type MapStop = Coordinates & { id: string; label: string; title: string; kind: 'next' | 'upcoming' | 'done' | 'failed' };
export type GoogleRouteMapProps = {
  stops: MapStop[];
  position: Coordinates | null;
  // Road path through the remaining stops; when empty, straight dashed lines join them instead.
  path: Coordinates[];
  // The remaining stops in visiting order, used for the dashed fallback line.
  order: Coordinates[];
  focus?: Coordinates | null;
  style?: ViewStyle;
  // Pin mode: a fixed pin sits in the middle of the map and the rider moves the map under it.
  pinning?: boolean;
  onCenterChange?: (center: Coordinates) => void;
};

const EDGE = { top: 60, right: 50, bottom: 60, left: 50 };
const MARKER_COLORS: Record<MapStop['kind'], { bg: string; fg: string; border: string }> = {
  next: { bg: c.primary, fg: '#1A1206', border: '#fff' },
  upcoming: { bg: '#16223A', fg: c.text, border: c.textSecondary },
  done: { bg: c.success, fg: '#05301E', border: '#fff' },
  failed: { bg: c.danger, fg: '#fff', border: '#fff' },
};

export default function GoogleRouteMap({ stops, position, path, order, focus, style, pinning, onCenterChange }: GoogleRouteMapProps) {
  const map = useRef<MapView>(null);
  const [ready, setReady] = useState(false);
  // Android draws custom marker views once; keep redrawing briefly so they appear, then stop for speed.
  const [redraw, setRedraw] = useState(true);
  // Once the rider pans or zooms, automatic fitting stops until they tap the fit button.
  const userMoved = useRef(false);
  const layoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setRedraw(false), 800);
    return () => clearTimeout(timer);
  }, [stops]);
  useEffect(() => {
    const timer = setTimeout(() => setRedraw(true), 0);
    return () => clearTimeout(timer);
  }, [stops]);

  // Every marker (all stops and the rider) in view.
  const fit = (animated: boolean) => {
    const all = [...stops, ...(position ? [position] : [])];
    if (all.length > 1) map.current?.fitToCoordinates(all, { edgePadding: EDGE, animated });
    else if (all.length) map.current?.animateCamera({ center: all[0], zoom: 15 }, { duration: animated ? 400 : 0 });
  };

  // After placing a pin, show the whole route again.
  useEffect(() => { if (!pinning) userMoved.current = false; }, [pinning]);

  // Re-fit when the stops or their order change (new route, re-optimised, a stop pinned).
  const fitKey = stops.map((s) => `${s.id}@${s.latitude},${s.longitude}`).join('|');
  useEffect(() => {
    if (!ready || userMoved.current || pinning || (!stops.length && !position)) return;
    fit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fitKey, pinning]);

  // The map grows and shrinks with the list below; fit again once its size settles.
  const onLayout = (_e: LayoutChangeEvent) => {
    if (layoutTimer.current) clearTimeout(layoutTimer.current);
    layoutTimer.current = setTimeout(() => { if (ready && !userMoved.current && !pinning) fit(true); }, 250);
  };
  useEffect(() => () => { if (layoutTimer.current) clearTimeout(layoutTimer.current); }, []);

  useEffect(() => {
    if (!ready || !focus) return;
    // A stop the rider picked stays in view; resizing the map no longer re-fits it.
    userMoved.current = true;
    map.current?.animateCamera({ center: focus, zoom: 16 }, { duration: 500 });
  }, [ready, focus]);

  const start = position || stops[0] || { latitude: 0, longitude: 0 };

  return (
    <View onLayout={onLayout} style={[{ height: 300, overflow: 'hidden', backgroundColor: c.surface }, style]}>
      <MapView
        ref={map}
        provider={PROVIDER_GOOGLE}
        style={{ flex: 1 }}
        initialRegion={{ ...start, latitudeDelta: 0.05, longitudeDelta: 0.05 }}
        customMapStyle={DARK_STYLE}
        onMapReady={() => setReady(true)}
        onRegionChangeComplete={(region, details) => {
          if (details?.isGesture) userMoved.current = true;
          if (pinning) onCenterChange?.({ latitude: region.latitude, longitude: region.longitude });
        }}
        toolbarEnabled={false}
        showsCompass={false}
        rotateEnabled={false}
        pitchEnabled={false}
      >
        {path.length > 1 ? (
          <Polyline coordinates={path} strokeColor={c.primary} strokeWidth={5} />
        ) : order.length > 1 || (position && order.length) ? (
          <Polyline coordinates={position ? [position, ...order] : order} strokeColor={c.primary} strokeWidth={3} lineDashPattern={[10, 8]} />
        ) : null}

        {stops.map((s) => {
          const col = MARKER_COLORS[s.kind];
          const big = s.kind === 'next';
          return (
            <Marker key={s.id} coordinate={s} title={s.title} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={redraw} zIndex={big ? 10 : s.kind === 'upcoming' ? 5 : 1}>
              <View style={{ width: big ? 36 : 28, height: big ? 36 : 28, borderRadius: 18, backgroundColor: col.bg, borderWidth: big ? 3 : 2, borderColor: col.border, alignItems: 'center', justifyContent: 'center' }}>
                {s.kind === 'done' ? <Ionicons name="checkmark" size={15} color={col.fg} />
                  : s.kind === 'failed' ? <Ionicons name="close" size={15} color={col.fg} />
                    : <Text style={{ color: col.fg, fontWeight: '800', fontSize: big ? 14 : 12 }}>{s.label}</Text>}
              </View>
            </Marker>
          );
        })}

        {position ? (
          <Marker coordinate={position} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={redraw} zIndex={20} title="You are here">
            <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(61,139,255,0.3)', alignItems: 'center', justifyContent: 'center' }}>
              <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: '#3D8BFF', borderWidth: 2, borderColor: '#fff' }} />
            </View>
          </Marker>
        ) : null}
      </MapView>

      {pinning ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
          {/* The pin's tip marks the map centre. */}
          <View style={{ marginBottom: 40, alignItems: 'center' }}>
            <MaterialCommunityIcons name="map-marker" size={44} color={c.primary} />
          </View>
        </View>
      ) : null}

      <Pressable onPress={() => { userMoved.current = false; fit(true); }} hitSlop={6} style={{ position: 'absolute', right: 12, top: 12, width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(13,22,41,0.92)', borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' }}>
        <MaterialCommunityIcons name="crosshairs-gps" size={19} color={c.primary} />
      </Pressable>
    </View>
  );
}

// Google's dark map theme, close to the app's colours.
const DARK_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#1d2c4d' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8ec3b9' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1a3646' }] },
  { featureType: 'administrative.country', elementType: 'geometry.stroke', stylers: [{ color: '#4b6878' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#023e58' }] },
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#283d6a' }] },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#6f9ba5' }] },
  { featureType: 'poi.park', elementType: 'geometry.fill', stylers: [{ color: '#023e58' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#304a7d' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#98a5be' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#2c6675' }] },
  { featureType: 'transit', elementType: 'labels.text.fill', stylers: [{ color: '#98a5be' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e1626' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4e6d70' }] },
];
