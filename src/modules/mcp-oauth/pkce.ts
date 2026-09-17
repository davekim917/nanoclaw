/**
 * PKCE (RFC 7636) — S256 only.
 *
 * `plain` is deliberately not implemented even though Dropbox's metadata still
 * advertises it: the MCP authorization spec requires S256, both first targets
 * support it, and offering a downgrade here would only ever be selected by a
 * mistake.
 */
import crypto from 'crypto';

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/**
 * RFC 7636 §4.1 puts the verifier between 43 and 128 characters of unreserved
 * ASCII. 32 random bytes base64url-encode to exactly 43, the minimum, which is
 * 256 bits of entropy — more is not stronger, it is just longer.
 */
export function createPkcePair(randomBytes: (n: number) => Buffer = crypto.randomBytes): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier), method: 'S256' };
}

export function pkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** Opaque CSRF value bound to one authorization request (RFC 6749 §10.12). */
export function createState(randomBytes: (n: number) => Buffer = crypto.randomBytes): string {
  return randomBytes(16).toString('base64url');
}
