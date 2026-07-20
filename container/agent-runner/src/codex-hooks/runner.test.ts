import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { normalizeCodexHookInput, runPreToolUseChain } from './runner.js';

describe('normalizeCodexHookInput', () => {
  it('translates exec_command → Bash', () => {
    const out = normalizeCodexHookInput({ tool_name: 'exec_command', tool_input: { command: 'ls' } });
    expect(out.tool_name).toBe('Bash');
  });

  it('translates local_shell_call → Bash', () => {
    const out = normalizeCodexHookInput({ tool_name: 'local_shell_call' });
    expect(out.tool_name).toBe('Bash');
  });

  it('joins array commands', () => {
    const out = normalizeCodexHookInput({ tool_name: 'shell', tool_input: { command: ['ls', '-la'] } });
    expect((out.tool_input as { command: string }).command).toBe('ls -la');
  });

  it('falls back to cmd when command absent', () => {
    const out = normalizeCodexHookInput({ tool_name: 'exec_command', tool_input: { cmd: 'pwd' } });
    expect((out.tool_input as { command: string }).command).toBe('pwd');
  });

  it('promotes tool_response → tool_output', () => {
    const out = normalizeCodexHookInput({ tool_name: 'Bash', tool_response: { exit_code: 0 } });
    expect(out.tool_output).toEqual({ exit_code: 0 });
  });

  it('leaves non-shell tool_name untouched', () => {
    const out = normalizeCodexHookInput({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } });
    expect(out.tool_name).toBe('WebFetch');
  });
});

