import { Alert, Linking, Platform } from 'react-native';
import { ApiRequestError } from './api';
import { sendStopEvent } from './v2api';
import type { Delivery } from './types';
import { stopLabel } from './format';

/** Opens Google Maps turn-by-turn directions to a delivery. */
export function openDirections(delivery: Delivery) {
  const { address } = delivery;
  // Approximate coordinates only point at the area, so let Google search the full address instead.
  const destination = address.geocoded && address.latitude != null && address.longitude != null ? `${address.latitude},${address.longitude}` : address.raw;
  const web = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving&dir_action=navigate`;
  const app = Platform.OS === 'android' ? `google.navigation:q=${encodeURIComponent(destination)}&mode=d` : web;
  Linking.openURL(app).catch(() => Linking.openURL(web).catch(() => {}));
}

const confirm = (title: string, message: string, action: string) => new Promise<boolean>((resolve) => {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
    { text: action, onPress: () => resolve(true) },
  ], { cancelable: true, onDismiss: () => resolve(false) });
});

/**
 * Marks a delivery delivered from a list: asks first, then one request (the server records "arrived" itself), and asks
 * again if earlier stops on the route are still open. Resolves true when it was marked delivered.
 */
export async function markDelivered(delivery: Delivery): Promise<boolean> {
  const name = stopLabel(delivery);
  if (!(await confirm('Mark as delivered?', `Confirm the parcel was handed over to ${name}. A proof photo can be added from the delivery details.`, 'Delivered'))) return false;
  try {
    await sendStopEvent(delivery.id, { type: 'deliver' });
  } catch (err) {
    if (!(err instanceof ApiRequestError) || err.code !== 'EARLIER_STOPS_REMAIN') throw err;
    if (!(await confirm('Earlier stops still open', 'Some stops before this one on your route are not finished yet. Deliver this one anyway?', 'Continue anyway'))) return false;
    await sendStopEvent(delivery.id, { type: 'deliver', allowSkip: true });
  }
  return true;
}

