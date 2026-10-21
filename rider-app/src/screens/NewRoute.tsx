import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { KeyboardAwareScrollView, useRevealOnFocus } from '../components/KeyboardAware';
import DatePicker from '../components/DatePicker';
import { Screen } from '../components/Kit';
import { LightButton, LightError } from '../components/LightKit';
import { get, ApiRequestError } from '../lib/api';
import { dayKey, defaultRouteName, fromDayKey, todayKey } from '../lib/format';
import { rememberRouteName } from '../lib/routeNames';
import type { Route } from '../lib/types';
import { useFocusEffect } from '../lib/useFocusEffect';
import { light as c, lightRadius as lr } from '../lib/theme';
import { useNav } from '../lib/nav';

// Step 1 of Add route: pick the route's day (today, tomorrow or any later date) and name it. `initialDate` comes from
// Home when the rider adds a route for the day they are looking at. A day can have several routes: a new route never
// replaces another one.
export default function NewRoute({ initialDate }: { initialDate?: string }) {
  const { navigate, goBack } = useNav();
  const [name, setName] = useState('');
  const [date, setDate] = useState(() => (initialDate && initialDate > todayKey() ? initialDate : todayKey()));
  const [calendar, setCalendar] = useState(false);
  const [active, setActive] = useState<Route | null>(null);
  const [error, setError] = useState('');

  // Only one route can be underway; another route for today can be planned once it is finished.
  useFocusEffect(useCallback(() => {
    get<Route | null>('/routes/current', { date: todayKey() })
      .then((res) => setActive(res.data?.status === 'active' ? res.data : null))
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Could not check your current route'));
  }, []));

  const today = dayKey(0);
  const tomorrow = dayKey(1);
  const picked = date !== today && date !== tomorrow;

  const fallback = defaultRouteName(date);
  const next = () => {
    const routeName = name.trim() || fallback;
    void rememberRouteName(date, routeName);
    navigate('AddStops', { name: routeName, date });
  };

  return (
    <Screen style={{ backgroundColor: c.background }}>
      <StatusBar style="dark" />
      <KeyboardAwareScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
        <Pressable onPress={goBack} hitSlop={12} accessibilityLabel="Back" style={{ alignSelf: 'flex-start' }}>
          <Ionicons name="arrow-back" size={26} color={c.text} />
        </Pressable>
        <Text style={s.title}>New route</Text>
        <Text style={s.subtitle}>Pick the day and give it a name. Planning tomorrow&apos;s route tonight saves time in the morning.</Text>
        <LightError text={error} />

        <Text style={s.label}>DAY</Text>
        <View style={s.tiles}>
          <DayTile top="Today" day={today} on={date === today} onPress={() => { setDate(today); setCalendar(false); }} />
          <DayTile top="Tomorrow" day={tomorrow} on={date === tomorrow} onPress={() => { setDate(tomorrow); setCalendar(false); }} />
          {picked ? (
            <DayTile top="Picked" day={date} on onPress={() => setCalendar((v) => !v)} />
          ) : (
            <Pressable onPress={() => setCalendar((v) => !v)} style={({ pressed }) => [s.tile, calendar && s.tileOpen, pressed && { opacity: 0.85 }]} accessibilityLabel="Pick a date">
              <Text style={s.tileTop}>Pick</Text>
              <Ionicons name="calendar-outline" size={28} color={c.text} style={{ marginTop: 6 }} />
            </Pressable>
          )}
        </View>
        {calendar ? <DatePicker light value={date} onChange={(key) => { setDate(key); setCalendar(false); }} /> : null}
        <Text style={s.chosen}>{fromDayKey(date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</Text>

        {active && date === todayKey() ? (
          <View style={s.notice}>
            <MaterialCommunityIcons name="progress-clock" size={20} color={c.warning} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.text, fontWeight: '600', fontSize: 15 }}>{active.name || 'A route'} is still underway</Text>
              <Text style={{ color: c.textSecondary, fontSize: 14, marginTop: 2, lineHeight: 20 }}>You can add stops now and plan them once it is finished, or pick Tomorrow.</Text>
            </View>
          </View>
        ) : null}

        <Text style={[s.label, { marginTop: 28 }]}>ROUTE NAME</Text>
        <NameField value={name} onChangeText={setName} placeholder={fallback} onSubmit={next} />
        <Text style={s.hint}>Optional, e.g. Ballsbridge run</Text>

        <Text style={[s.label, { marginTop: 28 }]}>START POINT</Text>
        <View style={s.row}>
          <MaterialCommunityIcons name="crosshairs-gps" size={24} color={c.text} />
          <Text style={s.rowText}>Current location</Text>
          {/* MISSING: see missing.md — the start is always the GPS position when the route is planned. */}
          <Pressable disabled accessibilityState={{ disabled: true }} hitSlop={8}>
            <Text style={[s.link, { opacity: 0.4 }]}>Change</Text>
          </Pressable>
        </View>
        <View style={s.divider} />
        {/* MISSING: see missing.md — there is no way to copy stops from another route yet. */}
        <Pressable disabled accessibilityState={{ disabled: true }} style={[s.row, { opacity: 0.4 }]}>
          <MaterialCommunityIcons name="content-copy" size={22} color={c.text} />
          <Text style={s.rowText}>Copy stops from a previous route</Text>
          <Ionicons name="chevron-forward" size={20} color={c.placeholder} />
        </Pressable>
      </KeyboardAwareScrollView>

      <View style={s.footer}>
        <LightButton title="Continue to stops" icon={<Ionicons name="arrow-forward" size={22} color={c.onInk} />} onPress={next} style={{ flexDirection: 'row-reverse' }} />
      </View>
    </Screen>
  );
}

