import { perfReportSchema } from '@chatme/contracts';
import type { FastifyInstance } from 'fastify';
import { parse } from '../../lib/errors.js';
import type { Metrics } from '../../plugins/metrics.js';

/**
 * Anonymous client performance ingest. Aggregated into histograms only;
 * no per-user storage, so it needs no auth and holds no personal data.
 */
export function telemetryRoutes(app: FastifyInstance, deps: { metrics: Metrics }) {
  app.post('/v1/telemetry/perf', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, bodyLimit: 8 * 1024 }, async (req, reply) => {
    const report = parse(perfReportSchema, req.body);
    for (const s of report.samples) {
      deps.metrics.clientPerf.observe(
        { name: s.name, platform: report.platform, device_class: report.deviceClass, connection: report.connection },
        s.value,
      );
    }
    return reply.status(202).send();
  });
}
