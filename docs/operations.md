# Operations runbook

No production environment exists yet. This runbook describes how the Phase 1 services are meant to be run; it will be completed when hosting is chosen.

## Deploy order

1. `pnpm build`
2. `node apps/api/dist/migrate.js latest` (release step, before new code takes traffic; migrations must be backward compatible with the previous release)
3. Roll out API instances; they become ready when `/health/ready` returns 200.
4. Publish `apps/web/dist` to static hosting/CDN. `index.html` and `sw.js` must be served with `Cache-Control: no-cache`; hashed `assets/*` with `immutable, max-age=31536000`.

## Health and degradation

- `/health/live` never checks dependencies, so a database outage does not cause restart loops.
- `/health/ready` returns 503 when Postgres is unreachable; requests that need the database return `503 service_unavailable` instead of hanging (5 s connect timeout, 10 s statement timeout).
- The web client keeps working from its cached shell and identity when the API is unreachable and shows the offline banner.

## Scaling notes

- Rate limiting is in-memory per instance. Before running more than one instance, switch `@fastify/rate-limit` to its Redis store.
- Feature flags are cached in-process for 30 s; a kill switch takes effect within that window without a redeploy.

## Disaster recovery (to be implemented with hosting)

- Managed Postgres with point-in-time recovery; target RPO ≤ 5 minutes, RTO ≤ 1 hour.
- Quarterly restore drill into a scratch database, running the migration check and API test suite against it.

## Incident checklist

1. Check `/health/ready` and `chatme_http_server_errors_total` by route.
2. Disable the offending feature flag if the incident is feature-scoped.
3. Roll back the API image; migrations are forward-only, so rollbacks rely on backward-compatible schema changes.
