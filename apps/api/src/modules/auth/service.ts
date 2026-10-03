import type { LoginRequest, RegisterRequest } from '@chatme/contracts';
import { DEFAULT_LOCALE } from '@chatme/contracts';
import type { Config } from '../../config.js';
import { isUniqueViolation, type DB } from '../../db/database.js';
import { generateSessionToken, getDummyHash, hashPassword, hashToken, verifyPassword } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { recordAudit } from '../audit/service.js';
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
  const session = await createSession(db, config, row.user_id, input.device);
  await recordAudit(db, { action: 'auth.login', userId: row.user_id, sessionId: session.sessionId, metadata: { platform: input.device.platform } });
  return session;
}

/** Deleting the session's device cascades to the session itself. */
export async function revokeSession(db: DB, userId: string, sessionId: string): Promise<boolean> {
  const row = await db.selectFrom('sessions').select('device_id').where('id', '=', sessionId).where('user_id', '=', userId).executeTakeFirst();
  if (!row) return false;
  await db.deleteFrom('devices').where('id', '=', row.device_id).where('user_id', '=', userId).execute();
  return true;
}

export async function revokeOtherSessions(db: DB, userId: string, keepSessionId: string): Promise<number> {
  const keep = await db.selectFrom('sessions').select('device_id').where('id', '=', keepSessionId).executeTakeFirstOrThrow();
  const res = await db.deleteFrom('devices').where('user_id', '=', userId).where('id', '!=', keep.device_id).executeTakeFirst();
  return Number(res.numDeletedRows);
}

export async function deleteAccount(db: DB, userId: string, password: string): Promise<void> {
  const cred = await db.selectFrom('user_credentials').select('password_hash').where('user_id', '=', userId).executeTakeFirst();
  if (!cred || !(await verifyPassword(cred.password_hash, password))) throw new AppError('invalid_credentials', 401);
  await db.transaction().execute(async (trx) => {
    // ON DELETE CASCADE removes identities, credentials, preferences, devices and sessions.
    await trx.deleteFrom('users').where('id', '=', userId).execute();
    await recordAudit(trx, { action: 'account.deleted', userId });
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
