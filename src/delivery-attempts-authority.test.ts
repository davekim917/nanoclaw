/**
 * `delivery_attempts` rows are the authority for delivery retry counts.
 *
 * Before seam 4 series B the count lived in a module-scope `Map`, so every
 * host restart handed a poison message a fresh set of attempts and a
 * crash-looping host retried it forever. The row survives the process, so the
 * message gets MAX_DELIVERY_ATTEMPTS in total rather than per process
 * lifetime.
 *
 * A "process restart" here is `vi.resetModules()` plus a re-import of
 * `delivery.ts` against the SAME central DB file: fresh module memory, same
 * rows. An in-memory DB would prove nothing, so this suite runs on a file.
 *
 * The count is also read BEFORE the adapter runs, so a row a dead host left at
 * the cap is terminal without spending another attempt or re-sending a message
 * that had already left that host.
 *
 * Bookkeeping is deliberately non-fatal, and three of these cases pin that: a
 * failed read still delivers, a failed record skips the give-up decision for
 * the tick (the message retries) and a failed clear costs only a WARN.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-delivery-attempts') }));
const DB_PATH = `${TEST_DIR}/v2.db`;

// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers (including process.exit(1)) at module scope — importOriginal() would
// install those in this test file's worker. Kept as a complete stub instead,
// and hoisted so the same spies survive `vi.resetModules()`.
const { logSpy } = vi.hoisted(() => ({
  logSpy: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: logSpy,
  isSurvivableIoError: vi.fn(() => false),
}));

vi.mock('./container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR, GROUPS_DIR: `${TEST_DIR}/groups` };
});

// The give-up path lazy-imports the repo-fence recovery module. Stubbed so the
// call is observable without dragging a workgroup fixture into every case.
const { fenceRecovery } = vi.hoisted(() => ({ fenceRecovery: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./repo-fence-recovery.js', () => ({
  releaseOrphanedRepoIngressFencesForDroppedMessage: fenceRecovery,
}));

import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
// Type-only: `import type` is erased, so this does not pin a module instance.
import type { ChannelDeliveryAdapter } from './delivery.js';
import type { Session } from './types.js';

/**
 * Everything the host graph exposes must be pulled through a dynamic import
 * after `vi.resetModules()`: a static binding in this file would keep pointing
 * at the pre-restart module instance and its closed DB driver.
 */
interface Host {
  delivery: typeof import('./delivery.js');
  db: typeof import('./db/index.js');
  sessions: typeof import('./session-manager.js');
  coord: typeof import('./db/coordination.js');
}

/** Message ids the adapter must refuse; everything else delivers. */
const poisoned = new Set<string>();
/** Every (message id) the adapter was asked to deliver, across restarts. */
let attempted: string[] = [];

const adapter: ChannelDeliveryAdapter = {
  async deliver(_channelType, _platformId, _threadId, _kind, content) {
    const id = JSON.parse(content).text as string;
    attempted.push(id);
    if (poisoned.has(id)) throw new Error(`refused ${id}`);
    return `plat-${id}`;
  },
};

/** The host currently holding the DB driver, so afterEach can close it. */
let host: Host | undefined;

/**
 * Boot a host process against the central DB file: fresh module memory, the
 * same rows on disk. Called again after `closeDb()` it is the restart.
 */
async function bootHost(): Promise<Host> {
  vi.resetModules();
  // Re-register the mailbox factory the reset just dropped: src/test-setup.ts
  // does this once per test, before the body reaches its first restart.
  await import('./mailbox/compose.js');
  const db = await import('./db/index.js');
  // Migrations run on their own connection rather than through `getRawDb()`:
  // the raw central-DB handle is a shrink-only allowlist and this file is not
  // on it (src/db/raw-db-ratchet.test.ts). Idempotent, so the restart is free.
  const migrator = new Database(DB_PATH);
  try {
    db.runMigrations(migrator);
  } finally {
    migrator.close();
  }
  await db.initDb(DB_PATH);
  const delivery = await import('./delivery.js');
  delivery.setDeliveryAdapter(adapter);
  host = {
    delivery,
    db,
    sessions: await import('./session-manager.js'),
    coord: await import('./db/coordination.js'),
  };
  return host;
}

async function restartHost(): Promise<Host> {
  await host?.db.closeDb();
  return bootHost();
}

function now(): string {
  return new Date().toISOString();
}

async function seedSession(): Promise<Session> {
  const { createAgentGroup, createMessagingGroup } = host!.db;
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  const { session } = await host!.sessions.resolveSession('ag-1', 'mg-1', null, 'shared');
  return session;
}

