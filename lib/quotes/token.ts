import { createHash, randomBytes } from 'node:crypto';

/** 256-bit random URL-safe token for the customer's quote link. Only its hash is stored. */
export function newQuoteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashQuoteToken(token) };
}

export function hashQuoteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Rejects obviously malformed tokens before touching the database. */
export function isWellFormedToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}
