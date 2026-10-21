import { StatusBar } from 'expo-status-bar';
import { SafeAreaView, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { BackHandler, Platform, Pressable, StatusBar as NativeStatusBar, Text, View } from 'react-native';
import { useCallback, useEffect, useState } from 'react';
import * as SplashScreen from 'expo-splash-screen';
import { AuthProvider, useAuth } from './src/lib/auth';
import { NavProvider, useNav, type TabName } from './src/lib/nav';
import { ServiceAreaProvider } from './src/lib/serviceArea';
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

function ScreenRouter() {
  const { current, goBack } = useNav();
  const refresh = () => { /* screens reload their own data via useFocusEffect on remount */ };

  switch (current.name) {
    case 'Dashboard': return <Dashboard />;
    case 'RouteMapScreen': return <RouteMapScreen reveal={!!current.params?.reveal} routeId={current.params?.routeId as string | undefined} />;
    case 'NewRoute': return <NewRoute initialDate={current.params?.date as string | undefined} />;
    // The old route detail screen is replaced by Review stops for that route.
    case 'RouteDetail': return <RoutePreview routeId={current.params!.id as string} />;
    case 'AddStops': return <AddStops name={current.params!.name as string} date={current.params!.date as string} />;
    case 'RoutePreview': return <RoutePreview name={current.params?.name as string | undefined} date={current.params?.date as string | undefined} ids={current.params?.ids as string[] | undefined} routeId={current.params?.routeId as string | undefined} />;
    case 'LiveNavigation': return <LiveNavigation />;
    case 'DeliveryDetail': return <DeliveryDetail id={current.params!.id as string} initialStep={current.params?.step as 'proof' | 'fail' | undefined} onDone={() => { goBack(); refresh(); }} />;
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
  // Android's back button/gesture does the same as the Back bar.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { if (!canGoBack) return false; back(); return true; });
    return () => sub.remove();
  }, [canGoBack, back]);
  if (!canGoBack || LIGHT_SCREENS.has(current.name)) return null;
  return (
    <View style={{ paddingHorizontal: spacing(5), paddingTop: spacing(3), backgroundColor: colors.bg }}>
      <Pressable onPress={back} hitSlop={10} style={{ alignSelf: 'flex-start', backgroundColor: colors.surfaceRaised, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 99 }}><Text style={{ color: '#CFC5FF', fontWeight: '800', fontSize: 13 }}>‹  Back</Text></Pressable>
    </View>
  );
}

function TabBar() {
  const { tab, switchTab, resetTab } = useNav();
  return (
    <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: light.border, backgroundColor: light.background, paddingHorizontal: 8, paddingTop: 8, paddingBottom: 6 }}>
      {TABS.map((t) => {
        const active = tab === t.key;
        const color = active ? light.link : light.textSecondary;
        return (
          <Pressable
            key={t.key}
            onPress={() => { if (active) resetTab(t.key); else switchTab(t.key); }}
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

/** The safe area behind the status bar follows the screen: light for redesigned screens, dark navy for the rest. */
function Shell() {
  const insets = useSafeAreaInsets();
  const { current } = useNav();
  const isLight = LIGHT_SCREENS.has(current.name);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: isLight ? light.background : colors.bg, paddingTop: insets.top }}>
      <StatusBar style={isLight ? 'dark' : 'light'} />
      <BackBar />
      <View style={{ flex: 1 }}>
        <ScreenRouter />
      </View>
      <TabBar />
    </SafeAreaView>
  );
}

function AuthedApp() {
  const { user } = useAuth();
  // Purchases follow the Routify account, so RevenueCat knows the rider by their user id.
  useEffect(() => { if (user?.id) void identifyRider(user.id); }, [user?.id]);

  return (
    <NavProvider>
      <ServiceAreaProvider>
        <Shell />
      </ServiceAreaProvider>
    </NavProvider>
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
        <StatusBar style="light" />
        <Gate />
        <Splash />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
