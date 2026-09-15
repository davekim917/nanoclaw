/**
 * The Claude provider mirrors the CLI's `background_tasks_changed` level
 * message into `hasBackgroundWork()` and a `background_work` event, so the
 * poll-loop can hold the published busy level while a background subagent
 * outlives the turn that launched it (2026-09-15: the task reaper killed one
 * session nine times in 80 minutes, each time with a worker mid-flight).
 *
 * Own file because it must mock.module the SDK (process-global in bun).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const sdkMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const gen = (async function* () {
      for (const m of sdkMessages) yield m;
    })();
    (gen as unknown as Record<string, unknown>).interrupt = async () => {};
    return gen;
  },
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bg-tasks-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  sdkMessages.length = 0;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Ev = { type: string; live?: number };

/** Drain the stream, sampling hasBackgroundWork() after every event. */
async function drain(): Promise<{ events: Ev[]; sampled: boolean[]; before: boolean }> {
  const provider = new ClaudeProvider({});
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  const before = q.hasBackgroundWork!();
  const events: Ev[] = [];
  const sampled: boolean[] = [];
  for await (const e of q.events) {
    events.push(e as Ev);
    sampled.push(q.hasBackgroundWork!());
  }
  return { events, sampled, before };
}

describe('background_tasks_changed → hasBackgroundWork', () => {
  it('starts empty, follows the level set with replace semantics, excludes ambient entries, reports at idle', async () => {
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [
          { task_id: 'agent-1', task_type: 'local_agent', description: 'Fresh review receipt' },
          { task_id: 'watch-1', task_type: 'live_update', description: 'artifact watch', ambient: true },
        ],
      },
      { type: 'result', subtype: 'success', result: '<internal>delegated, waiting</internal>' },
      // The agent finished; only the ambient watcher remains → no work. The
      // CLI withheld idle until now.
      {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'watch-1', task_type: 'live_update', description: 'artifact watch', ambient: true }],
      },
      { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: 'sess-1' },
    );

    const { events, sampled, before } = await drain();
    expect(before).toBe(false);

    // The membership change itself emits nothing; the level is reported at idle.
    const bg = events.map((e, i) => ({ e, i })).filter(({ e }) => e.type === 'background_work');
    expect(bg.map(({ e }) => e.live)).toEqual([0]);
    const resultIdx = events.findIndex((e) => e.type === 'result');
    expect(bg[0].i).toBeGreaterThan(resultIdx);
    // hasBackgroundWork tracks the set: live through the result, false once
    // only the ambient watcher remains.
    expect(sampled[resultIdx]).toBe(true);
    expect(sampled[bg[0].i]).toBe(false);
  });

  it('reports the live count at an idle that arrives with work still running', async () => {
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-3' },
      {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'agent-1', task_type: 'local_agent', description: 'worker' }],
      },
      { type: 'result', subtype: 'success', result: '<internal>delegated</internal>' },
      { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: 'sess-3' },
    );
    const { events, sampled } = await drain();
    const bg = events.filter((e) => e.type === 'background_work');
    expect(bg.map((e) => e.live)).toEqual([1]);
    expect(sampled[sampled.length - 1]).toBe(true);
  });

  it('a CLI that never emits the level message reports no background work', async () => {
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-2' },
      { type: 'result', subtype: 'success', result: '<internal>done</internal>' },
      { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: 'sess-2' },
    );
    const { events, sampled } = await drain();
    const bg = events.filter((e) => e.type === 'background_work');
    expect(bg.map((e) => e.live)).toEqual([0]);
    expect(sampled.every((v) => v === false)).toBe(true);
  });
});
