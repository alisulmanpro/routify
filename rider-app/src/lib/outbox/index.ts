import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { deleteAsync, documentDirectory, makeDirectoryAsync, moveAsync } from 'expo-file-system/legacy';
import { api, ApiRequestError, isOnline, NetworkError, newId, onOnlineChange, postFile } from '../api';
import { queryClient } from '../query';
import { rememberStopEvent } from '../queries';
import { applyLocalEvent, toDelivery, type V2BatchStop, type V2EventResult } from '../v2';
import type { NewStop, StopEvent } from '../v2api';
import type { Delivery, Route } from '../types';
import { MemoryStore, Outbox, type OutboxItem, type OutboxSummary, type SendOutcome } from './core';
import { sqliteStore } from './sqliteStore';

const SYNC_EVERY_MS = 30_000;
const PHOTO_DIR = `${documentDirectory ?? ''}outbox-photos/`;

/** How the server's answer to an outbox item counts: try again later, or a rejection the rider must see. */
function classify(err: unknown): SendOutcome {
  if (err instanceof NetworkError || err instanceof TypeError) return { status: 'retry', error: 'No connection' };
  if (err instanceof ApiRequestError) {
    if (err.status >= 500 || err.status === 429 || err.status === 401 || err.code === 'IDEMPOTENCY_IN_PROGRESS') {
      return { status: 'retry', error: err.message };
    }
    return { status: 'rejected', error: err.message, code: err.code };
  }
  return { status: 'retry', error: err instanceof Error ? err.message : 'Could not send' };
}

async function sendItems(items: OutboxItem[]): Promise<SendOutcome[]> {
  const [head] = items;
  if (head.kind === 'create') return sendCreates(items);
  try {
    if (head.kind === 'event') {
      const res = await api<V2EventResult>(`/v2/stops/${head.stopId}/events`, { method: 'POST', body: head.payload, headers: { 'Idempotency-Key': head.key } });
      rememberStopEvent(res.data);
      return [{ status: 'sent', result: res.data }];
    }
    // proof: the photo kept on the phone (P4.3) goes up, then its file is removed.
    const path = String(head.payload.path);
    const res = await postFile<{ stopId: string; proof: Delivery['proof'] }>(`/v2/uploads/proof?stopId=${encodeURIComponent(head.stopId)}`, path, 'photo',
      'image/jpeg', undefined, { 'Idempotency-Key': head.key });
    await deleteAsync(path, { idempotent: true }).catch(() => {});
    return [{ status: 'sent', result: res.data }];
  } catch (err) {
    return [classify(err)];
  }
}

/** Consecutive new stops in one /v2/deliveries/batch request; each item's key is the stop's clientId. */
async function sendCreates(items: OutboxItem[]): Promise<SendOutcome[]> {
  try {
    const res = await api<{ stops: V2BatchStop[] }>('/v2/deliveries/batch', {
      method: 'POST', idempotent: true, body: { items: items.map((i) => ({ ...i.payload, clientId: i.key })) },
    });
    const byClient = new Map(res.data.stops.map((s) => [s.clientId, s]));
    return items.map((i) => {
      const stop = byClient.get(i.key);
      return stop ? { status: 'sent', serverId: stop.id, result: toDelivery(stop, { serviceDate: stop.serviceDate, routeId: stop.routeId }) }
        : { status: 'retry', error: 'Not saved yet' };
    });
  } catch (err) {
    const outcome = classify(err);
    if (outcome.status !== 'rejected' || !(err instanceof ApiRequestError)) return items.map(() => outcome);
    // The server names the refused stops (details[].index); the others in the request were not saved either (one
    // transaction) and go again on the next run.
    const refused = new Set((err.details as { index?: number }[] | undefined)?.map((d) => d.index) ?? items.map((_, i) => i));
    return items.map((_, i) => (refused.has(i) ? outcome : { status: 'retry', error: 'Waiting for the stops before it' }));
  }
}

// ---- One outbox per signed-in rider ----

let current: { owner: string; outbox: Outbox } | null = null;
// The rider the sync loop runs for: the screens' submit calls use their outbox.
let activeOwner: string | null = null;

