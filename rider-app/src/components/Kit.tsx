import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { colors, radius, spacing } from '../lib/theme';

export function Screen({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[{ flex: 1, backgroundColor: colors.bg }, style]}>{children}</View>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Button({ title, onPress, variant = 'primary', disabled, loading }: { title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; disabled?: boolean; loading?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled || loading} style={({ pressed }) => [s.btn, s[`btn_${variant}`], (disabled || loading) && s.btnDisabled, pressed && !disabled && { opacity: 0.88, transform: [{ scale: 0.99 }] }]}>
      {loading ? <ActivityIndicator color={variant === 'secondary' || variant === 'ghost' ? colors.primary : '#fff'} /> : <Text style={[s.btnText, s[`btnText_${variant}`]]}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, error, ...props }: { label: string; error?: string } & TextInputProps) {
  return (
    <View style={{ marginBottom: spacing(4) }}>
      <Text style={s.label}>{label}</Text>
      <TextInput style={[s.input, error && s.inputError]} placeholderTextColor={colors.faint} {...props} />
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
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing(4), borderWidth: 1, borderColor: colors.border, elevation: 1, shadowColor: '#152a22', shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
  btn: { minHeight: 48, paddingHorizontal: spacing(4), paddingVertical: 12, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  btn_primary: { backgroundColor: colors.primary }, btn_secondary: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.primary },
  btn_danger: { backgroundColor: colors.red }, btn_ghost: { backgroundColor: 'transparent' },
  btnDisabled: { opacity: 0.5 },
  btnText: { fontSize: 15, fontWeight: '700' },
  btnText_primary: { color: '#fff' }, btnText_secondary: { color: colors.primary }, btnText_danger: { color: '#fff' }, btnText_ghost: { color: colors.primary },
  label: { fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 6 },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 11, fontSize: 15, backgroundColor: '#fff', color: colors.text },
  inputError: { borderColor: colors.red },
  errorText: { color: colors.red, fontSize: 12, marginTop: 4 },
  banner: { padding: 12, borderRadius: radius.sm, marginBottom: spacing(3) },
});