/** The message's own id doubles as its text, so the adapter can refuse by id. */
function insertOutbound(sessionId: string, msgId: string): void {
  const db = new Database(outboundDbPath('ag-1', sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, ?, 'chat', 'telegram:123', 'telegram', ?)`,
  ).run(msgId, now(), JSON.stringify({ text: msgId }));
  db.close();
}

/** Attempts a previous host recorded — rows only, no module state. */
async function seedPriorAttempts(messageId: string, sessionId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await host!.coord.recordDeliveryAttempt({
      messageId,
      sessionId,
      now: now(),
      nextAttemptAt: null,
      error: 'failure from before the restart',
    });
  }
}

/**
 * Make every coordination accessor fail the way a broken bookkeeping write
 * does, without mocking them: the table they address is gone. Injecting the
 * fault in the DB rather than in a module factory keeps the real accessors and
 * the real driver in the path, which matters because the point of this suite
 * is that the row, not a module, is the authority.
 */
function breakAttemptsTable(): void {
  const db = new Database(DB_PATH);
  try {
    db.exec('ALTER TABLE delivery_attempts RENAME TO delivery_attempts_unreachable');
  } finally {
    db.close();
  }
}

/** Read the attempt row through a fresh connection — no module state involved. */
function attemptRow(messageId: string): { attempts: number } | undefined {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db.prepare('SELECT attempts FROM delivery_attempts WHERE message_id = ?').get(messageId) as
      | { attempts: number }
      | undefined;
  } finally {
    db.close();
  }
}

function deliveredRow(sessionId: string, messageId: string): { status: string } | undefined {
  const db = new Database(inboundDbPath('ag-1', sessionId), { readonly: true });
  try {
    return db.prepare('SELECT status FROM delivered WHERE message_out_id = ?').get(messageId) as
      | { status: string }
      | undefined;
  } finally {
    db.close();
  }
}

function gaveUpCalls(): Array<Record<string, unknown>> {
  return logSpy.error.mock.calls
    .filter((c) => c[0] === 'Message delivery failed permanently, giving up')
    .map((c) => c[1] as Record<string, unknown>);
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  poisoned.clear();
  attempted = [];
  fenceRecovery.mockClear();
  logSpy.info.mockClear();
  logSpy.warn.mockClear();
  logSpy.error.mockClear();
});

afterEach(async () => {
  await host?.db.closeDb();
  host = undefined;
  vi.resetModules();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('delivery_attempts is the retry authority', () => {
  it('attempt counts survive a process restart', async () => {
    let { delivery } = await bootHost();
    const session = await seedSession();
    poisoned.add('out-poison');
    insertOutbound(session.id, 'out-poison');

    expect(await delivery.deliverSessionMessages(session)).toBe('error');
    expect(await delivery.deliverSessionMessages(session)).toBe('error');
    expect(gaveUpCalls()).toHaveLength(0);
    expect(attemptRow('out-poison')?.attempts).toBe(2);

    // The host goes away. The row does not.
    ({ delivery } = await restartHost());
    expect(await delivery.deliverSessionMessages(session)).toBe('error');

    expect(gaveUpCalls()).toEqual([expect.objectContaining({ messageId: 'out-poison', attempts: 3 })]);
    // markDeliveryFailed ran: the inbound `delivered` row is terminal.
    expect(deliveredRow(session.id, 'out-poison')?.status).toBe('failed');
    expect(attemptRow('out-poison')).toBeUndefined();
  });

  it('three restarts each burning one attempt still give up', async () => {
    let { delivery } = await bootHost();
    const session = await seedSession();
    poisoned.add('out-loop');
    insertOutbound(session.id, 'out-loop');

    // The incident shape: a crash-looping host, one delivery attempt per
    // process lifetime. With an in-memory counter this never gives up.
    await delivery.deliverSessionMessages(session);
    ({ delivery } = await restartHost());
    await delivery.deliverSessionMessages(session);
    expect(gaveUpCalls()).toHaveLength(0);

    ({ delivery } = await restartHost());
    await delivery.deliverSessionMessages(session);

    expect(gaveUpCalls()).toEqual([expect.objectContaining({ messageId: 'out-loop', attempts: 3 })]);
    expect(deliveredRow(session.id, 'out-loop')?.status).toBe('failed');
  });

  it('a successful delivery clears the row', async () => {
    const { delivery } = await bootHost();
    const session = await seedSession();
    poisoned.add('out-flaky');
    insertOutbound(session.id, 'out-flaky');

    expect(await delivery.deliverSessionMessages(session)).toBe('error');
    expect(attemptRow('out-flaky')?.attempts).toBe(1);

    poisoned.delete('out-flaky');
    expect(await delivery.deliverSessionMessages(session)).toBe('clean');

    expect(attemptRow('out-flaky')).toBeUndefined();
    expect(deliveredRow(session.id, 'out-flaky')?.status).toBe('delivered');
  });

  it('a failed record skips the give-up decision for that tick', async () => {
    const { delivery } = await bootHost();
    const session = await seedSession();
    poisoned.add('out-first');
    insertOutbound(session.id, 'out-first');
    insertOutbound(session.id, 'out-second');
    breakAttemptsTable();

    // Three drains: with a working counter the third would give up.
    for (let i = 0; i < 3; i++) expect(await delivery.deliverSessionMessages(session)).toBe('error');

    expect(gaveUpCalls()).toHaveLength(0);
    expect(deliveredRow(session.id, 'out-first')).toBeUndefined();
    expect(
      logSpy.error.mock.calls.filter(
        (c) => c[0] === 'Failed to record delivery attempt — retrying next poll without a count',
      ),
    ).toHaveLength(3);
    // The retry branch still `break`s, so the drain never reached out-second.
    expect(attempted).toEqual(['out-first', 'out-first', 'out-first']);
    expect(logSpy.warn.mock.calls.filter((c) => c[0] === 'Message delivery failed, will retry')[0][1]).toMatchObject({
      attempt: null,
    });
  });

  it('a failed clear does not break delivery', async () => {
    const { delivery } = await bootHost();
    const session = await seedSession();
    insertOutbound(session.id, 'out-clean');
    breakAttemptsTable();

    expect(await delivery.deliverSessionMessages(session)).toBe('clean');

    expect(deliveredRow(session.id, 'out-clean')?.status).toBe('delivered');
    expect(logSpy.warn.mock.calls.filter((c) => c[0] === 'Failed to clear delivery attempt row')).toHaveLength(1);
    expect(gaveUpCalls()).toHaveLength(0);
  });

  it('outbound ordering is preserved on retry', async () => {
    const { delivery } = await bootHost();
    const session = await seedSession();
    poisoned.add('out-head');
    insertOutbound(session.id, 'out-head');
    insertOutbound(session.id, 'out-tail');

    expect(await delivery.deliverSessionMessages(session)).toBe('error');

    // Below the cap, so the drain breaks rather than letting out-tail
    // overtake the row that is still owed to the user.
    expect(attemptRow('out-head')?.attempts).toBe(1);
    expect(attempted).toEqual(['out-head']);
    expect(deliveredRow(session.id, 'out-tail')).toBeUndefined();
  });

  it('the give-up path still runs orphaned repository-fence recovery', async () => {
    const { delivery } = await bootHost();
    const session = await seedSession();
    poisoned.add('out-fenced');
    insertOutbound(session.id, 'out-fenced');

    for (let i = 0; i < 3; i++) await delivery.deliverSessionMessages(session);

    expect(gaveUpCalls()).toHaveLength(1);
    expect(fenceRecovery).toHaveBeenCalledTimes(1);
    expect(fenceRecovery.mock.calls[0][0]).toMatchObject({ id: 'out-fenced' });
    expect(fenceRecovery.mock.calls[0][1]).toMatchObject({ id: session.id });
  });

  it('a stored count at the cap gives up before the adapter is called', async () => {
    await bootHost();
    const session = await seedSession();
    insertOutbound(session.id, 'out-stranded');
    // The crash window: a previous host recorded the capped attempt and died
    // before it could write the terminal `delivered` row.
    await seedPriorAttempts('out-stranded', session.id, 3);

    const { delivery } = await restartHost();
    expect(await delivery.deliverSessionMessages(session)).toBe('error');

    // The adapter was never consulted, so no fourth attempt and no chance of
    // re-sending a message the previous host had already put on the wire.
    expect(attempted).toEqual([]);
    expect(deliveredRow(session.id, 'out-stranded')?.status).toBe('failed');
    expect(attemptRow('out-stranded')).toBeUndefined();
    expect(gaveUpCalls()).toEqual([
      expect.objectContaining({
        messageId: 'out-stranded',
        attempts: 3,
        decidedFrom: 'a count stored before this host started',
      }),
    ]);
  });

  it('a failed pre-delivery read still delivers', async () => {
    const { delivery } = await bootHost();
    const session = await seedSession();
    insertOutbound(session.id, 'out-readfail');
    breakAttemptsTable();

    expect(await delivery.deliverSessionMessages(session)).toBe('clean');

    // No stored count is not a reason to hold a message back.
    expect(attempted).toEqual(['out-readfail']);
    expect(deliveredRow(session.id, 'out-readfail')?.status).toBe('delivered');
    expect(
      logSpy.warn.mock.calls.filter(
        (c) => c[0] === 'Failed to read delivery attempt row — delivering without a stored count',
      ),
    ).toHaveLength(1);
    expect(gaveUpCalls()).toHaveLength(0);
    expect(logSpy.error).not.toHaveBeenCalled();
  });
});
