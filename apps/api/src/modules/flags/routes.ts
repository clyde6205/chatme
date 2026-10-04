import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/database.js';
import { parse } from '../../lib/errors.js';
import { evaluateFlag, type FlagDefinition } from './service.js';

const querySchema = z.object({
  installId: z.string().uuid().optional(),
  platform: z.enum(['web', 'android', 'ios', 'desktop']).optional(),
  deviceClass: z.enum(['low', 'normal', 'high']).optional(),
  locale: z.string().max(10).optional(),
});

const CACHE_MS = 30_000;

export function flagRoutes(app: FastifyInstance, deps: { db: DB }) {
  const { db } = deps;
  // Flags change rarely; a short in-process cache keeps this endpoint off the database hot path
  // while a kill switch still takes effect within CACHE_MS, without a redeploy.
  let cache: { at: number; flags: FlagDefinition[] } | undefined;

  app.get('/v1/flags', async (req) => {
    const q = parse(querySchema, req.query);
    if (!cache || Date.now() - cache.at > CACHE_MS) {
      const flags = await db.selectFrom('feature_flags').select(['key', 'enabled', 'rollout_percent', 'conditions']).execute();
      cache = { at: Date.now(), flags };
    }
    const subject = req.auth?.userId ?? q.installId ?? 'anonymous';
    const result: Record<string, boolean> = {};
    for (const f of cache.flags) result[f.key] = evaluateFlag(f, { subject, ...q });
    return { flags: result };
  });
}
