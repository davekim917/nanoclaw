/**
 * Gather recent chat messages from a session's inbound + outbound DBs
 * and project them into the ConversationMessage shape the memory
 * extractor expects. Read-only — opens the DBs, queries, closes.
 */
import { openInboundDb, openOutboundDb } from './session-manager.js';
import type { ConversationMessage } from './memory-extractor.js';

interface Row {
  timestamp: string;
  role: 'user' | 'assistant';
  content: string;
}

export function gatherRecentConversation(
  agentGroupId: string,
  sessionId: string,
  limit = 20,
): ConversationMessage[] {
  const rows: Row[] = [];

  const inDb = openInboundDb(agentGroupId, sessionId);
  try {
    const inboundRows = inDb
      .prepare(
        `SELECT timestamp, content FROM messages_in
         WHERE kind IN ('chat', 'chat-sdk')
         ORDER BY seq DESC
         LIMIT ?`,
      )
      .all(limit) as { timestamp: string; content: string }[];
    for (const r of inboundRows) rows.push({ timestamp: r.timestamp, role: 'user', content: r.content });
  } finally {
    inDb.close();
  }

  const outDb = openOutboundDb(agentGroupId, sessionId);
  try {
    const outboundRows = outDb
      .prepare(
        `SELECT timestamp, content FROM messages_out
         WHERE kind = 'chat'
         ORDER BY seq DESC
         LIMIT ?`,
      )
      .all(limit) as { timestamp: string; content: string }[];
    for (const r of outboundRows) rows.push({ timestamp: r.timestamp, role: 'assistant', content: r.content });
  } finally {
    outDb.close();
  }

  rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const recent = rows.slice(-limit);

  const messages: ConversationMessage[] = [];
  for (const r of recent) {
    const { senderName, text } = parseContent(r.content, r.role);
    if (!text) continue;
    messages.push({ role: r.role, senderName, content: text });
  }
  return messages;
}

function parseContent(raw: string, role: 'user' | 'assistant'): { senderName: string; text: string } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const text =
      typeof parsed.text === 'string'
        ? parsed.text
        : typeof parsed.content === 'string'
          ? parsed.content
          : '';
    const senderName =
      (typeof parsed.senderName === 'string' && parsed.senderName) ||
      (typeof parsed.sender === 'string' && parsed.sender) ||
      (role === 'user' ? 'user' : 'assistant');
    return { senderName, text };
  } catch {
    return { senderName: role === 'user' ? 'user' : 'assistant', text: '' };
  }
}
