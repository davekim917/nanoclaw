/**
 * CORS middleware and JSON body parser utility for the API gateway.
 *
 * CORS behavior:
 * - When WEB_UI_ORIGINS is empty: no CORS headers sent (same-origin only).
 * - When set: matched-origin headers; OPTIONS preflight returns 204.
 * - Non-matching origins get no CORS headers.
 * - Never uses '*' for Access-Control-Allow-Origin.
 */
import { IncomingMessage, ServerResponse } from 'http';

import { WEB_UI_ORIGINS } from '../config.js';

const ALLOWED_METHODS = 'GET, POST, PATCH, OPTIONS';
const ALLOWED_HEADERS = 'Authorization, Content-Type';
const MAX_AGE = '86400'; // 24 hours

/**
 * Apply CORS headers if the request's Origin matches WEB_UI_ORIGINS.
 * Returns true if this was an OPTIONS preflight (response already sent).
 * Returns false if request should continue to route matching.
 */
export function handleCors(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const origin = req.headers.origin;

  // No Origin header (same-origin request or non-browser) — skip CORS
  if (!origin) return false;

  // No allowed origins configured — skip CORS (same-origin mode only)
  if (WEB_UI_ORIGINS.length === 0) return false;

  // Check if this origin is in the allowlist
  if (!WEB_UI_ORIGINS.includes(origin)) {
    // Non-matching origin — no CORS headers, but don't block the request
    // (the browser will reject the response without CORS headers)
    if (req.method === 'OPTIONS') {
      res.writeHead(403);
      res.end();
      return true;
    }
    return false;
  }

  // Origin matches — add CORS headers
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  res.setHeader('Access-Control-Max-Age', MAX_AGE);

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  return false;
}

/**
 * Error type for body parsing failures, includes HTTP status code.
 */
export class BodyParseError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'BodyParseError';
  }
}

/**
 * Parse JSON body from request.
 * Rejects if body exceeds maxBytes or is invalid JSON.
 */
export function parseJsonBody<T = unknown>(
  req: IncomingMessage,
  maxBytes: number = 65_536,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    let aborted = false;

    req.on('error', () => {
      aborted = true;
      reject(new BodyParseError('Request error', 400));
    });

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      if (body.length + chunk.length > maxBytes) {
        aborted = true;
        req.destroy();
        reject(new BodyParseError('Body too large', 413));
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      if (aborted) return;
      try {
        resolve(JSON.parse(body) as T);
      } catch {
        reject(new BodyParseError('Invalid JSON', 400));
      }
    });
  });
}
