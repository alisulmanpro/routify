import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Linking, Platform, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission, usePhotoOutput, type TorchMode } from 'react-native-vision-camera';
import { PhotoRecognizer } from 'react-native-vision-camera-ocr-plus';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { containFit, photoLines, pickAddress, type PhotoLine, type PickedAddress } from '../../lib/scan/photoLines';
import { premium as c, premiumRadius as r } from '../../lib/theme';
import { PButton } from '../Premium';

// Photo settings must be constants: a new object makes the camera set its session up again. 1440 × 1920 is sharp
// enough for small print on a label and still quick to read (a 12 MP photo is several times slower, worst on iPhone).
const PHOTO_RESOLUTION = { width: 1440, height: 1920 };

// Torch calls the camera cancels when it stops are harmless (the Eircode scanner ignores them the same way).
const onCameraError = (err: Error) => { if (__DEV__) console.log('[address scan] camera:', err.message); };

type Photo = { uri: string; width: number; height: number; lines: PhotoLine[] };

type Props = {
  /** The rider chose lines: their address text, or the Eircode among them. */
  onPicked: (picked: PickedAddress) => void;
  onTypeInstead: () => void;
  onClose: () => void;
  /** The Eircode / Address switch, drawn under the top bar. */
  modeSwitch: React.ReactNode;
};

/**
 * Address scanner: the rider takes one photo, every line of text in it gets a box, and the rider taps the lines that
 * make up the address (one line out of a page of addresses, or the 2-3 lines of a label). Nothing is guessed: the
 * chosen text goes to the address field, where the map search and its checks take over.
 */
