/**
 * Codex-side hook runner.
 *
 * Codex's app-server fires shell-command hooks via ~/.codex/hooks.json with
 * Claude-flavored stdin/stdout JSON (same shape Claude Code uses; the codex
 * hook protocol borrowed this format directly). This module exposes the
 * same hook decisions the Claude provider uses as SDK callbacks, but
 * dispatched from a CLI entry-point so codex-spawned subprocesses can
 * invoke them.
 *
 * Payload differences from Claude to Codex are normalized in
 * `normalizeCodexHookInput` — same algorithm as ~/.codex/hooks/codex-claude-shim.cjs.
 */
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

import {
  SDK_DISALLOWED_TOOLS,
  preToolUseHook,
  postToolUseHook,
  createSanitizeBashHook,
  createSelfApprovalBlockHook,
  createBlockSnowflakeConnectorHook,
  createBlockGitCloneHook,
  createEmailGateHook,
} from '../providers/claude.js';
import { createBlockMnemonRealHook } from '../modules/memory/block-mnemon-real-hook.js';
import {
  createMemoryCaptureBashHook,
  createMemoryCaptureWebFetchHook,
  createMemoryCaptureMcpHook,
} from '../mcp-tools/memory-capture.js';

/**
 * Codex shell-tool aliases. Normalized to Claude's `Bash` so existing hooks
 * (which match on `tool_name === 'Bash'`) fire correctly.
 */
const CODEX_SHELL_ALIASES = new Set(['exec_command', 'local_shell_call', 'shell']);

export interface CodexHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: unknown;
  tool_response?: unknown;
  cwd?: string;
  session_id?: string;
  transcript_path?: string;
  hook_event_name?: string;
  [key: string]: unknown;
}

/**
 * Normalize a Codex hook payload to Claude's shape so existing
 * `tool_name === 'Bash'` / `tool_input.command` matching works.
 */
export function normalizeCodexHookInput(input: CodexHookInput): CodexHookInput {
  if (!input || typeof input !== 'object') return input;
  const out: CodexHookInput = { ...input };

  if (typeof out.tool_name === 'string' && CODEX_SHELL_ALIASES.has(out.tool_name)) {
    out.tool_name = 'Bash';
  }

  if (out.tool_input && typeof out.tool_input === 'object') {
    const ti = { ...out.tool_input } as Record<string, unknown>;
    if (Array.isArray(ti.command)) ti.command = (ti.command as unknown[]).join(' ');
    if (!ti.command) {
      if (typeof ti.cmd === 'string') ti.command = ti.cmd;
      else if (Array.isArray(ti.cmd)) ti.command = (ti.cmd as unknown[]).join(' ');
    }
    out.tool_input = ti;
  }

  // Codex calls the post-tool envelope `tool_response`; Claude calls it `tool_output`.
  if (!out.tool_output && out.tool_response) {
    out.tool_output = out.tool_response;
  }

  return out;
}

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure';

// ── Destructive-action guard (shared bootstrap core) ───────────────────────────
// Codex does NOT fire plugin-provided hooks under app-server (container) or exec
// (host) — verified empirically. So the destructive-command gate (parity with the
// Claude block-destructive hook + the OpenCode opencode-guard plugin) is wired
// into THIS chain, the codex surface that provably fires (same path email-gate
// rides). It reuses the SAME decision core the other runtimes import — no drift.
// The equivalent HOST codex adapter is workflow-agents/hooks/codex-guard.ts
// (wired via ~/.codex/hooks.json, which fires in interactive codex).
type GuardCore = {
  evaluateBashCommand: (cmd: string, opts?: { skipGate?: boolean }) => { action: 'allow' | 'block' | 'gate'; reason?: string };
  consumeGateApproval: (cmd: string) => boolean;
  runNanoclawGate: (cmd: string, reason: string, onStageError?: (e: unknown) => void) => 'approved' | 'denied' | 'timeout';
  IS_NANOCLAW: boolean;
};

/** Default container path to the vendored shared guard core. Overridable via
 *  NANOCLAW_DESTRUCTIVE_GUARD_CORE (used by tests). */
const DEFAULT_GUARD_CORE_PATH =
  '/workspace/plugins/bootstrap/plugins/workflow-agents/hooks/guards/block-destructive-core.ts';

/** Import the shared guard core from the mounted bootstrap plugin (bun caches the
 *  module, so re-calls are cheap). Fail-open (returns null + warns) if the mount
 *  is absent — a missing plugin must not wedge the agent. */
