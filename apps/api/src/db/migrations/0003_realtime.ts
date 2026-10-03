import { sql, type Kysely } from 'kysely';

/**
 * Realtime delivery and presence. See docs/realtime.md.
 *
 * user_events is a per-user ordered log. Each user's sequence lives in
 * user_event_seq; bumping it takes that row's lock until commit, so for any
 * one user, commit order equals sequence order and a client cursor never
 * skips an event that commits late.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('user_event_seq')
    .addColumn('user_id', 'uuid', (c) => c.primaryKey().references('users.id').onDelete('cascade'))
    .addColumn('seq', 'bigint', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('user_events')
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('seq', 'bigint', (c) => c.notNull())
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('payload', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('user_events_pkey', ['user_id', 'seq'])
    .execute();
  // Retention pruning.
  await db.schema.createIndex('user_events_created_at_idx').on('user_events').column('created_at').execute();

  // One row per running API instance that accepts WebSocket connections.
  await db.schema
    .createTable('realtime_instances')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('region', 'text', (c) => c.notNull())
    .addColumn('started_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('heartbeat_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // Which users are connected to which instance. A user is online when any row
  // belongs to an instance whose heartbeat is fresh; rows of a crashed instance
  // are swept by the survivors.
  await db.schema
    .createTable('realtime_presence')
    .addColumn('instance_id', 'text', (c) => c.notNull().references('realtime_instances.id').onDelete('cascade'))
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('connections', 'integer', (c) => c.notNull().check(sql`connections > 0`))
    .addColumn('since', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('realtime_presence_pkey', ['instance_id', 'user_id'])
    .execute();
  await db.schema.createIndex('realtime_presence_user_id_idx').on('realtime_presence').column('user_id').execute();

  // Last time a user was seen connected; shown as "last seen" subject to privacy settings.
  await db.schema.alterTable('users').addColumn('last_seen_at', 'timestamptz').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('users').dropColumn('last_seen_at').execute();
  for (const t of ['realtime_presence', 'realtime_instances', 'user_events', 'user_event_seq']) await db.schema.dropTable(t).execute();
}
