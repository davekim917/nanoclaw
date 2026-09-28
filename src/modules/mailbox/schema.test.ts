import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { readRepoIngressFence, repoIngressFenceAckToken } from './ops/fence.js';
import { ensureNanoclawInboundSchema } from './schema.js';

describe('scheduled_for backfill', () => {
  it('gives a legacy task its process_after as its slot, even mid-backoff, in ISO form', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE messages_in (
        id TEXT PRIMARY KEY, seq INTEGER UNIQUE, kind TEXT NOT NULL, timestamp TEXT NOT NULL,
        status TEXT DEFAULT 'pending', process_after TEXT, recurrence TEXT, series_id TEXT,
        tries INTEGER DEFAULT 0, trigger INTEGER NOT NULL DEFAULT 1, platform_id TEXT,
        channel_type TEXT, thread_id TEXT, content TEXT NOT NULL
      );
      INSERT INTO messages_in (id, seq, kind, timestamp, process_after, tries, content)
        VALUES ('backoff', 2, 'task', '2026-09-01T11:00:00.000Z', '2026-09-01 12:05:00', 3, '{}'),
               ('chat', 4, 'chat', '2026-09-01T11:00:00.000Z', '2026-09-01 12:05:00', 0, '{}');
    `);
    ensureNanoclawInboundSchema(db);

    const slots = db.prepare('SELECT id, scheduled_for FROM messages_in ORDER BY id').all();
    expect(slots).toEqual([
      { id: 'backoff', scheduled_for: '2026-09-01T12:05:00.000Z' },
      { id: 'chat', scheduled_for: null },
    ]);
    db.close();
  });
});

describe('repo_ingress_fence generation upgrade', () => {
  /** A session DB from before the fence carried a generation, with a fence still active. */
  function legacyFenceDb(epoch: string): Database.Database {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE repo_ingress_fence (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        epoch TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'released'))
      );
      INSERT INTO repo_ingress_fence (id, epoch, state) VALUES (1, '${epoch}', 'active');
    `);
    return db;
  }

  it('gives a pre-generation fence a random generation and keeps its epoch and state', () => {
    const db = legacyFenceDb('epoch-1');
    ensureNanoclawInboundSchema(db);

    const fence = readRepoIngressFence(db);
    expect(fence).toMatchObject({ epoch: 'epoch-1', state: 'active' });
    expect(fence!.generation).toMatch(/^[0-9a-f]{32}$/);
    db.close();
  });

  it('does not re-randomize the generation on a later open, so the release ack token stays stable', () => {
    const db = legacyFenceDb('epoch-1');
    ensureNanoclawInboundSchema(db);
    const token = repoIngressFenceAckToken(readRepoIngressFence(db)!);

    ensureNanoclawInboundSchema(db);
    expect(repoIngressFenceAckToken(readRepoIngressFence(db)!)).toBe(token);
    db.close();
  });
});