describe('runPreToolUseChain — guardrails', () => {
  const savedEnv: Record<string, string | undefined> = {};
  // The destructive guard is fail-CLOSED (D17/C4): with no core, it denies
  // everything. These tests exercise the OTHER chain hooks (self-approval,
  // snowflake, git-clone), so point the destructive guard at the stub
  // core (allows anything but STUB_BLOCK/STUB_GATE) to let benign commands
  // through to the assertions under test.
  const STUB_CORE = new URL('./__test-fixtures__/guard-core-stub.ts', import.meta.url).pathname;

  beforeEach(() => {
    // Snapshot env vars the hooks read.
    for (const k of ['NANOCLAW_IS_SCHEDULED_TASK', 'NANOCLAW_DESTRUCTIVE_GUARD_CORE'])
      savedEnv[k] = process.env[k];
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = STUB_CORE;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('blocks git clone into /workspace/agent', async () => {
    const out = (await runPreToolUseChain({
      tool_name: 'exec_command',
      tool_input: { command: 'git clone https://github.com/x/y /workspace/agent/y' },
    })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('blocks .claude-destructive-gate self-approval', async () => {
    const out = (await runPreToolUseChain({
      tool_name: 'exec_command',
      tool_input: { command: 'touch .claude-destructive-gate' },
    })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('blocks python snowflake.connector', async () => {
    const out = (await runPreToolUseChain({
      tool_name: 'shell',
      tool_input: { command: 'python -c "import snowflake.connector; ..."' },
    })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('allows benign bash and merges sanitize prefix', async () => {
    const out = (await runPreToolUseChain({
      tool_name: 'exec_command',
      tool_input: { command: 'ls -la' },
    })) as
      | { continue?: boolean }
      | { hookSpecificOutput?: { hookEventName?: string; updatedInput?: { command?: string } } };
    if ('hookSpecificOutput' in out && out.hookSpecificOutput) {
      // Sanitize wraps with `unset KEY...;` if any secret env vars exist.
      // In the test env they may not, so updatedInput is optional.
      expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    } else {
      expect(out).toEqual({ continue: true });
    }
  });

  it('allows /tmp-only git clone', async () => {
    const out = (await runPreToolUseChain({
      tool_name: 'exec_command',
      tool_input: { command: 'git clone https://github.com/x/y /tmp/y' },
    })) as { continue?: boolean; hookSpecificOutput?: { permissionDecision?: string } };
    // Sanitize may insert updatedInput; assert nothing was denied.
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it('passes through non-Bash tools', async () => {
    const out = (await runPreToolUseChain({
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com' },
    })) as { continue?: boolean };
    expect(out.continue).toBe(true);
  });
});

describe('runPreToolUseChain — destructive-action guard wiring', () => {
  // Point the guard loader at the in-repo stub core (the real core lives in the
  // bootstrap repo; its verdicts are validated there). This tests that runner.ts
  // calls the core and maps verdicts → codex deny/continue correctly.
  const FIXTURE = new URL('./__test-fixtures__/guard-core-stub.ts', import.meta.url).pathname;
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = FIXTURE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
    else process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = saved;
  });

  it('denies a hard-blocked command (core → block)', async () => {
    const out = (await runPreToolUseChain({
      tool_name: 'exec_command',
      tool_input: { command: 'echo STUB_BLOCK' },
    })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('stub hard-block');
  });

  it('denies a gated command when no session-DB gate exists (core → gate, IS_NANOCLAW false → fail-closed)', async () => {
    const out = (await runPreToolUseChain({
      tool_name: 'exec_command',
      tool_input: { command: 'echo STUB_GATE' },
    })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('allows a benign command (core → allow)', async () => {
    const out = (await runPreToolUseChain({
      tool_name: 'exec_command',
      tool_input: { command: 'echo benign-ok' },
    })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it('fails CLOSED (denies) when the guard core is unavailable', async () => {
    // CONTRACT INVERSION (D17/C4): the destructive guard is now fail-CLOSED.
    // A missing/unimportable core must DENY, not allow — the previous fail-open
    // behavior (this test's old assertion) was the security gap this feature
    // closes. The reason text surfaces the unavailability so the agent reports
    // rather than retrying.
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = '/nonexistent/guard-core.ts';
    const out = (await runPreToolUseChain({
      tool_name: 'exec_command',
      tool_input: { command: 'echo benign-after-core-gone' },
    })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('guard unavailable');
  });

  // QA cross-model finding (codex #1): validateGuardCore only proves the export
  // is a function — a malformed-but-importable core whose evaluateBashCommand
  // RETURNS a non-verdict (undefined / unknown action) would previously throw on
  // the `verdict.action` access OUTSIDE the try/catch, escape the chain, and hit
  // the CLI's fail-OPEN handler. The verdict-shape guard must DENY instead.
  it('test_codex_destructive_fail_closed_malformed_verdict: denies when the core returns undefined', async () => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = new URL(
      './__test-fixtures__/malformed-verdict/block-destructive-core.ts',
      import.meta.url,
    ).pathname;
    const out = (await runPreToolUseChain({
      tool_name: 'exec_command',
      tool_input: { command: 'echo VERDICT_UNDEFINED' },
    })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('malformed verdict');
  });

  it('test_codex_destructive_fail_closed_unknown_action: denies when the core returns an unknown action', async () => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = new URL(
      './__test-fixtures__/malformed-verdict/block-destructive-core.ts',
      import.meta.url,
    ).pathname;
    const out = (await runPreToolUseChain({
      tool_name: 'exec_command',
      tool_input: { command: 'echo anything-else-gives-banana-action' },
    })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  // QA codex re-pass #2: the initial verdict was shape-validated, but the
  // post-approval skipGate re-check allowed any non-block action — a malformed
  // post-verdict (gate→approved→{action:'banana'}) fell through to allow.
  it('test_codex_destructive_fail_closed_malformed_postcheck: denies on a malformed post-approval verdict', async () => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = new URL(
      './__test-fixtures__/malformed-postcheck/block-destructive-core.ts',
      import.meta.url,
    ).pathname;
    const out = (await runPreToolUseChain({
      tool_name: 'exec_command',
      tool_input: { command: 'echo gated-then-malformed-postcheck' },
    })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('malformed post-approval verdict');
  });

  // codex #126 N1: consumeGateApproval returning a TRUTHY NON-BOOLEAN ({}) must
  // not count as "already approved" — the strict `=== true` check falls through
  // to real gate staging, which here can't stage → deny (NOT a skip-gate allow).
  it('test_codex_gate_nonboolean_approval_fails_closed: truthy-non-boolean consumeGateApproval denies', async () => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = new URL(
      './__test-fixtures__/gate-postcheck/block-destructive-core.ts',
      import.meta.url,
    ).pathname;
    const out = (await runPreToolUseChain({
      tool_name: 'exec_command',
      tool_input: { command: 'echo NONBOOL_APPROVAL' },
    })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('stage');
  });

  // codex #126 N2: a repeated `gate` after an approval is consumed (a stale core
  // ignoring skipGate) must DENY — only an explicit `allow` post-verdict passes.
  it('test_codex_gate_repeated_after_approval_fails_closed: post-approval gate denies', async () => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = new URL(
      './__test-fixtures__/gate-postcheck/block-destructive-core.ts',
      import.meta.url,
    ).pathname;
    const out = (await runPreToolUseChain({
      tool_name: 'exec_command',
      tool_input: { command: 'echo GATE_AFTER_APPROVAL' },
    })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  // codex #126 N3: a file-protection core returning a falsy NON-null ({undefined})
  // for an edit must DENY (fail-closed), not fall through to allow.
  it('test_codex_file_protection_malformed_result_fails_closed: falsy-non-null denies the edit', async () => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = new URL(
      './__test-fixtures__/fp-malformed-result/block-destructive-core.ts',
      import.meta.url,
    ).pathname;
    const out = (await runPreToolUseChain({
      tool_name: 'Write',
      tool_input: { file_path: 'src/index.ts' },
    })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('malformed');
  });

  it('denies an edit to a protected path (file-protection core → blocked)', async () => {
    const out = (await runPreToolUseChain({
      tool_name: 'Write',
      tool_input: { file_path: 'app/STUB_PROTECTED.env' },
    })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('allows an edit to a safe path', async () => {
    const out = (await runPreToolUseChain({
      tool_name: 'Write',
      tool_input: { file_path: 'src/index.ts' },
    })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });
});

// ── Shared fixture paths for the fail-closed suites ──
const STUB_GUARD_CORE = new URL('./__test-fixtures__/guard-core-stub.ts', import.meta.url).pathname;
const MALFORMED_CORE = new URL('./__test-fixtures__/malformed/block-destructive-core.ts', import.meta.url).pathname;
const THROWING_CORE = new URL('./__test-fixtures__/throwing/block-destructive-core.ts', import.meta.url).pathname;

/** Normalize a chain result to a single block/allow signal. Two deny shapes
 *  exist: the tool denylist returns top-level { decision: 'block' }; the guards
 *  return { hookSpecificOutput: { permissionDecision: 'deny', ... } }. `denied`
 *  is true for either; `reason` carries the guard reason when present. */
function decisionOf(out: unknown): { decision?: string; reason?: string; denied: boolean } {
  const o = out as {
    decision?: string;
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  const hso = o?.hookSpecificOutput;
  const denied = o?.decision === 'block' || hso?.permissionDecision === 'deny';
  return { decision: hso?.permissionDecision, reason: hso?.permissionDecisionReason, denied };
}

// ── E4: Codex destructive guard — fail-closed + export-validation ──
describe('E4 codex destructive guard — fail-closed', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
    else process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = saved;
  });

  it('test_codex_destructive_fail_closed_missing_core', async () => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = '/nonexistent/guard-core.ts';
    // Even a totally benign command denies when the core can't be imported.
    const out = await runPreToolUseChain({ tool_name: 'exec_command', tool_input: { command: 'echo hi' } });
    const d = decisionOf(out);
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('guard unavailable');
  });

  it('test_codex_destructive_fail_closed_malformed_core', async () => {
    // Exports present but mis-typed → validateGuardCore rejects → deny.
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = MALFORMED_CORE;
    const out = await runPreToolUseChain({ tool_name: 'exec_command', tool_input: { command: 'echo hi' } });
    const d = decisionOf(out);
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('guard unavailable');
  });

  it('test_codex_destructive_fail_closed_throwing_evaluator', async () => {
    // Core passes validation but evaluateBashCommand throws → caught → deny.
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = THROWING_CORE;
    const out = await runPreToolUseChain({ tool_name: 'exec_command', tool_input: { command: 'echo hi' } });
    const d = decisionOf(out);
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('guard errored');
  });

  it('test_codex_destructive_happy_path_unchanged', async () => {
    // With a valid core: block/gate/allow verdicts map as before.
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = STUB_GUARD_CORE;
    const blocked = decisionOf(
      await runPreToolUseChain({ tool_name: 'exec_command', tool_input: { command: 'echo STUB_BLOCK' } }),
    );
    expect(blocked.decision).toBe('deny');
    expect(blocked.reason).toContain('stub hard-block');

    // gate + IS_NANOCLAW false (stub) → fail-closed deny for the gated command.
    const gated = decisionOf(
      await runPreToolUseChain({ tool_name: 'exec_command', tool_input: { command: 'echo STUB_GATE' } }),
    );
    expect(gated.decision).toBe('deny');

    const allowed = decisionOf(
      await runPreToolUseChain({ tool_name: 'exec_command', tool_input: { command: 'echo benign-ok' } }),
    );
    expect(allowed.decision).toBeUndefined();
  });
});

// ── E5: Codex file-protection — fail-closed + export-validation ──
describe('E5 codex file-protection — fail-closed', () => {
  let savedGuard: string | undefined;
  let savedSkip: string | undefined;
  beforeEach(() => {
    savedGuard = process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
    savedSkip = process.env.SKIP_FILE_PROTECTION;
    delete process.env.SKIP_FILE_PROTECTION;
  });
  afterEach(() => {
    if (savedGuard === undefined) delete process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
    else process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = savedGuard;
    if (savedSkip === undefined) delete process.env.SKIP_FILE_PROTECTION;
    else process.env.SKIP_FILE_PROTECTION = savedSkip;
  });

  it('test_codex_fileprot_fail_closed_missing_core', async () => {
    // Missing core → an EDIT tool call denies; the FP path derives from the
    // (nonexistent) guard-core dir so it can't import.
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = '/nonexistent/block-destructive-core.ts';
    const out = await runPreToolUseChain({ tool_name: 'Write', tool_input: { file_path: 'src/anything.ts' } });
    const d = decisionOf(out);
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('file-protection unavailable');
  });

  it('missing core still passes non-edit tools through', async () => {
    // File-protection only governs edit tools; a non-edit tool is unaffected by
    // a missing FP core. (The Bash chain is separate; WebFetch hits the FP path.)
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = '/nonexistent/block-destructive-core.ts';
    const out = await runPreToolUseChain({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } });
    expect(decisionOf(out).decision).toBeUndefined();
  });

  it('test_codex_fileprot_fail_closed_malformed', async () => {
    // EDIT_TOOLS not a Set / checkEditProtection not a fn → reject → deny edits.
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = MALFORMED_CORE;
    const out = await runPreToolUseChain({ tool_name: 'apply_patch', tool_input: { input: '*** Add File: x.ts' } });
    const d = decisionOf(out);
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('file-protection unavailable');
  });

  it('test_codex_fileprot_throwing_check_denies', async () => {
    // Valid shape but checkEditProtection throws → caught → deny.
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = THROWING_CORE;
    const out = await runPreToolUseChain({ tool_name: 'Write', tool_input: { file_path: 'src/anything.ts' } });
    const d = decisionOf(out);
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('file-protection check errored');
  });

  it('test_codex_fileprot_skip_env_bypass', async () => {
    // SKIP_FILE_PROTECTION=1 bypasses entirely — even a protected path is allowed
    // and even a missing core does not deny.
    process.env.SKIP_FILE_PROTECTION = '1';
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = STUB_GUARD_CORE;
    const protectedEdit = await runPreToolUseChain({
      tool_name: 'Write',
      tool_input: { file_path: 'app/STUB_PROTECTED.env' },
    });
    expect(decisionOf(protectedEdit).decision).toBeUndefined();

    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = '/nonexistent/block-destructive-core.ts';
    const missingCore = await runPreToolUseChain({ tool_name: 'Write', tool_input: { file_path: 'x.ts' } });
    expect(decisionOf(missingCore).decision).toBeUndefined();
  });

  it('test_codex_fileprot_happy_path', async () => {
    // Valid core: protected path denies, safe path allows (existing contract).
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = STUB_GUARD_CORE;
    const blocked = await runPreToolUseChain({
      tool_name: 'Write',
      tool_input: { file_path: 'config/STUB_PROTECTED.yaml' },
    });
    expect(decisionOf(blocked).decision).toBe('deny');
    const allowed = await runPreToolUseChain({ tool_name: 'Write', tool_input: { file_path: 'src/index.ts' } });
    expect(decisionOf(allowed).decision).toBeUndefined();
  });
});

// ── E6 (Codex side): dispatch coverage at the real entrypoint ──
describe('E6 codex dispatch — each guard + uniform fail-closed', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
    else process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = saved;
  });

  it('test_codex_dispatch_each_guard', async () => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = STUB_GUARD_CORE;
    // Drive runPreToolUseChain (the real codex entrypoint) over each migrated
    // guard; assert per-gate block + a benign allow through the same chain.
    type Case = { name: string; tool: string; input: Record<string, unknown>; expectDeny: boolean };
    const cases: Case[] = [
      // denylist (SDK_DISALLOWED_TOOLS) — first hook in preToolUseHook.
      { name: 'denylist:CronCreate', tool: 'CronCreate', input: {}, expectDeny: true },
      // self-approval (chain hook)
      { name: 'self-approval', tool: 'exec_command', input: { command: 'touch .claude-destructive-gate' }, expectDeny: true },
      // snowflake (chain hook)
      { name: 'snowflake', tool: 'exec_command', input: { command: 'python -c "import snowflake.connector"' }, expectDeny: true },
      // git-clone (chain hook, inline fallback since stub lacks the export)
      { name: 'git-clone', tool: 'exec_command', input: { command: 'git clone https://x/y /workspace/agent/y' }, expectDeny: true },
      // destructive core (post-chain guard)
      { name: 'destructive', tool: 'exec_command', input: { command: 'echo STUB_BLOCK' }, expectDeny: true },
      // file-protection (non-Bash edit tool)
      { name: 'file-protection', tool: 'Write', input: { file_path: 'a/STUB_PROTECTED.env' }, expectDeny: true },
      // benign passthrough
      { name: 'benign-bash', tool: 'exec_command', input: { command: 'ls -la' }, expectDeny: false },
      { name: 'benign-edit', tool: 'Write', input: { file_path: 'src/index.ts' }, expectDeny: false },
    ];
    for (const c of cases) {
      const d = decisionOf(await runPreToolUseChain({ tool_name: c.tool, tool_input: c.input }));
      if (c.expectDeny) {
        // `denied` covers both deny shapes (top-level block + permissionDecision).
        expect(d.denied, `${c.name} should be denied`).toBe(true);
      } else {
        expect(d.denied, `${c.name} should be allowed`).toBe(false);
      }
    }
  });

  it('test_codex_denylist_chain_dispatched', async () => {
    // The tool denylist is dispatched via preToolUseHook (runner.ts:222, first
    // hook). A disallowed tool returns decision:'block' before any guard runs.
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = STUB_GUARD_CORE;
    const out = (await runPreToolUseChain({ tool_name: 'CronCreate', tool_input: {} })) as { decision?: string };
    expect(out.decision).toBe('block');
  });

  it('test_codex_dispatch_uniform_fail_closed_both_cores', async () => {
    // Both the destructive core AND the file-protection core fail CLOSED in the
    // same direction when missing: bash command denies, edit denies.
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = '/nonexistent/block-destructive-core.ts';
    const bash = decisionOf(await runPreToolUseChain({ tool_name: 'exec_command', tool_input: { command: 'echo hi' } }));
    expect(bash.decision).toBe('deny');
    const edit = decisionOf(await runPreToolUseChain({ tool_name: 'Write', tool_input: { file_path: 'src/x.ts' } }));
    expect(edit.decision).toBe('deny');

    // Same uniform direction under malformed cores.
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = MALFORMED_CORE;
    const bash2 = decisionOf(await runPreToolUseChain({ tool_name: 'exec_command', tool_input: { command: 'echo hi' } }));
    expect(bash2.decision).toBe('deny');
    const edit2 = decisionOf(await runPreToolUseChain({ tool_name: 'apply_patch', tool_input: { input: '*** Add File: y.ts' } }));
    expect(edit2.decision).toBe('deny');
  });
});
