import { useEffect } from 'react';

/**
 * Our navigator keeps each tab's screens mounted only while active, so a plain
 * mount-effect already behaves like "on focus" — this just gives screens a
 * familiar name to call it by.
 */
export function useFocusEffect(effect: () => void | (() => void)) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(effect, []);
}
