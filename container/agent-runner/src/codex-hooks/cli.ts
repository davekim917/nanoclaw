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
 * Error policy: a malformed-stdin / unknown-event error exits 2 (Codex treats
 * exit 2 as a block). A runtime error from the hook chain FAILS CLOSED for
 * PreToolUse (emits a deny decision) and soft-continues for PostToolUse — see
 * the catch in main().
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
    // Fail CLOSED for PreToolUse (C4): a guard chain that throws must DENY the
    // tool, never silently allow it. A bare `{continue:true}` here is fail-OPEN
    // — Codex treats continue:true + exit 0 as "run the tool", so a thrown guard
    // exception (a malformed core verdict, or an approval-DB failure in the email
    // gate) would let a gated destructive/email action proceed unguarded.
    // PostToolUse is advisory (the tool already ran) → keep it soft so a
    // post-hook error doesn't wedge the session.
    if (eventArg === 'PreToolUse') {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              'BLOCKED: guard hook errored — denying for safety. Report this rather than retrying.',
          },
        }),
      );
      process.exit(0);
    }
    // Soft fail for PostToolUse only.
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }
}

void main();
