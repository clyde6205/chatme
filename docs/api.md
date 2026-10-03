# API

Base path: `/v1`. JSON only. Every response carries `x-request-id`.

## Authentication

| Client | Mechanism |
|---|---|
| Web (`device.platform = "web"`) | `httpOnly`, `SameSite=Lax` session cookie (`__Host-chatme_session` when `COOKIE_SECURE=true`). The token never reaches JavaScript. |
| Native (`android`, `ios`, `desktop`) | `token` in the register/login response; send `Authorization: Bearer <token>`. Store it in the platform keystore. |

**CSRF rule:** every `POST`/`PATCH`/`DELETE` without a bearer token must send `x-chatme-csrf: 1`, and if an `Origin` header is present it must be in `WEB_ORIGINS`. Otherwise the API answers `403 csrf_failed`.

Sessions expire after `SESSION_TTL_DAYS` (default 90) or `SESSION_IDLE_DAYS` of inactivity (default 30).

## Errors

```json
{ "error": { "code": "validation_failed", "requestId": "…", "fields": { "email": ["Invalid email"] } } }
```

Codes: `validation_failed` 400, `unauthenticated` 401, `invalid_credentials` 401, `csrf_failed` 403, `forbidden` 403, `not_found` 404, `conflict_email` 409, `conflict_username` 409, `rate_limited` 429, `internal` 500, `service_unavailable` 503. Clients translate codes via `errors.<code>` in the i18n catalogs; the API never returns user-facing prose.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/auth/register` | none | Create account + first session. Body: `registerRequestSchema`. 201. Rate limited per IP+email. |
| POST | `/v1/auth/login` | none | New session for a new device. Body: `loginRequestSchema`. Rate limited per IP+email. |
| POST | `/v1/auth/logout` | yes | Revoke the current session. 204. |
| GET | `/v1/me` | yes | Current user (`meSchema`). |
| PATCH | `/v1/me/profile` | yes | `displayName`, `username`, `bio`. Strict schema. |
| PATCH | `/v1/me/preferences` | yes | `locale`, `timezone`, `performanceMode`, partial `privacy`, partial `notifications`. Partial updates merge atomically. |
| POST | `/v1/me/delete` | yes | Permanently delete the account. Body `{ password }`. 204. |
| GET | `/v1/sessions` | yes | Active sessions/devices, current one flagged. |
| DELETE | `/v1/sessions/:id` | yes | Revoke one of your sessions. 204, or 404 if not yours. |
| POST | `/v1/sessions/revoke-others` | yes | Revoke every session except the current one. Returns `{ revoked }`. |
| GET | `/v1/flags` | optional | Evaluated feature flags. Query: `installId`, `platform`, `deviceClass`, `locale`. |
| POST | `/v1/telemetry/perf` | none | Anonymous performance samples (`perfReportSchema`). 202. |
| GET | `/health/live` | none | Process liveness (no dependency checks). |
| GET | `/health/ready` | none | Database reachability; 503 when degraded. |
| GET | `/metrics` | `Bearer METRICS_TOKEN` | Prometheus metrics. |

Request and response schemas live in `packages/contracts/src` and are shared by every client.
