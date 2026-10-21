import { useEffect, useRef } from 'react';
import { View, type ViewStyle } from 'react-native';
import MapView, { Circle, Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import { Ionicons } from '@expo/vector-icons';
import { light as c } from '../../lib/theme';
import { LIGHT_MAP_STYLE } from '../../lib/mapStyles';

export type ConfirmMapProps = {
  /** The stop's point once it is found; until then the map shows `fallback` without a pin. */
  point: { latitude: number; longitude: number } | null;
  fallback: { latitude: number; longitude: number } | null;
  style?: ViewStyle;
};

// Ireland, for when neither the stop nor the rider's position is known yet.
const IRELAND = { latitude: 53.35, longitude: -7.7 };

/** The light, quiet map behind Confirm stop: one blue pin with a soft accuracy halo, no controls. */
export default function ConfirmMap({ point, fallback, style }: ConfirmMapProps) {
  const map = useRef<MapView>(null);
  const center = point || fallback || IRELAND;

  useEffect(() => {
    map.current?.animateCamera({ center, zoom: point ? 16 : fallback ? 13 : 6 }, { duration: 400 });
  }, [center.latitude, center.longitude, point, fallback]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={[{ backgroundColor: '#EEF0F3' }, style]}>
      <MapView
        ref={map}
        provider={PROVIDER_GOOGLE}
        style={{ flex: 1 }}
        customMapStyle={LIGHT_MAP_STYLE}
        initialCamera={{ center, zoom: point ? 16 : fallback ? 13 : 6, heading: 0, pitch: 0 }}
        toolbarEnabled={false}
        showsCompass={false}
        showsMyLocationButton={false}
        rotateEnabled={false}
        pitchEnabled={false}
      >
        {point ? (
          <>
            <Circle center={point} radius={45} fillColor="rgba(37,99,235,0.16)" strokeColor="rgba(37,99,235,0)" />
            <Marker coordinate={point} anchor={{ x: 0.5, y: 1 }} tracksViewChanges={false}>
              <Ionicons name="location" size={44} color={c.link} />
            </Marker>
          </>
        ) : null}
      </MapView>
    </View>
  );
}
