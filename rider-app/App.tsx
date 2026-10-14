import { StatusBar } from 'expo-status-bar';
import { SafeAreaView, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Platform, Pressable, StatusBar as NativeStatusBar, Text, View } from 'react-native';
import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './src/lib/auth';
import { NavProvider, useNav, type TabName } from './src/lib/nav';
import { ServiceAreaProvider } from './src/lib/serviceArea';
import { Ionicons } from '@expo/vector-icons';
import { colors, premium, spacing } from './src/lib/theme';
import Login from './src/screens/Login';
import Register from './src/screens/Register';
import ForgotPassword from './src/screens/ForgotPassword';
import { configureRevenueCat, identifyRider } from './src/lib/revenuecat';

// Once per app launch (no-op in Expo Go or without a key).
configureRevenueCat();
import Dashboard from './src/screens/Dashboard';
import DeliveriesList from './src/screens/DeliveriesList';
import RouteNavigation from './src/screens/RouteNavigation';
import DeliveryDetail from './src/screens/DeliveryDetail';
import AddDelivery from './src/screens/AddDelivery';
import AddManual from './src/screens/AddManual';
import ImportFile from './src/screens/ImportFile';
import ScanDelivery from './src/screens/ScanDelivery';
import VoiceEntry from './src/screens/VoiceEntry';
import History from './src/screens/History';
import Reports from './src/screens/Reports';
import SubscriptionScreen from './src/screens/Subscription';
import Paywall from './src/screens/Paywall';
import Account from './src/screens/Account';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
const TABS: { key: TabName; label: string; icon: IconName; activeIcon: IconName }[] = [
  { key: 'home', label: 'Home', icon: 'home-outline', activeIcon: 'home' },
  { key: 'deliveries', label: 'Deliveries', icon: 'cube-outline', activeIcon: 'cube' },
  { key: 'history', label: 'History', icon: 'time-outline', activeIcon: 'time' },
  { key: 'reports', label: 'Reports', icon: 'reader-outline', activeIcon: 'reader' },
  { key: 'account', label: 'Account', icon: 'person-outline', activeIcon: 'person' },
];

function ScreenRouter() {
  const { current, goBack } = useNav();
  const refresh = () => { /* screens reload their own data via useFocusEffect on remount */ };

  switch (current.name) {
    case 'Dashboard': return <Dashboard />;
    case 'DeliveriesList': return <DeliveriesList />;
    case 'RouteNavigation': return <RouteNavigation />;
    case 'DeliveryDetail': return <DeliveryDetail id={current.params!.id as string} onDone={() => { goBack(); refresh(); }} />;
    case 'AddDelivery': return <AddDelivery />;
    case 'AddManual': return <AddManual onCreated={refresh} />;
    case 'ImportFile': return <ImportFile onCreated={refresh} />;
    case 'ScanDelivery': return <ScanDelivery onCreated={refresh} />;
    case 'VoiceEntry': return <VoiceEntry onCreated={refresh} />;
    case 'History': return <History />;
    case 'Reports': return <Reports />;
    case 'SubscriptionScreen': return <SubscriptionScreen />;
    case 'Paywall': return <Paywall />;
    case 'Account': return <Account />;
    default: return <Dashboard />;
  }
}

function BackBar() {
  const { canGoBack, goBack } = useNav();
  if (!canGoBack) return null;
  return (
    <View style={{ paddingHorizontal: spacing(5), paddingTop: spacing(3), backgroundColor: colors.bg }}>
      <Pressable onPress={goBack} hitSlop={10} style={{ alignSelf: 'flex-start', backgroundColor: colors.surfaceRaised, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 99 }}><Text style={{ color: '#CFC5FF', fontWeight: '800', fontSize: 13 }}>‹  Back</Text></Pressable>
    </View>
  );
}

function TabBar() {
  const { tab, switchTab, resetTab } = useNav();
  return (
    <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: premium.border, backgroundColor: premium.surface, paddingHorizontal: 8, paddingVertical: 8 }}>
      {TABS.map((t) => {
        const active = tab === t.key;
        return (
          <Pressable
            key={t.key}
            onPress={() => { if (active) resetTab(t.key); else switchTab(t.key); }}
            style={{ flex: 1, alignItems: 'center', paddingVertical: 8, marginHorizontal: 3, borderRadius: 18, backgroundColor: active ? 'rgba(255,170,50,0.16)' : 'transparent' }}
          >
            <Ionicons name={active ? t.activeIcon : t.icon} size={21} color={active ? premium.primary : premium.textSecondary} />
            <Text numberOfLines={1} style={{ fontSize: 10, marginTop: 2, color: active ? premium.primary : premium.textSecondary, fontWeight: active ? '800' : '600' }}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function AuthedApp() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  // Purchases follow the Routify account, so RevenueCat knows the rider by their user id.
  useEffect(() => { if (user?.id) void identifyRider(user.id); }, [user?.id]);

  return (
    <NavProvider>
      <ServiceAreaProvider>
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
          <BackBar />
          <View style={{ flex: 1 }}>
            <ScreenRouter />
          </View>
          <TabBar />
        </SafeAreaView>
      </ServiceAreaProvider>
    </NavProvider>
  );
}

function Gate() {
  const { user, loading } = useAuth();
  const [screen, setScreen] = useState<'login' | 'register' | 'forgot'>('login');
  const [resetEmail, setResetEmail] = useState('');
  const insets = useSafeAreaInsets();

  if (loading) return <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', paddingTop: insets.top }}><Text style={{ color: colors.muted }}>Loading…</Text></SafeAreaView>;
  if (user) return <AuthedApp />;
  if (screen === 'forgot') return <ForgotPassword initialEmail={resetEmail} onBack={() => setScreen('login')} />;
  return screen === 'login'
    ? <Login onGoRegister={() => setScreen('register')} onForgot={(email) => { setResetEmail(email); setScreen('forgot'); }} />
    : <Register onGoLogin={() => setScreen('login')} />;
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
      </AuthProvider>
    </SafeAreaProvider>
  );
}
