import { createHash } from 'node:crypto';
import type { FlagConditions } from '../../db/schema.js';

export interface FlagContext {
  /** Stable subject for percentage rollout: user id, or a client-generated install id when signed out. */
  subject: string;
  platform?: string;
  deviceClass?: string;
  locale?: string;
}

export interface FlagDefinition {
  key: string;
  enabled: boolean;
  rollout_percent: number;
  conditions: FlagConditions;
}

/** 0–99 bucket, stable per (flag, subject) so a user does not flip between variants. */
export function bucketOf(flagKey: string, subject: string): number {
  return createHash('sha256').update(`${flagKey}:${subject}`).digest().readUInt32BE(0) % 100;
}

export function evaluateFlag(flag: FlagDefinition, ctx: FlagContext): boolean {
  if (!flag.enabled) return false; // kill switch
  const c = flag.conditions;
  if (c.platforms?.length && (!ctx.platform || !c.platforms.includes(ctx.platform))) return false;
  if (c.deviceClasses?.length && (!ctx.deviceClass || !c.deviceClasses.includes(ctx.deviceClass))) return false;
  if (c.locales?.length && (!ctx.locale || !c.locales.includes(ctx.locale))) return false;
  return bucketOf(flag.key, ctx.subject) < flag.rollout_percent;
}

/** Server-side check of one flag for one user. Unknown flags are off. */
export async function isFlagOn(db: import('../../db/database.js').DB, key: string, ctx: FlagContext): Promise<boolean> {
  const flag = await db.selectFrom('feature_flags').select(['key', 'enabled', 'rollout_percent', 'conditions']).where('key', '=', key).executeTakeFirst();
  return flag ? evaluateFlag(flag, ctx) : false;
}
