import {
  changePasswordRequestSchema,
  deleteAccountRequestSchema,
  forgotPasswordRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
  resetPasswordRequestSchema,
  verifyEmailRequestSchema,
} from '@chatme/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from '../../config.js';
import type { DB } from '../../db/database.js';
import { parse } from '../../lib/errors.js';
import { authOf, requireAuth, sessionCookieName } from '../../plugins/auth.js';
import type { Runtime } from '../../runtime.js';
import { recordAudit } from '../audit/service.js';
import { publishUserEventTx } from '../realtime/events.js';
import { getMe } from '../users/service.js';
import { changePassword, requestPasswordReset, resendVerification, resetPassword, verifyEmail } from './recovery.js';
import { announceRevoked, deleteAccount, login, register, revokeSession, type IssuedSession } from './service.js';

export function authRoutes(app: FastifyInstance, deps: { db: DB; config: Config; runtime: Runtime }) {
  const { db, config, runtime } = deps;
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
  // Token endpoints: per IP only, since the body carries no stable identity.
  const tokenRateLimit = { rateLimit: { max: config.rateLimitAuthPerMin, timeWindow: '1 minute' } };

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
    runtime.outbox.wake();
    reply.status(201);
    return respond(reply, session, input.device.platform);
  });

  app.post('/v1/auth/login', { config: authRateLimit }, async (req, reply) => {
    const input = parse(loginRequestSchema, req.body);
    const session = await login(db, config, input);
    runtime.outbox.wake();
    return respond(reply, session, input.device.platform);
  });

  app.post('/v1/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    const auth = authOf(req);
    await revokeSession(db, runtime.bus, auth.userId, auth.sessionId);
    await recordAudit(db, { action: 'auth.logout', userId: auth.userId, sessionId: auth.sessionId });
    reply.clearCookie(cookieName, { path: '/' });
    return reply.status(204).send();
  });

  app.post('/v1/auth/verify-email', { config: tokenRateLimit }, async (req, reply) => {
    const { token } = parse(verifyEmailRequestSchema, req.body);
    const userId = await verifyEmail(db, token);
    await publishUserEventTx(db, runtime.bus, userId, 'email.verified');
    return reply.status(204).send();
  });

  app.post('/v1/auth/verify-email/resend', { preHandler: requireAuth, config: tokenRateLimit }, async (req, reply) => {
    const auth = authOf(req);
    if (await resendVerification(db, config, auth.userId)) runtime.outbox.wake();
    return reply.status(204).send();
  });

  // Always 202 with the same body, whether or not the email has an account. The lookup
  // and enqueue run after the response so timing does not reveal the answer either.
  app.post('/v1/auth/password/forgot', { config: authRateLimit }, async (req, reply) => {
    const { email } = parse(forgotPasswordRequestSchema, req.body);
    runtime.background.run('password_reset_request', async () => {
      const outcome = await requestPasswordReset(db, config, email);
      if (outcome === 'sent') runtime.outbox.wake();
      if (outcome === 'throttled') req.log.warn({}, 'password reset throttled for account');
    });
    return reply.status(202).send({ status: 'accepted' });
  });

  app.post('/v1/auth/password/reset', { config: tokenRateLimit }, async (req, reply) => {
    const input = parse(resetPasswordRequestSchema, req.body);
    const { userId, revokedSessionIds } = await resetPassword(db, config, input);
    runtime.outbox.wake();
    await db.transaction().execute((trx) => announceRevoked(trx, runtime.bus, userId, revokedSessionIds));
    // The browser that reset may itself hold a (now revoked) session cookie.
    reply.clearCookie(cookieName, { path: '/' });
    return reply.status(204).send();
  });

  app.post('/v1/me/password', { preHandler: requireAuth, config: authRateLimit }, async (req) => {
    const auth = authOf(req);
    const input = parse(changePasswordRequestSchema, req.body);
    const { revokedSessionIds } = await changePassword(db, config, auth, input);
    runtime.outbox.wake();
    await db.transaction().execute((trx) => announceRevoked(trx, runtime.bus, auth.userId, revokedSessionIds));
    return { revokedSessions: revokedSessionIds.length };
  });

  app.post('/v1/me/delete', { preHandler: requireAuth, config: authRateLimit }, async (req, reply) => {
    const auth = authOf(req);
    const { password } = parse(deleteAccountRequestSchema, req.body);
    await deleteAccount(db, runtime.bus, auth.userId, password);
    runtime.outbox.wake();
    reply.clearCookie(cookieName, { path: '/' });
    return reply.status(204).send();
  });
}
