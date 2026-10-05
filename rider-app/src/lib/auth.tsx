import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { get, post, setAuthChangeHandler, setTokens, getTokens, ApiRequestError } from './api';
import type { User, Currency } from './types';

type AuthState = { user: User | null; loading: boolean };
type RegisterInput = { fullName: string; phone: string; email: string; password: string; confirmPassword: string; currency: Currency };
type AuthContextValue = AuthState & {
  login: (email: string, password: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: true });

  const loadProfile = useCallback(async () => {
    try {
      const me = await get<User>('/auth/me');
      setState({ user: me.data, loading: false });
    } catch {
      setState({ user: null, loading: false });
    }
  }, []);

  useEffect(() => {
    setAuthChangeHandler((tokens) => { if (!tokens) setState({ user: null, loading: false }); });
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
    setState({ user: result.data.user, loading: false });
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    const result = await post<{ user: User; accessToken: string; refreshToken: string }>('/auth/register', input);
    await setTokens({ accessToken: result.data.accessToken, refreshToken: result.data.refreshToken });
    setState({ user: result.data.user, loading: false });
  }, []);

  const logout = useCallback(async () => {
    const tokens = await getTokens();
    try { await post('/auth/logout', { refreshToken: tokens?.refreshToken, client: 'mobile' }); } catch { /* clear locally regardless */ }
    await setTokens(null);
    setState({ user: null, loading: false });
  }, []);

  const value = useMemo(() => ({ ...state, login, register, logout, refreshProfile: loadProfile }), [state, login, register, logout, loadProfile]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export { ApiRequestError };
