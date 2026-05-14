#!/usr/bin/env bun
/**
 * Codex hook CLI entry-point. Invoked as a subprocess by the Codex
 * app-server via ~/.codex/hooks.json entries:
 *
 *   "command": "bun /app/agent-runner/codex-hooks/cli.js PreToolUse"
 *
 * Reads JSON from stdin, dispatches to the appropriate hook chain in
 * `./runner.ts`, writes the decision JSON to stdout, exits 0.
 *
 * On parse / runtime error, writes a diagnostic to stderr and exits
 * non-zero — Codex treats hook failure as soft (does not block the tool).
 */
import { runHookForCodex, type HookEvent, type CodexHookInput } from './runner.js';

async function main(): Promise<void> {
  const eventArg = process.argv[2];
  if (eventArg !== 'PreToolUse' && eventArg !== 'PostToolUse' && eventArg !== 'PostToolUseFailure') {
    process.stderr.write(`[codex-hook] unknown event: ${eventArg ?? '(none)'}\n`);
    process.exit(2);
  }

  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) {
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  let input: CodexHookInput;
  try {
    input = JSON.parse(raw) as CodexHookInput;
  } catch (err) {
    process.stderr.write(`[codex-hook] invalid stdin JSON: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }

  try {
    const result = await runHookForCodex(eventArg as HookEvent, input);
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    process.stderr.write(`[codex-hook] runtime error in ${eventArg}: ${err instanceof Error ? err.message : String(err)}\n`);
    // Soft fail: don't block the tool call on hook error.
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }
}

void main();
