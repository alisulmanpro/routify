import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from '../components/KeyboardAware';
import { useAuth } from '../lib/auth';
import { ApiRequestError, get } from '../lib/api';
import type { PublicConfig } from '../lib/types';
import { StatusBar } from 'expo-status-bar';
import { Screen } from '../components/Kit';
import { GoogleButton, LightBrand, LightButton, LightDivider, LightError, LightField } from '../components/LightKit';
import { light as c } from '../lib/theme';

export default function Register({ onGoLogin }: { onGoLogin: () => void }) {
  const { register } = useAuth();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [form, setForm] = useState({ fullName: '', email: '', password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  useEffect(() => { get<PublicConfig>('/config').then((res) => setConfig(res.data)).catch(() => {}); }, []);

  const submit = async () => {
    if (form.password !== form.confirmPassword) { setError('Passwords do not match'); return; }
    setBusy(true);
    setError('');
    try {
      await register(form);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not create your account');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen style={{ backgroundColor: c.background }}>
        <StatusBar style="dark" />
        <KeyboardAwareScrollView contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 24, paddingTop: 64, paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
          <LightBrand name={config?.platformName || 'Routify'} />
          <Text style={s.title}>Create your account</Text>
          <Text style={s.subtitle}>Sign up to start your deliveries</Text>

          <LightError text={error} />
          <View style={{ gap: 20 }}>
            <LightField label="Full name" value={form.fullName} onChangeText={set('fullName')} placeholder="e.g. Seán Murphy" autoCapitalize="words" autoComplete="name" />
            <LightField label="Email" autoCapitalize="none" keyboardType="email-address" autoComplete="email" value={form.email} onChangeText={set('email')} placeholder="you@example.ie" />
            <LightField label="Password" secureTextEntry value={form.password} onChangeText={set('password')} placeholder={`At least ${config?.minPasswordLength || 8} characters`} />
            {/* Not in the design; kept because register() still checks it. */}
            <LightField label="Confirm password" secureTextEntry value={form.confirmPassword} onChangeText={set('confirmPassword')} placeholder="Type it again" />
          </View>

          <LightButton title="Create account" onPress={submit} loading={busy} disabled={!form.fullName || !form.email || !form.password} style={{ marginTop: 28 }} />
          <LightDivider />
          {/* MISSING: see missing.md — there is no Google sign-in in the app or API yet. */}
          <GoogleButton />

          <Pressable onPress={onGoLogin} style={{ alignItems: 'center', marginTop: 'auto', paddingTop: 40, paddingBottom: 8 }}>
            <Text style={{ color: c.textSecondary, fontSize: 15 }}>Already have an account?  <Text style={{ color: c.link, fontWeight: '600' }}>Sign in</Text></Text>
          </Pressable>
        </KeyboardAwareScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  title: { color: c.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.6, marginTop: 44, marginBottom: 8 },
  subtitle: { color: c.textSecondary, fontSize: 16, lineHeight: 22, marginBottom: 32 },
});
