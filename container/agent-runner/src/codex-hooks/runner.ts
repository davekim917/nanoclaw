/** Payload normalization follows ~/.codex/hooks/codex-claude-shim.cjs; keep the two in step. */
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

import {
  preToolUseHook,
  postToolUseHook,
  createBashCommandRewriteHook,
  createSelfApprovalBlockHook,
  createBlockSnowflakeConnectorHook,
  createBlockGitCloneHook,
  createEmailGateHook,
} from '../providers/claude.js';
import { createManagedGitMaintenanceHook } from '../managed-git-guard.js';
import { hookFailureDenyReason } from './hook-failure.js';

/** Normalized to `Bash` because the shared hooks match on `tool_name === 'Bash'`. */
const CODEX_SHELL_ALIASES = new Set(['exec_command', 'local_shell_call', 'shell']);

export interface CodexHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: unknown;
  tool_response?: unknown;
  cwd?: string;
  session_id?: string;
  /** Same value for every handler of one tool call, which lets the concurrent guards share one approval card. */
  tool_use_id?: string;
  transcript_path?: string;
  hook_event_name?: string;
  [key: string]: unknown;
}

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

// This chain and the plugin's codex-guard.ts both run, concurrently, on every Codex tool call. Both must evaluate
// (neither covers the other); only the approval is shared, via `toolUseId`, so the two raise one card.
type GuardCore = {
  evaluateBashCommand: (
    cmd: string,
    opts?: { skipGate?: boolean },
  ) => { action: 'allow' | 'block' | 'gate'; reason?: string };
  consumeGateApproval: (cmd: string) => boolean;
  runNanoclawGate: (
    cmd: string,
    reason: string,
    onStageError?: (e: unknown) => void,
    /** Optional: a core from an older image ignores it (two cards), so it must never be required. */
    toolUseId?: string,
  ) => 'approved' | 'denied' | 'timeout';
  IS_NANOCLAW: boolean;
};

const DEFAULT_GUARD_CORE_PATH =
  '/workspace/plugins/bootstrap/plugins/workflow-agents/hooks/guards/block-destructive-core.ts';

type GuardCoreLoad = { ok: true; core: GuardCore } | { ok: false; reason: string };

/** A core missing or mis-typing any export is rejected, never used partially. */
function validateGuardCore(mod: Record<string, unknown>): string | null {
  const missing: string[] = [];
  if (typeof mod.evaluateBashCommand !== 'function') missing.push('evaluateBashCommand');
  if (typeof mod.consumeGateApproval !== 'function') missing.push('consumeGateApproval');
  if (typeof mod.runNanoclawGate !== 'function') missing.push('runNanoclawGate');
  if (typeof mod.IS_NANOCLAW !== 'boolean') missing.push('IS_NANOCLAW');
  return missing.length > 0 ? `missing/mis-typed export(s): ${missing.join(', ')}` : null;
}

async function loadGuardCore(): Promise<GuardCoreLoad> {
  const corePath = process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE || DEFAULT_GUARD_CORE_PATH;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(corePath)) as Record<string, unknown>;
  } catch (err) {
    const reason = `destructive-guard core unavailable at ${corePath}: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[codex-hook] ${reason} — denying (fail-closed)`);
    return { ok: false, reason };
  }
  const invalid = validateGuardCore(mod);
  if (invalid) {
    const reason = `destructive-guard core malformed at ${corePath}: ${invalid}`;
    console.error(`[codex-hook] ${reason} — denying (fail-closed)`);
    return { ok: false, reason };
  }
  return { ok: true, core: mod as unknown as GuardCore };
}

