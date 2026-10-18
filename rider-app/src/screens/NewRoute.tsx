import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from '../components/KeyboardAware';
import { Screen } from '../components/Kit';
import { DARK_ON_PRIMARY, ErrorBanner, Header, IconCircle, PButton, PCard, PInput } from '../components/Premium';
import { get, ApiRequestError } from '../lib/api';
import { dayKey, dayLabel, todayKey } from '../lib/format';
import type { Route } from '../lib/types';
import { useFocusEffect } from '../lib/useFocusEffect';
import { premium as c, premiumRadius as r } from '../lib/theme';
import { useNav } from '../lib/nav';

// Today, tomorrow and the rest of the coming week.
const DAYS = Array.from({ length: 8 }, (_, i) => dayKey(i));

// Step 1 of Add route: name the route and pick its day (e.g. plan tomorrow's route the night before).
export default function NewRoute() {
  const { navigate } = useNav();
  const [name, setName] = useState('');
  const [date, setDate] = useState(() => (new Date().getHours() >= 18 ? dayKey(1) : dayKey(0)));
  const [active, setActive] = useState<Route | null>(null);
  const [error, setError] = useState('');

  // Only one route can be underway; another route for today can be planned once it is finished.
  useFocusEffect(useCallback(() => {
    get<Route | null>('/routes/current', { date: todayKey() })
      .then((res) => setActive(res.data?.status === 'active' ? res.data : null))
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Could not check your current route'));
  }, []));

  // A date, not "Tomorrow": the name is kept after that day comes.
  const fallback = `Route · ${new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`;
  const next = () => navigate('AddStops', { name: name.trim() || fallback, date });

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <KeyboardAwareScrollView contentContainerStyle={{ padding: 18, paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
        <Header eyebrow="Add route" eyebrowIcon="map-marker-path" title="New route" subtitle="Name it and pick the day. Planning tomorrow's route tonight saves time in the morning." />
        <ErrorBanner text={error} />

        <Text style={s.label}>DAY</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 4 }}>
          {DAYS.map((key) => {
            const on = key === date;
            return (
              <Pressable key={key} onPress={() => setDate(key)} style={({ pressed }) => [s.day, on && s.dayOn, pressed && { opacity: 0.85 }]}>
                <Text style={{ color: on ? DARK_ON_PRIMARY : c.text, fontWeight: '800', fontSize: 13 }}>{dayLabel(key)}</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {active && date === todayKey() ? (
          <PCard accent style={{ marginTop: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <IconCircle icon="progress-clock" />
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.text, fontWeight: '800', fontSize: 14 }}>{active.name || 'A route'} is still underway</Text>
                <Text style={{ color: c.textSecondary, fontSize: 12, marginTop: 2 }}>You can add stops now and plan them once it is finished, or pick Tomorrow.</Text>
              </View>
            </View>
          </PCard>
        ) : null}

        <Text style={[s.label, { marginTop: 18 }]}>ROUTE NAME</Text>
        <PInput icon="flag-outline" placeholder={fallback} value={name} onChangeText={setName} maxLength={80} returnKeyType="next" onSubmitEditing={next} />
        <PButton title="Continue to stops" icon="arrow-forward" onPress={next} chevron style={{ marginTop: 18 }} />
      </KeyboardAwareScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  label: { color: c.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 8 },
  day: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: r.pill, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  dayOn: { backgroundColor: c.primary, borderColor: c.primary },
});
