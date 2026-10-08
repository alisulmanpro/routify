import type { ComponentProps, ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type TextStyle, type ViewStyle } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { premium as c, premiumRadius as r, premiumShadow } from '../lib/theme';

// Shared building blocks for screens on the premium navy + orange design system.

export type IonName = ComponentProps<typeof Ionicons>['name'];
export type McName = ComponentProps<typeof MaterialCommunityIcons>['name'];

/** Gradients use RN's native CSS gradient support; backgroundColor is the fallback (e.g. web). */
export const gradient = (value: string): ViewStyle => ({ experimental_backgroundImage: value } as ViewStyle);
export const PRIMARY_GRADIENT = 'linear-gradient(100deg, #C97812 0%, #FFAA32 100%)';
export const DARK_ON_PRIMARY = '#1A1206';

export function Header({ eyebrow, eyebrowIcon, title, subtitle, right }: { eyebrow?: string; eyebrowIcon?: McName; title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <View style={{ marginBottom: 18 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          {eyebrow ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              {eyebrowIcon ? <MaterialCommunityIcons name={eyebrowIcon} size={14} color={c.primary} /> : null}
              <Text style={s.eyebrow}>{eyebrow}</Text>
            </View>
          ) : null}
          <Text style={s.title}>{title}</Text>
        </View>
        {right}
      </View>
      {subtitle ? <Text style={s.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

export function PCard({ children, style, accent }: { children: ReactNode; style?: ViewStyle | ViewStyle[]; accent?: boolean }) {
  return <View style={[s.card, accent && s.cardAccent, style]}>{children}</View>;
}

type ButtonVariant = 'primary' | 'secondary' | 'danger';
export function PButton({ title, onPress, icon, variant = 'primary', loading, disabled, chevron, style }: {
  title: string; onPress: () => void; icon?: IonName; variant?: ButtonVariant; loading?: boolean; disabled?: boolean; chevron?: boolean; style?: ViewStyle;
}) {
  const fg = variant === 'primary' ? DARK_ON_PRIMARY : variant === 'danger' ? '#fff' : c.text;
  const accent = variant === 'secondary' ? c.primary : fg;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        s.btn,
        variant === 'primary' && [s.btnPrimary, gradient(PRIMARY_GRADIENT)],
        variant === 'secondary' && s.btnSecondary,
        variant === 'danger' && [s.btnDanger, gradient('linear-gradient(100deg, #E0384F 0%, #FF5368 100%)')],
        (disabled || loading) && { opacity: 0.55 },
        pressed && { opacity: 0.88 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={accent} /> : icon ? <Ionicons name={icon} size={18} color={accent} /> : null}
      <Text style={[s.btnText, { color: fg }]} numberOfLines={1}>{title}</Text>
      {chevron ? <View style={[s.chevron, variant !== 'primary' && { backgroundColor: 'rgba(255,255,255,0.06)' }]}><Ionicons name="chevron-forward" size={15} color={fg} /></View> : null}
    </Pressable>
  );
}

export type PillTone = 'green' | 'amber' | 'blue' | 'red' | 'orange' | 'muted';
const PILL: Record<PillTone, { fg: string; bg: string }> = {
  green: { fg: c.success, bg: 'rgba(25,216,139,0.14)' },
  amber: { fg: c.warning, bg: 'rgba(255,179,64,0.14)' },
  blue: { fg: '#7FB2FF', bg: 'rgba(61,139,255,0.16)' },
  red: { fg: c.danger, bg: 'rgba(255,83,104,0.14)' },
  orange: { fg: c.primary, bg: 'rgba(255,170,50,0.14)' },
  muted: { fg: c.textSecondary, bg: c.surfaceSoft },
};
export function Pill({ text, tone = 'muted', icon, style }: { text: string; tone?: PillTone; icon?: IonName; style?: ViewStyle }) {
  const t = PILL[tone];
  return (
    <View style={[s.pill, { backgroundColor: t.bg }, style]}>
      {icon ? <Ionicons name={icon} size={11} color={t.fg} /> : <View style={[s.pillDot, { backgroundColor: t.fg }]} />}
      <Text style={{ color: t.fg, fontSize: 11, fontWeight: '700' }}>{text}</Text>
    </View>
  );
}

export function PInput({ icon, style, ...props }: TextInputProps & { icon?: IonName }) {
  return (
    <View style={[s.input, style as ViewStyle]}>
      {icon ? <Ionicons name={icon} size={18} color={c.primary} /> : null}
      <TextInput placeholderTextColor={c.textMuted} style={s.inputText} {...props} />
    </View>
  );
}

export function SectionLabel({ children, style }: { children: string; style?: TextStyle }) {
  return <Text style={[s.sectionLabel, style]}>{children}</Text>;
}

export function IconCircle({ icon, color = c.primary, bg = 'rgba(255,170,50,0.14)', size = 40 }: { icon: McName; color?: string; bg?: string; size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      <MaterialCommunityIcons name={icon} size={size * 0.5} color={color} />
    </View>
  );
}

export function ErrorBanner({ text }: { text: string }) {
  if (!text) return null;
  return (
    <View style={s.error}>
      <Ionicons name="alert-circle" size={16} color={c.danger} />
      <Text style={{ flex: 1, color: c.danger, fontSize: 12, lineHeight: 17 }}>{text}</Text>
    </View>
  );
}

export function Empty({ icon, title, subtitle }: { icon: McName; title: string; subtitle?: string }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 40, paddingHorizontal: 20 }}>
      <IconCircle icon={icon} size={64} />
      <Text style={{ color: c.text, fontSize: 16, fontWeight: '800', marginTop: 14 }}>{title}</Text>
      {subtitle ? <Text style={{ color: c.textSecondary, fontSize: 13, textAlign: 'center', marginTop: 6, lineHeight: 19 }}>{subtitle}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  eyebrow: { color: c.primary, fontSize: 11, fontWeight: '800', letterSpacing: 1.1, textTransform: 'uppercase' },
  title: { color: c.text, fontSize: 24, fontWeight: '800' },
  subtitle: { color: c.textSecondary, fontSize: 13, marginTop: 4, lineHeight: 19 },

  card: { backgroundColor: c.surface, borderRadius: r.large, borderWidth: 1, borderColor: c.border, padding: 16, ...premiumShadow },
  cardAccent: { borderColor: 'rgba(255,170,50,0.35)' },

  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 50, paddingHorizontal: 16, borderRadius: r.medium },
  btnPrimary: { backgroundColor: c.primary, shadowColor: c.primary, shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 6 },
  btnSecondary: { backgroundColor: c.surfaceSoft, borderWidth: 1, borderColor: c.border },
  btnDanger: { backgroundColor: c.danger },
  btnText: { flexShrink: 1, fontSize: 15, fontWeight: '800' },
  chevron: { position: 'absolute', right: 12, width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(26,18,6,0.14)', alignItems: 'center', justifyContent: 'center' },

  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 4, borderRadius: r.pill, alignSelf: 'flex-start' },
  pillDot: { width: 6, height: 6, borderRadius: 3 },

  input: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 50, paddingHorizontal: 14, borderRadius: r.medium, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceSoft },
  inputText: { flex: 1, color: c.text, fontSize: 15, paddingVertical: 12 },

  sectionLabel: { color: c.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 },
  error: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(255,83,104,0.12)', borderRadius: r.small, padding: 12, marginBottom: 12 },
});
