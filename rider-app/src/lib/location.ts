import * as Location from 'expo-location';

/**
 * Development only: a fixed position used instead of GPS, to test another city from your desk.
 * Set EXPO_PUBLIC_TEST_LOCATION="53.3498,-6.2603" (latitude,longitude) in .env and restart Expo.
 * Release builds always use the real GPS.
 */
export const TEST_LOCATION = (() => {
  if (!__DEV__) return null;
  const [latitude, longitude] = (process.env.EXPO_PUBLIC_TEST_LOCATION || '').split(',').map((v: string) => Number(v.trim()));
  return Number.isFinite(latitude) && Number.isFinite(longitude) && (latitude !== 0 || longitude !== 0) ? { latitude, longitude } : null;
})();

export async function getRouteOrigin() {
  if (TEST_LOCATION) return TEST_LOCATION;
  try {
    let permission = await Location.getForegroundPermissionsAsync();
    if (!permission.granted) permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return null;

    const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { latitude: current.coords.latitude, longitude: current.coords.longitude };
  } catch {
    return null;
  }
}