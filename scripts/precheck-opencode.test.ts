/**
 * The pre-check is the cheap pass that runs BEFORE a scarce reviewer round, so
 * its two failure modes are both "looks like it worked": a hang that never
 * returns, and a clean exit with nothing to show. Neither is visible from
 * reading the script — both were found by running it — so they are pinned here.
 *
 * Shell scripts are tested the way `codex-review.test.ts` tests its helper:
 * spawn bash with a stub `bin/` ahead of PATH, so nothing reaches the network.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

allowSubprocess(['bash']);
enforceHermeticity();

const SCRIPT = path.resolve('container/skills/pr-review-loop/scripts/precheck-opencode.sh');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A scratch root with a stub `gh` (PR body + diff, no network) and a stub
 * `opencode` whose behaviour the caller chooses. `opencodeBody` is the body of
 * the stub script; it may print, exit non-zero, or do nothing at all.
 */
function tempRoot(opencodeBody: string, diffBytes = 200) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'precheck-test-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
# \`pr diff\` prints a diff; \`pr view\` prints the body. Nothing goes out.
case "$*" in
  *"pr diff"*) printf 'd%.0s' {1..${diffBytes}}; echo ;;
  *) echo "TITLE: a title"; echo; echo "BODY:"; echo "a body" ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, 'opencode'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "$OPENCODE_ARGS"\n${opencodeBody}\n`, {
    mode: 0o755,
  });
  return { root, bin, argsFile: path.join(root, 'opencode-args') };
}

function run(opencodeBody: string, args: string[] = ['--pr', '1'], env: Record<string, string> = {}, diffBytes = 200) {
  const { root, bin, argsFile } = tempRoot(opencodeBody, diffBytes);
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    // A parsing mutation that loops forever fails this test instead of hanging
    // the worker: spawnSync blocks, so vitest's own timeout cannot interrupt it.
    timeout: 20_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, OPENCODE_ARGS: argsFile, ...env },
  });
  return {
    ...result,
    root,
    opencodeArgs: fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8') : null,
  };
}

describe('argument parsing never spins on a missing value', () => {
  // `shift 2` with one argument left fails and shifts nothing, and the script
  // sets `-uo pipefail` without `-e`, so the loop used to re-read the same
  // argument until it was killed. `signal` is what a timeout kill looks like.
  it.each([
    ['a trailing --pr', ['--pr']],
    ['a trailing --repo', ['--pr', '1', '--repo']],
    ['a trailing --model', ['--pr', '1', '--model']],
  ])('refuses %s instead of hanging', (_case, args) => {
    const result = run('exit 0', args);
    expect(result.signal, 'the script hung and had to be killed').toBeNull();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('needs a value');
  });

  it('still refuses an unknown argument', () => {
    const result = run('exit 0', ['--pr', '1', '--nonsense']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown argument');
  });
});

describe('an empty result is never reported as a pass', () => {
  it('refuses a run that exits 0 having printed nothing', () => {
    const result = run('exit 0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('produced NO output');
  });

  it('refuses a run that prints only whitespace', () => {
    const result = run("printf '   \\n\\n'\nexit 0");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('produced NO output');
  });

  it('propagates a non-zero exit rather than swallowing it', () => {
    const result = run("echo 'rate limited' >&2\nexit 7");
    expect(result.status).toBe(7);
    expect(result.stderr).toContain('is not a PASS');
  });

  it('passes real findings through on stdout and exits 0', () => {
    const result = run("echo '1. a finding at foo.ts:12'\nexit 0");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('a finding at foo.ts:12');
  });
});

describe('the agent never runs in the caller directory', () => {
  // `opencode run` has write tools; pointed at a checkout it edits files there.
  it('passes --dir, and not the cwd', () => {
    const result = run("echo findings\nexit 0");
    expect(result.opencodeArgs).toContain('--dir');
    expect(result.opencodeArgs).not.toContain(`--dir ${result.root} `);
  });

  it('honours PRECHECK_DIR when a throwaway checkout is supplied', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precheck-explicit-'));
    roots.push(dir);
    const result = run("echo findings\nexit 0", ['--pr', '1'], { PRECHECK_DIR: dir });
    expect(result.opencodeArgs).toContain(`--dir ${dir}`);
    expect(fs.existsSync(dir), 'a caller-supplied directory must not be deleted').toBe(true);
  });
});

describe('a truncated diff is announced even though output is now captured', () => {
  // The capture added for the empty-output check takes opencode's stdout and
  // stderr; the script's own warnings must still reach the terminal.
  it('warns on stderr when the diff does not fit the prompt budget', () => {
    // Budget 9000 minus the stub body minus the 2000-byte headroom leaves ~6.9KB
    // for a 9KB diff, so it truncates.
    const result = run("echo findings\nexit 0", ['--pr', '1'], { PRECHECK_PROMPT_BUDGET: '9000' }, 9000);
    expect(result.stderr).toContain('THIS PRE-CHECK SAW A PARTIAL DIFF');
    expect(result.status).toBe(0);
  });
});
