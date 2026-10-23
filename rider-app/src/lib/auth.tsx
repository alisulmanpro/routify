import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert } from 'react-native';
import { get, post, setAuthChangeHandler, setTokens, getTokens, onOnlineChange, ApiRequestError } from './api';
import { secureDelete, secureGet, secureSet } from './secureStorage';
import { forgetRider } from './revenuecat';
import type { User } from './types';

type AuthState = { user: User | null; loading: boolean };
type RegisterInput = { fullName: string; email: string; password: string; confirmPassword: string };
type AuthContextValue = AuthState & {
  login: (email: string, password: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

// The last profile the API returned, so an offline start keeps the rider signed in (P3.11). Cleared on sign-out.
const PROFILE_KEY = 'dp_rider_profile_v1';
const saveProfile = (user: User) => secureSet(PROFILE_KEY, JSON.stringify(user)).catch(() => {});
const forgetProfile = () => secureDelete(PROFILE_KEY).catch(() => {});
/** No answer (offline, timeout) or a server error: says nothing about the session, unlike 401/403. */
const unreachable = (err: unknown) => err instanceof TypeError || (err instanceof ApiRequestError && err.status >= 500);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: true });
  // True while the profile on screen is the saved copy (the API could not be reached): it is reloaded once online.
  const fromSavedCopy = useRef(false);

  const loadProfile = useCallback(async () => {
    try {
      const me = await get<User>('/auth/me');
      fromSavedCopy.current = false;
      setState({ user: me.data, loading: false });
      void saveProfile(me.data);
    } catch (err) {
      // Offline or the server is down: keep the rider signed in with the saved profile. A rejected session (401, which
      // also clears the tokens, or 403) still signs out.
      const saved = unreachable(err) && (await getTokens()) ? await secureGet(PROFILE_KEY).catch(() => null) : null;
      if (saved) {
        fromSavedCopy.current = true;
        setState({ user: JSON.parse(saved) as User, loading: false });
        return;
      }
      setState({ user: null, loading: false });
    }
  }, []);

  // Back online after starting from the saved profile: load the real one.
  useEffect(() => onOnlineChange((online) => { if (online && fromSavedCopy.current) void loadProfile(); }), [loadProfile]);

  useEffect(() => {
    setAuthChangeHandler((tokens) => {
      if (tokens) return;
      void forgetProfile();
      setState({ user: null, loading: false });
    });
    (async () => {
      const tokens = await getTokens();
      if (!tokens) { setState({ user: null, loading: false }); return; }
      await loadProfile();
    })();
    return () => setAuthChangeHandler(null);
  }, [loadProfile]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await post<{ user: User; accessToken: string; refreshToken: string }>('/auth/login', { email, password, client: 'mobile' });
    await setTokens({ accessToken: result.data.accessToken, refreshToken: result.data.refreshToken });
    void saveProfile(result.data.user);
    setState({ user: result.data.user, loading: false });
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    const result = await post<{ user: User; accessToken: string; refreshToken: string }>('/auth/register', input);
    await setTokens({ accessToken: result.data.accessToken, refreshToken: result.data.refreshToken });
    void saveProfile(result.data.user);
    setState({ user: result.data.user, loading: false });
  }, []);

  const userId = state.user?.id;
  const logout = useCallback(async () => {
    if (userId && !(await confirmUnsynced(userId))) return;
    await forgetRider();
    const tokens = await getTokens();
    try { await post('/auth/logout', { refreshToken: tokens?.refreshToken, client: 'mobile' }); } catch { /* clear locally regardless */ }
    await setTokens(null);
    setState({ user: null, loading: false });
  }, [userId]);

  const value = useMemo(() => ({ ...state, login, register, logout, refreshProfile: loadProfile }), [state, login, register, logout, loadProfile]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Signing out keeps this rider's outbox on the phone (it is sent at their next sign-in), but the rider should know
 * (ISSUE-22): with changes still waiting, ask first. Resolves true to go on.
 */
async function confirmUnsynced(userId: string): Promise<boolean> {
  let waiting = 0;
  try {
    // Loaded here: the outbox module imports the query client, which imports this file.
    const { outboxFor } = await import('./outbox');
    const summary = await outboxFor(userId).summary();
    waiting = summary.waiting + summary.needsAttention;
  } catch { /* no outbox (e.g. storage unavailable): nothing to warn about */ }
  if (!waiting) return true;
  return new Promise((resolve) => Alert.alert(
    'Changes not synced yet',
    `${waiting} change${waiting === 1 ? ' is' : 's are'} not synced yet. They will be sent the next time you sign in on this phone.`,
    [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Sign out', style: 'destructive', onPress: () => resolve(true) },
    ],
    { cancelable: true, onDismiss: () => resolve(false) },
  ));
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export { ApiRequestError };
