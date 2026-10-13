import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { useRevealOnFocus } from './KeyboardAware';
import { useEffect, useState } from 'react';
import { colors, radius, spacing } from '../lib/theme';

export function Screen({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const [opacity] = useState(() => new Animated.Value(0));
  const [translateY] = useState(() => new Animated.Value(10));
  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start();
  }, [opacity, translateY]);
  return <Animated.View style={[{ flex: 1, backgroundColor: colors.bg, opacity, transform: [{ translateY }] }, style]}>{children}</Animated.View>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Button({ title, onPress, variant = 'primary', disabled, loading }: { title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; disabled?: boolean; loading?: boolean }) {
  const [scale] = useState(() => new Animated.Value(1));
  const animateScale = (toValue: number) => Animated.spring(scale, { toValue, useNativeDriver: true, speed: 38, bounciness: 3 }).start();
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable onPress={onPress} onPressIn={() => !disabled && !loading && animateScale(0.98)} onPressOut={() => animateScale(1)} disabled={disabled || loading} style={({ pressed }) => [s.btn, s[`btn_${variant}`], (disabled || loading) && s.btnDisabled, pressed && !disabled && { opacity: 0.9 }]}>
        {loading ? <ActivityIndicator color={variant === 'secondary' || variant === 'ghost' ? colors.primary : '#fff'} /> : <Text style={[s.btnText, s[`btnText_${variant}`]]}>{title}</Text>}
      </Pressable>
    </Animated.View>
  );
}

export function Field({ label, error, ...props }: { label: string; error?: string } & TextInputProps) {
  const reveal = useRevealOnFocus();
  return (
    <View style={{ marginBottom: spacing(4) }}>
      <Text style={s.label}>{label}</Text>
      <TextInput style={[s.input, error && s.inputError]} placeholderTextColor={colors.faint} {...props} onFocus={(e) => { reveal(); props.onFocus?.(e); }} />
      {error ? <Text style={s.errorText}>{error}</Text> : null}
    </View>
  );
}

export function Badge({ text, tone = 'muted' }: { text: string; tone?: 'green' | 'amber' | 'red' | 'blue' | 'muted' }) {
  const map = { green: [colors.greenBg, colors.green], amber: [colors.amberBg, colors.amber], red: [colors.redBg, colors.red], blue: [colors.blueBg, colors.blue], muted: [colors.muted2, colors.muted] } as const;
  const [bg, fg] = map[tone];
  return <View style={{ backgroundColor: bg, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, alignSelf: 'flex-start' }}><Text style={{ color: fg, fontSize: 12, fontWeight: '700', textTransform: 'capitalize' }}>{text.replace(/_/g, ' ')}</Text></View>;
}

export function Banner({ text, tone = 'error' }: { text: string; tone?: 'error' | 'info' }) {
  return <View style={[s.banner, tone === 'error' ? { backgroundColor: colors.redBg } : { backgroundColor: colors.blueBg }]}><Text style={{ color: tone === 'error' ? colors.red : colors.blue, fontSize: 13 }}>{text}</Text></View>;
}

export function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return <View style={{ padding: spacing(10), alignItems: 'center' }}><Text style={{ fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: 4 }}>{title}</Text>{subtitle ? <Text style={{ fontSize: 13, color: colors.muted, textAlign: 'center' }}>{subtitle}</Text> : null}</View>;
}

const s = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing(4), borderWidth: 1, borderColor: colors.border, elevation: 4, shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 16, shadowOffset: { width: 0, height: 8 } },
  btn: { minHeight: 52, paddingHorizontal: spacing(5), paddingVertical: 13, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  btn_primary: { backgroundColor: colors.primary, shadowColor: colors.primary, shadowOpacity: 0.32, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 4 }, btn_secondary: { backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: '#4B3BA6' },
  btn_danger: { backgroundColor: colors.red }, btn_ghost: { backgroundColor: 'transparent' },
  btnDisabled: { opacity: 0.5 },
  btnText: { fontSize: 15, fontWeight: '800', letterSpacing: 0.1 },
  btnText_primary: { color: '#fff' }, btnText_secondary: { color: '#CFC5FF' }, btnText_danger: { color: '#2B1020' }, btnText_ghost: { color: '#B9ABFF' },
  label: { fontSize: 12, fontWeight: '800', color: colors.muted, marginBottom: 8, letterSpacing: 0.4, textTransform: 'uppercase' },
  input: { minHeight: 52, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, backgroundColor: colors.surfaceSoft, color: colors.text },
  inputError: { borderColor: colors.red },
  errorText: { color: colors.red, fontSize: 12, marginTop: 4 },
  banner: { padding: 14, borderRadius: radius.md, marginBottom: spacing(3), borderWidth: 1, borderColor: colors.border },
});
