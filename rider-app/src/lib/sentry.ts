import * as Sentry from '@sentry/react-native';
import type { ComponentType } from 'react';

/**
 * Crash and error reporting (P0.8). On only in release builds with EXPO_PUBLIC_SENTRY_DSN set; no personal data
 * (no IPs, request bodies or screenshots). Without the DSN this does nothing, so builds without Sentry keep working.
 */
const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
const enabled = !!dsn && !__DEV__;

if (enabled) {
  Sentry.init({ dsn, sendDefaultPii: false, tracesSampleRate: 0.05, attachScreenshot: false });
}

export function withSentry<P extends Record<string, unknown>>(App: ComponentType<P>): ComponentType<P> {
  return enabled ? (Sentry.wrap(App as ComponentType<Record<string, unknown>>) as ComponentType<P>) : App;
}
