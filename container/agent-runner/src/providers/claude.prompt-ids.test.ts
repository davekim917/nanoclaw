/**
 * Prompt ids on the Claude provider. It stamps a uuid on every prompt it
 * pushes; the CLI echoes a consumed prompt's uuid on the result of the turn
 * that answered it and echoes none on a turn it started itself, such as its
 * synthetic "Continue from where you left off." turn on resuming an
 * interrupted session. From that the provider reports which prompts each
 * result answered, whether any prompt is still queued, and, at the CLI's
 * idle, which prompts were consumed with no echo at all (#606, #617).
 *
 * Harness mirrors claude.turn-usage-effort.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

let captured: { options?: { env?: Record<string, string | undefined> } } = {};
/** The SDK messages to stream, given the uuid of the first pushed prompt. */
let script: (firstPromptUuid: string | undefined) => AsyncGenerator<unknown> = async function* () {};

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: AsyncIterable<{ uuid?: string }>; options?: { env?: Record<string, string | undefined> } }) => {
    captured = args;
    const it = (async function* () {
      const first = await args.prompt[Symbol.asyncIterator]().next();
      yield* script(first.done ? undefined : first.value.uuid);
    })();
    return Object.assign(it, {
      setModel: async () => {},
      applyFlagSettings: async () => {},
    });
  },
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
const { initTestSessionDb } = await import('../modules/mailbox/testing.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-prompt-ids-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  initTestSessionDb();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const init = { type: 'system', subtype: 'init', session_id: 'sess-1' };
const state = (s: 'running' | 'idle') => ({ type: 'system', subtype: 'session_state_changed', state: s, session_id: 'sess-1' });
const result = (text: string, echo: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  result: text,
  ...echo,
});

function start() {
  const provider = new ClaudeProvider({ env: { ...process.env } });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  return provider.query({ prompt: 'run the task', cwd: tmp });
}

describe('claude prompt ids', () => {
  it('asks the CLI for the session-state events that idle depends on', async () => {
    script = async function* () {};
    const q = start();
    for await (const _ of q.events) void _;
    expect(captured.options?.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe('1');
  });

  it('stamps the initial prompt and reports it answered when a result echoes it', async () => {
    let stamped: string | undefined;
    script = async function* (uuid) {
      stamped = uuid;
      yield init;
      yield result('done', { user_message_uuid: uuid, user_message_uuids: [uuid] });
    };
    const q = start();
    const answered: Array<string[] | undefined> = [];
    for await (const e of q.events) if (e.type === 'result') answered.push(e.answeredPrompts);
    expect(stamped).toMatch(UUID);
    expect(q.initialPromptId).toBe(stamped);
    expect(answered).toEqual([[stamped!]]);
  });

  it('reports nothing answered by a turn the CLI started itself, or by an id it never stamped', async () => {
    script = async function* (uuid) {
      yield init;
      yield result('No response requested.');
      yield result('scheduled', { user_message_uuid: 'cli-internal', user_message_uuids: ['cli-internal'] });
      yield init;
      yield result('real work', { user_message_uuid: uuid, user_message_uuids: [uuid] });
    };
    const q = start();
    const answered: Array<string[] | undefined> = [];
    for await (const e of q.events) if (e.type === 'result') answered.push(e.answeredPrompts);
    expect(answered).toEqual([[], [], [q.initialPromptId!]]);
  });

  it('reports queued work only once the CLI emits session state, and until the prompt is echoed', async () => {
    script = async function* (uuid) {
      yield init;
      yield state('running');
      // A turn the CLI started itself, while the task prompt waits behind it.
      yield result('No response requested.');
      yield init;
      yield result('real work', { user_message_uuids: [uuid] });
    };
    const q = start();
    const seen: Array<[string, boolean]> = [];
    for await (const e of q.events) {
      if (e.type === 'init' || e.type === 'result') seen.push([e.type, q.hasQueuedWork!()]);
    }
    // No session state seen yet at the first init: no claim, as before.
    expect(seen).toEqual([
      ['init', false],
      ['result', true],
      ['init', true],
      ['result', false],
    ]);
  });

  it('never reports queued work from a CLI that emits no session state', async () => {
    script = async function* () {
      yield init;
      yield result('No response requested.');
    };
    const q = start();
    for await (const _ of q.events) void _;
    expect(q.hasQueuedWork!()).toBe(false);
  });

  it('settles at idle a prompt that no result echoed', async () => {
    script = async function* () {
      yield state('running');
      yield init;
      yield result('answered, with the echo dropped');
      yield state('idle');
    };
    const q = start();
    const seen: unknown[] = [];
    for await (const e of q.events) {
      if (e.type === 'result') seen.push(['result', e.answeredPrompts]);
      if (e.type === 'settled') seen.push(['settled', e.unansweredPrompts]);
    }
    expect(seen).toEqual([
      ['result', []],
      ['settled', [q.initialPromptId!]],
    ]);
    expect(q.hasQueuedWork!()).toBe(false);
  });

  it('does not settle a prompt pushed after the last result at an idle that predates it', async () => {
    let release!: () => void;
    const pushedAfterResult = new Promise<void>((resolve) => (release = resolve));
    script = async function* (uuid) {
      yield state('running');
      yield init;
      yield result('done', { user_message_uuids: [uuid] });
      // The runner pushes a nudge while handling that result...
      await pushedAfterResult;
      // ...but the CLI went idle before it arrived.
      yield state('idle');
    };
    const q = start();
    let nudgeId: string | void = undefined;
    const settled: string[][] = [];
    for await (const e of q.events) {
      if (e.type === 'result') {
        nudgeId = q.push('nudge');
        release();
      }
      if (e.type === 'settled') settled.push(e.unansweredPrompts);
    }
    expect(nudgeId).toMatch(UUID);
    expect(settled).toEqual([]);
    // The nudge is still queued: its own turn and echo are yet to come.
    expect(q.hasQueuedWork!()).toBe(true);
  });
});
