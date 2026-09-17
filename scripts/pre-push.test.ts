import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const linkedWorktrees: Array<{ main: string; root: string }> = [];
const zeroSha = '0000000000000000000000000000000000000000';
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const realTsx = path.resolve('node_modules/.bin/tsx');

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-push-'));
  roots.push(root);
  return root;
}

function runGit(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function writeExecutable(file: string, source: string): void {
  fs.writeFileSync(file, source);
  fs.chmodSync(file, 0o755);
}

function linkSystemCommand(bin: string, command: string): void {
  const executable = execFileSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).trim();
  fs.symlinkSync(executable, path.join(bin, command));
}

function commit(root: string, value: string, message = value): string {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'gate.ts'), `${value}\n`);
  fs.writeFileSync(path.join(root, 'scripts', 'gate.ts'), `${value}\n`);
  runGit(root, ['add', '.public-boundary-allowlist.json', 'src/gate.ts', 'scripts/gate.ts']);
  runGit(root, ['commit', '-m', message, '--quiet']);
  return runGit(root, ['rev-parse', 'HEAD']);
}

// Like commit(), but the resulting commit's own tree carries no
// .public-boundary-allowlist.json — modeling a ref whose history never
// introduced the file (the long-lived channels/providers sibling branches,
// most local tags). --cached only: the file stays on disk so it does not
// disturb any later ordinary commit() call in the same fixture.
function commitWithoutAllowlist(root: string, value: string, message = value): string {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'gate.ts'), `${value}\n`);
  fs.writeFileSync(path.join(root, 'scripts', 'gate.ts'), `${value}\n`);
  runGit(root, ['add', 'src/gate.ts', 'scripts/gate.ts']);
  runGit(root, ['rm', '--cached', '--quiet', '.public-boundary-allowlist.json']);
  runGit(root, ['commit', '-m', message, '--quiet']);
  return runGit(root, ['rev-parse', 'HEAD']);
}

function fixture(objectFormat?: 'sha256'): { root: string; hook: string; log: string; bin: string } {
  const root = tempRoot();
  runGit(root, objectFormat ? ['init', `--object-format=${objectFormat}`, '--quiet'] : ['init', '--quiet']);
  runGit(root, ['config', 'user.email', 'test@example.invalid']);
  runGit(root, ['config', 'user.name', 'Hook Test']);
  fs.mkdirSync(path.join(root, '.nanoclaw'), { recursive: true });
  // Install inventory stays untracked; snapshots resolve it from their common checkout.
  fs.writeFileSync(path.join(root, '.nanoclaw', 'public-boundary-identifiers'), 'Private Customer\n');
  fs.writeFileSync(path.join(root, '.public-boundary-allowlist.json'), '{"entries": []}\n');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.symlinkSync(
    new URL('../scripts/check-public-boundary.ts', import.meta.url),
    path.join(root, 'scripts', 'check-public-boundary.ts'),
  );
  const hook = path.join(root, '.husky', 'pre-push');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.copyFileSync(new URL('../.husky/pre-push', import.meta.url), hook);

  const bin = path.join(root, 'bin');
  const modules = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(modules, { recursive: true });
  writeExecutable(
    path.join(bin, 'pnpm'),
    `#!/bin/sh
while [ "$1" != "--root" ]; do shift; done
root=$2
IFS= read -r consumed || true
value=$(git -C "$root" show :src/gate.ts) || exit 1
printf 'boundary|%s|%s|%s\\n' "$root" "$value" "$consumed" >> "$HOOK_LOG"
[ "\${HOOK_FAIL:-}" != "boundary:$value" ] || exit 1
if [ "\${HOOK_CHECK_TREE:-}" = 1 ]; then
  exec "$HOOK_REAL_TSX" "$HOOK_REAL_CHECKER" "$@"
fi
`,
  );
  writeExecutable(
    path.join(modules, 'tsx'),
    `#!/bin/sh
printf 'message|%s|\\n' "$*" >> "$HOOK_LOG"
script=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$1")
shift
exec "$HOOK_REAL_TSX" "$script" "$@"
`,
  );
  writeExecutable(
    path.join(bin, 'git'),
    `#!/bin/sh
if [ "$1" = -C ] && [ "$3" = ls-remote ]; then shift 2; fi
if [ "$1" = ls-remote ] && [ "$2" = --get-url ]; then
  # HOOK_GET_URL_FAILS simulates --get-url itself failing (nonzero exit, no
  # output) — distinct from HOOK_GET_URL, which simulates a successful
  # resolution to a different URL.
  [ "\${HOOK_GET_URL_FAILS:-}" != 1 ] || exit 1
  # Default: echo the URL back unchanged (no fetch-side rewrite in play).
  # HOOK_GET_URL overrides it to simulate insteadOf resolving elsewhere.
  printf '%s\\n' "\${HOOK_GET_URL:-$3}"
  exit 0
fi
if [ "$1" = ls-remote ]; then
  if [ "\${HOOK_LS_REMOTE_FAIL_AFTER_OUTPUT:-}" = 1 ]; then
    # Simulates a real ls-remote that prints partial refs and THEN fails —
    # the hook must not trust anything written to the redirected file once
    # the command's own exit status says it failed.
    printf '%s' "\${HOOK_REMOTE_REFS:-}"
    exit 1
  fi
  [ "\${HOOK_LS_REMOTE_FAIL:-}" != 1 ] || exit 1
  case "\${HOOK_REQUIRE_CONFIG:-}" in
    count) [ "\${GIT_CONFIG_COUNT:-}" = 1 ] || exit 1 ;;
    parameters) [ "$("$HOOK_REAL_GIT" config --get hook.prepushprobe)" = parameters ] || exit 1 ;;
  esac
  printf '%s' "\${HOOK_REMOTE_REFS:-}"
  exit 0
fi
exec "$HOOK_REAL_GIT" "$@"
`,
  );
  // No eslint or tsc fake: the hook no longer runs either. CI owns typecheck
  // (.github/workflows/ci.yml, `typecheck` job) and the nightly owns lint
  // (ci-full.yml; the author lints before pushing); this hook carries only
  // the public-boundary check, which CI cannot run against the identifier
  // registry.
  const hooks = path.join(root, 'hooks');
  fs.mkdirSync(hooks);
  writeExecutable(path.join(hooks, 'post-checkout'), '#!/bin/sh\ntouch "$HOOK_POST_CHECKOUT"\n');
  runGit(root, ['config', 'core.hooksPath', hooks]);
  return { root, hook, log: path.join(root, 'hook.log'), bin };
}

