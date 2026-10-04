import pg from 'pg';

const dbUrl = process.env.E2E_DATABASE_URL ?? 'postgres://chatme:chatme@localhost:5432/chatme_e2e';

/**
 * The e2e API runs with its email worker disabled, so rendered messages wait in
 * the outbox. Reading the link from there exercises the real token, template and
 * link format without a mail server.
 */
export async function linkFromOutbox(to: string, path: string): Promise<string> {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    for (let i = 0; i < 50; i++) {
      const { rows } = await client.query<{ text_body: string }>(
        `select text_body from email_outbox where to_address = $1 and text_body like $2 order by created_at desc limit 1`,
        [to, `%${path}#token=%`],
      );
      const m = rows[0] && new RegExp(`https?://[^\\s]+${path}#token=[A-Za-z0-9_-]{43}`).exec(rows[0].text_body);
      if (m) return m[0];
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no ${path} email for ${to}`);
  } finally {
    await client.end();
  }
}
