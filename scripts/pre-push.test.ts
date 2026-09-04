import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const linkedWorktrees: Array<{ main: string; root: string }> = [];
const zeroSha = '0000000000000000000000000000000000000000';

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
printf 'boundary|%s|%s|%s\\n' "$root" "$(cat "$root/src/gate.ts")" "$consumed" >> "$HOOK_LOG"
[ "\${HOOK_FAIL:-}" != "boundary:$(cat "$root/src/gate.ts")" ] || exit 1
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

function push(f: ReturnType<typeof fixture>, refs: string, fail = '') {
  return spawnSync('sh', [f.hook], {
    cwd: f.root,
    encoding: 'utf8',
    input: refs,
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      HOOK_LOG: f.log,
      HOOK_POST_CHECKOUT: path.join(f.root, 'post-checkout-ran'),
      TMPDIR: f.root,
      HOOK_FAIL: fail,
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
    const result = push(
      f,
      `refs/heads/rejected-push ${rejected} refs/heads/rejected-push ${zeroSha}\n`,
      `${gate}:rejected-push`,
    );

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
