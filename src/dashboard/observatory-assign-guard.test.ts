import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withCentralSync } from '../db/central-lease.js';
import { closeDb, initTestDb, getRawDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { ALLOW, guard } from '../guard/index.js';
import { observatoryAssign, type ObservatoryAssignPayload } from './observatory-assign-guard.js';

/**
 * The seam, not the handler. `assign.test.ts` pins what the endpoint DOES;
 * this pins what the guard REFUSES, so a second caller arriving later with its
 * own looser copy of these two rules fails here rather than in production.
 */
const OWNER = 'u-owner';
const ADMIN = 'u-admin';
const NOBODY = 'u-nobody';

// The guard's role reads are lease-only (seam 3 §4.5 I-1): the production
// caller consults it inside `withCentralSync`, so the test does the same.
function decide(userId: string, payload: Partial<ObservatoryAssignPayload>, actorKind: 'human' | 'agent' = 'human') {
  return withCentralSync(
    () =>
      guard(observatoryAssign, {
        actor:
          actorKind === 'human'
            ? { kind: 'human', userId }
            : { kind: 'agent', agentGroupId: 'ag-wired', sessionId: 's-1' },
        resource: { itemId: 'board:EXAMPLE-APP#817', workgroupId: 'wg-example' },
        payload: payload as ObservatoryAssignPayload,
      }),
    'test decide',
  );
}

const wired = { agentGroupId: 'ag-wired', channelKey: 'slack:CEXAMPLE001', wiredToItemChannel: true };

beforeEach(async () => {
  await initTestDb();
  const db = getRawDb();
  runMigrations(db);
  db.exec(`
    INSERT INTO workgroups (id, created_at) VALUES ('wg-example', '2026-08-01T00:00:00.000Z');
    INSERT INTO agent_groups (id, name, folder, agent_provider, workgroup_id, created_at)
      VALUES ('ag-wired', 'ava', 'ava', 'claude', 'wg-example', '2026-08-01T00:00:00.000Z');
    INSERT INTO users (id, kind, created_at)
      VALUES ('${OWNER}', 'email', '2026-08-01T00:00:00.000Z'),
             ('${ADMIN}', 'email', '2026-08-01T00:00:00.000Z'),
             ('${NOBODY}', 'email', '2026-08-01T00:00:00.000Z');
    INSERT INTO user_roles (user_id, role, agent_group_id, granted_at)
      VALUES ('${OWNER}', 'owner', NULL, '2026-08-01T00:00:00.000Z'),
             ('${ADMIN}', 'admin', 'ag-wired', '2026-08-01T00:00:00.000Z');
  `);
});

afterEach(() => closeDb());

describe('observatory.assign guard', () => {
  it('allows an admin of an agent wired to the item’s channel', async () => {
    expect((await decide(OWNER, wired)).effect).toBe('allow');
    expect((await decide(ADMIN, wired)).effect).toBe('allow');
  });

  it('denies a caller with no admin privilege over the target group', async () => {
    const d = await decide(NOBODY, wired);
    expect(d.effect).toBe('deny');
    expect(d.reason).toMatch(/not an admin/);
  });

  it('denies an agent wired nowhere near the item’s room, however privileged the caller', async () => {
    const d = await decide(OWNER, { ...wired, wiredToItemChannel: false });
    expect(d.effect).toBe('deny');
    expect(d.reason).toContain('slack:CEXAMPLE001');
  });

  it('denies a non-human actor — the host never mints an assignment nobody asked for', async () => {
    expect((await decide(OWNER, wired, 'agent')).effect).toBe('deny');
  });

  it('denies a payload with no target at all rather than falling open', async () => {
    expect((await decide(OWNER, { channelKey: 'slack:CEXAMPLE001', wiredToItemChannel: true })).effect).toBe('deny');
  });

  /**
   * The seam itself, not this action's rules.
   *
   * `guard()` takes the value `defineGuardedAction` minted, so an unwired
   * consult site is a compile error. This is the runtime backstop for callers
   * outside the type system — a cast, a plain-JS caller, a hand-rolled object
   * carrying the same `action` name and a permissive `decide`. It must be
   * refused rather than run, or "assign is guarded" would mean only "assign
   * happens to call a guard today".
   */
  it('refuses a hand-rolled action object that is not the minted one', () => {
    const forged = { action: 'observatory.assign', decide: () => ALLOW('trust me') };
    const d = guard(forged as never, {
      actor: { kind: 'human', userId: OWNER },
      resource: {},
      payload: wired,
    });
    expect(d.effect).toBe('deny');
  });

  it('never HOLDs — assignment resolves in front of the operator, never through an approval card', async () => {
    expect(observatoryAssign.grantActionName).toBeUndefined();
    for (const d of [
      await decide(OWNER, wired),
      await decide(NOBODY, wired),
      await decide(OWNER, { ...wired, wiredToItemChannel: false }),
    ]) {
      expect(d.effect).not.toBe('hold');
    }
  });
});
