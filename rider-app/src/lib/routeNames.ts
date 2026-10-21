import AsyncStorage from '@react-native-async-storage/async-storage';
import { todayKey } from './format';

// The name typed on New route is only sent when the route is planned (Review route). If the rider plans those stops
// another way (e.g. Plan route on Home), the name is remembered here per day so it is not lost.
const KEY = 'dp_route_names_v1';
type Names = Record<string, string>;

async function read(): Promise<Names> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Names) : {};
  } catch {
    return {};
  }
}

async function write(names: Names) {
  // Past days are never planned again, so they are dropped.
  const today = todayKey();
  const kept = Object.fromEntries(Object.entries(names).filter(([day]) => day >= today));
  await AsyncStorage.setItem(KEY, JSON.stringify(kept)).catch(() => {});
}

export async function rememberRouteName(date: string, name: string) {
  await write({ ...(await read()), [date]: name });
}

export async function routeNameFor(date: string): Promise<string | null> {
  return (await read())[date] || null;
}

export async function forgetRouteName(date: string) {
  const names = await read();
  delete names[date];
  await write(names);
}
