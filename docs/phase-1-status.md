# Phase 1 status

Last updated: 2026-10-03. Categories follow the build directive: a capability is only listed as verified when it was actually exercised.

## Implemented

- Repository hygiene: 45,737 committed `node_modules` files and `.expo/` untracked; Expo app relocated to `apps/mobile`; pnpm workspace.
- `packages/contracts`: shared Zod request/response schemas, error codes, locale list.
- `packages/i18n`: 18 locale catalogs (93 strings each), ICU-subset formatter with CLDR plurals, locale negotiation, RTL metadata, catalog validator.
- `apps/api`: config with production safety checks; PostgreSQL schema and migration (users, identities, credentials, preferences, devices, sessions, audit events, feature flags); register, login, logout, session list, revoke one, revoke others, account deletion; profile and preference updates with atomic JSONB merges; CSRF and CORS; rate limiting; Argon2id; log redaction; audit log; feature flag evaluation (kill switch, rollout %, conditions); health/readiness; Prometheus metrics; client performance ingest; expired-session pruning; graceful shutdown.
- `apps/web`: installable PWA (manifest, Workbox service worker, offline shell), static pre-JS shell, capability detection with light/standard/rich modes and user override, sign-in, registration, home, profile, settings (language, time zone, performance, privacy, notifications, quiet hours, account deletion), devices screen, offline/online banner, web-vitals telemetry, per-screen and per-locale code splitting, RTL layout.
- CI workflow: install, lint, typecheck, i18n validation, unit + integration tests on Postgres 16, migration down/up, production builds with web performance budget, dependency audit, Playwright e2e.
- Docs: architecture assessment, API, database, security, i18n, environment, performance, operations.

## Tested (passed locally in the build environment)

| Suite | Count | Notes |
|---|---|---|
| contracts unit | 4 | normalisation, strict schemas, telemetry bounds |
| i18n unit | 21 | formatter, plurals incl. Arabic, negotiation, validator break tests |
| API integration (real PostgreSQL 16) | 48 | auth, CSRF, CORS, concurrency race, expiry, revocation, deletion, rate limit, DB-down 503, metrics, flags, migrations up/down, log secrecy |
| web unit | 15 | capability classification, API client error/timeout mapping |
| e2e (Playwright, built PWA + API + Postgres, 360×640) | 8 | register → profile → reload; duplicate username; Arabic RTL persists; offline reload from service worker; revoke other devices; low-memory → light mode; static shell with JS blocked; slow-3G + 4× CPU cold load 2.4 s |

Mutation check: removing the CSRF check or the ownership filter on session revocation makes 4 API tests fail, so those tests guard real behaviour.

## Verified against real external systems

- PostgreSQL 16 (local instance): migrations, all queries, constraints, cascades.
- Chromium (headless, Playwright): service worker install and offline navigation, RTL rendering, cookie sessions.

## Not verified / not implemented

- **CI on GitHub**: workflow written; see the pull request for whether it has run green.
- **No deployment exists.** No production hosting, domain (CHATme.pro), TLS, CDN or managed database configured.
- **Email delivery**: no provider. Email verification and password recovery are NOT IMPLEMENTED (the schema stores `verified_at`).
- Phone sign-in, passkeys, 2FA: NOT IMPLEMENTED.
- Push notifications: NOT IMPLEMENTED.
- Android client rebuild on shared packages, Baseline Profiles, R8 verification, release signing: NOT IMPLEMENTED (existing placeholder app untouched).
- Physical low-end Android testing: NOT DONE. Performance numbers above are emulated.
- Translations for 17 non-English locales: drafts, NOT human-reviewed.
- Accessibility: semantic markup, labels, focus styles and 48 px targets are in place, but no automated axe audit or screen-reader pass has been run.
- Multi-instance deployment (Redis rate-limit store): NOT IMPLEMENTED.

## Phase 1 quality gate: remaining before Phase 2

1. CI green on GitHub.
2. Choose hosting and deploy API + web to a staging environment.
3. Email provider + verification/recovery flows.
4. Android client rebuilt on shared packages with sign-in, running on a low-RAM device.
5. Automated accessibility checks in e2e.
