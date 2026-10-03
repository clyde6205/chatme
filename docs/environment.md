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

Tests: `TEST_DATABASE_URL` (integration; the schema is wiped on every run, never point it at real data), `E2E_DATABASE_URL` (Playwright).

## Web (`apps/web`)

| Variable | Default | Notes |
|---|---|---|
| `VITE_API_URL` | `/api` | build-time. Same-origin `/api` reverse proxy is recommended so cookies stay first-party |
| `API_PROXY_TARGET` | http://localhost:8080 | dev/preview proxy only |
