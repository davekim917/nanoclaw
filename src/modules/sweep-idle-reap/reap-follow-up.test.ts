/**
 * The chat idle reap's accountability wake, driven through the REGISTERED S13 duty against real temp git checkouts
 * at the exact topic worktrees path the session's container mounts, and a real in-memory session mailbox.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../../db/schema.js';
import type { Session } from '../../types.js';

const h = await vi.hoisted(async () => {
  const nodeFs = await import('fs');
  const nodeOs = await import('os');
  const nodePath = await import('path');
  return {
    dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'reap-follow-up-')),
    selfHeal: true,
    spawnedAtMs: 0,
    ownsOutbound: false,
    kills: [] as string[],
  };
});

vi.mock('../../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config.js')>();
  return {
    ...real,
    get SELF_HEAL_ENABLED() {
      return h.selfHeal;
    },
    get DATA_DIR() {
      return h.dataDir;
    },
  };
});

vi.mock('../../container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../container-runner.js')>();
  return {
    ...real,
    getContainerSpawnedAt: () => h.spawnedAtMs,
    containerOwnsOutbound: () => h.ownsOutbound,
    killContainer: (sessionId: string, _reason: string, onExit?: () => void) => {
      h.kills.push(sessionId);
      onExit?.();
    },
  };
});

vi.mock('../../db/agent-groups.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/agent-groups.js')>()),
  getAgentGroup: async () => ({ id: 'ag-1', folder: 'ag-folder', workgroup_id: 'wg-test' }),
}));

vi.mock('../../db/messaging-groups.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/messaging-groups.js')>()),
  getMessagingGroup: async () => ({ id: 'mg-1', channel_type: 'slack', platform_id: 'slack:C1' }),
}));

import { CHAT_IDLE_REAP_MS } from './index.js';
import { _settleChatReapFollowUpsForTesting } from './reap-follow-up.js';
import { _listSweepRegistrationsForTesting, SWEEP_DUTY_INVENTORY, type SweepSessionContext } from '../../host-sweep.js';
import { composeNanoclawSession, type NanoclawMailboxSession } from '../mailbox/index.js';
import { resolveRepositoryWorkUnit, topicWorktreesDir } from '../../repository-workspaces.js';
import { decideReapFollowUp } from '../sweep-continuation/decide.js';
import { WORK_CONTINUATION_RESUME_MAX_ATTEMPTS } from '../mailbox/ops/continuation.js';
import { log } from '../../log.js';

const SESSION = {
  id: 'sess-reap',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-1',
  thread_id: 'slack:C1:1700000000.000100',
  status: 'active',
} as unknown as Session;

const HOUR = 60 * 60 * 1000;

function worktreesDir(): string {
  return topicWorktreesDir(
    resolveRepositoryWorkUnit({
      workgroupId: 'wg-test',
      sessionId: SESSION.id,
      platformId: 'slack:C1',
      messagingGroupId: 'mg-1',
      threadId: SESSION.thread_id,
    }),
    h.dataDir,
  );
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    stdio: 'pipe',
  })
    .toString()
    .trim();
}

/** A pushed, tracked clone at `<topic worktrees>/app@feat-x`, the layout `checkoutDirName` produces. */
function makeCheckout(): string {
  const scratch = path.join(h.dataDir, 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const origin = path.join(scratch, 'origin.git');
  git(scratch, ['init', '-q', '--bare', origin]);
  const seed = path.join(scratch, 'seed');
  git(scratch, ['init', '-q', seed]);
  fs.writeFileSync(path.join(seed, 'a.ts'), 'a\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-q', '-m', 'seed']);
  git(seed, ['push', '-q', origin, 'HEAD:main']);
  const checkout = path.join(worktreesDir(), 'app@feat-x');
  fs.mkdirSync(path.dirname(checkout), { recursive: true });
  git(scratch, ['clone', '-q', origin, checkout]);
  git(checkout, ['checkout', '-q', '-b', 'feat/x']);
  git(checkout, ['push', '-q', '-u', 'origin', 'feat/x']);
  return checkout;
}

let inDb: Database.Database;
let outDb: Database.Database;
let mailbox: NanoclawMailboxSession;

function ctx(): SweepSessionContext {
  return {
    session: SESSION,
    runIn: async <T>(_window: string, action: (m: NanoclawMailboxSession) => T | Promise<T>) => action(mailbox),
  } as unknown as SweepSessionContext;
}

