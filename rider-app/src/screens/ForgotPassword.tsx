import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from '../components/KeyboardAware';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useAuth } from '../lib/auth';
import { ApiRequestError, API_URL, get, post } from '../lib/api';
import type { PublicConfig } from '../lib/types';
import { Screen } from '../components/Kit';
import { ErrorBanner, PButton, PInput, SectionLabel } from '../components/Premium';
import { premium as c, premiumRadius as r } from '../lib/theme';

type Step = 'email' | 'code' | 'password';
const RESEND_SECONDS = 60;

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiRequestError ? err.message : err instanceof TypeError ? `Could not connect to ${API_URL}. Check that the backend is running.` : fallback;

/** Email → 6-digit code → new password, then the rider is signed straight in. */
export default function ForgotPassword({ initialEmail = '', onBack }: { initialEmail?: string; onBack: () => void }) {
  const { login } = useAuth();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [minLength, setMinLength] = useState(8);

  useEffect(() => { get<PublicConfig>('/config').then((res) => setMinLength(res.data.minPasswordLength || 8)).catch(() => {}); }, []);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const act = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError('');
    try { await action(); } catch (err) { setError(errorText(err, fallback)); } finally { setBusy(false); }
  };

  const sendCode = () => act(async () => {
    await post('/auth/forgot-password', { email: email.trim() });
    setCode('');
    setCooldown(RESEND_SECONDS);
    setStep('code');
  }, 'Could not send the code');

  const verifyCode = () => act(async () => {
    await post('/auth/reset-password/verify', { email: email.trim(), code });
    setStep('password');
  }, 'Could not check the code');

  const resetPassword = () => act(async () => {
    if (password !== confirm) throw new ApiRequestError(400, { code: 'MISMATCH', message: 'The two passwords do not match' });
    await post('/auth/reset-password', { email: email.trim(), code, newPassword: password, confirmPassword: confirm });
    await login(email.trim(), password);
  }, 'Could not reset your password');

  const titles: Record<Step, [string, string]> = {
    email: ['Forgot your password?', "Enter your account's email and we'll send you a 6-digit code."],
    code: ['Check your email', `If an account exists for ${email.trim()}, we've sent it a 6-digit code. It expires in 15 minutes.`],
    password: ['Choose a new password', 'This signs you out on every other device.'],
  };

  return (
    <Screen style={{ backgroundColor: c.background }}>
        <KeyboardAwareScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
          <Pressable onPress={step === 'email' ? onBack : () => { setError(''); setStep(step === 'password' ? 'code' : 'email'); }} hitSlop={10} style={s.back}>
            <Text style={s.backText}>‹  Back</Text>
          </Pressable>

          <View style={s.icon}>
            <MaterialCommunityIcons name={step === 'email' ? 'lock-question' : step === 'code' ? 'email-check-outline' : 'lock-reset'} size={30} color={c.primary} />
          </View>
          <Text style={s.title}>{titles[step][0]}</Text>
          <Text style={s.subtitle}>{titles[step][1]}</Text>
          <Steps step={step} />

          <ErrorBanner text={error} />

          {step === 'email' ? (
            <>
              <SectionLabel>Email</SectionLabel>
              <PInput icon="mail-outline" autoCapitalize="none" keyboardType="email-address" autoComplete="email" value={email} onChangeText={setEmail}
                placeholder="you@example.com" returnKeyType="send" onSubmitEditing={() => { if (email.trim()) void sendCode(); }} />
              <PButton title="Send code" icon="send-outline" onPress={sendCode} loading={busy} disabled={!email.trim()} chevron style={{ marginTop: 22 }} />
            </>
          ) : null}

          {step === 'code' ? (
            <>
              <SectionLabel>6-digit code</SectionLabel>
              <PInput icon="keypad-outline" keyboardType="number-pad" maxLength={6} autoComplete="one-time-code" textContentType="oneTimeCode"
                value={code} onChangeText={(v) => setCode(v.replace(/\D/g, ''))} placeholder="123456"
                returnKeyType="go" onSubmitEditing={() => { if (code.length === 6) void verifyCode(); }} />
              <PButton title="Verify code" icon="checkmark-circle-outline" onPress={verifyCode} loading={busy} disabled={code.length !== 6} chevron style={{ marginTop: 22 }} />
              <Pressable onPress={sendCode} disabled={busy || cooldown > 0} style={{ alignItems: 'center', paddingVertical: 16 }}>
                <Text style={{ color: c.textSecondary, fontSize: 13 }}>
                  Didn&apos;t get it? <Text style={{ color: cooldown ? c.textMuted : c.primary, fontWeight: '800' }}>{cooldown ? `Resend in ${cooldown}s` : 'Send a new code'}</Text>
                </Text>
              </Pressable>
              {__DEV__ ? <Text style={s.devHint}>Development: with EMAIL_PROVIDER=console the code is printed in the API server&apos;s terminal.</Text> : null}
            </>
          ) : null}

          {step === 'password' ? (
            <View style={{ gap: 14 }}>
              <View>
                <SectionLabel>{`New password (min ${minLength} characters)`}</SectionLabel>
                <PInput icon="lock-closed-outline" secureTextEntry autoComplete="new-password" value={password} onChangeText={setPassword} placeholder="••••••••" />
              </View>
              <View>
                <SectionLabel>Confirm new password</SectionLabel>
                <PInput icon="shield-checkmark-outline" secureTextEntry autoComplete="new-password" value={confirm} onChangeText={setConfirm} placeholder="••••••••"
                  returnKeyType="go" onSubmitEditing={() => { if (password && confirm) void resetPassword(); }} />
              </View>
              <PButton title="Reset password & sign in" icon="log-in-outline" onPress={resetPassword} loading={busy} disabled={!password || !confirm} chevron style={{ marginTop: 8 }} />
            </View>
          ) : null}
        </KeyboardAwareScrollView>
    </Screen>
  );
}

function Steps({ step }: { step: Step }) {
  const order: Step[] = ['email', 'code', 'password'];
  const at = order.indexOf(step);
  return (
    <View style={s.steps}>
      {order.map((name, i) => <View key={name} style={[s.stepBar, i <= at && { backgroundColor: c.primary }]} />)}
    </View>
  );
}

const s = StyleSheet.create({
  page: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  back: { position: 'absolute', top: 16, left: 24, backgroundColor: c.surfaceSoft, paddingHorizontal: 12, paddingVertical: 8, borderRadius: r.pill },
  backText: { color: c.text, fontWeight: '800', fontSize: 13 },
  icon: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,170,50,0.14)', marginBottom: 18 },
  title: { color: c.text, fontSize: 24, fontWeight: '800', marginBottom: 6 },
  subtitle: { color: c.textSecondary, fontSize: 14, lineHeight: 20 },
  steps: { flexDirection: 'row', gap: 6, marginTop: 18, marginBottom: 22 },
  stepBar: { flex: 1, height: 4, borderRadius: 2, backgroundColor: c.border },
  devHint: { color: c.textMuted, fontSize: 11, textAlign: 'center', lineHeight: 16 },
});
