/**
 * Compatibility seam for the retired per-session worktree autosave.
 *
 * Topic worktrees are shared by sibling agents. A turn-end or PreCompact
 * callback from one sibling therefore cannot safely stage, commit, or remove
 * index locks: another sibling may be in the middle of an edit or Git command.
 * Dirty topic worktrees are persistent and conservative host cleanup refuses
 * to remove them, so exact working/index state survives without mutation.
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
