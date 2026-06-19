/**
 * Throwing file-protection-core fixture: correctly shaped (passes validation)
 * but checkEditProtection throws. runFileProtection must catch the throw and
 * DENY the edit (fail-closed). Sits next to throwing/block-destructive-core.ts.
 */
export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'apply_patch', 'edit', 'write', 'write_file', 'create_file']);
export function checkEditProtection(): string | null {
  throw new Error('STUB-CORE: checkEditProtection boom');
}
