# Environment

## API (`apps/api`)

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | development | `production` enables boot-time safety checks |
| `HOST` / `PORT` | 0.0.0.0 / 8080 | |
| `DATABASE_URL` | — | required |
| `DATABASE_POOL_MAX` | 10 | per instance |
| `WEB_ORIGINS` | http://localhost:5173 | comma-separated; must be https in production |
| `COOKIE_SECURE` | false | must be true in production |
| `SESSION_TTL_DAYS` / `SESSION_IDLE_DAYS` | 90 / 30 | |
| `METRICS_TOKEN` | — | required in production, ≥ 24 chars |
| `TRUST_PROXY_HOPS` | 0 | set to the number of load balancers in front |
| `RATE_LIMIT_GLOBAL_PER_MIN` / `RATE_LIMIT_AUTH_PER_MIN` | 300 / 10 | |
| `LOG_LEVEL` | info | |
| `DATABASE_SSL` | disable | `require` or `verify-full` in production |
| `DATABASE_CA_CERT` | — | PEM; required for `verify-full` |
| `MIGRATION_DATABASE_URL` | `DATABASE_URL` | direct connection for migrations |
| `REALTIME_DATABASE_URL` | `DATABASE_URL` | session-mode connection for LISTEN/NOTIFY |
| `REALTIME_MAX_CONNECTIONS` / `REALTIME_MAX_PER_USER` | 2500 / 10 | |
| `WEB_BASE_URL` | http://localhost:5173 | links in emails; https in production |
| `EMAIL_PROVIDER` | log | `resend` required in production; `log` prints messages, `memory` is for tests |
| `EMAIL_FROM` / `EMAIL_REPLY_TO` | — | sender must be on a domain verified in Resend |
| `RESEND_API_KEY` / `RESEND_API_BASE` | — / https://api.resend.com | secret; required with `resend` |
| `WORKERS_ENABLED` | true | run the email outbox worker in this process |
| `AI_PROVIDER` | none | `openai` enables the AI Gateway |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_ORGANIZATION` | — | secret key; base URL for proxies or tests |
| `AI_MODEL` | — | required with a provider; no silent default |
| `AI_DAILY_TOKEN_BUDGET` / `AI_MAX_OUTPUT_TOKENS` / `AI_TIMEOUT_MS` | 50000 / 1024 / 60000 | |
| `FLY_REGION` / `FLY_MACHINE_ID` | set by Fly | region label and instance id for presence and logs |

Tests: `TEST_DATABASE_URL` (integration; the schema is wiped on every run, never point it at real data), `E2E_DATABASE_URL` (Playwright).

## Web (`apps/web`)

| Variable | Default | Notes |
|---|---|---|
| `VITE_API_URL` | `/api` | build-time. Production: `https://api.chatme.pro` (same site as `chatme.pro`, so the `SameSite=Lax` cookie is sent). Must match `connect-src` in `vercel.json` |
| `API_PROXY_TARGET` | http://localhost:8080 | dev/preview proxy only |
