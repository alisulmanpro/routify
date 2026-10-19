import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from '../components/KeyboardAware';
import { useAuth } from '../lib/auth';
import { ApiRequestError, get } from '../lib/api';
import type { PublicConfig } from '../lib/types';
import { Screen } from '../components/Kit';
import { ErrorBanner, PButton, PCard, PInput, SectionLabel } from '../components/Premium';
import { AUTOFILL } from '../lib/inputs';
import { BrandMark } from './Login';
import { premium as c } from '../lib/theme';

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
        <KeyboardAwareScrollView contentContainerStyle={{ padding: 24, paddingTop: 36 }} keyboardShouldPersistTaps="handled">
          <BrandMark />
          <Text style={s.eyebrow}>Routify · Get started</Text>
          <Text style={s.title}>Create your rider account.</Text>
          <Text style={s.subtitle}>Your own {config?.platformName || 'Routify'} account. Then start your {config?.trialDays ? `${config.trialDays}-day ` : ''}free trial through Google Play or the App Store.</Text>

          <ErrorBanner text={error} />
          <PCard style={{ gap: 14 }}>
            <View><SectionLabel>Full name</SectionLabel><PInput icon="person-outline" {...AUTOFILL.name} value={form.fullName} onChangeText={set('fullName')} placeholder="Ali Hassan" autoCapitalize="words" /></View>
            <View><SectionLabel>Email</SectionLabel><PInput icon="mail-outline" {...AUTOFILL.email} autoCapitalize="none" keyboardType="email-address" value={form.email} onChangeText={set('email')} placeholder="you@example.com" /></View>
          </PCard>

          <PCard style={{ gap: 14, marginTop: 14 }}>
            <View><SectionLabel>{`Password (min ${config?.minPasswordLength || 8} characters)`}</SectionLabel><PInput icon="lock-closed-outline" {...AUTOFILL.newPassword} secureTextEntry value={form.password} onChangeText={set('password')} placeholder="••••••••" /></View>
            <View><SectionLabel>Confirm password</SectionLabel><PInput icon="shield-checkmark-outline" {...AUTOFILL.newPassword} secureTextEntry value={form.confirmPassword} onChangeText={set('confirmPassword')} placeholder="••••••••" /></View>
          </PCard>

          <PButton title="Create account" icon="person-add-outline" onPress={submit} loading={busy} disabled={!form.fullName || !form.email || !form.password} chevron style={{ marginTop: 20 }} />
          <Pressable onPress={onGoLogin} style={{ alignItems: 'center', paddingVertical: 18 }}>
            <Text style={{ color: c.textSecondary, fontSize: 14 }}>Already have an account? <Text style={{ color: c.primary, fontWeight: '800' }}>Sign in</Text></Text>
          </Pressable>
        </KeyboardAwareScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  eyebrow: { color: c.primary, fontSize: 12, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 6 },
  title: { color: c.text, fontSize: 26, fontWeight: '800', marginBottom: 6 },
  subtitle: { color: c.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: 22 },
});
