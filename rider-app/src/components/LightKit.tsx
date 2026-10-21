import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Image, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRevealOnFocus } from './KeyboardAware';
import { light as c, lightRadius as r } from '../lib/theme';

// Shared building blocks for the light design_pref screens (auth, Home).

export function LightBrand({ name = 'Routify' }: { name?: string }) {
  return (
    <View style={s.brand}>
      <View style={s.mark}>
        <MaterialCommunityIcons name="vector-curve" size={20} color={c.onInk} />
        <View style={s.markDot} />
      </View>
      <Text style={s.brandName}>{name}</Text>
    </View>
  );
}

export function LightField({ label, secureTextEntry, style, ...props }: TextInputProps & { label: string }) {
  const reveal = useRevealOnFocus();
  const [hidden, setHidden] = useState(true);
  const [focused, setFocused] = useState(false);
  return (
    <View style={style as ViewStyle}>
      <Text style={s.label}>{label}</Text>
      <View style={[s.field, focused && { borderColor: c.ink }]}>
        {/* Password fields must reach the API exactly as typed: no auto-capitalised first letter, no autocorrect. */}
        <TextInput placeholderTextColor={c.placeholder} style={s.fieldText}
          {...(secureTextEntry ? { secureTextEntry: hidden, autoCapitalize: 'none' as const, autoCorrect: false, spellCheck: false } : null)} {...props}
          onFocus={(e) => { setFocused(true); reveal(); props.onFocus?.(e); }}
          onBlur={(e) => { setFocused(false); props.onBlur?.(e); }} />
        {secureTextEntry ? (
          <Pressable onPress={() => setHidden((h) => !h)} hitSlop={10} accessibilityLabel={hidden ? 'Show password' : 'Hide password'}>
            <Ionicons name={hidden ? 'eye-outline' : 'eye-off-outline'} size={20} color={c.textSecondary} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function LightButton({ title, onPress, variant = 'solid', icon, loading, disabled, style }: {
  title: string; onPress: () => void; variant?: 'solid' | 'outline'; icon?: ReactNode; loading?: boolean; disabled?: boolean; style?: ViewStyle;
}) {
  const fg = variant === 'solid' ? c.onInk : c.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityState={{ disabled: disabled || loading }}
      style={({ pressed }) => [s.btn, variant === 'solid' ? s.btnSolid : s.btnOutline, (disabled || loading) && { opacity: 0.45 }, pressed && { opacity: 0.85 }, style]}
    >
      {loading ? <ActivityIndicator color={fg} /> : <>{icon}<Text style={[s.btnText, { color: fg }]} numberOfLines={1}>{title}</Text></>}
    </Pressable>
  );
}

// Rendered from design_pref/Vector.svg; the app has no SVG support.
const GOOGLE_G = require('../../assets/brand/google-g.png');

/** Disabled until Google sign-in exists. MISSING: see missing.md */
export function GoogleButton({ style }: { style?: ViewStyle }) {
  return <LightButton title="Continue with Google" variant="outline" icon={<Image source={GOOGLE_G} style={{ width: 20, height: 20 }} resizeMode="contain" />} onPress={() => {}} disabled style={style} />;
}

export function LightDivider({ text = 'or' }: { text?: string }) {
  return (
    <View style={s.divider}>
      <View style={s.rule} />
      <Text style={s.dividerText}>{text}</Text>
      <View style={s.rule} />
    </View>
  );
}

export type LightTone = 'blue' | 'green' | 'amber' | 'red' | 'muted';
const TONE: Record<LightTone, { fg: string; bg: string }> = {
  blue: { fg: c.link, bg: c.linkBg },
  green: { fg: c.success, bg: c.successBg },
  amber: { fg: c.warning, bg: c.warningBg },
  red: { fg: c.danger, bg: c.dangerBg },
  muted: { fg: c.textLabel, bg: c.soft },
};
export function LightPill({ text, tone = 'muted' }: { text: string; tone?: LightTone }) {
  const t = TONE[tone];
  return (
    <View style={[s.pill, { backgroundColor: t.bg }]}>
      <Text style={{ color: t.fg, fontSize: 14, fontWeight: '500' }} numberOfLines={1}>{text}</Text>
    </View>
  );
}

export function LightProgress({ progress, style }: { progress: number; style?: ViewStyle }) {
  const [value] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(value, { toValue: Math.max(0, Math.min(progress, 100)), duration: 650, useNativeDriver: false }).start();
  }, [progress, value]);
  const width = value.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] });
  return (
    <View style={[s.track, style]}>
      <Animated.View style={{ width, height: '100%', borderRadius: 99, backgroundColor: c.link }} />
    </View>
  );
}

export function LightError({ text }: { text: string }) {
  if (!text) return null;
  return (
    <View style={s.error}>
      <Ionicons name="alert-circle" size={16} color={c.danger} />
      <Text style={{ flex: 1, color: c.danger, fontSize: 13, lineHeight: 18 }}>{text}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mark: { width: 32, height: 32, borderRadius: r.mark, backgroundColor: c.ink, alignItems: 'center', justifyContent: 'center' },
  markDot: { position: 'absolute', top: 6, right: 6, width: 6, height: 6, borderRadius: 3, backgroundColor: c.accentDot },
  brandName: { color: c.text, fontSize: 18, fontWeight: '700' },

  label: { color: c.textLabel, fontSize: 14, fontWeight: '500', marginBottom: 8 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 16, borderRadius: r.field, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
  fieldText: { flex: 1, color: c.text, fontSize: 16, paddingVertical: 14 },

  btn: { flexDirection: 'row', gap: 12, alignItems: 'center', justifyContent: 'center', minHeight: 56, paddingHorizontal: 16, borderRadius: r.button },
  btnSolid: { backgroundColor: c.ink },
  btnOutline: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  btnText: { fontSize: 16, fontWeight: '600' },

  divider: { flexDirection: 'row', alignItems: 'center', gap: 16, marginVertical: 22 },
  rule: { flex: 1, height: 1, backgroundColor: c.divider },
  dividerText: { color: c.textSecondary, fontSize: 14 },

  pill: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999 },
  track: { height: 6, backgroundColor: c.track, borderRadius: 99, overflow: 'hidden' },

  error: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FEF2F2', borderRadius: 12, padding: 12, marginBottom: 16 },
});
