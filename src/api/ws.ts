/**
 * WebSocket handler for the NanoClaw Web UI.
 *
 * Uses `ws` in noServer mode — attached to the HTTP server's upgrade event.
 * Auth via ?token= at upgrade time (reuse checkAuth from web-ui.ts).
 * Origin validation against WEB_UI_ORIGINS.
 */
import crypto from 'crypto';
import { IncomingMessage, Server } from 'http';
import { URL } from 'url';
import { WebSocket, WebSocketServer } from 'ws';

import { WEB_UI_ORIGINS, WEB_UI_SENDER_NAME } from '../config.js';
import { logger } from '../logger.js';
import type { Capabilities, WsServerMessage } from './types.js';

// --- Rate limiting ---

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10; // max send_message per window

interface RateState {
  count: number;
  windowStart: number;
}

// --- Ring buffer for reconnection replay ---

const RING_BUFFER_SIZE = 500;
const ringBuffer: Array<{ data: string; timestamp: number }> = [];
let ringHead = 0;
let ringCount = 0;

function pushToRingBuffer(data: string): void {
  if (ringCount < RING_BUFFER_SIZE) {
    ringBuffer.push({ data, timestamp: Date.now() });
    ringCount++;
  } else {
    ringBuffer[ringHead] = { data, timestamp: Date.now() };
    ringHead = (ringHead + 1) % RING_BUFFER_SIZE;
  }
}

/** Get events from the ring buffer after a given timestamp. */
export function getEventsSince(
  since: number,
): Array<{ data: string; timestamp: number }> {
  const results: Array<{ data: string; timestamp: number }> = [];
  const len = ringCount;
  for (let i = 0; i < len; i++) {
    const idx =
      ringCount < RING_BUFFER_SIZE
        ? i
        : (ringHead + i) % RING_BUFFER_SIZE;
    const entry = ringBuffer[idx];
    if (entry && entry.timestamp > since) {
      results.push(entry);
    }
  }
  return results;
}

// --- Backpressure threshold ---

const BACKPRESSURE_THRESHOLD = 1_048_576; // 1MB

// --- Connection tracking ---

interface WsClient {
  ws: WebSocket;
  subscribedGroups: Set<string> | null; // null = all groups (default)
  rateState: RateState;
}

const wsClients = new Set<WsClient>();

// --- WebSocket deps ---

export interface WsDeps {
  checkAuth: (req: IncomingMessage, token: string) => boolean;
  getCapabilities: () => Capabilities;
  startSession: (
    groupJid: string,
    text: string,
    senderName: string,
    senderId: string,
  ) => boolean;
}

// --- Helpers ---

function sendJson(ws: WebSocket, msg: WsServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function checkRateLimit(client: WsClient): boolean {
  const now = Date.now();
  if (now - client.rateState.windowStart > RATE_LIMIT_WINDOW_MS) {
    client.rateState = { count: 0, windowStart: now };
  }
  client.rateState.count++;
  return client.rateState.count <= RATE_LIMIT_MAX;
}

function validateOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;

  // No Origin header (same-origin / non-browser) — allow
  if (!origin) return true;

  // No origins configured — only allow same-origin (no Origin header)
  // But we already checked that. If origins is empty and origin IS present,
  // reject to prevent cross-site WebSocket hijacking in bundled mode.
  if (WEB_UI_ORIGINS.length === 0) return false;

  // Check allowlist
  return WEB_UI_ORIGINS.includes(origin);
}

// --- Init ---

/**
 * Initialize WebSocket handling on the given HTTP server.
 * Returns functions for broadcasting events to WS clients.
 */
