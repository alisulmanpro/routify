import { createElement, useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import type { Route } from '../lib/types';
import { colors, spacing } from '../lib/theme';

type Stop = Route['stops'][number];
type Coordinates = { latitude: number; longitude: number };
type OsrmResponse = {
  code: string;
  routes: {
    distance: number;
    duration: number;
    legs: { steps: { distance: number; name: string; maneuver: { type: string; modifier?: string } }[] }[];
  }[];
};

export default function OpenStreetMapNavigation({ destination }: { destination: Coordinates; approximate?: boolean; currentStopId: string; stops: Stop[]; onError: (message: string) => void }) {
  const [origin, setOrigin] = useState<Coordinates | null>(null);
  const [instructions, setInstructions] = useState<string[]>([]);
  const [trip, setTrip] = useState<{ distance: number; duration: number } | null>(null);
  const [message, setMessage] = useState('');
  const locationAvailable = typeof navigator !== 'undefined' && Boolean(navigator.geolocation);

  useEffect(() => {
    if (!locationAvailable) return;
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setOrigin({ latitude: coords.latitude, longitude: coords.longitude });
        setMessage('');
      },
      () => setMessage('Allow location access in your browser to show driving directions.'),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    );
  }, [locationAvailable]);

  useEffect(() => {
    if (!origin) return;
    const controller = new AbortController();
    const coordinates = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
    fetch(`https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=true`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Route directions are temporarily unavailable.');
        return response.json() as Promise<OsrmResponse>;
      })
      .then((data) => {
        const route = data.routes?.[0];
        if (data.code !== 'Ok' || !route) throw new Error('No driving route was found to this stop.');
        setTrip({ distance: route.distance, duration: route.duration });
        setInstructions(route.legs.flatMap((leg) => leg.steps.map((step) => {
          const { type, modifier } = step.maneuver;
          const direction = type === 'depart' ? `Head ${modifier || 'straight'}` : type === 'arrive' ? 'Arrive at the destination' : `${(modifier || type).replace(/_/g, ' ')} ${type === 'turn' ? 'turn' : type}`;
          const distance = step.distance >= 1000 ? `${(step.distance / 1000).toFixed(1)} km` : `${Math.round(step.distance)} m`;
          return `${direction}${step.name ? ` onto ${step.name}` : ''} · ${distance}`;
        })));
        setMessage('');
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        setMessage(error instanceof Error ? error.message : 'Could not load route directions.');
      });
    return () => controller.abort();
  }, [destination.latitude, destination.longitude, origin]);

  const mapUrl = useMemo(() => {
    const points = [destination, ...(origin ? [origin] : [])];
    const pad = 0.01;
    const bbox = [
      Math.min(...points.map((p) => p.longitude)) - pad,
      Math.min(...points.map((p) => p.latitude)) - pad,
      Math.max(...points.map((p) => p.longitude)) + pad,
      Math.max(...points.map((p) => p.latitude)) + pad,
    ].join(',');
    return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${destination.latitude},${destination.longitude}`;
  }, [destination, origin]);
  const directionsUrl = origin
    ? `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${origin.latitude},${origin.longitude};${destination.latitude},${destination.longitude}`
    : `https://www.openstreetmap.org/?mlat=${destination.latitude}&mlon=${destination.longitude}#map=16/${destination.latitude}/${destination.longitude}`;

  return (
    <View style={{ gap: spacing(3) }}>
      {createElement('iframe', { title: 'OpenStreetMap route map', src: mapUrl, style: { width: '100%', height: 330, border: 0, borderRadius: 8 } })}
      <Text style={{ color: colors.muted, fontSize: 11, textAlign: 'right' }}>Map data © OpenStreetMap contributors · Routing by OSRM</Text>
      {(message || (!locationAvailable ? 'Location is unavailable in this browser. Open the map to set your starting point.' : !origin ? 'Finding your location…' : '')) ? <Text style={{ color: colors.muted, fontSize: 13 }}>{message || (!locationAvailable ? 'Location is unavailable in this browser. Open the map to set your starting point.' : 'Finding your location…')}</Text> : null}
      {instructions[0] ? (
        <View style={{ backgroundColor: colors.blueBg, borderRadius: 8, padding: spacing(4) }}>
          <Text style={{ color: colors.primary, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }}>Next direction</Text>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', marginTop: spacing(2) }}>{instructions[0]}</Text>
          {trip ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: spacing(2) }}>{(trip.distance / 1000).toFixed(1)} km · {Math.max(1, Math.round(trip.duration / 60))} min remaining</Text> : null}
        </View>
      ) : null}
      <Pressable onPress={() => { void Linking.openURL(directionsUrl); }} accessibilityRole="link">
        <Text style={{ color: colors.primary, fontWeight: '700' }}>Open full route in OpenStreetMap</Text>
      </Pressable>
    </View>
  );
}
