import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ArchiveConversationReader } from './archive.js';

const roots: string[] = [];

function fixture(): { path: string; db: Database.Database } {
  const root = mkdtempSync(join(tmpdir(), 'graphify-archive-'));
  roots.push(root);
  const path = join(root, 'archive.db');
  const db = new Database(path);
  db.exec(`
    CREATE TABLE messages_archive (
      id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL,
      messaging_group_id TEXT, channel_type TEXT NOT NULL,
      channel_name TEXT, platform_id TEXT, thread_id TEXT,
      role TEXT NOT NULL, sender_id TEXT, sender_name TEXT,
      text TEXT NOT NULL, sent_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  return { path, db };
}

function insert(
  db: Database.Database,
  values: Partial<Record<string, string | null>> & { id: string; agent_group_id: string; text: string },
): void {
  db.prepare(
    `INSERT INTO messages_archive
    (id, agent_group_id, messaging_group_id, channel_type, channel_name, platform_id,
     thread_id, role, sender_id, sender_name, text, sent_at, created_at)
    VALUES (@id, @agent_group_id, @messaging_group_id, @channel_type, @channel_name,
            @platform_id, @thread_id, @role, @sender_id, @sender_name, @text,
            @sent_at, @created_at)`,
  ).run({
    messaging_group_id: 'mg',
    channel_type: 'discord',
    channel_name: 'dev',
    platform_id: 'channel',
    thread_id: 'thread',
    role: 'user',
    sender_id: 'dave',
    sender_name: 'Dave',
    sent_at: '2026-07-19T00:00:00.000Z',
    created_at: '2026-07-19T00:00:00.000Z',
    ...values,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ArchiveConversationReader', () => {
  it('test_daemon_indexes_external_workgroup_conversations', () => {
    const { path, db } = fixture();
    insert(db, { id: 'u1', agent_group_id: 'a', text: 'Define gross margin by cohort' });
    insert(db, {
      id: 'a1',
      agent_group_id: 'b',
      role: 'assistant',
      sender_id: 'bot',
      text: 'Use net revenue minus COGS',
    });
    db.close();

    const sources = new ArchiveConversationReader(path).read('madison', ['a', 'b']);
    expect(sources).toHaveLength(1);
    expect(sources[0].bundle.nodes.map((node) => node.description).join('\n')).toContain('gross margin');
    expect(sources[0].bundle.nodes.map((node) => node.description).join('\n')).toContain('net revenue');
    expect(sources[0].bundle.nodes.flatMap((node) => node.evidence ?? []).map((item) => item.messageId)).toEqual(
      expect.arrayContaining(['u1', 'a1']),
    );
  });

  it('test_daemon_excludes_agent_channel_conversations', () => {
    const { path, db } = fixture();
    insert(db, { id: 'human', agent_group_id: 'a', text: 'customer research' });
    insert(db, { id: 'internal', agent_group_id: 'a', channel_type: 'agent', text: 'private sibling relay' });
    insert(db, { id: 'system', agent_group_id: 'a', role: 'system', text: 'system internals' });
    db.close();
    const text = new ArchiveConversationReader(path)
      .read('wg', ['a'])
      .flatMap((source) => source.bundle.nodes.map((node) => node.description ?? ''))
      .join('\n');
    expect(text).toContain('customer research');
    expect(text).not.toContain('private sibling relay');
    expect(text).not.toContain('system internals');
  });

  it('test_daemon_incremental_archive_reconciliation_handles_late_rows', () => {
    const { path, db } = fixture();
    insert(db, { id: 'new', agent_group_id: 'a', sent_at: '2026-07-19T02:00:00.000Z', text: 'newer' });
    const reader = new ArchiveConversationReader(path);
    expect(reader.read('wg', ['a']).flatMap((item) => item.messages.map((message) => message.id))).toEqual(['new']);
    insert(db, { id: 'late', agent_group_id: 'a', sent_at: '2026-07-19T01:00:00.000Z', text: 'late arrival' });
    db.close();
    expect(reader.read('wg', ['a']).flatMap((item) => item.messages.map((message) => message.id))).toEqual([
      'late',
      'new',
    ]);
  });
});
