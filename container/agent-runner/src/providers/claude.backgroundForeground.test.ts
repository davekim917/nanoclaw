/**
 * `backgroundForegroundTools`: a human message pushed into a running turn is
 * read only at the next tool boundary, so a long foreground Bash or subagent
 * call is detached through the SDK's `backgroundTasks(toolUseId)` once it has
 * run the minimum age.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Query } from '@anthropic-ai/claude-agent-sdk';

const realContainerState = await import('../db/container-state.js');
mock.module('../db/container-state.js', () => ({
  ...realContainerState,
  setContainerToolInFlight: () => {},
  clearContainerToolInFlight: () => {},
}));

const {
  preToolUseHook,
  postToolUseHook,
  resetToolInFlightTracking,
  backgroundableToolsInFlight,
  ClaudeProvider,
  _setSdkQueryForTesting,
} = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

const CTX = {} as Parameters<typeof preToolUseHook>[1];
const OPTS = {} as Parameters<typeof preToolUseHook>[2];

function pre(toolUseId: string, tool: string, agentId?: string) {
  return preToolUseHook(
    {
      tool_name: tool,
      tool_use_id: toolUseId,
      tool_input: {},
      ...(agentId ? { agent_id: agentId } : {}),
    } as unknown as Parameters<typeof preToolUseHook>[0],
    CTX,
    OPTS,
  );
}

function post(toolUseId: string) {
  return postToolUseHook({ tool_use_id: toolUseId } as unknown as Parameters<typeof postToolUseHook>[0], CTX, OPTS);
}

let backgrounded: string[] = [];
let backgroundImpl: (id: string) => Promise<boolean> = async () => true;
let releaseStream: (() => void) | null = null;

const fakeSdkQuery = (() => {
  const gen = (async function* () {
    await new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    yield { type: 'result', subtype: 'success', result: 'ok' };
  })();
  const g = gen as unknown as Record<string, unknown>;
  g.interrupt = async () => {};
  g.backgroundTasks = (id: string) => {
    backgrounded.push(id);
    return backgroundImpl(id);
  };
  return gen as unknown as Query;
}) as unknown as NonNullable<Parameters<typeof _setSdkQueryForTesting>[0]>;

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  resetToolInFlightTracking();
  backgrounded = [];
  backgroundImpl = async () => true;
  releaseStream = null;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bg-foreground-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  _setSdkQueryForTesting(fakeSdkQuery);
});

afterEach(() => {
  releaseStream?.();
  resetToolInFlightTracking();
  _setSdkQueryForTesting();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function startQuery() {
  const provider = new ClaudeProvider({});
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  // Start consuming so the SDK generator is live, as in production.
  void (async () => {
    for await (const _ of q.events) void _;
  })();
  return q;
}

describe('backgroundableToolsInFlight', () => {
  it("lists main-thread Bash and subagent calls only, not other tools or a subagent's own calls", async () => {
    await pre('bash-main', 'Bash');
    await pre('agent-main', 'Agent');
    await pre('read-main', 'Read');
    await pre('bash-in-subagent', 'Bash', 'subagent-1');
    expect(backgroundableToolsInFlight().map((c) => c.id)).toEqual(['bash-main', 'agent-main']);
  });
});

describe('query.backgroundForegroundTools', () => {
  it('detaches a call only once it reaches the minimum age', async () => {
    const q = startQuery();
    await pre('bash-1', 'Bash');
    expect(q.backgroundForegroundTools!(150)).toBe(1);
    await Bun.sleep(40);
    expect(backgrounded).toEqual([]);
    await Bun.sleep(200);
    expect(backgrounded).toEqual(['bash-1']);
  });

  it('detaches a call already past the minimum age right away', async () => {
    const q = startQuery();
    await pre('bash-old', 'Bash');
    await Bun.sleep(30);
    q.backgroundForegroundTools!(10);
    await Bun.sleep(20);
    expect(backgrounded).toEqual(['bash-old']);
  });

  it('a second waiting message does not detach the same call twice', async () => {
    const q = startQuery();
    await pre('bash-1', 'Bash');
    q.backgroundForegroundTools!(20);
    q.backgroundForegroundTools!(20);
    await Bun.sleep(80);
    expect(backgrounded).toEqual(['bash-1']);
  });

  it('leaves alone a call that finishes before the minimum age', async () => {
    const q = startQuery();
    await pre('bash-quick', 'Bash');
    q.backgroundForegroundTools!(60);
    await post('bash-quick');
    await Bun.sleep(120);
    expect(backgrounded).toEqual([]);
  });

  it('reports 0 and schedules nothing with no detachable call in flight', async () => {
    const q = startQuery();
    await pre('read-1', 'Read');
    expect(q.backgroundForegroundTools!(0)).toBe(0);
    await Bun.sleep(20);
    expect(backgrounded).toEqual([]);
  });

  it('a rejected or throwing backgroundTasks does not escape', async () => {
    const q = startQuery();
    backgroundImpl = async () => {
      throw new Error('background tasks are disabled for this session');
    };
    await pre('bash-1', 'Bash');
    q.backgroundForegroundTools!(0);
    await Bun.sleep(20);
    await pre('bash-2', 'Bash');
    backgroundImpl = () => {
      throw new Error('sync throw');
    };
    q.backgroundForegroundTools!(0);
    await Bun.sleep(30);
    expect(backgrounded).toEqual(['bash-1', 'bash-2']);
  });
});