async function loadGuardCore(): Promise<GuardCore | null> {
  const corePath = process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE || DEFAULT_GUARD_CORE_PATH;
  try {
    return (await import(corePath)) as unknown as GuardCore;
  } catch (err) {
    console.error(
      `[codex-hook] destructive-guard core unavailable at ${corePath} — codex running WITHOUT the gate: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function denyDecision(reason: string): {
  hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string };
} {
  const r = reason.startsWith('BLOCKED:') || reason.startsWith('GATED:') ? reason : `BLOCKED: ${reason}`;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: r,
    },
  };
}

/** Evaluate a bash command against the shared core; return a deny decision to
 *  block, or null to allow. Mirrors the control flow of block-destructive.ts /
 *  opencode-guard.ts / codex-guard.ts (each a thin adapter over the same core). */
async function runDestructiveGuard(
  command: string,
): Promise<ReturnType<typeof denyDecision> | null> {
  if (!command) return null;
  const core = await loadGuardCore();
  if (!core) return null; // fail-open: core unavailable (e.g. bootstrap not mounted)

  const verdict = core.evaluateBashCommand(command);
  if (verdict.action === 'allow') return null;
  if (verdict.action === 'block') return denyDecision(verdict.reason ?? 'destructive command blocked');

  // gate
  const reason = verdict.reason ?? 'requires approval';
  if (core.consumeGateApproval(command)) {
    const post = core.evaluateBashCommand(command, { skipGate: true });
    return post.action === 'block' ? denyDecision(post.reason ?? reason) : null;
  }
  if (core.IS_NANOCLAW) {
    let staged = true;
    const decision = core.runNanoclawGate(command, reason, () => {
      staged = false;
    });
    if (!staged) return denyDecision(`${reason} — could not stage approval request (session DBs unavailable).`);
    if (decision === 'approved') {
      const post = core.evaluateBashCommand(command, { skipGate: true });
      return post.action === 'block' ? denyDecision(post.reason ?? reason) : null;
    }
    const detail =
      decision === 'denied'
        ? 'Cancelled by user. Do not retry or explain why it was blocked — just acknowledge the cancellation briefly.'
        : 'Timed out waiting for user approval. Do not retry.';
    return denyDecision(`${reason} — ${detail}`);
  }
  // No session-DB surface (non-NanoClaw): fail-closed for gated infra commands.
  return denyDecision(`${reason} — requires explicit user approval, unavailable in this environment.`);
}

// ── File-protection (shared bootstrap core, parity with Claude file-protection) ──
type FileProtectionCore = {
  EDIT_TOOLS: Set<string>;
  checkEditProtection: (toolName: string, toolInput: Record<string, unknown>) => string | null;
};

/** Import file-protection-core.ts from the same dir as the guard core. */
async function loadFileProtectionCore(): Promise<FileProtectionCore | null> {
  const guardPath = process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE || DEFAULT_GUARD_CORE_PATH;
  const fpPath = guardPath.replace(/[^/]+$/, 'file-protection-core.ts');
  try {
    return (await import(fpPath)) as unknown as FileProtectionCore;
  } catch {
    return null; // fail-open: file-protection unavailable
  }
}

/** Block edits (Edit/Write/apply_patch/...) to protected paths. Returns a deny
 *  decision or null. Bypassable via SKIP_FILE_PROTECTION=1 (parity with Claude). */
async function runFileProtection(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<ReturnType<typeof denyDecision> | null> {
  if (process.env.SKIP_FILE_PROTECTION === '1') return null;
  const core = await loadFileProtectionCore();
  if (!core || !core.EDIT_TOOLS.has(toolName)) return null;
  const blocked = core.checkEditProtection(toolName, toolInput);
  return blocked
    ? denyDecision(`file-protection — '${blocked}' is protected from automated edits. Set SKIP_FILE_PROTECTION=1 to bypass.`)
    : null;
}

/**
 * Run the PreToolUse hook chain in sequence. Stops on the first hook
 * that emits a `decision: 'block'` or a `permissionDecision: 'deny'`.
 * Carries `updatedInput` forward across hooks.
 *
 * Output: a single object suitable for JSON.stringify to stdout. Codex's
 * hook runtime parses it the same way Claude Code does:
 *   { hookSpecificOutput: { hookEventName: 'PreToolUse',
 *                            permissionDecision: 'deny' | 'allow',
 *                            permissionDecisionReason: string,
 *                            updatedInput?: object } }
 *   or { continue: true } for "no opinion / proceed".
 */
export async function runPreToolUseChain(input: CodexHookInput): Promise<unknown> {
  const normalized = normalizeCodexHookInput(input);

  // Tool denylist (preToolUseHook's first responsibility) + container_state
  // tracking. Block path is structural — non-Bash tools also pass through
  // here so the in-flight tracker stays current.
  const first = await preToolUseHook(
    normalized as Parameters<HookCallback>[0],
    {} as Parameters<HookCallback>[1],
    {} as Parameters<HookCallback>[2],
  );
  if ((first as { decision?: string })?.decision === 'block') {
    return first;
  }

  if (normalized.tool_name !== 'Bash') {
    // File-protection applies to edit tools (apply_patch, Edit, Write, ...) —
    // they don't go through the Bash chain below.
    const fpDeny = await runFileProtection(
      normalized.tool_name ?? '',
      (normalized.tool_input ?? {}) as Record<string, unknown>,
    );
    if (fpDeny) return fpDeny;
    return first ?? { continue: true };
  }

  // Bash-only chain. Order matters: sanitize first (so blocked commands
  // also get the unset prefix stripped from logs); then the guardrails.
  const chain: HookCallback[] = [
    createSanitizeBashHook(),
    createSelfApprovalBlockHook(),
    createBlockSnowflakeConnectorHook(),
    createBlockGitCloneHook(),
    createEmailGateHook(),
  ];
  if (process.env.MNEMON_READ_ONLY === '1') {
    chain.push(createBlockMnemonRealHook());
  }

  let currentInput: CodexHookInput = normalized;
  let mergedUpdatedInput: Record<string, unknown> | undefined;

  for (const hook of chain) {
    const out = await hook(
      currentInput as Parameters<HookCallback>[0],
      {} as Parameters<HookCallback>[1],
      {} as Parameters<HookCallback>[2],
    );
    if (!out) continue;
    const ret = out as {
      decision?: string;
      stopReason?: string;
      hookSpecificOutput?: {
        hookEventName?: string;
        permissionDecision?: string;
        permissionDecisionReason?: string;
        updatedInput?: Record<string, unknown>;
      };
      systemMessage?: string;
    };
    if (ret.decision === 'block' || ret.hookSpecificOutput?.permissionDecision === 'deny') {
      return ret;
    }
    if (ret.hookSpecificOutput?.updatedInput) {
      mergedUpdatedInput = { ...(mergedUpdatedInput ?? currentInput.tool_input), ...ret.hookSpecificOutput.updatedInput };
      currentInput = { ...currentInput, tool_input: mergedUpdatedInput };
    }
  }

  // Destructive-action guard — runs on the post-sanitize command, after the
  // existing chain. Returns a deny decision (blocks) or null (allow/continue).
  const guardCommand = (currentInput.tool_input as { command?: string } | undefined)?.command ?? '';
  const guardDeny = await runDestructiveGuard(guardCommand);
  if (guardDeny) return guardDeny;

  if (mergedUpdatedInput) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: mergedUpdatedInput,
      },
    };
  }
  return { continue: true };
}

/**
 * Run the PostToolUse hook chain. Captures Bash/WebFetch/MCP output into
 * mnemon inbox when MNEMON_STORE is set; always clears the in-flight
 * tracker.
 */
export async function runPostToolUseChain(input: CodexHookInput): Promise<unknown> {
  const normalized = normalizeCodexHookInput(input);

  await postToolUseHook(
    normalized as Parameters<HookCallback>[0],
    {} as Parameters<HookCallback>[1],
    {} as Parameters<HookCallback>[2],
  );

  if (!process.env.MNEMON_STORE) {
    return { continue: true };
  }

  const toolName = normalized.tool_name ?? '';
  const captureHooks: HookCallback[] = [];
  if (toolName === 'Bash') captureHooks.push(createMemoryCaptureBashHook());
  else if (toolName === 'WebFetch') captureHooks.push(createMemoryCaptureWebFetchHook());
  else if (toolName.startsWith('mcp__')) captureHooks.push(createMemoryCaptureMcpHook());

  for (const hook of captureHooks) {
    try {
      await hook(
        normalized as Parameters<HookCallback>[0],
        {} as Parameters<HookCallback>[1],
        {} as Parameters<HookCallback>[2],
      );
    } catch (err) {
      console.error(`[codex-hook] capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { continue: true };
}

/**
 * Dispatch a hook by event name. Returns the JSON object to emit on
 * stdout for the Codex hook runtime to interpret.
 */
export async function runHookForCodex(eventName: HookEvent, input: CodexHookInput): Promise<unknown> {
  switch (eventName) {
    case 'PreToolUse':
      return runPreToolUseChain(input);
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return runPostToolUseChain(input);
    default:
      return { continue: true };
  }
}

/** Re-export for tests. */
export { SDK_DISALLOWED_TOOLS };
