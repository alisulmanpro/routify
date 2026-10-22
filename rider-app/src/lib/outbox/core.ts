/**
 * The offline outbox (P4.1): every stop event, new stop and proof photo is saved on the phone first and sent in order.
 * Pure logic with an injected store and sender, so it is unit-tested in Node (tests/outbox.test.ts); the app wires it to
 * SQLite and the API in ./index.ts.
 *
 * Rules
 * - Items go out strictly in the order they were made. A network failure (or 5xx) stops the run and retries later with
 *   backoff, so a deliver never overtakes its arrive.
 * - A rejection (4xx) moves the item to "needs attention" and the run goes on. Nothing is ever dropped silently: an item
 *   only leaves the outbox when the server took it, or when the rider discards it on the needs-attention list.
 * - A stop made offline has the phone's id until the server has it; events queued for it are then pointed at the
 *   server's id.
 */

export type OutboxKind = 'event' | 'create' | 'proof';
export type OutboxItem = {
  id: string;
  kind: OutboxKind;
  /** The stop: the server's id, or the phone's (clientId) for a stop not saved yet. */
  stopId: string;
  /** The request body (event, new stop) or the photo's file path (proof). */
  payload: Record<string, unknown>;
  /** Sent as the Idempotency-Key (events, photos) / clientId (new stops), the same on every retry. */
  key: string;
  createdAt: number;
  attempts: number;
  state: 'pending' | 'failed';
  /** Why it needs attention (failed), or the last network error (pending). */
  error: string | null;
  /** The API error code of a rejection, e.g. EARLIER_STOPS_REMAIN, SAME_EIRCODE_SAME_DAY. */
  code: string | null;
  nextAttemptAt: number;
  /** What the rider sees on the sync list, e.g. "Delivered · D01 F5P2". */
  label?: string | null;
};

export interface OutboxStore {
  all(): Promise<OutboxItem[]>;
  put(item: OutboxItem): Promise<void>;
  remove(id: string): Promise<void>;
}

/** What happened to one item: sent (with the server's answer), try again later, or rejected. */
export type SendOutcome =
  | { status: 'sent'; result?: unknown; serverId?: string }
  | { status: 'retry'; error: string }
  | { status: 'rejected'; error: string; code?: string };

/** Sends a run of items: one, or up to 500 consecutive new stops in one request. One outcome per item, same order. */
export type Sender = (items: OutboxItem[]) => Promise<SendOutcome[]>;

export const MAX_CREATE_BATCH = 500;
const MAX_BACKOFF_MS = 5 * 60_000;
/** 2 s, 4 s, 8 s … up to 5 min between tries while the network is down. */
export const backoffMs = (attempts: number) => Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.max(0, attempts - 1));

export type OutboxSummary = { waiting: number; needsAttention: number; sending: boolean; lastError: string | null };

export class Outbox {
  private items: OutboxItem[] | null = null;
  private running: Promise<void> | null = null;
  private sending = false;
  private listeners = new Set<() => void>();
  /** Answers of items sent during a run, for callers waiting on their own item (submit). */
  private results = new Map<string, SendOutcome>();

  constructor(private store: OutboxStore, private send: Sender, private now: () => number = () => Date.now()) {}

  private async load(): Promise<OutboxItem[]> {
    if (!this.items) this.items = (await this.store.all()).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return this.items;
  }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private changed() { this.listeners.forEach((fn) => fn()); }

  async list(): Promise<OutboxItem[]> { return [...await this.load()]; }

  async summary(): Promise<OutboxSummary> {
    const items = await this.load();
    const waiting = items.filter((i) => i.state === 'pending');
    return {
      waiting: waiting.length, needsAttention: items.length - waiting.length, sending: this.sending,
      lastError: waiting.find((i) => i.error)?.error ?? null,
    };
  }

  async enqueue(kind: OutboxKind, stopId: string, payload: Record<string, unknown>, ids: { id: string; key: string; label?: string | null }): Promise<OutboxItem> {
    const items = await this.load();
    const last = items[items.length - 1]?.createdAt ?? 0;
    // Strictly increasing, so two items made in the same millisecond keep their order after a restart.
    const createdAt = Math.max(this.now(), last + 1);
    const item: OutboxItem = { ...ids, kind, stopId, payload, createdAt, attempts: 0, state: 'pending', error: null, code: null, nextAttemptAt: 0 };
    await this.store.put(item);
    items.push(item);
    this.changed();
    return item;
  }

