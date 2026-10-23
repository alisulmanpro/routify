import { createContext, useCallback, useContext, useMemo } from 'react';
import { CommonActions, StackActions, useNavigation, useNavigationState, useRoute, type NavigationProp, type ParamListBase } from '@react-navigation/native';

export type TabName = 'home' | 'history' | 'reports' | 'account';
type Route = { name: string; params?: Record<string, unknown> };

export const TAB_ROOTS: Record<TabName, string> = { home: 'Dashboard', history: 'History', reports: 'Reports', account: 'Account' };

/** Which tab a stack belongs to; provided by each tab's stack navigator in App.tsx. */
export const TabContext = createContext<TabName>('home');

type NavContextValue = {
  tab: TabName;
  current: Route;
  canGoBack: boolean;
  switchTab: (tab: TabName) => void;
  navigate: (name: string, params?: Record<string, unknown>) => void;
  goBack: () => void;
  /** Takes a tab back to its first screen. */
  resetTab: (tab: TabName) => void;
  /** Replaces the current tab's history with its root plus this screen, so Back skips the flow that led here. */
  resetTo: (name: string, params?: Record<string, unknown>) => void;
};

type TabsState = { routes: readonly { name: string; state?: { key?: string; index?: number } }[] };

/** Pops a tab's stack back to its first screen, given the tab navigator's dispatch and state. */
export function popTabToTop(dispatch: NavigationProp<ParamListBase>['dispatch'], tabs: TabsState, tab: TabName) {
  const stack = tabs.routes.find((r) => r.name === tab)?.state;
  if (stack?.key && (stack.index ?? 0) > 0) dispatch({ ...StackActions.popToTop(), target: stack.key });
}

/**
 * The app's navigation API, on top of React Navigation: every tab is a native stack, so screens under the top one stay
 * mounted (going back shows them as they were) and each tab keeps its own history. Same calls as the earlier
 * hand-written navigator, so screens did not change.
 */
export function useNav(): NavContextValue {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const route = useRoute();
  const tab = useContext(TabContext);
  const canGoBack = useNavigationState((state) => state.index > 0);

  const tabNav = useCallback(() => navigation.getParent<NavigationProp<ParamListBase>>(), [navigation]);
  const switchTab = useCallback((next: TabName) => tabNav()?.navigate(next), [tabNav]);
  const resetTab = useCallback((t: TabName) => {
    const parent = tabNav();
    if (parent) popTabToTop(parent.dispatch, parent.getState(), t);
  }, [tabNav]);
  // Always a new screen on top, like before (the same screen may be open twice, e.g. two stops' details).
  const navigate = useCallback((name: string, params?: Record<string, unknown>) => navigation.dispatch(StackActions.push(name, params)), [navigation]);
  const goBack = useCallback(() => { if (navigation.canGoBack()) navigation.goBack(); }, [navigation]);
  const resetTo = useCallback((name: string, params?: Record<string, unknown>) => {
    navigation.dispatch(CommonActions.reset({ index: 1, routes: [{ name: TAB_ROOTS[tab] }, { name, params }] }));
  }, [navigation, tab]);

  return useMemo<NavContextValue>(() => ({
    tab, current: { name: route.name, params: route.params as Record<string, unknown> | undefined }, canGoBack, switchTab, navigate, goBack, resetTab, resetTo,
  }), [tab, route.name, route.params, canGoBack, switchTab, navigate, goBack, resetTab, resetTo]);
}
