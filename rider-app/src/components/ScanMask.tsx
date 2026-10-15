import { useEffect, useState, type ReactNode } from 'react';
import { Animated, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { scanWindow } from '../lib/labelTracking';

const MASK = 'rgba(0,0,0,0.55)';
const LINE = 4;
const CORNER = 30;

/**
 * Full-screen scanning mask: the camera is dimmed except for a fixed, centred window (`aspect` is
 * its height / width), marked by four L-shaped corners only. `children` sit just below the window.
 * Fades out while `visible` is false.
 */
export default function ScanMask({ color, aspect, visible = true, children }: { color: string; aspect: number; visible?: boolean; children?: ReactNode }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [opacity] = useState(() => new Animated.Value(visible ? 1 : 0));

  useEffect(() => {
    Animated.timing(opacity, { toValue: visible ? 1 : 0, duration: 160, useNativeDriver: true }).start();
  }, [visible, opacity]);
  const onLayout = (e: LayoutChangeEvent) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });

  const { x, y, w, h } = scanWindow(size, aspect);
  const bar = { position: 'absolute' as const, backgroundColor: color, borderRadius: LINE / 2 };

  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity }]} onLayout={onLayout}>
      {size.width > 0 ? (
        <>
          <View style={[s.mask, { top: 0, left: 0, right: 0, height: y }]} />
          <View style={[s.mask, { top: y + h, left: 0, right: 0, bottom: 0 }]} />
          <View style={[s.mask, { top: y, left: 0, width: x, height: h }]} />
          <View style={[s.mask, { top: y, left: x + w, right: 0, height: h }]} />

          {([[0, 0], [1, 0], [0, 1], [1, 1]] as const).map(([right, bottom]) => {
            // Each corner sits just outside the window so the clear area stays unobstructed.
            const left = right ? x + w + LINE - CORNER : x - LINE;
            const top = bottom ? y + h + LINE - CORNER : y - LINE;
            return (
              <View key={`${right}${bottom}`} style={{ position: 'absolute', left, top, width: CORNER, height: CORNER }}>
                <View style={[bar, { left: 0, right: 0, height: LINE, [bottom ? 'bottom' : 'top']: 0 }]} />
                <View style={[bar, { top: 0, bottom: 0, width: LINE, [right ? 'right' : 'left']: 0 }]} />
              </View>
            );
          })}

          {children ? <View style={{ position: 'absolute', left: 0, right: 0, top: y + h + 16, alignItems: 'center' }}>{children}</View> : null}
        </>
      ) : null}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  mask: { position: 'absolute', backgroundColor: MASK },
});
