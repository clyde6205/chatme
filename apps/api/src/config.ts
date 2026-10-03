import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  /** Comma-separated list of web origins allowed to call the API with credentials. */
  WEB_ORIGINS: z.string().default('http://localhost:5173'),
  /** Must be true anywhere served over HTTPS (always in production). */
  COOKIE_SECURE: bool.default('false'),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  SESSION_IDLE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Bearer token required to scrape /metrics. Required in production. */
  METRICS_TOKEN: z.string().min(24).optional(),
  /** Trust X-Forwarded-* from this many proxy hops (load balancer). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().min(1).default(10),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${fields}`);
  }
  const c = parsed.data;

  // Refuse insecure production configurations at boot rather than at the first incident.
  if (c.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (!c.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true');
    if (!c.METRICS_TOKEN) problems.push('METRICS_TOKEN is required');
    const origins = c.WEB_ORIGINS.split(',').map((o) => o.trim());
    if (origins.some((o) => !o.startsWith('https://'))) problems.push('WEB_ORIGINS must all be https://');
    if (problems.length) throw new Error(`Unsafe production configuration: ${problems.join('; ')}`);
  }

  return {
    env: c.NODE_ENV,
    host: c.HOST,
    port: c.PORT,
    logLevel: c.LOG_LEVEL,
    databaseUrl: c.DATABASE_URL,
    databasePoolMax: c.DATABASE_POOL_MAX,
    webOrigins: c.WEB_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
    cookieSecure: c.COOKIE_SECURE,
    sessionTtlMs: c.SESSION_TTL_DAYS * 86_400_000,
    sessionIdleMs: c.SESSION_IDLE_DAYS * 86_400_000,
    metricsToken: c.METRICS_TOKEN,
    trustProxyHops: c.TRUST_PROXY_HOPS,
    rateLimitGlobalPerMin: c.RATE_LIMIT_GLOBAL_PER_MIN,
    rateLimitAuthPerMin: c.RATE_LIMIT_AUTH_PER_MIN,
  };
}
