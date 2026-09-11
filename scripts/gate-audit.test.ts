import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

allowSubprocess(['bash']);
enforceHermeticity();

/**
 * .github/scripts/gate-audit.sh, main-provenance.yml's gate-audit jobs: for the PR a
 * push to main merged, or (--sweep) for every recent PR merge whose push-triggered
 * audit left no result, run `codex-review.sh audit` and file one `gate-bypass` issue
 * per PR it flags. `gh` and `git` are faked, `gh` over an issue store two runs can
 * share; so is the audit helper, whose own rules scripts/codex-review.test.ts covers.
 * The push mode's helper comes from CODEX_REVIEW; the sweep's from each merge
 * commit's tree, through `git archive`.
 */

const SCRIPT = path.resolve('.github/scripts/gate-audit.sh');
const SHA = '1234567890123456789012345678901234567890';
const sha = (c: string) => c.repeat(40);
const PROVENANCE = '.github/workflows/main-provenance.yml';
const roots: string[] = [];

interface Audit {
  status: number;
  out: string;
}

interface Job {
  name: string;
  status: string;
  conclusion: string | null;
}

interface Issue {
  number: number;
  state: string;
  body: string;
}

// One record in main's Activity API feed, and what GitHub knows about its commit.
interface Merge {
  sha: string;
  ageHours: number;
  type?: string;
  prs?: number[];
  carriesAudit?: boolean;
  runs?: { id: number; status: string; path?: string; jobs: Job[] }[];
}

interface Options {
  args?: string[];
  prs?: number[];
  merges?: Merge[];
  audits?: Record<number, Audit>;
  filed?: { number: number; body: string; state?: string }[];
  issueCreateFails?: boolean;
  relistFails?: boolean;
  // Each of two runs (CALLER a and b) waits at its already-filed check until both reach it.
  barrier?: boolean;
}

function pulls(prs: number[], merged: string) {
  return prs.map((number) => ({
    number,
    merged_at: '2026-09-11T18:43:58Z',
    base: { ref: 'main' },
    merge_commit_sha: merged,
  }));
}

function job(name: string, status: string, conclusion: string | null = null): Job {
  return { name, status, conclusion };
}

