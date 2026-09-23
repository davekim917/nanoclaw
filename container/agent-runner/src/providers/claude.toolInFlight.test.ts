/**
 * `container_state` in-flight bookkeeping under PARALLEL tool calls.
 *
 * `postToolUseHook` has no matcher and used to clear the row unconditionally,
 * so the first tool to finish erased the state of a still-running Bash. The
 * host then read `activeOperationTimeoutMs` = null
 * (src/modules/sweep-container-health/index.ts:545-548) and collapsed its
 * ceiling to ABSOLUTE_CEILING_MS / CLAIM_STUCK_MS while a 30-minute declared
 * Bash was mid-flight.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Query } from '@anthropic-ai/claude-agent-sdk';

type Recorded = { tool: string; declaredTimeoutMs: number | null } | null;
let current: Recorded = null;
let setCalls = 0;

const realContainerState = await import('../db/container-state.js');
mock.module('../db/container-state.js', () => ({
  ...realContainerState,
  setContainerToolInFlight: (tool: string, declaredTimeoutMs: number | null) => {
    current = { tool, declaredTimeoutMs };
    setCalls++;
  },
  clearContainerToolInFlight: () => {
    current = null;
  },
}));

const {
  preToolUseHook,
  postToolUseHook,
  resetToolInFlightTracking,
  clampDeclaredBashTimeoutMs,
  ClaudeProvider,
  _setSdkQueryForTesting,
} = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

const CTX = {} as Parameters<typeof preToolUseHook>[1];
const OPTS = {} as Parameters<typeof preToolUseHook>[2];

function pre(toolUseId: string, tool: string, timeout?: number) {
  return preToolUseHook(
    {
      tool_name: tool,
      tool_use_id: toolUseId,
      tool_input: timeout === undefined ? {} : { timeout },
    } as unknown as Parameters<typeof preToolUseHook>[0],
    CTX,
    OPTS,
  );
}

// Every container runs with the cap the host pins (src/group-init.ts:30), so the
// declarations below (up to 30 min) pass through the clamp unchanged.
const savedCap = process.env.BASH_MAX_TIMEOUT_MS;
beforeEach(() => {
  process.env.BASH_MAX_TIMEOUT_MS = '3600000';
});
afterEach(() => {
  if (savedCap === undefined) delete process.env.BASH_MAX_TIMEOUT_MS;
  else process.env.BASH_MAX_TIMEOUT_MS = savedCap;
});

function post(toolUseId?: string) {
  return postToolUseHook({ tool_use_id: toolUseId } as unknown as Parameters<typeof postToolUseHook>[0], CTX, OPTS);
}

describe('tool in-flight tracking', () => {
  beforeEach(() => {
    resetToolInFlightTracking();
    current = null;
  });

  it('records a Bash call with its declared timeout', async () => {
    await pre('t1', 'Bash', 1_800_000);
    expect(current).toEqual({ tool: 'Bash', declaredTimeoutMs: 1_800_000 });
  });

  it('a parallel Read finishing does NOT clear a still-running long Bash', async () => {
    await pre('bash-1', 'Bash', 1_800_000);
    await pre('read-1', 'Read');
    // The widest declared timeout still in flight stays published while both run.
    expect(current).toEqual({ tool: 'Bash', declaredTimeoutMs: 1_800_000 });
    await post('read-1');
    expect(current).toEqual({ tool: 'Bash', declaredTimeoutMs: 1_800_000 });
    await post('bash-1');
    expect(current).toBeNull();
  });

  it('two parallel Bash calls: the first to finish does not clear the second', async () => {
    // The case a `matcher: "Bash"` could not have fixed.
    await pre('bash-a', 'Bash', 60_000);
    await pre('bash-b', 'Bash', 1_800_000);
    await post('bash-a');
    expect(current).toEqual({ tool: 'Bash', declaredTimeoutMs: 1_800_000 });
    await post('bash-b');
    expect(current).toBeNull();
  });

  it('an unknown tool_use_id on PostToolUse leaves live calls alone', async () => {
    await pre('bash-1', 'Bash', 900_000);
    await post('never-started');
    expect(current).toEqual({ tool: 'Bash', declaredTimeoutMs: 900_000 });
  });

  it('a MISSING tool_use_id degrades to the old clear-everything behaviour', async () => {
    await pre('bash-1', 'Bash', 900_000);
    await post(undefined);
    expect(current).toBeNull();
  });

  it('blocks a disallowed tool and records nothing for it', async () => {
    const out = await pre('x1', 'AskUserQuestion');
    expect((out as { decision?: string }).decision).toBe('block');
    expect(current).toBeNull();
  });

  it('resetToolInFlightTracking clears a leaked entry from a denied call', async () => {
    await pre('denied-1', 'Bash', 1_800_000);
    expect(current).not.toBeNull();
    resetToolInFlightTracking();
    expect(current).toBeNull();
  });

  it('does NOT re-write the row (and so re-stamp tool_started_at) while the described call is unchanged', async () => {
    // The writer stamps tool_started_at = now on every set, and the host reads
    // that stamp as the described tool's start: decideCeilingFollowUp's
    // freshness bound (src/modules/sweep-continuation/decide.ts:42-57), the
    // wedged-tool recovery key (sweep-continuation/index.ts:336),
    // host-restart-warn (src/host-restart-warn.ts:249, :287), the dashboard's
    // stall rule (src/dashboard/api/threads.ts:251-253) and decideStuckAction's
    // tool-in-flight claim forgiveness (src/modules/sweep-container-health/
    // index.ts:552, :645). A parallel Read starting or finishing inside a long
    // Bash must not move it forward.
    await pre('bash-1', 'Bash', 1_800_000);
    const afterBash = setCalls;
    await pre('read-1', 'Read');
    await post('read-1');
    expect(setCalls).toBe(afterBash);
    expect(current).toEqual({ tool: 'Bash', declaredTimeoutMs: 1_800_000 });
  });
});

/**
 * The host trusts the published timeout unbounded (sweep-container-health
 * index.ts:585, :611), so the hook must never publish more than the CLI will
 * enforce: `BASH_MAX_TIMEOUT_MS` (pinned to 3600000 by src/group-init.ts:30),
 * or Claude Code's own 600000 when that is absent or unusable.
 */
