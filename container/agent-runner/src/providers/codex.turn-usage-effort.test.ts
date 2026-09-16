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
import {
  getTurnUsageRows,
  recordTurnUsage,
  _resetCumulativeTrackingForTesting,
} from '../modules/mailbox/turn-usage.js';
import { CodexProvider, codexConfigSchema } from './codex.js';
import type { TurnUsageInfo } from './types.js';

const ORIGINAL_ENV = {
  PATH: process.env.PATH,
  CODEX_HOME: process.env.CODEX_HOME,
  CODEX_HEALTH_STILL_WORKING_NOTICE_MS: process.env.CODEX_HEALTH_STILL_WORKING_NOTICE_MS,
  FAKE_CODEX_THREAD_PARAMS_FILE: process.env.FAKE_CODEX_THREAD_PARAMS_FILE,
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
import fs from 'fs';

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
  // verifyCodexHookTrust (codex-companion-setup.ts) refuses the spawn unless
  // every generated guard handler reads back dispatchable. The provider writes
  // hooks.json AND its trust entries immediately before each spawn, so a
  // faithful fake reports exactly those two handlers trusted and enabled —
  // which is what a real codex 0.154.0 does against the same home (measured).
  if (request.method === 'hooks/list') {
    const home = process.env.CODEX_HOME || (process.env.HOME || '/home/node') + '/.codex';
    const hooksPath = home + '/hooks.json';
    const rows = ['pre_tool_use', 'post_tool_use'].map((event, index) => ({
      key: hooksPath + ':' + event + ':0:0',
      eventName: event,
      handlerType: 'command',
      sourcePath: hooksPath,
      source: 'user',
      pluginId: null,
      displayOrder: index,
      enabled: true,
      isManaged: false,
      trustStatus: 'trusted',
    }));
    send({ id: request.id, result: { data: [{ cwd: process.cwd(), hooks: rows, warnings: [], errors: [] }] } });
    return;
  }
  // Healthy account snapshot: the provider reads this at every app-server
  // bind (codex-rate-limit-tracker.ts) and would wait out its deadline on a
  // fake that stays silent.
  if (request.method === 'account/rateLimits/read') {
    send({
      id: request.id,
      result: {
        rateLimits: {
          primary: { usedPercent: 10, windowDurationMins: 300 },
          secondary: { usedPercent: 20, windowDurationMins: 10080 },
        },
      },
    });
    return;
  }
  if (request.method === 'thread/start' || request.method === 'thread/resume') {
    if (process.env.FAKE_CODEX_THREAD_PARAMS_FILE) {
      fs.writeFileSync(process.env.FAKE_CODEX_THREAD_PARAMS_FILE, JSON.stringify(request.params));
    }
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
  options: { providerConfig?: Record<string, unknown>; effort?: string; instructions?: string } = {},
): Promise<{
  row: { effort: string | null; effort_requested: string | null; model: string | null };
  threadParams: { baseInstructions?: string };
}> {
  const binDir = path.join(tmpDir, 'bin');
  const codexHome = path.join(tmpDir, 'codex-home');
  const threadParamsFile = path.join(tmpDir, 'thread-params.json');
  writeFakeCodex(binDir);
  fs.mkdirSync(codexHome, { recursive: true });

  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_HEALTH_STILL_WORKING_NOTICE_MS = '10000';
  process.env.FAKE_CODEX_THREAD_PARAMS_FILE = threadParamsFile;

  const provider = new CodexProvider({ providerConfig: options.providerConfig ?? {} });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const query = provider.query({
    prompt: 'one turn',
    cwd: tmpDir,
    effort: options.effort,
    systemContext: options.instructions ? { instructions: options.instructions } : undefined,
  });

  for await (const event of query.events) {
    if (event.type !== 'result') continue;
    const usage = event.usage as TurnUsageInfo | TurnUsageInfo[] | undefined;
    for (const u of Array.isArray(usage) ? usage : [usage]) recordTurnUsage('codex', u ?? {}, undefined, 'thread-1');
    query.end();
  }
  const [row] = getTurnUsageRows();
  return {
    row: row as unknown as { effort: string | null; effort_requested: string | null; model: string | null },
    threadParams: JSON.parse(fs.readFileSync(threadParamsFile, 'utf8')) as { baseInstructions?: string },
  };
}

describe('codex turn effort -> turn_usage row', () => {
  it('records the configured sticky effort a turn ran at', async () => {
    const { row } = await runTurnAndRecord({ providerConfig: { reasoning_effort: 'low' } });
    expect(row).toMatchObject({ effort: 'low', effort_requested: 'low' });
  }, 15_000);

  it('records the schema default when nothing was configured', async () => {
    // Derived, not hardcoded. The contract under test is "an unconfigured run
    // records the provider's own default", and that default is an operator
    // dial: it has been high and xhigh, as well as `low` under the gpt-6-astra
    // trial (c58597034). A
    // literal here would make this test a change-detector for that dial —
    // which is not a fact about this plumbing.
    const schemaDefault = codexConfigSchema.parse({}).reasoning_effort;
    const { row } = await runTurnAndRecord();
    expect(row.effort).toBe(schemaDefault);
    // Guard against the tautology: it must be a real value, not null/undefined.
    expect(row.effort).toBeTruthy();
  }, 15_000);

  it('records a per-turn -e over the sticky config', async () => {
    const { row } = await runTurnAndRecord({ providerConfig: { reasoning_effort: 'low' }, effort: 'xhigh' });
    expect(row).toMatchObject({ effort: 'xhigh', effort_requested: 'xhigh' });
  }, 15_000);

  it('shows an ignored -e as a divergence instead of letting it look applied', async () => {
    // Codex silently drops a `-e` outside its vocabulary and stays on the
    // sticky default. Recording only the effective value would hide that the
    // operator asked for something else entirely.
    const { row } = await runTurnAndRecord({ providerConfig: { reasoning_effort: 'low' }, effort: 'bogus' });
    expect(row.effort).toBe('low');
    expect(row.effort_requested).toBe('bogus');
  }, 15_000);

  it('reports the resolved Codex model and effort over an agent identity instruction', async () => {
    const { threadParams } = await runTurnAndRecord({
      providerConfig: { model: 'gpt-6-astra', reasoning_effort: 'medium' },
      instructions: 'You are the agent.',
    });

    expect(threadParams.baseInstructions).toContain('You are the agent.');
    expect(threadParams.baseInstructions).toContain(
      'provider "codex", model "gpt-6-astra", and reasoning effort "medium"',
    );
  }, 15_000);
});
