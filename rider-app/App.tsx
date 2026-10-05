import { StatusBar } from 'expo-status-bar';
import { SafeAreaView, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Pressable, StatusBar as NativeStatusBar, Text, View } from 'react-native';
import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './src/lib/auth';
import { NavProvider, useNav, type TabName } from './src/lib/nav';
import { colors, spacing } from './src/lib/theme';
import Login from './src/screens/Login';
import Register from './src/screens/Register';
import Dashboard from './src/screens/Dashboard';
import DeliveriesList from './src/screens/DeliveriesList';
import RouteNavigation from './src/screens/RouteNavigation';
import DeliveryDetail from './src/screens/DeliveryDetail';
import AddManual from './src/screens/AddManual';
import ImportPdf from './src/screens/ImportPdf';
import History from './src/screens/History';
import Reports from './src/screens/Reports';
import SubscriptionScreen from './src/screens/Subscription';
import Account from './src/screens/Account';

const TABS: { key: TabName; label: string; icon: string }[] = [
  { key: 'home', label: 'Home', icon: '🏠' },
  { key: 'deliveries', label: 'Deliveries', icon: '📦' },
  { key: 'history', label: 'History', icon: '🕘' },
  { key: 'reports', label: 'Reports', icon: '📄' },
  { key: 'account', label: 'Account', icon: '👤' },
];

function ScreenRouter() {
  const { current, goBack } = useNav();
  const refresh = () => { /* screens reload their own data via useFocusEffect on remount */ };

  switch (current.name) {
    case 'Dashboard': return <Dashboard />;
    case 'DeliveriesList': return <DeliveriesList />;
    case 'RouteNavigation': return <RouteNavigation />;
    case 'DeliveryDetail': return <DeliveryDetail id={current.params!.id as string} onDone={() => { goBack(); refresh(); }} />;
    case 'AddManual': return <AddManual onCreated={refresh} />;
    case 'ImportPdf': return <ImportPdf onCreated={refresh} />;
    case 'History': return <History />;
    case 'Reports': return <Reports />;
    case 'SubscriptionScreen': return <SubscriptionScreen />;
    case 'Account': return <Account />;
    default: return <Dashboard />;
  }
}

function BackBar() {
  const { canGoBack, goBack } = useNav();
  if (!canGoBack) return null;
  return (
    <View style={{ paddingHorizontal: spacing(5), paddingTop: spacing(3), backgroundColor: colors.bg }}>
      <Pressable onPress={goBack} hitSlop={10}><Text style={{ color: colors.primary, fontWeight: '600', fontSize: 15 }}>← Back</Text></Pressable>
    </View>
  );
}

function TabBar() {
  const { tab, switchTab, resetTab } = useNav();
  return (
    <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: '#fff', paddingBottom: 4, paddingTop: 6 }}>
      {TABS.map((t) => (
        <Pressable
          key={t.key}
          onPress={() => { if (tab === t.key) resetTab(t.key); else switchTab(t.key); }}
          style={{ flex: 1, alignItems: 'center', paddingVertical: 6, gap: 2 }}
        >
          <View style={{ width: 22, height: 3, borderRadius: 2, backgroundColor: tab === t.key ? colors.primary : 'transparent' }} />
          <Text style={{ fontSize: 19 }}>{t.icon}</Text>
          <Text style={{ fontSize: 11, marginTop: 2, color: tab === t.key ? colors.primary : colors.muted, fontWeight: tab === t.key ? '700' : '500' }}>{t.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function AuthedApp() {
  const insets = useSafeAreaInsets();

  return (
    <NavProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
        <BackBar />
        <View style={{ flex: 1 }}>
          <ScreenRouter />
        </View>
        <TabBar />
      </SafeAreaView>
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
    NativeStatusBar.setBarStyle('dark-content');
    NativeStatusBar.setBackgroundColor(colors.bg);
  }, []);

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="dark" />
        <Gate />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
