import type { Session } from '@chatme/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/database.js';
import type { Runtime } from '../../runtime.js';
import { notFound, parse } from '../../lib/errors.js';
import { authOf, requireAuth } from '../../plugins/auth.js';
import { recordAudit } from '../audit/service.js';
import { revokeOtherSessions, revokeSession } from '../auth/service.js';

const iso = (d: Date | string) => new Date(d).toISOString();

export function sessionRoutes(app: FastifyInstance, deps: { db: DB; runtime: Runtime }) {
  const { db, runtime } = deps;

  app.get('/v1/sessions', { preHandler: requireAuth }, async (req) => {
    const auth = authOf(req);
    const rows = await db
      .selectFrom('sessions as s')
      .innerJoin('devices as d', 'd.id', 's.device_id')
      .select(['s.id', 's.created_at', 's.last_seen_at', 's.expires_at', 'd.id as device_id', 'd.platform', 'd.name', 'd.app_version'])
      .where('s.user_id', '=', auth.userId)
      .where('s.expires_at', '>', new Date())
      .orderBy('s.last_seen_at', 'desc')
      .limit(100)
      .execute();
    const sessions: Session[] = rows.map((r) => ({
      id: r.id,
      current: r.id === auth.sessionId,
      createdAt: iso(r.created_at),
      lastSeenAt: iso(r.last_seen_at),
      expiresAt: iso(r.expires_at),
      device: { id: r.device_id, platform: r.platform, name: r.name, appVersion: r.app_version },
    }));
    return { sessions };
  });

  app.delete('/v1/sessions/:id', { preHandler: requireAuth }, async (req, reply) => {
    const auth = authOf(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    if (!(await revokeSession(db, runtime.bus, auth.userId, id))) throw notFound();
    await recordAudit(db, { action: 'auth.session_revoked', userId: auth.userId, sessionId: auth.sessionId, metadata: { revoked: id } });
    return reply.status(204).send();
  });

  app.post('/v1/sessions/revoke-others', { preHandler: requireAuth }, async (req) => {
    const auth = authOf(req);
    const revoked = await revokeOtherSessions(db, runtime.bus, auth.userId, auth.sessionId);
    await recordAudit(db, { action: 'auth.sessions_revoked_others', userId: auth.userId, sessionId: auth.sessionId, metadata: { revoked } });
    return { revoked };
  });
}
