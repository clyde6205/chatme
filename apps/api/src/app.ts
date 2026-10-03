import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { CSRF_HEADER } from '@chatme/contracts';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Config } from './config.js';
import type { DB } from './db/database.js';
import { errorHandler } from './lib/errors.js';
import { authRoutes } from './modules/auth/routes.js';
import { flagRoutes } from './modules/flags/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { sessionRoutes } from './modules/sessions/routes.js';
import { telemetryRoutes } from './modules/telemetry/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { registerAuth } from './plugins/auth.js';
import { registerMetrics } from './plugins/metrics.js';

/**
 * Paths pino must never print. Fastify's default serializers already omit
 * headers and bodies; these cover any code that logs a request, reply or error object.
 */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.password_hash',
  '*.token_hash',
  'headers.authorization',
  'headers.cookie',
];

export interface AppDeps {
  config: Config;
  db: DB;
  pool: pg.Pool;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(deps: AppDeps) {
  const { config, db, pool } = deps;
  const app = Fastify({
    logger: deps.logger ?? { level: config.logLevel, redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' } },
    // Trust exactly N proxy hops (the load balancer), never arbitrary client-supplied X-Forwarded-For.
    trustProxy: config.trustProxyHops > 0 ? (_addr: string, hop: number) => hop < config.trustProxyHops : false,
    bodyLimit: 64 * 1024,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    },
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: 'not_found', requestId: req.id } }));
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(helmet, {
    // The API serves JSON only; the web app sets its own CSP.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, {
    origin: config.webOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization', CSRF_HEADER, 'x-request-id'],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitGlobalPerMin,
    timeWindow: '1 minute',
    // In-memory store is per instance. Horizontal scaling must switch to the Redis store (docs/operations.md).
    allowList: (req) => req.url.startsWith('/health/'),
  });

  const metrics = registerMetrics(app, { config, pool });
  registerAuth(app, { db, config });

  healthRoutes(app, { db });
  authRoutes(app, { db, config });
  sessionRoutes(app, { db });
  userRoutes(app, { db });
  flagRoutes(app, { db });
  telemetryRoutes(app, { metrics });

  return app;
}
