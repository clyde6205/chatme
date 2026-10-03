import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { DB } from '../../db/database.js';
import type { Runtime } from '../../runtime.js';

export function healthRoutes(app: FastifyInstance, deps: { db: DB; runtime: Runtime }) {
  const { runtime } = deps;
  // Liveness: the process can serve requests. Never touches dependencies,
  // so a database outage does not make the orchestrator restart-loop the API.
  app.get('/health/live', { logLevel: 'warn' }, async () => ({ status: 'ok' }));

  // Readiness: dependencies reachable. Load balancers stop routing here when it fails.
  // A draining instance reports not-ready so the proxy stops sending it new connections.
  // The realtime bus is reported but does not fail readiness: HTTP keeps working without it.
  app.get('/health/ready', { logLevel: 'warn' }, async (_req, reply) => {
    const realtime = { ok: runtime.bus.connected, connections: runtime.gateway.size, draining: runtime.gateway.isDraining };
    if (runtime.gateway.isDraining) return reply.status(503).send({ status: 'draining', checks: { realtime } });
    const started = performance.now();
    try {
      await Promise.race([
        sql`select 1`.execute(deps.db),
        new Promise((_, reject) => setTimeout(() => reject(new Error('db timeout')), 2_000)),
      ]);
      return { status: 'ok', checks: { database: { ok: true, latencyMs: Math.round(performance.now() - started) }, realtime } };
    } catch {
      return reply.status(503).send({ status: 'degraded', checks: { database: { ok: false }, realtime } });
    }
  });
}
