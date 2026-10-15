import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, StyleSheet, Text, Vibration, View, type LayoutChangeEvent } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import { deleteAsync } from 'expo-file-system/legacy';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { NATIVE_BUILD_HINT, hasTextBlocks, hasTextReader, readTextBlocks, readTextFromImage, type TextBlock } from '../lib/optionalNative';
import { SHAPE_ASPECT, fitsWindow, labelRect, pointToView, quadShape, movement, isStraight, perspectiveTextQuad, pickPictureSize, rectToQuad, scanWindow, stepStability, textQuad, type LabelShape, type Stability, type Quad, type Rect, type Size } from '../lib/labelTracking';
import { analyzeLabel, cropLabel, straightenLabel } from '../lib/stickerDetect';
import { readingOrder, textAngle } from '../lib/ocrOrder';
import { plausibleSticker } from '../lib/labelWarp';
import { cleanParcelId, codeLines, fieldsScore, labelKey, labelFields, looksLikeAddress, mergeFields, readLabel, type LabelFields, type LabelRead } from '../lib/labelText';
import { Screen } from '../components/Kit';
import { PButton } from '../components/Premium';
import ScanMask from '../components/ScanMask';
import LabelResult from '../components/LabelResult';
import { premium as c, premiumRadius as r } from '../lib/theme';
import { useNav } from '../lib/nav';

/*
 * Add via camera.
 *   1. A silent low-res photo is read about twice a second (expo-camera has no live text frames).
 *      ML Kit finds the text and the paper sticker around it. The guide box stays fixed in the
 *      middle of the screen; only its shape (wide, square or tall) changes to match the label.
 *   2. When the label is readable (sharp, bright enough, an address or postcode found), sits inside
 *      the guide box and has held still for STABLE_MS, a full-quality photo is taken. The label is
 *      cut out along its four corners and straightened (perspective correction, grayscale, contrast;
 *      see labelWarp), and OCR runs again on just the label. Both readings are parsed into fields
 *      and merged.
 *   3. The rider sees the postcode, name and address parts (LabelResult); unsure fields are marked
 *      yellow and can be fixed one by one. Nothing is saved automatically. After a save, a toast,
 *      then a prompt: Next (a fresh scanner) or Cancel (back to today's route). A label saved in
 *      this session is not opened again; "Already added" shows instead.
 */

type Phase = 'searching' | 'seen' | 'capturing' | 'review' | 'saved' | 'askNext';

// How long the "saved" toast shows before the next-scan prompt.
const TOAST_MS = 1500;
// A code seen this recently is taken as being in front of the camera now.
const CODE_NOW_MS = 700;
// How long "Already added" stays up after the saved label was last seen.
const ALREADY_MS = 2000;
// Pause between scan photos. Taking and reading a photo already takes a few hundred ms; the short
// pause leaves the phone time to keep the preview and buttons smooth.
const SCAN_INTERVAL_MS = hasTextBlocks ? 100 : 900;
// With nothing in view for this long, the scanner goes back to searching.
const LOST_MS = 1500;
// How long the label must stay still, readable and inside the guide box before it is captured.
const STABLE_MS = 1000;
// A scan photo that hasn't finished after this long is given up, so the loop can't get stuck.
const SCAN_TIMEOUT_MS = 5000;
// Photos in a row that must agree on a new label shape before the guide box changes to it.
const SHAPE_FRAMES = 2;
// A barcode seen this recently is taken as the parcel ID of the label being read.
const BARCODE_FRESH_MS = 15_000;
const BARCODE_TYPES: BarcodeType[] = ['qr', 'code128', 'code39', 'code93', 'ean13', 'ean8', 'upc_a', 'upc_e', 'itf14', 'codabar', 'datamatrix', 'pdf417', 'aztec'];
const TWO_D = /qr|matrix|pdf417|aztec/i;
const toRect = (f: { left: number; top: number; width: number; height: number }): Rect => ({ x: f.left, y: f.top, w: f.width, h: f.height });
// Labels without a readable barcode or ID still need a unique parcel ID for the backend.
const generatedParcelId = () => `CAM-${Date.now().toString(36).toUpperCase()}`;
const linesOf = (blocks: TextBlock[]) => blocks.flatMap((b) => b.lines);

