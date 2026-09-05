import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

enforceHermeticity();
allowSubprocess(['sh', 'tsx']);

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

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
  executable(path.join(root, 'node_modules/.bin/eslint'), "printf '[]\\n'");
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

describe('setup typecheck enforcement', () => {
  it.each(['build', 'push'] as const)('rejects setup type errors at the %s gate', (gate) => {
    const root = fixture(false);
    const result = runGate(root, gate);
    expect(result.status, result.stderr).toBeGreaterThan(0);
    expect(result.stdout).toContain('setup/index.ts');
    expect(result.stdout).toContain('TS2322');
    expect(fs.existsSync(path.join(root, 'dist/.build-start-sha'))).toBe(false);
  });

  it.each(['build', 'push'] as const)('accepts valid setup code at the %s gate', (gate) => {
    const root = fixture(true);
    const result = runGate(root, gate);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});

function runGate(root: string, gate: 'build' | 'push') {
  const env = { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}` };
  return gate === 'build'
    ? spawnSync(path.join(repoRoot, 'node_modules/.bin/tsx'), [path.join(root, 'scripts/check-build-clean.mts')], {
        cwd: root,
        env,
        encoding: 'utf8',
      })
    : spawnSync('sh', [path.join(repoRoot, '.husky/pre-push')], { cwd: root, env, encoding: 'utf8' });
}
