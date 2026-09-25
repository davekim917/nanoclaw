import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { readRepoIngressFence, repoIngressFenceAckToken } from './ops/fence.js';
import { ensureNanoclawInboundSchema } from './schema.js';

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
