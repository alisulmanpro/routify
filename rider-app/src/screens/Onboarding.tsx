import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { Screen } from '../components/Kit';
import { LightButton } from '../components/LightKit';
import { PERMISSION_STEPS, checkPermission, finishOnboarding, notificationsSupported, requestPermission, type PermissionState, type PermissionStep } from '../lib/permissions';
import { light as c } from '../lib/theme';

const PAGES: Record<PermissionStep, { title: string; text: string; name: string; art: ReactNode }> = {
  location: { title: 'Allow location access', text: 'We use your location to plan routes and guide you to each stop', name: 'Location', art: <LocationArt /> },
  camera: { title: 'Allow camera access', text: 'Scan Eircodes from parcel labels', name: 'Camera', art: <CameraArt /> },
  notifications: { title: 'Turn on notifications', text: 'Get alerts about your routes', name: 'Notifications', art: <BellArt /> },
};

/**
 * Shown once after the first sign-in: one page per permission, each asked on its own. Pages for permissions that are
 * already granted are skipped. "Not now" moves on without asking; the feature asks again when it is used.
 * If the rider says no, the page stays and says so. Once Android stops showing its dialog ("Don't ask again"), Allow
 * opens the app's settings, and coming back re-checks: a permission turned on there moves on by itself.
 */
export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [steps, setSteps] = useState<PermissionStep[] | null>(null);
  const [index, setIndex] = useState(0);
  const [asking, setAsking] = useState(false);
  // The current page's permission after Allow was tapped and not granted (null before that).
  const [denied, setDenied] = useState<PermissionState | null>(null);
  const inSettings = useRef(false);

  useEffect(() => {
    const wanted = PERMISSION_STEPS.filter((step) => step !== 'notifications' || notificationsSupported);
    void Promise.all(wanted.map(checkPermission)).then((states) => {
      const open = wanted.filter((_, i) => !states[i].granted);
      if (open.length) setSteps(open);
      else void finishOnboarding().then(onDone);
    });
  }, [onDone]);

  const next = useCallback(() => {
    if (!steps) return;
    setDenied(null);
    if (index < steps.length - 1) setIndex(index + 1);
    else void finishOnboarding().then(onDone);
  }, [steps, index, onDone]);

  // Back from the system settings: move on if the rider turned the permission on there.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !inSettings.current || !steps) return;
      inSettings.current = false;
      void checkPermission(steps[index]).then((now) => { if (now.granted) next(); else setDenied(now); });
    });
    return () => sub.remove();
  }, [steps, index, next]);

  const allow = async () => {
    if (!steps || asking) return;
    // Android no longer shows its dialog for this permission: only the app's settings can turn it on.
    if (denied && !denied.canAskAgain) {
      inSettings.current = true;
      void Linking.openSettings();
      return;
    }
    setAsking(true);
    const state = await requestPermission(steps[index]);
    setAsking(false);
    if (state.granted) next();
    else setDenied(state);
  };

  if (!steps) {
    return (
      <Screen style={{ backgroundColor: c.background, alignItems: 'center', justifyContent: 'center' }}>
        <StatusBar style="dark" />
        <ActivityIndicator color={c.ink} />
      </Screen>
    );
  }

  const page = PAGES[steps[index]];
  return (
    <Screen style={{ backgroundColor: c.background }}>
      <StatusBar style="dark" />
      <View style={s.page}>
        {steps.length > 1 ? (
          <View style={s.dots} accessibilityLabel={`Step ${index + 1} of ${steps.length}`}>
            {steps.map((step, i) => <View key={step} style={[s.dot, i === index && s.dotOn]} />)}
          </View>
        ) : <View style={{ height: 8 }} />}

        <View style={s.body}>
          <View style={s.circle}>{page.art}</View>
          <Text style={s.title}>{page.title}</Text>
          <Text style={s.text}>{page.text}</Text>
          {denied ? (
            <Text style={s.denied}>
              {denied.canAskAgain
                ? `${page.name} wasn't allowed. Tap Allow to try again, or Not now to skip.`
                : `${page.name} is turned off for Routify. Tap Open settings, then Permissions → ${page.name} → Allow.`}
            </Text>
          ) : null}
        </View>

        <LightButton title={denied && !denied.canAskAgain ? 'Open settings' : 'Allow'} onPress={() => void allow()} loading={asking} />
        <Pressable onPress={next} hitSlop={8} style={s.later} disabled={asking}>
          <Text style={s.laterText}>Not now</Text>
        </Pressable>
      </View>
    </Screen>
  );
}

function LocationArt() {
  return (
    <View style={{ alignItems: 'center' }}>
      <Ionicons name="location-outline" size={96} color={c.ink} />
      <View style={s.ground}><View style={s.groundInner} /></View>
    </View>
  );
}

function CameraArt() {
  return (
    <View style={s.frame}>
      {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => <View key={corner} style={[s.corner, CORNERS[corner]]} />)}
      <Ionicons name="camera-outline" size={84} color={c.ink} />
    </View>
  );
}

function BellArt() {
  return (
    <View>
      <Ionicons name="notifications-outline" size={96} color={c.ink} />
      <View style={s.bellDot} />
    </View>
  );
}

const CORNER = 24;
const CORNERS = {
  tl: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 8 },
  tr: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 8 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 8 },
  br: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 8 },
};

const s = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 24, paddingTop: 56, paddingBottom: 24 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.track },
  dotOn: { width: 24, backgroundColor: c.link },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  circle: { width: 220, height: 220, borderRadius: 110, backgroundColor: c.linkBg, alignItems: 'center', justifyContent: 'center', marginBottom: 44 },
  title: { color: c.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.5, textAlign: 'center' },
  text: { color: c.textSecondary, fontSize: 16, lineHeight: 24, textAlign: 'center', marginTop: 12, maxWidth: 300 },
  denied: { color: c.warning, backgroundColor: c.warningBg, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 20, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, overflow: 'hidden' },
  later: { alignItems: 'center', paddingVertical: 18 },
  laterText: { color: c.textLabel, fontSize: 16, fontWeight: '600' },

  ground: { width: 70, height: 14, borderRadius: 35, borderWidth: 2, borderColor: c.ink, marginTop: -10, alignItems: 'center', justifyContent: 'center' },
  groundInner: { width: 32, height: 6, borderRadius: 16, borderWidth: 2, borderColor: c.link },
  frame: { width: 108, height: 108, alignItems: 'center', justifyContent: 'center' },
  corner: { position: 'absolute', width: CORNER, height: CORNER, borderColor: c.link },
  bellDot: { position: 'absolute', top: 8, right: 10, width: 22, height: 22, borderRadius: 11, borderWidth: 3, borderColor: c.link, backgroundColor: c.linkBg },
});
