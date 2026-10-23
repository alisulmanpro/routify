import { requireOptionalNativeModule } from 'expo';
import type { ComponentType } from 'react';

// Speech recognition is a native module that Expo Go does not ship. It is only loaded when present, so the app
// still runs in Expo Go (voice falls back to typing) and works fully in a development or store build.

export const hasSpeech = !!requireOptionalNativeModule('ExpoSpeechRecognition');

export const NATIVE_BUILD_HINT = 'This needs the full app build (not Expo Go).';

export type VoicePanelProps = { onText: (text: string) => void; compact?: boolean };

/** The microphone control, or null when speech recognition is not available. */
export function loadVoicePanel(): ComponentType<VoicePanelProps> | null {
  if (!hasSpeech) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded lazily so Expo Go doesn't crash on startup
  return (require('../components/VoicePanel') as typeof import('../components/VoicePanel')).default;
}
