import { requireOptionalNativeModule } from 'expo';
import { NativeModules } from 'react-native';
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

// ML Kit text recognition also says where each line is in the photo, so the camera's guide box can
// sit on the label. Builds made before it was added fall back to expo-text-extractor (text only).
export const hasTextBlocks = !!NativeModules.TextRecognition;

export type TextBlockFrame = { left: number; top: number; width: number; height: number };
export type TextBlock = { text: string; frame: TextBlockFrame | null; lines: { text: string; frame: TextBlockFrame | null; corners: { x: number; y: number }[] | null }[] };

/** Text blocks (with positions) in a photo, or null when ML Kit is not in this build. */
export async function readTextBlocks(uri: string): Promise<TextBlock[] | null> {
  if (!hasTextBlocks) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded lazily so older builds don't crash on startup
  const TextRecognition = (require('@react-native-ml-kit/text-recognition') as typeof import('@react-native-ml-kit/text-recognition')).default;
  const result = await TextRecognition.recognize(uri);
  return result.blocks.map((b) => ({ text: b.text, frame: b.frame ?? null, lines: b.lines.map((l) => ({ text: l.text, frame: l.frame ?? null, corners: l.cornerPoints ? [...l.cornerPoints] : null })) }));
}
