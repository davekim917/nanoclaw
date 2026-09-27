/**
 * PKCE (RFC 7636), S256 only: the MCP authorization spec requires it, and a
 * `plain` downgrade would only ever be selected by mistake.
 */
import crypto from 'crypto';

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** 32 random bytes base64url-encode to 43 chars, RFC 7636's minimum verifier length (256 bits). */
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
