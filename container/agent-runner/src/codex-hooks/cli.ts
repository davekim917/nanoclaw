#!/usr/bin/env bun
/**
 * Malformed stdin or an unknown event exits 2, which Codex treats as a block. A hook-chain error denies
 * PreToolUse and soft-continues PostToolUse.
 */
// Module barrel — loads registration modules, including the singular mailbox slot.
import '../modules/index.js';
import { getAgentMailbox, readMailboxContext } from '../mailbox/index.js';
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
    // Separate process from the runner: without its own mailbox the email gate throws, denying every gated command.
    await getAgentMailbox().start(await readMailboxContext());
    const result = await runHookForCodex(eventArg as HookEvent, input);
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    process.stderr.write(`[codex-hook] runtime error in ${eventArg}: ${err instanceof Error ? err.message : String(err)}\n`);
    // Fail closed: Codex runs the tool on continue:true + exit 0, so a throwing PreToolUse guard must deny.
    // PostToolUse is advisory (the tool already ran), so it stays soft rather than wedging the session.
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
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }
}

void main();
