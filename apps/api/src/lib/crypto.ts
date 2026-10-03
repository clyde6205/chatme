import { createHash, randomBytes } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

/** 256-bit opaque session token. Only its SHA-256 is stored server-side. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

// OWASP Password Storage Cheat Sheet (2025): Argon2id, m=19 MiB, t=2, p=1.
const ARGON_OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON_OPTS);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(stored, password);
  } catch {
    return false;
  }
}

/**
 * Hash used to spend the same Argon2 work when the account does not exist,
 * so response timing does not reveal which emails are registered.
 */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  return (dummyHash ??= hashPassword(randomBytes(16).toString('hex')));
}
