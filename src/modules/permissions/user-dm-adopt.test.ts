/**
 * `ensureUserDm` cold-DM race (seam 3 PR 4, Codex round 3).
 *
 * The `getMessagingGroupByPlatform` lookup yields on the async driver, so two
 * host paths that both want to cold-DM the same user (an approval card and a
 * pairing handshake, say) can both miss and both INSERT on
 * UNIQUE(channel_type, platform_id, instance). Before `insertOrAdopt` the
 * loser threw out of `ensureUserDm`, which reads as "user unreachable" to the
 * caller and silently drops an approval delivery.
 *
 * The loss is driven deterministically: the leaf is stubbed to write the
 * winner's row and then reject with the driver's unique-violation code, which
 * is exactly what the real race produces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Direct-addressable fixture channel: an adapter exists, it has no `openDM`,
// so the user's handle doubles as the DM platform id.
vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapter: () => ({ channelType: 'telegram', instance: 'telegram' }),
}));

vi.mock('../../db/messaging-groups.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/messaging-groups.js')>();
  return { ...real, createMessagingGroup: vi.fn(real.createMessagingGroup) };
});

import { closeDb, getRawDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { upsertUser } from './db/users.js';
import { ensureUserDm } from './user-dm.js';

const USER_ID = 'telegram:555';

function now(): string {
  return new Date().toISOString();
}

function count(sql: string): number {
  return (getRawDb().prepare(sql).get() as { c: number }).c;
}

/** Write the row the concurrent winner would have written. */
function insertWinnerRow(): void {
  getRawDb()
    .prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('mg-winner', 'telegram', '555', 'telegram', 'Ada (winner)', 0, 'strict', now());
}

describe('ensureUserDm adopts a concurrently created DM messaging group', () => {
  beforeEach(async () => {
    await initTestDb();
    runMigrations(getRawDb());
    upsertUser({ id: USER_ID, kind: 'telegram', display_name: 'Ada', created_at: now() });
  });

  afterEach(async () => {
    vi.mocked(createMessagingGroup).mockReset();
    await closeDb();
  });

  it('returns the winner row, caches it, and leaves exactly one messaging group', async () => {
    vi.mocked(createMessagingGroup).mockImplementationOnce(async () => {
      insertWinnerRow();
      throw Object.assign(new Error('UNIQUE constraint failed: messaging_groups'), {
        code: 'SQLITE_CONSTRAINT_UNIQUE',
      });
    });

    const mg = await ensureUserDm(USER_ID);

    expect(mg).not.toBeNull();
    expect(mg!.id).toBe('mg-winner');
    expect(count('SELECT COUNT(*) AS c FROM messaging_groups')).toBe(1);

    // The caller continued past the insert: the DM cache was written, so the
    // next approval delivery is a pure read instead of another openDM.
    const cached = getRawDb().prepare('SELECT messaging_group_id FROM user_dms WHERE user_id = ?').get(USER_ID) as
      | { messaging_group_id: string }
      | undefined;
    expect(cached?.messaging_group_id).toBe('mg-winner');
  });

  it('still propagates a non-unique insert failure', async () => {
    vi.mocked(createMessagingGroup).mockRejectedValueOnce(
      Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' }),
    );

    await expect(ensureUserDm(USER_ID)).rejects.toThrow('disk I/O error');
  });
});
