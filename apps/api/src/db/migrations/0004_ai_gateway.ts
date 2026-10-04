import { sql, type Kysely } from 'kysely';

/**
 * AI Gateway accounting: tokens per user per UTC day, used to enforce budgets.
 * Prompts and completions are never stored here.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('ai_usage')
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('day', 'date', (c) => c.notNull())
    .addColumn('requests', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('input_tokens', 'bigint', (c) => c.notNull().defaultTo(0))
    .addColumn('output_tokens', 'bigint', (c) => c.notNull().defaultTo(0))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('ai_usage_pkey', ['user_id', 'day'])
    .execute();
  await db
    .insertInto('feature_flags')
    .values({ key: 'ai.assistant', description: 'AI assistant chat through the AI Gateway', enabled: false, rollout_percent: 0 })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.deleteFrom('feature_flags').where('key', '=', 'ai.assistant').execute();
  await db.schema.dropTable('ai_usage').execute();
}
