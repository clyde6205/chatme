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
| Unsafe production config | Boot fails without `COOKIE_SECURE`, `METRICS_TOKEN`, https origins | `platform.test.ts` |
| Audit trail | register, login, failed login, logout, session revocations, username change, account deletion | `auth.test.ts`, `platform.test.ts` |
| Dependency audit | `pnpm audit --audit-level high --prod` in CI | CI |

## Not yet implemented

- Email verification and password recovery delivery (needs an email provider; tokens and UI come with it).
- Passkeys / WebAuthn, phone sign-in, 2FA.
- Distributed rate limiting (Redis store) for more than one API instance.
- Content scanning, upload validation (arrives with media in Phase 2).
- Block / report / moderation (Trust & Safety, Phase 2 and 5).

Never log passwords, tokens, cookies, provider keys or credentials. Report vulnerabilities privately to the repository owner.
