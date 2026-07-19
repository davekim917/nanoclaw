import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';

import type { ExtractionBundle, SourceInput } from '../graphify/types.js';

export interface ArchivedConversationMessage {
  id: string;
  messagingGroupId: string | null;
  channelType: string;
  channelName: string | null;
  platformId: string | null;
  threadId: string | null;
  role: 'user' | 'assistant';
  senderId: string | null;
  senderName: string | null;
  text: string;
  sentAt: string;
}

export interface ConversationGraphSource {
  input: SourceInput;
  bundle: ExtractionBundle;
  messages: ArchivedConversationMessage[];
}

export interface ArchiveConversationOptions {
  maxMessages?: number;
  maxBytes?: number;
  maxWindowMs?: number;
}

interface ArchiveRow {
  id: string;
  messaging_group_id: string | null;
  channel_type: string;
  channel_name: string | null;
  platform_id: string | null;
  thread_id: string | null;
  role: 'user' | 'assistant';
  sender_id: string | null;
  sender_name: string | null;
  text: string;
  sent_at: string;
}

function digest(...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

function slug(value: string | null): string {
  return (value || 'root').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'root';
}

function logicalMessageKey(row: ArchiveRow): string {
  return [
    row.messaging_group_id ?? '',
    row.channel_type,
    row.platform_id ?? '',
    row.thread_id ?? '',
    row.role,
    row.sender_id ?? '',
    row.sent_at,
    row.text,
  ].join('\0');
}

function toMessage(row: ArchiveRow): ArchivedConversationMessage {
  return {
    id: row.id,
    messagingGroupId: row.messaging_group_id,
    channelType: row.channel_type,
    channelName: row.channel_name,
    platformId: row.platform_id,
    threadId: row.thread_id,
    role: row.role,
    senderId: row.sender_id,
    senderName: row.sender_name,
    text: row.text,
    sentAt: row.sent_at,
  };
}

function segmentRows(rows: ArchiveRow[], options: Required<ArchiveConversationOptions>): ArchiveRow[][] {
  const segments: ArchiveRow[][] = [];
  let segment: ArchiveRow[] = [];
  let bytes = 0;
  let started = 0;
  for (const row of rows) {
    const at = Date.parse(row.sent_at);
    const rowBytes = Buffer.byteLength(row.text, 'utf8');
    const beyondWindow =
      segment.length > 0 && Number.isFinite(at) && Number.isFinite(started) && at - started > options.maxWindowMs;
    if (
      segment.length > 0 &&
      (segment.length >= options.maxMessages || bytes + rowBytes > options.maxBytes || beyondWindow)
    ) {
      segments.push(segment);
      segment = [];
      bytes = 0;
    }
    if (segment.length === 0) started = at;
    segment.push(row);
    bytes += rowBytes;
  }
  if (segment.length > 0) segments.push(segment);
  return segments;
}

/**
 * Read-through reconciliation intentionally re-reads the complete scoped
 * archive. The archive is small compared with workgroup files, and this avoids
 * a high-water-mark bug where a late row has an older sent_at than the last
 * observed message. Stable source hashes make unchanged segments no-ops at the
 * daemon layer.
 */
export class ArchiveConversationReader {
  private readonly options: Required<ArchiveConversationOptions>;

  constructor(
    private readonly archivePath: string,
    options: ArchiveConversationOptions = {},
  ) {
    this.options = {
      maxMessages: options.maxMessages ?? 100,
      maxBytes: options.maxBytes ?? 256 * 1024,
      maxWindowMs: options.maxWindowMs ?? 6 * 60 * 60 * 1000,
    };
  }

  read(workgroupId: string, memberIds: string[]): ConversationGraphSource[] {
    if (!workgroupId.trim()) throw new Error('workgroupId is required');
    if (memberIds.length === 0) return [];
    const db = new Database(this.archivePath, { readonly: true, fileMustExist: true });
    let rows: ArchiveRow[];
    try {
      const placeholders = memberIds.map(() => '?').join(', ');
      rows = db
        .prepare(
          `
        SELECT id, messaging_group_id, channel_type, channel_name, platform_id,
               thread_id, role, sender_id, sender_name, text, sent_at
          FROM messages_archive
         WHERE agent_group_id IN (${placeholders})
           AND role IN ('user', 'assistant')
           AND channel_type <> 'agent'
         ORDER BY sent_at, id
      `,
        )
        .all(...memberIds) as ArchiveRow[];
    } finally {
      db.close();
    }

    // Projection fan-out can duplicate the same external message under each
    // sibling. Keep the lexicographically first id for deterministic evidence.
    const deduped = new Map<string, ArchiveRow>();
    for (const row of rows) {
      const key = logicalMessageKey(row);
      const prior = deduped.get(key);
      if (!prior || row.id < prior.id) deduped.set(key, row);
    }
    const grouped = new Map<string, ArchiveRow[]>();
    for (const row of [...deduped.values()].sort(
      (a, b) => a.sent_at.localeCompare(b.sent_at) || a.id.localeCompare(b.id),
    )) {
      const key = [row.channel_type, row.platform_id ?? '', row.messaging_group_id ?? '', row.thread_id ?? ''].join(
        '\0',
      );
      const group = grouped.get(key) ?? [];
      group.push(row);
      grouped.set(key, group);
    }

    const sources: ConversationGraphSource[] = [];
    for (const rowsForThread of grouped.values()) {
      for (const segment of segmentRows(rowsForThread, this.options)) {
        const first = segment[0];
        const logicalIds = segment.map(logicalMessageKey);
        const segmentHash = digest(...logicalIds);
        const relativePath = `conversations/${slug(first.channel_type)}/${slug(first.platform_id)}/${slug(first.thread_id)}/${slug(first.sent_at)}-${segmentHash.slice(0, 16)}.conversation`;
        const sourceId = `source_${digest(workgroupId, relativePath)}`;
        const rootNodeId = `conversation_${digest(sourceId, 'root')}`;
        const evidence = segment.map((row) => ({
          sourceId,
          relativePath,
          messageId: row.id,
          sentAt: row.sent_at,
          excerpt: row.text.slice(0, 500),
        }));
        const nodes = [
          {
            id: rootNodeId,
            name: first.channel_name || first.thread_id || first.platform_id || 'conversation',
            type: 'conversation',
            description: segment
              .map(
                (row) =>
                  `${row.role === 'user' ? row.sender_name || row.sender_id || 'user' : row.sender_name || 'assistant'}: ${row.text}`,
              )
              .join('\n\n'),
            properties: {
              channelType: first.channel_type,
              platformId: first.platform_id,
              threadId: first.thread_id,
              messageCount: segment.length,
              startedAt: first.sent_at,
              endedAt: segment.at(-1)?.sent_at,
            },
            evidence,
          },
          ...segment.map((row, index) => ({
            id: `message_${digest(sourceId, logicalMessageKey(row))}`,
            name: `${row.role} ${index + 1}`,
            type: 'conversation_chunk',
            description: row.text,
            properties: { role: row.role, senderId: row.sender_id, senderName: row.sender_name },
            evidence: [
              {
                sourceId,
                relativePath,
                messageId: row.id,
                sentAt: row.sent_at,
                excerpt: row.text.slice(0, 500),
              },
            ],
          })),
        ];
        const edges = nodes.slice(1).map((node, index) => ({
          id: `edge_${digest(sourceId, rootNodeId, node.id)}`,
          from: rootNodeId,
          to: node.id,
          type: 'contains',
          structural: true,
          properties: { ordinal: index },
          evidence: node.evidence,
        }));
        sources.push({
          input: {
            id: sourceId,
            workgroupId,
            kind: 'conversation',
            relativePath,
            contentHash: segmentHash,
            sizeBytes: segment.reduce((total, row) => total + Buffer.byteLength(row.text), 0),
            modifiedAt: segment.at(-1)?.sent_at,
          },
          bundle: { nodes, edges, hyperedges: [] },
          messages: segment.map(toMessage),
        });
      }
    }
    return sources.sort((left, right) => left.input.relativePath.localeCompare(right.input.relativePath));
  }
}
