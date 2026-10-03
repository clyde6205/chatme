import type { Me, NotificationSettings, PrivacySettings } from '@chatme/contracts';
import { DEFAULT_LOCALE } from '@chatme/contracts';
import type { DB } from '../../db/database.js';
import { notFound } from '../../lib/errors.js';

/** Privacy-protective defaults: discoverable by username, contacts-only for unsolicited contact. */
export const DEFAULT_PRIVACY: PrivacySettings = {
  profileVisibility: 'everyone',
  whoCanMessage: 'everyone',
  whoCanAddToGroups: 'contacts',
  showPresence: true,
  sendReadReceipts: true,
  discoverable: true,
};

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  messages: true,
  mentions: true,
  calls: true,
  groupActivity: true,
  communityActivity: false,
  quietHours: { enabled: false, start: '22:00', end: '07:00' },
};

export async function getMe(db: DB, userId: string): Promise<Me> {
  const row = await db
    .selectFrom('users as u')
    .innerJoin('user_identities as i', (j) => j.onRef('i.user_id', '=', 'u.id').on('i.kind', '=', 'email'))
    .innerJoin('user_preferences as p', 'p.user_id', 'u.id')
    .select([
      'u.id', 'u.username', 'u.display_name', 'u.avatar_url', 'u.bio', 'u.locale', 'u.timezone', 'u.created_at',
      'i.value as email', 'i.verified_at',
      'p.privacy', 'p.notifications', 'p.performance_mode',
    ])
    .where('u.id', '=', userId)
    .executeTakeFirst();
  if (!row) throw notFound();
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.verified_at !== null,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    locale: (row.locale as Me['locale']) ?? DEFAULT_LOCALE,
    timezone: row.timezone,
    privacy: { ...DEFAULT_PRIVACY, ...row.privacy },
    notifications: { ...DEFAULT_NOTIFICATIONS, ...row.notifications },
    performanceMode: row.performance_mode,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
