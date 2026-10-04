# Phase 1 status

Last updated: 2026-10-03. Every item sits in the highest category it has actually reached:

- **IMPLEMENTED**: code exists.
- **TESTED LOCALLY**: automated tests passed in the build environment against real PostgreSQL 16 and headless Chromium.
- **MOCK VERIFIED**: exercised against a local server that implements the external provider's documented API.
- **INTEGRATION VERIFIED**: exercised against the real external service with real credentials.
- **PRODUCTION VERIFIED**: running on the production deployment and checked there.

Decisions: Supabase (PostgreSQL), Fly.io (API + WebSockets, primary region `iad`), Vercel (web/PWA), Resend (email), OpenAI behind the AI Gateway, Android id `pro.chatme.app` (permanent).

## Summary

| Capability | Status |
|---|---|
| Accounts, sessions, devices, profile, preferences, privacy, flags, audit | TESTED LOCALLY |
| Email verification, forgot/reset password, change password, security notices | TESTED LOCALLY (memory provider) |
| Resend adapter | MOCK VERIFIED (request shape, auth, idempotency key, error classification, timeouts) |
| Email outbox (multi-worker, retries, crash recovery) | TESTED LOCALLY |
| Localized email templates, 18 locales, RTL | TESTED LOCALLY |
| Realtime WebSockets: auth, ordering, resume, fan-out across two instances, presence, revocation, limits, heartbeats, drain | TESTED LOCALLY (two API instances in one process sharing Postgres) |
| Web realtime client (backoff, offline, background pause, dead-socket detection) | TESTED LOCALLY (unit) and in e2e (live profile sync, remote sign-out) |
| AI Gateway + OpenAI adapter | MOCK VERIFIED (streaming, usage, failures); disabled by default |
| API Docker image | TESTED LOCALLY: built, migrated, booted, health-checked, WebSocket round trip, SIGTERM exit 0, production guard refuses defaults |
| `fly.toml` | IMPLEMENTED (not deployed) |
| `vercel.json` headers and SPA routing | TESTED LOCALLY (CSP e2e against the production build); not deployed |
| Android id `pro.chatme.app` in app.json, Gradle, Kotlin | IMPLEMENTED + CI guard (no Android build run here) |
| Supabase connection (pooler, direct, TLS verify-full) | IMPLEMENTED; NOT INTEGRATION VERIFIED |
| Resend delivery to a real inbox | NOT INTEGRATION VERIFIED (needs API key and verified domain) |
| OpenAI real call | NOT INTEGRATION VERIFIED (needs API key and model choice) |
| Anything on Fly.io, Vercel, DNS, TLS | NOT VERIFIED: nothing is deployed |
| Nothing | PRODUCTION VERIFIED |

## Tests (all passing locally)

| Suite | Count |
|---|---|
| contracts unit | 4 |
| i18n unit | 21 |
| API integration, real PostgreSQL 16 | 101 (auth 28, platform 20, email 14, recovery 15, realtime 19, AI 5) |
| web unit | 23 |
| e2e, built PWA + API + Postgres, 360×640 Android profile | 12 |

Also run locally: lint, typecheck, i18n validation (0 issues), every migration down to zero and back up, production builds with the web budget (critical path 15.3 KB of 20 KB), `pnpm audit` (0 known vulnerabilities), Docker build and boot, actionlint.

Break tests (each change made the named suite fail, then was reverted): removing single-use token consumption (3 recovery tests), the WebSocket origin check (1), `FOR UPDATE SKIP LOCKED` in the outbox (double send detected), the presence privacy filter (1), the AI flag gate (1), weakening the production CSP (CSP e2e), changing the Android id (guard exits 1). Earlier: CSRF and session-ownership checks.

## Known gaps

- **GitHub Actions does not start** for this repository (startup failure even for a trivial workflow): an account or repository setting, not the code. CI now also builds and boots the API image.
- Per-IP HTTP rate limits are per instance. Per-account email caps, presence and fan-out are global.
- Read replicas and additional regions: documented, not built (`docs/deploy-fly.md`).
- Phone sign-in, passkeys, 2FA, push notifications: NOT IMPLEMENTED.
- Android client rebuild on shared packages, release signing, Baseline Profiles: NOT IMPLEMENTED; the placeholder app has only its id fixed.
- Physical low-end Android testing: NOT DONE (emulated throttling only).
- 17 non-English catalogs, including the new email copy: drafts, NOT human-reviewed.
- No automated accessibility audit yet.
- PWA icons are placeholders; brand assets have not been applied.

## To reach INTEGRATION VERIFIED

1. Supabase project in `us-east-1`: pooler URL, direct URL, CA certificate.
2. Resend: verified sending domain (`mail.chatme.pro`), API key.
3. Fly.io: app `chatme-api`, secrets set, `fly deploy`.
4. Vercel: project on `apps/web`, `VITE_API_URL`, domains.
5. DNS for `chatme.pro`, `www`, `api`, `mail`.
6. OpenAI key and a model id, only when the AI assistant should be switched on.
