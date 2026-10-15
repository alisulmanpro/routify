import type { ComponentProps } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Screen } from '../components/Kit';
import { premium as c, premiumRadius as r, premiumShadow } from '../lib/theme';
import { useNav } from '../lib/nav';

type McIcon = ComponentProps<typeof MaterialCommunityIcons>['name'];

const OPTIONS: { screen: string; icon: McIcon; title: string; subtitle: string }[] = [
  { screen: 'CameraAdd', icon: 'camera', title: 'Add via camera', subtitle: 'Point at a parcel label. The address is read and checked on the map automatically' },
  { screen: 'ScanDelivery', icon: 'barcode-scan', title: 'Scan step by step', subtitle: 'Scan the address, then the parcel ID — QR codes, barcodes or printed text' },
  { screen: 'VoiceEntry', icon: 'microphone', title: 'Voice entry', subtitle: 'Say the address, parcel ID and details one by one' },
  { screen: 'AddManual', icon: 'file-document-edit-outline', title: 'Manual entry', subtitle: 'Type a single delivery' },
  { screen: 'ImportFile', icon: 'file-document', title: 'Import from file', subtitle: 'Pick a courier manifest — PDF, Word or Excel. We’ll pull out parcel IDs, addresses and customer details for you to review before adding them.' },
];

export default function AddDelivery() {
  const { navigate } = useNav();
  return (
    <Screen style={{ backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ padding: 18, gap: 14 }}>
        {OPTIONS.map((o) => (
          <Pressable key={o.screen} onPress={() => navigate(o.screen)} style={({ pressed }) => [s.card, pressed && { opacity: 0.9 }]}>
            <View style={s.icon}>
              <MaterialCommunityIcons name={o.icon} size={24} color={c.text} />
            </View>
            <View style={{ flex: 1, marginHorizontal: 14 }}>
              <Text style={s.title}>{o.title}</Text>
              <Text style={s.subtitle}>{o.subtitle}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={c.textSecondary} />
          </Pressable>
        ))}
      </ScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', padding: 16, borderRadius: r.large, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, ...premiumShadow },
  icon: { width: 48, height: 48, borderRadius: 24, backgroundColor: c.surfaceSoft, alignItems: 'center', justifyContent: 'center' },
  title: { color: c.text, fontSize: 15, fontWeight: '700' },
  subtitle: { color: c.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 3 },
});