/** Every verdict, including the post-approval re-checks, is shape-checked: an unknown action denies. */
function wellFormedVerdict(v: unknown): v is { action: 'allow' | 'block' | 'gate'; reason?: string } {
  const action = (v as { action?: unknown } | null | undefined)?.action;
  return action === 'allow' || action === 'block' || action === 'gate';
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

async function runDestructiveGuard(
  command: string,
  toolUseId?: string,
): Promise<ReturnType<typeof denyDecision> | null> {
  if (!command) return null;
  const loaded = await loadGuardCore();
  // Fail closed: a missing or malformed core denies.
  if (!loaded.ok) {
    return denyDecision(
      `Destructive-command guard unavailable (${loaded.reason}). Denying for safety — report this rather than retrying.`,
    );
  }
  const core = loaded.core;

  // A throwing guard must never fall through to allow.
  let verdict: ReturnType<GuardCore['evaluateBashCommand']>;
  try {
    verdict = core.evaluateBashCommand(command);
  } catch (err) {
    return denyDecision(
      `Destructive-command guard errored (${err instanceof Error ? err.message : String(err)}). Denying for safety.`,
    );
  }
  if (!wellFormedVerdict(verdict)) {
    return denyDecision(
      'Destructive-command guard returned a malformed verdict — denying for safety. Report this rather than retrying.',
    );
  }
  if (verdict.action === 'allow') return null;
  if (verdict.action === 'block') return denyDecision(verdict.reason ?? 'destructive command blocked');

  const reason = verdict.reason ?? 'requires approval';
  try {
    // Only an exact `true` counts: a malformed core may return a truthy non-boolean.
    if (core.consumeGateApproval(command) === true) {
      const post = core.evaluateBashCommand(command, { skipGate: true });
      if (!wellFormedVerdict(post))
        return denyDecision(`${reason} — malformed post-approval verdict, denying for safety.`);
      // A repeated `gate` (a stale core ignoring skipGate) must deny, not allow.
      return post.action === 'allow' ? null : denyDecision(post.reason ?? reason);
    }
    if (core.IS_NANOCLAW) {
      let staged = true;
      const decision = core.runNanoclawGate(
        command,
        reason,
        () => {
          staged = false;
        },
        toolUseId,
      );
      if (!staged) return denyDecision(`${reason} — could not stage approval request (session DBs unavailable).`);
      if (decision === 'approved') {
        const post = core.evaluateBashCommand(command, { skipGate: true });
        if (!wellFormedVerdict(post))
          return denyDecision(`${reason} — malformed post-approval verdict, denying for safety.`);
        return post.action === 'allow' ? null : denyDecision(post.reason ?? reason);
      }
      const detail =
        decision === 'denied'
          ? 'Cancelled by user. Do not retry or explain why it was blocked — just acknowledge the cancellation briefly.'
          : 'Timed out waiting for user approval. Do not retry.';
      return denyDecision(`${reason} — ${detail}`);
    }
  } catch (err) {
    // A throw anywhere in the gate path is treated as a denied gate, never allow.
    return denyDecision(
      `${reason} — approval gate errored (${err instanceof Error ? err.message : String(err)}). Denying for safety.`,
    );
  }
  // No session-DB surface (non-NanoClaw): fail-closed for gated infra commands.
  return denyDecision(`${reason} — requires explicit user approval, unavailable in this environment.`);
}

type FileProtectionCore = {
  EDIT_TOOLS: Set<string>;
  checkEditProtection: (toolName: string, toolInput: Record<string, unknown>) => string | null;
};

/** Used only to deny edits when the core is unavailable; keep in sync with file-protection-core.ts EDIT_TOOLS. */
const FALLBACK_EDIT_TOOLS = new Set([
  'Edit',
  'MultiEdit',
  'Write',
  'edit',
  'write',
  'write_file',
  'create_file',
  'apply_patch',
]);

type FileProtectionLoad = { ok: true; core: FileProtectionCore } | { ok: false; reason: string };

function validateFileProtectionCore(mod: Record<string, unknown>): string | null {
  const missing: string[] = [];
  if (!(mod.EDIT_TOOLS instanceof Set)) missing.push('EDIT_TOOLS');
  if (typeof mod.checkEditProtection !== 'function') missing.push('checkEditProtection');
  return missing.length > 0 ? `missing/mis-typed export(s): ${missing.join(', ')}` : null;
}

async function loadFileProtectionCore(): Promise<FileProtectionLoad> {
  const guardPath = process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE || DEFAULT_GUARD_CORE_PATH;
  const fpPath = guardPath.replace(/[^/]+$/, 'file-protection-core.ts');
  let mod: Record<string, unknown>;
  try {
    mod = (await import(fpPath)) as Record<string, unknown>;
  } catch (err) {
    const reason = `file-protection core unavailable at ${fpPath}: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[codex-hook] ${reason} — denying protected edits (fail-closed)`);
    return { ok: false, reason };
  }
  const invalid = validateFileProtectionCore(mod);
  if (invalid) {
    const reason = `file-protection core malformed at ${fpPath}: ${invalid}`;
    console.error(`[codex-hook] ${reason} — denying protected edits (fail-closed)`);
    return { ok: false, reason };
  }
  return { ok: true, core: mod as unknown as FileProtectionCore };
}

