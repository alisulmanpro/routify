import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from '../components/KeyboardAware';
import { useAuth } from '../lib/auth';
import { ApiRequestError, API_URL } from '../lib/api';
import { StatusBar } from 'expo-status-bar';
import { Screen } from '../components/Kit';
import { GoogleButton, LightBrand, LightButton, LightDivider, LightError, LightField } from '../components/LightKit';
import { light as c } from '../lib/theme';

export default function Login({ onGoRegister, onForgot }: { onGoRegister: () => void; onForgot: (email: string) => void }) {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : err instanceof TypeError ? `Could not connect to ${API_URL}. Check that the backend is running and reachable from this device.` : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen style={{ backgroundColor: c.background }}>
        <StatusBar style="dark" />
        <KeyboardAwareScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
          <LightBrand />
          <Text style={s.title}>Welcome back</Text>
          <Text style={s.subtitle}>Sign in to start your deliveries</Text>

          <LightError text={error} />
          <View style={{ gap: 20 }}>
            <LightField label="Email" autoCapitalize="none" keyboardType="email-address" autoComplete="email" value={email} onChangeText={setEmail} placeholder="you@example.ie" />
            <View>
              <LightField label="Password" secureTextEntry autoComplete="password" value={password} onChangeText={setPassword} placeholder="Enter your password" returnKeyType="go" onSubmitEditing={() => { if (email && password) void submit(); }} />
              <Pressable onPress={() => onForgot(email.trim())} hitSlop={8} style={{ alignSelf: 'flex-end', marginTop: 16 }}>
                <Text style={{ color: c.link, fontSize: 15, fontWeight: '500' }}>Forgot password?</Text>
              </Pressable>
            </View>
          </View>

          <LightButton title="Sign in" onPress={submit} loading={busy} disabled={!email || !password} style={{ marginTop: 28 }} />
          <LightDivider />
          {/* MISSING: see missing.md — there is no Google sign-in in the app or API yet. */}
          <GoogleButton />

          <Pressable onPress={onGoRegister} style={{ alignItems: 'center', marginTop: 'auto', paddingTop: 40, paddingBottom: 8 }}>
            <Text style={{ color: c.textSecondary, fontSize: 15 }}>Don&apos;t have an account?  <Text style={{ color: c.link, fontWeight: '600' }}>Sign up</Text></Text>
          </Pressable>
        </KeyboardAwareScrollView>
    </Screen>
  );
}

export const BRAND_MARK = require('../../assets/brand/routify-mark.png');

export function BrandMark() {
  return <Image source={BRAND_MARK} style={s.mark} resizeMode="contain" accessibilityLabel="Routify" />;
}

const s = StyleSheet.create({
  page: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 72, paddingBottom: 32 },
  mark: { width: 76, height: 70, marginBottom: 16 },
  title: { color: c.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.6, marginTop: 52, marginBottom: 8 },
  subtitle: { color: c.textSecondary, fontSize: 16, lineHeight: 22, marginBottom: 36 },
});