function push(
  f: ReturnType<typeof fixture>,
  refs: string,
  options: {
    fail?: string;
    remoteRefs?: string;
    remoteFailure?: boolean;
    lsRemoteFailAfterOutput?: boolean;
    getUrl?: string;
    getUrlFails?: boolean;
    sourceGitEnv?: boolean;
    commandScopedConfig?: 'count' | 'parameters';
    withoutIonice?: boolean;
    realTreeCheck?: boolean;
    allowMainPush?: boolean;
  } = {},
) {
  if (options.withoutIonice) {
    for (const command of ['dirname', 'mktemp', 'rm', 'rmdir', 'ln', 'grep', 'cat', 'node', 'sed', 'awk', 'uname']) {
      linkSystemCommand(f.bin, command);
    }
    writeExecutable(
      path.join(f.bin, 'nice'),
      `#!/bin/sh
printf 'nice\\n' >> "$HOOK_LOG"
[ "$1" = -n ] && shift 2
exec "$@"
`,
    );
  }
  return spawnSync('/bin/sh', [f.hook, 'origin', 'test://origin'], {
    cwd: f.root,
    encoding: 'utf8',
    input: refs,
    env: {
      ...process.env,
      PATH: options.withoutIonice ? f.bin : `${f.bin}:${process.env.PATH}`,
      HOOK_LOG: f.log,
      HOOK_POST_CHECKOUT: path.join(f.root, 'post-checkout-ran'),
      TMPDIR: f.root,
      HOOK_FAIL: options.fail ?? '',
      HOOK_REMOTE_REFS: options.remoteRefs ?? '',
      HOOK_LS_REMOTE_FAIL: options.remoteFailure ? '1' : '',
      HOOK_LS_REMOTE_FAIL_AFTER_OUTPUT: options.lsRemoteFailAfterOutput ? '1' : '',
      HOOK_GET_URL: options.getUrl ?? '',
      HOOK_GET_URL_FAILS: options.getUrlFails ? '1' : '',
      HOOK_REQUIRE_CONFIG: options.commandScopedConfig ?? '',
      HOOK_REAL_GIT: realGit,
      HOOK_REAL_TSX: realTsx,
      HOOK_REAL_CHECKER: fileURLToPath(new URL('./check-public-boundary.ts', import.meta.url)),
      HOOK_CHECK_TREE: options.realTreeCheck ? '1' : '',
      NANOCLAW_ALLOW_MAIN_PUSH: options.allowMainPush ? '1' : '',
      ...(options.sourceGitEnv ? { GIT_DIR: path.join(f.root, '.git'), GIT_WORK_TREE: f.root } : {}),
      ...(options.commandScopedConfig === 'count'
        ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Hook Test' }
        : {}),
      ...(options.commandScopedConfig === 'parameters'
        ? { GIT_CONFIG_PARAMETERS: "'hook.prepushprobe=parameters'" }
        : {}),
    },
  });
}

function records(log: string): string[] {
  return fs.readFileSync(log, 'utf8').trim().split('\n');
}

