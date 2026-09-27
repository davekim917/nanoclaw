/**
 * Path-traversal-safe static handler for the SPA bundle: resolve + `STATIC_ROOT + sep` containment, null-byte
 * rejection, isFile() guard. Unknown extensions are application/octet-stream, never text/plain (browsers reject JS
 * modules served as text/plain).
 */
import fs from 'fs';
import path from 'path';

import type { Handler } from './router.js';

// Separate from the host's compiled `dist/dashboard/`: Vite's emptyOutDir would wipe the host's index.js.
export const STATIC_ROOT = path.resolve(process.cwd(), 'dist/dashboard-spa');

const MIME: Record<string, string> = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function resolveAndCheck(tail: string): { filePath: string; stat: fs.Stats } | null {
  if (tail.includes('\0')) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(tail);
  } catch {
    return null;
  }

  if (decoded.includes('\0')) return null;

  const filePath = path.resolve(STATIC_ROOT, decoded);

  if (!filePath.startsWith(STATIC_ROOT + path.sep)) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  return { filePath, stat };
}

export const indexHtmlHandler: Handler = async (_req, _params, _ctx) => {
  const filePath = path.join(STATIC_ROOT, 'index.html');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const etag = stat.mtimeMs.toString(16);
  const body = fs.readFileSync(filePath);

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html',
      ETag: etag,
      'Cache-Control': 'no-cache',
    },
  });
};

export const staticHandler: Handler = async (req, params, _ctx) => {
  const tail = params['tail'] ?? '';

  if (!tail) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const resolved = resolveAndCheck(tail);
  if (!resolved) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { filePath, stat } = resolved;

  // ETags must be quoted (RFC 7232), or If-None-Match never matches and assets re-download every request.
  const etag = `"${stat.mtimeMs.toString(16)}"`;
  const ifNoneMatch = req.headers.get('if-none-match');
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304 });
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] ?? 'application/octet-stream';
  const body = fs.readFileSync(filePath);

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      ETag: etag,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
