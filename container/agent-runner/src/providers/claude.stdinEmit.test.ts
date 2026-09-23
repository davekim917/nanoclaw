/**
 * THE stdin-prefix contract file — for BOTH chains that register the shared
 * rewrite hook. It is deliberately ONE file: when a hook's coverage is split
 * across a file per chain, a change to the hook can be validated by running
 * only one of them, which is how `codex-hooks/runner.test.ts` sat red for
 * three review rounds of #1010 (docs/review-notes.md, class `hook tests`).
 * Anything pinning the prefix contract belongs here, not in a chain's own file.
 *
 * INVARIANT: the `exec </dev/null` stdin prefix is a transport detail that no
 * guard may ever see. It is applied on the CLAUDE path only — the Codex chain
 * applies none (codex-hooks/runner.ts). On the Claude SDK path the single emit
 * point is the rewrite hook with `closeStdin: true`, the only hook in the Bash
 * PreToolUse list that returns `updatedInput`.
 *
 * How the CLI actually dispatches, read from its binary at SDK 0.3.280 (logic
 * unchanged from 0.3.272): all of these hooks share one tier (only
 * policySettings hooks run in an earlier one), whose hooks run CONCURRENTLY,
 * every one on the same `hookInput`; the fold keeps the last `updatedInput` to
 * complete. So in production no guard can see the prefix whatever the order.
 * This test deliberately models something STRICTER — it threads each hook's
 * `updatedInput` into the next, in list order — over the provider's REAL
 * registered list, and asserts every guard still saw the command exactly as
 * the agent typed it. Passing the stricter model implies the real one; that is
 * why the rewrite stays registered last even though position orders nothing.
 */
import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const { runPreToolUseChain } = await import('../codex-hooks/runner.js');

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

describe('(iii) Claude registration: one emitter, and no guard ever sees the stdin prefix', () => {
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

// The `exec </dev/null` stdin prefix is CLAUDE-ONLY. This chain must never
// emit it, and no guard here may ever see it — the email gate fails closed on
// `<` and newlines, and the destructive guard would print it on an approval card.
describe('runPreToolUseChain — no stdin prefix here, and no guard ever sees one', () => {
  const PREFIX = 'exec </dev/null\n';
  const saved: Record<string, string | undefined> = {};
  let sink = '';
  let writeSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    for (const k of [
      'NANOCLAW_DESTRUCTIVE_GUARD_CORE',
      'NANOCLAW_EMAIL_GATE_CORE',
      'NANOCLAW_IS_SCHEDULED_TASK',
      'NANOCLAW_TEST_GUARD_COMMAND_SINK',
    ])
      saved[k] = process.env[k];
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = new URL(
      '../codex-hooks/__test-fixtures__/guard-command-recorder/block-destructive-core.ts',
      import.meta.url,
    ).pathname;
    // Inline email policy — the same fail-closed bypass check the finding cites.
    process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts';
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    sink = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-guard-sink-')), 'commands.jsonl');
    process.env.NANOCLAW_TEST_GUARD_COMMAND_SINK = sink;
    // Staging an approval card writes an outbound row. None may be written here.
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
    fs.rmSync(path.dirname(sink), { recursive: true, force: true });
  });

  const guardCalls = (): string[] =>
    fs.existsSync(sink)
      ? fs
          .readFileSync(sink, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as string)
      : [];

  it('(i) a --dry-run send passes the email gate with no approval request, and gets no prefix', async () => {
    const cmd = 'gws gmail +send --to person8@fixture1.example.com --subject hi --body x --dry-run';
    const out = (await runPreToolUseChain({
      tool_name: 'exec_command',
      tool_input: { command: cmd },
      tool_use_id: 'exec-dry-run',
    })) as {
      continue?: boolean;
      hookSpecificOutput?: { permissionDecision?: string; updatedInput?: { command?: string } };
    };
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(writeSpy).not.toHaveBeenCalled();
    // Nothing rewrote it, so the chain emits no updatedInput at all.
    expect(out).toEqual({ continue: true });
  });

  it('(ii) the destructive guard is called with the un-prefixed command', async () => {
    const out = (await runPreToolUseChain({
      tool_name: 'exec_command',
      tool_input: { command: 'git status' },
    })) as { continue?: boolean; hookSpecificOutput?: { updatedInput?: { command?: string } } };
    expect(guardCalls()).toEqual(['git status']);
    expect(out).toEqual({ continue: true });
  });

  it('(ii) guards see the jest rewrite, and the emitted command carries no prefix', async () => {
    const out = (await runPreToolUseChain({
      tool_name: 'exec_command',
      tool_input: { command: 'npx jest' },
    })) as { hookSpecificOutput?: { updatedInput?: { command?: string } } };
    const [seen] = guardCalls();
    expect(seen).toContain('flock -n -E 126'); // the semantic rewrite IS visible
    expect(seen.startsWith(PREFIX)).toBe(false);
    expect(seen).not.toContain('</dev/null');
    // The jest rewrite is still emitted — and still without a stdin prefix.
    const emitted = out.hookSpecificOutput?.updatedInput?.command ?? '';
    expect(emitted).toContain('flock -n -E 126');
    expect(emitted.startsWith(PREFIX)).toBe(false);
  });
});
