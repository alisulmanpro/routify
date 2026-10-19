import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../lib/auth';
import { patch, post, setTokens, ApiRequestError } from '../lib/api';
import { Screen } from '../components/Kit';
import { KeyboardAwareScrollView } from '../components/KeyboardAware';
import { ErrorBanner, Header, IconCircle, PButton, PCard, PInput, Pill, SectionLabel, gradient, DARK_ON_PRIMARY } from '../components/Premium';
import { AUTOFILL } from '../lib/inputs';
import { premium as c, premiumRadius as r } from '../lib/theme';
import { useNav } from '../lib/nav';
import { useServiceArea } from '../lib/serviceArea';

export default function Account() {
  const { user, logout, refreshProfile } = useAuth();
  const { navigate } = useNav();
  const [error, setError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' });
  const [cityInput, setCityInput] = useState('');
  const [detecting, setDetecting] = useState(false);
  const { checkNow } = useServiceArea();

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
      setShowPassword(false);
      Alert.alert('Password changed');
    } catch (err) { setPasswordError(err instanceof ApiRequestError ? err.message : 'Could not change password'); }
    finally { setSaving(false); }
  };

  const area = user.serviceArea;

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <KeyboardAwareScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 14 }} keyboardShouldPersistTaps="handled">
        <Header eyebrow="Settings" eyebrowIcon="cog-outline" title="Account" />
        <ErrorBanner text={error} />

        {/* Profile */}
        <PCard accent style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <View style={[s.avatar, gradient('linear-gradient(135deg, #FFC56B 0%, #FFAA32 50%, #C97812 100%)')]}>
            <Text style={{ color: DARK_ON_PRIMARY, fontWeight: '800', fontSize: 22 }}>{user.fullName.slice(0, 1).toUpperCase()}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: c.text, fontSize: 18, fontWeight: '800' }} numberOfLines={1}>{user.fullName}</Text>
            <View style={s.metaRow}><Ionicons name="mail-outline" size={13} color={c.textMuted} /><Text style={s.meta} numberOfLines={1}>{user.email}</Text></View>
            {user.phone ? <View style={s.metaRow}><Ionicons name="call-outline" size={13} color={c.textMuted} /><Text style={s.meta}>{user.phone}</Text></View> : null}
          </View>
        </PCard>

        {/* Subscription */}
        <Pressable onPress={() => navigate('SubscriptionScreen')} style={({ pressed }) => [pressed && { opacity: 0.88 }]}>
          <PCard style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 }}>
            <IconCircle icon="crown-outline" />
            <Text style={{ flex: 1, color: c.text, fontSize: 15, fontWeight: '700' }}>Subscription & plans</Text>
            <Ionicons name="chevron-forward" size={18} color={c.textSecondary} />
          </PCard>
        </Pressable>

        {/* Delivery city */}
        <PCard>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <IconCircle icon="city-variant-outline" />
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>Delivery city</Text>
              <Text style={s.cardHint}>Customer addresses are searched in this city.</Text>
            </View>
          </View>
          <View style={s.cityBox}>
            <Ionicons name="location" size={18} color={c.primary} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.text, fontSize: 15, fontWeight: '800' }}>{area ? `${area.city}${area.country ? `, ${area.country}` : ''}` : 'Not set yet'}</Text>
              <Text style={{ color: c.textMuted, fontSize: 11, marginTop: 1 }}>{area ? (area.source === 'gps' ? 'Detected from your location' : 'Set by you') : 'We will detect it from your location'}</Text>
            </View>
            {area ? <Pill text={area.source === 'gps' ? 'GPS' : 'Manual'} tone={area.source === 'gps' ? 'green' : 'orange'} /> : null}
          </View>
          <PButton title="Use my current location" icon="navigate-outline" variant="secondary" onPress={detectCity} loading={detecting} disabled={saving} chevron style={{ marginTop: 12 }} />

          <View style={s.orRow}>
            <View style={s.orLine} /><Text style={s.orText}>OR TYPE YOUR CITY</Text><View style={s.orLine} />
          </View>
          <PInput icon="search" placeholder="e.g. London, United Kingdom" value={cityInput} onChangeText={setCityInput} autoCapitalize="words" returnKeyType="done" onSubmitEditing={saveCity} />
          <PButton title="Save city" icon="checkmark-circle-outline" onPress={saveCity} loading={saving && !!cityInput.trim()} disabled={!cityInput.trim() || saving} style={{ marginTop: 10 }} />
        </PCard>

        {/* Password */}
        <PCard style={{ paddingVertical: showPassword ? 16 : 14 }}>
          <Pressable onPress={() => setShowPassword((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <IconCircle icon="lock-outline" />
            <Text style={{ flex: 1, color: c.text, fontSize: 15, fontWeight: '700' }}>Change password</Text>
            <Ionicons name={showPassword ? 'chevron-up' : 'chevron-down'} size={18} color={c.textSecondary} />
          </Pressable>
          {showPassword ? (
            <View style={{ gap: 10, marginTop: 14 }}>
              <SectionLabel>Current password (your old one)</SectionLabel>
              <PInput icon="key-outline" placeholder="Current password" {...AUTOFILL.password} secureTextEntry value={passwords.currentPassword} onChangeText={(v) => setPasswords({ ...passwords, currentPassword: v })} />
              <SectionLabel>New password</SectionLabel>
              <PInput icon="lock-closed-outline" placeholder="New password" {...AUTOFILL.newPassword} secureTextEntry value={passwords.newPassword} onChangeText={(v) => setPasswords({ ...passwords, newPassword: v })} />
              {/* Shown here, not in the banner at the top, which is off-screen while this card is open. */}
              <ErrorBanner text={passwordError} />
              <PButton title="Update password" icon="shield-checkmark-outline" onPress={changePassword} loading={saving} disabled={!passwords.currentPassword || !passwords.newPassword} />
            </View>
          ) : null}
        </PCard>

        <PButton title="Sign out" icon="log-out-outline" variant="danger" onPress={logout} style={{ marginTop: 4 }} />
      </KeyboardAwareScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  avatar: { width: 60, height: 60, borderRadius: 30, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  meta: { flex: 1, color: c.textSecondary, fontSize: 12 },
  cardTitle: { color: c.text, fontSize: 15, fontWeight: '800' },
  cardHint: { color: c.textMuted, fontSize: 12, marginTop: 1 },
  cityBox: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, padding: 12, borderRadius: r.medium, backgroundColor: c.surfaceSoft, borderWidth: 1, borderColor: c.border },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 14 },
  orLine: { flex: 1, height: 1, backgroundColor: c.divider },
  orText: { color: c.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
});
