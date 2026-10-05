import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type TabName = 'home' | 'deliveries' | 'history' | 'reports' | 'account';
type Route = { name: string; params?: Record<string, unknown> };
type NavState = Record<TabName, Route[]>;

type NavContextValue = {
  tab: TabName;
  current: Route;
  canGoBack: boolean;
  switchTab: (tab: TabName) => void;
  navigate: (name: string, params?: Record<string, unknown>) => void;
  goBack: () => void;
  resetTab: (tab: TabName) => void;
};

const TAB_ROOTS: Record<TabName, string> = { home: 'Dashboard', deliveries: 'DeliveriesList', history: 'History', reports: 'Reports', account: 'Account' };
const NavContext = createContext<NavContextValue | null>(null);

export function NavProvider({ children }: { children: ReactNode }) {
  const [tab, setTab] = useState<TabName>('home');
  const [stacks, setStacks] = useState<NavState>({
    home: [{ name: 'Dashboard' }], deliveries: [{ name: 'DeliveriesList' }], history: [{ name: 'History' }], reports: [{ name: 'Reports' }], account: [{ name: 'Account' }],
  });

  const switchTab = useCallback((next: TabName) => setTab(next), []);
  const resetTab = useCallback((t: TabName) => setStacks((s) => ({ ...s, [t]: [{ name: TAB_ROOTS[t] }] })), []);
  const navigate = useCallback((name: string, params?: Record<string, unknown>) => {
    setStacks((s) => ({ ...s, [tab]: [...s[tab], { name, params }] }));
  }, [tab]);
  const goBack = useCallback(() => {
    setStacks((s) => (s[tab].length > 1 ? { ...s, [tab]: s[tab].slice(0, -1) } : s));
  }, [tab]);

  const stack = stacks[tab];
  const value = useMemo<NavContextValue>(() => ({
    tab, current: stack[stack.length - 1], canGoBack: stack.length > 1, switchTab, navigate, goBack, resetTab,
  }), [tab, stack, switchTab, navigate, goBack, resetTab]);

  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav() {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error('useNav must be used within NavProvider');
  return ctx;
}
