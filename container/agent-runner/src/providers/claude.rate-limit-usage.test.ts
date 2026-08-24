/**
 * Per-turn cost attribution follow-up: persist SDK rate-limit telemetry
 * (utilization/type/resetsAt) on the `result` event instead of discarding it
 * — see turn-usage.ts's TurnMeta. Mirrors the pattern in
 * claude.compact-boundary.test.ts (mock the SDK module, feed raw messages,
 * assert on the translated ProviderEvent stream).
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

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ratelimit-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface ResultEvent {
  type: 'result';
  text: string | null;
  rateLimit?: { type: string | null; utilization: number | null; resetsAt: string | null } | null;
}

async function collectResults(): Promise<ResultEvent[]> {
  const provider = new ClaudeProvider({});
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  const events: ResultEvent[] = [];
  for await (const e of q.events) if (e.type === 'result') events.push(e as ResultEvent);
  return events;
}

describe('rate_limit_event -> result.rateLimit', () => {
  it('attaches the most recent rate_limit_event to the result that closes the turn', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.91, resetsAt: 1_700_000_000 },
      },
      { type: 'result', subtype: 'success', result: '<message to="user">hi</message>' },
    );

    const [result] = await collectResults();
    expect(result!.rateLimit).toEqual({
      type: 'seven_day',
      utilization: 0.91,
      resetsAt: new Date(1_700_000_000_000).toISOString(),
    });
  });

  it('reports null when no rate_limit_event fired this turn', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'result', subtype: 'success', result: '<message to="user">hi</message>' },
    );

    const [result] = await collectResults();
    expect(result!.rateLimit).toBeNull();
  });

  it('does not leak a rate-limit reading from one turn onto the next turn that had none', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.5 },
      },
      { type: 'result', subtype: 'success', result: '<message to="user">turn one</message>' },
      { type: 'result', subtype: 'success', result: '<message to="user">turn two</message>' },
    );

    const [first, second] = await collectResults();
    expect(first!.rateLimit).not.toBeNull();
    expect(second!.rateLimit).toBeNull();
  });
});
