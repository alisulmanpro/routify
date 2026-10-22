import { setStatusBarStyle, StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Platform, Pressable, StatusBar as NativeStatusBar, Text, View } from 'react-native';
import { useCallback, useEffect, useState } from 'react';
import * as SplashScreen from 'expo-splash-screen';
import { NavigationContainer, DefaultTheme, useFocusEffect } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator, type BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { AuthProvider, useAuth } from './src/lib/auth';
import { popTabToTop, TAB_ROOTS, TabContext, useNav, type TabName } from './src/lib/nav';
import { ServiceAreaProvider } from './src/lib/serviceArea';
import { QueryProvider } from './src/lib/query';
import { Ionicons } from '@expo/vector-icons';
import { colors, light, spacing } from './src/lib/theme';
import Login from './src/screens/Login';
import Register from './src/screens/Register';
import ForgotPassword from './src/screens/ForgotPassword';
import Onboarding from './src/screens/Onboarding';
import { onboardingDone } from './src/lib/permissions';
import { configureRevenueCat, identifyRider } from './src/lib/revenuecat';
import AnimatedSplash from './src/components/AnimatedSplash';

// Once per app launch (no-op in Expo Go or without a key).
configureRevenueCat();
// The native splash stays up until AnimatedSplash has drawn its first frame (it takes over seamlessly).
void SplashScreen.preventAutoHideAsync().catch(() => {});
import Dashboard from './src/screens/Dashboard';
import RouteMapScreen from './src/screens/RouteMapScreen';
import NewRoute from './src/screens/NewRoute';
import AddStops from './src/screens/AddStops';
import RoutePreview from './src/screens/RoutePreview';
import LiveNavigation from './src/screens/LiveNavigation';
import DeliveryDetail from './src/screens/DeliveryDetail';
import RouteComplete from './src/screens/RouteComplete';
import History from './src/screens/History';
import Reports from './src/screens/Reports';
import SubscriptionScreen from './src/screens/Subscription';
import Paywall from './src/screens/Paywall';
import Account from './src/screens/Account';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
const TABS: { key: TabName; label: string; icon: IconName }[] = [
  { key: 'home', label: 'Home', icon: 'home-outline' },
  { key: 'history', label: 'History', icon: 'time-outline' },
  { key: 'reports', label: 'Reports', icon: 'bar-chart-outline' },
  { key: 'account', label: 'Account', icon: 'person-outline' },
];

// Screens already redesigned on the light design_pref theme: the strip above them goes light too, and they draw their
// own back arrow, so the Back bar is hidden (the Android back button still works).
const LIGHT_SCREENS = new Set(['Dashboard', 'AddStops', 'NewRoute', 'RoutePreview', 'RouteMapScreen', 'DeliveryDetail', 'RouteComplete', 'LiveNavigation']);

// Every screen can be opened in any tab's stack (navigate() pushes onto the current tab), as with the old navigator.
const SCREENS = ['Dashboard', 'RouteMapScreen', 'NewRoute', 'RouteDetail', 'AddStops', 'RoutePreview', 'LiveNavigation', 'DeliveryDetail',
  'RouteComplete', 'History', 'Reports', 'SubscriptionScreen', 'Paywall', 'Account'] as const;

function ScreenRouter() {
  const { current, goBack } = useNav();

  switch (current.name) {
    case 'Dashboard': return <Dashboard />;
    case 'RouteMapScreen': return <RouteMapScreen reveal={!!current.params?.reveal} routeId={current.params?.routeId as string | undefined} />;
    case 'NewRoute': return <NewRoute initialDate={current.params?.date as string | undefined} />;
    // The old route detail screen is replaced by Review stops for that route.
    case 'RouteDetail': return <RoutePreview routeId={current.params!.id as string} />;
    case 'AddStops': return <AddStops name={current.params!.name as string} date={current.params!.date as string} routeId={current.params?.routeId as string | undefined} />;
    case 'RoutePreview': return <RoutePreview name={current.params?.name as string | undefined} date={current.params?.date as string | undefined} ids={current.params?.ids as string[] | undefined} routeId={current.params?.routeId as string | undefined} />;
    case 'LiveNavigation': return <LiveNavigation />;
    // The screens below stay mounted and reload on focus, so going back is enough.
    case 'DeliveryDetail': return <DeliveryDetail id={current.params!.id as string} initialStep={current.params?.step as 'proof' | 'fail' | undefined} onDone={goBack} />;
    case 'RouteComplete': return <RouteComplete routeId={current.params!.routeId as string} />;
    case 'History': return <History />;
    case 'Reports': return <Reports />;
    case 'SubscriptionScreen': return <SubscriptionScreen />;
    case 'Paywall': return <Paywall />;
    case 'Account': return <Account />;
    default: return <Dashboard />;
  }
}

function BackBar() {
  const { canGoBack, goBack: back, current } = useNav();
  // Android's back button/gesture is handled by the stack navigator itself.
  if (!canGoBack || LIGHT_SCREENS.has(current.name)) return null;
  return (
    <View style={{ paddingHorizontal: spacing(5), paddingTop: spacing(3), backgroundColor: colors.bg }}>
      <Pressable onPress={back} hitSlop={10} style={{ alignSelf: 'flex-start', backgroundColor: colors.surfaceRaised, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 99 }}><Text style={{ color: '#CFC5FF', fontWeight: '800', fontSize: 13 }}>‹  Back</Text></Pressable>
    </View>
  );
}

