import { useEffect, useState, type ComponentType } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { get } from '../lib/api';
import { updateNeeded } from '../lib/appVersion';
import type { PublicConfig } from '../lib/types';
import { LightButton } from './LightKit';
import { light as c } from '../lib/theme';

type Need = { level: 'required' | 'suggested'; storeUrl: string | null };

/**
 * Wraps the app: GET /config says which app versions the server still supports. Below `minAppVersion` the app shows only
 * "Update the app"; below `latestAppVersion` it suggests the update once per launch. Offline or on any error the app
 * simply opens, so a server problem never locks riders out.
 */
export function withUpdateGate<P extends object>(App: ComponentType<P>) {
  return function UpdateGate(props: P) {
    const [need, setNeed] = useState<Need | null>(null);

    useEffect(() => {
      let cancelled = false;
      get<PublicConfig>('/config')
        .then(({ data }) => {
          const level = updateNeeded(Constants.expoConfig?.version, data.minAppVersion, data.latestAppVersion);
          const storeUrl = (Platform.OS === 'ios' ? data.storeUrls?.ios : data.storeUrls?.android) ?? null;
          if (!cancelled && level !== 'none') setNeed({ level, storeUrl });
        })
        .catch(() => {});
      return () => { cancelled = true; };
    }, []);

    if (!need) return <App {...props} />;
    return <UpdateScreen need={need} onLater={need.level === 'suggested' ? () => setNeed(null) : undefined} />;
  };
}

function UpdateScreen({ need, onLater }: { need: Need; onLater?: () => void }) {
  const required = need.level === 'required';
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.screen}>
        <View style={s.body}>
          <View style={s.mark}><Ionicons name="arrow-up-circle-outline" size={56} color={c.ink} /></View>
          <Text style={s.title}>{required ? 'Update the app' : 'A new version is ready'}</Text>
          <Text style={s.text}>
            {required
              ? 'This version of the app no longer works with your routes. Update it to keep delivering.'
              : 'Update now for the latest fixes and faster routes.'}
          </Text>
        </View>
        {need.storeUrl ? (
          <LightButton title="Update" onPress={() => void Linking.openURL(need.storeUrl!)} style={{ alignSelf: 'stretch' }} />
        ) : (
          <Text style={s.hint}>Open the {Platform.OS === 'ios' ? 'App Store' : 'Play Store'} and update the app.</Text>
        )}
        {onLater ? <LightButton title="Later" variant="outline" onPress={onLater} style={{ alignSelf: 'stretch', marginTop: 12 }} /> : null}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background, paddingHorizontal: 24, paddingBottom: 24 },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  mark: { width: 96, height: 96, borderRadius: 48, backgroundColor: c.soft, alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  title: { color: c.text, fontSize: 24, fontWeight: '700', textAlign: 'center' },
  text: { color: c.textSecondary, fontSize: 16, lineHeight: 22, textAlign: 'center', marginTop: 12 },
  hint: { color: c.textSecondary, fontSize: 15, textAlign: 'center' },
});
