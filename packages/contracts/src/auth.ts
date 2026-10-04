import { z } from 'zod';
import { SUPPORTED_LOCALES } from './locales.js';

/** Lowercase letters, digits and underscores; must start with a letter. */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(30)
  .regex(/^[a-z][a-z0-9_]*$/, 'username_format');

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

/**
 * Length is the primary strength control (NIST SP 800-63B). 128 chars caps
 * Argon2 work per request so the field cannot be used for CPU exhaustion.
 */
export const passwordSchema = z.string().min(10).max(128);

export const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  // Reject control characters, which break rendering and enable spoofing.
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'display_name_control_chars');

export const localeSchema = z.enum(SUPPORTED_LOCALES);

export const timezoneSchema = z
  .string()
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'invalid_timezone');

export const devicePlatformSchema = z.enum(['web', 'android', 'ios', 'desktop']);

export const deviceInfoSchema = z.object({
  platform: devicePlatformSchema,
  /** Human-readable label, e.g. "Chrome on Android". Never trusted for security decisions. */
  name: z.string().trim().max(100).optional(),
  appVersion: z.string().trim().max(32).optional(),
});

export const registerRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  username: usernameSchema,
  displayName: displayNameSchema,
  locale: localeSchema.optional(),
  timezone: timezoneSchema.optional(),
  device: deviceInfoSchema,
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
  device: deviceInfoSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const authResponseSchema = z.object({
  user: z.lazy(() => meSchema),
  /** Returned only to native clients (bearer auth). Web clients receive an httpOnly cookie instead. */
  token: z.string().optional(),
  sessionId: z.string().uuid(),
});

export const sessionSchema = z.object({
  id: z.string().uuid(),
  current: z.boolean(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
  device: z.object({
    id: z.string().uuid(),
    platform: devicePlatformSchema,
    name: z.string().nullable(),
    appVersion: z.string().nullable(),
  }),
});
export type Session = z.infer<typeof sessionSchema>;

export const deleteAccountRequestSchema = z.object({
  password: z.string().min(1).max(128),
});

export const privacyLevelSchema = z.enum(['everyone', 'contacts', 'nobody']);

export const privacySettingsSchema = z.object({
  profileVisibility: privacyLevelSchema,
  whoCanMessage: privacyLevelSchema,
  whoCanAddToGroups: privacyLevelSchema,
  showPresence: z.boolean(),
  sendReadReceipts: z.boolean(),
  discoverable: z.boolean(),
});
export type PrivacySettings = z.infer<typeof privacySettingsSchema>;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const notificationSettingsSchema = z.object({
  messages: z.boolean(),
  mentions: z.boolean(),
  calls: z.boolean(),
  groupActivity: z.boolean(),
  communityActivity: z.boolean(),
  quietHours: z
    .object({ enabled: z.boolean(), start: hhmm, end: hhmm })
    .strict(),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export const performanceModeSchema = z.enum(['auto', 'low', 'normal', 'high']);

export const meSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  emailVerified: z.boolean(),
  username: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  bio: z.string().nullable(),
  locale: localeSchema,
  timezone: z.string(),
  privacy: privacySettingsSchema,
  notifications: notificationSettingsSchema,
  performanceMode: performanceModeSchema,
  createdAt: z.string(),
});
export type Me = z.infer<typeof meSchema>;

export const updateProfileRequestSchema = z
  .object({
    displayName: displayNameSchema,
    bio: z.string().trim().max(280).nullable(),
    username: usernameSchema,
  })
  .partial()
  .strict();

export const updatePreferencesRequestSchema = z
  .object({
    locale: localeSchema,
    timezone: timezoneSchema,
    privacy: privacySettingsSchema.partial().strict(),
    notifications: notificationSettingsSchema.partial().strict(),
    performanceMode: performanceModeSchema,
  })
  .partial()
  .strict();

/** Single-use tokens from email links (verification, password reset). 256-bit base64url. */
export const emailTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'token_format');

export const verifyEmailRequestSchema = z.object({ token: emailTokenSchema }).strict();

export const forgotPasswordRequestSchema = z.object({ email: emailSchema }).strict();

export const resetPasswordRequestSchema = z.object({ token: emailTokenSchema, password: passwordSchema }).strict();

export const changePasswordRequestSchema = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema })
  .strict()
  .refine((v) => v.currentPassword !== v.newPassword, { message: 'password_unchanged', path: ['newPassword'] });
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
