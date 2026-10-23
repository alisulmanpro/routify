import { Text, View } from 'react-native';
import { light as c } from '../../lib/theme';
import type { ConfirmMapProps } from './ConfirmMap.native';

// The native Google map is mobile-only; on web the confirm sheet shows a plain panel instead.
export default function ConfirmMap({ point, style }: ConfirmMapProps) {
  return (
    <View style={[{ backgroundColor: '#EEF0F3', alignItems: 'center', justifyContent: 'center' }, style]}>
      <Text style={{ color: c.textSecondary }}>{point ? `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}` : 'Map is available in the mobile app'}</Text>
    </View>
  );
}
