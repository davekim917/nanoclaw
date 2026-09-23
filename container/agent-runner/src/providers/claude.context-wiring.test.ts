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
const { formatStatusSubtext, formatSubagentRoster, resetTurnStatus, setTurnSettings } =
  await import('../turn-status.js');

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

function assistant(usage: Record<string, number>, opts: { parentToolUseId?: string; model?: string } = {}) {
  return {
    type: 'assistant',
    ...(opts.parentToolUseId ? { parent_tool_use_id: opts.parentToolUseId } : {}),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'working' }],
      usage,
      ...(opts.model ? { model: opts.model } : {}),
    },
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
  // Seen live 2026-09-23: the support-poller task is pinned `-m opus`, so the
  // requested model is the bare alias and the footer read `opus · low`. The
  // API reported claude-opus-5-5 on every frame; the footer now prints that.
  it('shows the model that SERVED the turn, not the alias that was requested', async () => {
    setTurnSettings('opus', 'low');
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      assistant({ input_tokens: 1_000, cache_read_input_tokens: 50_000 }, { model: 'claude-opus-5-5' }),
      // A subagent served by another model says nothing about ours.
      assistant(
        { input_tokens: 10, cache_read_input_tokens: 10 },
        { parentToolUseId: 'toolu_1', model: 'claude-haiku-4-5' },
      ),
      // The CLI's own placeholder frames name no model.
      assistant({ input_tokens: 1_000, cache_read_input_tokens: 50_000 }, { model: '<synthetic>' }),
      { type: 'result', subtype: 'success', result: '<message to="here">done</message>' },
    );

    await runTurn();

    expect(formatStatusSubtext()).toStartWith('opus-5-5 · low · 51k context');
  });

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

    // The context figure is the point: 181k is the PARENT's window, unmoved by
    // the subagent's much smaller one. The trailing roster clause is the
    // subagent feature doing its own job correctly on the same frame — this
    // fixture's worker carries no model, so it renders as a bare count.
    expect(formatStatusSubtext()).toBe('opus-5 · high · 181k context · 1 subagent');
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

describe('claude subagent roster is wired into the message loop', () => {
  function worker(
    parentToolUseId: string,
    subagentType: string,
    model: string,
    usage: Record<string, number> = { input_tokens: 100 },
  ) {
    return {
      type: 'assistant',
      parent_tool_use_id: parentToolUseId,
      subagent_type: subagentType,
      message: { role: 'assistant', model, content: [{ type: 'text', text: 'working' }], usage },
    };
  }

  it('records each deployed worker with the model that actually served it', async () => {
    setTurnSettings('claude-opus-5[1m]', 'xhigh');
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      assistant({ input_tokens: 1_200, cache_read_input_tokens: 180_000 }),
      worker('toolu_a', 'worker-xhigh', 'claude-sonnet-5'),
      worker('toolu_b', 'worker-xhigh', 'claude-sonnet-5'),
      worker('toolu_c', 'worker-low', 'claude-haiku-4-5'),
      { type: 'result', subtype: 'success', result: '<message to="here">done</message>' },
    );

    await runTurn();

    expect(formatSubagentRoster()).toBe('3 subagents: 2x sonnet-5, haiku-4-5');
    // And the parent's own context reading is untouched by the workers.
    expect(formatStatusSubtext()).toBe('opus-5 · xhigh · 181k context · 3 subagents: 2x sonnet-5, haiku-4-5');
  });

  it('counts a chatty worker once', async () => {
    setTurnSettings('claude-opus-5[1m]', 'high');
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      worker('toolu_a', 'worker-high', 'claude-sonnet-5'),
      worker('toolu_a', 'worker-high', 'claude-sonnet-5'),
      worker('toolu_a', 'worker-high', 'claude-sonnet-5'),
      { type: 'result', subtype: 'success', result: '<message to="here">done</message>' },
    );

    await runTurn();

    expect(formatSubagentRoster()).toBe('1 subagent: sonnet-5');
  });

  it('reports no roster for a turn that delegated nothing', async () => {
    setTurnSettings('claude-opus-5[1m]', 'high');
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      assistant({ input_tokens: 1_200, cache_read_input_tokens: 180_000 }),
      { type: 'result', subtype: 'success', result: '<message to="here">done</message>' },
    );

    await runTurn();

    expect(formatSubagentRoster()).toBeNull();
  });
});
