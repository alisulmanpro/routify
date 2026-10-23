import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import Constants from 'expo-constants';
import { useAuth } from '../lib/auth';
import { get, patch, post, setTokens, ApiRequestError } from '../lib/api';
import type { PublicConfig } from '../lib/types';
import { Screen } from '../components/Kit';
import { KeyboardAwareScrollView, useRevealOnFocus } from '../components/KeyboardAware';
import { LightButton, LightError } from '../components/LightKit';
import { AUTOFILL } from '../lib/inputs';
import { light as c, lightRadius as lr } from '../lib/theme';
import { useNav } from '../lib/nav';
import { useServiceArea } from '../lib/serviceArea';

type IonName = ComponentProps<typeof Ionicons>['name'];

/**
 * Account (design_pref "Account"): profile, settings, support and about. Rows the app has nothing behind yet are shown
 * disabled; the existing account features (plan, delivery area, password, sign out) keep their own rows.
 */
export default function Account() {
  const { user, logout, refreshProfile } = useAuth();
  const { navigate } = useNav();
  const [error, setError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [saving, setSaving] = useState(false);
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' });
  const [cityInput, setCityInput] = useState('');
  const [detecting, setDetecting] = useState(false);
  const { checkNow } = useServiceArea();
  const [open, setOpen] = useState<'area' | 'password' | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  useEffect(() => { get<PublicConfig>('/config').then((res) => setConfig(res.data)).catch(() => {}); }, []);

  if (!user) return null;

  const updateField = async (patchBody: Record<string, unknown>) => {
    setSaving(true);
    setError('');
    try { await patch('/auth/me', patchBody); await refreshProfile(); }
    catch (err) { setError(err instanceof ApiRequestError ? err.message : 'Could not save'); }
    finally { setSaving(false); }
  };

  const saveCity = async () => {
    const city = cityInput.trim();
    if (!city) return;
    await updateField({ city });
    setCityInput('');
  };

  const detectCity = async () => {
    setDetecting(true);
    try { await checkNow(); } finally { setDetecting(false); }
  };

  const changePassword = async () => {
    setSaving(true);
    setPasswordError('');
    try {
      // Changing the password signs out every session; keep this one going with the fresh tokens the API returns.
      const result = await post<{ accessToken: string; refreshToken: string }>('/auth/change-password', { ...passwords, client: 'mobile' });
      await setTokens({ accessToken: result.data.accessToken, refreshToken: result.data.refreshToken });
      setPasswords({ currentPassword: '', newPassword: '' });
      setOpen(null);
      Alert.alert('Password changed');
    } catch (err) { setPasswordError(err instanceof ApiRequestError ? err.message : 'Could not change password'); }
    finally { setSaving(false); }
  };

  const area = user.serviceArea;
  const version = Constants.expoConfig?.version;

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <StatusBar style="dark" />
      <KeyboardAwareScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Text style={s.title}>Account</Text>
        <LightError text={error} />

        <View style={s.profile}>
          <View style={s.avatar}><Text style={s.avatarText}>{user.fullName.slice(0, 1).toUpperCase()}</Text></View>
          <View style={{ flex: 1, marginLeft: 16 }}>
            <Text style={s.name} numberOfLines={1}>{user.fullName}</Text>
            <Text style={s.role} numberOfLines={1}>Rider{area ? ` · ${area.city}` : ''}</Text>
            {/* Not in the design: the sign-in email (and phone), as before. */}
            <Text style={s.email} numberOfLines={1}>{user.email}{user.phone ? ` · ${user.phone}` : ''}</Text>
          </View>
          {/* MISSING: see missing.md — no profile editing screen yet. */}
          <Text style={[s.link, { opacity: 0.4 }]}>Edit</Text>
        </View>

        <Text style={s.section}>Settings</Text>
        {/* MISSING: see missing.md — only Google Maps is supported, and there are no unit, sound or theme settings. */}
        <Row icon="navigate-outline" label="Navigation app" value="Google Maps" disabled first />
        <Row icon="resize-outline" label="Units" value="km" disabled />
        <Row icon="volume-medium-outline" label="Scan sound & vibration" disabled right={<Switch value disabled trackColor={{ true: c.link, false: c.track }} thumbColor="#fff" />} />
        <Row icon="sunny-outline" label="Appearance" value="Light" disabled />
        {/* Not in the design: the existing account settings. */}
        <Row icon="location-outline" label="Delivery area" value={area?.city || 'Not set'} onPress={() => setOpen(open === 'area' ? null : 'area')} expanded={open === 'area'} />
        {open === 'area' ? (
          <View style={s.panel}>
            <Text style={s.hint}>Customer addresses are searched in this area{area ? ` (${area.source === 'gps' ? 'from your location' : 'set by you'})` : ''}.</Text>
            <LightButton title="Use my current location" variant="outline" icon={detecting ? undefined : <Ionicons name="navigate-outline" size={20} color={c.text} />} onPress={detectCity} loading={detecting} disabled={saving} style={{ marginTop: 12 }} />
            <Field placeholder="Or type a city, e.g. Cork" value={cityInput} onChangeText={setCityInput} onSubmit={saveCity} />
            <LightButton title="Save city" onPress={saveCity} loading={saving && !!cityInput.trim()} disabled={!cityInput.trim() || saving} style={{ marginTop: 10 }} />
          </View>
        ) : null}
        <Row icon="card-outline" label="Subscription & plans" onPress={() => navigate('SubscriptionScreen')} />
        <Row icon="lock-closed-outline" label="Change password" onPress={() => setOpen(open === 'password' ? null : 'password')} expanded={open === 'password'} />
        {open === 'password' ? (
          <View style={s.panel}>
            <Field placeholder="Current password" secure value={passwords.currentPassword} onChangeText={(v) => setPasswords({ ...passwords, currentPassword: v })} autofill={AUTOFILL.password} />
            <Field placeholder="New password" secure value={passwords.newPassword} onChangeText={(v) => setPasswords({ ...passwords, newPassword: v })} autofill={AUTOFILL.newPassword} />
            <LightError text={passwordError} />
            <LightButton title="Update password" onPress={changePassword} loading={saving} disabled={!passwords.currentPassword || !passwords.newPassword} style={{ marginTop: passwordError ? 0 : 10 }} />
          </View>
        ) : null}

        <Text style={s.section}>Support</Text>
        {/* MISSING: see missing.md — no help pages yet. */}
        <Row icon="help-circle-outline" label="Help" disabled first />
        {/* Riders are independent (no manager); this emails the platform's support address. */}
        <Row icon="chatbubble-outline" label="Contact support" onPress={() => { if (config?.supportEmail) void Linking.openURL(`mailto:${config.supportEmail}`); }} disabled={!config?.supportEmail} />

        <Text style={s.section}>About</Text>
        <Row icon="information-circle-outline" label="Version" value={version || '—'} first />
        <Row icon="shield-outline" label="Privacy" onPress={() => { if (config?.privacyUrl) void Linking.openURL(config.privacyUrl); }} disabled={!config?.privacyUrl} />

        <Pressable onPress={logout} style={({ pressed }) => [s.signOut, pressed && { opacity: 0.7 }]}>
          <Ionicons name="log-out-outline" size={22} color={c.danger} />
          <Text style={{ color: c.danger, fontSize: 17, fontWeight: '600' }}>Sign out</Text>
        </Pressable>
      </KeyboardAwareScrollView>
    </Screen>
  );
}

