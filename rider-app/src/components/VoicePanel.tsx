import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { Ionicons } from '@expo/vector-icons';
import { premium as c } from '../lib/theme';
import type { VoicePanelProps } from '../lib/optionalNative';
import { DARK_ON_PRIMARY, gradient } from './Premium';

// Imported only through loadVoicePanel(), because importing expo-speech-recognition
// crashes on builds without its native module (e.g. Expo Go).
export default function VoicePanel({ onText }: VoicePanelProps) {
  const [listening, setListening] = useState(false);
  const [live, setLive] = useState('');
  const [problem, setProblem] = useState('');

  useSpeechRecognitionEvent('start', () => { setListening(true); setProblem(''); });
  useSpeechRecognitionEvent('end', () => setListening(false));
  useSpeechRecognitionEvent('result', (event) => {
    const text = event.results[0]?.transcript ?? '';
    setLive(text);
    if (event.isFinal && text) onText(text);
  });
  useSpeechRecognitionEvent('error', (event) => {
    setListening(false);
    if (event.error === 'no-speech' || event.error === 'speech-timeout') setProblem("Didn't catch that. Tap the microphone and try again.");
    else if (event.error === 'not-allowed') setProblem('Allow microphone access to use voice entry.');
    else if (event.error !== 'aborted') setProblem('Voice recognition is not available right now. Type the value instead.');
  });

  useEffect(() => () => { ExpoSpeechRecognitionModule.abort(); }, []);

  const toggle = async () => {
    if (listening) { ExpoSpeechRecognitionModule.stop(); return; }
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) { setProblem('Allow microphone access to use voice entry.'); return; }
    setLive('');
    // No fixed language: recognition follows the phone's language so riders anywhere can use it.
    ExpoSpeechRecognitionModule.start({ interimResults: true, continuous: false });
  };

  return (
    <View style={{ alignItems: 'center', paddingVertical: 8 }}>
      <Pressable onPress={toggle} style={({ pressed }) => [s.mic, listening && s.micOn, pressed && { opacity: 0.9 }]}>
        <View style={[s.micInner, gradient(listening ? 'linear-gradient(135deg, #FF5368 0%, #E0384F 100%)' : 'linear-gradient(135deg, #FFC56B 0%, #FFAA32 50%, #C97812 100%)')]}>
          <Ionicons name={listening ? 'stop' : 'mic'} size={34} color={listening ? '#fff' : DARK_ON_PRIMARY} />
        </View>
      </Pressable>
      <Text style={{ color: listening ? c.primary : c.textSecondary, fontWeight: '700', marginTop: 10 }}>{listening ? 'Listening… tap to stop' : 'Tap to speak'}</Text>
      {live && listening ? <Text style={{ color: c.text, fontSize: 15, marginTop: 8, textAlign: 'center' }}>{live}</Text> : null}
      {problem ? <Text style={{ color: c.warning, fontSize: 12, marginTop: 8, textAlign: 'center' }}>{problem}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  mic: { width: 112, height: 112, borderRadius: 56, padding: 8, backgroundColor: 'rgba(255,170,50,0.12)' },
  micOn: { backgroundColor: 'rgba(255,83,104,0.18)' },
  micInner: { flex: 1, borderRadius: 48, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
});
