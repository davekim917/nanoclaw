/**
 * The delivery loop drains sessions serially, so a repository publish handled
 * inline froze outbound delivery for the whole host while it waited for every
 * sibling container to reach the mount barrier (`cycleMs=172606 polled=2`,
 * 2026-09-01). These tests pin the properties that make running it off the loop
 * safe: one job per request id, strictly one job at a time, an ack the loop no
 * longer writes, and the orphan-fence release on the give-up path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { log } from '../../log.js';
import type { Session } from '../../types.js';

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const marks: Array<{ kind: 'delivered' | 'failed'; id: string; error?: string }> = [];
vi.mock('../../db/session-db.js', () => ({
  markDelivered: (_db: unknown, id: string) => marks.push({ kind: 'delivered', id }),
  markDeliveryFailed: (_db: unknown, id: string, error?: string) => marks.push({ kind: 'failed', id, error }),
}));

let openInboundDbImpl: () => { close: () => void };
const closed: number[] = [];
vi.mock('../../session-manager.js', () => ({
  openInboundDb: () => openInboundDbImpl(),
}));

const releaseOrphans = vi.fn(async (_msg: { kind: string }, _session: Session) => null);
vi.mock('../../repo-fence-recovery.js', () => ({
  releaseOrphanedRepoIngressFencesForDroppedMessage: (msg: { kind: string }, session: Session) =>
    releaseOrphans(msg, session),
}));

const {
  runRepositoryActionDetached,
  _repositoryActionChainForTesting,
  _resetRepositoryActionsForTesting,
  REPOSITORY_REQUEST_ID_PATTERN,
} = await import('./job-runner.js');

const session = { id: 'sess-1', agent_group_id: 'group-1' } as Session;

function requestId(suffix: string): string {
  return `repo-1788289675241-${suffix.padStart(16, '0')}`;
}

/** Let the microtask chain advance without depending on job completion. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  _resetRepositoryActionsForTesting();
  marks.length = 0;
  closed.length = 0;
  releaseOrphans.mockClear();
  vi.mocked(log.error).mockReset();
  openInboundDbImpl = () => ({ close: () => closed.push(1) });
});

describe('runRepositoryActionDetached', () => {
  it('acks the delivery loop immediately instead of waiting for the apply', async () => {
    let started = false;
    const apply = vi.fn(async () => {
      started = true;
      await new Promise(() => {}); // never settles, like a 10-minute quiescence
    });

    const result = await runRepositoryActionDetached(
      'repository_publish',
      apply,
      { requestId: requestId('a') },
      session,
    );

    expect(result).toEqual({ deferAck: true });
    await tick();
    expect(started).toBe(true);
    expect(marks).toEqual([]); // still running — the row stays undelivered
  });

  it('starts exactly one job when the undelivered row is re-dispatched by later polls', async () => {
    let release: (() => void) | null = null;
    const apply = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const content = { requestId: requestId('b') };

    await runRepositoryActionDetached('repository_publish', apply, content, session);
    await runRepositoryActionDetached('repository_publish', apply, content, session);
    await runRepositoryActionDetached('repository_publish', apply, content, session);
    await tick();

    expect(apply).toHaveBeenCalledTimes(1);
    release!();
    await _repositoryActionChainForTesting();
    expect(marks).toEqual([{ kind: 'delivered', id: content.requestId }]);
  });

  it('marks the row delivered on success and closes the inbound handle it opened', async () => {
    const id = requestId('c');
    await runRepositoryActionDetached('repository_publish', async () => {}, { requestId: id }, session);
    await _repositoryActionChainForTesting();

    expect(marks).toEqual([{ kind: 'delivered', id }]);
    expect(closed).toHaveLength(1);
  });

  it('marks the row failed and releases orphaned fences when the action throws', async () => {
    const id = requestId('d');
    await runRepositoryActionDetached(
      'repository_publish',
      async () => {
        throw new Error('timed out waiting for container poll admission and active repository work to drain');
      },
      { requestId: id },
      session,
    );
    await _repositoryActionChainForTesting();

    expect(marks).toEqual([{ kind: 'failed', id, error: expect.stringContaining('timed out waiting') }]);
    expect(releaseOrphans).toHaveBeenCalledTimes(1);
    expect(releaseOrphans).toHaveBeenCalledWith({ kind: 'system' }, session);
  });

  it('never runs two repository actions at once, and a thrown job does not break the chain', async () => {
    const observed: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const first = async (): Promise<void> => {
      observed.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      observed.push('first:end');
      throw new Error('publication failed');
    };
    const second = async (): Promise<void> => {
      observed.push('second:start');
    };

    await runRepositoryActionDetached('repository_publish', first, { requestId: requestId('e') }, session);
    await runRepositoryActionDetached('repository_transfer', second, { requestId: requestId('f') }, session);
    await tick();

    expect(observed).toEqual(['first:start']); // the second job waits its turn
    releaseFirst!();
    await _repositoryActionChainForTesting();
    expect(observed).toEqual(['first:start', 'first:end', 'second:start']);
    expect(marks.map((mark) => mark.kind)).toEqual(['failed', 'delivered']);
  });

  it('keeps the in-flight guard when the ack cannot be written, so the job is not re-run', async () => {
    const id = requestId('0a');
    openInboundDbImpl = () => {
      throw new Error('session inbound database is gone');
    };
    const apply = vi.fn(async () => {});

    await runRepositoryActionDetached('repository_publish', apply, { requestId: id }, session);
    await _repositoryActionChainForTesting();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(marks).toEqual([]);

    // The row is still undelivered, so the next poll re-dispatches it. The next
    // host START replays it; this process must not.
    await runRepositoryActionDetached('repository_publish', apply, { requestId: id }, session);
    await _repositoryActionChainForTesting();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("survives a job error that escapes the job's own handling, without poisoning the chain", async () => {
    // The one seam left uncovered: `ackRow` already catches, so make its own
    // error log throw. Without the terminal catch this rejects the chain — every
    // later repository action is dropped and Node kills the host on the
    // unhandled rejection, which is the failure class this change removes.
    const escaped = requestId('0b');
    const queued = requestId('0c');
    openInboundDbImpl = () => {
      throw new Error('session inbound database is gone');
    };
    vi.mocked(log.error).mockImplementationOnce(() => {
      throw new Error('logger exploded');
    });
    const escapedApply = vi.fn(async () => {});
    const queuedApply = vi.fn(async () => {
      openInboundDbImpl = () => ({ close: () => closed.push(1) });
    });

    await runRepositoryActionDetached('repository_publish', escapedApply, { requestId: escaped }, session);
    await runRepositoryActionDetached('repository_transfer', queuedApply, { requestId: queued }, session);
    await expect(_repositoryActionChainForTesting()).resolves.toBeUndefined();

    expect(queuedApply).toHaveBeenCalledTimes(1); // the chain still runs
    expect(vi.mocked(log.error).mock.calls.at(-1)?.[0]).toBe('Repository action job escaped its own error handling');

    // The escaped job's ack is unproven, so it keeps its in-flight entry and is
    // not re-run by a later poll — only the next host start may replay it.
    await runRepositoryActionDetached('repository_publish', escapedApply, { requestId: escaped }, session);
    await _repositoryActionChainForTesting();
    expect(escapedApply).toHaveBeenCalledTimes(1);
  });

  it('runs an unkeyable payload inline so the delivery loop keeps owning that row', async () => {
    const apply = vi.fn(async () => {
      throw new Error('repository_publish payload is invalid');
    });

    await expect(runRepositoryActionDetached('repository_publish', apply, { repo: 'proj' }, session)).rejects.toThrow(
      /payload is invalid/,
    );
    expect(apply).toHaveBeenCalledTimes(1);
    expect(marks).toEqual([]);
  });

  it('accepts the request ids the container actually generates', () => {
    expect(REPOSITORY_REQUEST_ID_PATTERN.test('repo-1788289675241-b13bcab3ec972233')).toBe(true);
    expect(REPOSITORY_REQUEST_ID_PATTERN.test('repo-1788289675241-NOTHEX0000000000')).toBe(false);
  });
});