const log = (...args: unknown[]) => { if (__DEV__) console.log('[scanner]', ...args); };

export default function CameraAdd({ onCreated }: { onCreated: () => void }) {
  const { navigate } = useNav();
  const [permission, requestPermission] = useCameraPermissions();

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

  if (Platform.OS === 'web' || !hasTextReader) {
    return (
      <Screen style={s.pageCenter}>
        <MaterialCommunityIcons name="text-recognition" size={36} color={c.textMuted} />
        <Text style={s.title}>Label reading is not available</Text>
        <Text style={s.hint}>{NATIVE_BUILD_HINT} You can still scan step by step.</Text>
        <PButton title="Scan step by step" icon="scan-outline" onPress={() => navigate('ScanDelivery')} chevron style={{ alignSelf: 'stretch', marginTop: 18 }} />
      </Screen>
    );
  }
  if (!permission) return <Screen style={s.pageCenter}><ActivityIndicator color={c.primary} /></Screen>;
  if (!permission.granted) {
    return (
      <Screen style={s.pageCenter}>
        <Ionicons name="camera-outline" size={36} color={c.textMuted} />
        <Text style={s.title}>Camera access needed</Text>
        <Text style={s.hint}>{permission.canAskAgain ? 'Allow the camera to read parcel labels.' : 'Camera access was turned off. Allow it in your phone settings to scan labels.'}</Text>
        {permission.canAskAgain
          ? <PButton title="Allow camera" icon="camera" onPress={() => void requestPermission()} style={{ alignSelf: 'stretch', marginTop: 18 }} />
          : <PButton title="Open settings" icon="settings-outline" onPress={() => void Linking.openSettings()} style={{ alignSelf: 'stretch', marginTop: 18 }} />}
      </Screen>
    );
  }
  return <LabelScanner onCreated={onCreated} />;
}

