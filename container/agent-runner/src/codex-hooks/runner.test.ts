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

  beforeEach(() => {
    // Snapshot env vars the hooks read.
    for (const k of ['MNEMON_READ_ONLY', 'NANOCLAW_IS_SCHEDULED_TASK']) savedEnv[k] = process.env[k];
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

  it('blocks mnemon real when MNEMON_READ_ONLY=1', async () => {
    process.env.MNEMON_READ_ONLY = '1';
    const out = (await runPreToolUseChain({
      tool_name: 'exec_command',
      tool_input: { command: 'mnemon-real remember foo bar' },
    })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
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

  it('fails open (allows) when the guard core is unavailable', async () => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = '/nonexistent/guard-core.ts';
    const out = (await runPreToolUseChain({
      tool_name: 'exec_command',
      tool_input: { command: 'echo STUB_BLOCK' },
    })) as { hookSpecificOutput?: { permissionDecision?: string } };
    // Missing core must not wedge the agent — guard no-ops, command not denied.
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
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
