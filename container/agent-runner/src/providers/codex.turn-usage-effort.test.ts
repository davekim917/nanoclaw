/**
 * End-to-end: a Codex turn run at a known reasoning effort records THAT
 * effort in the session's `turn_usage` row.
 *
 * The second provider required alongside claude.turn-usage-effort.test.ts —
 * effort attribution has to be a fleet-wide property of the ledger, not a
 * Claude-only one, or `effort IS NULL` stops meaning anything. Drives the real
 * CodexProvider against a fake app-server (same shape as
 * codex.token-usage.test.ts, trimmed to one usage notification) and asserts on
 * the SQLite row, not on the event.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { MEMORY_SESSION_HOOK } from '../memory/session-hook.js';
import { getTurnUsageRows, recordTurnUsage, _resetCumulativeTrackingForTesting } from '../modules/mailbox/turn-usage.js';
import { CodexProvider, codexConfigSchema } from './codex.js';
import type { TurnUsageInfo } from './types.js';

const ORIGINAL_ENV = {
  PATH: process.env.PATH,
  CODEX_HOME: process.env.CODEX_HOME,
  CODEX_HEALTH_STILL_WORKING_NOTICE_MS: process.env.CODEX_HEALTH_STILL_WORKING_NOTICE_MS,
};

let tmpDir = '';

beforeEach(() => {
  initTestSessionDb();
  _resetCumulativeTrackingForTesting();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-effort-usage-'));
});

afterEach(() => {
  closeSessionDb();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Fake codex app-server: one turn, one token-usage notification, then done. */
function writeFakeCodex(binDir: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'codex'),
    `#!/usr/bin/env bun
import readline from 'readline';

const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const usage = {
  totalTokens: 4328, inputTokens: 4210, cachedInputTokens: 3900,
  cacheWriteInputTokens: 0, outputTokens: 118, reasoningOutputTokens: 40,
};

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    send({ id: request.id, result: { userAgent: 'fake-codex' } });
    return;
  }
  if (request.method === 'thread/start' || request.method === 'thread/resume') {
    send({ id: request.id, result: { thread: { id: 'thread-1', status: { type: 'idle' } } } });
    return;
  }
  if (request.method === 'turn/start') {
    send({ id: request.id, result: { turn: { id: 'turn-1' } } });
    send({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', items: [] } },
    });
    setTimeout(() => {
      send({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          tokenUsage: { last: usage, total: usage, modelContextWindow: 258400 },
        },
      });
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'done' } });
      send({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } },
      });
    }, 5);
    return;
  }
  if (request.method === 'thread/read') return;
  if (request.method === 'thread/list') {
    send({ id: request.id, result: { data: [] } });
    return;
  }
  if (request.method === 'turn/interrupt') send({ id: request.id, result: {} });
});
`,
    { mode: 0o755 },
  );
}

/**
 * Run one turn and persist its usage the way poll-loop.ts does, then return
 * the row that reached SQLite.
 */
async function runTurnAndRecord(
  options: { providerConfig?: Record<string, unknown>; effort?: string } = {},
): Promise<{ effort: string | null; effort_requested: string | null; model: string | null }> {
  const binDir = path.join(tmpDir, 'bin');
  const codexHome = path.join(tmpDir, 'codex-home');
  writeFakeCodex(binDir);
  fs.mkdirSync(codexHome, { recursive: true });

  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_HEALTH_STILL_WORKING_NOTICE_MS = '10000';

  const provider = new CodexProvider({ providerConfig: options.providerConfig ?? {} });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const query = provider.query({ prompt: 'one turn', cwd: tmpDir, effort: options.effort });

  for await (const event of query.events) {
    if (event.type !== 'result') continue;
    const usage = event.usage as TurnUsageInfo | TurnUsageInfo[] | undefined;
    for (const u of Array.isArray(usage) ? usage : [usage]) recordTurnUsage('codex', u ?? {}, undefined, 'thread-1');
    query.end();
  }
  const [row] = getTurnUsageRows();
  return row as unknown as { effort: string | null; effort_requested: string | null; model: string | null };
}

describe('codex turn effort -> turn_usage row', () => {
  it('records the configured sticky effort a turn ran at', async () => {
    const row = await runTurnAndRecord({ providerConfig: { reasoning_effort: 'low' } });
    expect(row).toMatchObject({ effort: 'low', effort_requested: 'low' });
  }, 15_000);

  it('records the schema default when nothing was configured', async () => {
    // Derived, not hardcoded. The contract under test is "an unconfigured run
    // records the provider's own default", and that default is an operator
    // dial: it has been xhigh, then high, and is currently `low` under a
    // one-week gpt-6-astra trial (c58597034). A literal here would make this
    // test a change-detector for that dial and it would go red when the trial
    // ends — which is not a fact about this plumbing.
    const schemaDefault = codexConfigSchema.parse({}).reasoning_effort;
    const row = await runTurnAndRecord();
    expect(row.effort).toBe(schemaDefault);
    // Guard against the tautology: it must be a real value, not null/undefined.
    expect(row.effort).toBeTruthy();
  }, 15_000);

  it('records a per-turn -e over the sticky config', async () => {
    const row = await runTurnAndRecord({ providerConfig: { reasoning_effort: 'low' }, effort: 'xhigh' });
    expect(row).toMatchObject({ effort: 'xhigh', effort_requested: 'xhigh' });
  }, 15_000);

  it('shows an ignored -e as a divergence instead of letting it look applied', async () => {
    // Codex silently drops a `-e` outside its vocabulary and stays on the
    // sticky default. Recording only the effective value would hide that the
    // operator asked for something else entirely.
    const row = await runTurnAndRecord({ providerConfig: { reasoning_effort: 'low' }, effort: 'bogus' });
    expect(row.effort).toBe('low');
    expect(row.effort_requested).toBe('bogus');
  }, 15_000);
});