async function reap(spawnedAtMs: number): Promise<void> {
  h.spawnedAtMs = spawnedAtMs;
  const duty = _listSweepRegistrationsForTesting().duties.find((d) => d.name === SWEEP_DUTY_INVENTORY.S13);
  await duty!.run(ctx());
  await _settleChatReapFollowUpsForTesting();
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

beforeEach(() => {
  fs.rmSync(path.join(h.dataDir, 'v2-topics'), { recursive: true, force: true });
  fs.rmSync(path.join(h.dataDir, 'scratch'), { recursive: true, force: true });
  inDb = new Database(':memory:');
  inDb.exec(INBOUND_SCHEMA);
  outDb = new Database(':memory:');
  outDb.exec(OUTBOUND_SCHEMA);
  mailbox = composeNanoclawSession(inDb, () => outDb);
  h.selfHeal = true;
  h.ownsOutbound = false;
  h.kills = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(h.dataDir, { recursive: true, force: true });
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

describe('the registered chat idle reap (S13) queues an accountable respawn for recent on-disk work', () => {
  it('a reap of a session with recent uncommitted edits writes exactly one deferred wake naming the work', async () => {
    const checkout = makeCheckout();
    const spawnedAt = Date.now() - 2_000;
    fs.writeFileSync(path.join(checkout, 'a.ts'), 'edited\n');
    fs.writeFileSync(path.join(checkout, 'enforce.ts'), 'new\n');

    await reap(spawnedAt);

    expect(h.kills).toEqual([SESSION.id]);
    const rows = wakeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(`reap-respawn-${spawnedAt}`);
    expect(rows[0].on_wake).toBe(1);
    expect(rows[0].trigger).toBe(0);
    const content = JSON.parse(rows[0].content);
    expect(content.sender).toBe('system');
    expect(content._system).toEqual({ kind: 'agent_reap_respawn', checkouts: ['app@feat-x'] });
    expect(content.text).toContain(`${Math.round(CHAT_IDLE_REAP_MS / 60_000)}-minute chat idle reap`);
    expect(content.text).toContain('/workspace/worktrees/app@feat-x: branch feat/x');
    expect(content.text).toContain(
      `pushed upstream origin/feat/x at ${git(checkout, ['rev-parse', 'origin/feat/x']).slice(0, 12)}`,
    );
    expect(content.text).toContain('2 uncommitted file(s): ');
    expect(content.text).toContain('a.ts');
    expect(content.text).toContain('enforce.ts');
    expect(content.text).toContain('done / lost / next');
    expect(content.text).toContain('continue_work');
  });

  it('a second follow-up for the same reaped container writes nothing new', async () => {
    const checkout = makeCheckout();
    const spawnedAt = Date.now() - 2_000;
    fs.writeFileSync(path.join(checkout, 'a.ts'), 'edited\n');

    await reap(spawnedAt);
    await reap(spawnedAt);

    expect(wakeRows()).toHaveLength(1);
  });

  it('a reap of a clean session writes nothing', async () => {
    makeCheckout();
    await reap(Date.now() - HOUR);
    expect(h.kills).toEqual([SESSION.id]);
    expect(wakeRows()).toHaveLength(0);
  });

  it('a reap of a session whose only dirt predates the container writes nothing', async () => {
    const checkout = makeCheckout();
    const edited = path.join(checkout, 'a.ts');
    fs.writeFileSync(edited, 'left by an earlier container\n');
    const old = new Date(Date.now() - 3 * HOUR);
    fs.utimesSync(edited, old, old);

    await reap(Date.now() - HOUR);

    expect(wakeRows()).toHaveLength(0);
  });

  it('a recent commit that was never pushed wakes the session', async () => {
    const checkout = makeCheckout();
    const spawnedAt = Date.now() - 5_000;
    fs.writeFileSync(path.join(checkout, 'a.ts'), 'committed\n');
    git(checkout, ['commit', '-q', '-am', 'work']);

    await reap(spawnedAt);

    const rows = wakeRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toContain('1 commit(s) not on the upstream');
  });

  it(`stops after ${WORK_CONTINUATION_RESUME_MAX_ATTEMPTS} wakes until a real inbound message resets the budget`, async () => {
    const checkout = makeCheckout();
    const base = Date.now() - 60_000;
    fs.writeFileSync(path.join(checkout, 'a.ts'), 'still dirty\n');

    for (let i = 0; i < WORK_CONTINUATION_RESUME_MAX_ATTEMPTS + 1; i++) await reap(base + i);
    expect(wakeRows()).toHaveLength(WORK_CONTINUATION_RESUME_MAX_ATTEMPTS);

    humanReply();
    await reap(base + 100);
    expect(wakeRows()).toHaveLength(WORK_CONTINUATION_RESUME_MAX_ATTEMPTS + 1);
  });

  it('writes nothing when a replacement container already owns the session', async () => {
    const checkout = makeCheckout();
    const spawnedAt = Date.now() - 2_000;
    fs.writeFileSync(path.join(checkout, 'a.ts'), 'edited\n');
    h.ownsOutbound = true;

    await reap(spawnedAt);

    expect(wakeRows()).toHaveLength(0);
  });

  it('only logs in self-heal shadow mode', async () => {
    const checkout = makeCheckout();
    fs.writeFileSync(path.join(checkout, 'a.ts'), 'edited\n');
    h.selfHeal = false;
    const info = vi.spyOn(log, 'info');

    await reap(Date.now() - 2_000);

    expect(wakeRows()).toHaveLength(0);
    expect(info).toHaveBeenCalledWith('self-heal: would queue chat-reap accountability wake', expect.anything());
  });

  it('writes nothing for an untracked container (no spawn instant to bound recency by)', async () => {
    const checkout = makeCheckout();
    fs.writeFileSync(path.join(checkout, 'a.ts'), 'edited\n');

    await reap(0);

    expect(wakeRows()).toHaveLength(0);
  });

  it('an unreadable checkout writes nothing and warns', async () => {
    const broken = path.join(worktreesDir(), 'app@broken');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, '.git'), 'gitdir: /nonexistent/admin/dir\n');
    const warn = vi.spyOn(log, 'warn');

    await reap(Date.now() - HOUR);

    expect(wakeRows()).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      'Chat-reap worktree check could not read some checkouts — not counted as work in flight',
      expect.objectContaining({ sessionId: SESSION.id, inFlight: 0 }),
    );
  });

  it('an exhausted continuation parks the reap wake with the other recovery wakes', async () => {
    const checkout = makeCheckout();
    fs.writeFileSync(path.join(checkout, 'a.ts'), 'edited\n');
    await reap(Date.now() - 2_000);
    // Due admission is what makes a deferred row wakeable; emulate it.
    inDb.prepare("UPDATE messages_in SET trigger = 1 WHERE id LIKE 'reap-respawn-%'").run();

    expect(mailbox.parkDueRecoveryWakes(new Date().toISOString())).toBe(1);
  });
});
