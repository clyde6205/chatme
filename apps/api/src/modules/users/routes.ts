import { updatePreferencesRequestSchema, updateProfileRequestSchema } from '@chatme/contracts';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { isUniqueViolation, type DB } from '../../db/database.js';
import { AppError, parse } from '../../lib/errors.js';
import { authOf, requireAuth } from '../../plugins/auth.js';
import { recordAudit } from '../audit/service.js';
import { getMe } from './service.js';

export function userRoutes(app: FastifyInstance, deps: { db: DB }) {
  const { db } = deps;

  app.get('/v1/me', { preHandler: requireAuth }, async (req) => getMe(db, authOf(req).userId));

  app.patch('/v1/me/profile', { preHandler: requireAuth }, async (req) => {
    const auth = authOf(req);
    const input = parse(updateProfileRequestSchema, req.body);
    if (Object.keys(input).length === 0) return getMe(db, auth.userId);
    try {
      const before = input.username
        ? await db.selectFrom('users').select('username').where('id', '=', auth.userId).executeTakeFirstOrThrow()
        : undefined;
      await db
        .updateTable('users')
        .set({
          ...(input.displayName !== undefined && { display_name: input.displayName }),
          ...(input.bio !== undefined && { bio: input.bio || null }),
          ...(input.username !== undefined && { username: input.username }),
          updated_at: new Date(),
        })
        .where('id', '=', auth.userId)
        .execute();
      if (before && before.username !== input.username) {
        await recordAudit(db, { action: 'profile.username_changed', userId: auth.userId, sessionId: auth.sessionId, metadata: { from: before.username, to: input.username } });
      }
    } catch (err) {
      if (isUniqueViolation(err, 'users_username_key')) throw new AppError('conflict_username', 409);
      throw err;
    }
    return getMe(db, auth.userId);
  });

  app.patch('/v1/me/preferences', { preHandler: requireAuth }, async (req) => {
    const auth = authOf(req);
    const input = parse(updatePreferencesRequestSchema, req.body);
    await db.transaction().execute(async (trx) => {
      if (input.locale !== undefined || input.timezone !== undefined) {
        await trx
          .updateTable('users')
          .set({
            ...(input.locale !== undefined && { locale: input.locale }),
            ...(input.timezone !== undefined && { timezone: input.timezone }),
            updated_at: new Date(),
          })
          .where('id', '=', auth.userId)
          .execute();
      }
      if (input.privacy || input.notifications || input.performanceMode) {
        // jsonb `||` merges partial updates atomically; concurrent toggles of different keys do not clobber each other.
        // quietHours is replaced as a whole object (validated as complete by the contract).
        await trx
          .updateTable('user_preferences')
          .set({
            ...(input.privacy && { privacy: sql`privacy || ${JSON.stringify(input.privacy)}::jsonb` as never }),
            ...(input.notifications && { notifications: sql`notifications || ${JSON.stringify(input.notifications)}::jsonb` as never }),
            ...(input.performanceMode && { performance_mode: input.performanceMode }),
            updated_at: new Date(),
          })
          .where('user_id', '=', auth.userId)
          .execute();
      }
    });
    return getMe(db, auth.userId);
  });
}
