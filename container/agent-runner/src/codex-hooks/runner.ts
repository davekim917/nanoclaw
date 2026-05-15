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