function Row({ icon, label, value, right, onPress, disabled, first, expanded }: {
  icon: IonName; label: string; value?: string; right?: ReactNode; onPress?: () => void; disabled?: boolean; first?: boolean; expanded?: boolean;
}) {
  const tappable = !!onPress && !disabled;
  return (
    <Pressable onPress={onPress} disabled={!tappable} style={({ pressed }) => [s.row, !first && s.divider, pressed && { opacity: 0.7 }]} accessibilityState={{ disabled: !!disabled, expanded }}>
      <Ionicons name={icon} size={24} color={disabled ? c.placeholder : c.text} />
      <Text style={[s.rowLabel, disabled && { color: c.placeholder }]} numberOfLines={1}>{label}</Text>
      {value ? <Text style={[s.rowValue, disabled && { color: c.placeholder }]} numberOfLines={1}>{value}</Text> : null}
      {right ?? (onPress || value === undefined ? <Ionicons name={expanded ? 'chevron-up' : 'chevron-forward'} size={20} color={c.placeholder} style={{ marginLeft: 8, opacity: disabled ? 0.5 : 1 }} /> : null)}
    </Pressable>
  );
}

function Field({ placeholder, value, onChangeText, onSubmit, secure, autofill }: {
  placeholder: string; value: string; onChangeText: (v: string) => void; onSubmit?: () => void; secure?: boolean; autofill?: object;
}) {
  const reveal = useRevealOnFocus();
  return (
    <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={c.placeholder} style={s.field}
      secureTextEntry={secure} autoCapitalize={secure ? 'none' : 'words'} autoCorrect={!secure} {...autofill}
      returnKeyType="done" onSubmitEditing={onSubmit} onFocus={reveal} />
  );
}

const s = StyleSheet.create({
  title: { color: c.text, fontSize: 32, fontWeight: '800', letterSpacing: -0.5, marginBottom: 8 },
  profile: { flexDirection: 'row', alignItems: 'center', marginTop: 16, marginBottom: 8 },
  avatar: { width: 64, height: 64, borderRadius: 32, backgroundColor: c.linkBg, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: c.link, fontSize: 26, fontWeight: '700' },
  name: { color: c.text, fontSize: 20, fontWeight: '700' },
  role: { color: c.textSecondary, fontSize: 15, marginTop: 3 },
  email: { color: c.placeholder, fontSize: 13, marginTop: 2 },
  link: { color: c.link, fontSize: 16, fontWeight: '600' },
  section: { color: c.textSecondary, fontSize: 15, fontWeight: '600', marginTop: 28, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 16 },
  divider: { borderTopWidth: 1, borderTopColor: c.border },
  rowLabel: { flex: 1, color: c.text, fontSize: 17 },
  rowValue: { color: c.textSecondary, fontSize: 16, maxWidth: '45%' },
  panel: { paddingBottom: 16 },
  hint: { color: c.textSecondary, fontSize: 14, lineHeight: 20 },
  field: { minHeight: 50, borderRadius: lr.field, borderWidth: 1, borderColor: c.border, paddingHorizontal: 16, color: c.text, fontSize: 16, marginTop: 10 },
  signOut: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 28, paddingVertical: 16, borderTopWidth: 1, borderTopColor: c.border },
});
