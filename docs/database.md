# Database

PostgreSQL 16. Migrations are TypeScript files in `apps/api/src/db/migrations`, registered in `migrations/index.ts`, applied with `pnpm db:migrate [latest|up|down]`. Shipped migrations are never edited; changes go in a new migration. CI applies all migrations, rolls back, and re-applies them.

## Phase 1 tables

| Table | Purpose | Notable constraints and indexes |
|---|---|---|
| `users` | Identity root: username, display name, avatar, bio, locale, time zone | `users_username_key` unique; check `username = lower(username)`; bio ≤ 280 |
| `user_identities` | Login identifiers (`email` now, `phone` ready) and verification state | unique `(kind, value)` for login lookup and one-account-per-email |
| `user_credentials` | Argon2id password hash, separate from profile data so profile queries never touch it | PK `user_id` |
| `user_preferences` | `privacy` and `notifications` JSONB, `performance_mode` | partial updates use `jsonb ||` for atomic merges |
| `devices` | One row per signed-in client install (platform, label, app version, last seen) | `devices_user_id_idx` |
| `sessions` | SHA-256 of the session token, expiry, last seen. Owned by a device; deleting the device revokes the session | unique `token_hash` (hot path), `user_id`, `expires_at` (pruning) |
| `audit_events` | Security-relevant actions. `user_id` is deliberately **not** a foreign key so history survives account deletion | `(user_id, created_at desc)` |
| `feature_flags` | Kill switch, percentage rollout, platform / device-class / locale conditions | key format check, `rollout_percent` 0–100 |

## Email and recovery (0002)

| Table | Purpose | Notes |
|---|---|---|
| `verification_tokens` | Email verification and password-reset tokens | SHA-256 only; unique `token_hash`; `(user_id, purpose, created_at)`; consumed by one conditional `UPDATE`, so concurrent uses cannot both win |
| `email_outbox` | Transactional email queue | no FK on `user_id` (deletion notices); partial indexes for due `pending` rows and stuck `sending` rows; rendered content nulled on send or failure; pruned after 30 days |

## Realtime (0003)

| Table | Purpose | Notes |
|---|---|---|
| `user_event_seq` | Per-user event counter | row lock until commit makes commit order equal seq order |
| `user_events` | Per-user ordered event log for resume | PK `(user_id, seq)`; pruned after 7 days |
| `realtime_instances` | Live API instances and heartbeats | swept by survivors when stale |
| `realtime_presence` | Users connected per instance | cascades from the instance |
| `users.last_seen_at` | Last disconnect time | shown subject to `privacy.showPresence` |

## AI Gateway (0004)

`ai_usage (user_id, day)`: requests and tokens per UTC day for budgets. No prompts or outputs are stored. Seeds the `ai.assistant` flag, disabled.

All foreign keys from user-owned tables use `ON DELETE CASCADE`, so account deletion is one statement inside a transaction.

## Indexing policy

An index is added only for a query that exists in code, and the migration comments name that query. Planned Phase 2 tables (conversations, members, messages, attachments, reactions, read states) will be load-tested with realistic volumes before their indexes are finalised.

## Data retention

- Hourly housekeeping on every instance: expired sessions (and their device rows), verification tokens a day past expiry, outbox rows older than 30 days, user events older than 7 days.
- Account deletion removes all personal rows immediately; the audit trail keeps only the action, user id and timestamp.
