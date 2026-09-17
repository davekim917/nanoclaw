import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Text the agent writes and then works past (a tool call follows it) is not
// the turn's final text, so the `result` never carries it. The provider must
// say so, or an update posted mid-turn reaches nobody (live 2026-09-16/17).

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-interim-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const assistant = (content: unknown[], parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { content },
});

async function interimTexts(): Promise<string[]> {
  const provider = new ClaudeProvider({});
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  const out: string[] = [];
  for await (const e of q.events) {
    const ev = e as { type: string; text?: string };
    if (ev.type === 'interim_text') out.push(ev.text ?? '');
  }
  return out;
}

describe('interim_text', () => {
  it('emits text once a tool call follows it, across separate assistant messages', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      assistant([{ type: 'text', text: '<message to="here">pushed the head</message>' }]),
      assistant([{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }]),
      assistant([{ type: 'text', text: '<message to="here">all done</message>' }]),
      { type: 'result', subtype: 'success', result: '<message to="here">all done</message>' },
    );

    // The final text is the result's to deliver, never emitted as interim.
    expect(await interimTexts()).toEqual(['<message to="here">pushed the head</message>']);
  });

  it('never emits a subagent’s text', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      assistant([{ type: 'text', text: '<message to="here">from the worker</message>' }], 'tu-agent'),
      assistant([{ type: 'tool_use', id: 'tu-2', name: 'Bash', input: {} }], 'tu-agent'),
      { type: 'result', subtype: 'success', result: '' },
    );

    expect(await interimTexts()).toEqual([]);
  });

  it('does not carry pending text over a result into the next turn', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      assistant([{ type: 'text', text: 'final answer' }]),
      { type: 'result', subtype: 'success', result: 'final answer' },
      assistant([{ type: 'tool_use', id: 'tu-3', name: 'Bash', input: {} }]),
      { type: 'result', subtype: 'success', result: '' },
    );

    expect(await interimTexts()).toEqual([]);
  });
});
