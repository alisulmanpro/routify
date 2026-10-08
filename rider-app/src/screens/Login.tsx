import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useAuth } from '../lib/auth';
import { ApiRequestError, API_URL } from '../lib/api';
import { Screen } from '../components/Kit';
import { DARK_ON_PRIMARY, ErrorBanner, PButton, PInput, SectionLabel, gradient } from '../components/Premium';
import { premium as c } from '../lib/theme';

export default function Login({ onGoRegister }: { onGoRegister: () => void }) {
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
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
          <View style={[s.glow, gradient('radial-gradient(circle at 50% 50%, rgba(255,170,50,0.28) 0%, rgba(5,11,24,0) 70%)')]} pointerEvents="none" />
          <BrandMark />
          <Text style={s.eyebrow}>Delivery planner</Text>
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
            </View>
          </View>
          <PButton title="Sign in" icon="log-in-outline" onPress={submit} loading={busy} disabled={!email || !password} chevron style={{ marginTop: 22 }} />
          <Pressable onPress={onGoRegister} style={{ alignItems: 'center', paddingVertical: 18 }}>
            <Text style={{ color: c.textSecondary, fontSize: 14 }}>New here? <Text style={{ color: c.primary, fontWeight: '800' }}>Create an account</Text></Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

export function BrandMark() {
  return (
    <View style={[s.logo, gradient('linear-gradient(135deg, #FFC56B 0%, #FFAA32 50%, #C97812 100%)')]}>
      <MaterialCommunityIcons name="package-variant-closed" size={30} color={DARK_ON_PRIMARY} />
    </View>
  );
}

const s = StyleSheet.create({
  page: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  glow: { position: 'absolute', top: 40, left: -60, width: 320, height: 320, borderRadius: 160 },
  logo: { width: 60, height: 60, borderRadius: 20, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', marginBottom: 22, shadowColor: c.primary, shadowOpacity: 0.45, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 10 },
  eyebrow: { color: c.primary, fontSize: 12, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 6 },
  title: { color: c.text, fontSize: 28, fontWeight: '800', marginBottom: 6 },
  subtitle: { color: c.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: 26 },
});
