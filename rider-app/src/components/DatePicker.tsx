import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { DARK_ON_PRIMARY } from './Premium';
import { fromDayKey, toDayKey, todayKey } from '../lib/format';
import { premium as c, premiumRadius as r } from '../lib/theme';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** A month calendar in plain JS (no native date picker, so it works on every build). Days before `min` can't be picked. */
export default function DatePicker({ value, onChange, min = todayKey() }: { value: string; onChange: (key: string) => void; min?: string }) {
  const [month, setMonth] = useState(() => {
    const d = fromDayKey(value);
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const minMonth = new Date(fromDayKey(min).getFullYear(), fromDayKey(min).getMonth(), 1);
  const canGoBack = month > minMonth;

  // Monday-first grid: blanks before the 1st, then every day of the month.
  const lead = (month.getDay() + 6) % 7;
  const length = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length }, (_, i) => toDayKey(new Date(month.getFullYear(), month.getMonth(), i + 1))),
  ];
  const today = todayKey();
  const shift = (by: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + by, 1));

  return (
    <View style={s.box}>
      <View style={s.head}>
        <Pressable onPress={() => shift(-1)} disabled={!canGoBack} hitSlop={10} style={[s.arrow, !canGoBack && { opacity: 0.3 }]} accessibilityLabel="Previous month">
          <Ionicons name="chevron-back" size={18} color={c.text} />
        </Pressable>
        <Text style={s.month}>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</Text>
        <Pressable onPress={() => shift(1)} hitSlop={10} style={s.arrow} accessibilityLabel="Next month">
          <Ionicons name="chevron-forward" size={18} color={c.text} />
        </Pressable>
      </View>
      <View style={s.grid}>
        {WEEKDAYS.map((w) => <Text key={w} style={[s.cell, s.weekday]}>{w}</Text>)}
        {cells.map((key, i) => {
          if (!key) return <View key={`blank-${i}`} style={s.cell} />;
          const past = key < min;
          const on = key === value;
          return (
            <Pressable key={key} onPress={() => onChange(key)} disabled={past} style={s.cell} accessibilityLabel={fromDayKey(key).toDateString()}>
              <View style={[s.day, key === today && s.today, on && s.dayOn]}>
                <Text style={{ color: on ? DARK_ON_PRIMARY : past ? c.textMuted : c.text, fontWeight: on ? '800' : '600', fontSize: 13 }}>{Number(key.slice(8))}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  box: { marginTop: 10, padding: 12, borderRadius: r.medium, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  arrow: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surfaceSoft },
  month: { color: c.text, fontWeight: '800', fontSize: 15 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, alignItems: 'center', paddingVertical: 3 },
  weekday: { color: c.textSecondary, fontSize: 11, fontWeight: '700', paddingVertical: 6 },
  day: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  today: { borderWidth: 1, borderColor: c.primary },
  dayOn: { backgroundColor: c.primary, borderColor: c.primary },
});
