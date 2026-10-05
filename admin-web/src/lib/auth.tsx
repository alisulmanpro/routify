import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { get, post, setAccessToken, setUnauthorizedHandler, ApiRequestError } from './api';
import type { AdminUser } from './types';

type AuthState = { user: AdminUser | null; loading: boolean; error: string | null };
type AuthContextValue = AuthState & { login: (email: string, password: string) => Promise<void>; logout: () => Promise<void> };

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: true, error: null });

  const clear = useCallback(() => {
    setAccessToken(null);
    setState({ user: null, loading: false, error: null });
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(clear);
    (async () => {
      try {
        const me = await get<AdminUser>('/auth/me');
        setState({ user: me.data, loading: false, error: null });
      } catch {
        setState({ user: null, loading: false, error: null });
      }
    })();
    return () => setUnauthorizedHandler(null);
  }, [clear]);

  const login = useCallback(async (email: string, password: string) => {
    setState((s) => ({ ...s, error: null }));
    try {
      const result = await post<{ user: AdminUser; accessToken: string }>('/auth/login', { email, password, client: 'web' });
      setAccessToken(result.data.accessToken);
      setState({ user: result.data.user, loading: false, error: null });
    } catch (error) {
      const message = error instanceof ApiRequestError ? error.message : 'Could not sign in';
      setState((s) => ({ ...s, error: message }));
      throw error;
    }
  }, []);

  const logout = useCallback(async () => {
    try { await post('/auth/logout', { client: 'web' }); } catch { /* clear locally regardless */ }
    clear();
  }, [clear]);

  const value = useMemo(() => ({ ...state, login, logout }), [state, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