function DayTile({ top, day, on, onPress }: { top: string; day: string; on: boolean; onPress: () => void }) {
  const d = fromDayKey(day);
  const fg = on ? c.onInk : c.text;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.tile, on && s.tileOn, pressed && { opacity: 0.85 }]} accessibilityRole="button" accessibilityState={{ selected: on }}>
      <Text style={[s.tileTop, { color: fg }]}>{top}</Text>
      <Text style={[s.tileDay, { color: fg }]}>{d.getDate()}</Text>
      <Text style={[s.tileWeek, { color: on ? c.onInk : c.textSecondary }]}>{d.toLocaleDateString(undefined, { weekday: 'short' })}</Text>
    </Pressable>
  );
}

function NameField({ value, onChangeText, placeholder, onSubmit }: { value: string; onChangeText: (v: string) => void; placeholder: string; onSubmit: () => void }) {
  const reveal = useRevealOnFocus();
  return (
    <View style={s.field}>
      <Ionicons name="flag-outline" size={22} color={c.textSecondary} />
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={c.placeholder} style={s.input}
        maxLength={80} returnKeyType="next" onSubmitEditing={onSubmit} onFocus={reveal} />
    </View>
  );
}

const s = StyleSheet.create({
  title: { color: c.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.5, marginTop: 28 },
  subtitle: { color: c.textSecondary, fontSize: 16, lineHeight: 23, marginTop: 10, marginBottom: 24 },
  label: { color: c.textSecondary, fontSize: 13, fontWeight: '600', letterSpacing: 1.2, marginBottom: 12 },
  tiles: { flexDirection: 'row', gap: 12 },
  tile: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 84, borderRadius: 18, backgroundColor: c.soft, paddingVertical: 10 },
  tileOn: { backgroundColor: c.ink },
  tileOpen: { backgroundColor: c.track },
  tileTop: { color: c.text, fontSize: 14, fontWeight: '500' },
  tileDay: { fontSize: 24, fontWeight: '800', marginTop: 2 },
  tileWeek: { fontSize: 13, marginTop: 2 },
  chosen: { color: c.textSecondary, fontSize: 15, marginTop: 14 },
  notice: { flexDirection: 'row', gap: 10, padding: 14, borderRadius: lr.field, backgroundColor: c.warningBg, marginTop: 16 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 16, borderRadius: lr.field, backgroundColor: c.soft },
  input: { flex: 1, color: c.text, fontSize: 17, paddingVertical: 12 },
  hint: { color: c.textSecondary, fontSize: 14, marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 10 },
  rowText: { flex: 1, color: c.text, fontSize: 17 },
  link: { color: c.link, fontSize: 17, fontWeight: '500' },
  divider: { height: 1, backgroundColor: c.border, marginVertical: 10 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 24, paddingTop: 12, paddingBottom: 14, backgroundColor: c.background, borderTopWidth: 1, borderTopColor: c.border },
});
