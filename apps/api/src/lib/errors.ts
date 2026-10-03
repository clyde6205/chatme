import type { ErrorCode } from '@chatme/contracts';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodType } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    public readonly fields?: Record<string, string[]>,
  ) {
    super(code);
  }
}

export const unauthenticated = () => new AppError('unauthenticated', 401);
export const notFound = () => new AppError('not_found', 404);

/** Parse untrusted input with a contract schema; failures become 400 validation_failed with per-field codes. */
export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw validationError(result.error);
}

function validationError(err: ZodError): AppError {
  const fields: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const path = issue.path.join('.') || '_';
    (fields[path] ??= []).push(issue.message);
  }
  return new AppError('validation_failed', 400, fields);
}

export function errorHandler(err: FastifyError | AppError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) {
    return reply.status(err.status).send({ error: { code: err.code, requestId: req.id, fields: err.fields } });
  }
  const fe = err as FastifyError;
  if (fe.statusCode === 429) {
    return reply.status(429).send({ error: { code: 'rate_limited', requestId: req.id } });
  }
  if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
    // Malformed JSON, oversized body, unsupported media type, etc.
    return reply.status(fe.statusCode).send({ error: { code: 'validation_failed', requestId: req.id } });
  }
  const dbDown = ['ECONNREFUSED', 'ETIMEDOUT', '57P01', '57P03', '08006', '08001'].includes((err as { code?: string }).code ?? '')
    || /timeout exceeded when trying to connect|Connection terminated/i.test(err.message);
  req.log.error({ err }, 'request failed');
  if (dbDown) return reply.status(503).send({ error: { code: 'service_unavailable', requestId: req.id } });
  return reply.status(500).send({ error: { code: 'internal', requestId: req.id } });
}
