import { useEffect, useRef, type ReactNode } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { focusManager, onlineManager, QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { isOnline, onOnlineChange } from './api';
import { useAuth } from './auth';

const DAY_MS = 24 * 60 * 60 * 1000;
const OWNER_KEY = 'dp_rider_query_owner_v1';

// Queries pause while offline and refetch when the phone reconnects or the app comes back to the foreground.
onlineManager.setEventListener((setOnline) => {
  setOnline(isOnline());
  return onOnlineChange(setOnline);
});
focusManager.setEventListener((handleFocus) => {
  const sub = AppState.addEventListener('change', (state) => handleFocus(state === 'active'));
  return () => sub.remove();
});

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Screens draw the saved copy at once and refresh it in the background.
      staleTime: 30_000,
      gcTime: DAY_MS,
      // The API client already retries network errors and 502-504 with backoff.
      retry: false,
      // Run the request even when NetInfo says offline: it fails fast, and the saved copy stays on screen.
      networkMode: 'offlineFirst',
    },
  },
});

const persister = createAsyncStoragePersister({ storage: AsyncStorage, key: 'dp_rider_query_cache_v1', throttleTime: 1000 });

/** The last signed-in rider's data must never show for another rider (or after signing out). */
function CacheOwner() {
  const { user, loading } = useAuth();
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (loading) return;
    const id = user?.id ?? null;
    // Signed out (or the session ended): drop everything. A cold start without a session keeps the cache, so the
    // saved Home and route are still there once the rider is back.
    if (previous.current && !id) {
      queryClient.clear();
      void AsyncStorage.removeItem(OWNER_KEY);
    }
    if (id) {
      void AsyncStorage.getItem(OWNER_KEY).then((owner) => {
        if (owner && owner !== id) queryClient.clear();
        if (owner !== id) void AsyncStorage.setItem(OWNER_KEY, id);
      });
    }
    previous.current = id;
  }, [user?.id, loading]);
  return null;
}

export function QueryProvider({ children }: { children: ReactNode }) {
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={{ persister, maxAge: DAY_MS, buster: 'v1' }}>
      <CacheOwner />
      {children}
    </PersistQueryClientProvider>
  );
}
