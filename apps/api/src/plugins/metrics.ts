import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';

export interface Metrics {
  registry: Registry;
  clientPerf: Histogram<'name' | 'platform' | 'device_class' | 'connection'>;
}

/**
 * Prometheus metrics. A registry per app instance keeps tests isolated.
 * Route label uses the route pattern (/v1/sessions/:id), never the raw URL,
 * to bound cardinality and avoid leaking identifiers.
 */
export function registerMetrics(app: FastifyInstance, deps: { config: Config; pool: pg.Pool }): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const httpDuration = new Histogram({
    name: 'chatme_http_request_duration_seconds',
    help: 'API request latency',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const httpErrors = new Counter({
    name: 'chatme_http_server_errors_total',
    help: '5xx responses',
    labelNames: ['route'] as const,
    registers: [registry],
  });
  new Gauge({
    name: 'chatme_db_pool_connections',
    help: 'Postgres pool connections by state',
    labelNames: ['state'] as const,
    registers: [registry],
    collect() {
      this.set({ state: 'total' }, deps.pool.totalCount);
      this.set({ state: 'idle' }, deps.pool.idleCount);
      this.set({ state: 'waiting' }, deps.pool.waitingCount);
    },
  });
  const clientPerf = new Histogram({
    name: 'chatme_client_perf_ms',
    help: 'Client-reported performance timings (web-vitals, startup) in milliseconds',
    labelNames: ['name', 'platform', 'device_class', 'connection'] as const,
    buckets: [50, 100, 250, 500, 1000, 1500, 2500, 4000, 6000, 10000, 20000],
    registers: [registry],
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    httpDuration.observe({ method: req.method, route, status: String(reply.statusCode) }, reply.elapsedTime / 1000);
    if (reply.statusCode >= 500) httpErrors.inc({ route });
  });

  app.get('/metrics', { logLevel: 'warn' }, async (req, reply) => {
    const expected = deps.config.metricsToken;
    if (expected) {
      const given = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
      const want = Buffer.from(expected);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return reply.status(401).send();
    }
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });

  return { registry, clientPerf };
}
