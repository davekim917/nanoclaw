/**
 * Web UI — Real-time agent activity monitor via SSE.
 * Single HTTP server: serves HTML, streams progress events, handles intervention.
 * Zero dependencies beyond Node built-in `http`.
 *
 * When WEB_UI_TOKEN is set, binds to 0.0.0.0 (public) and requires token auth.
 * When unset, binds to 127.0.0.1 (local only, no auth).
 */
import { createServer, IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import { URL } from 'url';

import { logger } from './logger.js';
import type { ProgressEvent } from './container-runner.js';

const clients = new Set<ServerResponse>();
const activeSessions = new Map<
  string,
  { group: string; groupJid: string; threadId?: string; startedAt: string }
>();
let cachedHtml: Buffer | null = null;

interface WebUIDeps {
  sendMessage: (
    groupJid: string,
    threadId: string | undefined,
    text: string,
  ) => boolean;
  getRegisteredGroups: () => Array<{
    jid: string;
    name: string;
    folder: string;
  }>;
  startSession: (groupJid: string, text: string) => boolean;
}

export interface WebUIHandle {
  broadcast: (
    sessionKey: string,
    group: string,
    threadId: string | undefined,
    event: ProgressEvent,
  ) => void;
  notifySessionStart: (
    sessionKey: string,
    group: string,
    groupJid: string,
    threadId?: string,
  ) => void;
  notifySessionEnd: (sessionKey: string) => void;
}

function broadcast(
  sessionKey: string,
  group: string,
  threadId: string | undefined,
  event: ProgressEvent,
): void {
  if (clients.size === 0) return;
  const data = JSON.stringify({
    type: 'progress',
    group,
    threadId,
    sessionKey,
    event,
  });
  for (const res of clients) {
    if (res.writableLength > 1_048_576) {
      clients.delete(res);
      res.end();
      continue;
    }
    res.write(`data: ${data}\n\n`);
  }
}

function notifySessionStart(
  sessionKey: string,
  group: string,
  groupJid: string,
  threadId?: string,
): void {
  activeSessions.set(sessionKey, {
    group,
    groupJid,
    threadId,
    startedAt: new Date().toISOString(),
  });
  if (clients.size === 0) return;
  const data = JSON.stringify({
    type: 'session_start',
    sessionKey,
    group,
    groupJid,
    threadId,
  });
  for (const res of clients) {
    if (res.writableLength > 1_048_576) {
      clients.delete(res);
      res.end();
      continue;
    }
    res.write(`data: ${data}\n\n`);
  }
}

function notifySessionEnd(sessionKey: string): void {
  activeSessions.delete(sessionKey);
  if (clients.size === 0) return;
  const data = JSON.stringify({ type: 'session_end', sessionKey });
  for (const res of clients) {
    if (res.writableLength > 1_048_576) {
      clients.delete(res);
      res.end();
      continue;
    }
    res.write(`data: ${data}\n\n`);
  }
}

/**
 * Check token auth. Accepts either:
 *   - ?token=<value> query param (for SSE/EventSource which can't set headers)
 *   - Authorization: Bearer <value> header
 */
function checkAuth(req: IncomingMessage, token: string): boolean {
  if (!token) return true; // No token configured = no auth required (localhost-only mode)
  const url = new URL(
    req.url || '/',
    `http://${req.headers.host || 'localhost'}`,
  );
  if (url.searchParams.get('token') === token) return true;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader === `Bearer ${token}`) return true;
  return false;
}

function rejectAuth(res: ServerResponse): void {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}

function handleIntervene(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebUIDeps,
): void {
  let body = '';
  let aborted = false;
  req.on('error', () => {
    aborted = true;
  });
  req.on('data', (chunk: Buffer) => {
    if (body.length + chunk.length > 65_536) {
      aborted = true;
      req.destroy();
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Body too large' }));
      return;
    }
    body += chunk;
  });
  req.on('end', () => {
    if (aborted) return;
    try {
      const { groupJid, threadId, text } = JSON.parse(body);
      if (!groupJid || !text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ ok: false, error: 'Missing groupJid or text' }),
        );
        return;
      }
      const ok = deps.sendMessage(groupJid, threadId, text);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
    }
  });
}

function handleSend(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebUIDeps,
): void {
  let body = '';
  let aborted = false;
  req.on('error', () => {
    aborted = true;
  });
  req.on('data', (chunk: Buffer) => {
    if (body.length + chunk.length > 65_536) {
      aborted = true;
      req.destroy();
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Body too large' }));
      return;
    }
    body += chunk;
  });
  req.on('end', () => {
    if (aborted) return;
    try {
      const { groupJid, text } = JSON.parse(body);
      if (!groupJid || !text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ ok: false, error: 'Missing groupJid or text' }),
        );
        return;
      }
      const ok = deps.startSession(groupJid, text);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
    }
  });
}

export function startWebUI(
  port: number,
  htmlPath: string,
  deps: WebUIDeps,
  token: string,
): Promise<WebUIHandle> {
  const server = createServer((req, res) => {
    // Strip query params for route matching
    const pathname = (req.url || '/').split('?')[0];

    // Serve HTML unauthenticated — login form is handled client-side
    if (pathname === '/' && req.method === 'GET') {
      if (!cachedHtml) {
        try {
          cachedHtml = fs.readFileSync(htmlPath);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Web UI HTML not found');
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(cachedHtml);
      return;
    }

    // Auth check on all other endpoints
    if (!checkAuth(req, token)) {
      rejectAuth(res);
      return;
    }

    if (pathname === '/events' && req.method === 'GET') {
      // SSE endpoint
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(
        `data: ${JSON.stringify({ type: 'sessions', sessions: Object.fromEntries(activeSessions) })}\n\n`,
      );
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else if (pathname === '/api/intervene' && req.method === 'POST') {
      handleIntervene(req, res, deps);
    } else if (pathname === '/api/groups' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ groups: deps.getRegisteredGroups() }));
    } else if (pathname === '/api/send' && req.method === 'POST') {
      handleSend(req, res, deps);
    } else if (pathname === '/api/sessions' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          sessions: Object.fromEntries(activeSessions),
        }),
      );
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  // Bind publicly when token is set (authenticated), localhost-only otherwise
  const bindAddress = token ? '0.0.0.0' : '127.0.0.1';

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, bindAddress, () => {
      logger.info(
        { port, bindAddress, authEnabled: !!token },
        'Web UI started',
      );
      resolve({ broadcast, notifySessionStart, notifySessionEnd });
    });
  });
}