/** One screen of a stack: the safe area behind the status bar follows the screen (light for redesigned screens, dark navy for the rest). */
function ScreenHost() {
  const insets = useSafeAreaInsets();
  const { current } = useNav();
  const isLight = LIGHT_SCREENS.has(current.name);
  // Several screens stay mounted now, so the status bar follows whichever one is in view.
  useFocusEffect(useCallback(() => { setStatusBarStyle(isLight ? 'dark' : 'light'); }, [isLight]));
  return (
    <View style={{ flex: 1, backgroundColor: isLight ? light.background : colors.bg, paddingTop: insets.top }}>
      <BackBar />
      <View style={{ flex: 1 }}>
        <ScreenRouter />
      </View>
    </View>
  );
}

const Stack = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();

function TabStack({ tab }: { tab: TabName }) {
  return (
    <TabContext.Provider value={tab}>
      <Stack.Navigator initialRouteName={TAB_ROOTS[tab]} screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
        {SCREENS.map((name) => <Stack.Screen key={name} name={name} component={ScreenHost} />)}
      </Stack.Navigator>
    </TabContext.Provider>
  );
}

const HomeStack = () => <TabStack tab="home" />;
const HistoryStack = () => <TabStack tab="history" />;
const ReportsStack = () => <TabStack tab="reports" />;
const AccountStack = () => <TabStack tab="account" />;
const TAB_STACKS: Record<TabName, () => React.JSX.Element> = { home: HomeStack, history: HistoryStack, reports: ReportsStack, account: AccountStack };

function TabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const activeTab = state.routes[state.index].name;
  return (
    <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: light.border, backgroundColor: light.background, paddingHorizontal: 8, paddingTop: 8, paddingBottom: 6 + insets.bottom }}>
      {TABS.map((t) => {
        const active = activeTab === t.key;
        const color = active ? light.link : light.textSecondary;
        return (
          <Pressable
            key={t.key}
            // Tapping the open tab takes it back to its first screen; another tab opens where it was left.
            onPress={() => { if (active) popTabToTop(navigation.dispatch, state, t.key); else navigation.navigate(t.key); }}
            style={{ flex: 1, alignItems: 'center', paddingVertical: 6 }}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
          >
            <Ionicons name={t.icon} size={24} color={color} />
            <Text numberOfLines={1} style={{ fontSize: 12, marginTop: 3, color, fontWeight: active ? '600' : '500' }}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const THEME = { ...DefaultTheme, colors: { ...DefaultTheme.colors, background: light.background } };

function AuthedApp() {
  const { user } = useAuth();
  // Purchases follow the Routify account, so RevenueCat knows the rider by their user id.
  useEffect(() => { if (user?.id) void identifyRider(user.id); }, [user?.id]);

  return (
    <NavigationContainer theme={THEME}>
      <ServiceAreaProvider>
        {/* Tabs stay mounted once opened; Back never switches tabs (as before). */}
        <Tabs.Navigator backBehavior="none" screenOptions={{ headerShown: false }} tabBar={(props) => <TabBar {...props} />}>
          {TABS.map((t) => <Tabs.Screen key={t.key} name={t.key} component={TAB_STACKS[t.key]} />)}
        </Tabs.Navigator>
      </ServiceAreaProvider>
    </NavigationContainer>
  );
}

function Gate() {
  const { user, loading } = useAuth();
  const [screen, setScreen] = useState<'login' | 'register' | 'forgot'>('login');
  const [resetEmail, setResetEmail] = useState('');
  const insets = useSafeAreaInsets();

  // Permission onboarding shows once per device, after the first sign-in (null while the flag is being read).
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  useEffect(() => { void onboardingDone().then(setOnboarded); }, []);
  const finishOnboarding = useCallback(() => setOnboarded(true), []);

  // AnimatedSplash covers the screen while the session is restored.
  if (loading || (user && onboarded === null)) return <View style={{ flex: 1, backgroundColor: light.background, paddingTop: insets.top }} />;
  if (user && !onboarded) return <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: light.background }}><Onboarding onDone={finishOnboarding} /></View>;
  if (user) return <AuthedApp />;
  if (screen === 'forgot') return <ForgotPassword initialEmail={resetEmail} onBack={() => setScreen('login')} />;
  return screen === 'login'
    ? <Login onGoRegister={() => setScreen('register')} onForgot={(email) => { setResetEmail(email); setScreen('forgot'); }} />
    : <Register onGoLogin={() => setScreen('login')} />;
}

function Splash() {
  const { loading } = useAuth();
  const [done, setDone] = useState(false);
  const finish = useCallback(() => setDone(true), []);
  return done ? null : <AnimatedSplash ready={!loading} onFinish={finish} />;
}

export default function App() {
  useEffect(() => {
    NativeStatusBar.setBarStyle('light-content');
    // The status bar background colour is Android-only; iOS shows the app's background through it.
    if (Platform.OS === 'android') NativeStatusBar.setBackgroundColor(colors.bg);
  }, []);

  return (
    <SafeAreaProvider>
      <AuthProvider>
        {/* Saved server data (Home, routes) survives restarts, so screens draw at once and refresh in the background. */}
        <QueryProvider>
          <StatusBar style="light" />
          <Gate />
          <Splash />
        </QueryProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