/** A missing, malformed or throwing core denies every edit tool (per FALLBACK_EDIT_TOOLS) rather than allowing. */
async function runFileProtection(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<ReturnType<typeof denyDecision> | null> {
  if (process.env.SKIP_FILE_PROTECTION === '1') return null;

  const loaded = await loadFileProtectionCore();
  if (!loaded.ok) {
    if (!FALLBACK_EDIT_TOOLS.has(toolName)) return null;
    return denyDecision(
      `file-protection unavailable (${loaded.reason}) — denying edit to '${(toolInput.file_path ?? toolInput.path ?? toolName) as string}' for safety. Set SKIP_FILE_PROTECTION=1 to bypass.`,
    );
  }

  const core = loaded.core;
  if (!core.EDIT_TOOLS.has(toolName)) return null;
  // `unknown`: the dynamically imported core's return value cannot be trusted to match its type.
  let blocked: unknown;
  try {
    blocked = core.checkEditProtection(toolName, toolInput);
  } catch (err) {
    return denyDecision(
      `file-protection check errored (${err instanceof Error ? err.message : String(err)}) — denying edit for safety. Set SKIP_FILE_PROTECTION=1 to bypass.`,
    );
  }
  // Only null allows; anything other than a non-empty string is malformed and denies.
  if (blocked === null) return null;
  if (typeof blocked === 'string' && blocked.length > 0) {
    return denyDecision(
      `file-protection — '${blocked}' is protected from automated edits. Set SKIP_FILE_PROTECTION=1 to bypass.`,
    );
  }
  return denyDecision(
    `file-protection returned a malformed result (expected a protected-path string or null) — denying edit for safety. Set SKIP_FILE_PROTECTION=1 to bypass.`,
  );
}

/** Stops at the first block or deny, carrying `updatedInput` forward across hooks. */
export async function runPreToolUseChain(input: CodexHookInput): Promise<unknown> {
  const normalized = normalizeCodexHookInput(input);

  // Non-Bash tools also pass through here so the in-flight tracker stays current.
  const first = await preToolUseHook(
    normalized as Parameters<HookCallback>[0],
    {} as Parameters<HookCallback>[1],
    {} as Parameters<HookCallback>[2],
  );
  if ((first as { decision?: string })?.decision === 'block') {
    return first;
  }

  if (normalized.tool_name !== 'Bash') {
    const fpDeny = await runFileProtection(
      normalized.tool_name ?? '',
      (normalized.tool_input ?? {}) as Record<string, unknown>,
    );
    if (fpDeny) return fpDeny;
    return first ?? { continue: true };
  }

  // Rewrite first, so every guardrail after it evaluates the same command text.
  const chain: HookCallback[] = [
    createBashCommandRewriteHook(),
    createManagedGitMaintenanceHook(),
    createSelfApprovalBlockHook(),
    createBlockSnowflakeConnectorHook(),
    createBlockGitCloneHook(),
    // The only caller that arms the shared approval claim: the plugin adapter gates the same tool call.
    createEmailGateHook({ sharedApprovalClaim: true }),
  ];
  let currentInput: CodexHookInput = normalized;
  let mergedUpdatedInput: Record<string, unknown> | undefined;

  for (const hook of chain) {
    let out: Awaited<ReturnType<HookCallback>>;
    try {
      out = await hook(
        currentInput as Parameters<HookCallback>[0],
        {} as Parameters<HookCallback>[1],
        {} as Parameters<HookCallback>[2],
      );
    } catch (err) {
      // A throwing guard (e.g. the email gate's session-DB round-trip) must deny here, not escape to the CLI.
      return denyDecision(hookFailureDenyReason('hook chain', err));
    }
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
      mergedUpdatedInput = {
        ...(mergedUpdatedInput ?? currentInput.tool_input),
        ...ret.hookSpecificOutput.updatedInput,
      };
      currentInput = { ...currentInput, tool_input: mergedUpdatedInput };
    }
  }

  // Runs on the rewritten command, after the chain.
  const guardCommand = (currentInput.tool_input as { command?: string } | undefined)?.command ?? '';
  // Keyed on the raw string tool_use_id exactly as codex-guard.ts keys it: any divergence means two cards.
  const toolUseId = typeof normalized.tool_use_id === 'string' ? normalized.tool_use_id : undefined;
  const guardDeny = await runDestructiveGuard(guardCommand, toolUseId);
  if (guardDeny) return guardDeny;

  // No `exec </dev/null` stdin prefix here: nothing shows Codex needs it, and whether Codex honours
  // `updatedInput` on every Bash call is unverified. The Claude side applies it at its own emit point.

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

async function runPostToolUseChain(input: CodexHookInput): Promise<unknown> {
  const normalized = normalizeCodexHookInput(input);

  await postToolUseHook(
    normalized as Parameters<HookCallback>[0],
    {} as Parameters<HookCallback>[1],
    {} as Parameters<HookCallback>[2],
  );

  return { continue: true };
}

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
