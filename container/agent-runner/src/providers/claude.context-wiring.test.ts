/**
 * Is the context reading actually WIRED, or only correct in isolation?
 *
 * context-occupancy.test.ts pins the arithmetic; this drives the provider's
 * real message loop with a mocked SDK and asserts the store moved. Without it
 * the whole feature could be unreachable — the helper exported, unit-tested
 * and never called — and every test would still be green while the line in
 * Slack showed a stale figure or none at all.
 *
 * Mirrors claude.rate-limit-usage.test.ts: mock the SDK module, feed raw
 * messages, assert on what the provider did with them.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const sdkMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const m of sdkMessages) yield m;
    })(),
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
const { initTestSessionDb } = await import('../modules/mailbox/testing.js');
const { formatStatusSubtext, resetTurnStatus, setTurnSettings } = await import('../turn-status.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ctx-wiring-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  initTestSessionDb();
  resetTurnStatus();
});

afterEach(() => {
  resetTurnStatus();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function assistant(usage: Record<string, number>, opts: { parentToolUseId?: string } = {}) {
  return {
    type: 'assistant',
    ...(opts.parentToolUseId ? { parent_tool_use_id: opts.parentToolUseId } : {}),
    message: { role: 'assistant', content: [{ type: 'text', text: 'working' }], usage },
  };
}

async function runTurn(): Promise<void> {
  const provider = new ClaudeProvider({});
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  for await (const _e of q.events) {
    // drain
  }
}

describe('claude context reading is wired into the message loop', () => {
  it('records occupancy off a real assistant frame', async () => {
    setTurnSettings('claude-opus-5[1m]', 'xhigh');
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      assistant({ input_tokens: 1_507, cache_read_input_tokens: 140_893, cache_creation_input_tokens: 0 }),
      { type: 'result', subtype: 'success', result: '<message to="here">done</message>' },
    );

    await runTurn();

    expect(formatStatusSubtext()).toBe('opus-5 · xhigh · 142k context');
  });

  it('tracks the LATEST frame across a multi-round turn', async () => {
    // A turn grows its own window as tool results come back. The subtext must
    // show where the thread ENDED, not where it started.
    setTurnSettings('claude-opus-5[1m]', 'high');
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      assistant({ input_tokens: 500, cache_read_input_tokens: 40_000 }),
      assistant({ input_tokens: 800, cache_read_input_tokens: 90_000 }),
      assistant({ input_tokens: 1_200, cache_read_input_tokens: 180_000 }),
      { type: 'result', subtype: 'success', result: '<message to="here">done</message>' },
    );

    await runTurn();

    expect(formatStatusSubtext()).toBe('opus-5 · high · 181k context');
  });

  it('ignores a subagent frame — that is ITS window, not ours', async () => {
    // A Task subagent's messages ride the same stream tagged with the tool
    // call that spawned them. Counting one would make the parent's window
    // appear to collapse the moment a subagent reported in.
    setTurnSettings('claude-opus-5[1m]', 'high');
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      assistant({ input_tokens: 1_200, cache_read_input_tokens: 180_000 }),
      assistant({ input_tokens: 300, cache_read_input_tokens: 2_000 }, { parentToolUseId: 'toolu_sub' }),
      { type: 'result', subtype: 'success', result: '<message to="here">done</message>' },
    );

    await runTurn();

    expect(formatStatusSubtext()).toBe('opus-5 · high · 181k context');
  });

  it('leaves the line without a figure when no frame carried usage', async () => {
    setTurnSettings('claude-opus-5[1m]', 'medium');
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'result', subtype: 'success', result: '<message to="here">done</message>' },
    );

    await runTurn();

    // Model and effort still answer "what am I running on"; the figure is
    // absent rather than 0.
    expect(formatStatusSubtext()).toBe('opus-5 · medium');
  });
});
