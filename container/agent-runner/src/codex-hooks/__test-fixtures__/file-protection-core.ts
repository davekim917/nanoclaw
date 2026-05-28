/**
 * Test stub mirroring file-protection-core.ts's surface (the real core lives in
 * the bootstrap repo; its patterns are validated there). Co-located with
 * guard-core-stub.ts so runner.ts's loadFileProtectionCore (which derives the FP
 * path from the guard-core dir) resolves it. A path containing STUB_PROTECTED is
 * treated as protected.
 */
export const EDIT_TOOLS = new Set([
  'Edit',
  'MultiEdit',
  'Write',
  'apply_patch',
  'edit',
  'write',
  'write_file',
  'create_file',
]);

export function checkEditProtection(
  toolName: string,
  toolInput: Record<string, unknown>,
): string | null {
  if (!EDIT_TOOLS.has(toolName)) return null;
  const p = (toolInput.file_path ?? toolInput.path ?? toolInput.filePath ?? '') as unknown;
  return typeof p === 'string' && p.includes('STUB_PROTECTED') ? p : null;
}