// A temp dir holding the fakes and the fixtures they answer from, and the env to run in.
function fixture(opts: Options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-audit-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, 'issues'));
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  write(`pulls-${SHA}.json`, pulls(opts.prs ?? [], SHA));
  for (const issue of opts.filed ?? [])
    write(`issues/${issue.number}.json`, { number: issue.number, state: issue.state ?? 'open', body: issue.body });
  if (opts.issueCreateFails) fs.writeFileSync(path.join(root, 'issue-create-fails'), '');
  if (opts.relistFails) fs.writeFileSync(path.join(root, 'relist-fails'), '');
  if (opts.barrier) fs.writeFileSync(path.join(root, 'barrier'), '');
  for (const [pr, result] of Object.entries(opts.audits ?? {})) {
    fs.writeFileSync(path.join(root, `audit-${pr}.out`), result.out);
    fs.writeFileSync(path.join(root, `audit-${pr}.status`), String(result.status));
  }
  // A helper that logs whose rules it is, then answers from audit-<pr>.*.
  const helper = (rules: string) => `#!/usr/bin/env bash
printf 'audit pr=%s rules=%s %s\\n' "$PR" "${rules}" "$*" >> "$MOCK_DIR/calls"
cat "$MOCK_DIR/audit-$PR.out"
exit "$(cat "$MOCK_DIR/audit-$PR.status")"
`;
  const now = Date.now();
  write(
    'activity.json',
    (opts.merges ?? []).map((m) => ({
      activity_type: m.type ?? 'pr_merge',
      after: m.sha,
      ref: 'refs/heads/main',
      timestamp: new Date(now - m.ageHours * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    })),
  );
  for (const m of opts.merges ?? []) {
    write(`pulls-${m.sha}.json`, pulls(m.prs ?? [], m.sha));
    // The merge commit's tree: its copy of the skill, and gate-audit.sh unless it predates it.
    const scripts = path.join(root, `tree-${m.sha}`, 'container/skills/pr-review-loop/scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'codex-review.sh'), helper(m.sha), { mode: 0o755 });
    if (m.carriesAudit ?? true) {
      fs.mkdirSync(path.join(root, `tree-${m.sha}`, '.github/scripts'), { recursive: true });
      fs.writeFileSync(path.join(root, `tree-${m.sha}`, '.github/scripts/gate-audit.sh'), '');
    }
    write(`runs-${m.sha}.json`, {
      workflow_runs: (m.runs ?? []).map((r) => ({ id: r.id, status: r.status, path: r.path ?? PROVENANCE })),
    });
    for (const r of m.runs ?? []) write(`jobs-${r.id}.json`, { total_count: r.jobs.length, jobs: r.jobs });
  }
  // Issues live one per file in issues/, numbered from 900 under a lock, so two runs
  // filing at once get distinct numbers and see each other's issues.
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\\n' "$*" >> "$MOCK_DIR/calls"
issues="$MOCK_DIR/issues"
list_issues() {
  local files=("$issues"/*.json)
  if [ ! -e "\${files[0]}" ]; then echo '[]'; return 0; fi
  jq -s --arg state "$1" '[ .[] | select($state == "all" or .state == $state) ]' "\${files[@]}"
}
case "$1 $2" in
  "label create") exit 0 ;;
  "issue create")
    if [ -f "$MOCK_DIR/issue-create-fails" ]; then echo 'gh: HTTP 403' >&2; exit 1; fi
    title="" label="" body=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --title) title="$2" ;;
        --label) label="$2" ;;
        --body) body="$2" ;;
      esac
      shift
    done
    printf '%s' "$title" > "$MOCK_DIR/issue-title"
    printf '%s' "$label" > "$MOCK_DIR/issue-label"
    printf '%s' "$body" > "$MOCK_DIR/issue-body"
    until mkdir "$MOCK_DIR/lock" 2>/dev/null; do /bin/sleep 0.01; done
    n=$(cat "$MOCK_DIR/next-issue" 2>/dev/null || echo 900)
    echo $((n + 1)) > "$MOCK_DIR/next-issue"
    rmdir "$MOCK_DIR/lock"
    jq -n --argjson n "$n" --arg body "$body" '{ number: $n, state: "open", body: $body }' > "$issues/$n.json"
    echo "https://github.com/example/repository/issues/$n"
    exit 0
    ;;
  "issue close")
    n="$3" comment=""
    while [ $# -gt 0 ]; do
      if [ "$1" = --comment ]; then comment="$2"; fi
      shift
    done
    printf 'closed #%s: %s\\n' "$n" "$comment" >> "$MOCK_DIR/closed"
    jq '.state = "closed"' "$issues/$n.json" > "$issues/.$n.$$"
    mv "$issues/.$n.$$" "$issues/$n.json"
    exit 0
    ;;
esac
rest=""
for arg in "$@"; do case "$arg" in repos/*) rest="$arg" ;; esac; done
case "$rest" in
  repos/example/repository/commits/*/pulls)
    commit="\${rest#*/commits/}"
    cat "$MOCK_DIR/pulls-\${commit%%/*}.json"
    ;;
  repos/example/repository/issues\\?*)
    state="\${rest#*state=}"
    state="\${state%%&*}"
    if [ "$state" = all ] && [ -f "$MOCK_DIR/barrier" ] && [ ! -e "$MOCK_DIR/arrived-\${CALLER:-}" ]; then
      touch "$MOCK_DIR/arrived-\${CALLER:-}"
      for _ in $(seq 1 400); do
        if [ "$(find "$MOCK_DIR" -maxdepth 1 -name 'arrived-*' | wc -l)" -ge 2 ]; then break; fi
        /bin/sleep 0.025
      done
    fi
    if [ "$state" = open ] && [ -f "$MOCK_DIR/relist-fails" ]; then echo 'gh: HTTP 502' >&2; exit 1; fi
    list_issues "$state"
    ;;
  repos/example/repository/activity\\?*) cat "$MOCK_DIR/activity.json" ;;
  repos/example/repository/actions/runs\\?head_sha=*)
    commit="\${rest#*head_sha=}"
    cat "$MOCK_DIR/runs-\${commit%%&*}.json"
    ;;
  repos/example/repository/actions/runs/*/jobs\\?*)
    id="\${rest#*/actions/runs/}"
    cat "$MOCK_DIR/jobs-\${id%%/*}.json"
    ;;
  *) echo "unexpected gh $*" >&2; exit 64 ;;
