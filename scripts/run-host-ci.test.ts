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
 * refuses, and the statuses and comment it posts. The declared commands really
 * run (bash), so pass/fail is the declaration's own exit.
 */

const SCRIPT = path.resolve('container/skills/pr-review-loop/scripts/run-host-ci.sh');
const GATE = path.resolve('container/skills/pr-review-loop/scripts/codex-review.sh');
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BASE = 'cccccccccccccccccccccccccccccccccccccccc';
const COMMENT_URL = 'https://github.com/example/repository/pull/7#issuecomment-99';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

type Status = { state: string; context: string; description: string; sha: string; target_url: string };
function setup(
  opts: {
    declaration?: string | null;
    state?: string;
    fetched?: string;
    cross?: boolean | null;
    commentFails?: boolean;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-host-ci-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const tree = path.join(root, 'tree');
  const scratch = path.join(root, 'scratch');
  const shared = path.join(root, 'shared');
  fs.mkdirSync(bin);
  fs.mkdirSync(scratch);
  fs.mkdirSync(shared);
  fs.mkdirSync(path.join(tree, '.github'), { recursive: true });
  if (opts.declaration !== null)
    fs.writeFileSync(path.join(tree, '.github', 'host-ci.sh'), opts.declaration ?? 'set -euo pipefail\ntrue\n');
  fs.writeFileSync(
    path.join(root, 'pr.json'),
    JSON.stringify({
      state: opts.state ?? 'OPEN',
      headRefOid: HEAD,
      baseRefName: 'develop',
      baseRefOid: BASE,
      isCrossRepository: opts.cross === undefined ? false : opts.cross,
    }),
  );
  if (opts.commentFails) fs.writeFileSync(path.join(root, 'comment.fail'), '');
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\\n' "$*" >> "$MOCK_DIR/calls"
if [ "$1" = pr ] && [ "$2" = view ]; then cat "$MOCK_DIR/pr.json"; exit 0; fi
if [ "$1" = api ] && [ "$2" = -X ] && [ "$3" = POST ]; then
  case "$4" in
    */issues/*/comments)
      [ ! -f "$MOCK_DIR/comment.fail" ] || { echo 'gh: Server Error (HTTP 500)' >&2; exit 1; }
      body="\${6#body=@}"
      cp "$body" "$MOCK_DIR/comment.md"
      echo '${COMMENT_URL}'
      exit 0
      ;;
    */statuses/*)
      sha="\${4##*/}"; state=""; context=""; description=""; target=""
      shift 4
      while [ $# -gt 0 ]; do
        case "$2" in state=*) state="\${2#state=}" ;; context=*) context="\${2#context=}" ;; description=*) description="\${2#description=}" ;; target_url=*) target="\${2#target_url=}" ;; esac
        shift 2
      done
      jq -cn --arg s "$state" --arg c "$context" --arg d "$description" --arg sha "$sha" --arg t "$target" '{state:$s,context:$c,description:$d,sha:$sha,target_url:$t}' >> "$MOCK_DIR/statuses"
      exit 0
      ;;
  esac
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
  return { root, bin, scratch, shared, fetched: opts.fetched };
}

