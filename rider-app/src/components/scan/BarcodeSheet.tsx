import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Platform, Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { premium as c } from '../../lib/theme';
import { PButton } from '../Premium';

// Every symbology the camera supports: labels vary a lot between couriers.
const BARCODE_TYPES: BarcodeType[] = ['qr', 'code128', 'code39', 'code93', 'ean13', 'ean8', 'upc_a', 'upc_e', 'itf14', 'codabar', 'datamatrix', 'pdf417', 'aztec'];
// A code must read the same twice in a row, so one misread frame is never used.
const REQUIRED_HITS = 2;

/** The camera on its own sheet, reading only a barcode or QR code (the parcel ID field's scan button). */
export default function BarcodeSheet({ visible, onClose, onResult }: { visible: boolean; onClose: () => void; onResult: (parcel: string) => void }) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      {visible ? <BarcodeBody onClose={onClose} onResult={onResult} /> : null}
    </Modal>
  );
}

function BarcodeBody({ onClose, onResult }: { onClose: () => void; onResult: (parcel: string) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const candidate = useRef({ value: '', hits: 0 });

  // Asked once, the first time the camera opens; after a "no" the rider uses the button (or settings).
  useEffect(() => {
    if (permission?.status === 'undetermined' && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

  const onBarcodeScanned = ({ data }: { data: string }) => {
    const raw = (data ?? '').trim();
    if (raw.length < 3) return;
    if (candidate.current.value !== raw) { candidate.current = { value: raw, hits: 1 }; return; }
    candidate.current.hits += 1;
    if (candidate.current.hits !== REQUIRED_HITS) return;
    Vibration.vibrate(30);
    onResult(raw.replace(/\s+/g, '').toUpperCase().slice(0, 80));
  };

  const denied = permission && !permission.granted;
  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {!permission ? <View style={[StyleSheet.absoluteFill, s.center]}><ActivityIndicator color="#FFFFFF" /></View> : denied ? (
        <View style={[StyleSheet.absoluteFill, s.center, { padding: 24, backgroundColor: c.background }]}>
          <Ionicons name="camera-outline" size={34} color={c.textMuted} />
          <Text style={{ color: c.text, fontWeight: '800', fontSize: 16, marginTop: 10 }}>Camera access is off</Text>
          <Text style={{ color: c.textSecondary, fontSize: 13, textAlign: 'center', marginTop: 6 }}>
            {permission.canAskAgain ? 'Allow the camera to scan barcodes.' : 'Turn on Camera for this app in your phone settings.'}
          </Text>
          <PButton title={permission.canAskAgain ? 'Allow camera' : 'Open settings'} icon={permission.canAskAgain ? 'camera' : 'settings-outline'}
            onPress={() => void (permission.canAskAgain ? requestPermission() : Linking.openSettings())} style={{ marginTop: 16, alignSelf: 'stretch' }} />
        </View>
      ) : (
        <CameraView style={StyleSheet.absoluteFill} facing="back" enableTorch={torch} barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }} onBarcodeScanned={onBarcodeScanned} />
      )}
      {!denied ? (
        <>
          <View pointerEvents="none" style={s.frame} />
          <Text style={s.hint}>Point at the barcode or QR code</Text>
        </>
      ) : null}
      <View style={[s.top, { paddingTop: Platform.OS === 'ios' ? 54 : 18 }]}>
        <Text style={s.title}>Scan parcel ID</Text>
        {!denied ? (
          <Pressable onPress={() => setTorch((t) => !t)} hitSlop={8} style={s.round} accessibilityLabel={torch ? 'Torch off' : 'Torch on'}>
            <Ionicons name={torch ? 'flash' : 'flash-outline'} size={18} color={torch ? '#FFE27A' : '#fff'} />
          </Pressable>
        ) : null}
        <Pressable onPress={onClose} hitSlop={10} style={s.round} accessibilityLabel="Close"><Ionicons name="close" size={20} color="#fff" /></Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  top: { position: 'absolute', left: 0, right: 0, top: 0, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 12, backgroundColor: 'rgba(5,11,24,0.55)' },
  title: { flex: 1, color: '#fff', fontSize: 18, fontWeight: '800' },
  round: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(5,11,24,0.7)', alignItems: 'center', justifyContent: 'center' },
  frame: { position: 'absolute', top: '32%', height: '22%', left: '10%', right: '10%', borderWidth: 3, borderColor: '#FFFFFF', borderRadius: 14 },
  hint: { position: 'absolute', top: '26%', left: 16, right: 16, textAlign: 'center', color: '#fff', fontSize: 13, fontWeight: '700', textShadowColor: '#000', textShadowRadius: 6 },
});
