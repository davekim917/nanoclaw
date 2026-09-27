/**
 * Strip every inherited `GIT_*` variable from a test process's environment. git reads its repository location from
 * the environment before the cwd, so an inherited `GIT_DIR` (from `git bisect run` or a hook) points fixture commands
 * at the real checkout, where `git init --bare` writes `core.bare=true`. The whole prefix goes:
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_PARAMETERS` can inject `core.worktree` or `core.bare` as effectively as `GIT_DIR`.
 * A test that wants a `GIT_*` variable sets it on the child it spawns.
 */
export function stripInheritedGitEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed = Object.keys(env).filter((key) => key.startsWith('GIT_'));
  for (const key of removed) delete env[key];
  return removed;
}
