/**
 * The `cli_request` delivery action: the agent's `ncl` transport.
 *
 * The container writes a `cli_request` system row, this handler dispatches the
 * command and writes the response back as a `cli_response` row the container
 * polls for. It had no test until the mailbox seam moved it off the delivery
 * loop's raw handle (plan §4.5b) and two review rounds landed on it, so the
 * two properties that path lives or dies by are pinned here: the response row
 * actually lands, and the handler never provisions storage.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({
  TEST_DIR: globalThis.uniqueTmpRoot('cli-delivery-action'),
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: TEST_DIR,
  GROUPS_DIR: `${TEST_DIR}/groups`,
}));

const dispatch = vi.fn();
vi.mock('./dispatch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./dispatch.js')>()),
  dispatch: (...args: unknown[]) => dispatch(...args),
}));

// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers (including process.exit(1)) at module scope — importOriginal() would
// install those in this test file's worker. Kept as a complete stub instead.
// (davekim917/nanoclaw#355 review thread)
vi.mock('../log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

import { closeDb, initTestDb, runMigrations, getRawDb } from '../db/index.js';
import { getDeliveryAction } from '../delivery.js';
import { log } from '../log.js';
import { initSessionFolder } from '../session-manager.js';
import { inboundDbPath } from '../mailbox/sqlite/paths.js';
import type { Session } from '../types.js';
import './delivery-action.js';

function session(): Session {
  return {
    id: 'sess-cli',
    agent_group_id: 'ag-cli',
    messaging_group_id: 'mg-cli',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

function responseRow(): { content: string } | undefined {
  const db = new Database(inboundDbPath('ag-cli', 'sess-cli'), { readonly: true });
  try {
    return db.prepare("SELECT content FROM messages_in WHERE id = 'cli-resp-req-1'").get() as
      | { content: string }
      | undefined;
  } finally {
    db.close();
  }
}

/** Every warn the handler logged, flattened. */
function warnings(): string {
  return vi
    .mocked(log.warn)
    .mock.calls.map((args) => args.map((a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    .join('\n');
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  // executeOnce (delivery-action.ts) unconditionally claims the request
  // against the central-DB execution ledger (request-ledger.ts) before
  // dispatching — the central DB must exist for the handler to reach dispatch
  // at all, let alone the response write these tests actually pin.
  await initTestDb();
  runMigrations(getRawDb());
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.info).mockClear();
  dispatch.mockReset();
  dispatch.mockResolvedValue({ id: 'req-1', ok: true, data: { groups: [] } });
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('cli_request delivery action', () => {
  it('writes the dispatched response into the calling session and reports success', async () => {
    initSessionFolder('ag-cli', 'sess-cli');
    const handler = getDeliveryAction('cli_request');
    expect(handler).toBeDefined();

    await handler!({ action: 'cli_request', requestId: 'req-1', command: 'groups-list', args: {} }, session());

    const row = responseRow();
    expect(row).toBeDefined();
    expect(JSON.parse(row!.content)).toMatchObject({
      type: 'cli_response',
      requestId: 'req-1',
      frame: { id: 'req-1', ok: true },
    });
    // Regression, PR #268 round 2: the callback must return a sentinel.
    // `insertMessage` resolves to `void`, so returning its own result made a
    // successful write look identical to the vanished-mailbox answer — every
    // request logged "dropped" and the success log never fired.
    expect(warnings()).not.toMatch(/CLI response dropped/);
    expect(vi.mocked(log.info).mock.calls.map((c) => c[0])).toContain('CLI response written');
  });

  it('never provisions a mailbox for a session that has none', async () => {
    const handler = getDeliveryAction('cli_request');

    await handler!({ action: 'cli_request', requestId: 'req-1', command: 'groups-list', args: {} }, session());

    // Regression, PR #268 round 1: provisioning here would open the
    // CONTAINER-owned outbound.db read-write to apply its schema, and this
    // runs after the command has already executed — a failed prepare would
    // make the delivery loop retry a completed mutation.
    expect(fs.existsSync(`${TEST_DIR}/v2-sessions/ag-cli/sess-cli`)).toBe(false);
    expect(warnings()).toMatch(/CLI response dropped/);
  });

  it('rejects a frame with no requestId or command before dispatching', async () => {
    initSessionFolder('ag-cli', 'sess-cli');
    const handler = getDeliveryAction('cli_request');

    await handler!({ action: 'cli_request', command: 'groups-list', args: {} }, session());
    await handler!({ action: 'cli_request', requestId: 'req-1', args: {} }, session());

    expect(dispatch).not.toHaveBeenCalled();
    expect(responseRow()).toBeUndefined();
  });
});