describe('declared Bash timeout is clamped to what the CLI enforces', () => {
  beforeEach(() => {
    resetToolInFlightTracking();
    current = null;
  });

  it('an oversized declaration publishes the cap', async () => {
    await pre('day', 'Bash', 86_400_000);
    expect(current).toEqual({ tool: 'Bash', declaredTimeoutMs: 3_600_000 });
    resetToolInFlightTracking();
    await pre('forever', 'Bash', 1e12);
    expect(current).toEqual({ tool: 'Bash', declaredTimeoutMs: 3_600_000 });
  });

  it('a declaration within the cap passes through unchanged', async () => {
    await pre('half-hour', 'Bash', 1_800_000);
    expect(current).toEqual({ tool: 'Bash', declaredTimeoutMs: 1_800_000 });
    resetToolInFlightTracking();
    await pre('exact', 'Bash', 3_600_000);
    expect(current).toEqual({ tool: 'Bash', declaredTimeoutMs: 3_600_000 });
  });

  it('NaN, negative, zero and Infinity publish null', async () => {
    for (const bad of [Number.NaN, -1, 0, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      resetToolInFlightTracking();
      current = null;
      await pre(`bad-${bad}`, 'Bash', bad);
      expect(current).toEqual({ tool: 'Bash', declaredTimeoutMs: null });
    }
  });

  it("falls back to Claude Code's 600000 default when BASH_MAX_TIMEOUT_MS is absent or unusable", () => {
    for (const env of [undefined, '', 'abc', '0', '-5']) {
      if (env === undefined) delete process.env.BASH_MAX_TIMEOUT_MS;
      else process.env.BASH_MAX_TIMEOUT_MS = env;
      expect(clampDeclaredBashTimeoutMs(86_400_000)).toBe(600_000);
      expect(clampDeclaredBashTimeoutMs(120_000)).toBe(120_000);
    }
  });

  it('a non-number declaration is no declaration', () => {
    expect(clampDeclaredBashTimeoutMs('3600000')).toBeNull();
    expect(clampDeclaredBashTimeoutMs(undefined)).toBeNull();
  });
});

/**
 * The two OUTER bounds on the leak `toolsInFlight` documents (a call denied by
 * another PreToolUse hook never reaches PostToolUse): `ClaudeProvider.query`
 * resets at query creation, and the `result` branch resets again. Each test
 * here fails if its own reset is deleted and passes without the other.
 */
describe('the in-flight leak is bounded by the provider', () => {
  let tmp: string;
  let prevHome: string | undefined;
  let midTurnLeak: (() => Promise<void>) | null = null;
  let seenBeforeResult: Recorded = null;

  const fakeSdkQuery = (() => {
    const gen = (async function* () {
      if (midTurnLeak) await midTurnLeak();
      seenBeforeResult = current;
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
    (gen as unknown as Record<string, unknown>).interrupt = async () => {};
    return gen as unknown as Query;
  }) as unknown as NonNullable<Parameters<typeof _setSdkQueryForTesting>[0]>;

  beforeEach(() => {
    resetToolInFlightTracking();
    current = null;
    midTurnLeak = null;
    seenBeforeResult = null;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-inflight-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmp;
    _setSdkQueryForTesting(fakeSdkQuery);
  });
  afterEach(() => {
    _setSdkQueryForTesting();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function startQuery() {
    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    return provider.query({ prompt: 'hi', cwd: tmp });
  }

  it('query creation clears an entry leaked by the previous query', () => {
    // A denied call from the last query: recorded, never cleared by PostToolUse.
    void pre('denied-last-query', 'Bash', 1_800_000);
    expect(current).toEqual({ tool: 'Bash', declaredTimeoutMs: 1_800_000 });
    startQuery();
    expect(current).toBeNull();
  });

  it('a result clears an entry leaked during the turn', async () => {
    midTurnLeak = async () => {
      await pre('denied-this-turn', 'Bash', 1_800_000);
    };
    const q = startQuery();
    const types: string[] = [];
    for await (const e of q.events) types.push((e as { type: string }).type);
    expect(types).toContain('result');
    // The leak was live right up to the result...
    expect(seenBeforeResult).toEqual({ tool: 'Bash', declaredTimeoutMs: 1_800_000 });
    // ...and the result branch released it.
    expect(current).toBeNull();
  });
});
