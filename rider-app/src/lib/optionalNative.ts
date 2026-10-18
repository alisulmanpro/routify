import { requireOptionalNativeModule } from 'expo';
import { NativeModules } from 'react-native';
import type { ComponentType } from 'react';

// Text reading and speech recognition are native modules that Expo Go does not ship.
// They are only loaded when present, so the app still runs in Expo Go (those two
// features fall back to typing) and works fully in a development or store build.

export const hasSpeech = !!requireOptionalNativeModule('ExpoSpeechRecognition');
const hasTextExtractor = !!requireOptionalNativeModule('ExpoTextExtractor');
// ML Kit reads labels best; builds made before it was added fall back to expo-text-extractor.
const hasMlKit = !!NativeModules.TextRecognition;
export const hasTextReader = hasMlKit || hasTextExtractor;

export const NATIVE_BUILD_HINT = 'This needs the full app build (not Expo Go).';

/** Lines of text in a photo, top to bottom, or null when text reading is not available on this build. */
export async function readTextFromImage(uri: string): Promise<string[] | null> {
  if (hasMlKit) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded lazily so builds without it don't crash on startup
    const TextRecognition = (require('@react-native-ml-kit/text-recognition') as typeof import('@react-native-ml-kit/text-recognition')).default;
    const result = await TextRecognition.recognize(uri);
    return result.blocks.flatMap((b) => b.lines.map((l) => l.text));
  }
  if (!hasTextExtractor) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded lazily so Expo Go doesn't crash on startup
  const reader = require('expo-text-extractor') as typeof import('expo-text-extractor');
  if (!reader.isSupported) return null;
  return (await reader.extractTextFromImage(uri)).flatMap((block) => block.split('\n'));
}

export type VoicePanelProps = { onText: (text: string) => void; compact?: boolean };

/** The microphone control, or null when speech recognition is not available. */
export function loadVoicePanel(): ComponentType<VoicePanelProps> | null {
  if (!hasSpeech) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded lazily so Expo Go doesn't crash on startup
  return (require('../components/VoicePanel') as typeof import('../components/VoicePanel')).default;
}
