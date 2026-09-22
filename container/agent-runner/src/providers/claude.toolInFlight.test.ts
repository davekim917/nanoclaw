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
import { describe, it, expect, beforeEach, mock } from 'bun:test';

type Recorded = { tool: string; declaredTimeoutMs: number | null } | null;
let current: Recorded = null;

const realContainerState = await import('../db/container-state.js');
mock.module('../db/container-state.js', () => ({
  ...realContainerState,
  setContainerToolInFlight: (tool: string, declaredTimeoutMs: number | null) => {
    current = { tool, declaredTimeoutMs };
  },
  clearContainerToolInFlight: () => {
    current = null;
  },
}));

const { preToolUseHook, postToolUseHook, resetToolInFlightTracking } = await import('./claude.js');

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
});
