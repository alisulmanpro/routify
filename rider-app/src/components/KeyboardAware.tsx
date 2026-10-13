import { createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Keyboard, Platform, ScrollView, StyleSheet, TextInput, type KeyboardEvent, type TextInputProps, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewProps } from 'react-native';

/**
 * A ScrollView that keeps the focused input above the on-screen keyboard.
 *
 * Android apps are edge-to-edge now, so the window no longer shrinks when the keyboard opens and a plain
 * KeyboardAvoidingView leaves inputs underneath it. This adds the keyboard's height as extra scroll room and scrolls the
 * focused field into view, on open and whenever focus moves to another field. It only uses React Native's own Keyboard
 * API, so it works in Expo Go (react-native-keyboard-controller would need a development build).
 */

const GAP = 24; // space kept between the focused field and the top of the keyboard
const SHOW = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
const HIDE = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

const KeyboardAwareContext = createContext<() => void>(() => {});

/** Inputs call this from onFocus, so moving between fields while the keyboard is open keeps the new one visible. */
export const useRevealOnFocus = () => useContext(KeyboardAwareContext);

/** A plain TextInput that keeps itself above the keyboard when it gains focus inside a KeyboardAwareScrollView. */
export const RevealingTextInput = forwardRef<TextInput, TextInputProps>(function RevealingTextInput(props, ref) {
  const reveal = useRevealOnFocus();
  return <TextInput ref={ref} {...props} onFocus={(e) => { reveal(); props.onFocus?.(e); }} />;
});

export const KeyboardAwareScrollView = forwardRef<ScrollView, ScrollViewProps>(function KeyboardAwareScrollView(
  { contentContainerStyle, onScroll, children, ...props }, ref,
) {
  const scrollRef = useRef<ScrollView>(null);
  useImperativeHandle(ref, () => scrollRef.current as ScrollView);
  const offset = useRef(0);
  const keyboardTop = useRef<number | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const reveal = useCallback(() => {
    // Wait a frame so the extra bottom room exists before scrolling into it.
    setTimeout(() => {
      const input = TextInput.State.currentlyFocusedInput();
      const top = keyboardTop.current;
      if (!input || top == null) return;
      input.measureInWindow((_x, y, _w, height) => {
        const overlap = y + height + GAP - top;
        if (overlap > 0) scrollRef.current?.scrollTo({ y: offset.current + overlap, animated: true });
      });
    }, Platform.OS === 'ios' ? 0 : 60);
  }, []);

  useEffect(() => {
    const show = Keyboard.addListener(SHOW, (e: KeyboardEvent) => {
      keyboardTop.current = e.endCoordinates.screenY;
      setKeyboardHeight(e.endCoordinates.height);
      reveal();
    });
    const hide = Keyboard.addListener(HIDE, () => {
      keyboardTop.current = null;
      setKeyboardHeight(0);
    });
    return () => { show.remove(); hide.remove(); };
  }, [reveal]);

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = e.nativeEvent.contentOffset.y;
    onScroll?.(e);
  }, [onScroll]);

  const container = useMemo(() => {
    const flat = StyleSheet.flatten(contentContainerStyle) ?? {};
    const base = Number(flat.paddingBottom ?? flat.paddingVertical ?? flat.padding ?? 0);
    return [flat, { paddingBottom: base + keyboardHeight }];
  }, [contentContainerStyle, keyboardHeight]);

  return (
    <KeyboardAwareContext.Provider value={reveal}>
      <ScrollView ref={scrollRef} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        scrollEventThrottle={16} {...props} onScroll={handleScroll} contentContainerStyle={container}>
        {children}
      </ScrollView>
    </KeyboardAwareContext.Provider>
  );
});
