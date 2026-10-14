import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from '../components/KeyboardAware';
import { useAuth } from '../lib/auth';
import { ApiRequestError, API_URL } from '../lib/api';
import { Screen } from '../components/Kit';
import { ErrorBanner, PButton, PInput, SectionLabel, gradient } from '../components/Premium';
import { premium as c } from '../lib/theme';

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
        <KeyboardAwareScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
          <View style={[s.glow, gradient('radial-gradient(circle at 50% 50%, rgba(124,92,255,0.30) 0%, rgba(5,11,24,0) 70%)')]} pointerEvents="none" />
          <Image source={LOGO} style={s.fullLogo} resizeMode="contain" accessibilityLabel="Routify: Plan, Deliver, Track" />
          <Text style={s.title}>Welcome back.</Text>
          <Text style={s.subtitle}>Sign in to take control of today&apos;s deliveries.</Text>

          <ErrorBanner text={error} />
          <View style={{ gap: 14 }}>
            <View>
              <SectionLabel>Email</SectionLabel>
              <PInput icon="mail-outline" autoCapitalize="none" keyboardType="email-address" autoComplete="email" value={email} onChangeText={setEmail} placeholder="you@example.com" />
            </View>
            <View>
              <SectionLabel>Password</SectionLabel>
              <PInput icon="lock-closed-outline" secureTextEntry autoComplete="password" value={password} onChangeText={setPassword} placeholder="••••••••" returnKeyType="go" onSubmitEditing={() => { if (email && password) void submit(); }} />
              <Pressable onPress={() => onForgot(email.trim())} hitSlop={8} style={{ alignSelf: 'flex-end', marginTop: 10 }}>
                <Text style={{ color: c.primary, fontSize: 13, fontWeight: '700' }}>Forgot password?</Text>
              </Pressable>
            </View>
          </View>
          <PButton title="Sign in" icon="log-in-outline" onPress={submit} loading={busy} disabled={!email || !password} chevron style={{ marginTop: 22 }} />
          <Pressable onPress={onGoRegister} style={{ alignItems: 'center', paddingVertical: 18 }}>
            <Text style={{ color: c.textSecondary, fontSize: 14 }}>New here? <Text style={{ color: c.primary, fontWeight: '800' }}>Create an account</Text></Text>
          </Pressable>
        </KeyboardAwareScrollView>
    </Screen>
  );
}

const LOGO = require('../../assets/brand/routify-logo.png');
export const BRAND_MARK = require('../../assets/brand/routify-mark.png');

export function BrandMark() {
  return <Image source={BRAND_MARK} style={s.mark} resizeMode="contain" accessibilityLabel="Routify" />;
}

const s = StyleSheet.create({
  page: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  glow: { position: 'absolute', top: 40, left: -60, width: 320, height: 320, borderRadius: 160 },
  fullLogo: { width: 190, height: 204, alignSelf: 'center', marginBottom: 26 },
  mark: { width: 76, height: 70, marginBottom: 16 },
  title: { color: c.text, fontSize: 28, fontWeight: '800', marginBottom: 6 },
  subtitle: { color: c.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: 26 },
});
