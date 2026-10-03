import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { DB } from '../../db/database.js';

export function healthRoutes(app: FastifyInstance, deps: { db: DB }) {
  // Liveness: the process can serve requests. Never touches dependencies,
  // so a database outage does not make the orchestrator restart-loop the API.
  app.get('/health/live', { logLevel: 'warn' }, async () => ({ status: 'ok' }));

  // Readiness: dependencies reachable. Load balancers stop routing here when it fails.
  app.get('/health/ready', { logLevel: 'warn' }, async (_req, reply) => {
    const started = performance.now();
    try {
      await Promise.race([
        sql`select 1`.execute(deps.db),
        new Promise((_, reject) => setTimeout(() => reject(new Error('db timeout')), 2_000)),
      ]);
      return { status: 'ok', checks: { database: { ok: true, latencyMs: Math.round(performance.now() - started) } } };
    } catch {
      return reply.status(503).send({ status: 'degraded', checks: { database: { ok: false } } });
    }
  });
}
