/**
 * Malformed file-protection RESULT fixture (codex #126 N3). Exports are valid
 * (EDIT_TOOLS is a Set, checkEditProtection is a function) so validateFileProtectionCore
 * passes — but checkEditProtection RETURNS a falsy non-null (`undefined`) for an
 * edit. runFileProtection must NOT treat that as "allowed" (null); for an EDIT
 * tool a non-(string|null) result is untrusted → DENY.
 *
 * Loaded by runner.ts loadFileProtectionCore (derives this path from the dir of
 * NANOCLAW_DESTRUCTIVE_GUARD_CORE).
 */
export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'apply_patch', 'edit', 'write']);

export function checkEditProtection(
  _toolName: string,
  _toolInput: Record<string, unknown>,
): string | null {
  return undefined as unknown as null; // malformed: falsy but NOT null → must fail closed
}