export function initWebSocket(
  server: Server,
  deps: WsDeps,
  token: string,
): {
  broadcastWs: (
    sessionKey: string,
    group: string,
    threadId: string | undefined,
    event: unknown,
  ) => void;
  notifyWsSessionStart: (
    sessionKey: string,
    group: string,
    groupJid: string,
    threadId?: string,
  ) => void;
  notifyWsSessionEnd: (sessionKey: string) => void;
  notifyWsSkillInstall: (
    jobId: string,
    output: string,
    status: string,
  ) => void;
} {
  const wss = new WebSocketServer({ noServer: true });

  // Handle HTTP upgrade
  server.on('upgrade', (req, socket, head) => {
    // Auth check
    if (!deps.checkAuth(req, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // Origin validation
    if (!validateOrigin(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  // Handle new connections
  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    const client: WsClient = {
      ws,
      subscribedGroups: null, // default: all groups
      rateState: { count: 0, windowStart: Date.now() },
    };
    wsClients.add(client);

    // Send connected message with capabilities
    sendJson(ws, {
      type: 'connected',
      capabilities: deps.getCapabilities(),
    });

    // Handle incoming messages
    ws.on('message', (raw: Buffer | string) => {
      let msg: { type: string; [key: string]: unknown };
      try {
        msg = JSON.parse(
          typeof raw === 'string' ? raw : raw.toString('utf-8'),
        );
      } catch {
        sendJson(ws, {
          type: 'error',
          code: 'invalid_json',
          message: 'Could not parse message as JSON',
        });
        return;
      }

      if (msg.type === 'send_message') {
        // Rate limit check
        if (!checkRateLimit(client)) {
          sendJson(ws, {
            type: 'error',
            code: 'rate_limited',
            message: 'Rate limit exceeded: max 10 messages per minute',
          });
          return;
        }

        const groupJid = msg.groupJid as string | undefined;
        const text = msg.text as string | undefined;
        const senderName = (msg.senderName as string) || WEB_UI_SENDER_NAME;
        const senderId =
          (msg.senderId as string) || `web-ui-${crypto.randomUUID().slice(0, 8)}`;

        if (!groupJid || !text) {
          sendJson(ws, {
            type: 'error',
            code: 'invalid_params',
            message: 'Missing required fields: groupJid, text',
          });
          return;
        }

        // startSession applies trigger prefix injection internally
        const ok = deps.startSession(groupJid, text, senderName, senderId);
        if (ok) {
          const msgId = `web-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
          sendJson(ws, { type: 'message_stored', id: msgId });
        } else {
          sendJson(ws, {
            type: 'error',
            code: 'group_not_found',
            message: `Group not found: ${groupJid}`,
          });
        }
      } else if (msg.type === 'subscribe') {
        const groups = msg.groups as string[] | undefined;
        if (groups && Array.isArray(groups)) {
          client.subscribedGroups = new Set(groups);
        } else {
          client.subscribedGroups = null; // all groups
        }
      } else {
        sendJson(ws, {
          type: 'error',
          code: 'unknown_type',
          message: `Unknown message type: ${msg.type}`,
        });
      }
    });

    ws.on('close', () => {
      wsClients.delete(client);
    });

    ws.on('error', () => {
      wsClients.delete(client);
    });
  });

  // --- Broadcast functions ---

  function broadcastWs(
    sessionKey: string,
    group: string,
    threadId: string | undefined,
    event: unknown,
  ): void {
    const msg: WsServerMessage = {
      type: 'progress',
      sessionKey,
      group,
      event,
    };
    const data = JSON.stringify(msg);
    pushToRingBuffer(data);

    for (const client of wsClients) {
      // Group filter
      if (
        client.subscribedGroups !== null &&
        !client.subscribedGroups.has(group)
      ) {
        continue;
      }

      // Backpressure: drop progress events when bufferedAmount > 1MB
      if (client.ws.bufferedAmount > BACKPRESSURE_THRESHOLD) {
        continue; // Drop progress (non-critical)
      }

      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  function notifyWsSessionStart(
    sessionKey: string,
    group: string,
    groupJid: string,
    threadId?: string,
  ): void {
    const msg: WsServerMessage = {
      type: 'session_start',
      sessionKey,
      group,
      groupJid,
    };
    const data = JSON.stringify(msg);
    pushToRingBuffer(data);

    for (const client of wsClients) {
      if (
        client.subscribedGroups !== null &&
        !client.subscribedGroups.has(group)
      ) {
        continue;
      }
      // Lifecycle events are always sent (no backpressure drop)
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  function notifyWsSessionEnd(sessionKey: string): void {
    const msg: WsServerMessage = { type: 'session_end', sessionKey };
    const data = JSON.stringify(msg);
    pushToRingBuffer(data);

    for (const client of wsClients) {
      // No group filter — session_end doesn't include group info
      // Lifecycle events are always sent
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  function notifyWsSkillInstall(
    jobId: string,
    output: string,
    status: string,
  ): void {
    const msg: WsServerMessage = {
      type: 'skill_install_progress',
      jobId,
      output,
      status,
    };
    const data = JSON.stringify(msg);

    for (const client of wsClients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  return {
    broadcastWs,
    notifyWsSessionStart,
    notifyWsSessionEnd,
    notifyWsSkillInstall,
  };
}
