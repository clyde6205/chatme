import { sql } from 'kysely';
import type { RealtimeEventType } from '@chatme/contracts/realtime';
import type { DB } from '../../db/database.js';
import type { Bus } from './bus.js';

/**
 * Per-user ordered event log. publishUserEvent must run inside the transaction
 * that made the change: the sequence bump locks the user's counter row until
 * commit (so commit order equals seq order), and NOTIFY is delivered on commit.
 */
export const EVENT_RETENTION_DAYS = 7;
export const MAX_REPLAY = 500;

export interface StoredEvent {
  seq: number;
  type: RealtimeEventType;
  payload: Record<string, unknown>;
  at: string;
}

export async function publishUserEvent(
  trx: DB,
  bus: Bus,
  userId: string,
  type: RealtimeEventType,
  payload: Record<string, unknown> = {},
): Promise<number> {
  const { seq } = await trx
    .insertInto('user_event_seq')
    .values({ user_id: userId, seq: 1 })
    .onConflict((oc) => oc.column('user_id').doUpdateSet({ seq: sql`user_event_seq.seq + 1` }))
    .returning('seq')
    .executeTakeFirstOrThrow();
  const row = await trx
    .insertInto('user_events')
    .values({ user_id: userId, seq, type, payload: JSON.stringify(payload) })
    .returning('created_at')
    .executeTakeFirstOrThrow();
  const s = Number(seq);
  await bus.publish({ k: 'ev', u: userId, s, ev: { type, payload, at: new Date(row.created_at).toISOString() } }, trx);
  return s;
}

/** Convenience for callers not already in a transaction. */
export function publishUserEventTx(db: DB, bus: Bus, userId: string, type: RealtimeEventType, payload: Record<string, unknown> = {}) {
  return db.transaction().execute((trx) => publishUserEvent(trx, bus, userId, type, payload));
}

export async function currentSeq(db: DB, userId: string): Promise<number> {
  const row = await db.selectFrom('user_event_seq').select('seq').where('user_id', '=', userId).executeTakeFirst();
  return row ? Number(row.seq) : 0;
}

/**
 * Events after `after`, oldest first. Returns null when the cursor cannot be
 * served (older than retention, more than MAX_REPLAY behind, or ahead of the
 * server); the client must then resync from current state.
 */
export async function replay(db: DB, userId: string, after: number, upTo: number): Promise<StoredEvent[] | null> {
  if (after > upTo) return null;
  if (upTo - after > MAX_REPLAY) return null;
  if (after === upTo) return [];
  const rows = await db
    .selectFrom('user_events')
    .select(['seq', 'type', 'payload', 'created_at'])
    .where('user_id', '=', userId)
    .where('seq', '>', String(after))
    .where('seq', '<=', String(upTo))
    .orderBy('seq')
    .execute();
  // A gap at the start means the events the client needs were pruned.
  if (rows.length !== upTo - after) return null;
  return rows.map((r) => ({ seq: Number(r.seq), type: r.type as RealtimeEventType, payload: r.payload, at: new Date(r.created_at).toISOString() }));
}

export async function pruneUserEvents(db: DB, retentionDays = EVENT_RETENTION_DAYS): Promise<number> {
  const res = await db
    .deleteFrom('user_events')
    .where('created_at', '<', new Date(Date.now() - retentionDays * 86_400_000))
    .executeTakeFirst();
  return Number(res.numDeletedRows);
}
