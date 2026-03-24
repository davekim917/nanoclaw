/**
 * Authentication utilities for the NanoClaw Cockpit.
 *
 * - Password hashing via bcryptjs (10 rounds)
 * - JWT signing/verifying via jsonwebtoken (30-day TTL)
 * - Cookie helpers: set/clear nc_token (HttpOnly, SameSite=Strict)
 * - JWT secret management: persisted in config table, auto-generated if missing
 */
import crypto from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import { getConfigValue, setConfigValue } from './db.js';

const BCRYPT_ROUNDS = 10;
const JWT_TTL_SECONDS = 2_592_000; // 30 days
const COOKIE_NAME = 'nc_token';

// --- Password helpers ---

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// --- JWT helpers ---

export function signJwt(
  payload: { userId: string; role: string },
  secret: string,
): string {
  return jwt.sign(payload, secret, { expiresIn: JWT_TTL_SECONDS });
}

export function verifyJwt(
  token: string,
  secret: string,
): { userId: string; role: string } | null {
  try {
    const decoded = jwt.verify(token, secret) as {
      userId: string;
      role: string;
    };
    if (
      typeof decoded.userId === 'string' &&
      typeof decoded.role === 'string'
    ) {
      return { userId: decoded.userId, role: decoded.role };
    }
    return null;
  } catch {
    return null;
  }
}

// --- Cookie helpers ---

export function parseCookieToken(
  cookieHeader: string | undefined,
): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) {
      return rest.join('=') || null;
    }
  }
  return null;
}

export function setAuthCookie(res: ServerResponse, jwtToken: string): void {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${jwtToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${JWT_TTL_SECONDS}`,
  );
}

export function clearAuthCookie(res: ServerResponse): void {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
  );
}

// --- JWT secret management ---

let cachedSecret: string | null = null;

export function getOrCreateJwtSecret(): string {
  if (cachedSecret) return cachedSecret;

  const stored = getConfigValue('jwt_secret');
  if (stored) {
    cachedSecret = stored;
    return cachedSecret;
  }

  const newSecret = crypto.randomBytes(64).toString('hex');
  setConfigValue('jwt_secret', newSecret);
  cachedSecret = newSecret;
  return cachedSecret;
}

// Exported for tests only — clears the in-memory cache so tests can reset state.
export function _resetSecretCache(): void {
  cachedSecret = null;
}

// Allow req to be IncomingMessage so callers don't need to import it
export { IncomingMessage };
