/**
 * Runs when the screen comes into view (and its cleanup when it leaves). Screens now stay mounted under the screens
 * opened on top of them, so this is what reloads their data on the way back. Pass a useCallback-wrapped effect.
 */
export { useFocusEffect } from '@react-navigation/native';
