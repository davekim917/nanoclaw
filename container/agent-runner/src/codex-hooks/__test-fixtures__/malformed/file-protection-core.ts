/**
 * Malformed file-protection-core fixture: EDIT_TOOLS is not a Set and
 * checkEditProtection is not a function. loadFileProtectionCore must reject this
 * and runFileProtection must DENY edit-tool calls (fail-closed). Sits next to
 * malformed/block-destructive-core.ts so the runner's dir-derived path resolves
 * here.
 */
export const EDIT_TOOLS = ['Edit', 'Write']; // wrong type (array, not Set)
export const checkEditProtection = 'not-a-function';
