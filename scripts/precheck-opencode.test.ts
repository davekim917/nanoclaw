/**
 * The pre-check is the cheap pass that runs BEFORE a scarce reviewer round, so
 * its two failure modes are both "looks like it worked": a hang that never
 * returns, and a clean exit with nothing to show. Neither is visible from
 * reading the script — both were found by running it — so they are pinned here.
 *
 * Shell scripts are tested the way `codex-review.test.ts` tests its helper:
 * spawn bash with a stub `bin/` ahead of PATH, so nothing reaches the network.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

// `git` is spawned to build the fixture repositories the confinement tests
// need, and the script itself shells out to the real `git` for its
// inside-a-repository check — that check is the behaviour under test, so it is
// deliberately not stubbed.
allowSubprocess(['bash', 'git']);
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

describe('the confinement cannot evaporate silently', () => {
  // `--dir` is advisory: it removes the mechanism (our checkout stops being the
  // agent's project root), it does not confine the process. That makes the
  // project root the whole guarantee, so a scratch directory that happens to
  // sit inside a repository — via TMPDIR, or a wrong PRECHECK_DIR — hands the
  // agent that repository and nothing says so. Refuse instead.
  function repoDir() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'precheck-repo-'));
    roots.push(repo);
    const init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8', timeout: 20_000 });
    expect(init.status, init.stderr).toBe(0);
    return repo;
  }

  it('refuses a TMPDIR that puts the scratch dir inside a repository, leaving nothing behind', () => {
    const repo = repoDir();
    const before = fs.readdirSync(repo);
    const result = run("echo findings\nexit 0", ['--pr', '1'], { TMPDIR: repo });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('inside a git repository');
    expect(result.opencodeArgs, 'opencode must not have been started at all').toBeNull();
    // The refusal happens after mktemp, so the refusal path must clean up too.
    expect(fs.readdirSync(repo)).toEqual(before);
  });

  it('refuses a PRECHECK_DIR inside a repository', () => {
    const repo = repoDir();
    const inner = path.join(repo, 'nested');
    fs.mkdirSync(inner);
    const result = run("echo findings\nexit 0", ['--pr', '1'], { PRECHECK_DIR: inner });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('inside a git repository');
    expect(result.opencodeArgs).toBeNull();
  });

});

describe('the scratch directory is always removed', () => {
  it('removes it on the normal path', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'precheck-tmpdir-'));
    roots.push(tmp);
    const result = run("echo findings\nexit 0", ['--pr', '1'], { TMPDIR: tmp });
    expect(result.status).toBe(0);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  // Without the trap, a signal during a run that can last 900s leaked the
  // directory and whatever the agent had written into it. This has to signal
  // the real process — a stub that kills its own parent does not reach the
  // script (it runs inside a command substitution) and passes either way, which
  // is how the first version of this test managed to pass against a script with
  // the traps deleted.
  it('removes it when the run is killed by a signal', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'precheck-tmpdir-'));
    roots.push(tmp);
    // The sentinel lives outside TMPDIR so its existence does not count against
    // the emptiness assertion below.
    const { root, bin, argsFile } = tempRoot(
      `dir=$(printf '%s' "$*" | sed -n 's/.*--dir \\([^ ]*\\).*/\\1/p')\ntouch "$dir/agent-wrote-this"\ntouch "$SENTINEL"\nsleep 3\n`,
    );
    const sentinel = path.join(root, 'started');
    const child = spawn('bash', [SCRIPT, '--pr', '1'], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, OPENCODE_ARGS: argsFile, TMPDIR: tmp, SENTINEL: sentinel },
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(sentinel) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(fs.existsSync(sentinel), 'the stub never started').toBe(true);
    expect(fs.readdirSync(tmp), 'the scratch dir should exist while the run is live').not.toEqual([]);

    // Signal bash itself, mid-run. With a TERM trap set, bash defers it until
    // the foreground command returns and then cleans up; with no trap, bash
    // takes SIGTERM's default action and dies on the spot, leaving the
    // directory and the agent's file behind — which is the difference this
    // asserts.
    child.kill('SIGTERM');
    await exited;
    expect(fs.readdirSync(tmp), 'the scratch dir and the agent output in it must be gone').toEqual([]);
  }, 25_000);
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
