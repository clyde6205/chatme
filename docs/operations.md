# Operations runbook

Hosting is decided: API on Fly.io (`docs/deploy-fly.md`), web on Vercel (`docs/deploy-vercel.md`), PostgreSQL on Supabase, email via Resend (`docs/providers.md`). Nothing is deployed yet; this runbook describes how the services are run once credentials exist.

## Deploy order

1. `pnpm build`
2. `node apps/api/dist/migrate.js latest` (release step, before new code takes traffic; migrations must be backward compatible with the previous release)
3. Roll out API instances; they become ready when `/health/ready` returns 200.
4. Publish `apps/web/dist` to static hosting/CDN. `index.html` and `sw.js` must be served with `Cache-Control: no-cache`; hashed `assets/*` with `immutable, max-age=31536000`.

## Health and degradation

- `/health/live` never checks dependencies, so a database outage does not cause restart loops.
- `/health/ready` returns 503 when Postgres is unreachable or the instance is draining; requests that need the database return `503 service_unavailable` instead of hanging (5 s connect timeout, 10 s query timeout; set a role-level `statement_timeout` too).
- Realtime bus down: HTTP keeps working, `/health/ready` reports `realtime.ok=false`, the bus reconnects with backoff and every socket catches up from the event log afterwards.
- Email provider down: messages stay in `email_outbox` and retry with backoff (up to 8 attempts over several hours); `chatme_email_outbox_results_total{status="retry"}` rises. A stuck `sending` row is recovered after 60 s.
- The web client keeps working from its cached shell and identity when the API is unreachable and shows the offline banner.

## Scaling notes

- Realtime, presence, the email outbox and per-account email caps coordinate through Postgres, so any number of API instances can run.
- Per-IP HTTP rate limiting is in-memory per instance; the effective limit is the per-instance limit times the number of instances until a shared store is added.
- Feature flags are cached in-process for 30 s; a kill switch takes effect within that window without a redeploy.

## Disaster recovery (to be implemented with hosting)

- Managed Postgres with point-in-time recovery; target RPO ≤ 5 minutes, RTO ≤ 1 hour.
- Quarterly restore drill into a scratch database, running the migration check and API test suite against it.

## Useful queries

```sql
-- Email backlog and failures
select status, count(*), min(next_attempt_at) from email_outbox group by status;
select template, last_error, count(*) from email_outbox where status = 'failed' and created_at > now() - interval '1 day' group by 1, 2;
-- Live realtime instances and connected users
select i.id, i.region, i.heartbeat_at, count(p.user_id) users from realtime_instances i left join realtime_presence p on p.instance_id = i.id group by i.id;
```

## Incident checklist

1. Check `/health/ready` and `chatme_http_server_errors_total` by route.
2. Disable the offending feature flag if the incident is feature-scoped.
3. Roll back the API image; migrations are forward-only, so rollbacks rely on backward-compatible schema changes.
