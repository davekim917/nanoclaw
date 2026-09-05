import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

enforceHermeticity();
allowSubprocess(['sh', 'tsx', 'git']);

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

function executable(file: string, content: string): void {
  fs.writeFileSync(file, `#!/bin/sh\nset -eu\n${content}\n`, { mode: 0o755 });
}

function fixture(valid: boolean): string {
  const root = globalThis.uniqueTmpRoot('setup-typecheck-gates');
  for (const dir of ['.git', 'bin', 'scripts', 'src', 'setup', 'node_modules/.bin']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ type: 'module', scripts: { typecheck: manifest.scripts.typecheck } }),
  );
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tsconfig.json'), 'utf8'));
  config.compilerOptions.types = [];
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(config));
  fs.copyFileSync(path.join(repoRoot, 'tsconfig.scripts.json'), path.join(root, 'tsconfig.scripts.json'));
  fs.writeFileSync(path.join(root, 'src/index.ts'), 'export const host = true;\n');
  fs.writeFileSync(path.join(root, 'scripts/index.ts'), 'export const script = true;\n');
  fs.writeFileSync(path.join(root, 'setup/index.ts'), `export const setup: number = ${valid ? '1' : '"wrong"'};\n`);
  fs.copyFileSync(path.join(repoRoot, 'scripts/check-build-clean.ts'), path.join(root, 'scripts/check-build-clean.ts'));
  // The real build guard is executed, but it is not part of this minimal
  // fixture's typecheck: only the host/script/setup sentinels belong to it.
  fs.renameSync(path.join(root, 'scripts/check-build-clean.ts'), path.join(root, 'scripts/check-build-clean.mts'));
  fs.symlinkSync(path.join(repoRoot, 'node_modules/.bin/tsc'), path.join(root, 'node_modules/.bin/tsc'));
  fs.symlinkSync(path.join(repoRoot, 'node_modules/typescript'), path.join(root, 'node_modules/typescript'));
  executable(
    path.join(root, 'node_modules/.bin/eslint'),
    `case " $* " in
      *" setup/ "*) printf '[]\\n' ;;
      *) printf '[{"messages":[{"message":"setup missing from lint gate"}]}]\\n'; exit 1 ;;
    esac`,
  );
  executable(
    path.join(root, 'bin/pnpm'),
    `if [ "$1" = run ] && [ "$2" = check:public-boundary ]; then exit 0; fi\nexec /usr/bin/env PATH=${quote(process.env.PATH ?? '')} pnpm "$@"`,
  );
  // Keep these fixtures offline: all Git calls are deterministic reads of
  // synthetic metadata, while the typecheck itself uses the real compiler.
  executable(
    path.join(root, 'bin/git'),
    `case "$*" in
      'rev-parse --git-common-dir') printf '%s\\n' ${quote(path.join(root, '.git'))} ;;
      'rev-parse --show-toplevel') printf '%s\\n' ${quote(root)} ;;
      'rev-parse HEAD'|'rev-parse origin/main') printf '%s\\n' ${quote('a'.repeat(40))} ;;
      'status --porcelain'|'fetch -q origin main') ;;
      *) echo 'unexpected fixture Git command' >&2; exit 2 ;;
    esac`,
  );
  return root;
}

// Each fixture launches two throttled compiler processes on the shared host.
describe('setup typecheck enforcement', () => {
  it('typechecks authentication steps without optional channel packages installed', () => {
    const root = fixture(true);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
    config.compilerOptions.types = ['node'];
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(config));
    fs.mkdirSync(path.join(root, 'node_modules/@types'), { recursive: true });
    fs.symlinkSync(path.join(repoRoot, 'node_modules/@types/node'), path.join(root, 'node_modules/@types/node'));
    for (const file of ['whatsapp-auth.ts', 'signal-auth.ts', 'status.ts']) {
      fs.copyFileSync(path.join(repoRoot, 'setup', file), path.join(root, 'setup', file));
    }
    for (const dependency of ['@whiskeysockets/baileys', 'pino', 'qrcode']) {
      expect(fs.existsSync(path.join(root, 'node_modules', dependency))).toBe(false);
    }
    const result = runGate(root, 'build');
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 60_000);

  it.each(['build', 'push'] as const)(
    'rejects setup type errors at the %s gate',
    (gate) => {
      const root = fixture(false);
      const result = runGate(root, gate);
      expect(result.status, result.stderr).toBeGreaterThan(0);
      expect(result.stdout).toContain('setup/index.ts');
      expect(result.stdout).toContain('TS2322');
      expect(fs.existsSync(path.join(root, 'dist/.build-start-sha'))).toBe(false);
    },
    60_000,
  );

  it.each(['build', 'push'] as const)(
    'accepts valid setup code at the %s gate',
    (gate) => {
      const root = fixture(true);
      const result = runGate(root, gate);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    },
    60_000,
  );
});

