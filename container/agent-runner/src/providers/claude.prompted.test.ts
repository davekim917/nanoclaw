/**
 * `prompted` on a Claude result: whether the turn consumed a prompt the runner
 * pushed. The provider stamps a uuid on every prompt it pushes; the CLI echoes
 * a consumed prompt's uuid on the result of the turn that answered it and
 * echoes none on a turn it started itself, such as its synthetic "Continue
 * from where you left off." turn on resuming an interrupted session. A task
 * fire's outcome must come from a prompted turn (#606).
 *
 * Harness mirrors claude.turn-usage-effort.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Builds the SDK messages once the uuid of the first pushed prompt is known. */
let script: (firstPromptUuid: string | undefined) => unknown[] = () => [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: AsyncIterable<{ uuid?: string }> }) => {
    const it = (async function* () {
      const first = await args.prompt[Symbol.asyncIterator]().next();
      for (const m of script(first.done ? undefined : first.value.uuid)) yield m;
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-prompted-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  initTestSessionDb();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const init = { type: 'system', subtype: 'init', session_id: 'sess-1' };
const result = (text: string, echo: Record<string, unknown>) => ({
  type: 'result',
  subtype: 'success',
  result: text,
  ...echo,
});

async function resultFlags(): Promise<Array<[string | null, boolean | undefined]>> {
  const provider = new ClaudeProvider({ env: { ...process.env } });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'run the task', cwd: tmp });
  const seen: Array<[string | null, boolean | undefined]> = [];
  for await (const e of q.events) if (e.type === 'result') seen.push([e.text, e.prompted]);
  return seen;
}

describe('claude result `prompted`', () => {
  it('stamps the pushed prompt and marks the turn that echoes it as prompted', async () => {
    let stamped: string | undefined;
    script = (uuid) => {
      stamped = uuid;
      return [init, result('done', { user_message_uuid: uuid, user_message_uuids: [uuid] })];
    };
    expect(await resultFlags()).toEqual([['done', true]]);
    expect(stamped).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('marks a turn the CLI started itself, which echoes no prompt, as unprompted', async () => {
    script = (uuid) => [
      init,
      result('No response requested.', {}),
      init,
      result('real work', { user_message_uuid: uuid, user_message_uuids: [uuid] }),
    ];
    expect(await resultFlags()).toEqual([
      ['No response requested.', false],
      ['real work', true],
    ]);
  });

  it('does not count an echoed id the provider never stamped', async () => {
    script = () => [
      init,
      result('scheduled', { user_message_uuid: 'cli-internal', user_message_uuids: ['cli-internal'] }),
    ];
    expect(await resultFlags()).toEqual([['scheduled', false]]);
  });
});
