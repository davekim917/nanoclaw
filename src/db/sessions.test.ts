/**
 * `getAskQuestionRender`'s two `hasTable` guards (seam 3, PR 4).
 *
 * Under the old synchronous `hasTable` these guards short-circuited cleanly
 * when the module-owned table was absent (module not installed / not yet
 * migrated). An un-awaited async `hasTable` returns a Promise, which is
 * always truthy, inverting the guard: the code would try to query a table
 * that doesn't exist and throw instead of falling through. This pins the
 * early-return behavior so that inversion regresses loudly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getRawDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import { getAskQuestionRender } from './sessions.js';

describe('getAskQuestionRender — module-absent path', () => {
  beforeEach(async () => {
    await initTestDb();
    runMigrations(getRawDb());
    // Simulate an install where the pending_channel_approvals /
    // pending_sender_approvals modules were never migrated in, which is
    // exactly the state the two `hasTable` guards exist to handle.
    getRawDb().exec('DROP TABLE pending_channel_approvals');
    getRawDb().exec('DROP TABLE pending_sender_approvals');
  });

  afterEach(async () => {
    await closeDb();
  });

  it('module-absent path returns early when the module table is missing', async () => {
    // No pending_question, no pending_approval, and both module tables gone
    // — every branch must fall through to the final `undefined` without
    // throwing.
    await expect(getAskQuestionRender('some-card-id')).resolves.toBeUndefined();
  });
});