esac
`,
    { mode: 0o755 },
  );
  // git answers from tree-<sha>: whether the commit and a path in it exist, and an archive of a path.
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\\n' "$*" >> "$MOCK_DIR/calls"
[ "$1" = -C ] && shift 2
case "$1" in
  cat-file)
    ref="$3"
    commit="\${ref%%[:^]*}"
    [ -d "$MOCK_DIR/tree-$commit" ] || exit 1
    case "$ref" in
      *:*) [ -e "$MOCK_DIR/tree-$commit/\${ref#*:}" ] ;;
    esac
    ;;
  archive) tar -c -C "$MOCK_DIR/tree-$2" "$3" ;;
  *) echo "unexpected git $*" >&2; exit 64 ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const pushHelper = path.join(root, 'codex-review.sh');
  fs.writeFileSync(pushHelper, helper('checkout'), { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    REPO: 'example/repository',
    GH_TOKEN: 'unused',
    MOCK_DIR: root,
    CODEX_REVIEW: pushHelper,
  };
  return { root, env };
}

function read(root: string, name: string): string | null {
  return fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name), 'utf8') : null;
}

function issuesIn(root: string): Issue[] {
  return fs
    .readdirSync(path.join(root, 'issues'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(root, 'issues', name), 'utf8')) as Issue)
    .sort((a, b) => a.number - b.number);
}

function gateAudit(opts: Options) {
  const { root, env } = fixture(opts);
  const result = spawnSync('bash', [SCRIPT, ...(opts.args ?? [SHA])], { cwd: root, encoding: 'utf8', env });
  return {
    ...result,
    calls: read(root, 'calls') ?? '',
    title: read(root, 'issue-title'),
    label: read(root, 'issue-label'),
    body: read(root, 'issue-body'),
    issues: issuesIn(root),
  };
}

const VIOLATION =
  "audit=violation pr=675 head=2e262d8a0 base=f2189f64e merged=2026-09-11T18:43:58Z verdict=skip: a fix PR merged with no 'Fixes-PR:' line in its body at merge time";

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('gate-audit.sh', () => {
  it('files one gate-bypass issue, carrying the finding and its marker, for a PR the audit flags', () => {
    const result = gateAudit({ prs: [675], audits: { 675: { status: 28, out: VIOLATION } } });
    expect(result.status).toBe(0);
    expect(result.calls).toContain('audit pr=675 rules=checkout audit');
    expect(result.calls).toMatch(/^gh label create gate-bypass --repo example\/repository --force /m);
    expect(result.title).toBe("Gate bypass: #675 merged without the merge gate's evidence");
    expect(result.label).toBe('gate-bypass');
    expect(result.body).toContain(VIOLATION);
    expect(result.body).toMatch(/<!-- gate-bypass pr=675 -->$/);
    expect(result.stdout).toContain('::warning::#675 merged without the merge gate');
    expect(result.issues.map((i) => [i.number, i.state])).toEqual([[900, 'open']]);
  });

  it('never files a second issue for a PR already filed, whatever state that issue is in', () => {
    const result = gateAudit({
      prs: [675],
      audits: { 675: { status: 28, out: VIOLATION } },
      filed: [
        { number: 812, body: 'first finding\n\n<!-- gate-bypass pr=674 -->' },
        { number: 813, body: 'first finding\n\n<!-- gate-bypass pr=675 -->', state: 'closed' },
      ],
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('#675 is already filed as #813');
    expect(result.calls).not.toContain('gh issue create');
  });

  it("does not take another PR's issue for this one's", () => {
    const result = gateAudit({
      prs: [675],
      audits: { 675: { status: 28, out: VIOLATION } },
      filed: [{ number: 812, body: '<!-- gate-bypass pr=6750 --> <!-- gate-bypass pr=67 -->' }],
    });
    expect(result.status).toBe(0);
    expect(result.calls).toContain('gh issue create');
    expect(result.calls).not.toContain('gh issue close');
  });

  it('leaves exactly one issue open when two runs pass the already-filed check together and both file', () => {
    const { root, env } = fixture({ prs: [675], audits: { 675: { status: 28, out: VIOLATION } }, barrier: true });
    const result = spawnSync(
      'bash',
      [
        '-c',
        `CALLER=a bash "$SCRIPT" "$SHA" > "$MOCK_DIR/out-a" 2>&1 & a=$!
