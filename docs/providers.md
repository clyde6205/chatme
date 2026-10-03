# Providers and portability

CHATme runs on Supabase (PostgreSQL), Fly.io (API + realtime), Vercel (web/PWA), Resend (email) and OpenAI (AI). Each one sits behind code CHATme owns, so any of them can be replaced or joined by another without rewriting application logic.

| Concern | Provider now | Seam in the code | What moving would take |
|---|---|---|---|
| Database | Supabase Postgres | plain PostgreSQL via `pg` + Kysely; no Supabase SDK, RLS or Supabase Auth | any PostgreSQL 15+ (RDS, Cloud SQL, Neon, self-hosted): change `DATABASE_URL` |
| Auth | CHATme API (own sessions, Argon2id) | `modules/auth` | nothing: identity data lives in our tables, not a vendor's user store |
| API + WebSockets | Fly.io Machines | `apps/api/Dockerfile` (standard OCI image, PORT env, SIGTERM drain, `/health/*`) | any container host: ECS/Fargate, Cloud Run (WebSockets supported), Kubernetes, Railway |
| Realtime fan-out | Postgres LISTEN/NOTIFY | `Bus` interface (`modules/realtime/bus.ts`) | add a Redis/NATS/Ably adapter |
| Web/PWA hosting | Vercel | static `dist/` + `vercel.json` headers | any static host or CDN (Cloudflare Pages, S3+CloudFront, Netlify): copy headers and SPA rewrite |
| Email | Resend | `EmailProvider` interface (`modules/email/provider.ts`) | one adapter file (SES, Postmark, SendGrid) |
| AI | OpenAI | `AIProvider` interface (`modules/ai/provider.ts`) behind the AI Gateway | one adapter file; model chosen by `AI_MODEL` |
| Object storage | none yet | (Phase 2: `StorageProvider` over the S3 API, so Supabase Storage, R2 and S3 are interchangeable) | |

## Why not Supabase Auth or Supabase Realtime

Using them would put user identity and realtime delivery inside one vendor's product: leaving would mean migrating password hashes and re-implementing every client's realtime layer. CHATme's own auth and realtime are already built and tested, and they keep Supabase replaceable by any PostgreSQL. Supabase remains a good fit for managed Postgres, backups, point-in-time recovery and, later, storage.

## Supabase connection strings

| Variable | Use | Supabase endpoint |
|---|---|---|
| `DATABASE_URL` | API queries | transaction pooler (Supavisor, port 6543) or direct; with the pooler keep `DATABASE_POOL_MAX` modest |
| `REALTIME_DATABASE_URL` | one LISTEN connection per instance | direct connection or session pooler (port 5432); **not** the transaction pooler |
| `MIGRATION_DATABASE_URL` | release-command migrations | direct connection |
| `DATABASE_SSL=verify-full` + `DATABASE_CA_CERT` | TLS with certificate verification | Supabase's CA certificate (Database settings → SSL) |

Server-side statement timeout: the pool no longer sends `statement_timeout` as a startup parameter (poolers reject it). Set it on the role instead: `alter role <api_role> set statement_timeout = '10s';`.

## Resend

- Verify the sending domain (`mail.chatme.pro` recommended, keeping the apex domain's reputation separate) with the SPF, DKIM and DMARC records Resend lists.
- Create a sending-only API key and store it as `RESEND_API_KEY` in Fly secrets. It never reaches the web bundle.
- Every message carries an `Idempotency-Key` equal to its outbox id, so retries after timeouts cannot send twice.

## OpenAI

Off by default (`AI_PROVIDER=none`, flag `ai.assistant` disabled). To enable: `fly secrets set OPENAI_API_KEY=...`, set `AI_PROVIDER=openai` and `AI_MODEL=<model id>`, then enable the flag for a rollout percentage. Budgets, timeouts and the system prompt are enforced in the gateway; prompts and outputs are not stored.
