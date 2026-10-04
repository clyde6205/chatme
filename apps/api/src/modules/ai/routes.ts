import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/database.js';
import { AppError, notFound, parse } from '../../lib/errors.js';
import { authOf, requireAuth } from '../../plugins/auth.js';
import { isFlagOn } from '../flags/service.js';
import type { AIGateway } from './gateway.js';

const chatSchema = z
  .object({
    // Clients send only user and assistant turns; the system prompt is set server-side.
    messages: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(4000) }).strict())
      .min(1)
      .max(20)
      .refine((m) => m[m.length - 1]?.role === 'user', { message: 'last_message_must_be_user' }),
  })
  .strict();

export function aiRoutes(app: FastifyInstance, deps: { db: DB; gateway: AIGateway | null }) {
  const { db, gateway } = deps;

  // Server-sent events: one JSON object per `data:` line. Works through proxies and on
  // flaky networks better than holding a WebSocket for a single request/response.
  app.post('/v1/ai/chat', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = authOf(req);
    if (!(await isFlagOn(db, 'ai.assistant', { subject: auth.userId }))) throw notFound();
    if (!gateway) throw new AppError('service_unavailable', 503);
    const { messages } = parse(chatSchema, req.body);

    const abort = new AbortController();
    req.raw.on('close', () => abort.abort());
    const stream = gateway.chat(auth.userId, messages, abort.signal);
    const it = stream[Symbol.asyncIterator]();
    // Pull the first chunk before committing to a 200, so budget and provider errors get real status codes.
    let first: IteratorResult<unknown>;
    try {
      first = await it.next();
    } catch (err) {
      if (err instanceof AppError) throw err;
      req.log.warn({ err: (err as Error).message }, 'ai provider failed');
      throw new AppError('service_unavailable', 503);
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      'x-request-id': req.id,
    });
    const write = (obj: unknown) => reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    try {
      let r = first;
      while (!r.done) {
        const c = r.value as { type: string; text?: string; usage?: unknown; finishReason?: unknown };
        write(c.type === 'text' ? { t: 'text', text: c.text } : { t: 'done', usage: c.usage, finishReason: c.finishReason });
        r = await it.next();
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        req.log.warn({ err: (err as Error).message }, 'ai stream failed');
        write({ t: 'error', code: 'service_unavailable' });
      }
    } finally {
      reply.raw.end();
    }
  });
}
