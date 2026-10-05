import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { ApiRequestError, get } from '../lib/api';
import type { Currency, PublicConfig } from '../lib/types';
import { Banner, Button, Field, Screen } from '../components/Kit';
import { colors, radius, spacing } from '../lib/theme';

const ALL_CURRENCIES: Currency[] = ['USD', 'GBP', 'EUR', 'PKR', 'INR'];

export default function Register({ onGoLogin }: { onGoLogin: () => void }) {
  const { register } = useAuth();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [form, setForm] = useState({ fullName: '', phone: '', email: '', password: '', confirmPassword: '', currency: 'USD' as Currency });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { get<PublicConfig>('/config').then((r) => { setConfig(r.data); setForm((f) => ({ ...f, currency: r.data.defaultCurrency })); }).catch(() => {}); }, []);

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

  const currencies = config?.currencies || ALL_CURRENCIES;

  return (
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: spacing(6) }} keyboardShouldPersistTaps="handled">
          <Text style={{ fontSize: 26, fontWeight: '800', color: colors.text, marginBottom: 4 }}>Create your account</Text>
          <Text style={{ fontSize: 14, color: colors.muted, marginBottom: spacing(6) }}>Sets you up with a {config?.platformName || 'Delivery Planner'} organization and a free trial.</Text>
          {error ? <Banner text={error} /> : null}
          <Field label="Full name" value={form.fullName} onChangeText={(v) => setForm({ ...form, fullName: v })} placeholder="Ali Hassan" />
          <Field label="Phone" keyboardType="phone-pad" value={form.phone} onChangeText={(v) => setForm({ ...form, phone: v })} placeholder="+92 300 1234567" />
          <Field label="Email" autoCapitalize="none" keyboardType="email-address" value={form.email} onChangeText={(v) => setForm({ ...form, email: v })} placeholder="you@example.com" />
          <Field label={`Password (min ${config?.minPasswordLength || 8} characters)`} secureTextEntry value={form.password} onChangeText={(v) => setForm({ ...form, password: v })} placeholder="••••••••" />
          <Field label="Confirm password" secureTextEntry value={form.confirmPassword} onChangeText={(v) => setForm({ ...form, confirmPassword: v })} placeholder="••••••••" />
          <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 8 }}>Currency</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: spacing(4) }}>
            {currencies.map((c) => (
              <Pressable key={c} onPress={() => setForm({ ...form, currency: c })} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: form.currency === c ? colors.primary : colors.border, backgroundColor: form.currency === c ? colors.blueBg : '#fff' }}>
                <Text style={{ color: form.currency === c ? colors.primary : colors.text, fontWeight: '600' }}>{c}</Text>
              </Pressable>
            ))}
          </View>
          <Button title="Create account" onPress={submit} loading={busy} disabled={!form.fullName || !form.phone || !form.email || !form.password} />
          <View style={{ height: spacing(4) }} />
          <Button title="Already have an account? Sign in" variant="ghost" onPress={onGoLogin} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
