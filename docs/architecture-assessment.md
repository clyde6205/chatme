# CHATme — Initial Architecture Assessment

Date: 2026-10-03 · Repository: `clyde6205/chatme` · Base commit: `c00866a7` (main)

## 1. What exists today (inspected, not assumed)

| Area | Finding | Evidence |
|---|---|---|
| Git status | Clean working tree on `main`, tracking `origin/main`. 18 commits, last 2026-01-23. | `git status`, `git log` |
| Branches | `main`, `clyde6205-patch-1` (older; adds a default `node.js.yml` workflow and stray `package.json1`/`app.json1` files). | `git branch -a` |
| Remote | `https://github.com/clyde6205/chatme` (private). | `git remote -v` |
| Tracked files | 45,784 files, of which **45,737 are `node_modules/`**. `.git` is 109 MB. | `git ls-files` |
| Package manager | npm (`package-lock.json`, lockfile v3). | repo root |
| Runtime / framework | Expo SDK 54, React Native 0.81.5, React 19.1, Hermes. Android only (`platforms: ["android"]`). | `app.json`, `package.json` |
| Application code | One file, `app.js` (20 lines): a centered "chatmepro / Running in Expo Go" label. No navigation, no state, no networking. | `app.js` |
| Database | None. `expo-sqlite` and `react-native-sqlite-storage` are both declared but never imported. | grep |
| Authentication | None. | grep |
| API architecture | None. No backend exists. | repo tree |
| Tests | None. No test runner configured. | `package.json` |
| Environment config | None (`.env*` absent). `app.json` embeds `extra.streamApiKey` (a Stream Chat *public* key; not a secret by Stream's design, but it hard-wires a vendor). | `app.json` |
| CI/CD | None on `main`. `clyde6205-patch-1` has GitHub's stock Node template, never merged. | `.github/` |
| Deployment | `android/` native project (prebuild output). Release build is signed with the **debug keystore**. `namespace`/`applicationId` is `com.chatmepro`, but Kotlin sources live in `com.clyde6205.chatmepro` and `app.json` says `com.clyde6205.chatmepro`: three disagreeing identifiers. | `android/app/build.gradle` |
| Assets | `icon.png`, `splash.png`, `favicon.png` are **0 bytes**; `adaptive-icon.png` is 33 bytes (not a valid image). | `ls -la assets` |
| Dependencies of note | `stream-chat-expo`, `stream-chat-react-native`, `stream-chat-react-native-core` (three overlapping majors, unused); `react-native-voice@0.3.0` (unmaintained since 2019, unused). | `package.json` |

Environment available to this build session: Node 22.22, npm 10.9, pnpm 10.28, PostgreSQL 16 binaries, JDK, 4 vCPU / 15 GB RAM. No Docker daemon, no Android SDK/emulator, no physical devices.

## 2. Reusable vs. replace

**Reusable**
- The decision to use Expo/React Native for Android. It lets Android share TypeScript contracts, i18n catalogs and API client code with the PWA. Keep.
- `android/` gradle setup as a reference for Hermes, R8 (`enableMinifyInReleaseBuilds`) and resource shrinking flags.
- Brand name and the `chatmepro` slug.

**Must be replaced or fixed (with evidence)**
- Committed `node_modules/` (4.9M lines, 109 MB history): breaks clean installs and reviews. Remove from tracking, add `.gitignore`.
- Committed `.expo/` machine-local folder: remove (Expo's own README in that folder says not to commit it).
- Empty/invalid image assets: the app cannot build a valid icon/splash. Replace with real brand assets.
- Release signing with debug keystore: must never ship. Production signing via CI secrets.
- Package identifier mismatch: pick one (`pro.chatme.app` recommended, matching the domain) before the first Play Store upload, because it cannot change afterwards.
- Stream Chat dependency: conflicts with the directive's provider-neutral, owned-backend requirement for chat. Chat will be served by CHATme's own realtime service (Phase 2). Remove unused packages.
- `app.json` description targets "rural African farmers"; the directive requires one global product. Update copy.

Nothing in the repository is working product functionality beyond the placeholder screen, so restructuring destroys no working features. The placeholder screen is preserved by moving the Expo app to `apps/mobile/`.

## 3. Target architecture

```text
chatme/
├── apps/
│   ├── api/        Node 22 + TypeScript + Fastify. Modular monolith (one deployable, strict module boundaries).
│   ├── web/        Vite + Preact PWA. Mobile-first, offline shell, code-split per module.
│   └── mobile/     Expo / React Native Android client (existing app, relocated; rebuilt on shared packages).
├── packages/
│   ├── contracts/  Zod schemas + TS types shared by API, web and mobile (single source of API truth).
│   └── i18n/       Locale catalogs, formatter helpers, RTL metadata, catalog validator.
├── docs/           Architecture, database, API, security, i18n, performance, operations.
└── .github/        CI.
```

### Why a modular monolith first
Directive priorities are Security > Reliability > Speed > Simplicity. One deployable with enforced module folders (`auth`, `users`, `sessions`, `observability`, later `chat`, `realtime`, `ai`, `fun`, …) gives clear boundaries without distributed-systems cost before there are users (§54). Modules communicate through explicit service interfaces, so any module (realtime, AI gateway, media) can be extracted into its own service when load or ownership demands it.

### Key technology decisions

| Concern | Choice | Reason |
|---|---|---|
| API framework | Fastify 5 | Low overhead, schema-first, mature plugin set (cookies, rate-limit, helmet). |
| Database | PostgreSQL 16 | Real relational DB (§31); JSONB for preferences; strong indexing. |
| Query layer | Kysely | Typed SQL without an ORM runtime; transparent queries for performance work. |
| Migrations | Kysely Migrator, versioned TS files, forward-only in production | Reviewed, ordered, testable (CI runs up + down on a scratch DB). |
| Validation | Zod schemas in `packages/contracts` | Same validation on server and clients; server is authoritative. |
| Passwords | Argon2id (`@node-rs/argon2`) | Current OWASP recommendation; prebuilt binaries, no node-gyp. |
| Sessions | Opaque 256-bit random tokens, only SHA-256 hash stored; httpOnly Secure cookie for web, bearer header for native | Instantly revocable (logout other devices, account deletion), nothing sensitive in the client. |
| CSRF | Cookie-authenticated mutating requests require `Origin` allow-list match **and** a custom header | Blocks cross-site form posts; bearer clients are not CSRF-exposed. |
| Rate limiting | `@fastify/rate-limit`, per-IP and per-route; Redis store when horizontally scaled | Auth brute force protection from Day 1. |
| Logging | pino with redaction of `authorization`, `cookie`, `password`, `token` paths | §23 "never log secrets", enforced by a test. |
| Metrics | Prometheus `/metrics` (prom-client), HTTP latency histograms, DB pool gauges; client web-vitals ingest endpoint | §30 performance observability. |
| Web | Vite + Preact 10 (React-compatible API, ~4 KB runtime), `preact-iso` router, `vite-plugin-pwa` (Workbox) | Static, CDN-cacheable shell; no server render dependency for first paint (§43). Preact was chosen over React to cut the startup bundle by roughly 40 KB gzip for low-end devices. |
| Web state | One context store; identity snapshot in localStorage (synchronous read, so the signed-in shell renders with no await); IndexedDB arrives with chat history in Phase 2 | Minimal JS shipped (§4). |
| i18n | ICU-style messages via `Intl.PluralRules`/`Intl.DateTimeFormat`/`Intl.NumberFormat`, lazy-loaded per locale | Zero-dependency formatting, 18 locales, RTL for `ar` and `ur`. |
| Android | Expo (React Native, Hermes) + shared TS packages; R8, resource shrinking, Baseline Profile plugin | Code sharing with web; native performance levers still available. |
| Realtime (Phase 2) | WebSocket gateway inside the API, Postgres as source of truth, Redis pub/sub when multi-node | Ordered, idempotent delivery with client message IDs. |
| Voice/video (later) | `CallProvider` interface; LiveKit (self-hostable) as first adapter candidate | §9 replaceable provider. |
| AI (Phase 3) | `AIProvider` interface + gateway with routing tiers, quotas, metering | §10–13. Provider secrets server-side only. |

### Startup and performance strategy (Day 1)
- Web shell HTML + critical CSS inline; JS entry budget enforced in CI (`size-limit`-style check on built assets).
- No network request blocks first render: the shell renders from the cached identity snapshot and then revalidates `/v1/me`.
- Route-level code splitting: auth, settings, and every future module (chat, AI, fun) are separate chunks.
- Capability detection (`navigator.deviceMemory`, `hardwareConcurrency`, Network Information API, `prefers-reduced-motion`, `saveData`, storage estimate) decides LOW / NORMAL / HIGH mode; user can override.

### Data model (Phase 1 tables)
`users`, `user_identities` (email/phone/passkey ready), `user_profiles`, `user_preferences` (locale, timezone, privacy, notification settings as typed JSONB), `devices`, `sessions`, `verification_tokens`, `audit_events`, `feature_flags`. Later phases add conversations, messages, attachments, reactions, read states, communities, rooms, notifications, AI requests/usage, referrals, reports, moderation. Full schema in `docs/database.md`.

## 4. Phase 1 scope (this phase)

Delivered in this PR series, each item classified honestly at the end of the phase:

1. Repository hygiene (untrack `node_modules`, `.expo`; workspace layout; relocate Expo app).
2. `packages/contracts`, `packages/i18n` with catalog validator.
3. API: config validation, Postgres + migrations, auth (register, login, logout, logout-others, session list, account deletion), profile read/update, preferences, health/readiness, metrics, audit log, rate limiting, CSRF, log redaction.
4. Web PWA: offline shell, service worker, manifest, capability detection + LOW/NORMAL/HIGH mode, auth screens, profile and settings screens, sessions/devices screen, language picker with RTL.
5. CI: install, lint, typecheck, unit + integration tests against real Postgres, migration up/down check, i18n validation, builds, bundle budget.
6. Docs: architecture, database, API, security, i18n, environment, performance budgets.

Explicitly **not** in Phase 1 (deferred, not faked): email/SMS delivery provider (verification and recovery tokens are generated and stored; a provider adapter is required before production), passkeys (schema-ready), push notifications, Android rebuild on shared packages (Phase 1b), on-device performance measurement (needs physical low-end hardware this environment does not have).

## 5. Risks and open decisions

- **Android package ID** must be decided before the first Play Store release. Recommendation: `pro.chatme.app`.
- **Translations**: non-English catalogs produced in this phase are drafts and are marked `status: "draft"` in the locale manifest. The validator blocks marking a locale `reviewed` without passing all checks; human review is required before claiming production quality (§19).
- **Hosting**: no deployment target is configured. Recommendation: managed Postgres + container host for the API, CDN static hosting for the PWA. Needs your choice and credentials.
- **Low-end device testing** (§42) cannot be performed in this cloud environment. It needs physical devices or a device farm.
