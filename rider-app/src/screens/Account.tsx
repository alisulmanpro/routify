import { useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { patch, post, ApiRequestError } from '../lib/api';
import type { Currency, RoutePreference } from '../lib/types';
import { Banner, Button, Card, Field, Screen } from '../components/Kit';
import { colors, radius, spacing } from '../lib/theme';
import { useNav } from '../lib/nav';

const CURRENCIES: Currency[] = ['USD', 'GBP', 'EUR', 'PKR', 'INR'];
const PREFERENCES: { value: RoutePreference; label: string }[] = [{ value: 'smart', label: 'Smart' }, { value: 'nearest_first', label: 'Nearest first' }, { value: 'shortest', label: 'Shortest' }];

export default function Account() {
  const { user, logout, refreshProfile } = useAuth();
  const { navigate } = useNav();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' });

  if (!user) return null;

  const updateField = async (patchBody: Record<string, unknown>) => {
    setSaving(true);
    setError('');
    try { await patch('/auth/me', patchBody); await refreshProfile(); }
    catch (err) { setError(err instanceof ApiRequestError ? err.message : 'Could not save'); }
    finally { setSaving(false); }
  };

  const changePassword = async () => {
    setSaving(true);
    setError('');
    try {
      await post('/auth/change-password', passwords);
      setPasswords({ currentPassword: '', newPassword: '' });
      setShowPassword(false);
      Alert.alert('Password changed');
    } catch (err) { setError(err instanceof ApiRequestError ? err.message : 'Could not change password'); }
    finally { setSaving(false); }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: spacing(5) }}>
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: spacing(4) }}>Account</Text>
        {error ? <Banner text={error} /> : null}

        <Card style={{ marginBottom: spacing(4) }}>
          <Text style={{ fontWeight: '700', color: colors.text, fontSize: 16 }}>{user.fullName}</Text>
          <Text style={{ color: colors.muted, fontSize: 13, marginTop: 2 }}>{user.email}</Text>
          <Text style={{ color: colors.muted, fontSize: 13 }}>{user.phone}</Text>
        </Card>

        <Pressable onPress={() => navigate('SubscriptionScreen')}>
          <Card style={{ marginBottom: spacing(3) }}><Text style={{ color: colors.text, fontWeight: '600' }}>Subscription & plans →</Text></Card>
        </Pressable>

        <Card style={{ marginBottom: spacing(3) }}>
          <Text style={{ fontWeight: '700', color: colors.text, marginBottom: 8 }}>Currency</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {CURRENCIES.map((c) => (
              <Pressable key={c} disabled={saving} onPress={() => updateField({ currency: c })} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: user.currency === c ? colors.primary : colors.border, backgroundColor: user.currency === c ? colors.blueBg : '#fff' }}>
                <Text style={{ color: user.currency === c ? colors.primary : colors.text, fontWeight: '600' }}>{c}</Text>
              </Pressable>
            ))}
          </View>
        </Card>

        <Card style={{ marginBottom: spacing(3) }}>
          <Text style={{ fontWeight: '700', color: colors.text, marginBottom: 8 }}>Route preference</Text>
          <View style={{ gap: 8 }}>
            {PREFERENCES.map((p) => (
              <Pressable key={p.value} disabled={saving} onPress={() => updateField({ routePreference: p.value })} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.primary, backgroundColor: user.routePreference === p.value ? colors.primary : '#fff' }} />
                <Text style={{ color: colors.text }}>{p.label}</Text>
              </Pressable>
            ))}
          </View>
        </Card>

        <Pressable onPress={() => setShowPassword((v) => !v)}>
          <Card style={{ marginBottom: spacing(3) }}><Text style={{ color: colors.text, fontWeight: '600' }}>Change password {showPassword ? '▾' : '▸'}</Text></Card>
        </Pressable>
        {showPassword && (
          <Card style={{ marginBottom: spacing(3) }}>
            <Field label="Current password" secureTextEntry value={passwords.currentPassword} onChangeText={(v) => setPasswords({ ...passwords, currentPassword: v })} />
            <Field label="New password" secureTextEntry value={passwords.newPassword} onChangeText={(v) => setPasswords({ ...passwords, newPassword: v })} />
            <Button title="Update password" onPress={changePassword} loading={saving} disabled={!passwords.currentPassword || !passwords.newPassword} />
          </Card>
        )}

        <View style={{ height: spacing(4) }} />
        <Button title="Sign out" variant="danger" onPress={logout} />
      </ScrollView>
    </Screen>
  );
}
