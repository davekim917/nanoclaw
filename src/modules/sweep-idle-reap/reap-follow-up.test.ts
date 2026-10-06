/**
 * The chat idle reap's accountability wake, driven through the REGISTERED S13 duty against a real in-memory session
 * mailbox and a real migrated central DB (the quiet-mark invalidation writes `sessions`).
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../../db/schema.js';
import type { AgentMailbox, MailboxSession, MailboxSessionKey } from '../../mailbox/types.js';
import type { Session } from '../../types.js';

const h = vi.hoisted(() => ({
  selfHeal: true,
  containerName: null as string | null,
  adoptedAtMs: 0,
  ownsOutbound: false,
  kills: [] as string[],
}));

vi.mock('../../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config.js')>();
  return {
    ...real,
    get SELF_HEAL_ENABLED() {
      return h.selfHeal;
    },
  };
});

vi.mock('../../container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../container-runner.js')>();
  return {
    ...real,
    // What adoption leaves in the registry: the adoption instant, not the start (container-runner.ts adopt path).
    getContainerSpawnedAt: () => h.adoptedAtMs,
    containerIdentityFor: () => (h.containerName ? { containerName: h.containerName, claimIncarnation: 1 } : null),
    containerOwnsOutbound: () => h.ownsOutbound,
    isContainerRunning: () => false,
    getActiveContainerSessionIds: () => [],
    killContainer: (sessionId: string, _reason: string, onExit?: () => void) => {
      h.kills.push(sessionId);
      onExit?.();
    },
  };
});

import { CHAT_IDLE_REAP_MS } from './index.js';
import { _settleChatReapFollowUpsForTesting, containerStartedAtMs } from './reap-follow-up.js';
import {
  _lastSweepTickStatsForTesting,
  _listSweepRegistrationsForTesting,
  _resetQuietSessionCacheForTesting,
  _resetSweepRegistryForTesting,
  _sweepOnceForTesting,
  SWEEP_DUTY_INVENTORY,
  type SweepSessionContext,
} from '../../host-sweep.js';
import { closeDb, initMigratedTestDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, getSession } from '../../db/sessions.js';
import { registerAgentMailbox, resetAgentMailboxForTesting } from '../../mailbox/index.js';
import { composeNanoclawSession, type NanoclawMailboxSession } from '../mailbox/index.js';
import { decideReapFollowUp } from '../sweep-continuation/decide.js';
import { WORK_CONTINUATION_RESUME_MAX_ATTEMPTS } from '../mailbox/ops/continuation.js';
import { log } from '../../log.js';

const SESSION_ID = 'sess-reap';
const HOUR = 60 * 60 * 1000;

let inDb: Database.Database;
let outDb: Database.Database;
let mailbox: NanoclawMailboxSession;

const store: AgentMailbox = {
  exists: async () => true,
  prepare: () => undefined,
  destroy: async () => undefined,
  runnerContext: async () => ({}),
  runnerEnvironment: async () => ({}),
  session: async <T>(_key: MailboxSessionKey, action: (m: MailboxSession) => T | Promise<T>): Promise<T> =>
    action(mailbox as unknown as MailboxSession),
};

async function session(): Promise<Session> {
  return (await getSession(SESSION_ID))!;
}

function ctx(s: Session): SweepSessionContext {
  return {
    session: s,
    runIn: async <T>(_window: string, action: (m: NanoclawMailboxSession) => T | Promise<T>) => action(mailbox),
  } as unknown as SweepSessionContext;
}

const S13 = _listSweepRegistrationsForTesting().duties.find((d) => d.name === SWEEP_DUTY_INVENTORY.S13)!;

/** `startedAtMs` 0 means the registry knows no container for the session. */
async function reap(startedAtMs: number): Promise<void> {
  h.containerName = startedAtMs > 0 ? `nanoclaw-v2-ag-folder-${startedAtMs}` : null;
  await S13.run(ctx(await session()));
  await _settleChatReapFollowUpsForTesting();
}

