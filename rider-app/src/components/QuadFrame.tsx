import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import type { Quad } from '../lib/labelTracking';

const LINE = 3;
const DOT = 10;
// Share of the remaining distance covered each frame, so the box glides to where the label moved.
const EASE = 0.35;

/** The camera guide box: four edges joining the label's corners, sliding smoothly as it moves. */
export default function QuadFrame({ quad, color, visible, children }: { quad: Quad | null; color: string; visible: boolean; children?: ReactNode }) {
  const [shown, setShown] = useState<Quad | null>(quad);
  const target = useRef(quad);
  const current = useRef(quad);
  const frame = useRef<number | null>(null);
  const [opacity] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.timing(opacity, { toValue: visible && quad ? 1 : 0, duration: 160, useNativeDriver: true }).start();
  }, [visible, quad, opacity]);

  useEffect(() => {
    target.current = quad;
    // Hidden: the next placement jumps straight to the new label instead of sliding from the old one.
    if (!quad) { current.current = null; return; }
    // First placement (or after hiding) jumps; later moves glide.
    if (!current.current) { current.current = quad; requestAnimationFrame(() => setShown(quad)); return; }
    if (frame.current != null) return;
    const step = () => {
      const to = target.current;
      const from = current.current;
      if (!to || !from) { frame.current = null; return; }
      let moving = false;
      const next = from.map((p, i) => {
        const dx = to[i].x - p.x, dy = to[i].y - p.y;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) moving = true;
        return { x: p.x + dx * EASE, y: p.y + dy * EASE };
      }) as Quad;
      current.current = moving ? next : to;
      setShown(current.current);
      frame.current = moving ? requestAnimationFrame(step) : null;
    };
    frame.current = requestAnimationFrame(step);
  }, [quad]);

  useEffect(() => () => { if (frame.current != null) cancelAnimationFrame(frame.current); }, []);

  if (!shown) return null;
  const bottom = Math.max(...shown.map((p) => p.y));
  const middle = shown.reduce((a, p) => a + p.x, 0) / 4;

  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity }]}>
      {shown.map((a, i) => {
        const b = shown[(i + 1) % 4];
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        return (
          <View
            key={`e${i}`}
            style={{ position: 'absolute', left: (a.x + b.x) / 2 - length / 2, top: (a.y + b.y) / 2 - LINE / 2, width: length, height: LINE, borderRadius: LINE, backgroundColor: color, transform: [{ rotate: `${angle}rad` }] }}
          />
        );
      })}
      {shown.map((p, i) => (
        <View key={`c${i}`} style={{ position: 'absolute', left: p.x - DOT / 2, top: p.y - DOT / 2, width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: color }} />
      ))}
      {children ? <View style={{ position: 'absolute', left: middle - 120, width: 240, top: bottom + 10, alignItems: 'center' }}>{children}</View> : null}
    </Animated.View>
  );
}
