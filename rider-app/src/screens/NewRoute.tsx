import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { KeyboardAwareScrollView } from '../components/KeyboardAware';
import DatePicker from '../components/DatePicker';
import { Screen } from '../components/Kit';
import { DARK_ON_PRIMARY, ErrorBanner, Header, IconCircle, PButton, PCard, PInput } from '../components/Premium';
import { get, ApiRequestError } from '../lib/api';
import { dayKey, dayLabel, todayKey } from '../lib/format';
import type { Route, RouteListItem } from '../lib/types';
import { useFocusEffect } from '../lib/useFocusEffect';
import { premium as c, premiumRadius as r } from '../lib/theme';
import { useNav } from '../lib/nav';

// Step 1 of Add route: name the route and pick its day: today, tomorrow or any later date. `initialDate` comes from
// Home when the rider adds a route for the day they are looking at.
export default function NewRoute({ initialDate }: { initialDate?: string }) {
  const { navigate } = useNav();
  const [name, setName] = useState('');
  const [date, setDate] = useState(() => (initialDate && initialDate > todayKey() ? initialDate : todayKey()));
  const [calendar, setCalendar] = useState(false);
  const [active, setActive] = useState<Route | null>(null);
  // The day's route that is planned but not started: planning another one for the same day replaces it.
  const [plannedFor, setPlannedFor] = useState<{ date: string; route: RouteListItem | null } | null>(null);
  const planned = plannedFor?.date === date ? plannedFor.route : null;
  const [error, setError] = useState('');

  // Only one route can be underway; another route for today can be planned once it is finished.
  useFocusEffect(useCallback(() => {
    get<Route | null>('/routes/current', { date: todayKey() })
      .then((res) => setActive(res.data?.status === 'active' ? res.data : null))
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Could not check your current route'));
  }, []));

  useEffect(() => {
    let current = true;
    get<RouteListItem[]>('/routes/by-date', { from: date, to: date })
      .then((res) => { if (current) setPlannedFor({ date, route: res.data.find((r) => r.status === 'planned') || null }); })
      .catch(() => { /* only a hint; the route can still be added */ });
    return () => { current = false; };
  }, [date]);

  const quick = [dayKey(0), dayKey(1)];
  const other = !quick.includes(date);

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
          {quick.map((key) => {
            const on = key === date;
            return (
              <Pressable key={key} onPress={() => { setDate(key); setCalendar(false); }} style={({ pressed }) => [s.day, on && s.dayOn, pressed && { opacity: 0.85 }]}>
                <Text style={{ color: on ? DARK_ON_PRIMARY : c.text, fontWeight: '800', fontSize: 13 }}>{dayLabel(key)}</Text>
              </Pressable>
            );
          })}
          <Pressable onPress={() => setCalendar((v) => !v)} style={({ pressed }) => [s.day, s.pick, other && s.dayOn, pressed && { opacity: 0.85 }]}>
            <Ionicons name="calendar-outline" size={15} color={other ? DARK_ON_PRIMARY : c.primary} />
            <Text style={{ color: other ? DARK_ON_PRIMARY : c.text, fontWeight: '800', fontSize: 13 }}>{other ? dayLabel(date) : 'Pick a date'}</Text>
          </Pressable>
        </ScrollView>
        {calendar ? <DatePicker value={date} onChange={(key) => { setDate(key); setCalendar(false); }} /> : null}

        {planned ? (
          <PCard style={{ marginTop: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <IconCircle icon="calendar-alert" />
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.text, fontWeight: '800', fontSize: 14 }}>{planned.name || 'A route'} is already planned for this day</Text>
                <Text style={{ color: c.textSecondary, fontSize: 12, marginTop: 2 }}>Planning a new route for this day replaces it. Its stops stay saved and can be added to the new route.</Text>
              </View>
            </View>
          </PCard>
        ) : null}

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
  pick: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