function LabelScanner({ onCreated }: { onCreated: () => void }) {
  const { openDeliveries } = useNav();
  const camera = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  // A ~1600 px picture size instead of the full sensor (often 12 MP): every photo is then quick to
  // take and to read, for the scan loop and the capture alike. Chosen once, when the camera is ready.
  const [pictureSize, setPictureSize] = useState<string | undefined>(undefined);
  const sizeChosen = useRef(false);
  const onCameraReady = () => {
    setReady(true);
    if (sizeChosen.current || !camera.current) return;
    sizeChosen.current = true;
    camera.current.getAvailablePictureSizesAsync()
      .then((sizes) => { const picked = pickPictureSize(sizes); log('picture sizes', JSON.stringify(sizes), '->', picked ?? 'default'); if (picked && mounted.current) setPictureSize(picked); })
      .catch(() => {});
  };
  const [phase, setPhaseState] = useState<Phase>('searching');
  const [error, setError] = useState('');
  const [torch] = useState(false);
  // The guide box's shape; it only changes after SHAPE_FRAMES photos agree on a new one.
  const [shape, setShapeState] = useState<LabelShape>('wide');
  const shapeRef = useRef<LabelShape>('wide');
  const shapeVote = useRef<{ shape: LabelShape; count: number }>({ shape: 'wide', count: 0 });
  const [review, setReview] = useState<{ fields: LabelFields; parcelId: string; key: number } | null>(null);
  // Labels saved in this scan session (kept across Next).
  const [savedCount, setSavedCount] = useState(0);
  const [alreadyAdded, setAlreadyAdded] = useState(false);
  const alreadyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tick, setTick] = useState(0);
  // The label is readable and inside the guide box: the box turns green.
  const [labelOk, setLabelOk] = useState(false);

  const mounted = useRef(true);
  const busy = useRef(false);
  // The label settled, readable and inside the box: since when, where, and frames missed since.
  const stable = useRef<Stability | null>(null);
  // When the scan photo in progress started (0 = none), to spot a stuck one.
  const busySince = useRef(0);
  // What identifies a label saved in this session: its address key (the Eircode when there is
  // one), and the barcode / QR values seen with it. Used to stop the same carton being added twice.
  const [savedKeys] = useState(() => new Set<string>());
  const savedCodes = useRef(new Set<string>());
  // Every code seen on the label (a label often has a QR code and a barcode), by value.
  const codes = useRef(new Map<string, { type: string; hits: number; at: number }>());
  // Address parts read from a QR code that didn't hold the whole address; they fill OCR's gaps.
  const qrFields = useRef<LabelFields | null>(null);
  // Async callbacks read the phase through this ref, since their closure may be stale.
  const phaseRef = useRef<Phase>('searching');
  const view = useRef<Size>({ width: 0, height: 0 });
  const barcodeSeenAt = useRef(0);
  const textSeenAt = useRef(0);
  const setPhase = useCallback((next: Phase) => { phaseRef.current = next; setPhaseState(next); }, []);
  const scanning = () => phaseRef.current === 'searching' || phaseRef.current === 'seen';

  useEffect(() => () => { mounted.current = false; if (alreadyTimer.current) clearTimeout(alreadyTimer.current); }, []);

  /** The label in view (by its fields, or its codes in view now) was saved earlier in this session. */
  const isSaved = useCallback((fields: LabelFields | null) => {
    if (fields && (fields.postalCode || fields.street) && savedKeys.has(labelKey(fields))) return true;
    // Or one of its codes is in front of the camera right now (not just seen a while ago).
    const now = Date.now();
    return [...codes.current.entries()].some(([value, c]) => now - c.at < CODE_NOW_MS && savedCodes.current.has(value));
  }, [savedKeys]);
  const showAlreadyAdded = useCallback(() => {
    setAlreadyAdded(true);
    if (alreadyTimer.current) clearTimeout(alreadyTimer.current);
    alreadyTimer.current = setTimeout(() => setAlreadyAdded(false), ALREADY_MS);
  }, []);

  const onLayout = (e: LayoutChangeEvent) => {
    view.current = { width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height };
  };

  const openReview = useCallback((read: LabelRead, fields: LabelFields = labelFields(read)) => {
    // The carton just saved is still in front of the camera: say so and keep scanning.
    if (isSaved(fields)) {
      showAlreadyAdded();
      log('duplicate: already added, not opened');
      stable.current = null;
      setPhase('seen');
      return;
    }
    // The parcel ID: a plain barcode seen twice lately, else such a QR code (that isn't an address).
    const now = Date.now();
    const seen = [...codes.current.entries()].filter(([value, c]) => c.hits >= 2 && now - c.at < BARCODE_FRESH_MS && !(TWO_D.test(c.type) && looksLikeAddress(value)));
    seen.sort((a, b) => Number(TWO_D.test(a[1].type)) - Number(TWO_D.test(b[1].type)) || b[1].at - a[1].at);
    const fromBarcode = seen[0] ? cleanParcelId(seen[0][0]) : null;
    setReview({ fields, parcelId: fromBarcode || read.parcelId || generatedParcelId(), key: Date.now() });
    setError('');
    setPhase('review');
  }, [setPhase, isSaved, showAlreadyAdded]);

  /**
   * Takes a full-quality photo, crops it to the label, turns it upright and reads it. Used by the
   * automatic capture and by the Capture button.
   */
  const capture = useCallback(async (manual: boolean) => {
    if (!camera.current || phaseRef.current === 'capturing' || phaseRef.current === 'review') return;
    setPhase('capturing');
    log('capture: start', manual ? '(manual)' : '(auto)');
    const captureStarted = Date.now();
    Vibration.vibrate(30);
    const temp: string[] = [];
    try {
      // Let a scan photo that is still being read finish first.
      for (let i = 0; i < 20 && busy.current; i += 1) await new Promise((done) => setTimeout(done, 50));
      // Step timings, logged at the end, to see where a slow capture spends its time.
      const steps: string[] = [];
      let mark = Date.now();
      const step = (name: string) => { const t = Date.now(); steps.push(`${name} ${t - mark}`); mark = t; };
      const photo = await camera.current.takePictureAsync({ quality: 0.9, shutterSound: false });
      temp.push(photo.uri);
      step(`photo(${photo.width}x${photo.height})`);
      const size = { width: photo.width, height: photo.height };
      const blocks = await readTextBlocks(photo.uri);
      step('ocr');
      let lines: string[];
      // The straightened label's reading, when there is one; merged with the whole photo's below.
      let straightLines: string[] | null = null;
      if (blocks) {
        const all = linesOf(blocks);
        const angle = textAngle(all);
        lines = readingOrder(all, angle);
        const first = readLabel(lines);
        const firstFields = labelFields(first);
        step('parse');
        // Every field read cleanly the first time: a second pass can't add anything.
        const complete = (['name', 'street', 'city', 'postalCode'] as const).every((k) => firstFields.confidence[k] === 'high');
        if (!complete) {
          // Re-read just the label, cropped and upright: fewer stray words, better line order.
          const used = [...(first.address?.split(', ') ?? []), first.name, first.parcelId, firstFields.postalCode].filter((t): t is string => !!t);
          const textInPhoto = labelRect(blocks, toRect, size, used, null);
          // The text area's outline with its perspective, from ML Kit's line corners (cheap).
          const textBox = textInPhoto ? perspectiveTextQuad(blocks, textInPhoto, angle) ?? textQuad(blocks, textInPhoto, angle) ?? rectToQuad(textInPhoto) : null;
          let cropped: string | null = null;
          if (textBox && isStraight(textBox, angle)) {
            // Already flat and level: a plain native crop, no paper search or pixel warp.
            cropped = await cropLabel(photo.uri, size, textBox, angle).catch(() => null);
            step('crop(straight)');
          } else if (textInPhoto) {
            // Turned or angled: find the paper's corners and straighten (perspective, grayscale, contrast).
            const analysis = await analyzeLabel(photo.uri, size, textInPhoto).catch(() => null);
            step('sticker');
            const sticker = analysis?.sticker && plausibleSticker(analysis.sticker, textInPhoto) ? analysis.sticker : null;
            const box = sticker ?? textBox!;
            cropped = await straightenLabel(photo.uri, size, box, angle).catch(() => null);
            step('warp');
            // The older rotate-only crop if the warp can't run.
            cropped ??= await cropLabel(photo.uri, size, box, angle).catch(() => null);
          }
          if (cropped) {
            temp.push(cropped);
            const croppedBlocks = await readTextBlocks(cropped).catch(() => null);
            const croppedLines = croppedBlocks ? readingOrder(linesOf(croppedBlocks), 0) : [];
            if (croppedLines.length) straightLines = croppedLines;
            step('ocr2');
          }
        } else {
          step('second pass skipped (complete)');
        }
      } else {
        lines = (await readTextFromImage(photo.uri)) || [];
        step('ocr(plain)');
      }
      log('capture steps (ms):', steps.join(' | '));
      if (!mounted.current) return;
      if (!lines.length) {
        setError('Could not read any text. Move closer, hold steady and try again.');
        setPhase('seen');
        return;
      }
      // Both readings become fields; the better one leads and the other fills its gaps.
      const read = readLabel(lines);
      const straightRead = straightLines ? readLabel(straightLines) : null;
      // The straightened reading goes first, so it wins a tie.
      const readings = [straightRead, read].filter((x): x is LabelRead => !!x).map((x) => ({ read: x, fields: labelFields(x) }));
      readings.sort((a, b) => fieldsScore(b.fields) - fieldsScore(a.fields));
      const best = readings[0];
      const merged = mergeFields([...readings.map((x) => x.fields), ...(qrFields.current ? [qrFields.current] : [])])!;
      // Shown in the Metro / device log while developing, to see what ML Kit actually read.
      if (__DEV__) {
        console.log('[label-ocr] blocks', JSON.stringify(blocks?.map((b) => b.lines.map((l) => l.text)) ?? null));
        console.log('[label-ocr] lines (photo)', JSON.stringify(lines));
        console.log('[label-ocr] lines (straightened)', JSON.stringify(straightLines));
        console.log('[label-ocr] fields', JSON.stringify(merged));
      }
      // Manual capture always opens the form, so the rider can type what OCR missed.
      log('capture: done in', Date.now() - captureStarted, 'ms');
      if (!best.read.address && !best.fields.postalCode && !manual) { log('capture: no address or postcode, back to scanning'); setPhase('seen'); return; }
      openReview({ ...best.read, parcelId: best.read.parcelId ?? read.parcelId }, merged);
    } catch {
      if (mounted.current) { setError('Could not take the photo. Try again.'); setPhase('seen'); }
    } finally {
      stable.current = null;
      for (const uri of temp) deleteAsync(uri, { idempotent: true }).catch(() => {});
    }
  }, [openReview, setPhase]);

  // Scan loop: low-res photos while nothing is captured yet. Each frame is only the photo, ML Kit
  // and some arithmetic on its text boxes; finding the paper edge, straightening and the second
  // OCR pass happen once, in capture().
  useEffect(() => {
    if (!ready || (phase !== 'searching' && phase !== 'seen')) return;
    const timer = setTimeout(async () => {
      if (!camera.current) return;
      if (busy.current) {
        // A photo still being read re-arms the loop when it finishes; one stuck for too long is dropped.
        if (Date.now() - busySince.current > SCAN_TIMEOUT_MS) { log('state: scan photo stuck, dropped'); busy.current = false; }
        setTick((n) => n + 1);
        return;
      }
      busy.current = true;
      busySince.current = Date.now();
      let uri: string | null = null;
      let captureNow = false;
      try {
        const t0 = Date.now();
        const photo = await camera.current.takePictureAsync({ quality: hasTextBlocks ? 0.35 : 0.5, shutterSound: false });
        uri = photo.uri;
        const t1 = Date.now();
        const blocks = await readTextBlocks(photo.uri);
        const lines = blocks ? readingOrder(linesOf(blocks)) : (await readTextFromImage(photo.uri)) || [];
        const t2 = Date.now();
        if (!mounted.current || !scanning()) return;
        const read = readLabel(lines);
        const now = Date.now();
        if (lines.length) textSeenAt.current = now;

        // A box round the label's text, turned to the text's angle: cheap, and steady from frame
        // to frame. Only used to check the label, never drawn.
        let box: Quad | null = null;
        if (blocks && view.current.width) {
          const used = [...(read.address?.split(', ') ?? []), read.name, read.parcelId, read.phone].filter((t): t is string => !!t);
          const size = { width: photo.width, height: photo.height };
          const textInPhoto = labelRect(blocks, toRect, size, used, null);
          const inPhoto = textInPhoto ? textQuad(blocks, textInPhoto, textAngle(linesOf(blocks))) ?? rectToQuad(textInPhoto) : null;
          box = inPhoto ? (inPhoto.map(pointToView(size, view.current)) as Quad) : null;
        }

        const inView = lines.length > 0 || now - barcodeSeenAt.current < LOST_MS;
        setPhase(inView || now - textSeenAt.current < LOST_MS ? 'seen' : 'searching');

        // The guide box takes the label's shape, but not while a label is settling in it.
        if (box && !stable.current) {
          const seen = quadShape(box);
          const vote = shapeVote.current;
          if (seen === shapeRef.current) shapeVote.current = { shape: seen, count: 0 };
          else if (seen === vote.shape) vote.count += 1;
          else shapeVote.current = { shape: seen, count: 1 };
          if (shapeVote.current.shape !== shapeRef.current && shapeVote.current.count >= SHAPE_FRAMES) {
            shapeRef.current = seen;
            setShapeState(seen);
          }
        }

        // Capture once the label is readable and inside the box, and has stayed put for STABLE_MS.
        // Without a detected outline (older builds) the position can't be checked, so it isn't.
        const fields = labelFields(read);
        const found = !!read.address || !!fields.postalCode;
        // A label saved earlier in this session is never captured again.
        const saved = found && isSaved(fields);
        if (saved) showAlreadyAdded();
        const inside = !box || fitsWindow(box, scanWindow(view.current, SHAPE_ASPECT[shapeRef.current]), 0.08, 0.12);
        const ok = found && !saved && inside;
        setLabelOk(ok);

        const drift = stable.current?.box && box ? movement(stable.current.box, box) : 0;
        stable.current = stepStability(stable.current, ok, box, now);
        const heldMs = stable.current && stable.current.misses === 0 ? now - stable.current.since : 0;
        captureNow = heldMs >= STABLE_MS;

        log(`frame ${Date.now() - t0}ms (photo ${t1 - t0}, ocr ${t2 - t1}, check ${Date.now() - t2})`,
          `| found ${found} inside ${inside} dup ${saved} drift ${drift.toFixed(3)}`,
          `| stable ${heldMs}/${STABLE_MS}ms misses ${stable.current?.misses ?? '-'}`,
          `| state processing${captureNow ? ' -> capture' : ''}`);
      } catch (err) {
        // A failed photo (camera busy, app in background) is simply retried on the next tick.
        log('frame failed', String(err));
      } finally {
        busy.current = false;
        busySince.current = 0;
        if (uri) deleteAsync(uri, { idempotent: true }).catch(() => {});
        if (captureNow && mounted.current && scanning()) void capture(false);
        // Force the next tick even when the phase did not change.
        else if (mounted.current && scanning()) setTick((n) => n + 1);
        else log('state: locked (' + phaseRef.current + ')');
      }
    }, SCAN_INTERVAL_MS);
    return () => clearTimeout(timer);
    // `tick` re-arms the loop after every photo.
  }, [ready, phase, tick, capture, setPhase, isSaved, showAlreadyAdded]);

  const onBarcode = ({ type, data }: { type: string; data: string }) => {
    barcodeSeenAt.current = Date.now();
    const value = (data ?? '').trim();
    if (!value || !scanning()) return;
    const code = codes.current.get(value) ?? { type, hits: 0, at: 0 };
    code.hits += 1;
    code.at = Date.now();
    codes.current.set(value, code);
    if (code.hits !== 2) return;
    // Some QR labels carry the address ("TEST-002|Eoin Doherty|155 Hillcrest Close|…").
    if (TWO_D.test(type) && looksLikeAddress(value) && !value.startsWith('{')) {
      const read = readLabel(codeLines(value));
      const parsed = labelFields(read);
      // Read from the code itself, so no OCR misreads: every part found is trusted.
      const confidence = Object.fromEntries(Object.keys(parsed.confidence).map((k) => [k, parsed[k as keyof typeof parsed.confidence] ? 'high' : 'missing'])) as LabelFields['confidence'];
      const fields = { ...parsed, confidence };
      if (__DEV__) console.log('[label-ocr] QR', JSON.stringify(value), JSON.stringify(fields));
      // The whole address: no need to wait for OCR. Only part of it: kept to fill OCR's gaps.
      if (fields.postalCode && fields.street && (fields.name || fields.city)) { openReview({ ...read, parcelId: null }, fields); return; }
      qrFields.current = fields;
    }
    if (phaseRef.current === 'searching') setPhase('seen');
  };

  /** Back to a fresh scanner: everything read from the last label is dropped (saved labels are kept). */
  const reset = () => {
    setReview(null);
    setError('');
    stable.current = null;
    busy.current = false;
    setLabelOk(false);
    codes.current.clear();
    qrFields.current = null;
    setPhase('searching');
  };

  const onSaved = (parcelId: string, key: string) => {
    savedKeys.add(key);
    savedCodes.current.add(parcelId);
    // The codes seen while this label was read belong to it.
    const now = Date.now();
    for (const [value, c] of codes.current) if (now - c.at < BARCODE_FRESH_MS) savedCodes.current.add(value);
    setSavedCount((n) => n + 1);
    setReview(null);
    setPhase('saved');
    onCreated();
  };

  // The saved toast shows briefly, then the rider chooses to scan another label or go back.
  useEffect(() => {
    if (phase !== 'saved') return;
    const timer = setTimeout(() => setPhase('askNext'), TOAST_MS);
    return () => clearTimeout(timer);
  }, [phase, setPhase]);

  const frameColor = (phase === 'seen' && labelOk) || phase === 'capturing' || phase === 'review' || phase === 'saved' || phase === 'askNext' ? c.success : '#FFFFFF';
  const showControls = phase === 'searching' || phase === 'seen';
  const readingTag = phase === 'capturing' ? (
    <View style={[s.tag, { backgroundColor: c.success }]}>
      <ActivityIndicator size="small" color="#05301E" />
      <Text style={[s.tagText, { color: '#05301E' }]}>Reading label…</Text>
    </View>
  ) : null;

  return (
    <Screen style={{ backgroundColor: '#000' }}>
      <View style={StyleSheet.absoluteFill} onLayout={onLayout} pointerEvents="none" />
      <CameraView
        ref={camera}
        style={StyleSheet.absoluteFill}
        facing="back"
        animateShutter={false}
        enableTorch={torch}
        onCameraReady={onCameraReady}
        pictureSize={pictureSize}
        barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
        onBarcodeScanned={onBarcode}
      />

      {/* A fixed guide box shaped like the label: white while looking, green when the label is
          readable and inside it. */}
      <ScanMask color={frameColor} aspect={SHAPE_ASPECT[shape]}>{readingTag}</ScanMask>

      {showControls && error ? (
        <View pointerEvents="none" style={s.hintWrap}>
          <View style={[s.hintPill, { backgroundColor: 'rgba(255,83,104,0.9)' }]}>
            <Text style={s.hintText}>{error}</Text>
          </View>
        </View>
      ) : null}

      {savedCount > 0 && showControls ? (
        <View pointerEvents="none" style={s.counter}>
          <Ionicons name="checkmark-circle" size={14} color={c.success} />
          <Text style={{ color: '#fff', fontWeight: '800', fontSize: 12 }}>{savedCount} added</Text>
        </View>
      ) : null}

      {alreadyAdded && showControls ? (
        <View pointerEvents="none" style={s.toastWrap}>
          <View style={[s.toast, { backgroundColor: c.warning }]}>
            <Ionicons name="checkmark-done" size={18} color="#3A2600" />
            <Text style={[s.toastText, { color: '#3A2600' }]}>Already added! Scan next parcel</Text>
          </View>
        </View>
      ) : null}

      {phase === 'review' && review ? (
        <LabelResult
          key={review.key}
          fields={review.fields}
          parcelId={review.parcelId}
          savedKeys={savedKeys}
          onCancel={reset}
          onSaved={onSaved}
        />
      ) : null}

      {phase === 'saved' ? (
        <View pointerEvents="none" style={s.toastWrap}>
          <View style={s.toast}>
            <Ionicons name="checkmark-circle" size={18} color="#05301E" />
            <Text style={s.toastText}>Delivery saved</Text>
          </View>
        </View>
      ) : null}

      {phase === 'askNext' ? (
        <View style={s.sheet}>
          <Text style={s.askText}>Do you want to scan another label?</Text>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
            {/* Leaves the scanner for today's route (the Deliveries tab), like the Back bar. */}
            <PButton title="Cancel" variant="secondary" onPress={() => { reset(); openDeliveries(); }} style={{ flex: 1 }} />
            <PButton title="Next" icon="scan" onPress={reset} style={{ flex: 1.4 }} />
          </View>
        </View>
      ) : null}
    </Screen>
  );
}

