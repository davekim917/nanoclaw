const CLAUDE_RTK_HOOK_BLOCK = [
  '## Hook-Based Usage',
  '',
  'All other commands are automatically rewritten by the Claude Code hook.',
  'Example: `git status` → `rtk git status` (transparent, 0 tokens overhead)',
  '',
  'Refer to CLAUDE.md for full command reference.',
].join('\n');

const CODEX_RTK_USAGE_BLOCK = [
  '## Codex Usage',
  '',
  'Codex does not get the Claude Code RTK PreToolUse auto-rewrite hook in this runtime.',
  'Use `rtk` explicitly for shell commands that can produce noisy output.',
  '',
  'Examples:',
  '',
  '```bash',
  'rtk git status',
  'rtk git diff',
  'rtk grep "pattern" .',
  'rtk pnpm test',
  '```',
  '',
  'Use `rtk gain` and `rtk gain --history` directly for savings analytics.',
].join('\n');

/**
 * Claude's global rules include an RTK section written for Claude Code, where
 * `rtk hook claude` transparently rewrites Bash commands. Codex's RTK support
 * is instruction-based (`AGENTS.md` + `RTK.md`), so generated Codex AGENTS.md
 * must not claim automatic Claude hook rewriting.
 */
export function rewriteCodexRtkGuidance(content: string): string {
  return content.replace(CLAUDE_RTK_HOOK_BLOCK, CODEX_RTK_USAGE_BLOCK);
}
