import { sql, type Kysely } from 'kysely';

/**
 * Phase 1 foundation: identity, preferences, devices, sessions, audit, flags.
 * See docs/database.md for the rationale behind each index.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('username', 'text', (c) => c.notNull())
    .addColumn('display_name', 'text', (c) => c.notNull())
    .addColumn('avatar_url', 'text')
    .addColumn('bio', 'text')
    .addColumn('locale', 'text', (c) => c.notNull())
    .addColumn('timezone', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('users_username_lowercase', sql`username = lower(username)`)
    .addCheckConstraint('users_bio_length', sql`char_length(bio) <= 280`)
    .execute();
  await db.schema.createIndex('users_username_key').unique().on('users').column('username').execute();

  await db.schema
    .createTable('user_identities')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('kind', 'text', (c) => c.notNull().check(sql`kind in ('email', 'phone')`))
    .addColumn('value', 'text', (c) => c.notNull())
    .addColumn('verified_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  // Login looks up by (kind, value); uniqueness prevents two accounts per email.
  await db.schema.createIndex('user_identities_kind_value_key').unique().on('user_identities').columns(['kind', 'value']).execute();
  await db.schema.createIndex('user_identities_user_id_idx').on('user_identities').column('user_id').execute();

  await db.schema
    .createTable('user_credentials')
    .addColumn('user_id', 'uuid', (c) => c.primaryKey().references('users.id').onDelete('cascade'))
    .addColumn('password_hash', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('user_preferences')
    .addColumn('user_id', 'uuid', (c) => c.primaryKey().references('users.id').onDelete('cascade'))
    .addColumn('privacy', 'jsonb', (c) => c.notNull())
    .addColumn('notifications', 'jsonb', (c) => c.notNull())
    .addColumn('performance_mode', 'text', (c) => c.notNull().defaultTo('auto').check(sql`performance_mode in ('auto','low','normal','high')`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('devices')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('platform', 'text', (c) => c.notNull().check(sql`platform in ('web','android','ios','desktop')`))
    .addColumn('name', 'text')
    .addColumn('app_version', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('last_seen_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('devices_user_id_idx').on('devices').column('user_id').execute();

  await db.schema
    .createTable('sessions')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('device_id', 'uuid', (c) => c.notNull().references('devices.id').onDelete('cascade'))
    .addColumn('token_hash', 'bytea', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('last_seen_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .execute();
  // Every authenticated request resolves a session by token hash.
  await db.schema.createIndex('sessions_token_hash_key').unique().on('sessions').column('token_hash').execute();
  await db.schema.createIndex('sessions_user_id_idx').on('sessions').column('user_id').execute();
  // Periodic pruning of expired sessions.
  await db.schema.createIndex('sessions_expires_at_idx').on('sessions').column('expires_at').execute();

  await db.schema
    .createTable('audit_events')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('user_id', 'uuid')
    .addColumn('session_id', 'uuid')
    .addColumn('action', 'text', (c) => c.notNull())
    .addColumn('metadata', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('audit_events_user_created_idx').on('audit_events').columns(['user_id', 'created_at desc']).execute();

  await db.schema
    .createTable('feature_flags')
    .addColumn('key', 'text', (c) => c.primaryKey().check(sql`key ~ '^[a-z][a-z0-9_.]*$'`))
    .addColumn('description', 'text', (c) => c.notNull())
    .addColumn('enabled', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('rollout_percent', 'integer', (c) => c.notNull().defaultTo(0).check(sql`rollout_percent between 0 and 100`))
    .addColumn('conditions', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of ['feature_flags', 'audit_events', 'sessions', 'devices', 'user_preferences', 'user_credentials', 'user_identities', 'users']) {
    await db.schema.dropTable(table).execute();
  }
}
