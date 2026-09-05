import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const linkedWorktrees: Array<{ main: string; root: string }> = [];
const zeroSha = '0000000000000000000000000000000000000000';
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

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

function commit(root: string, value: string): string {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'eslint.config.js'), 'export default [];\n');
  fs.writeFileSync(path.join(root, 'src', 'gate.ts'), `${value}\n`);
  fs.writeFileSync(path.join(root, 'scripts', 'gate.ts'), `${value}\n`);
  runGit(root, ['add', 'eslint.config.js', 'src/gate.ts', 'scripts/gate.ts']);
  runGit(root, ['commit', '-m', value, '--quiet']);
  return runGit(root, ['rev-parse', 'HEAD']);
}

function fixture(): { root: string; hook: string; log: string; bin: string } {
  const root = tempRoot();
  runGit(root, ['init', '--quiet']);
  runGit(root, ['config', 'user.email', 'test@example.invalid']);
  runGit(root, ['config', 'user.name', 'Hook Test']);
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
`,
  );
  writeExecutable(
    path.join(bin, 'git'),
    `#!/bin/sh
if [ "$1" = -C ] && [ "$3" = ls-remote ]; then shift 2; fi
if [ "$1" = ls-remote ]; then
  [ "\${HOOK_LS_REMOTE_FAIL:-}" != 1 ] || exit 1
  printf '%s' "\${HOOK_REMOTE_REFS:-}"
  exit 0
fi
exec "$HOOK_REAL_GIT" "$@"
`,
  );
  writeExecutable(
    path.join(modules, 'eslint'),
    `#!/bin/sh
test -f eslint.config.js || exit 1
IFS= read -r consumed || true
printf 'lint|%s|%s|%s\\n' "$PWD" "$(cat src/gate.ts)" "$consumed" >> "$HOOK_LOG"
[ "\${HOOK_FAIL:-}" != "lint:$(cat src/gate.ts)" ] || exit 1
`,
  );
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
    sourceGitEnv?: boolean;
    withoutIonice?: boolean;
  } = {},
) {
  if (options.withoutIonice) {
    for (const command of ['dirname', 'mktemp', 'rm', 'rmdir', 'ln', 'grep', 'cat']) linkSystemCommand(f.bin, command);
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
      HOOK_REAL_GIT: realGit,
      ...(options.sourceGitEnv ? { GIT_DIR: path.join(f.root, '.git'), GIT_WORK_TREE: f.root } : {}),
    },
  });
}

function records(log: string): string[] {
  return fs.readFileSync(log, 'utf8').trim().split('\n');
}

afterEach(() => {
  for (const worktree of linkedWorktrees.splice(0)) {
    fs.rmSync(path.join(worktree.root, '.husky'), { recursive: true, force: true });
    runGit(worktree.main, ['worktree', 'remove', worktree.root]);
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('.husky/pre-push', () => {
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
    expect(records(f.log)).toHaveLength(4);
    expect(records(f.log).join('\n')).toContain('first-pushed');
    expect(records(f.log).join('\n')).toContain('second-pushed');
    expect(records(f.log).join('\n')).not.toContain('dirty-worktree');
    expect(records(f.log).every((record) => record.endsWith('|'))).toBe(true);
    for (const record of records(f.log)) {
      const snapshot = record.split('|')[1];
      expect(fs.existsSync(snapshot)).toBe(false);
      expect(fs.existsSync(path.dirname(snapshot))).toBe(false);
    }
    expect(fs.existsSync(path.join(f.root, 'post-checkout-ran'))).toBe(false);
  });

  it.each(['boundary', 'lint'] as const)('rejects a non-HEAD snapshot when %s finds a violation', (gate) => {
    const f = fixture();
    const rejected = commit(f.root, 'rejected-push');
    runGit(f.root, ['branch', 'rejected-push', rejected]);
    commit(f.root, 'clean-head');
    fs.writeFileSync(path.join(f.root, 'src', 'gate.ts'), 'dirty-clean\n');
    const result = push(f, `refs/heads/rejected-push ${rejected} refs/heads/rejected-push ${zeroSha}\n`, {
      fail: `${gate}:rejected-push`,
    });

    expect(result.status).toBe(1);
    expect(records(f.log).join('\n')).toContain('rejected-push');
    expect(records(f.log).join('\n')).not.toContain('clean-head');
    expect(records(f.log).join('\n')).not.toContain('dirty-clean');
    expect(records(f.log)).toHaveLength(gate === 'boundary' ? 1 : 2);
    const snapshot = records(f.log)[0].split('|')[1];
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
    expect(records(f.log).filter((record) => record.includes('shared-push'))).toHaveLength(2);
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

  it('fails closed when live advertised refs cannot be listed', () => {
    const f = fixture();
    const pushed = commit(f.root, 'new-ref');
    const result = push(f, `refs/heads/new ${pushed} refs/heads/new ${zeroSha}\n`, { remoteFailure: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed to list advertised refs');
    expect(fs.existsSync(f.log)).toBe(false);
  });

  it('clears the source Git environment before the boundary gate reads a snapshot index', () => {
    const f = fixture();
    const snapshot = commit(f.root, 'snapshot-index');
    runGit(f.root, ['branch', 'snapshot-index', snapshot]);
    commit(f.root, 'source-index');
    const result = push(f, `refs/heads/snapshot ${snapshot} refs/heads/snapshot ${zeroSha}\n`, { sourceGitEnv: true });

    expect(result.status).toBe(0);
    expect(records(f.log)[0]).toContain('snapshot-index');
    expect(records(f.log)[0]).not.toContain('source-index');
  });

  it('runs eslint through nice when ionice is unavailable', () => {
    const f = fixture();
    const pushed = commit(f.root, 'no-ionice');
    const result = push(f, `refs/heads/new ${pushed} refs/heads/new ${zeroSha}\n`, { withoutIonice: true });

    expect(result.status).toBe(0);
    expect(records(f.log)).toContain('nice');
    expect(records(f.log).join('\n')).toContain('lint');
  });

  it('cleans up a snapshot that already tracks node_modules without unlinking it', () => {
    const main = fixture();
    const base = commit(main.root, 'base');
    const linkedRoot = tempRoot();
    runGit(main.root, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', '--quiet', linkedRoot, base]);
    linkedWorktrees.push({ main: main.root, root: linkedRoot });
    fs.symlinkSync('tracked-dependency', path.join(linkedRoot, 'node_modules'));
    runGit(linkedRoot, ['add', 'node_modules']);
    runGit(linkedRoot, ['commit', '-m', 'track node modules', '--quiet']);
    const sha = runGit(linkedRoot, ['rev-parse', 'HEAD']);
    const hook = path.join(linkedRoot, '.husky', 'pre-push');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.copyFileSync(new URL('../.husky/pre-push', import.meta.url), hook);

    const result = push(
      { ...main, root: linkedRoot, hook, log: path.join(linkedRoot, 'hook.log') },
      `refs/heads/current ${sha} refs/heads/current ${zeroSha}\n`,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('snapshot unexpectedly contains node_modules');
    expect(fs.lstatSync(path.join(linkedRoot, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(runGit(main.root, ['worktree', 'list', '--porcelain'])).not.toContain('nanoclaw-pre-push');
    expect(fs.readdirSync(linkedRoot).some((name) => name.startsWith('nanoclaw-pre-push.'))).toBe(false);
  });
});