function run(
  ctx: ReturnType<typeof setup>,
  args: string[] = ['--pr', '7', '--repo', 'example/repository'],
  env: Record<string, string> = {},
) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: ctx.root,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${ctx.bin}:${process.env.PATH ?? ''}`,
      MOCK_DIR: ctx.root,
      HOST_CI_SCRATCH: ctx.scratch,
      HOST_CI_SHARED_DIR: ctx.shared,
      ...(ctx.fetched ? { MOCK_FETCHED: ctx.fetched } : {}),
      ...env,
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
  const commentFile = path.join(ctx.root, 'comment.md');
  const comment = fs.existsSync(commentFile) ? fs.readFileSync(commentFile, 'utf8') : null;
  return { ...result, statuses, calls, comment, scratchLeft: fs.readdirSync(ctx.scratch) };
}

const states = (statuses: Status[]) => statuses.map((s) => [s.context, s.state]);

describe('run-host-ci.sh', () => {
  it('posts the context merge-check reads', () => {
    const gate = fs.readFileSync(GATE, 'utf8');
    const runner = fs.readFileSync(SCRIPT, 'utf8');
    const context = /^HOST_CI_CONTEXT='([^']+)'$/m;
    expect(gate.match(context)?.[1]).toBe('CI (host)');
    expect(runner.match(context)?.[1]).toBe('CI (host)');
  });

  it('runs the declaration at the exact head and posts pending then success on that head, linked to its record', () => {
    const ctx = setup({
      declaration:
        'set -euo pipefail\n[ "$HOST_CI_HEAD" = ' +
        HEAD +
        ' ]\n[ "$HOST_CI_BASE_REF" = develop ]\n[ "$HOST_CI_BASE_SHA" = ' +
        BASE +
        ' ]\n[ -f .github/host-ci.sh ]\necho declared-output-line\n',
    });
    const result = run(ctx);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`host-ci=success repo=example/repository pr=7 head=${HEAD}`);
    expect(result.statuses.map((s) => [s.state, s.context, s.sha])).toEqual([
      ['pending', 'CI (host)', HEAD],
      ['success', 'CI (host)', HEAD],
    ]);
    expect(result.statuses[1].description).toMatch(/^\.github\/host-ci\.sh passed in \d+s on /);
    // The verdict links to the PR comment that records the run and its log.
    expect(result.statuses[1].target_url).toBe(COMMENT_URL);
    expect(result.comment).toContain(`<!-- run-host-ci head=${HEAD} verdict=success -->`);
    expect(result.comment).toContain('declared-output-line');
    const logs = fs.readdirSync(path.join(ctx.shared, 'host-ci-logs'));
    expect(logs).toHaveLength(1);
    expect(result.comment).toContain(path.join(ctx.shared, 'host-ci-logs', logs[0]));
    expect(fs.readFileSync(path.join(ctx.shared, 'host-ci-logs', logs[0]), 'utf8')).toContain('declared-output-line');
    expect(result.calls).toContain(`git -C ${ctx.scratch}/`);
    // Full history: a shallow clone makes review-notes.test.ts skip pinned citations.
    expect(result.calls).toContain(`fetch -q --no-tags https://github.com/example/repository.git ${HEAD}`);
    expect(result.calls).not.toContain('--depth');
    expect(result.scratchLeft).toEqual([]);
  });

  it('takes its lock in the shared directory, and falls back to TMPDIR when there is none', () => {
    const decl = 'set -euo pipefail\necho "vitest-lock=$HOST_CI_VITEST_LOCK"\n';
    const shared = setup({ declaration: decl });
    const inShared = run(shared);
    expect(inShared.status).toBe(0);
    expect(inShared.stderr).toContain(`waiting for ${path.join(shared.shared, 'host-ci.lock')}`);
    expect(inShared.stdout).toContain(`vitest-lock=${path.join(shared.shared, 'vitest.lock')}`);

    const none = setup({ declaration: decl });
    const tmp = path.join(none.root, 'tmp');
    fs.mkdirSync(tmp);
    const fallback = run(none, undefined, { HOST_CI_SHARED_DIR: '', TMPDIR: tmp });
    expect(fallback.status).toBe(0);
    expect(fallback.stderr).toContain(`waiting for ${path.join(tmp, 'host-ci.lock')}`);
    expect(fallback.stdout).toContain(`vitest-lock=${path.join(tmp, 'vitest.lock')}`);
  });

  it('still posts its verdict, unlinked, when the record comment cannot be posted', () => {
    const ctx = setup({ commentFails: true });
    const result = run(ctx);
    expect(result.status).toBe(0);
    expect(states(result.statuses)).toEqual([
      ['CI (host)', 'pending'],
      ['CI (host)', 'success'],
    ]);
    expect(result.statuses[1].target_url).toBe('');
  });

  it('posts failure when the declaration fails', () => {
    const ctx = setup({ declaration: 'set -euo pipefail\nexit 3\n' });
    const result = run(ctx);
    expect(result.status).toBe(1);
    expect(result.statuses.map((s) => s.state)).toEqual(['pending', 'failure']);
    expect(result.statuses[1].description).toContain('failed (exit 3)');
    expect(result.comment).toContain('verdict=failure');
    expect(result.scratchLeft).toEqual([]);
  });

  it('posts failure, never success, when it is interrupted between pending and a verdict', () => {
    // The declaration signals the top-level runner (the outermost ancestor
    // running run-host-ci.sh with this test's MOCK_DIR — never a shell above
    // the test that merely mentions the script) and then exits 0: bash runs the trap once the
    // declaration returns, before the success branch.
    const ctx = setup({
      declaration: `set -euo pipefail
p=$$ top=""
while [ "$p" -gt 1 ]; do
  if tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -qxF "MOCK_DIR=$MOCK_DIR" \\
    && tr '\\0' ' ' < /proc/$p/cmdline | grep -qF 'run-host-ci.sh'; then top=$p; fi
  p=$(awk '{print $4}' /proc/$p/stat)
done
kill -TERM "$top"
exit 0
`,
    });
    const result = run(ctx);
    expect(result.status).toBe(143);
    expect(states(result.statuses)).toEqual([
      ['CI (host)', 'pending'],
      ['CI (host)', 'failure'],
    ]);
    expect(result.statuses[1].description).toContain('did not finish (exit 143)');
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

  it('refuses a PR whose head is in another repository, before fetching anything', () => {
    const ctx = setup({ cross: true });
    const result = run(ctx);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('isCrossRepository=true');
    expect(result.calls).not.toContain('fetch');
    expect(result.statuses).toEqual([]);
  });

  it('refuses a PR whose origin GitHub does not report: only an explicit false runs', () => {
    const ctx = setup({ cross: null });
    const result = run(ctx);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('isCrossRepository=null');
    expect(result.calls).not.toContain('fetch');
    expect(result.statuses).toEqual([]);
  });

  it('does not wait on a background process the declaration left holding its output', () => {
    // Without the group kill, tee waits the full 300s for this sleep to close
    // the pipe, and spawnSync's 60s timeout kills the run (status null).
    const ctx = setup({ declaration: 'set -euo pipefail\nsleep 300 &\necho left-a-child\n' });
    const started = Date.now();
    const result = run(ctx);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('left-a-child');
    expect(Date.now() - started).toBeLessThan(30_000);
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

  describe('--dry-run', () => {
    it('runs the declaration, even on a merged PR, and posts nothing', () => {
      const ctx = setup({
        state: 'MERGED',
        declaration: 'set -euo pipefail\necho ran\n',
      });
      const result = run(ctx, ['--pr', '7', '--repo', 'example/repository', '--dry-run']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('ran');
      expect(result.stdout).toMatch(/host-ci=success .* dry-run=1 .*would-post="CI \(host\)"/);
      expect(result.statuses).toEqual([]);
      expect(result.comment).toBeNull();
      expect(result.calls).not.toContain('POST');
    });

    it('runs a declaration from HOST_CI_OVERLAY over a head that has none', () => {
      const ctx = setup({ state: 'MERGED', declaration: null });
      const overlay = path.join(ctx.root, 'overlay');
      fs.mkdirSync(path.join(overlay, '.github'), { recursive: true });
      fs.writeFileSync(path.join(overlay, '.github', 'host-ci.sh'), 'set -euo pipefail\necho overlaid\n');
      const result = run(ctx, ['--pr', '7', '--repo', 'example/repository', '--dry-run'], { HOST_CI_OVERLAY: overlay });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('overlaid');
      expect(result.statuses).toEqual([]);
    });

    it('refuses HOST_CI_OVERLAY without --dry-run, before fetching anything', () => {
      const ctx = setup();
      const result = run(ctx, undefined, { HOST_CI_OVERLAY: ctx.root });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('--dry-run only');
      expect(result.calls).toBe('');
      expect(result.statuses).toEqual([]);
    });

    it('reports a failing declaration with exit 1, still posting nothing', () => {
      const ctx = setup({ declaration: 'set -euo pipefail\nexit 4\n' });
      const result = run(ctx, ['--pr', '7', '--repo', 'example/repository', '--dry-run']);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('host-ci=failure');
      expect(result.statuses).toEqual([]);
    });
  });
});