  /**
   * Saves the item, sends what is due, and says what happened to this item: sent (with the answer), queued (no
   * connection: it goes later by itself) or rejected (the caller decides with the rider; the item is then removed).
   */
  async submit(kind: OutboxKind, stopId: string, payload: Record<string, unknown>, ids: { id: string; key: string; label?: string | null }):
    Promise<{ status: 'sent'; result?: unknown; serverId?: string } | { status: 'queued' } | { status: 'rejected'; error: string; code?: string }> {
    const item = await this.enqueue(kind, stopId, payload, ids);
    await this.flush();
    const outcome = this.results.get(item.id);
    this.results.delete(item.id);
    if (outcome?.status === 'sent') return outcome;
    if (outcome?.status === 'rejected') {
      // The rider is looking at it right now: they get the answer instead of a needs-attention entry.
      await this.discard(item.id);
      return outcome;
    }
    return { status: 'queued' };
  }

  /** The answer for an item sent in the last run (once; for callers that enqueued several items and flushed). */
  takeOutcome(id: string): SendOutcome | undefined {
    const outcome = this.results.get(id);
    this.results.delete(id);
    return outcome;
  }

  /** Sends everything due, in order. Concurrent calls share one run. */
  flush(): Promise<void> {
    if (!this.running) this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private async run() {
    const items = await this.load();
    this.sending = true;
    this.changed();
    try {
      for (;;) {
        const head = items.find((i) => i.state === 'pending');
        if (!head || head.nextAttemptAt > this.now()) return;
        // Consecutive new stops go in one request; anything else alone.
        const batch = [head];
        if (head.kind === 'create') {
          for (let i = items.indexOf(head) + 1; i < items.length && batch.length < MAX_CREATE_BATCH; i += 1) {
            if (items[i].state !== 'pending' || items[i].kind !== 'create') break;
            batch.push(items[i]);
          }
        }
        let outcomes: SendOutcome[];
        try {
          outcomes = await this.send(batch);
        } catch (err) {
          outcomes = batch.map(() => ({ status: 'retry' as const, error: err instanceof Error ? err.message : 'Could not send' }));
        }
        let stop = false;
        for (let i = 0; i < batch.length; i += 1) {
          const item = batch[i];
          const outcome = outcomes[i] ?? { status: 'retry', error: 'No answer' };
          if (outcome.status === 'sent') {
            this.results.set(item.id, outcome);
            await this.store.remove(item.id);
            items.splice(items.indexOf(item), 1);
            if (outcome.serverId && outcome.serverId !== item.stopId) await this.repoint(item.stopId, outcome.serverId);
          } else if (outcome.status === 'retry') {
            item.attempts += 1;
            item.error = outcome.error;
            item.nextAttemptAt = this.now() + backoffMs(item.attempts);
            await this.store.put(item);
            stop = true;
          } else {
            this.results.set(item.id, outcome);
            item.state = 'failed';
            item.error = outcome.error;
            item.code = outcome.code ?? null;
            await this.store.put(item);
          }
        }
        this.changed();
        if (stop) return;
      }
    } finally {
      this.sending = false;
      this.changed();
    }
  }

  /** A stop made offline now has its server id: later items for it use that id. */
  private async repoint(clientId: string, serverId: string) {
    for (const item of await this.load()) {
      if (item.stopId === clientId) {
        item.stopId = serverId;
        await this.store.put(item);
      }
    }
  }

  /** Needs attention → try again, optionally with a changed request (e.g. allowSkip, secondParcel). Resets the backoff. */
  async retry(id: string, payloadPatch: Record<string, unknown> = {}) {
    const item = (await this.load()).find((i) => i.id === id);
    if (!item) return;
    Object.assign(item, { state: 'pending', error: null, code: null, attempts: 0, nextAttemptAt: 0, payload: { ...item.payload, ...payloadPatch } });
    await this.store.put(item);
    this.changed();
    await this.flush();
  }

  /** Sends what is waiting now, ignoring the backoff (the connection just came back, the app was opened). */
  async wake() {
    for (const item of await this.load()) if (item.state === 'pending') item.nextAttemptAt = 0;
    await this.flush();
  }

  /** Removes an item for good: only on the rider's own decision (or after they saw the rejection). */
  async discard(id: string) {
    const items = await this.load();
    const index = items.findIndex((i) => i.id === id);
    if (index < 0) return;
    await this.store.remove(id);
    items.splice(index, 1);
    this.changed();
  }
}

/** An in-memory store (tests; and a fallback where SQLite is unavailable). */
export class MemoryStore implements OutboxStore {
  rows = new Map<string, OutboxItem>();
  async all() { return [...this.rows.values()].map((r) => ({ ...r, payload: { ...r.payload } })); }
  async put(item: OutboxItem) { this.rows.set(item.id, { ...item, payload: { ...item.payload } }); }
  async remove(id: string) { this.rows.delete(id); }
}
