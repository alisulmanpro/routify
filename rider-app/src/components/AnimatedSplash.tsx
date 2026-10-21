import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import Constants from 'expo-constants';
import { StatusBar } from 'expo-status-bar';
import { light as c } from '../lib/theme';

/**
 * Takes over from the native splash (same mark, size and white background, so the hand-off is invisible), then
 * brings in the name and tagline (design_pref "Splash · B Dots") while the app restores the session. Three dots pulse
 * while it waits. It fades out once `ready` is true and the intro has played.
 */

const MARK = 96; // matches imageWidth of the expo-splash-screen plugin in app.json
const MIN_SHOW_MS = 1700;
const SLOW_HINT_MS = 5000; // the free API server can take ~50 s to wake up
const VERSION = Constants.expoConfig?.version;

export default function AnimatedSplash({ ready, onFinish }: { ready: boolean; onFinish: () => void }) {
  const intro = useState(() => new Animated.Value(0))[0]; // mark rises
  const word = useState(() => new Animated.Value(0))[0]; // wordmark
  const tag = useState(() => new Animated.Value(0))[0]; // tagline + dots
  const pulse = useState(() => new Animated.Value(0))[0];
  const outro = useState(() => new Animated.Value(0))[0];
  const hint = useState(() => new Animated.Value(0))[0];
  const [minTimePassed, setMinTimePassed] = useState(false);
  const [slow, setSlow] = useState(false);
  const leaving = useRef(false);

  useEffect(() => {
    const ease = Easing.out(Easing.cubic);
    Animated.sequence([
      Animated.delay(120),
      Animated.parallel([
        Animated.timing(intro, { toValue: 1, duration: 650, easing: ease, useNativeDriver: true }),
        Animated.sequence([Animated.delay(280), Animated.timing(word, { toValue: 1, duration: 480, easing: ease, useNativeDriver: true })]),
        Animated.sequence([Animated.delay(480), Animated.timing(tag, { toValue: 1, duration: 440, easing: ease, useNativeDriver: true })]),
      ]),
    ]).start();
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1200, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    const min = setTimeout(() => setMinTimePassed(true), MIN_SHOW_MS);
    const slowTimer = setTimeout(() => setSlow(true), SLOW_HINT_MS);
    return () => { loop.stop(); clearTimeout(min); clearTimeout(slowTimer); };
  }, [intro, word, tag, pulse]);

  useEffect(() => {
    if (slow) Animated.timing(hint, { toValue: 1, duration: 400, useNativeDriver: true }).start();
  }, [slow, hint]);

  useEffect(() => {
    if (!ready || !minTimePassed || leaving.current) return;
    leaving.current = true;
    Animated.timing(outro, { toValue: 1, duration: 380, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => onFinish());
  }, [ready, minTimePassed, outro, onFinish]);

  const fadeUp = (v: Animated.Value) => ({
    opacity: v,
    transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
  });
  // Each dot brightens in turn: light, mid, full blue, like the design's three dots.
  const dot = (i: number) => ({
    opacity: pulse.interpolate({ inputRange: [0, (i + 0.5) / 3, (i + 1) / 3, 1], outputRange: [0.35, 1, 0.35, 0.35], extrapolate: 'clamp' }),
  });

  return (
    <Animated.View
      pointerEvents={ready ? 'none' : 'auto'}
      style={[StyleSheet.absoluteFill, s.root, { opacity: outro.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]}
      // The native splash stays up until this first frame is on screen, so there is no flash in between.
      onLayout={() => { void SplashScreen.hideAsync(); }}
    >
      <StatusBar style="dark" />
      <Animated.View style={[s.center, { transform: [{ translateY: intro.interpolate({ inputRange: [0, 1], outputRange: [0, -40] }) }] }]}>
        <Animated.Image source={require('../../assets/splash-mark.png')} style={{ width: MARK, height: MARK }} resizeMode="contain" />
        <Animated.Text style={[s.word, fadeUp(word)]}>Routify</Animated.Text>
        <Animated.Text style={[s.tagline, fadeUp(tag)]}>PLAN  ·  DELIVER  ·  TRACK</Animated.Text>
        <Animated.View style={[s.dots, { opacity: tag }]}>
          {[0, 1, 2].map((i) => <Animated.View key={i} style={[s.dot, dot(i)]} />)}
        </Animated.View>
        <Animated.Text style={[s.hint, { opacity: hint }]}>Waking up the server…</Animated.Text>
      </Animated.View>
      {VERSION ? (
        <View style={s.version} pointerEvents="none">
          <Animated.Text style={[s.versionText, { opacity: tag }]}>v{VERSION}</Animated.Text>
        </View>
      ) : null}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  root: { backgroundColor: c.background, alignItems: 'center', justifyContent: 'center', zIndex: 100, elevation: 100 },
  center: { alignItems: 'center' },
  word: { color: c.text, fontSize: 34, fontWeight: '800', letterSpacing: -0.5, marginTop: 20 },
  tagline: { color: c.textSecondary, fontSize: 12, fontWeight: '700', letterSpacing: 3, marginTop: 10 },
  dots: { flexDirection: 'row', gap: 8, marginTop: 44 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.link },
  hint: { color: c.textSecondary, fontSize: 13, marginTop: 18 },
  version: { position: 'absolute', bottom: 40, left: 0, right: 0, alignItems: 'center' },
  versionText: { color: c.textSecondary, fontSize: 14 },
});
