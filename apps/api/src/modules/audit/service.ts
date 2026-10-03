import type { DB } from '../../db/database.js';

/** Actions recorded for security-sensitive operations. Metadata must never contain secrets. */
export type AuditAction =
  | 'auth.register'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.session_revoked'
  | 'auth.sessions_revoked_others'
  | 'account.deleted'
  | 'profile.username_changed';

export async function recordAudit(
  db: Pick<DB, 'insertInto'>,
  event: { action: AuditAction; userId?: string | null; sessionId?: string | null; metadata?: Record<string, unknown> },
) {
  await db
    .insertInto('audit_events')
    .values({
      action: event.action,
      user_id: event.userId ?? null,
      session_id: event.sessionId ?? null,
      metadata: JSON.stringify(event.metadata ?? {}),
    })
    .execute();
}
