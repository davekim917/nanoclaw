/**
 * Compatibility seam for the retired per-session worktree autosave. Topic worktrees are shared by siblings, so a
 * callback from one must never stage, commit, or remove index locks: another may be mid-edit.
 */
export interface AutoSaveResult {
  committed: string[];
  skipped: string[];
  failed: string[];
}

export async function autoCommitDirtyWorktrees(
  _reason: string,
  _rootDir = '/workspace/worktrees',
): Promise<AutoSaveResult> {
  return { committed: [], skipped: [], failed: [] };
}
