export function createBlockMnemonRealHook() {
  return async (input: unknown) => {
    const cmd = (input as { tool_input?: { command?: string } }).tool_input?.command ?? '';
    // Substring match (not word-boundary) so shell-operator-prefixed forms like `;mnemon-real`,
    // `&&mnemon-real`, `(mnemon-real`, and command-substitution `$(...mnemon-real...)` all hit.
    // Defense-in-depth only — cross-tenant access is already prevented by host-side mount
    // narrowing (only the calling group's store data is mounted; cross-store writes fail at
    // the filesystem level even if this regex is bypassed via heavy obfuscation or scripts
    // dropped on disk by the agent).
    if (cmd.includes('mnemon-real')) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason:
            'Use `mnemon` (wrapper). Direct `mnemon-real` invocation is blocked — bypasses phase gating, write-locking, and metering.',
        },
      };
    }
    return {};
  };
}