const s = StyleSheet.create({
  pageCenter: { backgroundColor: c.background, padding: 24, alignItems: 'center', justifyContent: 'center' },
  title: { color: c.text, fontSize: 16, fontWeight: '800', marginTop: 12, textAlign: 'center' },
  hint: { color: c.textSecondary, fontSize: 13, marginTop: 6, textAlign: 'center', lineHeight: 19 },

  tag: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: r.pill },
  tagText: { fontWeight: '800', fontSize: 13 },
  hintWrap: { position: 'absolute', top: 14, left: 16, right: 16, alignItems: 'center' },
  hintPill: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: r.pill, backgroundColor: 'rgba(0,0,0,0.6)' },
  hintText: { color: '#fff', fontWeight: '700', fontSize: 13, textAlign: 'center' },
  counter: { position: 'absolute', top: 58, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: r.pill, backgroundColor: 'rgba(0,0,0,0.55)' },


  sheet: { position: 'absolute', left: 12, right: 12, bottom: 12, padding: 16, borderRadius: r.large, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  askText: { color: c.text, fontWeight: '800', fontSize: 16, textAlign: 'center' },
  toastWrap: { position: 'absolute', left: 16, right: 16, bottom: 28, alignItems: 'center' },
  toast: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderRadius: r.pill, backgroundColor: c.success },
  toastText: { color: '#05301E', fontWeight: '800', fontSize: 14 },
});
