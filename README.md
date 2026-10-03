# CHATme

**Work. Play. Stay Connected. Global with CHATme.**

CHATme is a communication-first platform: chat is the front door, and AI, fun, communities and work tools live inside the conversation. This repository holds the whole platform.

## Status

Phase 1 (Foundation) is in progress. See [docs/architecture-assessment.md](docs/architecture-assessment.md) for the inspection of the original repository and the target architecture, and [docs/phase-1-status.md](docs/phase-1-status.md) for exactly what is implemented, tested and verified.

## Layout

| Path | What |
|---|---|
| `apps/api` | Node 22 + Fastify API (modular monolith), PostgreSQL via Kysely |
| `apps/web` | Preact PWA, mobile-first, offline shell |
| `apps/mobile` | Expo / React Native Android client (pre-existing app, relocated; rebuild planned) |
| `packages/contracts` | Shared Zod schemas and types for API requests and responses |
| `packages/i18n` | 18 locale catalogs, ICU-subset formatter, catalog validator |
| `docs/` | Architecture, database, API, security, i18n, performance, operations |

## Quick start

Requirements: Node 22, pnpm 10, PostgreSQL 16.

```bash
pnpm install
cp apps/api/.env.example apps/api/.env      # set DATABASE_URL
pnpm db:migrate
pnpm dev:api                                # http://localhost:8080
pnpm dev:web                                # http://localhost:5173 (proxies /api to the API)
```

## Quality gates

```bash
pnpm lint && pnpm typecheck && pnpm i18n:check
TEST_DATABASE_URL=postgres://… pnpm test     # unit + integration against real Postgres
pnpm build                                   # production builds + web performance budget
pnpm --filter @chatme/web e2e                # Playwright against the built PWA + API
```

CI runs all of the above on every pull request (`.github/workflows/ci.yml`).
