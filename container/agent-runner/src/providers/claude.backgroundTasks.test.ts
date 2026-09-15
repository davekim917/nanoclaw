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

const RUNNING = { type: 'system', subtype: 'session_state_changed', state: 'running', session_id: 'sess' };
const IDLE = { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: 'sess' };
const agentLive = {
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: [
    { task_id: 'agent-1', task_type: 'local_agent', description: 'Fresh review receipt' },
    { task_id: 'watch-1', task_type: 'live_update', description: 'artifact watch', ambient: true },
  ],
};
const onlyAmbient = {
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: [{ task_id: 'watch-1', task_type: 'live_update', description: 'artifact watch', ambient: true }],
};
const bashLive = {
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: [{ task_id: 'bash-1', task_type: 'local_bash', description: 'pnpm test' }],
};
const empty = { type: 'system', subtype: 'background_tasks_changed', tasks: [] };
const RESULT = { type: 'result', subtype: 'success', result: '<internal>delegated, waiting</internal>' };

describe('background_tasks_changed → hasBackgroundWork', () => {
  it('latches on the level set (ambient excluded), holds across the drain, releases at idle', async () => {
    // A background subagent: the CLI withholds idle until it is done, so the
    // idle arrives after the drain.
    sdkMessages.push({ type: 'system', subtype: 'init', session_id: 'sess' }, RUNNING, agentLive, RESULT, onlyAmbient, IDLE);

    const { events, sampled, before } = await drain();
    expect(before).toBe(false);

    // The membership change itself emits nothing; the level is reported at idle.
    const bg = events.map((e, i) => ({ e, i })).filter(({ e }) => e.type === 'background_work');
    expect(bg.map(({ e }) => e.live)).toEqual([0]);
    const resultIdx = events.findIndex((e) => e.type === 'result');
    expect(bg[0].i).toBeGreaterThan(resultIdx);
    // hasBackgroundWork is latched: true through the result AND through the
    // drain that leaves only the ambient watcher — the restart gate polls in
    // that gap — and false only at the idle report.
    expect(sampled[resultIdx]).toBe(true);
    const drainIdx = bg[0].i - 1;
    expect(drainIdx).toBeGreaterThan(resultIdx);
    expect(sampled[drainIdx]).toBe(true);
    expect(sampled[bg[0].i]).toBe(false);
  });

  it('holds through an idle that arrives with work still live, and releases at the drain after it', async () => {
    // A backgrounded Bash: the CLI does NOT gate its idle on it, so idle
    // arrives with the task live and no second idle follows the drain.
    sdkMessages.push({ type: 'system', subtype: 'init', session_id: 'sess' }, RUNNING, bashLive, RESULT, IDLE, empty);

    const { events, sampled } = await drain();
    const bg = events.map((e, i) => ({ e, i })).filter(({ e }) => e.type === 'background_work');
    // Reported at idle (live), then again at the drain that releases.
    expect(bg.map(({ e }) => e.live)).toEqual([1, 0]);
    expect(sampled[bg[0].i]).toBe(true);
    expect(sampled[bg[1].i]).toBe(false);
    expect(bg[1].i).toBe(events.length - 1);
  });

  it('does not release at a drain the CLI has not yet gone idle over', async () => {
    // The task ends mid-turn, before any idle: still one release, at idle.
    sdkMessages.push({ type: 'system', subtype: 'init', session_id: 'sess' }, RUNNING, bashLive, empty, RESULT, IDLE);

    const { events, sampled } = await drain();
    const bg = events.map((e, i) => ({ e, i })).filter(({ e }) => e.type === 'background_work');
    expect(bg.map(({ e }) => e.live)).toEqual([0]);
    const resultIdx = events.findIndex((e) => e.type === 'result');
    expect(sampled[resultIdx]).toBe(true);
    expect(sampled[bg[0].i]).toBe(false);
  });

  it('reports nothing and holds nothing until the CLI has shown it emits session-state events', async () => {
    // Raise comes from an unconditional message; release needs the env-gated
    // one. Until the latter is seen, the predicate stays false (fail open).
    sdkMessages.push({ type: 'system', subtype: 'init', session_id: 'sess' }, agentLive, RESULT);
    const { events, sampled } = await drain();
    expect(events.some((e) => e.type === 'background_work')).toBe(false);
    expect(sampled.every((v) => v === false)).toBe(true);
  });

  it('a CLI that never emits the level message reports no background work', async () => {
    sdkMessages.push({ type: 'system', subtype: 'init', session_id: 'sess' }, RUNNING, RESULT, IDLE);
    const { events, sampled } = await drain();
    const bg = events.filter((e) => e.type === 'background_work');
    expect(bg.map((e) => e.live)).toEqual([0]);
    expect(sampled.every((v) => v === false)).toBe(true);
  });
});