CALLER=b bash "$SCRIPT" "$SHA" > "$MOCK_DIR/out-b" 2>&1 & b=$!
wait "$a"; ra=$?; wait "$b"; rb=$?
echo "$ra $rb"`,
      ],
      { cwd: root, encoding: 'utf8', env: { ...env, SCRIPT, SHA } },
    );
    expect(result.stdout.trim()).toBe('0 0');
    // Both got past the already-filed check before either filed.
    expect(fs.readdirSync(root).filter((name) => name.startsWith('arrived-'))).toHaveLength(2);
    const issues = issuesIn(root);
    expect(issues.map((i) => i.number)).toEqual([900, 901]);
    expect(issues.filter((i) => i.state === 'open').map((i) => i.number)).toEqual([900]);
    expect(read(root, 'closed')).toContain(
      'closed #901: Duplicate of #900: both were filed for #675 at the same time.',
    );
  });

  it('fails the job when it cannot re-list the issues after filing, since a duplicate may be left open', () => {
    const result = gateAudit({ prs: [675], audits: { 675: { status: 28, out: VIOLATION } }, relistFails: true });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      '::error::filed https://github.com/example/repository/issues/900 for #675, but could not re-list gate-bypass issues',
    );
  });

  it.each([
    ['passes', { status: 0, out: 'audit=pass pr=675 head=h base=b merged=t verdict=skip: no risky file' }],
    ['was a legacy repo', { status: 0, out: 'audit=legacy pr=675 head=h base=b merged=t: not risk-scoped' }],
  ])('files nothing for a PR that %s', (_case, result) => {
    const run = gateAudit({ prs: [675], audits: { 675: result } });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(result.out);
    expect(run.calls).not.toMatch(/gh (label|issue) create/);
  });

  it('fails the job loudly, filing nothing, when the audit cannot judge the merge', () => {
    const result = gateAudit({ prs: [675], audits: { 675: { status: 1, out: '' } } });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::the gate audit could not judge #675 (exit 1)');
    expect(result.calls).not.toMatch(/gh (label|issue) create/);
  });

  it('fails the job loudly when the issue cannot be filed', () => {
    const result = gateAudit({ prs: [675], audits: { 675: { status: 28, out: VIOLATION } }, issueCreateFails: true });
    expect(result.status).toBe(1);
  });

  it('fails the job loudly for a push no merged PR is linked to, after waiting for the link', () => {
    const result = gateAudit({ prs: [] });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`::error::${SHA} is no merged PR's merge commit after two minutes`);
    expect(result.calls.match(/^gh api repos\/example\/repository\/commits\/\S+\/pulls$/gm)).toHaveLength(13);
    expect(result.calls).not.toContain('audit pr=');
  });

  it('audits every PR the push merged, and fails if any one cannot be judged', () => {
    const result = gateAudit({
      prs: [675, 676],
      audits: { 675: { status: 28, out: VIOLATION }, 676: { status: 1, out: '' } },
    });
    expect(result.status).toBe(1);
    expect(result.calls).toContain('audit pr=675 rules=checkout audit');
    expect(result.calls).toContain('audit pr=676 rules=checkout audit');
    expect(result.calls).toContain('gh issue create');
  });
});

