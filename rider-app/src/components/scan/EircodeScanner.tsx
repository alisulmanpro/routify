import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Platform, Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission, useFrameOutput, type Frame } from 'react-native-vision-camera';
import { useTextRecognition, type TextRecognitionOptions } from 'react-native-vision-camera-ocr-plus';
import { createSynchronizable, scheduleOnRN } from 'react-native-worklets';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { eircodesInText } from '../../lib/scan/eircode';
import { createEircodeVote } from '../../lib/scan/eircodeVote';
import { premium as c, premiumRadius as r } from '../../lib/theme';
import { PButton } from '../Premium';

// The guide box, in % of the screen: one wide line, where the Eircode goes.
const BOX = { top: 38, height: 13, side: 6 };
// OCR runs only on a band around the box. The preview fills the screen like `cover`, so on a phone (taller than the
// camera frame) the box's vertical position maps 1:1 onto the frame; the band spans the frame's full width.
const OCR: TextRecognitionOptions = {
  language: 'latin',
  // At 30 fps this starts a read about 5 times a second (fewer when ML Kit is still busy with the last one).
  frameSkipThreshold: 6,
  scanRegion: { left: '0%', top: `${BOX.top - 4}%`, width: '100%', height: `${BOX.height + 8}%` },
};
// The recogniser hands back its last finished result on every frame. A new read on a hand-held phone always moves the
// text boxes a little, so a repeat of the same result is the old one: it is only counted again after this long.
const REPEAT_MS = 400;
// With no Eircode in this long, the rider is offered help (closer, torch, or typing it).
const HELP_AFTER_MS = 6000;
// The green "locked" box shows this long before the camera closes.
const LOCKED_MS = 350;

type Props = {
  visible: boolean;
  /** A steady Eircode, "R93 Y201". */
  onEircode: (eircode: string) => void;
  onTypeInstead: () => void;
  onClose: () => void;
};

/**
 * Live Eircode scanner: no buttons to press. The camera reads the text in the box several times a second on the
 * phone, and as soon as the same Eircode is seen in 3 of the last 5 reads it is handed back. It reads nothing else.
 */
export default function EircodeScanner({ visible, ...props }: Props) {
  return (
    <Modal visible={visible} animationType="fade" onRequestClose={props.onClose}>
      {visible ? <ScannerBody {...props} /> : null}
    </Modal>
  );
}