afterEach(() => {
  for (const worktree of linkedWorktrees.splice(0)) {
    fs.rmSync(path.join(worktree.root, '.husky'), { recursive: true, force: true });
    fs.rmSync(path.join(worktree.root, 'hook.log'), { force: true });
    fs.rmSync(path.join(worktree.root, 'scripts', 'check-public-boundary.ts'), { force: true });
    runGit(worktree.root, ['clean', '-fd']);
    runGit(worktree.main, ['worktree', 'remove', worktree.root]);
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('.husky/pre-push', () => {
  it('refuses a push to main before scanning anything', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    const pushed = commit(f.root, 'direct-to-main');
    const result = push(f, `refs/heads/main ${pushed} refs/heads/main ${base}\n`, {
      remoteRefs: `${base}\trefs/heads/main\n`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing to push to main');
    expect(fs.existsSync(f.log)).toBe(false);
  });

  it('refuses deleting main', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    const result = push(f, `(delete) ${zeroSha} refs/heads/main ${base}\n`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing to push to main');
  });

  it('does not name its own bypass in the refusal message', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    const pushed = commit(f.root, 'direct-to-main-again');
    const result = push(f, `refs/heads/main ${pushed} refs/heads/main ${base}\n`, {
      remoteRefs: `${base}\trefs/heads/main\n`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing to push to main');
    expect(result.stderr).not.toContain('NANOCLAW_ALLOW_MAIN_PUSH');
  });

  it('lets an emergency main push through with NANOCLAW_ALLOW_MAIN_PUSH=1, and still scans it', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    const pushed = commit(f.root, 'emergency-fix');
    const result = push(f, `refs/heads/main ${pushed} refs/heads/main ${base}\n`, {
      allowMainPush: true,
      fail: 'boundary:emergency-fix',
      remoteRefs: `${base}\trefs/heads/main\n`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('refusing to push to main');
    expect(records(f.log).join('\n')).toContain('emergency-fix');
  });

  it('does not refuse a local main pushed to another branch name', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    const pushed = commit(f.root, 'main-to-branch');
    const result = push(f, `refs/heads/main ${pushed} refs/heads/feature ${zeroSha}\n`, {
      remoteRefs: `${base}\trefs/heads/main\n`,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(records(f.log).join('\n')).toContain('main-to-branch');
  });

  it('gates every pushed SHA, not dirty files, and skips deletions', () => {
    const f = fixture();
    const first = commit(f.root, 'first-pushed');
    runGit(f.root, ['branch', 'first-pushed', first]);
    const second = commit(f.root, 'second-pushed');
    fs.writeFileSync(path.join(f.root, 'src', 'gate.ts'), 'dirty-worktree\n');

    const result = push(
      f,
      [
        `refs/heads/first-pushed ${first} refs/heads/first-pushed ${zeroSha}`,
        `refs/heads/deleted ${zeroSha} refs/heads/deleted ${first}`,
        `refs/heads/current ${second} refs/heads/current ${zeroSha}`,
      ].join('\n') + '\n',
    );

    expect(result.status).toBe(0);
    // Two gates per pushed commit — the commit-message scan and the boundary
    // check — across the two non-deletion refs.
    expect(records(f.log)).toHaveLength(4);
    expect(records(f.log).join('\n')).toContain('first-pushed');
    expect(records(f.log).join('\n')).toContain('second-pushed');
    expect(records(f.log).join('\n')).not.toContain('dirty-worktree');
    const snapshotRecords = records(f.log).filter((record) => /^boundary\|/.test(record));
    expect(snapshotRecords.every((record) => record.endsWith('|'))).toBe(true);
    for (const record of snapshotRecords) {
      const snapshot = record.split('|')[1];
      expect(fs.existsSync(snapshot)).toBe(false);
      expect(fs.existsSync(path.dirname(snapshot))).toBe(false);
    }
    expect(fs.existsSync(path.join(f.root, 'post-checkout-ran'))).toBe(false);
  });

  it('rejects a non-HEAD snapshot when the boundary check finds a violation', () => {
    const f = fixture();
    const rejected = commit(f.root, 'rejected-push');
    runGit(f.root, ['branch', 'rejected-push', rejected]);
    commit(f.root, 'clean-head');
    fs.writeFileSync(path.join(f.root, 'src', 'gate.ts'), 'dirty-clean\n');
    const result = push(f, `refs/heads/rejected-push ${rejected} refs/heads/rejected-push ${zeroSha}\n`, {
      fail: 'boundary:rejected-push',
    });

    expect(result.status).toBe(1);
    expect(records(f.log).join('\n')).toContain('rejected-push');
    expect(records(f.log).join('\n')).not.toContain('clean-head');
    expect(records(f.log).join('\n')).not.toContain('dirty-clean');
    expect(records(f.log)).toHaveLength(2);
    const snapshot = records(f.log)
      .find((record) => record.startsWith('boundary|'))
      ?.split('|')[1];
    expect(snapshot).toBeDefined();
    if (!snapshot) throw new Error('boundary gate did not record a snapshot');
    expect(fs.existsSync(snapshot)).toBe(false);
    expect(fs.existsSync(path.dirname(snapshot))).toBe(false);
    expect(runGit(f.root, ['worktree', 'list', '--porcelain'])).not.toContain(snapshot);
  });

  it('rejects an intermediate commit in an existing ref update', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    commit(f.root, 'intermediate-violation');
    const cleanTip = commit(f.root, 'clean-tip');
    const result = push(f, `refs/heads/current ${cleanTip} refs/heads/current ${base}\n`, {
      fail: 'boundary:intermediate-violation',
    });

    expect(result.status).toBe(1);
    expect(records(f.log).join('\n')).toContain('clean-tip');
    expect(records(f.log).join('\n')).toContain('intermediate-violation');
  });

  it('deduplicates overlapping and force-pushed ref ranges', () => {
    const f = fixture();
    const base = commit(f.root, 'base');
    const pushed = commit(f.root, 'shared-push');
    runGit(f.root, ['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', base, '--quiet']);
    const remoteOld = commit(f.root, 'remote-old');
    runGit(f.root, ['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', pushed, '--quiet']);
    const result = push(
      f,
      [
        `refs/heads/first ${pushed} refs/heads/first ${base}`,
        `refs/heads/force ${pushed} refs/heads/force ${remoteOld}`,
        `refs/heads/deleted ${zeroSha} refs/heads/deleted ${base}`,
      ].join('\n') + '\n',
    );

    expect(result.status).toBe(0);
    // The same commit is reachable from both pushed refs; `seen_objects` must
    // make the snapshot gate run over it exactly once, not once per ref.
    expect(
      records(f.log).filter((record) => record.startsWith('boundary|') && record.includes('shared-push')),
    ).toHaveLength(1);
  });

  it('gates local-only history on a new ref against live advertised tips', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    const localOnly = commit(f.root, 'local-only');
    runGit(f.root, ['branch', 'local-only', localOnly]);
    const pushed = commit(f.root, 'new-ref-tip');
    const result = push(f, `refs/heads/new ${pushed} refs/heads/new ${zeroSha}\n`, {
      fail: 'boundary:local-only',
      remoteRefs: `${base}\trefs/heads/main\n`,
    });

    expect(result.status).toBe(1);
    expect(records(f.log).join('\n')).toContain('new-ref-tip');
    expect(records(f.log).join('\n')).toContain('local-only');
    expect(records(f.log).join('\n')).not.toContain('remote-base');
  });

  it('uses locally known advertised tips when the remote baseline is missing', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    const pushed = commit(f.root, 'missing-baseline-push');
    const missingRemote = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const result = push(f, `refs/heads/current ${pushed} refs/heads/current ${missingRemote}\n`, {
      fail: 'boundary:missing-baseline-push',
      remoteRefs: `${base}\trefs/heads/main\n`,
    });

    expect(result.status).toBe(1);
    expect(records(f.log).join('\n')).toContain('missing-baseline-push');
    expect(records(f.log).join('\n')).not.toContain('remote-base');
  });

  it('excludes a commit already reachable via a known remote tip, even for an existing ref whose own remote_sha predates it', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    // Already published to origin via `main` (advertised below), but NOT an
    // ancestor of this ref's own remote_sha — exactly what a branch merging
    // (or rebasing onto) a newer main looks like.
    const publishedViaMain = commit(f.root, 'already-on-main');
    const pushed = commit(f.root, 'new-on-branch');
    const result = push(f, `refs/heads/current ${pushed} refs/heads/current ${base}\n`, {
      fail: 'boundary:already-on-main',
      remoteRefs: `${publishedViaMain}\trefs/heads/main\n`,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(records(f.log).join('\n')).toContain('new-on-branch');
    expect(records(f.log).join('\n')).not.toContain('already-on-main');
  });

  it('still scans a genuinely new commit on that same existing-ref push', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    const publishedViaMain = commit(f.root, 'clean-on-main');
    const pushed = commit(f.root, 'flagged-new-work');
    const result = push(f, `refs/heads/current ${pushed} refs/heads/current ${base}\n`, {
      fail: 'boundary:flagged-new-work',
      remoteRefs: `${publishedViaMain}\trefs/heads/main\n`,
    });

    expect(result.status).toBe(1);
    expect(records(f.log).join('\n')).toContain('flagged-new-work');
  });

  it('falls back to the old remote_sha..local_sha range, and still scans it, when ls-remote fails on an existing-ref push', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    const pushed = commit(f.root, 'flagged-in-fallback-range');
    const result = push(f, `refs/heads/current ${pushed} refs/heads/current ${base}\n`, {
      fail: 'boundary:flagged-in-fallback-range',
      remoteFailure: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('falling back to each ref');
    expect(records(f.log).join('\n')).toContain('flagged-in-fallback-range');
  });

  it('leaves a new-ref push unaffected by the always-on ls-remote lookup', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    const pushed = commit(f.root, 'new-ref-push');
    const result = push(f, `refs/heads/new ${pushed} refs/heads/new ${zeroSha}\n`, {
      fail: 'boundary:new-ref-push',
      remoteRefs: `${base}\trefs/heads/main\n`,
    });

    expect(result.status).toBe(1);
    expect(records(f.log).join('\n')).toContain('new-ref-push');
    expect(records(f.log).join('\n')).not.toContain('remote-base');
  });

  it('drops an advertised tip unknown locally instead of trusting the batch lookup line for it', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    const pushed = commit(f.root, 'existing-ref-with-unknown-sibling-tip');
    // A real remote routinely advertises tips this clone has never fetched
    // (81 of origin's 740, per #612) — here, a sibling ref pointing at a SHA
    // this repo has no object for. If the batch cat-file miss for it ever
    // leaked into known_remote_tips, it would be handed to `rev-list --not`
    // as a bogus revision and the push would die with a git error instead of
    // scanning anything.
    const unknownTip = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const result = push(f, `refs/heads/current ${pushed} refs/heads/current ${base}\n`, {
      fail: 'boundary:existing-ref-with-unknown-sibling-tip',
      remoteRefs: `${base}\trefs/heads/current\n${unknownTip}\trefs/heads/other\n`,
    });

    expect(result.status).toBe(1);
    expect(records(f.log).join('\n')).toContain('existing-ref-with-unknown-sibling-tip');
  });

  it('refuses to trust ls-remote once fetch-side URL rewriting is detected, for an existing ref', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    // If the hook trusted a rewritten (mirror) ls-remote, this tip would be
    // reported as already known and would wrongly exclude the flagged
    // commit below — exactly the false negative a mirror-vs-push-target
    // mismatch produces against a real remote.
    const wouldBeTrustedTip = commit(f.root, 'already-on-main');
    const pushed = commit(f.root, 'new-on-branch');
    const result = push(f, `refs/heads/current ${pushed} refs/heads/current ${base}\n`, {
      fail: 'boundary:already-on-main',
      remoteRefs: `${wouldBeTrustedTip}\trefs/heads/main\n`,
      getUrl: 'https://internal-mirror.invalid/nanoclaw.git',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fetch-side URL rewriting');
    expect(records(f.log).join('\n')).toContain('already-on-main');
  });

  it('refuses to trust ls-remote once fetch-side URL rewriting is detected, for a new ref', () => {
    const f = fixture();
    const pushed = commit(f.root, 'new-ref-under-rewrite');
    const result = push(f, `refs/heads/new ${pushed} refs/heads/new ${zeroSha}\n`, {
      getUrl: 'https://internal-mirror.invalid/nanoclaw.git',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fetch-side URL rewriting');
  });

  it('takes the same fail-closed branch when --get-url itself fails, for an existing ref', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    // If the hook trusted a fetch-side lookup it never actually validated
    // against the push target, this tip would wrongly be treated as known
    // and would exclude the flagged commit below.
    const wouldBeTrustedTip = commit(f.root, 'already-on-main-get-url-fails');
    const pushed = commit(f.root, 'new-on-branch-get-url-fails');
    const result = push(f, `refs/heads/current ${pushed} refs/heads/current ${base}\n`, {
      fail: 'boundary:already-on-main-get-url-fails',
      remoteRefs: `${wouldBeTrustedTip}\trefs/heads/main\n`,
      getUrlFails: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fetch-side URL rewriting');
    expect(records(f.log).join('\n')).toContain('already-on-main-get-url-fails');
  });

  it('takes the same fail-closed branch when --get-url itself fails, for a new ref', () => {
    const f = fixture();
    const pushed = commit(f.root, 'new-ref-get-url-fails');
    const result = push(f, `refs/heads/new ${pushed} refs/heads/new ${zeroSha}\n`, {
      getUrlFails: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fetch-side URL rewriting');
  });

  it('never trusts stdout from a failed ls-remote, even when it printed refs before failing', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    // If this printed-then-failed tip were trusted, it would wrongly exclude
    // the flagged commit below (it IS the flagged commit's own SHA).
    const pushed = commit(f.root, 'flagged-despite-printed-tip');
    const result = push(f, `refs/heads/current ${pushed} refs/heads/current ${base}\n`, {
      fail: 'boundary:flagged-despite-printed-tip',
      remoteRefs: `${pushed}\trefs/heads/main\n`,
      lsRemoteFailAfterOutput: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('falling back to each ref');
    expect(records(f.log).join('\n')).toContain('flagged-despite-printed-tip');
  });

  it('fails closed for an existing ref whose remote_sha is unknown locally when ls-remote fails', () => {
    const f = fixture();
    const pushed = commit(f.root, 'unknown-baseline-push');
    const missingRemote = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const result = push(f, `refs/heads/current ${pushed} refs/heads/current ${missingRemote}\n`, {
      remoteFailure: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed to list advertised refs');
    expect(fs.existsSync(f.log)).toBe(false);
  });

  it('fails closed when live advertised refs cannot be listed', () => {
    const f = fixture();
    const pushed = commit(f.root, 'new-ref');
    const result = push(f, `refs/heads/new ${pushed} refs/heads/new ${zeroSha}\n`, { remoteFailure: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed to list advertised refs');
    expect(fs.existsSync(f.log)).toBe(false);
  });

  it.each(['count', 'parameters'] as const)(
    'preserves GIT_CONFIG_%s while listing live refs',
    (commandScopedConfig) => {
      const f = fixture();
      const base = commit(f.root, 'remote-base');
      const pushed = commit(f.root, 'configured-new-ref');
      const result = push(f, `refs/heads/new ${pushed} refs/heads/new ${zeroSha}\n`, {
        remoteRefs: `${base}\trefs/heads/main\n`,
        commandScopedConfig,
      });

      expect(result.status).toBe(0);
      expect(records(f.log).join('\n')).toContain('configured-new-ref');
    },
  );

  it.each([
    ['tree', 'Private Customer', 'clean message', 'boundary:Private Customer'],
    ['message', 'clean-original', 'fix: Private Customer', undefined],
  ] as const)('gates the original replaced commit %s', (_surface, originalValue, originalMessage, fail) => {
    const f = fixture();
    const base = commit(f.root, 'base');
    const original = commit(f.root, originalValue, originalMessage);
    runGit(f.root, ['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', base, '--quiet']);
    const replacement = commit(f.root, 'clean-replacement', 'clean replacement');
    runGit(f.root, ['replace', original, replacement]);

    const result = push(f, `refs/heads/current ${original} refs/heads/current ${zeroSha}\n`, { fail });

    expect(result.status).toBe(1);
    if (fail) {
      expect(records(f.log).join('\n')).toContain('Private Customer');
      expect(records(f.log).join('\n')).not.toContain('clean-replacement');
    } else {
      expect(result.stderr).toContain('private-identifier');
    }
  });

  it.each([false, true])(
    'rejects a private annotated tag even when its commit is already remote (nested=%s)',
    (nested) => {
      const f = fixture();
      const base = commit(f.root, 'remote-base');
      runGit(f.root, [
        'tag',
        '-a',
        'synthetic-inner',
        '--cleanup=verbatim',
        '-m',
        'clean first paragraph\n\n# Private Customer annotation',
        base,
      ]);
      if (nested)
        runGit(f.root, [
          '-c',
          'advice.nestedTag=false',
          'tag',
          '-a',
          'synthetic-outer',
          '-m',
          'clean annotation',
          'synthetic-inner',
        ]);
      const tag = runGit(f.root, ['rev-parse', nested ? 'synthetic-outer' : 'synthetic-inner']);
      const result = push(f, `refs/tags/release ${tag} refs/tags/release ${zeroSha}\n`, {
        remoteRefs: `${base}\trefs/heads/main\n`,
      });

      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('TAG_EDITMSG:');
      expect(result.stderr).toContain('private-identifier');
      expect(fs.readdirSync(f.root).some((name) => name.startsWith('nanoclaw-pre-push.'))).toBe(false);
    },
  );

  it('accepts an annotation with a tagger outside the synthetic email exemptions', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    // Deliberately outside the boundary check's synthetic-identity exemptions.
    // The reserved .invalid domain keeps this fixture independent of any person.
    const email = ['release', 'publisher.invalid'].join('@');
    runGit(f.root, [
      '-c',
      'user.name=Release Publisher',
      '-c',
      `user.email=${email}`,
      'tag',
      '-a',
      'ordinary-tagger',
      '-m',
      'clean annotation',
      base,
    ]);
    const tag = runGit(f.root, ['rev-parse', 'ordinary-tagger']);
    expect(runGit(f.root, ['cat-file', 'tag', tag])).toContain(`<${email}>`);
    const result = push(f, `refs/tags/release ${tag} refs/tags/release ${zeroSha}\n`, {
      remoteRefs: `${base}\trefs/heads/main\n`,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(records(f.log)).toHaveLength(1);
  });

  it.each([
    ['no later blank line', 'Private Customer annotation\n'],
    [
      'a later blank line after private pre-separator content',
      'Private Customer annotation\n\nclean second paragraph\n',
    ],
  ])('rejects an annotated tag with %s', (_shape, contentAfterHeaders) => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    const tagFile = path.join(f.root, 'malformed-tag');
    fs.writeFileSync(
      tagFile,
      [
        `object ${base}`,
        'type commit',
        'tag missing-separator',
        'tagger Synthetic Tag <tagger@example.invalid> 0 +0000',
        contentAfterHeaders,
      ].join('\n'),
    );
    const tag = runGit(f.root, ['hash-object', '-t', 'tag', '-w', tagFile]);

    const result = push(f, `refs/tags/release ${tag} refs/tags/release ${zeroSha}\n`, {
      remoteRefs: `${base}\trefs/heads/main\n`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('malformed annotated tag object: expected header separator');
    expect(fs.existsSync(f.log)).toBe(false);
  });

  it('accepts a raw annotated tag with an empty annotation after its separator', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    const tagFile = path.join(f.root, 'empty-annotation-tag');
    fs.writeFileSync(
      tagFile,
      `object ${base}\ntype commit\ntag empty-annotation\ntagger Synthetic Tag <tagger@example.invalid> 0 +0000\n\n`,
    );
    const tag = runGit(f.root, ['hash-object', '-t', 'tag', '-w', tagFile]);

    const result = push(f, `refs/tags/release ${tag} refs/tags/release ${zeroSha}\n`, {
      remoteRefs: `${base}\trefs/heads/main\n`,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(records(f.log)).toHaveLength(1);
  });

  it('accepts clean annotated and lightweight tags and scans shared tag objects once', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    runGit(f.root, ['tag', '-a', 'synthetic-release', '-m', 'clean annotation', base]);
    const tag = runGit(f.root, ['rev-parse', 'synthetic-release']);
    const result = push(
      f,
      [
        `refs/tags/release ${tag} refs/tags/release ${zeroSha}`,
        `refs/tags/alias ${tag} refs/tags/alias ${zeroSha}`,
        `refs/tags/lightweight ${base} refs/tags/lightweight ${zeroSha}`,
      ].join('\n') + '\n',
      { remoteRefs: `${base}\trefs/heads/main\n` },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(records(f.log)).toHaveLength(1);
    expect(records(f.log)[0]).toContain('/TAG_EDITMSG --message-raw');
    expect(fs.readdirSync(f.root).some((name) => name.startsWith('nanoclaw-pre-push.'))).toBe(false);
  });

  it.each(['tree', 'blob'] as const)('fails closed for a tag pointing to an unsupported %s target', (kind) => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    const target = runGit(f.root, ['rev-parse', kind === 'tree' ? `${base}^{tree}` : `${base}:src/gate.ts`]);
    runGit(f.root, ['tag', '-a', 'synthetic-object', '-m', 'clean annotation', target]);
    const tag = runGit(f.root, ['rev-parse', 'synthetic-object']);
    const result = push(f, `refs/tags/object ${tag} refs/tags/object ${zeroSha}\n`, {
      remoteRefs: `${base}\trefs/heads/main\n`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unsupported ref target');
  });

  it('skips SHA-256 ref deletions', () => {
    const f = fixture('sha256');
    const pushed = commit(f.root, 'sha256-pushed');
    const zeroSha256 = '0'.repeat(64);
    const result = push(f, `refs/heads/deleted ${zeroSha256} refs/heads/deleted ${pushed}\n`);

    expect(result.status).toBe(0);
    expect(fs.existsSync(f.log)).toBe(false);
  });

  it.each([
    [
      'exact scissors',
      'fix: imported\n# ------------------------ >8 ------------------------\nPrivate Customer after scissors',
    ],
    ['trailing comment block', 'fix: imported\n\n# Private Customer in history\n#'],
  ])('rejects a committed %s message verbatim', (_shape, message) => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    const pushed = commit(f.root, 'clean-tree', message);
    const result = push(f, `refs/heads/current ${pushed} refs/heads/current ${base}\n`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('private-identifier');
    expect(records(f.log).join('\n')).toContain('--message-raw');
    const snapshot = records(f.log)[0].match(/--root ([^ ]+)/)?.[1];
    expect(snapshot).toBeDefined();
    expect(fs.existsSync(snapshot!)).toBe(false);
    expect(fs.existsSync(path.dirname(snapshot!))).toBe(false);
    expect(runGit(f.root, ['worktree', 'list', '--porcelain'])).not.toContain(snapshot!);
  });

  it('matches reviewed commit-message exceptions with a stable filename and cleans up each scan', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    fs.writeFileSync(
      path.join(f.root, '.public-boundary-allowlist.json'),
      JSON.stringify({ entries: [{ path: 'COMMIT_EDITMSG', value: 'Private Customer', reason: 'synthetic fixture' }] }),
    );
    const pushed = commit(f.root, 'clean-tree', 'fix: Private Customer');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = push(f, `refs/heads/current ${pushed} refs/heads/current ${base}\n`);
      expect(result.status).toBe(0);
      expect(fs.readdirSync(f.root).some((name) => name.startsWith('nanoclaw-pre-push.'))).toBe(false);
    }
    const messages = records(f.log).filter((record) => record.startsWith('message|'));
    expect(messages).toHaveLength(2);
    expect(messages.every((record) => record.includes('/COMMIT_EDITMSG --message-raw'))).toBe(true);
  });

  it('does not honor an uncommitted allowlist entry: reads the allowlist from the pushed tree', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    const pushed = commit(f.root, 'clean-tree', 'fix: Private Customer');
    // Edit the allowlist in the pushing worktree WITHOUT committing it. If
    // the hook read this file instead of $local_sha's own committed tree,
    // this uncommitted edit would exempt the identifier above with nothing
    // on the remote actually backing the exception (#651).
    fs.writeFileSync(
      path.join(f.root, '.public-boundary-allowlist.json'),
      JSON.stringify({ entries: [{ path: 'COMMIT_EDITMSG', value: 'Private Customer', reason: 'uncommitted' }] }),
    );
    const result = push(f, `refs/heads/current ${pushed} refs/heads/current ${base}\n`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('private-identifier');
  });

  it('treats a pushed tip with no committed allowlist as an empty one, not a refusal', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    const pushed = commitWithoutAllowlist(f.root, 'no-allowlist-clean');
    const result = push(f, `refs/heads/current ${pushed} refs/heads/current ${base}\n`);

    expect(result.status, result.stderr).toBe(0);
    expect(records(f.log).join('\n')).toContain('no-allowlist-clean');
    // Non-fatal, and it does not change the result, but a later alert about a
    // finding on this ref should be able to explain itself.
    expect(result.stderr).toContain(`refs/heads/current (${pushed})`);
    expect(result.stderr).toContain('scanning with an empty allowlist');
  });

  it('still refuses a pushed tip with no committed allowlist when it carries an identifier', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    const pushed = commitWithoutAllowlist(f.root, 'clean-tree', 'fix: Private Customer, no allowlist');
    const result = push(f, `refs/heads/current ${pushed} refs/heads/current ${base}\n`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('private-identifier');
  });

  it('does not let the missing-allowlist fallback read the working copy instead of synthesizing an empty one', () => {
    const f = fixture();
    const base = commit(f.root, 'remote-base');
    // The working copy's allowlist, left on disk and never committed, exempts
    // the identifier below. The pushed tip's own tree carries no allowlist at
    // all, so this push must fall back to a FRESH empty allowlist, not this
    // file — if the fallback ever read the working copy instead, this
    // identifier would wrongly pass unflagged.
    fs.writeFileSync(
      path.join(f.root, '.public-boundary-allowlist.json'),
      JSON.stringify({ entries: [{ path: 'COMMIT_EDITMSG', value: 'Private Customer', reason: 'uncommitted' }] }),
    );
    const pushed = commitWithoutAllowlist(f.root, 'clean-tree', 'fix: Private Customer, no allowlist in tree');
    const result = push(f, `refs/heads/current ${pushed} refs/heads/current ${base}\n`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('private-identifier');
  });

  it.each(['tree', 'message'] as const)(
    'honors a later approved exception for an intermediate commit %s',
    (surface) => {
      const f = fixture();
      fs.mkdirSync(path.join(f.root, 'data'));
      const db = new Database(path.join(f.root, 'data', 'v2.db'));
      db.exec(
        "CREATE TABLE workgroups (id TEXT, display_name TEXT); INSERT INTO workgroups VALUES ('fixture-workgroup', 'Private Customer');",
      );
      db.close();
      const base = commit(f.root, 'remote-base');
      const flagged = commit(
        f.root,
        surface === 'tree' ? 'Private Customer' : 'clean-tree',
        surface === 'message' ? 'fix: Private Customer' : 'imported commit',
      );
      const rejected = push(f, `refs/heads/current ${flagged} refs/heads/current ${base}\n`, { realTreeCheck: true });
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain('private-identifier');

      const paths = surface === 'tree' ? ['src/gate.ts', 'scripts/gate.ts'] : ['COMMIT_EDITMSG'];
      fs.writeFileSync(
        path.join(f.root, '.public-boundary-allowlist.json'),
        JSON.stringify({
          entries: paths.map((file) => ({
            path: file,
            value: 'Private Customer',
            reason: 'reviewed synthetic fixture',
          })),
        }),
      );
      const approved = commit(f.root, 'clean-tip', 'record approved exception');
      const accepted = push(f, `refs/heads/current ${approved} refs/heads/current ${base}\n`, { realTreeCheck: true });
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(fs.readdirSync(f.root).some((name) => name.startsWith('nanoclaw-pre-push.'))).toBe(false);
    },
  );

  it('clears the source Git environment before the boundary gate reads a snapshot index', () => {
    const f = fixture();
    const snapshot = commit(f.root, 'snapshot-index');
    runGit(f.root, ['branch', 'snapshot-index', snapshot]);
    commit(f.root, 'source-index');
    const result = push(f, `refs/heads/snapshot ${snapshot} refs/heads/snapshot ${zeroSha}\n`, { sourceGitEnv: true });

    expect(result.status).toBe(0);
    const boundaryRecord = records(f.log).find((record) => record.startsWith('boundary|'))!;
    expect(boundaryRecord).toContain('snapshot-index');
    expect(boundaryRecord).not.toContain('source-index');
  });

  function linkedWorktree(main: ReturnType<typeof fixture>, base: string): ReturnType<typeof fixture> {
    const root = tempRoot();
    runGit(main.root, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', '--quiet', root, base]);
    linkedWorktrees.push({ main: main.root, root });
    const hook = path.join(root, '.husky', 'pre-push');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.copyFileSync(new URL('../.husky/pre-push', import.meta.url), hook);
    return { ...main, root, hook, log: path.join(root, 'hook.log') };
  }

  it("scans raw messages with the main checkout's tooling and never links into a linked worktree", () => {
    const main = fixture();
    const base = commit(main.root, 'base');
    const linked = linkedWorktree(main, base);

    const result = push(linked, `refs/heads/current ${base} refs/heads/current ${zeroSha}\n`);

    expect(result.status, result.stderr).toBe(0);
    expect(records(linked.log).join('\n')).toContain('--message-raw');
    expect(fs.existsSync(path.join(linked.root, 'node_modules'))).toBe(false);
  });

  it('scans raw messages from a linked worktree whose node_modules is a partial real directory', () => {
    // A stray cache directory used to make the hook skip its node_modules link
    // and then run a tsx that did not exist: exit 127 on every push (#623).
    const main = fixture();
    const base = commit(main.root, 'base');
    const linked = linkedWorktree(main, base);
    fs.mkdirSync(path.join(linked.root, 'node_modules', '.cache'), { recursive: true });

    const result = push(linked, `refs/heads/current ${base} refs/heads/current ${zeroSha}\n`);

    expect(result.status, result.stderr).toBe(0);
    expect(records(linked.log).join('\n')).toContain('--message-raw');
    expect(fs.lstatSync(path.join(linked.root, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(linked.root, 'node_modules', '.cache'))).toBe(true);
  });

  it('runs the boundary check through nice when ionice is unavailable', () => {
    const f = fixture();
    const pushed = commit(f.root, 'no-ionice');
    const result = push(f, `refs/heads/new ${pushed} refs/heads/new ${zeroSha}\n`, { withoutIonice: true });

    expect(result.status).toBe(0);
    expect(records(f.log)).toContain('nice');
    expect(records(f.log).join('\n')).toContain('boundary');
  });

  it('leaves the snapshot free of untracked files so a plain worktree remove succeeds', () => {
    // The hook used to symlink the main checkout's node_modules into every
    // snapshot for eslint and tsc, and had to unlink it again before
    // `worktree remove` (which refuses an untracked file without --force).
    // With those gates gone nothing in the snapshot needs node_modules, so the
    // symlink, its fail-closed guard and the extra cleanup step are all gone.
    const f = fixture();
    const pushed = commit(f.root, 'no-node-modules');
    const result = push(f, `refs/heads/new ${pushed} refs/heads/new ${zeroSha}\n`);

    expect(result.status).toBe(0);
    const snapshot = records(f.log)
      .find((record) => record.startsWith('boundary|'))!
      .split('|')[1];
    expect(fs.existsSync(snapshot)).toBe(false);
    expect(runGit(f.root, ['worktree', 'list', '--porcelain'])).not.toContain(snapshot);
    expect(fs.readdirSync(f.root).some((name) => name.startsWith('nanoclaw-pre-push.'))).toBe(false);
  });
});