describe('gate-audit.sh --sweep, the daily backstop', () => {
  it('audits a PR merge whose push-triggered audit never ran, by the rules its merge commit carries', () => {
    const result = gateAudit({
      args: ['--sweep', '50'],
      merges: [{ sha: SHA, ageHours: 3, prs: [675] }],
      audits: { 675: { status: 28, out: VIOLATION } },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${SHA}: its push-triggered gate audit left no result; auditing it here`);
    expect(result.calls).toContain(`audit pr=675 rules=${SHA} audit`);
    expect(result.calls).not.toContain('rules=checkout');
    expect(result.title).toBe("Gate bypass: #675 merged without the merge gate's evidence");
    expect(result.body).toMatch(/<!-- gate-bypass pr=675 -->$/);
  });

  it.each([
    ['was cancelled', [{ id: 11, status: 'completed', jobs: [job('gate-audit', 'completed', 'cancelled')] }]],
    ['failed', [{ id: 11, status: 'completed', jobs: [job('gate-audit', 'completed', 'failure')] }]],
    [
      'passed only in some other workflow',
      [
        {
          id: 11,
          status: 'completed',
          path: '.github/workflows/ci.yml',
          jobs: [job('gate-audit', 'completed', 'success')],
        },
      ],
    ],
  ])('re-audits a merge whose push-triggered audit %s', (_case, runs) => {
    const result = gateAudit({
      args: ['--sweep'],
      merges: [{ sha: SHA, ageHours: 3, prs: [675], runs }],
      audits: { 675: { status: 0, out: 'audit=pass pr=675' } },
    });
    expect(result.status).toBe(0);
    expect(result.calls).toContain(`audit pr=675 rules=${SHA} audit`);
  });

  it('leaves a merge to its own push-triggered audit when that finished green or is still running', () => {
    const result = gateAudit({
      args: ['--sweep'],
      merges: [
        {
          sha: sha('a'),
          ageHours: 3,
          prs: [1],
          runs: [
            { id: 11, status: 'completed', jobs: [job('gate-audit', 'completed', 'failure')] },
            {
              id: 12,
              status: 'completed',
              jobs: [job('provenance', 'completed', 'success'), job('gate-audit', 'completed', 'success')],
            },
          ],
        },
        {
          sha: sha('b'),
          ageHours: 3,
          prs: [2],
          runs: [{ id: 13, status: 'in_progress', jobs: [job('gate-audit', 'queued')] }],
        },
        { sha: sha('c'), ageHours: 3, prs: [3], runs: [{ id: 14, status: 'queued', jobs: [] }] },
      ],
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${sha('a')}: its push-triggered gate audit finished`);
    expect(result.stdout).toContain(`${sha('b')}: its push-triggered gate audit is still running`);
    expect(result.stdout).toContain(`${sha('c')}: its push-triggered gate audit is still running`);
    expect(result.calls).not.toContain('audit pr=');
  });

  it('looks only at PR merges from an hour to the window ago, and skips merges from before the audit existed', () => {
    const result = gateAudit({
      args: ['--sweep', '50'],
      merges: [
        { sha: sha('a'), ageHours: 0.5, prs: [1] },
        { sha: sha('b'), ageHours: 60, prs: [2] },
        { sha: sha('c'), ageHours: 3, prs: [3], type: 'push' },
        { sha: sha('d'), ageHours: 3, prs: [4], carriesAudit: false },
      ],
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('checking 1 PR merge(s)');
    expect(result.stdout).toContain(`${sha('d')} predates the gate audit`);
    expect(result.calls).not.toContain('audit pr=');
    expect(result.calls).not.toContain('actions/runs');
  });

  it('fails the sweep loudly, after auditing the rest, when one merge cannot be judged', () => {
    const result = gateAudit({
      args: ['--sweep'],
      merges: [
        { sha: sha('a'), ageHours: 3, prs: [1] },
        { sha: sha('b'), ageHours: 4, prs: [2] },
      ],
      audits: { 1: { status: 1, out: '' }, 2: { status: 28, out: VIOLATION } },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::the gate audit could not judge #1 (exit 1)');
    expect(result.calls).toContain('gh issue create');
  });

  it.each([['0'], ['169'], ['two']])('refuses a window of %s hours, reading nothing', (hours) => {
    const result = gateAudit({ args: ['--sweep', hours] });
    expect(result.status).toBe(2);
    expect(result.calls).toBe('');
  });
});