export default function AddressScan({ onPicked, onTypeInstead, onClose, modeSwitch }: Props) {
  const device = useCameraDevice('back');
  const { hasPermission, canRequestPermission, requestPermission } = useCameraPermission();
  const photoOutput = usePhotoOutput({ targetResolution: PHOTO_RESOLUTION, containerFormat: 'jpeg' });
  const outputs = useMemo(() => [photoOutput], [photoOutput]);
  const [started, setStarted] = useState(false);
  const onStarted = useCallback(() => setStarted(true), []);
  const onStopped = useCallback(() => setStarted(false), []);
  const [torch, setTorch] = useState(false);
  const [reading, setReading] = useState(false);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [view, setView] = useState({ width: 0, height: 0 });

  const take = async () => {
    setReading(true);
    setError('');
    try {
      const shot = await photoOutput.capturePhotoToFile({ flashMode: 'off', enableShutterSound: false }, {});
      // Drawn upright and saved again: the camera file may only say "rotate me" (EXIF), which the text reader on
      // Android ignores; the saved copy's pixels, size and boxes all match what is shown.
      const upright = await (await ImageManipulator.manipulate(`file://${shot.filePath}`).renderAsync()).saveAsync({ compress: 0.9, format: SaveFormat.JPEG });
      const result = await PhotoRecognizer({ uri: upright.uri });
      const lines = photoLines(result);
      setChosen(new Set());
      setPhoto({ uri: upright.uri, width: upright.width, height: upright.height, lines });
      if (!lines.length) setError('No text found. Hold the phone closer and steady, or turn on the torch.');
    } catch (err) {
      if (__DEV__) console.warn('[address scan]', err);
      setError('Could not read the photo. Try again.');
    } finally {
      setReading(false);
    }
  };

  const retake = () => { setPhoto(null); setChosen(new Set()); setError(''); };
  const toggle = (id: string) => setChosen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const picked = photo ? pickAddress(photo.lines, chosen) : null;
  const onLayout = (e: LayoutChangeEvent) => setView({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });
  const fit = photo && view.width ? containFit(photo, view) : null;
  const torchMode: TorchMode | undefined = started && !photo ? (torch ? 'on' : 'off') : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {!hasPermission ? (
        <View style={[StyleSheet.absoluteFill, s.center, { padding: 24, backgroundColor: c.background }]}>
          <Ionicons name="camera-outline" size={34} color={c.textMuted} />
          <Text style={{ color: c.text, fontWeight: '800', fontSize: 16, marginTop: 10 }}>Camera access is off</Text>
          <PButton title={canRequestPermission ? 'Allow camera' : 'Open settings'} icon={canRequestPermission ? 'camera' : 'settings-outline'}
            onPress={() => void (canRequestPermission ? requestPermission() : Linking.openSettings())} style={{ marginTop: 16, alignSelf: 'stretch' }} />
          <PButton title="Type it instead" icon="create-outline" variant="secondary" onPress={onTypeInstead} style={{ marginTop: 10, alignSelf: 'stretch' }} />
        </View>
      ) : !device ? (
        <View style={[StyleSheet.absoluteFill, s.center]}><Text style={{ color: c.textSecondary }}>No camera found on this phone.</Text></View>
      ) : photo ? (
        // The photo with a box on every line. Tapping a box adds that line to the address (tap again to remove it).
        <View style={StyleSheet.absoluteFill} onLayout={onLayout}>
          <Image source={{ uri: photo.uri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
          {fit ? photo.lines.map((line) => {
            const on = chosen.has(line.id);
            return (
              <Pressable key={line.id} onPress={() => toggle(line.id)} hitSlop={4} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={line.text}
                style={[s.line, on && s.lineOn, {
                  left: fit.left + line.box.left * fit.scale - 3, top: fit.top + line.box.top * fit.scale - 3,
                  width: line.box.width * fit.scale + 6, height: line.box.height * fit.scale + 6,
                }]} />
            );
          }) : null}
        </View>
      ) : (
        <Camera style={StyleSheet.absoluteFill} device={device} isActive outputs={outputs} torchMode={torchMode}
          onStarted={onStarted} onStopped={onStopped} onError={onCameraError} resizeMode="cover" enableNativeTapToFocusGesture />
      )}

      <View style={[s.top, { paddingTop: Platform.OS === 'ios' ? 54 : 18 }]}>
        <Text style={s.title}>Scan address</Text>
        {hasPermission && device?.hasTorch && !photo ? (
          <Pressable onPress={() => setTorch((t) => !t)} disabled={!started} hitSlop={8} style={[s.round, !started && { opacity: 0.5 }]} accessibilityLabel={torch ? 'Torch off' : 'Torch on'}>
            <Ionicons name={torch ? 'flash' : 'flash-outline'} size={18} color={torch ? '#FFE27A' : '#fff'} />
          </Pressable>
        ) : null}
        <Pressable onPress={onClose} hitSlop={10} style={s.round} accessibilityLabel="Close"><Ionicons name="close" size={20} color="#fff" /></Pressable>
      </View>
      {modeSwitch}

      <View style={s.bottom}>
        {error ? (
          <View style={s.note}>
            <MaterialCommunityIcons name="information-outline" size={18} color={c.warning} />
            <Text style={s.noteText}>{error}</Text>
          </View>
        ) : null}
        {photo ? (
          <>
            <View style={s.note}>
              <MaterialCommunityIcons name={picked ? 'map-marker-outline' : 'gesture-tap'} size={18} color="#fff" />
              <Text style={s.noteText} numberOfLines={3}>
                {picked ? (picked.kind === 'eircode' ? `Eircode ${picked.eircode}` : picked.text) : 'Tap the lines of the address you want to add.'}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <PButton title="Retake" icon="camera-reverse-outline" variant="secondary" onPress={retake} style={{ flex: 1 }} />
              <PButton title={picked?.kind === 'eircode' ? 'Use Eircode' : 'Use address'} icon="checkmark" disabled={!picked}
                onPress={() => picked && onPicked(picked)} style={{ flex: 1 }} />
            </View>
          </>
        ) : hasPermission && device ? (
          <>
            <Text style={s.hint}>Fit the address in view, hold steady, then take the photo.</Text>
            <Pressable onPress={() => void take()} disabled={!started || reading} style={({ pressed }) => [s.shutter, (pressed || reading) && { opacity: 0.7 }]}
              accessibilityRole="button" accessibilityLabel="Take photo">
              {reading ? <ActivityIndicator color="#000" /> : <View style={s.shutterInner} />}
            </Pressable>
            <Pressable onPress={onTypeInstead} hitSlop={6}><Text style={s.link}>Type it instead</Text></Pressable>
          </>
        ) : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  top: { position: 'absolute', left: 0, right: 0, top: 0, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 12, backgroundColor: 'rgba(5,11,24,0.55)' },
  title: { flex: 1, color: '#fff', fontSize: 18, fontWeight: '800' },
  round: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(5,11,24,0.7)', alignItems: 'center', justifyContent: 'center' },
  line: { position: 'absolute', borderWidth: 2, borderColor: 'rgba(255,255,255,0.85)', borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.08)' },
  lineOn: { borderColor: c.success, backgroundColor: 'rgba(25,216,139,0.28)' },
  bottom: { position: 'absolute', left: 16, right: 16, bottom: 36, gap: 12, alignItems: 'stretch' },
  note: { flexDirection: 'row', gap: 10, padding: 14, borderRadius: r.medium, backgroundColor: 'rgba(13,22,41,0.92)', borderWidth: 1, borderColor: c.border },
  noteText: { flex: 1, color: '#fff', fontSize: 14, fontWeight: '700', lineHeight: 19 },
  hint: { color: '#fff', fontSize: 15, fontWeight: '800', textAlign: 'center', textShadowColor: '#000', textShadowRadius: 6 },
  shutter: { alignSelf: 'center', width: 74, height: 74, borderRadius: 37, borderWidth: 4, borderColor: '#fff', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.25)' },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#fff' },
  link: { color: '#fff', fontWeight: '800', fontSize: 14, textAlign: 'center' },
});
