import { sql } from 'kysely';
import type { ChangePasswordRequest, ResetPasswordRequest } from '@chatme/contracts';
import type { Config } from '../../config.js';
import type { DB } from '../../db/database.js';
import { generateSessionToken, hashPassword, hashToken, verifyPassword } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { recordAudit } from '../audit/service.js';
import { enqueueEmail } from '../email/outbox.js';

/**
 * Email verification and password recovery.
 *
 * Tokens are 256-bit random values delivered only by email; the database keeps
 * their SHA-256. Consumption is a single conditional UPDATE, so two concurrent
 * uses of one token cannot both succeed. Issuing a new token for a purpose
 * invalidates the user's older unused tokens for that purpose.
 */

export const VERIFY_TTL_MS = 24 * 3_600_000;
export const RESET_TTL_MS = 3_600_000;
/** Per-account caps on emails we will send, independent of per-IP rate limits. */
export const MAX_VERIFY_PER_HOUR = 5;
export const MAX_RESET_PER_HOUR = 3;

type Purpose = 'verify_email' | 'reset_password';
type Trx = Pick<DB, 'insertInto' | 'deleteFrom' | 'selectFrom' | 'updateTable'>;

interface Recipient {
  userId: string;
  email: string;
  name: string;
  locale: string;
}

async function issueToken(db: Trx, r: Recipient, purpose: Purpose, ttlMs: number): Promise<string> {
  await db
    .deleteFrom('verification_tokens')
    .where('user_id', '=', r.userId)
    .where('purpose', '=', purpose)
    .where('consumed_at', 'is', null)
    .execute();
  const token = generateSessionToken();
  await db
    .insertInto('verification_tokens')
    .values({ user_id: r.userId, purpose, token_hash: hashToken(token), email: r.email, expires_at: new Date(Date.now() + ttlMs) })
    .execute();
  return token;
}

/**
 * Emails of this purpose sent to the account in the last hour. Counted from the
 * audit log, which keeps a row per send even after superseded tokens are deleted.
 */
async function recentCount(db: Trx, userId: string, purpose: Purpose): Promise<number> {
  const row = await db
    .selectFrom('audit_events')
    .select(sql<string>`count(*)`.as('n'))
    .where('user_id', '=', userId)
    .where('action', '=', purpose === 'verify_email' ? 'auth.verification_sent' : 'auth.password_reset_requested')
    .where('created_at', '>', new Date(Date.now() - 3_600_000))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/** Links carry the token in the URL fragment so it never reaches server or proxy access logs. */
function link(config: Config, path: string, token: string) {
  return `${config.webBaseUrl}${path}#token=${token}`;
}

export async function recipientOf(db: Pick<DB, 'selectFrom'>, userId: string): Promise<Recipient | undefined> {
  const row = await db
    .selectFrom('users as u')
    .innerJoin('user_identities as i', (j) => j.onRef('i.user_id', '=', 'u.id').on('i.kind', '=', 'email'))
    .select(['u.id', 'u.display_name', 'u.locale', 'i.value as email', 'i.verified_at'])
    .where('u.id', '=', userId)
    .executeTakeFirst();
  return row && { userId: row.id, email: row.email, name: row.display_name, locale: row.locale };
}

/** Called inside the registration transaction. */
export async function sendVerification(db: Trx, config: Config, r: Recipient): Promise<void> {
  const token = await issueToken(db, r, 'verify_email', VERIFY_TTL_MS);
  await enqueueEmail(db, {
    userId: r.userId,
    to: r.email,
    locale: r.locale,
    template: { kind: 'verify_email', name: r.name, link: link(config, '/verify-email', token) },
  });
  await recordAudit(db, { action: 'auth.verification_sent', userId: r.userId });
}

/** Re-send for a signed-in user. Returns false when there was nothing to do (already verified). */
export async function resendVerification(db: DB, config: Config, userId: string): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    // Lock the identity row so concurrent resends serialize and the hourly cap holds.
    const identity = await trx
      .selectFrom('user_identities')
      .select(['verified_at'])
      .where('user_id', '=', userId)
      .where('kind', '=', 'email')
      .forUpdate()
      .executeTakeFirst();
    if (!identity || identity.verified_at) return false;
    if ((await recentCount(trx, userId, 'verify_email')) >= MAX_VERIFY_PER_HOUR) throw new AppError('rate_limited', 429);
    const r = await recipientOf(trx, userId);
    if (!r) return false;
    await sendVerification(trx, config, r);
    return true;
  });
}

/** Atomically mark a token used. Returns its owner only if it was valid, unexpired and unused. */
async function consumeToken(db: Trx, token: string, purpose: Purpose) {
  return db
    .updateTable('verification_tokens')
    .set({ consumed_at: new Date() })
    .where('token_hash', '=', hashToken(token))
    .where('purpose', '=', purpose)
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', new Date())
    .returning(['user_id', 'email'])
    .executeTakeFirst();
}

export async function verifyEmail(db: DB, token: string): Promise<string> {
  return db.transaction().execute(async (trx) => {
    const t = await consumeToken(trx, token, 'verify_email');
    if (!t) throw new AppError('invalid_token', 400);
    // Only the address the link was sent to is verified; if the account's email changed since, nothing is.
    const res = await trx
      .updateTable('user_identities')
      .set({ verified_at: new Date() })
      .where('user_id', '=', t.user_id)
      .where('kind', '=', 'email')
      .where('value', '=', t.email)
      .where('verified_at', 'is', null)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) > 0) await recordAudit(trx, { action: 'auth.email_verified', userId: t.user_id });
    return t.user_id;
  });
}

