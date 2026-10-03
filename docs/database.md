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

All foreign keys from user-owned tables use `ON DELETE CASCADE`, so account deletion is one statement inside a transaction.

## Indexing policy

An index is added only for a query that exists in code, and the migration comments name that query. Planned Phase 2 tables (conversations, members, messages, attachments, reactions, read states) will be load-tested with realistic volumes before their indexes are finalised.

## Data retention

- Expired sessions (and their device rows) are pruned hourly by the API process.
- Account deletion removes all personal rows immediately; the audit trail keeps only the action, user id and timestamp.
