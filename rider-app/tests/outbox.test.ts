import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, Outbox, backoffMs, type OutboxItem, type SendOutcome } from '../src/lib/outbox/core';

let seq = 0;
const ids = () => { seq += 1; return { id: `item-${seq}`, key: `key-${seq}` }; };

/** A fake API: records what it received; `offline` makes every call a network failure. */
function fakeServer() {
  const received: { kind: string; stopId: string; key: string; payload: Record<string, unknown> }[] = [];
  const server = {
    offline: false,
    rejectNext: null as null | { code: string; error: string },
    received,
    send: async (items: OutboxItem[]): Promise<SendOutcome[]> => {
      if (server.offline) throw new TypeError('Network request failed');
      return items.map((item) => {
        if (server.rejectNext) {
          const r = server.rejectNext;
          server.rejectNext = null;
          return { status: 'rejected', error: r.error, code: r.code };
        }
        received.push({ kind: item.kind, stopId: item.stopId, key: item.key, payload: item.payload });
        return item.kind === 'create' ? { status: 'sent', serverId: `srv-${item.key}` } : { status: 'sent', result: { ok: true } };
      });
    },
  };
  return server;
}

test('restart with 50 pending: everything is still there and goes out once, in order', async () => {
  const store = new MemoryStore();
  let clock = 1_000;
  const server = fakeServer();
  server.offline = true;
  const before = new Outbox(store, server.send, () => clock);
  for (let i = 0; i < 25; i += 1) {
    await before.enqueue('event', `stop-${i}`, { type: 'arrive' }, ids());
    await before.enqueue('event', `stop-${i}`, { type: 'deliver' }, ids());
  }
  await before.flush(); // offline: nothing sent, nothing lost
  assert.equal(store.rows.size, 50);

  // The app is killed and opened again, back online.
  clock += 60_000;
  server.offline = false;
  const after = new Outbox(store, server.send, () => clock);
  assert.equal((await after.summary()).waiting, 50);
  await after.wake();
  assert.equal(server.received.length, 50);
  assert.deepEqual(server.received.slice(0, 4).map((r) => `${r.stopId}:${r.payload.type}`), ['stop-0:arrive', 'stop-0:deliver', 'stop-1:arrive', 'stop-1:deliver']);
  assert.equal(store.rows.size, 0);
});

test('a network drop mid-run keeps the order and sends the rest later with the same keys', async () => {
  const store = new MemoryStore();
  let clock = 0;
  let calls = 0;
  const server = fakeServer();
  const flaky = async (items: OutboxItem[]) => { calls += 1; if (calls === 3) throw new TypeError('timeout'); return server.send(items); };
  const outbox = new Outbox(store, flaky, () => clock);
  const made = [];
  for (let i = 0; i < 5; i += 1) made.push(await outbox.enqueue('event', 's', { type: 'deliver', n: i }, ids()));
  await outbox.flush();
  assert.deepEqual(server.received.map((r) => r.payload.n), [0, 1], 'stops at the failure, nothing after it overtakes');
  const third = (await outbox.list())[0];
  assert.equal(third.attempts, 1);
  assert.ok(third.nextAttemptAt > clock && third.error);

  await outbox.flush(); // still backing off: nothing
  assert.equal(server.received.length, 2);
  clock += backoffMs(1);
  await outbox.flush();
  assert.deepEqual(server.received.map((r) => r.payload.n), [0, 1, 2, 3, 4]);
  assert.equal(server.received[2].key, made[2].key, 'the retry uses the same Idempotency-Key');
});

test('the same event resent three times is one key, so the server applies it once', async () => {
  const store = new MemoryStore();
  let clock = 0;
  const keys: string[] = [];
  let failures = 2;
  const outbox = new Outbox(store, async (items) => {
    keys.push(items[0].key);
    if (failures-- > 0) return [{ status: 'retry', error: '502' }];
    return [{ status: 'sent' }];
  }, () => clock);
  await outbox.enqueue('event', 's', { type: 'deliver' }, ids());
  for (let i = 0; i < 3; i += 1) { await outbox.flush(); clock += backoffMs(5); }
  assert.equal(keys.length, 3);
  assert.equal(new Set(keys).size, 1);
  assert.equal(store.rows.size, 0);
});

test('a rejection needs attention, never vanishes, and the queue goes on', async () => {
  const store = new MemoryStore();
  const server = fakeServer();
  const outbox = new Outbox(store, server.send);
  server.rejectNext = { code: 'EARLIER_STOPS_REMAIN', error: 'Earlier deliveries are still open' };
  const blocked = await outbox.enqueue('event', 'late-stop', { type: 'deliver' }, ids());
  await outbox.enqueue('event', 'other', { type: 'deliver' }, ids());
  await outbox.flush();
  const summary = await outbox.summary();
  assert.equal(summary.needsAttention, 1);
  assert.equal(summary.waiting, 0);
  assert.deepEqual(server.received.map((r) => r.stopId), ['other']);
  const failed = (await outbox.list())[0];
  assert.equal(failed.code, 'EARLIER_STOPS_REMAIN');
  // The rider chooses "Deliver anyway".
  await outbox.retry(blocked.id, { allowSkip: true });
  assert.deepEqual(server.received[1], { kind: 'event', stopId: 'late-stop', key: blocked.key, payload: { type: 'deliver', allowSkip: true } });
  assert.equal(store.rows.size, 0);
});

test('stops made offline go in one request and their queued events follow the server id', async () => {
  const store = new MemoryStore();
  const server = fakeServer();
  server.offline = true;
  const outbox = new Outbox(store, server.send);
  const a = await outbox.enqueue('create', 'client-a', { address: { raw: '1 A St' } }, { id: 'c-a', key: 'client-a' });
  await outbox.enqueue('create', 'client-b', { address: { raw: '2 B St' } }, { id: 'c-b', key: 'client-b' });
  await outbox.enqueue('event', 'client-a', { type: 'arrive' }, ids());
  await outbox.flush();
  server.offline = false;
  let batches = 0;
  const counting = new Outbox(store, async (items) => { batches += 1; return server.send(items); });
  await counting.wake();
  assert.equal(batches, 2, 'two new stops in one request, then the event');
  assert.equal(server.received[2].stopId, `srv-${a.key}`);
});

test('submit: sent answers at once, offline queues, a rejection goes back to the rider', async () => {
  const server = fakeServer();
  const outbox = new Outbox(new MemoryStore(), server.send);
  assert.equal((await outbox.submit('event', 's1', { type: 'deliver' }, ids())).status, 'sent');
  server.offline = true;
  assert.equal((await outbox.submit('event', 's2', { type: 'deliver' }, ids())).status, 'queued');
  assert.equal((await outbox.summary()).waiting, 1);
  server.offline = false;
  await outbox.wake();
  server.rejectNext = { code: 'SAME_EIRCODE_SAME_DAY', error: 'D01 F5P2 is already on that day' };
  const rejected = await outbox.submit('create', 'c', {}, ids());
  assert.equal(rejected.status, 'rejected');
  assert.equal((await outbox.summary()).needsAttention, 0, 'the rider saw it: not left as needs attention');
});