/**
 * Starts a reset if the email belongs to an account. Callers must not reveal
 * the outcome: the route always answers 202 and runs this off the response path.
 */
export async function requestPasswordReset(db: DB, config: Config, email: string): Promise<'sent' | 'unknown' | 'throttled'> {
  return db.transaction().execute(async (trx) => {
    const identity = await trx
      .selectFrom('user_identities')
      .select('user_id')
      .where('kind', '=', 'email')
      .where('value', '=', email)
      .forUpdate()
      .executeTakeFirst();
    if (!identity) return 'unknown';
    if ((await recentCount(trx, identity.user_id, 'reset_password')) >= MAX_RESET_PER_HOUR) return 'throttled';
    const r = await recipientOf(trx, identity.user_id);
    if (!r) return 'unknown';
    const token = await issueToken(trx, r, 'reset_password', RESET_TTL_MS);
    await enqueueEmail(trx, {
      userId: r.userId,
      to: r.email,
      locale: r.locale,
      template: { kind: 'reset_password', name: r.name, link: link(config, '/reset-password', token) },
    });
    await recordAudit(trx, { action: 'auth.password_reset_requested', userId: r.userId });
    return 'sent';
  });
}

/** Revokes every session of the user except `keepDeviceId`, returning the revoked session ids. */
async function revokeSessions(trx: Trx, userId: string, keepDeviceId?: string): Promise<string[]> {
  let q = trx.selectFrom('sessions').select('id').where('user_id', '=', userId);
  if (keepDeviceId) q = q.where('device_id', '!=', keepDeviceId);
  const ids = (await q.execute()).map((r) => r.id);
  let del = trx.deleteFrom('devices').where('user_id', '=', userId);
  if (keepDeviceId) del = del.where('id', '!=', keepDeviceId);
  await del.execute();
  return ids;
}

export async function resetPassword(db: DB, config: Config, input: ResetPasswordRequest): Promise<{ userId: string; revokedSessionIds: string[] }> {
  // Hash before the transaction so no row locks are held during Argon2.
  const passwordHash = await hashPassword(input.password);
  return db.transaction().execute(async (trx) => {
    const t = await consumeToken(trx, input.token, 'reset_password');
    if (!t) throw new AppError('invalid_token', 400);
    await trx.updateTable('user_credentials').set({ password_hash: passwordHash, updated_at: new Date() }).where('user_id', '=', t.user_id).execute();
    // Receiving the reset email proves control of the address.
    await trx
      .updateTable('user_identities')
      .set({ verified_at: new Date() })
      .where('user_id', '=', t.user_id)
      .where('kind', '=', 'email')
      .where('value', '=', t.email)
      .where('verified_at', 'is', null)
      .execute();
    // Anyone holding a session may be the reason for the reset: sign out everywhere,
    // and burn any other outstanding reset links.
    const revokedSessionIds = await revokeSessions(trx, t.user_id);
    await trx.deleteFrom('verification_tokens').where('user_id', '=', t.user_id).where('purpose', '=', 'reset_password').where('consumed_at', 'is', null).execute();
    await recordAudit(trx, { action: 'auth.password_reset', userId: t.user_id, metadata: { sessionsRevoked: revokedSessionIds.length } });
    const r = await recipientOf(trx, t.user_id);
    if (r) {
      await enqueueEmail(trx, {
        userId: r.userId,
        to: r.email,
        locale: r.locale,
        template: { kind: 'password_changed', name: r.name, resetLink: `${config.webBaseUrl}/forgot-password` },
      });
    }
    return { userId: t.user_id, revokedSessionIds };
  });
}

export async function changePassword(
  db: DB,
  config: Config,
  auth: { userId: string; sessionId: string; deviceId: string },
  input: ChangePasswordRequest,
): Promise<{ revokedSessionIds: string[] }> {
  const cred = await db.selectFrom('user_credentials').select('password_hash').where('user_id', '=', auth.userId).executeTakeFirst();
  if (!cred || !(await verifyPassword(cred.password_hash, input.currentPassword))) {
    await recordAudit(db, { action: 'auth.login_failed', userId: auth.userId, sessionId: auth.sessionId, metadata: { context: 'change_password' } });
    throw new AppError('invalid_credentials', 401);
  }
  const passwordHash = await hashPassword(input.newPassword);
  return db.transaction().execute(async (trx) => {
    // Optimistic check: fail if the password changed between verification and now.
    const res = await trx
      .updateTable('user_credentials')
      .set({ password_hash: passwordHash, updated_at: new Date() })
      .where('user_id', '=', auth.userId)
      .where('password_hash', '=', cred.password_hash)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) throw new AppError('invalid_credentials', 401);
    const revokedSessionIds = await revokeSessions(trx, auth.userId, auth.deviceId);
    await trx.deleteFrom('verification_tokens').where('user_id', '=', auth.userId).where('purpose', '=', 'reset_password').where('consumed_at', 'is', null).execute();
    await recordAudit(trx, { action: 'auth.password_changed', userId: auth.userId, sessionId: auth.sessionId, metadata: { sessionsRevoked: revokedSessionIds.length } });
    const r = await recipientOf(trx, auth.userId);
    if (r) {
      await enqueueEmail(trx, {
        userId: r.userId,
        to: r.email,
        locale: r.locale,
        template: { kind: 'password_changed', name: r.name, resetLink: `${config.webBaseUrl}/forgot-password` },
      });
    }
    return { revokedSessionIds };
  });
}

export async function pruneVerificationTokens(db: DB): Promise<number> {
  const res = await db.deleteFrom('verification_tokens').where('expires_at', '<', new Date(Date.now() - 86_400_000)).executeTakeFirst();
  return Number(res.numDeletedRows);
}
