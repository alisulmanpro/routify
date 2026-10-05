import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { ApiRequestError, API_URL } from '../lib/api';
import { Banner, Button, Field, Screen } from '../components/Kit';
import { colors, spacing } from '../lib/theme';

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
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: spacing(6) }} keyboardShouldPersistTaps="handled">
          <Text style={{ fontSize: 28, fontWeight: '800', color: colors.text, marginBottom: 4 }}>Delivery Rider</Text>
          <Text style={{ fontSize: 14, color: colors.muted, marginBottom: spacing(6) }}>Sign in to manage your deliveries.</Text>
          {error ? <Banner text={error} /> : null}
          <Field label="Email" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} placeholder="you@example.com" />
          <Field label="Password" secureTextEntry value={password} onChangeText={setPassword} placeholder="••••••••" />
          <View style={{ height: spacing(2) }} />
          <Button title="Sign in" onPress={submit} loading={busy} disabled={!email || !password} />
          <View style={{ height: spacing(4) }} />
          <Button title="Create an account" variant="ghost" onPress={onGoRegister} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
