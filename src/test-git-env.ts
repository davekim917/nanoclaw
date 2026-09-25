/**
 * Strip every inherited `GIT_*` variable from a test process's environment.
 *
 * git reads its repository location from the environment before it looks at
 * the working directory, so a variable inherited from whatever launched the
 * test run points every fixture command at a real repository. On 2026-09-25
 * `git bisect run` exported `GIT_DIR` into a vitest run, and
 * `src/migrate-repo-store.test.ts`'s fixture commands wrote `core.bare=true`
 * into the shared checkout's `.git/config` (`git init --bare` run inside a
 * fixture directory does exactly that under an inherited `GIT_DIR`). Git hooks export the same family (`GIT_DIR`, `GIT_INDEX_FILE`,
 * `GIT_WORK_TREE`), so a test run started from a hook is exposed the same way.
 *
 * The whole prefix goes, identity and config variables included: no test reads
 * an inherited one (fixtures that need an identity pass `-c user.*` or set it
 * in their own child env), and `GIT_CONFIG_COUNT`/`GIT_CONFIG_PARAMETERS` can
 * inject `core.worktree` or `core.bare` as effectively as `GIT_DIR` can.
 * A test that wants a `GIT_*` variable sets it on the child it spawns.
 */
export function stripInheritedGitEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed = Object.keys(env).filter((key) => key.startsWith('GIT_'));
  for (const key of removed) delete env[key];
  return removed;
}
