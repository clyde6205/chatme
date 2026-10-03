import { deleteAccountRequestSchema, loginRequestSchema, registerRequestSchema } from '@chatme/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from '../../config.js';
import type { DB } from '../../db/database.js';
import { parse } from '../../lib/errors.js';
import { authOf, requireAuth, sessionCookieName } from '../../plugins/auth.js';
import { recordAudit } from '../audit/service.js';
import { getMe } from '../users/service.js';
import { deleteAccount, login, register, revokeSession, type IssuedSession } from './service.js';

export function authRoutes(app: FastifyInstance, deps: { db: DB; config: Config }) {
  const { db, config } = deps;
  const cookieName = sessionCookieName(config);
  const authRateLimit = {
    rateLimit: {
      max: config.rateLimitAuthPerMin,
      timeWindow: '1 minute',
      // Per IP and per target email, so one attacker cannot spray one account from many IPs cheaply
      // nor exhaust many accounts from one IP.
      keyGenerator: (req: { ip: string; body?: unknown }) => {
        const email = (req.body as { email?: unknown } | undefined)?.email;
        return `${req.ip}|${typeof email === 'string' ? email.toLowerCase().slice(0, 254) : ''}`;
      },
    },
  };

  async function respond(reply: FastifyReply, session: IssuedSession, platform: string) {
    const user = await getMe(db, session.userId);
    if (platform === 'web') {
      reply.setCookie(cookieName, session.token, {
        httpOnly: true,
        secure: config.cookieSecure,
        sameSite: 'lax',
        path: '/',
        expires: session.expiresAt,
      });
      return { user, sessionId: session.sessionId };
    }
    return { user, sessionId: session.sessionId, token: session.token };
  }

  app.post('/v1/auth/register', { config: authRateLimit }, async (req, reply) => {
    const input = parse(registerRequestSchema, req.body);
    const session = await register(db, config, input);
    reply.status(201);
    return respond(reply, session, input.device.platform);
  });

  app.post('/v1/auth/login', { config: authRateLimit }, async (req, reply) => {
    const input = parse(loginRequestSchema, req.body);
    const session = await login(db, config, input);
    return respond(reply, session, input.device.platform);
  });

  app.post('/v1/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    const auth = authOf(req);
    await revokeSession(db, auth.userId, auth.sessionId);
    await recordAudit(db, { action: 'auth.logout', userId: auth.userId, sessionId: auth.sessionId });
    reply.clearCookie(cookieName, { path: '/' });
    return reply.status(204).send();
  });

  app.post('/v1/me/delete', { preHandler: requireAuth, config: authRateLimit }, async (req, reply) => {
    const auth = authOf(req);
    const { password } = parse(deleteAccountRequestSchema, req.body);
    await deleteAccount(db, auth.userId, password);
    reply.clearCookie(cookieName, { path: '/' });
    return reply.status(204).send();
  });
}