function active(): Outbox {
  if (!activeOwner) throw new Error('Not signed in');
  return outboxFor(activeOwner);
}

export function outboxFor(owner: string): Outbox {
  if (current?.owner !== owner) {
    let store;
    try { store = sqliteStore(owner); } catch { store = new MemoryStore(); }
    current = { owner, outbox: new Outbox(store, sendItems) };
  }
  return current.outbox;
}

/**
 * The sync loop (P4.2): sends on start, when the connection comes back, when the app returns to the foreground, and
 * every 30 s while anything is waiting. After something was sent, Home and routes reload from the server.
 */
export function startSync(owner: string): () => void {
  activeOwner = owner;
  const outbox = outboxFor(owner);
  let waitingBefore = 0;
  const unsubscribe = outbox.subscribe(() => {
    void outbox.summary().then((s) => {
      if (!s.sending && s.waiting < waitingBefore) {
        void queryClient.invalidateQueries({ queryKey: ['route'] });
        void queryClient.invalidateQueries({ queryKey: ['home'] });
      }
      if (!s.sending) waitingBefore = s.waiting;
    });
  });
  const offOnline = onOnlineChange((online) => { if (online) void outbox.wake(); });
  const app = AppState.addEventListener('change', (state) => { if (state === 'active') void outbox.wake(); });
  const timer = setInterval(() => {
    if (AppState.currentState === 'active' && isOnline()) void outbox.flush();
  }, SYNC_EVERY_MS);
  void outbox.wake();
  return () => { unsubscribe(); offOnline(); app.remove(); clearInterval(timer); if (activeOwner === owner) activeOwner = null; };
}

/** Runs the sync loop while a rider is signed in (mounted once, on Home). */
export function useSyncLoop(owner: string | undefined) {
  useEffect(() => (owner ? startSync(owner) : undefined), [owner]);
}

/** The outbox's state for the sync indicator (P4.4), live. */
export function useOutbox(owner: string | undefined) {
  const [summary, setSummary] = useState<OutboxSummary>({ waiting: 0, needsAttention: 0, sending: false, lastError: null });
  const [items, setItems] = useState<OutboxItem[]>([]);
  useEffect(() => {
    if (!owner) return;
    const outbox = outboxFor(owner);
    const refresh = () => { void outbox.summary().then(setSummary); void outbox.list().then(setItems); };
    refresh();
    return outbox.subscribe(refresh);
  }, [owner]);
  return { summary, items };
}

// ---- What screens call ----

/**
 * A stop event through the outbox: `sent` with the server's answer, or `queued` (no connection: it goes later by itself,
 * and the saved route already shows it). A rejection is thrown as ApiRequestError, like a direct request.
 */
export async function submitStopEvent(stopId: string, event: StopEvent, label?: string):
  Promise<{ status: 'sent'; result: V2EventResult } | { status: 'queued' }> {
  const at = new Date().toISOString();
  const body = { ...event, at };
  const outcome = await active().submit('event', stopId, body, { id: newId(), key: newId(), label });
  if (outcome.status === 'rejected') throw new ApiRequestError(409, { code: outcome.code ?? 'REJECTED', message: outcome.error });
  if (outcome.status === 'queued') {
    queryClient.setQueriesData<Route | null>({ queryKey: ['route'] }, (r) => (r ? applyLocalEvent(r, stopId, { type: event.type, reason: event.reason, at }) : r));
    void queryClient.invalidateQueries({ queryKey: ['home'], refetchType: 'none' });
    return { status: 'queued' };
  }
  return { status: 'sent', result: outcome.result as V2EventResult };
}

/**
 * New stops through the outbox: saved stops, or for each one not sent yet a stand-in with the phone's id and the
 * `pending_sync` flag. A rejection (e.g. same parcel ID) is thrown and none of them is kept: the rider fixes it and adds again.
 */
