/**
 * An installer must never name the remote a registry branch (`channels`,
 * `providers`) comes from: `setup/lib/channels-remote.sh` resolves it, and a
 * fork's own copy of the branch can be months stale.
 *
 * Fail closed rather than parse git's option grammar: on any line that runs
 * git, every mention of a registry branch must sit right after a variable
 * (`$remote`, `${remote}`) or the resolver call, whatever else the line holds.
 * A false positive is fixed the same way as a real one.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALLER_ROOTS = ['.claude/skills', 'container/skills', 'setup', 'scripts'];
const INSTALLER_FILE = /\.(?:md|sh|[cm]?[jt]s)$/;
const TEST_FILE = /\.test\.[cm]?[jt]s$/;
const RESOLVER = 'setup/lib/channels-remote.sh';

const RUNS_GIT = /(?:^|[\s`'"(;|&{])git\s+\S/;
/** `channels`/`providers` as a branch argument or a ref's branch part, not as a path directory or part of a word. */
const REGISTRY_BRANCH = /(?<![\w.-])(?:channels|providers)(?=$|[\s:'"`),;])/g;
/**
 * Registry placeholders in the two shapes a registry install takes: any `<…>` as a ref's branch
 * read for a file (`origin/<branch>:<path>`), and `<branch>` as a fetch argument (other fetch
 * placeholders such as `<sha>` or `<bundle>` are not branches).
 */
const PLACEHOLDER_REF = /(?<=\/)<[\w-]+>(?=:)/g;
const PLACEHOLDER_FETCHED = /(?<=\s)<branch>(?=$|[\s'"`),;])/g;
/**
 * What must directly precede a branch mention: a variable, the resolver call, or the `<remote>`
 * placeholder a skill binds to the resolver's answer, then `/` or whitespace (other branch names may
 * sit between).
 */
const REMOTE_FROM_VARIABLE =
  /(?:\$\{?\w+\}?|\$\(resolve_channels_remote\)|<remote>)["']?(?:\/|(?:\s+(?:channels|providers|<[\w-]+>))*\s+)["']?$/;

function hardCodesRegistryRemote(line: string): boolean {
  if (!RUNS_GIT.test(line)) return false;
  const mentions = [
    ...line.matchAll(REGISTRY_BRANCH),
    ...line.matchAll(PLACEHOLDER_REF),
    ...(/\bfetch\b/.test(line) ? line.matchAll(PLACEHOLDER_FETCHED) : []),
  ];
  return mentions.some((match) => match[0] !== '<remote>' && !REMOTE_FROM_VARIABLE.test(line.slice(0, match.index)));
}

function installerFiles(rel: string): string[] {
  const abs = path.join(REPO_ROOT, rel);
  const stat = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink()) return [];
  if (stat.isDirectory()) {
    return fs
      .readdirSync(abs)
      .filter((name) => name !== 'node_modules')
      .flatMap((name) => installerFiles(path.posix.join(rel, name)));
  }
  if (!INSTALLER_FILE.test(rel) || TEST_FILE.test(rel) || rel === RESOLVER) return [];
  return [rel];
}

describe('installers take the registry remote from the resolver', () => {
  it('rejects a literal remote in every git form, whatever the option order', () => {
    for (const line of [
      'git fetch origin channels',
      'git fetch upstream channels',
      'git fetch --prune origin channels',
      'git fetch origin channels providers --prune',
      'git fetch --depth 1 origin channels',
      'git fetch --depth=1 upstream main providers',
      'git fetch --upload-pack /tmp/git-upload-pack upstream providers',
      'git -C "$root" fetch --depth=1 upstream main providers',
      'git show origin/channels:src/channels/github.ts > src/channels/github.ts',
      'git show upstream/channels:src/channels/deltachat.ts > src/channels/deltachat.ts',
      'git show upstream/providers:src/providers/codex.ts',
      'git cat-file -e origin/channels:src/channels/x.ts',
      'git archive upstream/providers src/providers',
      'git checkout -B channels origin/channels',
      "execSync('git fetch origin channels')",
      '`git show origin/channels:<path> > <path>`',
      'run its `git fetch origin <branch>`, write its files with `git show origin/<branch>:path > $WORKTREE/path`',
      'diff <(git show origin/<branch>:<path>) <path>',
      'git fetch upstream <branch>',
    ]) {
      expect(hardCodesRegistryRemote(line), line).toBe(true);
    }
  });

  it('accepts a remote from a variable or the resolver', () => {
    for (const line of [
      'git fetch "$remote" channels',
      'git fetch --depth 1 "$remote" channels',
      'git show "$remote/channels:src/channels/emacs.ts" > src/channels/emacs.ts',
      "git fetch '$remote' providers",
      'git fetch ${remote} channels',
      'git show ${remote}/providers:src/providers/opencode.ts',
      'git fetch "$(resolve_channels_remote)" channels',
      'git fetch "$remote" channels providers --prune',
      'await exec(`git fetch ${remote} ${b}`);',
      'git add src/channels/index.ts src/providers/index.ts',
      'git diff -- src/channels/',
      'git fetch origin main',
      'cmp -s <(git show <remote>/<branch>:<path>) <path>',
      'git fetch "$remote" <branch>',
      'git merge upstream/<branch>',
      'git checkout upstream/<branch> -- .claude/skills/migrate-nanoclaw/',
      'git show upstream/main:package.json',
      'git diff $BASE..HEAD -- <file>',
      'Fetch the `channels` branch from the resolved remote.',
    ]) {
      expect(hardCodesRegistryRemote(line), line).toBe(false);
    }
  });

  it('no installer names the remote a registry branch comes from', () => {
    const offenders = INSTALLER_ROOTS.flatMap(installerFiles).flatMap((rel) =>
      fs
        .readFileSync(path.join(REPO_ROOT, rel), 'utf8')
        .split('\n')
        .flatMap((line, i) => (hardCodesRegistryRemote(line) ? [`${rel}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(offenders, `source ${RESOLVER} and use "$(resolve_channels_remote)" as the remote`).toEqual([]);
  });
});
