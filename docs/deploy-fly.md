# Deploying the API to Fly.io

Files: `fly.toml` (repo root), `apps/api/Dockerfile`, `.dockerignore`.

## First deploy

```sh
fly apps create chatme-api
# Secrets (never in fly.toml or the repo):
fly secrets set \
  DATABASE_URL='postgres://...pooler.supabase.com:6543/postgres' \
  REALTIME_DATABASE_URL='postgres://...supabase.co:5432/postgres' \
  MIGRATION_DATABASE_URL='postgres://...supabase.co:5432/postgres' \
  DATABASE_CA_CERT="$(cat supabase-ca.crt)" \
  RESEND_API_KEY='re_...' \
  METRICS_TOKEN="$(openssl rand -hex 24)"
fly deploy                       # builds the image, runs migrations as the release command, rolls out
fly scale count 2 --region iad   # matches min_machines_running
fly certs add api.chatme.pro     # then point a CNAME/AAAA at the app as fly instructs
```

The API refuses to start in production without HTTPS origins, secure cookies, a metrics token, Resend, a non-local sender and database TLS, so a half-configured deploy fails its release instead of running insecurely.

## How a deploy behaves

1. `release_command` runs `node dist/migrate.js latest` once, in a temporary machine. If it fails, nothing is rolled out.
2. Rolling strategy: one machine at a time receives SIGTERM, reports `/health/ready` 503 `draining`, closes its WebSockets with 1012 over 5 s, finishes HTTP requests and exits. Clients reconnect to the other machine with jitter and resume from their cursor.
3. The new machine passes `/health/ready` before taking traffic.

Migrations must stay compatible with the previous version for the length of a rollout (add columns before using them, drop them a release later).

## Regions

Start in `iad` next to Supabase `us-east-1`. Every request talks to Postgres, so an API machine far from the database is slower, not faster. The code already supports any number of machines in any regions (presence, fan-out and outbox all coordinate through Postgres), so expansion is an infrastructure step:

1. Add Postgres read replicas near new regions and route read-heavy endpoints to them (not built yet).
2. `fly scale count 2 --region fra` (Europe), `jnb` (Africa), `sin` (Asia), `gru` (South America).
3. Watch `chatme_http_request_duration_seconds` per region before and after.

Nothing in this repository claims multi-region today: one region is configured and verified.

## Operations

- Logs: `fly logs` (JSON, secrets redacted).
- Metrics: `GET /metrics` with `Authorization: Bearer $METRICS_TOKEN`.
- Scale: `fly scale vm shared-cpu-2x --memory 1024`; keep `REALTIME_MAX_CONNECTIONS` at or below `hard_limit`.
- Rate limits are per machine (in-memory store), so the effective HTTP limit is per-machine limit × machines. Per-account email caps are in Postgres and hold globally. A shared store is on the Phase 2 list.
