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

  /**
   * TLS to PostgreSQL. `verify-full` checks the server certificate against
   * DATABASE_CA_CERT (PEM, e.g. Supabase's root CA); `require` encrypts without
   * verifying; `disable` is for local development only.
   */
  DATABASE_SSL: z.enum(['disable', 'require', 'verify-full']).default('disable'),
  DATABASE_CA_CERT: z.string().optional(),
  /**
   * Session-mode connection used for LISTEN/NOTIFY (realtime fan-out). Transaction
   * poolers (Supabase Supavisor port 6543, PgBouncer transaction mode) cannot hold
   * LISTEN, so point this at the direct or session-mode endpoint. Defaults to DATABASE_URL.
   */
  REALTIME_DATABASE_URL: z.string().url().optional(),

  /** WebSocket limits per instance; keep REALTIME_MAX_CONNECTIONS at or below fly.toml's hard_limit. */
  REALTIME_MAX_CONNECTIONS: z.coerce.number().int().min(1).default(2_500),
  REALTIME_MAX_PER_USER: z.coerce.number().int().min(1).max(100).default(10),

  /** Public base URL of the web app; links in emails point here. */
  WEB_BASE_URL: z.string().url().default('http://localhost:5173'),
  EMAIL_PROVIDER: z.enum(['resend', 'log', 'memory']).default('log'),
  EMAIL_FROM: z.string().min(3).default('CHATme <no-reply@localhost>'),
  EMAIL_REPLY_TO: z.string().email().optional(),
  RESEND_API_KEY: z.string().min(10).optional(),
  RESEND_API_BASE: z.string().url().default('https://api.resend.com'),
  /** Run background workers (email outbox) in this process. */
  WORKERS_ENABLED: bool.default('true'),

  /** AI Gateway. `none` disables it; the ai.assistant flag gates it per user. */
  AI_PROVIDER: z.enum(['none', 'openai']).default('none'),
  OPENAI_API_KEY: z.string().min(10).optional(),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_ORGANIZATION: z.string().optional(),
  /** Model id sent to the provider. Required when a provider is enabled; there is no silent default. */
  AI_MODEL: z.string().min(1).optional(),
  AI_DAILY_TOKEN_BUDGET: z.coerce.number().int().min(0).default(50_000),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(16).max(16_384).default(1024),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),

  /** Fly.io sets these; used only for logs, metrics and presence bookkeeping. */
  FLY_REGION: z.string().optional(),
  FLY_MACHINE_ID: z.string().optional(),
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
  if (c.EMAIL_PROVIDER === 'resend' && !c.RESEND_API_KEY) throw new Error('Invalid configuration: RESEND_API_KEY is required when EMAIL_PROVIDER=resend');
  if (c.AI_PROVIDER === 'openai' && (!c.OPENAI_API_KEY || !c.AI_MODEL)) throw new Error('Invalid configuration: OPENAI_API_KEY and AI_MODEL are required when AI_PROVIDER=openai');
  if (c.DATABASE_SSL === 'verify-full' && !c.DATABASE_CA_CERT) throw new Error('Invalid configuration: DATABASE_CA_CERT is required when DATABASE_SSL=verify-full');

  if (c.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (!c.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true');
    if (!c.METRICS_TOKEN) problems.push('METRICS_TOKEN is required');
    const origins = c.WEB_ORIGINS.split(',').map((o) => o.trim());
    if (origins.some((o) => !o.startsWith('https://'))) problems.push('WEB_ORIGINS must all be https://');
    if (!c.WEB_BASE_URL.startsWith('https://')) problems.push('WEB_BASE_URL must be https://');
    if (c.EMAIL_PROVIDER !== 'resend') problems.push('EMAIL_PROVIDER must be resend');
    if (c.EMAIL_PROVIDER === 'resend' && !c.RESEND_API_KEY) problems.push('RESEND_API_KEY is required');
    if (/@localhost\b/.test(c.EMAIL_FROM)) problems.push('EMAIL_FROM must use a verified sending domain');
    if (c.DATABASE_SSL === 'disable') problems.push('DATABASE_SSL must be require or verify-full');
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
    databaseSsl: c.DATABASE_SSL,
    databaseCaCert: c.DATABASE_CA_CERT?.replace(/\\n/g, '\n'),
    realtimeDatabaseUrl: c.REALTIME_DATABASE_URL ?? c.DATABASE_URL,
    realtimeMaxConnections: c.REALTIME_MAX_CONNECTIONS,
    realtimeMaxPerUser: c.REALTIME_MAX_PER_USER,
    webBaseUrl: c.WEB_BASE_URL.replace(/\/$/, ''),
    email: {
      provider: c.EMAIL_PROVIDER,
      from: c.EMAIL_FROM,
      replyTo: c.EMAIL_REPLY_TO,
      resendApiKey: c.RESEND_API_KEY,
      resendApiBase: c.RESEND_API_BASE,
    },
    workersEnabled: c.WORKERS_ENABLED,
    ai: {
      provider: c.AI_PROVIDER,
      openaiApiKey: c.OPENAI_API_KEY,
      openaiBaseUrl: c.OPENAI_BASE_URL,
      openaiOrganization: c.OPENAI_ORGANIZATION,
      model: c.AI_MODEL ?? '',
      dailyTokenBudget: c.AI_DAILY_TOKEN_BUDGET,
      maxOutputTokens: c.AI_MAX_OUTPUT_TOKENS,
      timeoutMs: c.AI_TIMEOUT_MS,
    },
    region: c.FLY_REGION ?? 'local',
    instanceId: c.FLY_MACHINE_ID ?? `local-${process.pid}`,
  };
}
