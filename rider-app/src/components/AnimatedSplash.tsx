import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { gradient } from './Premium';
import { premium as c } from '../lib/theme';

/**
 * Takes over from the native splash (same mark, size and background, so the hand-off is invisible), then animates the
 * brand in while the app restores the session. It fades out once `ready` is true and the intro has played.
 */

const MARK = 200; // matches imageWidth of the expo-splash-screen plugin in app.json
const MIN_SHOW_MS = 1700;
const SLOW_HINT_MS = 5000; // the free API server can take ~50 s to wake up
const TRACK = 132;

export default function AnimatedSplash({ ready, onFinish }: { ready: boolean; onFinish: () => void }) {
  const intro = useState(() => new Animated.Value(0))[0]; // mark rises, glow appears
  const word = useState(() => new Animated.Value(0))[0]; // wordmark
  const tag = useState(() => new Animated.Value(0))[0]; // tagline + loading bar
  const shimmer = useState(() => new Animated.Value(0))[0];
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
        Animated.timing(intro, { toValue: 1, duration: 750, easing: ease, useNativeDriver: true }),
        Animated.sequence([Animated.delay(330), Animated.timing(word, { toValue: 1, duration: 520, easing: ease, useNativeDriver: true })]),
        Animated.sequence([Animated.delay(560), Animated.timing(tag, { toValue: 1, duration: 480, easing: ease, useNativeDriver: true })]),
      ]),
    ]).start();
    const loop = Animated.loop(Animated.timing(shimmer, { toValue: 1, duration: 1150, easing: Easing.inOut(Easing.quad), useNativeDriver: true }));
    loop.start();
    const min = setTimeout(() => setMinTimePassed(true), MIN_SHOW_MS);
    const slowTimer = setTimeout(() => setSlow(true), SLOW_HINT_MS);
    return () => { loop.stop(); clearTimeout(min); clearTimeout(slowTimer); };
  }, [intro, word, tag, shimmer]);

  useEffect(() => {
    if (slow) Animated.timing(hint, { toValue: 1, duration: 400, useNativeDriver: true }).start();
  }, [slow, hint]);

  useEffect(() => {
    if (!ready || !minTimePassed || leaving.current) return;
    leaving.current = true;
    Animated.timing(outro, { toValue: 1, duration: 420, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => onFinish());
  }, [ready, minTimePassed, outro, onFinish]);

  const rise = (to: number) => ({ transform: [{ translateY: intro.interpolate({ inputRange: [0, 1], outputRange: [0, to] }) }] });
  const fadeUp = (v: Animated.Value) => ({
    opacity: v,
    transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
  });

  return (
    <Animated.View
      pointerEvents={ready ? 'none' : 'auto'}
      style={[StyleSheet.absoluteFill, s.root, {
        opacity: outro.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
        transform: [{ scale: outro.interpolate({ inputRange: [0, 1], outputRange: [1, 1.04] }) }],
      }]}
      // The native splash stays up until this first frame is on screen, so there is no flash in between.
      onLayout={() => { void SplashScreen.hideAsync(); }}
    >
      <Animated.View style={[s.glow, { opacity: intro, transform: [{ scale: intro.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }] }]} />

      <Animated.View style={[s.center, rise(-58)]}>
        <Animated.Image
          source={require('../../assets/splash-icon.png')}
          style={{ width: MARK, height: MARK, transform: [{ scale: intro.interpolate({ inputRange: [0, 1], outputRange: [1, 0.82] }) }] }}
          resizeMode="contain"
        />
        <Animated.View style={[s.wordRow, fadeUp(word)]}>
          <Text style={s.word}>Rout</Text>
          <Text style={[s.word, { color: c.purpleSoft }]}>ify</Text>
        </Animated.View>
        <Animated.Text style={[s.tagline, fadeUp(tag)]}>PLAN  ·  DELIVER  ·  TRACK</Animated.Text>
        <Animated.View style={[s.track, { opacity: tag }]}>
          <Animated.View style={[s.bar, gradient('linear-gradient(90deg, rgba(255,170,50,0) 0%, #FFAA32 50%, rgba(255,170,50,0) 100%)'), {
            transform: [{ translateX: shimmer.interpolate({ inputRange: [0, 1], outputRange: [-TRACK * 0.6, TRACK] }) }],
          }]} />
        </Animated.View>
        <Animated.Text style={[s.hint, { opacity: hint }]}>Waking up the server…</Animated.Text>
      </Animated.View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  root: { backgroundColor: c.background, alignItems: 'center', justifyContent: 'center', zIndex: 100, elevation: 100 },
  center: { alignItems: 'center' },
  glow: {
    position: 'absolute', width: 360, height: 360, borderRadius: 180, marginTop: -116,
    ...gradient('radial-gradient(circle, rgba(124,92,255,0.30) 0%, rgba(108,92,231,0.10) 42%, rgba(5,11,24,0) 70%)'),
  },
  wordRow: { flexDirection: 'row', marginTop: -14 },
  word: { color: c.text, fontSize: 34, fontWeight: '800', letterSpacing: 0.5 },
  tagline: { color: c.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 2.4, marginTop: 8 },
  track: { width: TRACK, height: 3, borderRadius: 3, marginTop: 26, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.07)' },
  bar: { width: TRACK * 0.6, height: 3, borderRadius: 3, backgroundColor: c.primary },
  hint: { color: c.textMuted, fontSize: 12, marginTop: 14 },
});
