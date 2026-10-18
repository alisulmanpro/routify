import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import GoogleRouteMap, { type Coordinates } from './GoogleRouteMap';
import { post } from '../lib/api';
import { getRouteOrigin } from '../lib/location';
import { premium as c, premiumRadius as r } from '../lib/theme';
import { PButton } from './Premium';

export type PinResult = Coordinates & { address: string };

type Props = { visible: boolean; position: Coordinates | null; center: Coordinates | null; onClose: () => void; onPick: (pin: PinResult) => void };

/** Full-screen map: the rider moves the map under a fixed pin, then confirms. The pin's street address is looked up. */
export default function PinSheet({ visible, ...props }: Props) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={props.onClose}>
      {visible ? <PinBody {...props} /> : null}
    </Modal>
  );
}

// Mounted fresh each time the sheet opens, so the pin starts where the rider is (or their city).
function PinBody({ position, center, onClose, onPick }: Omit<Props, 'visible'>) {
  const [here, setHere] = useState<Coordinates | null>(position);
  const [at, setAt] = useState<Coordinates | null>(position || center);
  // The map only opens once it knows where to start; otherwise it would open on the ocean at 0,0.
  const [locating, setLocating] = useState(!position && !center);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (position) return;
    let alive = true;
    void getRouteOrigin().then((gps) => {
      if (!alive) return;
      if (gps) { setHere(gps); if (!center) setAt(gps); }
      setLocating(false);
    });
    return () => { alive = false; };
  }, [position, center]);
  const start = here || center;

  const confirm = async () => {
    if (!at) return;
    setSaving(true);
    let address: string | null = null;
    try {
      address = (await post<{ address: string | null }>('/deliveries/geocode-reverse', at)).data.address;
    } catch {
      // The pin itself is what matters; the rider can type a better address afterwards.
    } finally {
      setSaving(false);
    }
    onPick({ ...at, address: address || `Pinned location ${at.latitude.toFixed(5)}, ${at.longitude.toFixed(5)}` });
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      {locating ? (
        <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', gap: 10 }]}>
          <ActivityIndicator color={c.primary} />
          <Text style={{ color: c.textSecondary, fontSize: 13 }}>Finding your location…</Text>
        </View>
      ) : start ? (
        <GoogleRouteMap stops={[]} position={here} path={[]} order={[]} pinning onCenterChange={setAt} initialCenter={start}
          focus={start} style={{ height: '100%' }} />
      ) : (
        <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', padding: 30 }]}>
          <Text style={{ color: c.textSecondary, fontSize: 13, textAlign: 'center' }}>Turn on location so the map can open where you are, or type the address instead.</Text>
        </View>
      )}
      <View style={[s.top, { top: Platform.OS === 'ios' ? 50 : 16 }]}>
        <Text style={{ flex: 1, color: c.text, fontWeight: '800', fontSize: 15 }}>Move the map to put the pin on the door</Text>
        <Pressable onPress={onClose} hitSlop={10} style={s.close}><Ionicons name="close" size={20} color={c.text} /></Pressable>
      </View>
      <View style={s.bottom}>
        <PButton title="Use this location" icon="location" onPress={() => void confirm()} loading={saving} disabled={!at || locating || !start} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  top: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: r.medium, backgroundColor: 'rgba(13,22,41,0.95)', borderWidth: 1, borderColor: c.border },
  close: { width: 34, height: 34, borderRadius: 17, backgroundColor: c.surfaceSoft, alignItems: 'center', justifyContent: 'center' },
  bottom: { position: 'absolute', left: 16, right: 16, bottom: 28 },
});
