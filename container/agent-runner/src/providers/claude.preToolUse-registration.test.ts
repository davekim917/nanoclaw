/**
 * `preToolUseHook` MUST be registered in the claude provider's PreToolUse table.
 *
 * It is the ONLY writer of `container_state.current_tool` / `tool_started_at` /
 * `tool_declared_timeout_ms`. `activeOperationTimeoutMs`
 * (src/modules/sweep-container-health/index.ts:545-548) returns null unless
 * `current_tool` is 'Bash' or 'CodexItem', and `decideStuckAction` (:585, :612)
 * then collapses the ceiling to `Math.max(ABSOLUTE_CEILING_MS, 0)` = 30 min and
 * the claim tolerance to `CLAIM_STUCK_MS` = 60 s. Unregistered, every
 * claude-provider container is killed at 30 minutes no matter what timeout the
 * agent declared on its Bash call — which is what a legitimately long Snowflake
 * query runs into.
 *
 * The registration has been lost in upstream merge resolution repeatedly: added
 * wired at 6a815190c (2026-04-20), lost again at ceb3fcd1a (2026-07-24), and
 * `git log -S'hooks: [preToolUseHook]'` shows no ordinary commit ever removing
 * it. It has never failed loudly — the container runs fine, the host just stops
 * honouring long tools. This file is the loud failure.
 *
 * The assertion is on the options object the provider actually hands the SDK,
 * captured through the same `mock.module` idiom claude.spawnEndToEnd.test.ts
 * uses, so it fails on a dropped ENTRY as well as on a dropped import.
 */
import { describe, it, expect, mock } from 'bun:test';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

let captured: Record<string, unknown> | null = null;
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (a: unknown) => {
    captured = (a as { options?: Record<string, unknown> }).options ?? null;
    const g = (async function* () {})() as AsyncGenerator & {
      setModel: (m?: string) => Promise<void>;
      applyFlagSettings: (s: Record<string, unknown>) => Promise<void>;
    };
    g.setModel = () => Promise.resolve();
    g.applyFlagSettings = () => Promise.resolve();
    return g;
  },
}));
const realContainerState = await import('../db/container-state.js');
mock.module('../db/container-state.js', () => ({
  ...realContainerState,
  clearContainerToolInFlight: () => {},
  setContainerToolInFlight: () => {},
}));

const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
const { ClaudeProvider, preToolUseHook, postToolUseHook } = await import('./claude.js');

type HookEntry = { matcher?: string; hooks: HookCallback[] };

function hookTable(event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'): HookEntry[] {
  captured = null;
  const provider = new ClaudeProvider({ providerConfig: {} });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  provider.query({ prompt: 'x', cwd: '/tmp' });
  const hooks = captured?.hooks as Record<string, HookEntry[]> | undefined;
  return hooks?.[event] ?? [];
}

describe('claude provider hook registration', () => {
  it('registers preToolUseHook in PreToolUse', () => {
    const entries = hookTable('PreToolUse');
    const all = entries.flatMap((e) => e.hooks);
    expect(all).toContain(preToolUseHook);
  });

  it('registers preToolUseHook with NO matcher, so every tool is recorded', () => {
    // A `matcher: 'Bash'` entry would leave `container_state` unset for every
    // other tool AND would never run the SDK_DISALLOWED_TOOLS block, which is
    // the whole defense-in-depth point of the hook.
    const owning = hookTable('PreToolUse').filter((e) => e.hooks.includes(preToolUseHook));
    expect(owning).toHaveLength(1);
    expect(owning[0].matcher).toBeUndefined();
  });

  it('keeps its PostToolUse counterparts registered', () => {
    // Half a pair is worse than neither: set-and-never-cleared pins the host's
    // ceiling open for the life of the query.
    expect(hookTable('PostToolUse').flatMap((e) => e.hooks)).toContain(postToolUseHook);
    expect(hookTable('PostToolUseFailure').flatMap((e) => e.hooks)).toContain(postToolUseHook);
  });
});
