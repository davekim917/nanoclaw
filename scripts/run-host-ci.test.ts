import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

allowSubprocess(['bash']);
enforceHermeticity();

/**
 * run-host-ci.sh against a fake gh and git: which head it runs, what it
 * refuses, and the `CI (host)` statuses it posts. The declared commands really
 * run (bash), so pass/fail is the declaration's own exit.
 */

const SCRIPT = path.resolve('container/skills/pr-review-loop/scripts/run-host-ci.sh');
const GATE = path.resolve('container/skills/pr-review-loop/scripts/codex-review.sh');
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

type Status = { state: string; context: string; description: string; sha: string };

function setup(opts: { declaration?: string | null; state?: string; fetched?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-host-ci-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const tree = path.join(root, 'tree');
  const scratch = path.join(root, 'scratch');
  fs.mkdirSync(bin);
  fs.mkdirSync(scratch);
  fs.mkdirSync(path.join(tree, '.github'), { recursive: true });
  if (opts.declaration !== null)
    fs.writeFileSync(path.join(tree, '.github', 'host-ci.sh'), opts.declaration ?? 'set -euo pipefail\ntrue\n');
  fs.writeFileSync(path.join(root, 'pr.json'), JSON.stringify({ state: opts.state ?? 'OPEN', headRefOid: HEAD }));
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\\n' "$*" >> "$MOCK_DIR/calls"
if [ "$1" = pr ] && [ "$2" = view ]; then cat "$MOCK_DIR/pr.json"; exit 0; fi
if [ "$1" = api ] && [ "$2" = -X ] && [ "$3" = POST ]; then
  sha="\${4##*/}"; state=""; context=""; description=""
  shift 4
  while [ $# -gt 0 ]; do
    case "$2" in state=*) state="\${2#state=}" ;; context=*) context="\${2#context=}" ;; description=*) description="\${2#description=}" ;; esac
    shift 2
  done
  jq -cn --arg s "$state" --arg c "$context" --arg d "$description" --arg sha "$sha" '{state:$s,context:$c,description:$d,sha:$sha}' >> "$MOCK_DIR/statuses"
  exit 0
fi
echo "unexpected gh $*" >&2; exit 64
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\\n' "$*" >> "$MOCK_DIR/calls"
if [ "$1" = init ]; then mkdir -p "$3"; exit 0; fi
[ "$1" = -C ] || { echo "unexpected git $*" >&2; exit 64; }
dir="$2"; shift 2
case "$1" in
  fetch) exit 0 ;;
  -c) cp -r "$MOCK_DIR/tree/." "$dir/"; exit 0 ;;
  rev-parse) echo "\${MOCK_FETCHED:-${HEAD}}"; exit 0 ;;
esac
echo "unexpected git $*" >&2; exit 64
`,
    { mode: 0o755 },
  );
  return { root, bin, scratch, fetched: opts.fetched };
}

function run(ctx: ReturnType<typeof setup>, args: string[] = ['--pr', '7', '--repo', 'example/repository']) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: ctx.root,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${ctx.bin}:${process.env.PATH ?? ''}`,
      MOCK_DIR: ctx.root,
      HOST_CI_SCRATCH: ctx.scratch,
      HOST_CI_LOCK: path.join(ctx.root, 'host-ci.lock'),
      ...(ctx.fetched ? { MOCK_FETCHED: ctx.fetched } : {}),
    },
  });
  const statusFile = path.join(ctx.root, 'statuses');
  const statuses: Status[] = fs.existsSync(statusFile)
    ? fs
        .readFileSync(statusFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Status)
    : [];
  const calls = fs.existsSync(path.join(ctx.root, 'calls'))
    ? fs.readFileSync(path.join(ctx.root, 'calls'), 'utf8')
    : '';
  return { ...result, statuses, calls, scratchLeft: fs.readdirSync(ctx.scratch) };
}

describe('run-host-ci.sh', () => {
  it('posts the context merge-check reads', () => {
    const gate = fs.readFileSync(GATE, 'utf8');
    const runner = fs.readFileSync(SCRIPT, 'utf8');
    const context = /^HOST_CI_CONTEXT='([^']+)'$/m;
    expect(gate.match(context)?.[1]).toBe('CI (host)');
    expect(runner.match(context)?.[1]).toBe('CI (host)');
  });

  it('runs the declaration at the exact head and posts pending then success on that head', () => {
    const ctx = setup({
      declaration: 'set -euo pipefail\n[ "$HOST_CI_HEAD" = ' + HEAD + ' ]\n[ -f .github/host-ci.sh ]\n',
    });
    const result = run(ctx);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`host-ci=success repo=example/repository pr=7 head=${HEAD}`);
    expect(result.statuses.map((s) => [s.state, s.context, s.sha])).toEqual([
      ['pending', 'CI (host)', HEAD],
      ['success', 'CI (host)', HEAD],
    ]);
    expect(result.statuses[1].description).toMatch(/^\.github\/host-ci\.sh passed in \d+s on /);
    expect(result.calls).toContain(`git -C ${ctx.scratch}/`);
    expect(result.calls).toContain(`fetch -q --depth=1 --no-tags https://github.com/example/repository.git ${HEAD}`);
    expect(result.scratchLeft).toEqual([]);
  });

  it('posts failure when the declaration fails', () => {
    const ctx = setup({ declaration: 'set -euo pipefail\nexit 3\n' });
    const result = run(ctx);
    expect(result.status).toBe(1);
    expect(result.statuses.map((s) => s.state)).toEqual(['pending', 'failure']);
    expect(result.statuses[1].description).toContain('failed (exit 3)');
    expect(result.scratchLeft).toEqual([]);
  });

  it('refuses a repository with no declaration, posting nothing', () => {
    const ctx = setup({ declaration: null });
    const result = run(ctx);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('declares no host CI');
    expect(result.statuses).toEqual([]);
    expect(result.scratchLeft).toEqual([]);
  });

  it('refuses when the PR head is not --head, before fetching anything', () => {
    const ctx = setup();
    const result = run(ctx, ['--pr', '7', '--repo', 'example/repository', '--head', OTHER]);
    expect(result.status).toBe(12);
    expect(result.calls).not.toContain('fetch');
    expect(result.statuses).toEqual([]);
  });

  it('refuses when the fetched commit is not the head', () => {
    const ctx = setup({ fetched: OTHER });
    const result = run(ctx);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`fetched ${OTHER}, not ${HEAD}`);
    expect(result.statuses).toEqual([]);
  });

  it('refuses a PR that is not open', () => {
    const ctx = setup({ state: 'MERGED' });
    const result = run(ctx);
    expect(result.status).toBe(1);
    expect(result.statuses).toEqual([]);
  });

  it('refuses a short --head', () => {
    const ctx = setup();
    expect(run(ctx, ['--pr', '7', '--head', 'aaaaaaa']).status).toBe(2);
  });
});
