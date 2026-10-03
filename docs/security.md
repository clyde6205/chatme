# Security

| Control | Implementation | Verified by |
|---|---|---|
| Password storage | Argon2id, m=19 MiB, t=2, p=1 (OWASP 2025). Max length 128 to cap hashing cost. | `auth.test.ts` asserts `$argon2id$` and no plaintext |
| Account enumeration | Login spends one Argon2 verify even for unknown emails; same error code for unknown email and wrong password | `auth.test.ts` |
| Session tokens | 256-bit random, only SHA-256 stored, instantly revocable, idle and absolute expiry | `auth.test.ts` |
| Web token handling | `httpOnly`, `SameSite=Lax`, `Secure` + `__Host-` prefix in production; token never in response body for web | `auth.test.ts`, `platform.test.ts` |
| CSRF | Custom header required on non-bearer mutations (forces CORS preflight) + Origin allow-list; covers login CSRF | `auth.test.ts` (and mutation-tested: removing the check fails 3 tests) |
| CORS | Explicit origin allow-list with credentials | `auth.test.ts` |
| Authorization | Every user-scoped query filters by the session's `user_id`; cross-user session revoke returns 404 | `auth.test.ts` (mutation-tested) |
| Input validation | Zod contracts, strict objects (no mass assignment), control characters rejected in names | contract + API tests |
| Rate limiting | Global per-IP; auth routes per IP+email; telemetry separately | `platform.test.ts` |
| Secrets in logs | pino redaction for auth headers, cookies, `password`, `token`, hashes | `auth.test.ts` scans captured logs |
| Security headers | helmet; API CSP `default-src 'none'`, `frame-ancestors 'none'` | — |
| Unsafe production config | Boot fails without `COOKIE_SECURE`, `METRICS_TOKEN`, https origins and base URL, Resend, a verified sender, database TLS | `platform.test.ts`; the Docker image refuses to start with defaults |
| Email tokens | 256-bit, SHA-256 stored, single use via one conditional `UPDATE`, 24 h (verify) / 1 h (reset), newer link invalidates older, delivered in the URL fragment and stripped from the address bar | `recovery.test.ts` (concurrent-use race, expiry, purpose mix-up, reuse; mutation-tested) |
| Recovery enumeration | Forgot-password always 202 with an identical body; lookup and enqueue run after the response | `recovery.test.ts` |
| Email abuse caps | Per-account caps from the audit log (5 verify, 3 reset per hour) in addition to per-IP limits; hold across instances | `recovery.test.ts` |
| Session revocation | Password reset signs out everywhere; password change signs out other devices; both burn outstanding reset links and send a notice; WebSockets of revoked sessions close at once on every instance | `recovery.test.ts`, `realtime.test.ts` |
| Email content | Templates escape every user value and strip control and bidi-override characters from names | `email.test.ts` |
| Email delivery | Provider key only in server env; idempotency key per message; rendered bodies (which contain links) cleared once sent | `email.test.ts` against a local Resend mock |
| WebSocket | Origin allow-list for cookie-authenticated upgrades (CSWSH), 4 KiB frames, frame-rate limit, per-user and per-instance connection caps, session re-validation | `realtime.test.ts` (origin check mutation-tested) |
| Presence privacy | `showPresence=false` users and unknown ids look identical (offline, no last-seen) | `realtime.test.ts` (mutation-tested) |
| AI Gateway | Keys server-side only; server-owned system prompt (client `system` messages rejected); hashed end-user id to the provider; per-user daily budget and one request at a time; behind a flag that is off by default; prompts not stored | `ai.test.ts` against a local OpenAI mock |
| Web CSP | `vercel.json`: `script-src 'self'`, `connect-src` limited to the API, `frame-ancestors 'none'`, HSTS | `e2e/csp.spec.ts` boots the built app under the real headers |
| Audit trail | register, login, failed login, logout, session revocations, username change, account deletion | `auth.test.ts`, `platform.test.ts` |
| Dependency audit | `pnpm audit --audit-level high --prod` in CI | CI |

## Not yet implemented

- Passkeys / WebAuthn, phone sign-in, 2FA.
- Shared rate-limit store across API instances (per-IP HTTP limits are per machine today; per-account email caps are already global).
- Content scanning, upload validation (arrives with media in Phase 2).
- Block / report / moderation (Trust & Safety, Phase 2 and 5).

Never log passwords, tokens, cookies, provider keys or credentials. Report vulnerabilities privately to the repository owner.
