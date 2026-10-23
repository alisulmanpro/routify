import { Platform, type TextInputProps } from 'react-native';

const IOS = Platform.OS === 'ios';

/**
 * iOS: no autofill at all. Accepting an iOS suggestion ("Strong Password", saved logins) painted the box yellow and
 * locked it. "none" stops suggestions on normal boxes; password boxes use "oneTimeCode", the one content type for
 * which iOS never offers saved or generated passwords. Android keeps autofill (see AUTOFILL below).
 */
export function iosNoAutofill(secure?: boolean): Partial<TextInputProps> {
  if (!IOS) return {};
  return { autoComplete: 'off', textContentType: secure ? 'oneTimeCode' : 'none' };
}

/**
 * Autofill hints for the account forms. Android fills saved names, emails and passwords; the yellow highlight it draws
 * over autofilled boxes is restyled in plugins/withAutofillHighlight.js so the text stays visible. On iOS these resolve
 * to "no autofill".
 */
export const AUTOFILL = {
  name: IOS ? iosNoAutofill() : { autoComplete: 'name' },
  email: IOS ? iosNoAutofill() : { autoComplete: 'email' },
  password: IOS ? iosNoAutofill(true) : { autoComplete: 'current-password' },
  newPassword: IOS ? iosNoAutofill(true) : { autoComplete: 'new-password' },
  oneTimeCode: IOS ? iosNoAutofill() : { autoComplete: 'one-time-code' },
} satisfies Record<string, Partial<TextInputProps>>;