export async function submitStops(stops: NewStop[]): Promise<Delivery[]> {
  const outbox = active();
  const queued = [];
  for (const stop of stops) {
    const clientId = newId();
    queued.push({ stop, item: await outbox.enqueue('create', clientId, stop as Record<string, unknown>, { id: clientId, key: clientId, label: stop.address.raw }) });
  }
  await outbox.flush();
  const outcomes = queued.map(({ item }) => outbox.takeOutcome(item.id));
  const rejected = outcomes.find((o) => o?.status === 'rejected');
  if (rejected && rejected.status === 'rejected') {
    for (const { item } of queued) await outbox.discard(item.id);
    throw new ApiRequestError(409, { code: rejected.code ?? 'REJECTED', message: rejected.error });
  }
  return queued.map(({ stop, item }, i) => {
    const outcome = outcomes[i];
    return outcome?.status === 'sent' ? outcome.result as Delivery : pendingStop(item.key, stop);
  });
}

/** A stop saved on the phone only: shown in lists until the server has it. */
export function pendingStop(clientId: string, stop: NewStop): Delivery {
  return {
    id: clientId, riderId: '', trackingId: stop.trackingId ?? '', customer: { name: stop.customer?.name ?? '', phone: '' },
    address: {
      raw: stop.address.raw, normalized: stop.address.normalized ?? null, latitude: stop.location?.latitude ?? null, longitude: stop.location?.longitude ?? null,
      geocoded: !!stop.location, approximate: false, geocodeStatus: stop.location ? 'found' : 'pending', postalCode: null,
    },
    status: 'pending', proof: null, note: null, failure: null, serviceDate: stop.serviceDate, routeId: null, stopOrder: null,
    arrivedAt: null, deliveredAt: null, failedAt: null, createdAt: '', flags: ['pending_sync'],
  };
}

/** Stops for `date` still waiting in the outbox (lists show them with the saved ones). */
export async function pendingStops(date: string): Promise<Delivery[]> {
  if (!activeOwner) return [];
  return (await active().list())
    .filter((i) => i.kind === 'create' && (i.payload as NewStop).serviceDate === date)
    .map((i) => pendingStop(i.key, i.payload as unknown as NewStop));
}

/** Removes a stop that was never sent (the rider deleted it before it synced). */
export async function forgetPendingStop(clientId: string) {
  const outbox = active();
  const item = (await outbox.list()).find((i) => i.kind === 'create' && i.key === clientId);
  if (item) await outbox.discard(item.id);
}

/**
 * A proof photo (P4.3): moved into the app's own folder (the cache can be cleared by the system), queued, and sent when
 * possible. The file stays on the phone until the server has it.
 */
export async function submitProof(stopId: string, photoUri: string, label?: string):
  Promise<{ status: 'sent'; proof: Delivery['proof'] } | { status: 'queued' }> {
  await makeDirectoryAsync(PHOTO_DIR, { intermediates: true }).catch(() => {});
  const id = newId();
  const path = `${PHOTO_DIR}${id}.jpg`;
  await moveAsync({ from: photoUri, to: path });
  const outcome = await active().submit('proof', stopId, { path }, { id, key: newId(), label });
  if (outcome.status === 'rejected') {
    await deleteAsync(path, { idempotent: true }).catch(() => {});
    throw new ApiRequestError(409, { code: outcome.code ?? 'REJECTED', message: outcome.error });
  }
  if (outcome.status === 'queued') return { status: 'queued' };
  return { status: 'sent', proof: (outcome.result as { proof: Delivery['proof'] }).proof };
}

/** Rider's choice on the needs-attention list: drop the change for good (and its photo file). */
export async function discardItem(item: OutboxItem) {
  if (item.kind === 'proof') await deleteAsync(String(item.payload.path), { idempotent: true }).catch(() => {});
  await active().discard(item.id);
}

/** Needs attention → send again, optionally changed ("Deliver anyway": allowSkip, "Second parcel": secondParcel). */
export async function retryItem(item: OutboxItem, patch: Record<string, unknown> = {}) {
  await active().retry(item.id, patch);
}

/** "Send now" on the sync list: try everything waiting, ignoring the backoff. */
export async function syncNow() {
  if (activeOwner) await active().wake();
}

export type { OutboxItem };
