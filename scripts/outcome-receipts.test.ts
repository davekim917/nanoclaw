import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { migration083 } from '../src/db/migrations/083-work-outcome-receipts.js';
import { reconcileOutcome } from './outcome-receipts.js';

describe('operator outcome reconciliation', () => {
  it('requires exact current evidence, records correction, and never blindly deletes a receipt', () => {
    const db = new Database(':memory:');
    migration083.up(db);
    db.prepare(
      `INSERT INTO work_outcome_receipts
      (workgroup_id,work_item,message_id,session_id,state,channel_type,platform_id,content,created_at,updated_at)
      VALUES ('wg','github:org/repo:pull:7','message','session','uncertain','slack','channel','{}','old','old')`,
    ).run();
    const input = {
      action: 'confirm-delivered' as const,
      workgroup: 'wg',
      workItem: 'https://github.com/org/repo/pull/7',
      expectedUpdatedAt: 'old',
      value: 'platform-id',
      reason: 'Platform readback confirmed the existing message.',
    };
    expect(() => reconcileOutcome(db, { ...input, expectedUpdatedAt: 'stale' })).toThrow('Receipt changed');
    expect(() => reconcileOutcome(db, { ...input, reason: '' })).toThrow();
    reconcileOutcome(db, input);
    const current = db.prepare('SELECT * FROM work_outcome_receipts').get() as {
      state: string;
      updated_at: string;
      resolution: string;
    };
    expect(current.state).toBe('delivered');
    expect(current.resolution).toContain('Platform readback');
    reconcileOutcome(db, {
      ...input,
      action: 'rekey',
      expectedUpdatedAt: current.updated_at,
      value: 'https://github.com/org/repo/pull/8',
      reason: 'Original item identity was wrong; inspected sent post and correct item.',
    });
    expect(db.prepare('SELECT work_item,platform_message_id FROM work_outcome_receipts').get()).toEqual({
      work_item: 'github:org/repo:pull:8',
      platform_message_id: 'platform-id',
    });
    db.close();
  });
});
