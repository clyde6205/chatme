import { sql, type Kysely } from 'kysely';

/**
 * Email verification, password recovery and the transactional email outbox.
 * See docs/database.md ("Email and recovery").
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('verification_tokens')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('purpose', 'text', (c) => c.notNull().check(sql`purpose in ('verify_email', 'reset_password')`))
    // SHA-256 of the 256-bit token sent by email; the token itself is never stored.
    .addColumn('token_hash', 'bytea', (c) => c.notNull())
    // The address the link was sent to: verifying proves control of this address only.
    .addColumn('email', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('consumed_at', 'timestamptz')
    .execute();
  await db.schema.createIndex('verification_tokens_token_hash_key').unique().on('verification_tokens').column('token_hash').execute();
  // Issuing a new token invalidates older ones; per-user throttling counts recent tokens.
  await db.schema.createIndex('verification_tokens_user_purpose_idx').on('verification_tokens').columns(['user_id', 'purpose', 'created_at']).execute();
  await db.schema.createIndex('verification_tokens_expires_at_idx').on('verification_tokens').column('expires_at').execute();

  await db.schema
    .createTable('email_outbox')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    // Not a foreign key: the account-deleted notice is sent after the user row is gone.
    .addColumn('user_id', 'uuid')
    .addColumn('template', 'text', (c) => c.notNull())
    .addColumn('to_address', 'text', (c) => c.notNull())
    // Rendered content is cleared once the message reaches a terminal state, so links do not linger.
    .addColumn('subject', 'text')
    .addColumn('html', 'text')
    .addColumn('text_body', 'text')
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('pending').check(sql`status in ('pending', 'sending', 'sent', 'failed')`))
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('next_attempt_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('locked_until', 'timestamptz')
    .addColumn('last_error', 'text')
    .addColumn('provider', 'text')
    .addColumn('provider_message_id', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('sent_at', 'timestamptz')
    .execute();
  // The worker's claim query: due pending rows, oldest first.
  await db.schema
    .createIndex('email_outbox_due_idx')
    .on('email_outbox')
    .column('next_attempt_at')
    .where(sql.ref('status'), '=', 'pending')
    .execute();
  // Recovery of rows a crashed worker left in 'sending'.
  await db.schema
    .createIndex('email_outbox_sending_idx')
    .on('email_outbox')
    .column('locked_until')
    .where(sql.ref('status'), '=', 'sending')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('email_outbox').execute();
  await db.schema.dropTable('verification_tokens').execute();
}