function recordInFlight(at: number, checkouts: unknown[] = [checkout()]): void {
  outDb
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('worktree_in_flight', JSON.stringify({ at: new Date(at).toISOString(), checkouts }), new Date().toISOString());
}

function checkout(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'app@feat-x',
    branch: 'feat/x',
    upstream: 'origin/feat/x',
    upstream_head: '025ca237c83aaf6e827f58b2f83f0859ddee132b',
    files: ['src/a.ts', 'src/enforce.ts'],
    file_count: 2,
    unpushed: 1,
    ...overrides,
  };
}

function wakeRows(): Array<{ id: string; on_wake: number; trigger: number; content: string }> {
  return inDb
    .prepare("SELECT id, on_wake, trigger, content FROM messages_in WHERE id LIKE 'reap-respawn-%' ORDER BY seq")
    .all() as Array<{ id: string; on_wake: number; trigger: number; content: string }>;
}

function humanReply(): void {
  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_in), 'chat-sdk', ?, 'completed', 1, ?)`,
    )
    .run(`human-${Math.random()}`, new Date(Date.now() + 1_000).toISOString(), JSON.stringify({ text: 'any news?' }));
}

beforeEach(async () => {
  await initMigratedTestDb();
  await createAgentGroup({
    id: 'ag-1',
    name: 'ag',
    folder: 'ag-folder',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await createSession({
    id: SESSION_ID,
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: 'slack:C1:1700000000.000100',
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: '2026-10-05T00:00:00.000Z',
    created_at: '2026-10-05T00:00:00.000Z',
  });
  inDb = new Database(':memory:');
  inDb.exec(INBOUND_SCHEMA);
  outDb = new Database(':memory:');
  outDb.exec(OUTBOUND_SCHEMA);
  mailbox = composeNanoclawSession(inDb, () => outDb);
  resetAgentMailboxForTesting();
  registerAgentMailbox(() => store);
  h.selfHeal = true;
  h.adoptedAtMs = 0;
  h.ownsOutbound = false;
  h.kills = [];
});

afterEach(async () => {
  _resetSweepRegistryForTesting();
  _resetQuietSessionCacheForTesting();
  vi.restoreAllMocks();
  await closeDb();
});

describe('decideReapFollowUp', () => {
  it('wakes only with in-flight work and attempts left', () => {
    expect(decideReapFollowUp({ inFlightCheckouts: 0, priorAttempts: 0 })).toEqual({
      action: 'none',
      reason: 'nothing-in-flight',
    });
    expect(decideReapFollowUp({ inFlightCheckouts: 1, priorAttempts: 0 })).toEqual({ action: 'wake-accountable' });
    expect(
      decideReapFollowUp({ inFlightCheckouts: 1, priorAttempts: WORK_CONTINUATION_RESUME_MAX_ATTEMPTS - 1 }),
    ).toEqual({ action: 'wake-accountable' });
    expect(decideReapFollowUp({ inFlightCheckouts: 2, priorAttempts: WORK_CONTINUATION_RESUME_MAX_ATTEMPTS })).toEqual({
      action: 'none',
      reason: 'capped',
    });
  });
});

describe('the registered chat idle reap (S13) queues an accountable respawn from the runner record', () => {
  it('a record written during the killed container writes exactly one deferred wake naming the work', async () => {
    const spawnedAt = Date.now() - HOUR;
    recordInFlight(spawnedAt + 1_000);

    await reap(spawnedAt);

    expect(h.kills).toEqual([SESSION_ID]);
    const rows = wakeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(`reap-respawn-${spawnedAt}`);
    expect(rows[0].on_wake).toBe(1);
    expect(rows[0].trigger).toBe(0);
    const content = JSON.parse(rows[0].content);
    expect(content.sender).toBe('system');
    expect(content._system).toEqual({ kind: 'agent_reap_respawn', checkouts: ['app@feat-x'] });
    expect(content.text).toContain(`${Math.round(CHAT_IDLE_REAP_MS / 60_000)}-minute chat idle reap`);
    expect(content.text).toContain(
      '/workspace/worktrees/app@feat-x: branch feat/x, pushed upstream origin/feat/x at 025ca237c83a',
    );
    expect(content.text).toContain('1 commit(s) not on the upstream');
    expect(content.text).toContain('2 uncommitted file(s): src/a.ts, src/enforce.ts');
    expect(content.text).toContain('done / lost / next');
    expect(content.text).toContain('continue_work');
  });

  it('a record stamped before the killed container spawned writes nothing', async () => {
    const spawnedAt = Date.now() - HOUR;
    recordInFlight(spawnedAt - 1);
    await reap(spawnedAt);
    expect(h.kills).toEqual([SESSION_ID]);
    expect(wakeRows()).toHaveLength(0);
  });

  it('an empty record writes nothing', async () => {
    const spawnedAt = Date.now() - HOUR;
    recordInFlight(spawnedAt + 1_000, []);
    await reap(spawnedAt);
    expect(wakeRows()).toHaveLength(0);
  });

  it('no record writes nothing', async () => {
    await reap(Date.now() - HOUR);
    expect(wakeRows()).toHaveLength(0);
  });

  it('a malformed record writes nothing', async () => {
    const spawnedAt = Date.now() - HOUR;
    recordInFlight(spawnedAt + 1_000, [checkout({ name: 'app\n- forged line' })]);
    await reap(spawnedAt);
    expect(wakeRows()).toHaveLength(0);
  });

  it.each(['null', 'not json', '[]', '{"at":"yesterday","checkouts":[]}'])(
    'an unparseable record (%s) writes nothing',
    async (value) => {
      outDb
        .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run('worktree_in_flight', value, new Date().toISOString());
      await reap(Date.now() - HOUR);
      expect(wakeRows()).toHaveLength(0);
    },
  );

  it('a record over the size cap is never parsed and writes nothing', async () => {
    const spawnedAt = Date.now() - HOUR;
    outDb
      .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(
        'worktree_in_flight',
        JSON.stringify({ at: new Date().toISOString(), checkouts: [checkout()], pad: 'x'.repeat(70 * 1024) }),
        new Date().toISOString(),
      );
    const parse = vi.spyOn(JSON, 'parse');
    await reap(spawnedAt);
    expect(parse.mock.calls.some(([text]) => typeof text === 'string' && text.includes('"pad"'))).toBe(false);
    expect(wakeRows()).toHaveLength(0);
  });

  it.each([
    ['a 100k-element array', Array.from({ length: 100_000 }, () => 0)],
    ['a 40-element array under the size cap', Array.from({ length: 40 }, () => 0)],
  ])('a record holding %s writes nothing', async (_label, big) => {
    const spawnedAt = Date.now() - HOUR;
    recordInFlight(spawnedAt + 1_000, [checkout({ files: big })]);
    await reap(spawnedAt);
    expect(wakeRows()).toHaveLength(0);
  });

  it('a bad path or a bad checkout entry costs only itself', async () => {
    const spawnedAt = Date.now() - HOUR;
    recordInFlight(spawnedAt + 1_000, [
      checkout({ files: ['src/a.ts', 'x'.repeat(301), 'line\nbreak.ts'], file_count: 3 }),
      checkout({ name: 'app\n- forged line' }),
    ]);
    await reap(spawnedAt);
    const rows = wakeRows();
    expect(rows).toHaveLength(1);
    const content = JSON.parse(rows[0].content);
    expect(content._system.checkouts).toEqual(['app@feat-x']);
    expect(content.text).toContain('3 uncommitted file(s): src/a.ts (+2 more)');
    expect(content.text).not.toContain('forged line');
  });

  it('a container that survived a host restart is attributed by its start, not its adoption', async () => {
    const startedAt = Date.now() - 2 * HOUR;
    recordInFlight(startedAt + 60_000);
    h.adoptedAtMs = Date.now() - HOUR;

    await reap(startedAt);

    expect(wakeRows().map((r) => r.id)).toEqual([`reap-respawn-${startedAt}`]);
  });

  it('reads the start instant from the container name', () => {
    expect(containerStartedAtMs('nanoclaw-v2-team-2-1791245192375')).toBe(1791245192375);
    expect(containerStartedAtMs('nanoclaw-v2-ag')).toBeNull();
    expect(containerStartedAtMs('other-1791245192375')).toBeNull();
    expect(containerStartedAtMs(null)).toBeNull();
  });

  it('an untracked container (no spawn instant) writes nothing', async () => {
    recordInFlight(Date.now());
    await reap(0);
    expect(wakeRows()).toHaveLength(0);
  });

  it('a second follow-up for the same reaped container writes nothing new', async () => {
    const spawnedAt = Date.now() - HOUR;
    recordInFlight(spawnedAt + 1_000);
    await reap(spawnedAt);
    await reap(spawnedAt);
    expect(wakeRows()).toHaveLength(1);
  });

  it(`stops after ${WORK_CONTINUATION_RESUME_MAX_ATTEMPTS} wakes until a real inbound message resets the budget`, async () => {
    const base = Date.now() - HOUR;
    recordInFlight(Date.now());

    for (let i = 0; i < WORK_CONTINUATION_RESUME_MAX_ATTEMPTS + 1; i++) await reap(base + i);
    expect(wakeRows()).toHaveLength(WORK_CONTINUATION_RESUME_MAX_ATTEMPTS);

    humanReply();
    await reap(base + 100);
    expect(wakeRows()).toHaveLength(WORK_CONTINUATION_RESUME_MAX_ATTEMPTS + 1);
  });

  it('writes nothing when a replacement container already owns the session', async () => {
    const spawnedAt = Date.now() - HOUR;
    recordInFlight(spawnedAt + 1_000);
    h.ownsOutbound = true;
    await reap(spawnedAt);
    expect(wakeRows()).toHaveLength(0);
  });

  it('only logs in self-heal shadow mode', async () => {
    const spawnedAt = Date.now() - HOUR;
    recordInFlight(spawnedAt + 1_000);
    h.selfHeal = false;
    const info = vi.spyOn(log, 'info');

    await reap(spawnedAt);

    expect(wakeRows()).toHaveLength(0);
    expect(info).toHaveBeenCalledWith('self-heal: would queue chat-reap accountability wake', expect.anything());
  });

  it('an exhausted continuation parks the reap wake with the other recovery wakes', async () => {
    const spawnedAt = Date.now() - HOUR;
    recordInFlight(spawnedAt + 1_000);
    await reap(spawnedAt);
    // Due admission is what makes a deferred row wakeable; emulate it.
    inDb.prepare("UPDATE messages_in SET trigger = 1 WHERE id LIKE 'reap-respawn-%'").run();

    expect(mailbox.parkDueRecoveryWakes(new Date().toISOString())).toBe(1);
  });

  it('a session the sweep quiet-marked after the kill is swept again on the next tick once the wake lands', async () => {
    // Only the driver: an empty registry finds every session fully quiet, which is the state to reproduce.
    _resetSweepRegistryForTesting({ builtins: false });
    _resetQuietSessionCacheForTesting();
    const spawnedAt = Date.now() - HOUR;
    recordInFlight(spawnedAt + 1_000);

    await _sweepOnceForTesting();
    expect(_lastSweepTickStatsForTesting()).toMatchObject({ sweptSessions: 1, skippedQuiet: 0 });
    expect((await session()).sweep_quiet_until).not.toBeNull();
    await _sweepOnceForTesting();
    expect(_lastSweepTickStatsForTesting()).toMatchObject({ sweptSessions: 0, skippedQuiet: 1 });

    // The kill's follow-up lands while the session is quiet-marked.
    await reap(spawnedAt);
    expect(wakeRows()).toHaveLength(1);
    expect((await session()).sweep_quiet_until).toBeNull();

    await _sweepOnceForTesting();
    expect(_lastSweepTickStatsForTesting()).toMatchObject({ sweptSessions: 1, skippedQuiet: 0 });
  });
});
