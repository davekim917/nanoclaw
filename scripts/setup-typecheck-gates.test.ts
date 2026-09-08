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
  // The boundary checker itself is covered exhaustively by
  // scripts/check-public-boundary.test.ts; what this fixture pins is that the
  // GATE runs it and honours its exit code. So the stub records how it was
  // called and fails on demand, rather than re-testing the checker.
  executable(
    path.join(root, 'bin/pnpm'),
    `if [ "$1" = run ] && [ "$2" = check:public-boundary ]; then
      [ -z "\${FIXTURE_BOUNDARY_LOG:-}" ] || printf '%s\\n' "$*" >> "$FIXTURE_BOUNDARY_LOG"
      if [ "\${FIXTURE_BOUNDARY_FAIL:-}" = 1 ]; then
        echo 'src/index.ts:1 private-identifier' >&2
        echo 'public boundary check failed with 1 redacted finding(s) (index)' >&2
        exit 1
      fi
      exit 0
    fi
exec /usr/bin/env PATH=${quote(process.env.PATH ?? '')} pnpm "$@"`,
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
//
// WHY THE PUSH GATE NO LONGER TYPECHECKS
// --------------------------------------
// This file was added (5cb76b776) to pin the typecheck step inside the
// pre-push snapshot gate. That step is gone, deliberately, and the cases below
// were rewritten to pin the contract that replaced it rather than relaxed to
// keep passing.
//
// `.husky/pre-push` runs per PUSHED COMMIT — `objects_for_ref` loops over every
// commit in the push. Measured on this host at load 1.15: eslint 68.1s, tsc
// 23.4s, boundary check 27.8s. That was affordable while the hook only ever ran
// for a deployer pushing from the main checkout; it is not, now that
// `scripts/pin-git-hooks-path.sh` makes hooks resolve from every agent worktree.
//
// The protection is not lost, only moved earlier-to-later:
//   - CI runs `pnpm run lint`, `tsc --noEmit` and
//     `tsc -p tsconfig.scripts.json --noEmit` on every PR
//     (.github/workflows/ci.yml:44, :47, :50).
//   - `scripts/check-build-clean.ts` still rejects the same setup type error,
//     so a bad type cannot reach a build or a deploy. The 'build' cases below
//     are that evidence and are unchanged.
// What changed is only WHEN a type error is caught: at CI and build time rather
// than at push time.
//
// The boundary check stays in the hook because CI structurally cannot run it:
// the CI step is `--portable` (ci.yml:34), structural patterns only, since a
// runner has no `data/v2.db` and shipping it the identifier registry would
// publish what the registry protects. So the push gate keeps a case of its own
// here — deleting one outright would leave the hook with nothing pinning it,
// which is how a gate quietly disappears.
describe('setup typecheck and push-gate boundary enforcement', () => {
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

  it('rejects setup type errors at the build gate', () => {
    const root = fixture(false);
    const result = runGate(root, 'build');
    expect(result.status, result.stderr).toBeGreaterThan(0);
    expect(result.stdout).toContain('setup/index.ts');
    expect(result.stdout).toContain('TS2322');
    expect(fs.existsSync(path.join(root, 'dist/.build-start-sha'))).toBe(false);
  }, 60_000);

  it('rejects a public-boundary violation at the push gate', () => {
    const root = fixture(true);
    const result = runGate(root, 'push', { boundaryFails: true });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBeGreaterThan(0);
    // The hook must surface the checker's own redacted output, not swallow it.
    expect(result.stderr).toContain('private-identifier');
  }, 60_000);

  it('gates the pushed commit’s snapshot index, not the live working tree', () => {
    // The failure this pins is real history: `.husky/pre-commit` once
    // defaulted the checker to `process.cwd()` after cd-ing to the main
    // checkout, so every commit made from a worktree scanned main's index —
    // entirely different content — and printed "passed" about work it never
    // saw. A gate pointed at the wrong tree reports success just as loudly as
    // one pointed at the right one.
    const root = fixture(true);
    const log = path.join(root, 'boundary-calls.log');
    const result = runGate(root, 'push', { boundaryLog: log });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--index');
    const scanned = /--root (\S+)/.exec(calls[0])?.[1];
    expect(scanned).toBeDefined();
    // A throwaway snapshot, not the checkout the push was issued from.
    expect(scanned).not.toBe(root);
    expect(scanned).toMatch(/nanoclaw-pre-push\.[^/]+\/tree$/);
    expect(fs.existsSync(scanned!)).toBe(false);
  }, 60_000);

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

function runGate(
  root: string,
  gate: 'build' | 'push',
  options: { boundaryFails?: boolean; boundaryLog?: string } = {},
) {
  const env = {
    ...process.env,
    PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
    ...(options.boundaryFails ? { FIXTURE_BOUNDARY_FAIL: '1' } : {}),
    ...(options.boundaryLog ? { FIXTURE_BOUNDARY_LOG: options.boundaryLog } : {}),
  };
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
