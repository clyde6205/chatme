import { CSRF_HEADER } from '@chatme/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { DB } from '../db/database.js';
import { hashToken } from '../lib/crypto.js';
import { AppError, unauthenticated } from '../lib/errors.js';

export interface AuthContext {
  userId: string;
  sessionId: string;
  deviceId: string;
  via: 'cookie' | 'bearer';
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const TOUCH_INTERVAL_MS = 5 * 60_000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function sessionCookieName(config: Config): string {
  // The __Host- prefix makes browsers reject the cookie unless Secure, Path=/ and host-only.
  return config.cookieSecure ? '__Host-chatme_session' : 'chatme_session';
}

export function registerAuth(app: FastifyInstance, deps: { db: DB; config: Config }) {
  const { db, config } = deps;
  const cookieName = sessionCookieName(config);

  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    let token: string | undefined;
    let via: AuthContext['via'] = 'cookie';
    if (header?.startsWith('Bearer ')) {
      token = header.slice(7).trim();
      via = 'bearer';
    } else {
      token = req.cookies[cookieName];
    }

    // CSRF: any state-changing request not carrying an explicit bearer token is
    // treated as potentially cookie-authenticated. Requiring a custom header forces
    // a CORS preflight, which only allow-listed origins pass; the Origin check is
    // defence in depth for browsers that send it.
    if (!SAFE_METHODS.has(req.method) && via === 'cookie') {
      const origin = req.headers.origin;
      if (req.headers[CSRF_HEADER] !== '1' || (origin !== undefined && !config.webOrigins.includes(origin))) {
        throw new AppError('csrf_failed', 403);
      }
    }

    if (!token || token.length > 128) return;

    const row = await db
      .selectFrom('sessions')
      .select(['id', 'user_id', 'device_id', 'expires_at', 'last_seen_at'])
      .where('token_hash', '=', hashToken(token))
      .executeTakeFirst();
    if (!row) return;

    const now = Date.now();
    const lastSeen = new Date(row.last_seen_at).getTime();
    if (new Date(row.expires_at).getTime() <= now || now - lastSeen > config.sessionIdleMs) {
      await db.deleteFrom('sessions').where('id', '=', row.id).execute();
      return;
    }
    if (now - lastSeen > TOUCH_INTERVAL_MS) {
      const ts = new Date(now);
      await db.updateTable('sessions').set({ last_seen_at: ts }).where('id', '=', row.id).execute();
      await db.updateTable('devices').set({ last_seen_at: ts }).where('id', '=', row.device_id).execute();
    }
    req.auth = { userId: row.user_id, sessionId: row.id, deviceId: row.device_id, via };
  });
}

/** preHandler for routes that need a signed-in user. */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.auth) throw unauthenticated();
}

export function authOf(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthenticated();
  return req.auth;
}