// Mounted fresh each time the scanner opens, so every scan starts with an empty vote.
function ScannerBody({ onEircode, onTypeInstead, onClose }: Omit<Props, 'visible'>) {
  const device = useCameraDevice('back');
  const { hasPermission, canRequestPermission, requestPermission, status } = useCameraPermission();
  const [torch, setTorch] = useState(false);
  const [locked, setLocked] = useState<string | null>(null);
  const [ambiguous, setAmbiguous] = useState<string[]>([]);
  const [help, setHelp] = useState(false);
  const vote = useMemo(() => createEircodeVote(), []);
  const done = useRef(false);

  // Asked once, the first time the scanner opens; after a "no" the rider uses the button (or settings).
  useEffect(() => {
    if (status === 'not-determined') void requestPermission();
  }, [status, requestPermission]);

  useEffect(() => {
    const timer = setTimeout(() => setHelp(true), HELP_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  // Runs on the JS thread for each new read (a few times a second): pull out Eircodes and vote.
  const onRead = useCallback((text: string) => {
    if (done.current) return;
    const result = vote.push(eircodesInText(text));
    if (result.kind === 'ambiguous') { setAmbiguous(result.eircodes); return; }
    setAmbiguous([]);
    if (result.kind !== 'locked') return;
    done.current = true;
    setLocked(result.eircode);
    Vibration.vibrate(40);
    setTimeout(() => onEircode(result.eircode), LOCKED_MS);
  }, [vote, onEircode]);

  const { scanText } = useTextRecognition(OCR);
  const last = useMemo(() => createSynchronizable({ key: '', at: 0 }), []);
  // Runs on the camera's frame thread, never the JS thread: only new reads are passed over.
  const onFrame = useCallback((frame: Frame) => {
    'worklet';
    const result = scanText(frame);
    const box = result.blocks[0]?.blockFrame;
    const key = box ? `${result.resultText}|${box.x}|${box.y}|${box.width}|${box.height}` : result.resultText;
    const now = Date.now();
    const prev = last.getDirty();
    if (key !== prev.key || now - prev.at >= REPEAT_MS) {
      last.setBlocking({ key, at: now });
      scheduleOnRN(onRead, result.resultText);
    }
    frame.dispose();
  }, [scanText, last, onRead]);
  const frameOutput = useFrameOutput({
    // ML Kit on Android needs RGB frames; a 720p frame is plenty for one line of print and keeps each read fast.
    pixelFormat: Platform.OS === 'android' ? 'rgb' : 'yuv',
    targetResolution: { width: 1280, height: 720 },
    dropFramesWhileBusy: true,
    onFrame,
  });

  // White while looking: it stands out on any camera image. Green once an Eircode is locked, amber when unsure.
  const boxColor = locked ? c.success : ambiguous.length ? c.warning : '#FFFFFF';
  const message = locked ? `Eircode ${locked}`
    : ambiguous.length ? `${ambiguous.join(' and ')} are both in view. Move closer to the one to deliver to.`
      : help ? 'Can\'t find an Eircode. Move closer, hold steady, or turn on the torch.' : null;

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {!hasPermission ? (
        <View style={[StyleSheet.absoluteFill, s.center, { padding: 24, backgroundColor: c.background }]}>
          {status === 'not-determined' ? <ActivityIndicator color="#FFFFFF" /> : (
            <>
              <Ionicons name="camera-outline" size={34} color={c.textMuted} />
              <Text style={{ color: c.text, fontWeight: '800', fontSize: 16, marginTop: 10 }}>Camera access is off</Text>
              <Text style={{ color: c.textSecondary, fontSize: 13, textAlign: 'center', marginTop: 6, lineHeight: 19 }}>
                {canRequestPermission ? 'Allow the camera to scan Eircodes.' : 'Turn on Camera for this app in your phone settings to scan Eircodes.'}
              </Text>
              <PButton title={canRequestPermission ? 'Allow camera' : 'Open settings'} icon={canRequestPermission ? 'camera' : 'settings-outline'}
                onPress={() => void (canRequestPermission ? requestPermission() : Linking.openSettings())} style={{ marginTop: 16, alignSelf: 'stretch' }} />
              <PButton title="Type it instead" icon="create-outline" variant="secondary" onPress={onTypeInstead} style={{ marginTop: 10, alignSelf: 'stretch' }} />
            </>
          )}
        </View>
      ) : !device ? (
        <View style={[StyleSheet.absoluteFill, s.center]}><Text style={{ color: c.textSecondary }}>No camera found on this phone.</Text></View>
      ) : (
        <Camera style={StyleSheet.absoluteFill} device={device} isActive={!locked} outputs={[frameOutput]} torchMode={torch ? 'on' : 'off'}
          resizeMode="cover" enableNativeTapToFocusGesture />
      )}

      {hasPermission ? (
        <>
          <Text style={s.hint}>Point at the Eircode</Text>
          <View pointerEvents="none" style={[s.box, { borderColor: boxColor }, locked && { backgroundColor: 'rgba(25,216,139,0.15)' }]}>
            {locked ? <Ionicons name="checkmark-circle" size={28} color={c.success} /> : null}
          </View>
        </>
      ) : null}

      <View style={[s.top, { paddingTop: Platform.OS === 'ios' ? 54 : 18 }]}>
        <Text style={s.title}>Scan Eircode</Text>
        {hasPermission && device?.hasTorch ? (
          <Pressable onPress={() => setTorch((t) => !t)} hitSlop={8} style={s.round} accessibilityLabel={torch ? 'Torch off' : 'Torch on'}>
            <Ionicons name={torch ? 'flash' : 'flash-outline'} size={18} color={torch ? '#FFE27A' : '#fff'} />
          </Pressable>
        ) : null}
        <Pressable onPress={onClose} hitSlop={10} style={s.round} accessibilityLabel="Close"><Ionicons name="close" size={20} color="#fff" /></Pressable>
      </View>

      {hasPermission && message ? (
        <View style={s.status}>
          <MaterialCommunityIcons name={locked ? 'check-circle' : 'information-outline'} size={18} color={locked ? c.success : c.warning} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700', lineHeight: 18 }}>{message}</Text>
            {help && !locked ? (
              <Pressable onPress={onTypeInstead} hitSlop={6} style={{ marginTop: 8 }}>
                <Text style={{ color: '#FFFFFF', fontWeight: '800', fontSize: 13 }}>Type it instead</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  top: { position: 'absolute', left: 0, right: 0, top: 0, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 12, backgroundColor: 'rgba(5,11,24,0.55)' },
  title: { flex: 1, color: '#fff', fontSize: 18, fontWeight: '800' },
  round: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(5,11,24,0.7)', alignItems: 'center', justifyContent: 'center' },
  box: { position: 'absolute', top: `${BOX.top}%`, height: `${BOX.height}%`, left: `${BOX.side}%`, right: `${BOX.side}%`, borderWidth: 3, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  hint: { position: 'absolute', top: `${BOX.top - 6}%`, left: 16, right: 16, textAlign: 'center', color: '#fff', fontSize: 15, fontWeight: '800', textShadowColor: '#000', textShadowRadius: 6 },
  status: { position: 'absolute', left: 16, right: 16, bottom: 48, flexDirection: 'row', gap: 10, padding: 14, borderRadius: r.medium, backgroundColor: 'rgba(13,22,41,0.92)', borderWidth: 1, borderColor: c.border },
});
