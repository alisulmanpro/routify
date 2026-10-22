import * as SQLite from 'expo-sqlite';
import type { OutboxItem, OutboxStore } from './core';

type Row = {
  id: string; owner: string; kind: OutboxItem['kind']; stop_id: string; payload: string; key: string; created_at: number; attempts: number;
  state: OutboxItem['state']; error: string | null; code: string | null; next_attempt_at: number; label: string | null;
};

let database: Promise<SQLite.SQLiteDatabase> | null = null;

/** The outbox table in the app's own SQLite file: it survives restarts, updates and a dead battery mid-route. */
function open() {
  database ??= SQLite.openDatabaseAsync('outbox.db').then(async (db) => {
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL, stop_id TEXT NOT NULL, payload TEXT NOT NULL,
        key TEXT NOT NULL, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL, state TEXT NOT NULL, error TEXT, code TEXT,
        next_attempt_at INTEGER NOT NULL, label TEXT
      );
      CREATE INDEX IF NOT EXISTS outbox_owner_created ON outbox (owner, created_at);
    `);
    return db;
  });
  return database;
}

/** The outbox of one rider: another rider signing in on the phone never sends (or sees) it. */
export function sqliteStore(owner: string): OutboxStore {
  return {
    async all() {
      const rows = await (await open()).getAllAsync<Row>('SELECT * FROM outbox WHERE owner = ? ORDER BY created_at, id', owner);
      return rows.map((r) => ({
        id: r.id, kind: r.kind, stopId: r.stop_id, payload: JSON.parse(r.payload), key: r.key, createdAt: r.created_at, attempts: r.attempts,
        state: r.state, error: r.error, code: r.code, nextAttemptAt: r.next_attempt_at, label: r.label,
      }));
    },
    async put(item) {
      await (await open()).runAsync(
        `INSERT OR REPLACE INTO outbox (id, owner, kind, stop_id, payload, key, created_at, attempts, state, error, code, next_attempt_at, label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        item.id, owner, item.kind, item.stopId, JSON.stringify(item.payload), item.key, item.createdAt, item.attempts, item.state,
        item.error, item.code, item.nextAttemptAt, item.label ?? null,
      );
    },
    async remove(id) {
      await (await open()).runAsync('DELETE FROM outbox WHERE id = ? AND owner = ?', id, owner);
    },
  };
}
