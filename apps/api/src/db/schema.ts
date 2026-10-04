import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';
import type { NotificationSettings, PrivacySettings } from '@chatme/contracts';

// Insert type includes undefined so columns with DB defaults are optional on insert.
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json<T> = ColumnType<T, string, string>;

export interface UsersTable {
  id: Generated<string>;
  username: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  locale: string;
  timezone: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  last_seen_at: NullableTimestamp;
}

export interface UserIdentitiesTable {
  id: Generated<string>;
  user_id: string;
  kind: 'email' | 'phone';
  value: string;
  verified_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  created_at: Timestamp;
}

export interface UserCredentialsTable {
  user_id: string;
  password_hash: string;
  updated_at: Timestamp;
}

export interface UserPreferencesTable {
  user_id: string;
  privacy: Json<PrivacySettings>;
  notifications: Json<NotificationSettings>;
  performance_mode: 'auto' | 'low' | 'normal' | 'high';
  updated_at: Timestamp;
}

export interface DevicesTable {
  id: Generated<string>;
  user_id: string;
  platform: 'web' | 'android' | 'ios' | 'desktop';
  name: string | null;
  app_version: string | null;
  created_at: Timestamp;
  last_seen_at: Timestamp;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  device_id: string;
  token_hash: Buffer;
  created_at: Timestamp;
  last_seen_at: Timestamp;
  expires_at: ColumnType<Date, Date | string, Date | string>;
}

export interface AuditEventsTable {
  id: Generated<string>;
  /** Not a foreign key: audit history must survive account deletion. */
  user_id: string | null;
  session_id: string | null;
  action: string;
  metadata: Json<Record<string, unknown>>;
  created_at: Timestamp;
}

export interface FeatureFlagsTable {
  key: string;
  description: string;
  enabled: boolean;
  rollout_percent: number;
  conditions: Json<FlagConditions>;
  updated_at: Timestamp;
}

export interface FlagConditions {
  platforms?: string[];
  deviceClasses?: string[];
  locales?: string[];
}

export interface VerificationTokensTable {
  id: Generated<string>;
  user_id: string;
  purpose: 'verify_email' | 'reset_password';
  token_hash: Buffer;
  email: string;
  created_at: Timestamp;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  consumed_at: NullableTimestamp;
}

export type EmailStatus = 'pending' | 'sending' | 'sent' | 'failed';

export interface EmailOutboxTable {
  id: Generated<string>;
  /** Not a foreign key: account-deletion notices outlive the user row. */
  user_id: string | null;
  template: string;
  to_address: string;
  subject: string | null;
  html: string | null;
  text_body: string | null;
  status: ColumnType<EmailStatus, EmailStatus | undefined, EmailStatus>;
  attempts: ColumnType<number, number | undefined, number>;
  next_attempt_at: Timestamp;
  locked_until: NullableTimestamp;
  last_error: string | null;
  provider: string | null;
  provider_message_id: string | null;
  created_at: Timestamp;
  sent_at: NullableTimestamp;
}

export interface UserEventSeqTable {
  user_id: string;
  seq: ColumnType<string, string | number, string | number>;
}

export interface UserEventsTable {
  user_id: string;
  /** bigint arrives as a string from node-postgres. */
  seq: ColumnType<string, string | number, string | number>;
  type: string;
  payload: Json<Record<string, unknown>>;
  created_at: Timestamp;
}

export interface RealtimeInstancesTable {
  id: string;
  region: string;
  started_at: Timestamp;
  heartbeat_at: Timestamp;
}

export interface RealtimePresenceTable {
  instance_id: string;
  user_id: string;
  connections: number;
  since: Timestamp;
}

export interface AiUsageTable {
  user_id: string;
  day: ColumnType<string, string, string>;
  requests: ColumnType<number, number | undefined, number>;
  input_tokens: ColumnType<string, string | number | undefined, string | number>;
  output_tokens: ColumnType<string, string | number | undefined, string | number>;
  updated_at: Timestamp;
}

export interface Database {
  users: UsersTable;
  user_identities: UserIdentitiesTable;
  user_credentials: UserCredentialsTable;
  user_preferences: UserPreferencesTable;
  devices: DevicesTable;
  sessions: SessionsTable;
  audit_events: AuditEventsTable;
  feature_flags: FeatureFlagsTable;
  verification_tokens: VerificationTokensTable;
  email_outbox: EmailOutboxTable;
  user_event_seq: UserEventSeqTable;
  user_events: UserEventsTable;
  realtime_instances: RealtimeInstancesTable;
  realtime_presence: RealtimePresenceTable;
  ai_usage: AiUsageTable;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type SessionRow = Selectable<SessionsTable>;