function runGate(root: string, gate: 'build' | 'push') {
  const env = { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}` };
  if (gate === 'build') {
    return spawnSync(path.join(repoRoot, 'node_modules/.bin/tsx'), [path.join(root, 'scripts/check-build-clean.mts')], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
  }

  // The pre-push hook now gates the pushed commit's own snapshot with real
  // `git` plumbing (rev-parse --show-object-format, cat-file, rev-list,
  // worktree add/remove, show --no-patch) rather than the handful of
  // deterministic canned answers the build-gate fixture's fake `git` gives —
  // there is no meaningful way to fake that plumbing, so turn this fixture
  // into a real, minimal one-commit repo and push it for real.
  fs.rmSync(path.join(root, 'bin', 'git'), { force: true });
  executable(
    path.join(root, 'bin', 'git'),
    `if [ "$1" = -C ] && [ "$3" = ls-remote ]; then shift 2; fi
if [ "$1" = ls-remote ]; then exit 0; fi
exec ${quote(realGit)} "$@"`,
  );
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\nbin/\n');
  fs.mkdirSync(path.join(root, '.nanoclaw'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nanoclaw', 'public-boundary-identifiers'), 'Private Customer\n');
  fs.writeFileSync(path.join(root, '.public-boundary-allowlist.json'), '{"entries": []}\n');
  if (!fs.existsSync(path.join(root, 'scripts', 'check-public-boundary.ts'))) {
    fs.symlinkSync(
      path.join(repoRoot, 'scripts/check-public-boundary.ts'),
      path.join(root, 'scripts', 'check-public-boundary.ts'),
    );
    // scan_message runs this real script through tsx directly, but it must
    // not also fall into this fixture's own `pnpm run typecheck` pass — this
    // minimal fixture has no @types/node or better-sqlite3 typings, and the
    // real script's own types are covered by the real repo's own gates, not
    // this one.
    // tsconfig.scripts.json carries `//` comments, so patch the raw text
    // rather than round-tripping through JSON.parse/stringify.
    const scriptsConfigPath = path.join(root, 'tsconfig.scripts.json');
    const scriptsConfigText = fs.readFileSync(scriptsConfigPath, 'utf8');
    fs.writeFileSync(
      scriptsConfigPath,
      scriptsConfigText.replace('"exclude": [', '"exclude": [\n    "scripts/check-public-boundary.ts",'),
    );
  }
  if (!fs.existsSync(path.join(root, 'node_modules/.bin/tsx'))) {
    // The pnpm shim resolves its sibling package via $0's dirname, not a
    // realpath, so the `tsx` package itself must be symlinked alongside it
    // (same reason `typescript` is symlinked next to the `tsc` shim above).
    fs.symlinkSync(path.join(repoRoot, 'node_modules/.bin/tsx'), path.join(root, 'node_modules/.bin/tsx'));
    fs.symlinkSync(path.join(repoRoot, 'node_modules/tsx'), path.join(root, 'node_modules/tsx'));
  }
  execFileSync(realGit, ['init', '--quiet'], { cwd: root });
  execFileSync(realGit, ['config', 'user.email', 'setup-typecheck@example.invalid'], { cwd: root });
  execFileSync(realGit, ['config', 'user.name', 'Setup Typecheck Gate Fixture'], { cwd: root });
  execFileSync(realGit, ['add', '-A'], { cwd: root });
  execFileSync(realGit, ['commit', '-m', 'fixture snapshot', '--quiet'], { cwd: root });
  const headSha = execFileSync(realGit, ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const zeroSha = '0'.repeat(40);

  return spawnSync('sh', [path.join(repoRoot, '.husky/pre-push'), 'origin', 'test://origin'], {
    cwd: root,
    env,
    encoding: 'utf8',
    input: `refs/heads/main ${headSha} refs/heads/main ${zeroSha}\n`,
  });
}
