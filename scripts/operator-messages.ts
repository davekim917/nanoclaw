/**
 * What the operator told a set of agent groups in a window, for counting corrections (fleet-retro).
 *
 * `author.isBot === false` is not proof a person typed a row: posts made with the operator's Slack user token, by a
 * host session or by an agent granted the token, arrive the same way and nothing in `messages_in` separates them.
 * Every count this prints is therefore an upper bound, and says so. Rows from the CLI channel are not counted: they
 * arrive through the admin transport, usually from a host session, not typed by the operator.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DATA_DIR } from '../src/config.js';
import { resolveInboundDbPath } from '../src/modules/mailbox/host-inbound.js';
import { isHumanChatSdkContent } from '../src/task-list-host.js';
import { latestMessageText } from '../src/thread-context.js';

export const PROVENANCE_CAVEAT =
  'upper bound: posts made with the operator user token are indistinguishable from typed messages; check a candidate against the poster’s own record before counting it as typed';

export interface InboundRow {
  id: string;
  kind: string;
  timestamp: string;
  content: string;
}

export interface OperatorMessage {
  key: string;
  timestamp: string;
  source: 'chat' | 'dashboard';
  agentGroupIds: string[];
  text: string;
}

function parse(content: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(content);
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function sourceOf(row: InboundRow, content: Record<string, unknown>): OperatorMessage['source'] | null {
  if (isHumanChatSdkContent(row.kind, row.content)) return 'chat';
  if (row.kind === 'chat' && content._via === 'dashboard') return 'dashboard';
  return null;
}

/** Operator messages across the given rows, one per platform event however many agents it was fanned out to. */
export function selectOperatorMessages(rows: Iterable<{ agentGroupId: string; row: InboundRow }>): OperatorMessage[] {
  const byKey = new Map<string, OperatorMessage>();
  for (const { agentGroupId, row } of rows) {
    const content = parse(row.content);
    if (!content) continue;
    const source = sourceOf(row, content);
    if (!source) continue;
    const suffix = `:${agentGroupId}`;
    const key = row.id.endsWith(suffix) ? row.id.slice(0, -suffix.length) : row.id;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.agentGroupIds.includes(agentGroupId)) existing.agentGroupIds.push(agentGroupId);
      continue;
    }
    const text = typeof content.text === 'string' ? latestMessageText(content.text) : '';
    byKey.set(key, { key, timestamp: row.timestamp, source, agentGroupIds: [agentGroupId], text });
  }
  return [...byKey.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function* inboundRows(
  agentGroupIds: string[],
  since: string,
  until: string,
): Generator<{ agentGroupId: string; row: InboundRow }> {
  for (const agentGroupId of agentGroupIds) {
    const groupDir = path.join(DATA_DIR, 'v2-sessions', agentGroupId);
    if (!fs.existsSync(groupDir)) throw new Error(`no session directory for agent group ${agentGroupId}`);
    for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dbPath = resolveInboundDbPath(path.join(groupDir, entry.name));
      if (!fs.existsSync(dbPath)) continue;
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_in'`).get()) continue;
        const rows = db
          .prepare(
            `SELECT id, kind, timestamp, content FROM messages_in
              WHERE kind IN ('chat', 'chat-sdk') AND datetime(timestamp) >= datetime(?) AND datetime(timestamp) < datetime(?)`,
          )
          .all(since, until) as InboundRow[];
        for (const row of rows) yield { agentGroupId, row };
      } finally {
        db.close();
      }
    }
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function main(args: string[]): void {
  const groups = flag(args, '--groups')?.split(',').filter(Boolean) ?? [];
  const since = flag(args, '--since');
  const until = flag(args, '--until') ?? new Date().toISOString();
  if (groups.length === 0 || !since || Number.isNaN(Date.parse(since)) || Number.isNaN(Date.parse(until))) {
    console.error('usage: tsx scripts/operator-messages.ts --groups <id,id> --since <date> [--until <date>] [--text]');
    process.exit(2);
  }
  const messages = selectOperatorMessages(
    inboundRows(groups, new Date(since).toISOString(), new Date(until).toISOString()),
  );
  const shown = args.includes('--text') ? messages : messages.map(({ text: _text, ...metadata }) => metadata);
  console.log(JSON.stringify({ count: messages.length, provenance: PROVENANCE_CAVEAT, messages: shown }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
