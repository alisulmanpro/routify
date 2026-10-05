import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import * as Location from 'expo-location';
import type { Route } from '../lib/types';
import { titleCase } from '../lib/format';
import { colors, spacing } from '../lib/theme';
import RouteMap from './RouteMap';

type Stop = Route['stops'][number];
type Coordinates = { latitude: number; longitude: number };
type OsrmResponse = {
  code: string;
  routes: {
    distance: number;
    duration: number;
    geometry: { coordinates: [number, number][] };
    legs: { steps: { distance: number; name: string; maneuver: { type: string; modifier?: string } }[] }[];
  }[];
};

export default function OpenStreetMapNavigation({ destination, currentStopId, stops, onError }: { destination: Coordinates; currentStopId: string; stops: Stop[]; onError: (message: string) => void }) {
  const [position, setPosition] = useState<Coordinates | null>(null);
  const [routePosition, setRoutePosition] = useState<Coordinates | null>(null);
  const [path, setPath] = useState<Coordinates[]>([]);
  const [instructions, setInstructions] = useState<string[]>([]);
  const [trip, setTrip] = useState<{ distance: number; duration: number } | null>(null);
  const lastRoutedPosition = useRef<Coordinates | null>(null);
  const lastRoutedDestination = useRef('');

  useEffect(() => {
    let mounted = true;
    let subscription: Location.LocationSubscription | null = null;
    const startTracking = async () => {
      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (!permission.granted) {
          onError('Allow location access to show your position and in-app directions.');
          return;
        }
        const last = await Location.getLastKnownPositionAsync();
        if (mounted && last) setPosition({ latitude: last.coords.latitude, longitude: last.coords.longitude });
        subscription = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, distanceInterval: 10, timeInterval: 5000 },
          (location) => setPosition({ latitude: location.coords.latitude, longitude: location.coords.longitude }),
          (reason) => onError(`Location update failed: ${reason}`),
        );
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Could not start location tracking');
      }
    };
    startTracking();
    return () => {
      mounted = false;
      subscription?.remove();
    };
  }, [onError]);

  useEffect(() => {
    if (!position) return;
    const destinationKey = `${destination.latitude},${destination.longitude}`;
    if (lastRoutedPosition.current && lastRoutedDestination.current === destinationKey) {
      const latMeters = (position.latitude - lastRoutedPosition.current.latitude) * 111_000;
      const lonMeters = (position.longitude - lastRoutedPosition.current.longitude) * 111_000 * Math.cos(position.latitude * Math.PI / 180);
      if (Math.hypot(latMeters, lonMeters) < 50) return;
    }
    lastRoutedPosition.current = position;
    lastRoutedDestination.current = destinationKey;
    setRoutePosition(position);
  }, [destination.latitude, destination.longitude, position]);

  useEffect(() => {
    if (!routePosition) return;
    const controller = new AbortController();
    const coordinates = `${routePosition.longitude},${routePosition.latitude};${destination.longitude},${destination.latitude}`;
    const url = `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=true`;
    fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Route directions are temporarily unavailable');
        return response.json() as Promise<OsrmResponse>;
      })
      .then((data) => {
        const route = data.routes?.[0];
        if (data.code !== 'Ok' || !route) throw new Error('No driving route was found to this stop');
        setPath(route.geometry.coordinates.map(([longitude, latitude]) => ({ latitude, longitude })));
        setTrip({ distance: route.distance, duration: route.duration });
        setInstructions(route.legs.flatMap((leg) => leg.steps.map((step) => {
          const maneuver = step.maneuver;
          const direction = maneuver.type === 'depart'
            ? `Head ${maneuver.modifier || 'straight'}`
            : maneuver.type === 'arrive'
              ? 'Arrive at the destination'
              : `${titleCase(maneuver.modifier || maneuver.type)} ${maneuver.type === 'turn' ? 'turn' : titleCase(maneuver.type)}`;
          const street = step.name ? ` onto ${step.name}` : '';
          const distance = step.distance >= 1000 ? `${(step.distance / 1000).toFixed(1)} km` : `${Math.round(step.distance)} m`;
          return `${direction}${street} · ${distance}`;
        })));
      })
      .catch((err) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        onError(err instanceof Error ? err.message : 'Could not load in-app directions');
      });
    return () => controller.abort();
  }, [destination.latitude, destination.longitude, onError, routePosition]);

  const mapStops = stops.flatMap((stop) => {
    const address = stop.delivery.address;
    if (!address.geocoded || address.latitude == null || address.longitude == null) return [];
    return [{ latitude: address.latitude, longitude: address.longitude, current: stop.delivery.id === currentStopId, name: `Delivery ${stop.order}: ${stop.delivery.customer.name}` }];
  });
  const nextInstruction = instructions[0];

  return (
    <View style={{ gap: spacing(3) }}>
      <RouteMap destination={destination} position={position} path={path} stops={mapStops} />
      <Text style={{ color: colors.muted, fontSize: 11, textAlign: 'right' }}>Map data © OpenStreetMap contributors · Routing by OSRM</Text>
      {nextInstruction ? (
        <View style={{ backgroundColor: colors.blueBg, borderRadius: 8, padding: spacing(4) }}>
          <Text style={{ color: colors.primary, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }}>Next direction</Text>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', marginTop: spacing(2) }}>{nextInstruction}</Text>
          {trip ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: spacing(2) }}>{(trip.distance / 1000).toFixed(1)} km · {Math.max(1, Math.round(trip.duration / 60))} min remaining</Text> : null}
        </View>
      ) : (
        <Text style={{ color: colors.muted, fontSize: 13 }}>{position ? 'Loading route directions…' : 'Waiting for your location…'}</Text>
      )}
    </View>
  );
}
