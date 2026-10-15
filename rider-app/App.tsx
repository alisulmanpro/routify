import { StatusBar } from 'expo-status-bar';
import { SafeAreaView, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { BackHandler, Platform, Pressable, StatusBar as NativeStatusBar, Text, View } from 'react-native';
import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './src/lib/auth';
import { NavProvider, useNav, type TabName } from './src/lib/nav';
import { ServiceAreaProvider } from './src/lib/serviceArea';
import { Ionicons } from '@expo/vector-icons';
import { colors, premium, spacing } from './src/lib/theme';
import Login from './src/screens/Login';
import Register from './src/screens/Register';
import Dashboard from './src/screens/Dashboard';
import DeliveriesList from './src/screens/DeliveriesList';
import RouteMapScreen from './src/screens/RouteMapScreen';
import DeliveryDetail from './src/screens/DeliveryDetail';
import AddDelivery from './src/screens/AddDelivery';
import AddManual from './src/screens/AddManual';
import ImportFile from './src/screens/ImportFile';
import ScanDelivery from './src/screens/ScanDelivery';
import CameraAdd from './src/screens/CameraAdd';
import VoiceEntry from './src/screens/VoiceEntry';
import History from './src/screens/History';
import Reports from './src/screens/Reports';
import SubscriptionScreen from './src/screens/Subscription';
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
    case 'RouteMapScreen': return <RouteMapScreen />;
    case 'DeliveryDetail': return <DeliveryDetail id={current.params!.id as string} onDone={() => { goBack(); refresh(); }} />;
    case 'AddDelivery': return <AddDelivery />;
    case 'AddManual': return <AddManual onCreated={refresh} />;
    case 'ImportFile': return <ImportFile onCreated={refresh} />;
    case 'ScanDelivery': return <ScanDelivery onCreated={refresh} />;
    case 'CameraAdd': return <CameraAdd onCreated={refresh} />;
    case 'VoiceEntry': return <VoiceEntry onCreated={refresh} />;
    case 'History': return <History />;
    case 'Reports': return <Reports />;
    case 'SubscriptionScreen': return <SubscriptionScreen />;
    case 'Account': return <Account />;
    default: return <Dashboard />;
  }
}

// Screens whose Back leaves the add-deliveries flow for the Deliveries list (all route stops).
const BACK_TO_DELIVERIES = new Set(['CameraAdd']);

function useBack() {
  const { current, canGoBack, goBack, openDeliveries } = useNav();
  return { canGoBack, back: BACK_TO_DELIVERIES.has(current.name) ? openDeliveries : goBack };
}

function BackBar() {
  const { canGoBack, back } = useBack();
  // Android's back button/gesture does the same as the Back bar.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { if (!canGoBack) return false; back(); return true; });
    return () => sub.remove();
  }, [canGoBack, back]);
  if (!canGoBack) return null;
  return (
    <View style={{ paddingHorizontal: spacing(5), paddingTop: spacing(3), backgroundColor: colors.bg }}>
      <Pressable onPress={back} hitSlop={10} style={{ alignSelf: 'flex-start', backgroundColor: colors.surfaceRaised, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 99 }}><Text style={{ color: '#CFC5FF', fontWeight: '800', fontSize: 13 }}>‹  Back</Text></Pressable>
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
  const [screen, setScreen] = useState<'login' | 'register'>('login');
  const insets = useSafeAreaInsets();

  if (loading) return <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', paddingTop: insets.top }}><Text style={{ color: colors.muted }}>Loading…</Text></SafeAreaView>;
  if (user) return <AuthedApp />;
  return screen === 'login' ? <Login onGoRegister={() => setScreen('register')} /> : <Register onGoLogin={() => setScreen('login')} />;
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
