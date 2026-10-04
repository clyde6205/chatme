import type { LoginRequest, RegisterRequest } from '@chatme/contracts';
import { DEFAULT_LOCALE } from '@chatme/contracts';
import type { Config } from '../../config.js';
import { isUniqueViolation, type DB } from '../../db/database.js';
import { generateSessionToken, getDummyHash, hashPassword, hashToken, verifyPassword } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { recordAudit } from '../audit/service.js';
import { enqueueEmail } from '../email/outbox.js';
import type { Bus } from '../realtime/bus.js';
import { publishUserEvent } from '../realtime/events.js';
import { recipientOf, sendVerification } from './recovery.js';
import { DEFAULT_NOTIFICATIONS, DEFAULT_PRIVACY } from '../users/service.js';

export interface IssuedSession {
  userId: string;
  sessionId: string;
  token: string;
  expiresAt: Date;
}

type DeviceInfo = RegisterRequest['device'];

async function createSession(db: DB, config: Config, userId: string, device: DeviceInfo): Promise<IssuedSession> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlMs);
  const dev = await db
    .insertInto('devices')
    .values({ user_id: userId, platform: device.platform, name: device.name ?? null, app_version: device.appVersion ?? null })
    .returning('id')
    .executeTakeFirstOrThrow();
  const session = await db
    .insertInto('sessions')
    .values({ user_id: userId, device_id: dev.id, token_hash: hashToken(token), expires_at: expiresAt })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { userId, sessionId: session.id, token, expiresAt };
}

export async function register(db: DB, config: Config, input: RegisterRequest): Promise<IssuedSession> {
  const passwordHash = await hashPassword(input.password);
  try {
    return await db.transaction().execute(async (trx) => {
      const user = await trx
        .insertInto('users')
        .values({
          username: input.username,
          display_name: input.displayName,
          locale: input.locale ?? DEFAULT_LOCALE,
          timezone: input.timezone ?? 'UTC',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('user_identities').values({ user_id: user.id, kind: 'email', value: input.email, verified_at: null }).execute();
      await trx.insertInto('user_credentials').values({ user_id: user.id, password_hash: passwordHash }).execute();
      await trx
        .insertInto('user_preferences')
        .values({
          user_id: user.id,
          privacy: JSON.stringify(DEFAULT_PRIVACY),
          notifications: JSON.stringify(DEFAULT_NOTIFICATIONS),
          performance_mode: 'auto',
        })
        .execute();
      const session = await createSession(trx, config, user.id, input.device);
      await recordAudit(trx, { action: 'auth.register', userId: user.id, sessionId: session.sessionId, metadata: { platform: input.device.platform } });
      await sendVerification(trx, config, { userId: user.id, email: input.email, name: input.displayName, locale: input.locale ?? DEFAULT_LOCALE });
      return session;
    });
  } catch (err) {
    if (isUniqueViolation(err, 'user_identities_kind_value_key')) throw new AppError('conflict_email', 409);
    if (isUniqueViolation(err, 'users_username_key')) throw new AppError('conflict_username', 409);
    throw err;
  }
}

export async function login(db: DB, config: Config, input: LoginRequest): Promise<IssuedSession> {
  const row = await db
    .selectFrom('user_identities as i')
    .innerJoin('user_credentials as c', 'c.user_id', 'i.user_id')
    .select(['i.user_id', 'c.password_hash'])
    .where('i.kind', '=', 'email')
    .where('i.value', '=', input.email)
    .executeTakeFirst();

  // Always spend one Argon2 verification so timing does not reveal account existence.
  const ok = await verifyPassword(row?.password_hash ?? (await getDummyHash()), input.password);
  if (!row || !ok) {
    if (row) await recordAudit(db, { action: 'auth.login_failed', userId: row.user_id });
    throw new AppError('invalid_credentials', 401);
  }
  return db.transaction().execute(async (trx) => {
    const session = await createSession(trx, config, row.user_id, input.device);
    await recordAudit(trx, { action: 'auth.login', userId: row.user_id, sessionId: session.sessionId, metadata: { platform: input.device.platform } });
    // Security notice for every sign-in: sessions last months, so sign-ins are rare and each one matters.
    const r = await recipientOf(trx, row.user_id);
    if (r) {
      const device = input.device.name ? `${input.device.name} (${input.device.platform})` : input.device.platform;
      await enqueueEmail(trx, {
        userId: r.userId,
        to: r.email,
        locale: r.locale,
        template: { kind: 'new_sign_in', name: r.name, device, resetLink: `${config.webBaseUrl}/forgot-password` },
      });
    }
    return session;
  });
}

/**
 * Tell every instance to close sockets of revoked sessions, and the user's other
 * devices to refresh their session lists. Runs inside the revoking transaction,
 * so nothing is announced for a revocation that rolled back.
 */
export async function announceRevoked(trx: DB, bus: Bus, userId: string, sessionIds: string[]) {
  if (!sessionIds.length) return;
  await bus.publish({ k: 'rv', u: userId, sids: sessionIds }, trx);
  await publishUserEvent(trx, bus, userId, 'session.revoked', { sessionIds });
}

/** Deleting the session's device cascades to the session itself. */
export async function revokeSession(db: DB, bus: Bus, userId: string, sessionId: string): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom('sessions').select('device_id').where('id', '=', sessionId).where('user_id', '=', userId).executeTakeFirst();
    if (!row) return false;
    await trx.deleteFrom('devices').where('id', '=', row.device_id).where('user_id', '=', userId).execute();
    await announceRevoked(trx, bus, userId, [sessionId]);
    return true;
  });
}

export async function revokeOtherSessions(db: DB, bus: Bus, userId: string, keepSessionId: string): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const keep = await trx.selectFrom('sessions').select('device_id').where('id', '=', keepSessionId).executeTakeFirstOrThrow();
    const ids = (await trx.selectFrom('sessions').select('id').where('user_id', '=', userId).where('device_id', '!=', keep.device_id).execute()).map((r) => r.id);
    const res = await trx.deleteFrom('devices').where('user_id', '=', userId).where('id', '!=', keep.device_id).executeTakeFirst();
    await announceRevoked(trx, bus, userId, ids);
    return Number(res.numDeletedRows);
  });
}

export async function deleteAccount(db: DB, bus: Bus, userId: string, password: string): Promise<void> {
  const cred = await db.selectFrom('user_credentials').select('password_hash').where('user_id', '=', userId).executeTakeFirst();
  if (!cred || !(await verifyPassword(cred.password_hash, password))) throw new AppError('invalid_credentials', 401);
  await db.transaction().execute(async (trx) => {
    const r = await recipientOf(trx, userId);
    // ON DELETE CASCADE removes identities, credentials, preferences, devices, sessions,
    // tokens, events and presence. The outbox row has no foreign key, so the notice survives.
    await trx.deleteFrom('users').where('id', '=', userId).execute();
    await recordAudit(trx, { action: 'account.deleted', userId });
    if (r) await enqueueEmail(trx, { userId: null, to: r.email, locale: r.locale, template: { kind: 'account_deleted', name: r.name } });
    await bus.publish({ k: 'rv', u: userId, all: true }, trx);
  });
}

export async function pruneExpiredSessions(db: DB): Promise<number> {
  // Each session owns one device row; removing the device cascades to the session.
  const res = await db
    .deleteFrom('devices')
    .where('id', 'in', (qb) => qb.selectFrom('sessions').select('device_id').where('expires_at', '<=', new Date()))
    .executeTakeFirst();
  return Number(res.numDeletedRows);
}
