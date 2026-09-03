/**
 * Acceptance cases R-1..R-5, R-9, R-10 for the runner mailbox seam
 * (docs/specs/upstream-mailbox-seam/plan.md §8).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getInboundDb, getOutboundDb } from '../../mailbox/sqlite/connection.js';
import { getAgentMailbox } from '../../mailbox/index.js';
import { getMessageIn, getPendingMessages } from '../../db/messages-in.js';
import { INBOUND_KINDS } from './inbound-kinds.js';
import {
  NanoclawAgentMailbox,
  acknowledgeRepositoryMountBarrier,
  cancelWorkContinuation,
  clearDoneProposal,
  clearWorkContinuationIfMatches,
  getDoneProposal,
  getStickyEffort,
  getStickyModel,
  getWorkContinuation,
  markWorkContinuationRunning,
  prepareOutboundFile,
  proposeDone,
  queueWorkContinuation,
  setProviderHealthState,
  setStickyEffort,
  setStickyModel,
  writeResourceTelemetry,
  type NanoclawMailboxOperations,
} from './index.js';
import { closeSessionDb, initTestSessionDb } from './testing.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mailbox-r2-'));
  tempDirs.push(dir);
  return path.join(dir, 'outbound.db');
}

interface InsertOptions {
  kind?: string;
  trigger?: number;
  status?: string;
  processAfter?: string | null;
  onWake?: number;
}

let seq = 0;

function insertMessage(id: string, content: unknown, options: InsertOptions = {}): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
         (id, seq, kind, timestamp, status, process_after, recurrence, series_id, tries, trigger,
          platform_id, channel_type, thread_id, content, on_wake)
       VALUES ($id, $seq, $kind, $timestamp, $status, $process_after, NULL, NULL, 0, $trigger,
               'room', 'test', NULL, $content, $on_wake)`,
    )
    .run({
      $id: id,
      $seq: (seq += 2),
      $kind: options.kind ?? 'chat',
      $timestamp: new Date().toISOString(),
      $status: options.status ?? 'pending',
      $process_after: options.processAfter ?? null,
      $trigger: options.trigger ?? 1,
      $content: JSON.stringify(content),
      $on_wake: options.onWake ?? 0,
    });
}

beforeEach(() => {
  seq = 0;
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('runner mailbox seam', () => {
  test('boot registers NanoclawAgentMailbox and start(null) succeeds', async () => {
    const mailbox = getAgentMailbox();
    expect(mailbox).toBeInstanceOf(NanoclawAgentMailbox);
    // I-1: a host that predates the seam writes no context file, so the runner
    // must boot with a null key.
    await expect(mailbox.start(null)).resolves.toBeUndefined();
    // `operations` is usable directly — no run() wrapper needed.
    insertMessage('op-1', { text: 'hi' });
    expect(mailbox.operations.getPendingMessages(10, true).map((m) => m.id)).toEqual(['op-1']);
  });

  test('outbound singleton runs busy_timeout, journal_mode=DELETE, foreign_keys=ON in that order; inbound opens set mmap_size=0', async () => {
    // Order, on the one opener the fork owns. Upstream's getOutboundDb runs
    // journal_mode BEFORE busy_timeout and switching journal mode takes an
    // exclusive lock, so prepareOutboundFile pins the (persistent) journal mode
    // behind a busy handler first and upstream's PRAGMA becomes a no-op read.
    const calls: string[] = [];
    prepareOutboundFile(
      () =>
        ({
          exec: (sql: string) => calls.push(sql.trim()),
          close: () => {},
        }) as unknown as Database,
    );
    expect(calls).toEqual(['PRAGMA busy_timeout = 5000', 'PRAGMA journal_mode = DELETE']);

    // Readback on a real file: journal_mode is DELETE, which is the cross-mount
    // invariant (I-5) — WAL's mmap'd -shm does not propagate over VirtioFS.
    const dbPath = tempDbPath();
    prepareOutboundFile(() => new Database(dbPath));
    const onDisk = new Database(dbPath);
    expect(onDisk.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    expect(onDisk.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 0 });
    onDisk.close();

    await getAgentMailbox().start(null);
    const outbound = getOutboundDb();
    expect(outbound.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    // The fork schema is applied on the outbound singleton by start().
    const tables = new Set(
      (outbound.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    expect(tables.has('turn_usage')).toBe(true);
    expect(tables.has('rate_limit_samples')).toBe(true);
    expect(tables.has('container_state')).toBe(true);
    const containerColumns = new Set(
      (outbound.prepare("PRAGMA table_info('container_state')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const column of ['provider_status', 'provider_failure_reason', 'memory_current_bytes']) {
      expect(containerColumns.has(column)).toBe(true);
    }
  });

  test('INBOUND_KINDS is exactly upstream’s closed set', () => {
    expect([...INBOUND_KINDS].sort()).toEqual(['chat', 'chat-sdk', 'system', 'task', 'webhook']);
  });

  test.each(INBOUND_KINDS)(
    'inbound kind %s round-trips through the compat getPendingMessages and getMessageIn',
    (kind) => {
      const errors = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const id = kind === 'system' ? 'recall-target-1' : `row-${kind}`;
        if (kind === 'system') {
          insertMessage('target-1', { text: 'do the thing' });
          insertMessage(id, { subtype: 'recall_context', text: 'facts' }, { kind, trigger: 0 });
        } else {
          insertMessage(id, { text: 'hello' }, { kind });
        }

        const pending = getPendingMessages(true);
        expect(pending.map((row) => row.id)).toContain(id);
        expect(pending.find((row) => row.id === id)?.kind).toBe(kind);

        const single = getMessageIn(id);
        expect(single?.id).toBe(id);
        expect(single?.kind).toBe(kind);

        expect(
          errors.mock.calls.filter(([message]) => String(message).includes('Skipping invalid inbound mailbox row')),
        ).toEqual([]);
      } finally {
        errors.mockRestore();
      }
    },
  );

  test('an inbound kind outside the inventory is skipped and logged', () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      insertMessage('bogus-1', { text: 'hello' }, { kind: 'bogus' });
      expect(getPendingMessages(true)).toEqual([]);
      expect(
        errors.mock.calls.filter(([message]) => String(message).includes('Skipping invalid inbound mailbox row')),
      ).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });

  test('getPendingMessages keeps recall units atomic and honours the wake window', () => {
    // A due task plus its recall marker, buried under a long trigger=0 tail.
    insertMessage('due-task', { prompt: 'run now' }, { kind: 'task' });
    insertMessage('recall-due-task', { subtype: 'recall_context', text: 'task facts' }, { kind: 'system', trigger: 0 });
    for (let i = 0; i < 200; i++) insertMessage(`context-${i}`, { text: `context ${i}` }, { trigger: 0 });

    const ids = getPendingMessages(false).map((row) => row.id);
    expect(ids).toContain('due-task');
    expect(ids).toContain('recall-due-task');
    // Chronological order: the older wake unit precedes the newest context row.
    expect(ids.indexOf('due-task')).toBeLessThan(ids.indexOf('context-199'));
  });

  test('getPendingMessages hides on_wake rows and future rows outside the wake window', () => {
    insertMessage('wake-only', { text: 'on wake' }, { onWake: 1 });
    insertMessage('future', { text: 'later' }, { processAfter: '2099-01-01T00:00:00.000Z' });
    insertMessage('now', { text: 'now' });

    expect(getPendingMessages(false).map((row) => row.id)).toEqual(['now']);
    expect(getPendingMessages(true).map((row) => row.id)).toEqual(['wake-only', 'now']);
  });

  test('fenced session returns [] from getPendingMessages and never writes the barrier ack from selection', async () => {
    await getAgentMailbox().start(null);
    const operations = getAgentMailbox().operations as NanoclawMailboxOperations;

    insertMessage('fenced-1', { text: 'should not be selected' });
    getInboundDb()
      .prepare("INSERT INTO repo_ingress_fence (id, epoch, generation, state) VALUES (1, ?, ?, 'active')")
      .run('epoch-1', 'gen-1');

    expect(getPendingMessages(true)).toEqual([]);
    expect(operations.getActiveRepositoryMountBarrier()).toBe(JSON.stringify(['epoch-1', 'gen-1']));
    const ackKey = 'repository_mount_barrier_ack';
    expect(getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?').get(ackKey)).toBeNull();

    // Only the explicit acknowledgement writes it.
    acknowledgeRepositoryMountBarrier(JSON.stringify(['epoch-1', 'gen-1']));
    expect(getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?').get(ackKey)).toEqual({
      value: JSON.stringify(['epoch-1', 'gen-1']),
    });

    // Released fence re-admits.
    getInboundDb().prepare("UPDATE repo_ingress_fence SET state = 'released' WHERE id = 1").run();
    expect(getPendingMessages(true).map((row) => row.id)).toEqual(['fenced-1']);
  });

  test('sticky settings, work continuation and done proposal ops persist through session_state', () => {
    setStickyModel('opus');
    setStickyEffort('high');
    expect(getStickyModel()).toBe('opus');
    expect(getStickyEffort()).toBe('high');

    const queued = queueWorkContinuation('finish the migration', 'in-1');
    expect(queued.accepted).toBe(true);
    const id = queued.accepted ? queued.continuation.id : '';
    expect(getWorkContinuation()?.phase).toBe('queued');

    expect(markWorkContinuationRunning(id, 'runner-a')?.phase).toBe('running');
    // A stale id must not clear another runner's claim.
    expect(clearWorkContinuationIfMatches('some-other-id')).toBe(false);
    expect(getWorkContinuation()?.phase).toBe('running');
    expect(clearWorkContinuationIfMatches(id)).toBe(true);
    expect(getWorkContinuation()).toBeUndefined();

    expect(proposeDone('nothing left to do').reason).toBe('nothing left to do');
    expect(getDoneProposal()?.reason).toBe('nothing left to do');
    // Taking on more work retracts the proposal.
    queueWorkContinuation('one more thing');
    expect(getDoneProposal()).toBeUndefined();
    expect(clearDoneProposal()).toBe(false);
    expect(cancelWorkContinuation()).toBe(true);

    // Sticky settings survive a batch that set no flags.
    expect(getStickyModel()).toBe('opus');
    expect(getStickyEffort()).toBe('high');
  });

  test('provider health and tool-in-flight writes land in container_state with the fork columns', async () => {
    await getAgentMailbox().start(null);

    setProviderHealthState({
      status: 'recovering',
      lastEventAt: '2026-09-03T00:00:00.000Z',
      lastProbeAt: '2026-09-03T00:00:05.000Z',
      probeFailures: 2,
      recoveryAttempts: 1,
      failureReason: 'control_plane_unresponsive',
    });
    // Through operations, not db/container-state.js: bun's mock.module is
    // process-global and another suite stubs that shim to a no-op.
    getAgentMailbox().operations.setContainerToolInFlight('Bash', 600000);
    writeResourceTelemetry({
      currentBytes: 1024,
      peakBytes: 2048,
      maxBytes: 4096,
      oomEvents: 1,
      oomKillEvents: 0,
      maxEvents: 3,
    });

    const row = getOutboundDb().prepare('SELECT * FROM container_state WHERE id = 1').get() as Record<string, unknown>;
    expect(row.provider_status).toBe('recovering');
    expect(row.provider_probe_failures).toBe(2);
    expect(row.provider_recovery_attempts).toBe(1);
    expect(row.provider_failure_reason).toBe('control_plane_unresponsive');
    expect(row.current_tool).toBe('Bash');
    expect(row.tool_declared_timeout_ms).toBe(600000);
    expect(row.memory_current_bytes).toBe(1024);
    expect(row.memory_max_events).toBe(3);
  });
});
