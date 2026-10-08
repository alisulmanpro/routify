import { requireOptionalNativeModule } from 'expo';
import type { ComponentType } from 'react';

// Text reading and speech recognition are native modules that Expo Go does not ship.
// They are only loaded when present, so the app still runs in Expo Go (those two
// features fall back to typing) and works fully in a development or store build.

export const hasTextReader = !!requireOptionalNativeModule('ExpoTextExtractor');
export const hasSpeech = !!requireOptionalNativeModule('ExpoSpeechRecognition');

export const NATIVE_BUILD_HINT = 'This needs the full app build (not Expo Go).';

/** Lines of text in a photo, or null when text reading is not available on this build/device. */
export async function readTextFromImage(uri: string): Promise<string[] | null> {
  if (!hasTextReader) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded lazily so Expo Go doesn't crash on startup
  const reader = require('expo-text-extractor') as typeof import('expo-text-extractor');
  if (!reader.isSupported) return null;
  return reader.extractTextFromImage(uri);
}

export type VoicePanelProps = { onText: (text: string) => void };

/** The microphone control, or null when speech recognition is not available. */
export function loadVoicePanel(): ComponentType<VoicePanelProps> | null {
  if (!hasSpeech) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded lazily so Expo Go doesn't crash on startup
  return (require('../components/VoicePanel') as typeof import('../components/VoicePanel')).default;
}
