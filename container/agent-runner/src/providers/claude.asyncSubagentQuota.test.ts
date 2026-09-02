/**
 * End-to-end proof that an ASYNC subagent's quota death aborts the parent turn.
 *
 * The unit coverage for the decision itself lives in
 * claude.subagentQuota.test.ts (subagentQuotaFromTaskNotification). What can
 * only be shown here is the consequence: the throw escapes translateEvents to
 * the caller, which is what puts poll-loop's existing rotation catch on the
 * path. A detection that stayed inside the generator would rotate nothing.
 *
 * Lives in its own file because it must mock.module the SDK — process-global
 * in bun and NOT undone by mock.restore — and claude.subagentQuota.test.ts is
 * deliberately a mock-free pure-unit file.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const sdkMessages: unknown[] = [];
let interrupts = 0;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const gen = (async function* () {
      for (const m of sdkMessages) yield m;
    })();
    (gen as unknown as Record<string, unknown>).interrupt = async () => {
      interrupts++;
    };
    return gen;
  },
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

// Verbatim from the 2026-09-02 03:17 UTC incident transcript.
const INCIDENT_SUMMARY =
  'Agent "Wave 2A trade spend web pages" failed: Agent terminated early due to an API error: ' +
  "You've hit your session limit · resets 12am (America/New_York) (error type rate_limit, HTTP 429, " +
  'request id req_011CedtTBWyKFHtu1UsNPTug, model sent to the API: claude-sonnet-5)';

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-async-quota-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  sdkMessages.length = 0;
  interrupts = 0;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Ev = { type: string; message?: string };

/** Drain the turn, keeping the events seen BEFORE any throw alongside it. */
async function drain(): Promise<{ events: Ev[]; error: Error | null }> {
  const provider = new ClaudeProvider({});
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  const events: Ev[] = [];
  try {
    for await (const e of q.events) events.push(e as Ev);
  } catch (err) {
    return { events, error: err instanceof Error ? err : new Error(String(err)) };
  }
  return { events, error: null };
}

describe('async subagent quota via task_notification', () => {
  it('throws the rotation marker, interrupts, and labels the retry before unwinding', async () => {
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        // The subagent tool is named `Agent` on this SDK (sdk-tools.d.ts:658
        // declares AgentInput; there is no TaskInput). Launched async, so its
        // tool_result was just "Async agent launched successfully…".
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_async', name: 'Agent' }] },
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 't1',
        tool_use_id: 'toolu_async',
        status: 'failed',
        summary: INCIDENT_SUMMARY,
      },
      // Must never be reached: the turn aborts at the notification.
      { type: 'result', subtype: 'success', result: '<message to="user">all done</message>' },
    );

    const { events, error } = await drain();
    expect(error).not.toBe(null);
    expect(error!.message.startsWith('subscription_quota_exhausted: ')).toBe(true);
    expect(error!.message).toContain("You've hit your session limit");
    expect(interrupts).toBe(1);
    // The user-facing rotation label is yielded before the unwind.
    expect(
      events.some(
        (e) => e.type === 'progress' && (e.message ?? '').includes("subagent hit the credential slot's limit"),
      ),
    ).toBe(true);
    // The turn never reaches its result — that is what makes poll-loop replay it.
    expect(events.some((e) => e.type === 'result')).toBe(false);
  });

  it('lets a completed notification carrying the same wording finish the turn normally', async () => {
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-2' },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_ok', name: 'Agent' }] },
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 't2',
        tool_use_id: 'toolu_ok',
        status: 'completed',
        summary: INCIDENT_SUMMARY,
      },
      { type: 'result', subtype: 'success', result: '<message to="user">all done</message>' },
    );

    const { events, error } = await drain();
    expect(error).toBe(null);
    expect(interrupts).toBe(0);
    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    // The notification still forwards as a progress label, unchanged.
    expect(events.some((e) => e.type === 'progress' && (e.message ?? '').includes('Wave 2A'))).toBe(true);
  });

  it('lets a failed backgrounded Bash task finish the turn normally', async () => {
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-3' },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash' }] },
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 't3',
        tool_use_id: 'toolu_bash',
        status: 'failed',
        summary: INCIDENT_SUMMARY,
      },
      { type: 'result', subtype: 'success', result: '<message to="user">all done</message>' },
    );

    const { events, error } = await drain();
    expect(error).toBe(null);
    expect(interrupts).toBe(0);
    expect(events.filter((e) => e.type === 'result')).toHaveLength(1);
  });
});
