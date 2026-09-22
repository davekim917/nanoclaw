/**
 * INVARIANT: the `exec </dev/null` stdin prefix is a transport detail that no
 * guard may ever see. It is applied on the CLAUDE path only — the Codex chain
 * applies none (codex-hooks/runner.ts). On the Claude SDK path the Bash
 * PreToolUse list IS the chain (the CLI merges it), so the single emit point
 * is the rewrite hook registered LAST with `closeStdin: true`.
 *
 * We cannot read how the CLI merges several hooks' `updatedInput`. This test
 * therefore runs the provider's REAL registered Bash hook list under the
 * strictest reading — each hook receives the previous hook's `updatedInput` —
 * and asserts that every guard still saw the command exactly as the agent
 * typed it. Under the other reading (every hook sees the original input) the
 * guards see raw text trivially.
 */
import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
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
const { ClaudeProvider, wrapDevNullStdin } = await import('./claude.js');
const messagesOut = await import('../db/messages-out.js');

type HookEntry = { matcher?: string; hooks: HookCallback[] };

function registeredBashHooks(): HookCallback[] {
  captured = null;
  const provider = new ClaudeProvider({ providerConfig: {} });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  provider.query({ prompt: 'x', cwd: '/tmp' });
  const pre = (captured?.hooks as Record<string, HookEntry[]> | undefined)?.PreToolUse ?? [];
  return pre.find((e) => e.matcher === 'Bash')?.hooks ?? [];
}

/** Run the list threading `updatedInput` forward; record what each hook was given. */
async function runChained(hooks: HookCallback[], command: string) {
  const seen: string[] = [];
  let toolInput: Record<string, unknown> = { command };
  let denied: string | undefined;
  for (const hook of hooks) {
    seen.push(String(toolInput.command));
    const out = (await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: toolInput, tool_use_id: 'toolu_stdin' } as never,
      {} as never,
      {} as never,
    )) as { hookSpecificOutput?: { permissionDecision?: string; updatedInput?: Record<string, unknown> } };
    if (out?.hookSpecificOutput?.permissionDecision === 'deny') {
      denied = String(toolInput.command);
      break;
    }
    if (out?.hookSpecificOutput?.updatedInput) toolInput = { ...toolInput, ...out.hookSpecificOutput.updatedInput };
  }
  return { seen, final: String(toolInput.command), denied };
}

describe('(iii) Claude registration: the stdin prefix is emitted last and never seen by a guard', () => {
  const saved: Record<string, string | undefined> = {};
  let writeSpy: ReturnType<typeof spyOn> | undefined;
  beforeEach(() => {
    for (const k of ['NANOCLAW_DESTRUCTIVE_GUARD_CORE', 'NANOCLAW_EMAIL_GATE_CORE', 'NANOCLAW_IS_SCHEDULED_TASK'])
      saved[k] = process.env[k];
    // Inline fallbacks: the same fail-closed email bypass check the finding cites.
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = '/nonexistent/guard-core.ts';
    process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts';
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    // Staging an approval card writes an outbound row. None may be written.
    writeSpy = spyOn(messagesOut, 'writeMessageOut').mockImplementation(() => {
      throw new Error('an approval request was staged');
    });
  });
  afterEach(() => {
    writeSpy?.mockRestore();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('a --dry-run send reaches the end un-denied, every guard saw raw text, and the prefix is emitted', async () => {
    const hooks = registeredBashHooks();
    // managed-git, self-approval, snowflake, git-clone, codex-companion, email gate, rewrite.
    expect(hooks).toHaveLength(7);
    const cmd = 'gws gmail +send --to person8@fixture1.example.com --subject hi --body x --dry-run';
    const r = await runChained(hooks, cmd);
    expect(r.denied).toBeUndefined();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(r.seen).toEqual(Array(hooks.length).fill(cmd)); // every hook, email gate included, saw raw text
    expect(r.final).toBe(wrapDevNullStdin(cmd));
  });
});
