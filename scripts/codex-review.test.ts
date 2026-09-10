import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

allowSubprocess(['bash']);
enforceHermeticity();

const roots: string[] = [];
const HELPER = path.resolve('container/skills/pr-review-loop/scripts/codex-review.sh');
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SINCE = '2026-09-05T00:00:00Z';
const REVIEWER = 'chatgpt-codex-connector';
const USAGE_LIMIT_NOTICE =
  'You have reached your Codex usage limits for code reviews. You can see your limits in the Codex usage dashboard.';
const CREDITS_REQUIRED_NOTICE =
  'Codex usage limits have been reached for code reviews. Please check with the admins of this repo to increase the limits by adding credits.\nCredits must be used to enable repository wide code reviews.';

type Page = Record<string, unknown>;

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-'));
  roots.push(root);
  return root;
}

function connectionPage(
  connection: string,
  nodes: unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
  headRefOid = HEAD,
): Page {
  return {
    data: {
      repository: {
        pullRequest: {
          headRefOid,
          [connection]: { pageInfo: { hasNextPage, endCursor }, nodes },
        },
      },
    },
  };
}

function thread(isResolved: boolean, reviewId = 'review-1'): Page {
  return {
    isResolved,
    comments: { nodes: [{ author: { login: REVIEWER }, pullRequestReview: { id: reviewId } }] },
  };
}

function review(submittedAt: string, commit = HEAD, body = ''): Page {
  return { author: { login: REVIEWER }, submittedAt, body, commit: { oid: commit } };
}

function reaction(createdAt: string): Page {
  return { content: 'THUMBS_UP', createdAt, user: { login: REVIEWER } };
}

function comment(createdAt: string, body: string, login = REVIEWER): Page {
  return { author: { login }, createdAt, body };
}

function writePage(root: string, connection: string, page: number, value: Page): void {
  fs.writeFileSync(path.join(root, `${connection}-${page}.json`), JSON.stringify(value));
}

function writeMocks(root: string): { bin: string; calls: string; sleepLog: string; dateValues: string } {
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'calls');
  const sleepLog = path.join(root, 'sleep');
  const dateValues = path.join(root, 'dates');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = pr ]; then
  printf 'pr %s\\n' "$2" >> "$MOCK_CALLS"
  if [ "$2" = view ]; then
    n=$(grep -c '^pr view$' "$MOCK_CALLS")
    if [ -f "$MOCK_DIR/pr-$n.json" ]; then cat "$MOCK_DIR/pr-$n.json"; else cat "$MOCK_DIR/pr.json"; fi
  elif [ "$2" = comment ]; then
    while [ $# -gt 0 ]; do
      if [ "$1" = --body ]; then printf '%s' "$2" > "$MOCK_DIR/posted"; fi
      shift
    done
    echo "https://github.com/example/repository/pull/1#issuecomment-1"
  fi
  exit 0
fi
rest=""
for arg in "$@"; do
  case "$arg" in repos/*) rest="$arg" ;; esac
done
if [ -n "$rest" ]; then
  printf 'rest %s\\n' "$rest" >> "$MOCK_CALLS"
  case "$rest" in
    */contents/.github/labeler.yml\\?ref=*)
      config="$MOCK_DIR/labeler--\${rest##*ref=}.yml"
      if [ -f "$config" ]; then cat "$config"; exit 0; fi
      echo '{"message":"Not Found","status":"404"}'
      echo 'gh: Not Found (HTTP 404)' >&2
      exit 1
      ;;
    */actions/runs\\?*)
      if printf '%s\\n' "$@" | grep -qx -- --slurp; then printf '['; cat "$MOCK_DIR/runs.json"; printf ']'; else cat "$MOCK_DIR/runs.json"; fi
      exit 0
      ;;
    */commits/*/statuses\\?*)
      sha="\${rest#*/commits/}"
      sha="\${sha%%/*}"
      printf '['
      if [ -f "$MOCK_DIR/statuses--$sha.json" ]; then cat "$MOCK_DIR/statuses--$sha.json"; else printf '[]'; fi
      printf ']'
      exit 0
      ;;
  esac
  echo "unexpected REST path $rest" >&2
  exit 64
fi
query=""
after="null"
for arg in "$@"; do
  case "$arg" in
    query=*) query="\${arg#query=}" ;;
    after=*) after="\${arg#after=}" ;;
  esac
done
case "$query" in
  *reviewThreads*) connection=reviewThreads ;;
  *reviews*) connection=reviews ;;
  *reactions*) connection=reactions ;;
  *comments*) connection=comments ;;
  *) echo "unexpected GraphQL query" >&2; exit 64 ;;
esac
page=1
[ "$after" = "null" ] || page=2
printf '%s %s\\n' "$connection" "$after" >> "$MOCK_CALLS"
if [ "$connection" = "reviewThreads" ] && [ -f "$MOCK_DIR/threads-after-review.json" ] && grep -q '^reviews ' "$MOCK_CALLS"; then
  cat "$MOCK_DIR/threads-after-review.json"
else
  cat "$MOCK_DIR/$connection-$page.json"
fi
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'sleep'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MOCK_SLEEP_LOG"
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'date'),
    `#!/usr/bin/env bash
set -euo pipefail
value=$(head -n 1 "$MOCK_DATE_VALUES")
sed -i '1d' "$MOCK_DATE_VALUES"
printf '%s\\n' "$value"
`,
    { mode: 0o755 },
  );
  return { bin, calls, sleepLog, dateValues };
}

function run(root: string, command: string, minutes?: string, sha = HEAD) {
  const comments = path.join(root, 'comments-1.json');
  if (!fs.existsSync(comments)) {
    const reviewPage = JSON.parse(fs.readFileSync(path.join(root, 'reviews-1.json'), 'utf8')) as {
      data: { repository: { pullRequest: { headRefOid: string } } };
    };
    const headRefOid = reviewPage.data.repository.pullRequest.headRefOid;
    writePage(root, 'comments', 1, connectionPage('comments', [], false, null, headRefOid));
  }
  const { bin, calls, sleepLog, dateValues } = writeMocks(root);
  fs.writeFileSync(dateValues, '0\n0\n0\n60\n60\n');
  const result = spawnSync('bash', [HELPER, command, sha, SINCE, ...(minutes ? [minutes] : [])], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      REPO: 'example/repository',
      PR: '1',
      MOCK_DIR: root,
      MOCK_CALLS: calls,
      MOCK_SLEEP_LOG: sleepLog,
      MOCK_DATE_VALUES: dateValues,
    },
  });
  return {
    ...result,
    calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '',
    sleep: fs.existsSync(sleepLog) ? fs.readFileSync(sleepLog, 'utf8') : '',
  };
}

const OLD_HEAD = 'cccccccccccccccccccccccccccccccccccccccc';
const OTHER_HEAD = 'dddddddddddddddddddddddddddddddddddddddd';
const RISK_CONFIG = "risk:high:\n- changed-files:\n  - any-glob-to-any-file:\n    - 'src/router.ts'\n";

function writeJson(root: string, name: string, value: unknown): void {
  fs.writeFileSync(path.join(root, name), JSON.stringify(value));
}

function prState(labels: string[], head = HEAD): Page {
  return { headRefOid: head, baseRefName: 'main', headRefName: 'feat', labels: labels.map((name) => ({ name })) };
}

function labelRun(status: string, conclusion: string | null, head = HEAD, name = 'Risk label'): Page {
  return {
    id: 1,
    name,
    event: 'pull_request_target',
    head_sha: head,
    status,
    conclusion,
    created_at: '2026-09-05T00:00:30Z',
  };
}

function marker(head: string, round: number, createdAt = '2026-09-05T00:05:00Z'): Page {
  return comment(
    createdAt,
    `@codex review\n\n<!-- pr-review-loop:request head=${head} round=${round} -->`,
    'davekim917',
  );
}

// An Actions run of one workflow on a head, as `actions/runs?head_sha=` lists it.
function workflowRun(
  name: string,
  status: string,
  conclusion: string | null,
  startedAt = '2026-09-05T00:01:00Z',
  head = HEAD,
): Page {
  return {
    id: Date.parse(startedAt) / 1000,
    name,
    event: 'pull_request',
    head_sha: head,
    status,
    conclusion,
    created_at: startedAt,
    run_started_at: startedAt,
  };
}

function commitStatus(context: string, state: string, createdAt = '2026-09-05T00:02:00Z'): Page {
  return { id: Date.parse(createdAt) / 1000, context, state, created_at: createdAt };
}

function receiptComment(head: string, outcome: string, createdAt: string, authorAssociation = 'OWNER'): Page {
  return {
    author: { login: 'davekim917' },
    authorAssociation,
    createdAt,
    body: `### Substitute review receipt\n\n- **Outcome:** ${outcome}\n\n<!-- pr-review-loop:substitute-receipt head=${head} outcome=${outcome} -->`,
  };
}

// findings_json (the gate's payload) reads totalCount, which connectionPage omits.
function threadsPage(nodes: unknown[]): Page {
  return {
    data: {
      repository: {
        pullRequest: {
          headRefOid: HEAD,
          reviewThreads: { totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes },
        },
      },
    },
  };
}

// One PR: its base-branch labeler config (null = absent), the Risk label runs
// the Actions API returns, its labels, and every GraphQL connection.
function scopeFixture(
  root: string,
  opts: {
    labels?: string[];
    baseConfig?: string | null;
    runs?: Page[];
    ci?: Page[];
    statuses?: Page[];
    comments?: Page[];
    reviews?: Page[];
    reactions?: Page[];
    threads?: Page[];
  } = {},
): void {
  writeJson(root, 'pr.json', prState(opts.labels ?? []));
  if (opts.baseConfig !== null) fs.writeFileSync(path.join(root, 'labeler--main.yml'), opts.baseConfig ?? RISK_CONFIG);
  // One Actions listing serves both readers, as the API does: the Risk label
  // runs `scope` waits on, and the CI runs `merge-check` requires green.
  const runs = [
    ...(opts.runs ?? [labelRun('completed', 'success')]),
    ...(opts.ci ?? [workflowRun('CI', 'completed', 'success')]),
  ];
  writeJson(root, 'runs.json', { total_count: runs.length, workflow_runs: runs });
  writeJson(root, `statuses--${HEAD}.json`, opts.statuses ?? []);
  writePage(root, 'comments', 1, connectionPage('comments', opts.comments ?? []));
  writePage(root, 'reviews', 1, connectionPage('reviews', opts.reviews ?? []));
  writePage(root, 'reactions', 1, connectionPage('reactions', opts.reactions ?? []));
  writePage(root, 'reviewThreads', 1, threadsPage(opts.threads ?? []));
}

// Runs the helper with any arguments. Each run starts a fresh call log, clock,
// and posted-comment slot, so assertions describe that run alone. `node` is a
// stub for the churn classifier (exit MOCK_GATE_STATUS), and the clock advances
// one second per `date` call so a tiny scope timeout expires deterministically.
function runHelper(root: string, args: string[], env: Record<string, string> = {}) {
  const { bin, calls, sleepLog } = writeMocks(root);
  const posted = path.join(root, 'posted');
  const clock = path.join(root, 'clock');
  for (const file of [calls, sleepLog, posted, clock]) fs.rmSync(file, { force: true });
  fs.writeFileSync(
    path.join(bin, 'date'),
    `#!/usr/bin/env bash
n=$(cat "$MOCK_CLOCK" 2>/dev/null || echo 0)
echo $((n + 1)) > "$MOCK_CLOCK"
echo "$n"
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'node'),
    `#!/usr/bin/env bash
cat >/dev/null
printf 'node %s\\n' "$*" >> "$MOCK_CALLS"
echo '{"status":"pass"}'
exit "\${MOCK_GATE_STATUS:-0}"
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/usr/bin/env bash
if [ "$*" = "rev-parse --show-toplevel" ]; then pwd; exit 0; fi
echo "unexpected git $*" >&2
exit 64
`,
    { mode: 0o755 },
  );
  const result = spawnSync('bash', [HELPER, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      REPO: 'example/repository',
      PR: '1',
      MOCK_DIR: root,
      MOCK_CALLS: calls,
      MOCK_SLEEP_LOG: sleepLog,
      MOCK_CLOCK: clock,
      CODEX_REVIEW_SCOPE_TIMEOUT_SECONDS: '2',
      CODEX_REVIEW_SCOPE_POLL_SECONDS: '1',
      REVIEW_ROUND_CAP: '',
      CODEX_REVIEW_REQUIRED_WORKFLOWS: '',
      ...env,
    },
  });
  return {
    ...result,
    calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '',
    sleep: fs.existsSync(sleepLog) ? fs.readFileSync(sleepLog, 'utf8') : '',
    posted: fs.existsSync(posted) ? fs.readFileSync(posted, 'utf8') : null,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('codex-review status and foreground wait', () => {
  it('paginates all GraphQL connections and ignores stale review and reaction evidence', () => {
    const root = tempRoot();
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', [thread(true)], true, 'threads-2'));
    writePage(root, 'reviewThreads', 2, connectionPage('reviewThreads', [thread(true, 'review-2')]));
    writePage(root, 'reviews', 1, connectionPage('reviews', [review('2026-09-04T23:59:59Z')], true, 'reviews-2'));
    writePage(root, 'reviews', 2, connectionPage('reviews', [review('2026-09-05T00:01:00Z')]));
    writePage(
      root,
      'reactions',
      1,
      connectionPage('reactions', [reaction('2026-09-04T23:59:59Z')], true, 'reactions-2'),
    );
    writePage(root, 'reactions', 2, connectionPage('reactions', [reaction('2026-09-05T00:02:00Z')]));

    const result = run(root, 'status');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`codex=clean head=${HEAD} open=0 review=1 last_review_at=2026-09-05T00:01:00Z`);
    expect(result.stdout).toContain('reaction=1 last_thumbs_up_at=2026-09-05T00:02:00Z rounds=2');
    expect(result.calls).toContain('reviewThreads threads-2');
    expect(result.calls).toContain('reviews reviews-2');
    expect(result.calls).toContain('reactions reactions-2');
  });

  it('includes findings published with a review between the separate GraphQL requests', () => {
    const root = tempRoot();
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', []));
    writePage(root, 'reviews', 1, connectionPage('reviews', [review('2026-09-05T00:01:00Z')]));
    writePage(root, 'reactions', 1, connectionPage('reactions', []));
    fs.writeFileSync(
      path.join(root, 'threads-after-review.json'),
      JSON.stringify(connectionPage('reviewThreads', [thread(false)])),
    );

    const result = run(root, 'wait', '1');
    expect(result.status).toBe(10);
    expect(result.stdout).toContain(`codex=findings head=${HEAD} open=1 review=1`);
    expect(result.stdout).not.toContain('codex=clean');
  });

  it('reports unresolved Codex threads as findings even when they are from an older round', () => {
    const root = tempRoot();
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', [thread(false)]));
    writePage(root, 'reviews', 1, connectionPage('reviews', [review('2026-09-04T23:59:59Z')]));
    writePage(root, 'reactions', 1, connectionPage('reactions', [reaction('2026-09-04T23:59:59Z')]));

    const result = run(root, 'status');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `codex=findings head=${HEAD} open=1 review=0 last_review_at=2026-09-04T23:59:59Z reaction=0 last_thumbs_up_at=2026-09-04T23:59:59Z`,
    );
  });

  it('reports a changed PR head as nonclean before accepting fresh evidence', () => {
    const root = tempRoot();
    const otherHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', [], false, null, otherHead));
    writePage(
      root,
      'reviews',
      1,
      connectionPage('reviews', [review('2026-09-05T00:01:00Z', otherHead)], false, null, otherHead),
    );
    writePage(
      root,
      'reactions',
      1,
      connectionPage('reactions', [reaction('2026-09-05T00:02:00Z')], false, null, otherHead),
    );

    const result = run(root, 'status');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`codex=head-changed head=${otherHead} open=0 review=1`);
  });

  it('accepts a documented short SHA after verifying it against the full PR head', () => {
    const root = tempRoot();
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', []));
    writePage(root, 'reviews', 1, connectionPage('reviews', [review('2026-09-05T00:01:00Z')]));
    writePage(root, 'reactions', 1, connectionPage('reactions', []));

    const result = run(root, 'status', undefined, HEAD.slice(0, 12));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`codex=clean head=${HEAD} open=0 review=1`);
  });

  it('fails a missing GraphQL connection instead of reporting a clean review', () => {
    const root = tempRoot();
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', []));
    writePage(root, 'reviews', 1, connectionPage('reviews', []));

    const result = run(root, 'status');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GraphQL reactions request failed');
    expect(result.stdout).not.toContain('codex=clean');
  });

  it('returns immediately for a clean foreground observation', () => {
    const root = tempRoot();
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', []));
    writePage(root, 'reviews', 1, connectionPage('reviews', [review('2026-09-05T00:01:00Z')]));
    writePage(root, 'reactions', 1, connectionPage('reactions', []));

    const result = run(root, 'wait', '1');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('wait tick=0 elapsed=0s/60s codex=clean');
    expect(result.sleep).toBe('');
  });

  it('returns immediately when an unresolved thread starts a new review round', () => {
    const root = tempRoot();
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', [thread(false)]));
    writePage(root, 'reviews', 1, connectionPage('reviews', []));
    writePage(root, 'reactions', 1, connectionPage('reactions', []));

    const result = run(root, 'wait', '1');
    expect(result.status).toBe(10);
    expect(result.stdout).toContain('wait tick=0 elapsed=0s/60s codex=findings');
    expect(result.sleep).toBe('');
  });

  it('returns a distinct timeout after foreground ticks at 60-second intervals', () => {
    const root = tempRoot();
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', []));
    writePage(root, 'reviews', 1, connectionPage('reviews', []));
    writePage(root, 'reactions', 1, connectionPage('reactions', []));

    const result = run(root, 'wait', '1');
    expect(result.status).toBe(11);
    expect(result.stdout).toContain('wait tick=0 elapsed=0s/60s codex=pending');
    expect(result.stdout).toContain('wait tick=1 elapsed=60s/60s codex=pending');
    expect(result.stderr).toContain('wait timeout after 1m; last observation: codex=pending');
    expect(result.sleep).toBe('60\n');
  });

  it.each([USAGE_LIMIT_NOTICE, CREDITS_REQUIRED_NOTICE])(
    'routes an authenticated connector quota notice to immediate fallback review',
    (notice) => {
      const root = tempRoot();
      writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', []));
      writePage(root, 'reviews', 1, connectionPage('reviews', []));
      writePage(root, 'reactions', 1, connectionPage('reactions', []));
      writePage(root, 'comments', 1, connectionPage('comments', [comment('2026-09-05T00:01:00Z', notice)]));

      const result = run(root, 'wait', '15');
      expect(result.status).toBe(13);
      expect(result.stdout).toContain(`codex=unavailable reason=usage_limit head=${HEAD}`);
      expect(result.sleep).toBe('');
    },
  );

  it('does not trust a usage-limit forgery from a non-connector author', () => {
    const root = tempRoot();
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', []));
    writePage(root, 'reviews', 1, connectionPage('reviews', []));
    writePage(root, 'reactions', 1, connectionPage('reactions', []));
    writePage(
      root,
      'comments',
      1,
      connectionPage('comments', [comment('2026-09-05T00:01:00Z', USAGE_LIMIT_NOTICE, 'reviewer')]),
    );

    const result = run(root, 'status');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`codex=pending head=${HEAD}`);
    expect(result.stdout).not.toContain('reason=usage_limit');
  });

  it('prefers a newer valid review over an older connector quota notice', () => {
    const root = tempRoot();
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', []));
    writePage(root, 'reviews', 1, connectionPage('reviews', [review('2026-09-05T00:02:00Z')]));
    writePage(root, 'reactions', 1, connectionPage('reactions', []));
    writePage(root, 'comments', 1, connectionPage('comments', [comment('2026-09-05T00:01:00Z', USAGE_LIMIT_NOTICE)]));

    const result = run(root, 'wait', '15');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`codex=clean head=${HEAD} open=0 review=1`);
    expect(result.sleep).toBe('');
  });

  it('keeps the existing thumbs-up clean signal when it follows a quota notice', () => {
    const root = tempRoot();
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', []));
    writePage(root, 'reviews', 1, connectionPage('reviews', []));
    writePage(root, 'reactions', 1, connectionPage('reactions', [reaction('2026-09-05T00:02:00Z')]));
    writePage(root, 'comments', 1, connectionPage('comments', [comment('2026-09-05T00:01:00Z', USAGE_LIMIT_NOTICE)]));

    const result = run(root, 'wait', '15');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`codex=clean head=${HEAD} open=0 review=0 last_review_at=none reaction=1`);
    expect(result.sleep).toBe('');
  });

  it('keeps a changed PR head above a quota notice', () => {
    const root = tempRoot();
    const otherHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', [], false, null, otherHead));
    writePage(root, 'reviews', 1, connectionPage('reviews', [], false, null, otherHead));
    writePage(root, 'reactions', 1, connectionPage('reactions', [], false, null, otherHead));
    writePage(
      root,
      'comments',
      1,
      connectionPage('comments', [comment('2026-09-05T00:01:00Z', USAGE_LIMIT_NOTICE)], false, null, otherHead),
    );

    const result = run(root, 'wait', '15');
    expect(result.status).toBe(12);
    expect(result.stdout).toContain(`codex=head-changed head=${otherHead}`);
    expect(result.stdout).not.toContain('reason=usage_limit');
    expect(result.sleep).toBe('');
  });
});

describe('codex-review risk-scoped review requests', () => {
  it('leaves a legacy repo on automatic review: scope says auto, request posts nothing, merge-check defers', () => {
    const root = tempRoot();
    scopeFixture(root, { baseConfig: null, labels: ['risk:high'] });

    const scope = runHelper(root, ['scope']);
    expect(scope.status).toBe(0);
    expect(JSON.parse(scope.stdout)).toMatchObject({
      repo: 'example/repository',
      pr: 1,
      head: HEAD,
      mode: 'legacy',
      verdict: 'auto',
      labels: ['risk:high'],
    });
    expect(scope.calls).not.toContain('actions/runs');

    const request = runHelper(root, ['request']);
    expect(request.status).toBe(20);
    expect(request.stderr).toContain('automatic review handles this repo; never request');
    expect(request.posted).toBeNull();
    expect(request.calls).not.toMatch(/^(node|pr comment)/m);

    const merge = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(merge.status).toBe(0);
    expect(merge.stdout).toContain('merge=defer mode=legacy');
    expect(merge.stdout).toContain('Step-6 evidence rules apply');
    expect(merge.calls).not.toMatch(/^(reviews|reactions|comments|reviewThreads) /m);
  });

  it('runs the pre-existing commands in a legacy repo exactly as before, reading no risk-scope state', () => {
    const root = tempRoot();
    writePage(root, 'reviewThreads', 1, threadsPage([]));
    writePage(root, 'reviews', 1, connectionPage('reviews', [review('2026-09-05T00:01:00Z')]));
    writePage(root, 'reactions', 1, connectionPage('reactions', []));

    const status = run(root, 'status');
    expect(status.status).toBe(0);
    expect(status.stdout).toBe(
      `codex=clean head=${HEAD} open=0 review=1 last_review_at=2026-09-05T00:01:00Z reaction=0 last_thumbs_up_at=none rounds=0\n`,
    );
    expect(status.calls.trim().split('\n').sort()).toEqual([
      'comments null',
      'reactions null',
      'reviewThreads null',
      'reviews null',
    ]);

    const wait = run(root, 'wait', '1');
    expect(wait.status).toBe(0);
    expect(wait.stdout).toContain('wait tick=0 elapsed=0s/60s codex=clean');
    expect(wait.calls).not.toMatch(/^(rest|pr) /m);

    const gate = runHelper(root, ['gate', '--committed-only']);
    expect(gate.status).toBe(0);
    expect(gate.calls).toMatch(/^node \S+review-churn\.mjs gate --json --committed-only$/m);
    expect(gate.calls).not.toMatch(/^(rest|pr) /m);
  });

  it.each([
    ['only on the PR head branch', null],
    [
      'on the base without a top-level risk:high key',
      "docs:\n- changed-files:\n  - any-glob-to-any-file: ['docs/**']\n  risk:high: nested\n",
    ],
  ])('treats a repo whose labeler.yml is %s as legacy', (_case, baseConfig) => {
    const root = tempRoot();
    scopeFixture(root, { baseConfig, labels: ['risk:high'] });
    fs.writeFileSync(path.join(root, 'labeler--feat.yml'), RISK_CONFIG);

    const result = runHelper(root, ['scope']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'legacy', verdict: 'auto' });
    expect(result.calls).toContain('rest repos/example/repository/contents/.github/labeler.yml?ref=main\n');
    expect(result.calls).not.toContain('ref=feat');
  });

  it.each([
    [['risk:high'], 'review', 'labeled risk:high'],
    [['review:requested'], 'review', 'labeled review:requested'],
    [['PR: Fix'], 'skip', 'set neither risk:high nor review:requested'],
  ])('reads labels %j as a %s verdict once the Risk label run for this head succeeds', (labels, verdict, reason) => {
    const root = tempRoot();
    scopeFixture(root, { labels });

    const result = runHelper(root, ['scope']);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { reason: string };
    expect(out).toMatchObject({ mode: 'risk-scoped', verdict, head: HEAD, labels });
    expect(out.reason).toContain(reason);
    expect(result.calls).toContain(
      `rest repos/example/repository/actions/runs?head_sha=${HEAD}&event=pull_request_target`,
    );
  });

  it.each([
    ['still running past the timeout', [labelRun('in_progress', null)], 'still in_progress after 2s'],
    ['missing', [], 'no Risk label run for this head within 2s'],
    ['failed', [labelRun('completed', 'failure')], 'concluded failure'],
    [
      'completed only for an older head',
      [labelRun('completed', 'success', OLD_HEAD)],
      'no Risk label run for this head',
    ],
    ['from another workflow', [labelRun('completed', 'success', HEAD, 'Label PR')], 'no Risk label run for this head'],
  ])('fails closed to review when the labeler run is %s', (_case, runs, reason) => {
    const root = tempRoot();
    scopeFixture(root, { labels: [], runs });

    const result = runHelper(root, ['scope']);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { verdict: string; reason: string };
    expect(out.verdict).toBe('review');
    expect(out.reason).toContain(reason);
  });

  it('polls a pending labeler run until the deadline before failing closed', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: [], runs: [labelRun('queued', null)] });

    const result = runHelper(root, ['scope']);
    expect(JSON.parse(result.stdout)).toMatchObject({ verdict: 'review' });
    expect(result.calls.match(/actions\/runs/g)).toHaveLength(2);
    expect(result.sleep).toBe('1\n');
  });

  it('fails closed when the head moves while its labeler run is awaited', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: [] });
    writeJson(root, 'pr-2.json', prState([], OTHER_HEAD));

    const result = runHelper(root, ['scope']);
    const out = JSON.parse(result.stdout) as { reason: string };
    expect(out).toMatchObject({ verdict: 'review', head: OTHER_HEAD });
    expect(out.reason).toContain(`the head moved from ${HEAD}`);
  });

  it('posts one marked request for the current head when every rule holds', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: ['risk:high'], comments: [marker(OLD_HEAD, 1)] });

    const result = runHelper(root, ['request']);
    expect(result.status).toBe(0);
    expect(result.posted).toBe(`@codex review\n\n<!-- pr-review-loop:request head=${HEAD} round=2 -->`);
    expect(result.stdout).toContain(`requested: round=2/3 head=${HEAD}`);
    expect(result.calls).toMatch(new RegExp(`^node \\S+ gate --json --committed-only --head ${HEAD}$`, 'm'));
  });

  it('refuses a skip-verdict head without posting', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: [] });

    const result = runHelper(root, ['request']);
    expect(result.status).toBe(21);
    expect(result.posted).toBeNull();
  });

  it('does not request a review of the same head twice', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: ['risk:high'], comments: [marker(HEAD, 1)] });

    const result = runHelper(root, ['request']);
    expect(result.status).toBe(22);
    expect(result.stderr).toContain(`a review of ${HEAD} was already requested`);
    expect(result.posted).toBeNull();
  });

  it('stops at the round cap and escalates instead of posting', () => {
    const root = tempRoot();
    const heads = ['1', '2', '3'].map((c) => c.repeat(40));
    scopeFixture(root, { labels: ['risk:high'], comments: heads.map((h, i) => marker(h, i + 1)) });

    const capped = runHelper(root, ['request']);
    expect(capped.status).toBe(23);
    expect(capped.stderr).toContain('CAP: 3 of 3 review rounds already requested');
    expect(capped.stderr).toContain('escalate');
    expect(capped.posted).toBeNull();
    expect(capped.calls).not.toMatch(/^node /m);

    const raised = runHelper(root, ['request'], { REVIEW_ROUND_CAP: '4' });
    expect(raised.status).toBe(0);
    expect(raised.posted).toContain(`head=${HEAD} round=4 -->`);
  });

  it('propagates a churn-gate REFRAME from request without posting', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: ['risk:high'] });

    const result = runHelper(root, ['request'], { MOCK_GATE_STATUS: '3' });
    expect(result.status).toBe(3);
    expect(result.posted).toBeNull();
  });

  it('allows merging a skip-verdict head once its CI is green', () => {
    const root = tempRoot();
    scopeFixture(root, {
      labels: [],
      ci: [
        workflowRun('CI', 'completed', 'success'),
        workflowRun('Docs', 'completed', 'skipped'),
        workflowRun('Label PR', 'completed', 'neutral'),
      ],
      statuses: [commitStatus('ci/external', 'success')],
    });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`merge=allowed head=${HEAD} mode=risk-scoped verdict=skip ci=green`);
    expect(result.calls).toContain(`rest repos/example/repository/actions/runs?head_sha=${HEAD}&per_page=100\n`);
    expect(result.calls).toContain(`rest repos/example/repository/commits/${HEAD}/statuses?per_page=100\n`);
    expect(result.calls).not.toContain('check-runs');
  });

  it('allows a review-verdict head only with a clean review of that head since its request', () => {
    const root = tempRoot();
    scopeFixture(root, {
      labels: ['risk:high'],
      comments: [marker(HEAD, 1, '2026-09-05T00:05:00Z')],
      reviews: [review('2026-09-05T00:10:00Z', HEAD)],
    });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `merge=allowed head=${HEAD} mode=risk-scoped verdict=review ci=green: codex=clean head=${HEAD} open=0`,
    );
  });

  it.each([
    ['its latest review is on an older SHA', { reviews: [review('2026-09-05T00:10:00Z', OLD_HEAD)] }, 'codex=pending'],
    [
      'a Codex thread is still open',
      { reviews: [review('2026-09-05T00:10:00Z', HEAD)], threads: [thread(false)] },
      'codex=findings',
    ],
    ['its review predates the request', { reviews: [review('2026-09-05T00:01:00Z', HEAD)] }, 'codex=pending'],
  ])('refuses a review-verdict head when %s', (_case, fixture, observation) => {
    const root = tempRoot();
    scopeFixture(root, { labels: ['risk:high'], comments: [marker(HEAD, 1)], ...fixture });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain(observation);
  });

  it('refuses a head the PR no longer has, and a review head nobody requested', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: ['risk:high'], reviews: [review('2026-09-05T00:10:00Z', HEAD)] });

    const moved = runHelper(root, ['merge-check', '--head', OLD_HEAD]);
    expect(moved.status).toBe(24);
    expect(moved.stderr).toContain(`the PR head is not ${OLD_HEAD}`);

    const unrequested = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(unrequested.status).toBe(24);
    expect(unrequested.stderr).toContain('no review of this head was requested');
  });

  it.each([
    [
      'a failed run',
      [workflowRun('CI', 'completed', 'success'), workflowRun('Lint', 'completed', 'failure')],
      [],
      'ci_red: Lint=failure',
    ],
    ['a run still in progress', [workflowRun('CI', 'in_progress', null)], [], 'ci_pending: CI=in_progress'],
    [
      'a queued run reporting a stale conclusion',
      [workflowRun('CI', 'queued', 'success')],
      [],
      'ci_pending: CI=queued',
    ],
    ['a cancelled run', [workflowRun('CI', 'completed', 'cancelled')], [], 'ci_red: CI=cancelled (required)'],
    [
      'a pending commit status',
      [workflowRun('CI', 'completed', 'success')],
      [commitStatus('ci/external', 'pending')],
      'ci_pending: ci/external=pending',
    ],
    ['a failed commit status', [], [commitStatus('ci/external', 'failure')], 'ci_red: ci/external=failure'],
    ['nothing but the Risk label run', [], [], 'CI never ran'],
    [
      'only Label PR and Risk label runs, both green, and no CI run',
      [workflowRun('Label PR', 'completed', 'success')],
      [],
      'ci_missing: CI — required, but no run on this head',
    ],
    [
      'a required workflow that was skipped',
      [workflowRun('CI', 'completed', 'skipped')],
      [],
      'ci_red: CI=skipped (required)',
    ],
  ])('refuses a skip-verdict head whose CI has %s', (_case, ci, statuses, reason) => {
    const root = tempRoot();
    scopeFixture(root, { labels: [], ci, statuses });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain(reason);
  });

  it('requires every workflow named in CODEX_REVIEW_REQUIRED_WORKFLOWS to have succeeded on the head', () => {
    const root = tempRoot();
    const env = { CODEX_REVIEW_REQUIRED_WORKFLOWS: 'CI, Lint' };
    scopeFixture(root, { labels: [], ci: [workflowRun('CI', 'completed', 'success')] });

    const missing = runHelper(root, ['merge-check', '--head', HEAD], env);
    expect(missing.status).toBe(24);
    expect(missing.stderr).toContain('ci_missing: Lint — required, but no run on this head');

    scopeFixture(root, {
      labels: [],
      ci: [workflowRun('CI', 'completed', 'success'), workflowRun('Lint', 'completed', 'success')],
    });
    const green = runHelper(root, ['merge-check', '--head', HEAD], env);
    expect(green.status).toBe(0);
  });

  it.each([
    // Newest first: taking the LAST run in list order would pick the failure.
    [
      'a failed run superseded by a successful rerun',
      [
        workflowRun('CI', 'completed', 'success', '2026-09-05T00:03:00Z'),
        workflowRun('CI', 'completed', 'failure', '2026-09-05T00:01:00Z'),
      ],
      [],
      0,
    ],
    // Oldest first: taking the FIRST run in list order would pick the success.
    [
      'a success superseded by a failed rerun',
      [
        workflowRun('CI', 'completed', 'success', '2026-09-05T00:01:00Z'),
        workflowRun('CI', 'completed', 'failure', '2026-09-05T00:03:00Z'),
      ],
      [],
      24,
    ],
    [
      'a failed status superseded by a newer success in its context',
      [workflowRun('CI', 'completed', 'success')],
      [
        commitStatus('ci/external', 'success', '2026-09-05T00:03:00Z'),
        commitStatus('ci/external', 'failure', '2026-09-05T00:01:00Z'),
      ],
      0,
    ],
  ])('judges only the latest run per workflow and status per context: %s', (_case, ci, statuses, status) => {
    const root = tempRoot();
    scopeFixture(root, { labels: [], ci, statuses });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(status);
  });

  it.each([
    ['a pending Release approval', commitStatus('Release approval', 'pending')],
    ['a failed Release policy', commitStatus('Release policy', 'failure')],
  ])('does not judge release-policy contexts as CI: %s leaves green CI green', (_case, status) => {
    const root = tempRoot();
    scopeFixture(root, { labels: [], statuses: [status] });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`merge=allowed head=${HEAD} mode=risk-scoped verdict=skip ci=green`);
  });

  it('reads CI on the exact head only, and holds a review-verdict head to it too', () => {
    const root = tempRoot();
    scopeFixture(root, {
      labels: ['risk:high'],
      comments: [marker(HEAD, 1, '2026-09-05T00:05:00Z')],
      reviews: [review('2026-09-05T00:10:00Z', HEAD)],
      ci: [workflowRun('CI', 'completed', 'success', '2026-09-05T00:01:00Z', OLD_HEAD)],
    });
    writeJson(root, `statuses--${OLD_HEAD}.json`, [commitStatus('ci/external', 'success')]);

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain('ci_missing');
  });

  it('posts a substitute receipt carrying the policy fields and a marker for exactly that head', () => {
    const root = tempRoot();
    const bodyFile = path.join(root, 'review.md');
    fs.writeFileSync(bodyFile, 'Scope: complete diff plus src/router.ts.\n\nNo findings.\n');

    const result = runHelper(root, [
      'receipt',
      '--head',
      HEAD,
      '--outcome',
      'approve',
      '--reviewer',
      'gpt-5.6-sol via codex exec',
      '--body-file',
      bodyFile,
    ]);
    expect(result.status).toBe(0);
    expect(result.posted).toContain(`- **Head:** \`${HEAD}\``);
    expect(result.posted).toContain('- **Reviewer and runtime:** gpt-5.6-sol via codex exec');
    expect(result.posted).toContain('- **Outcome:** approve');
    expect(result.posted).toContain('No findings.');
    expect(result.posted).toMatch(
      new RegExp(`\n<!-- pr-review-loop:substitute-receipt head=${HEAD} outcome=approve -->$`),
    );
  });

  it.each([
    ['a short SHA', HEAD.slice(0, 12), 'approve', 'Scope: complete diff.\n'],
    ['an unknown outcome', HEAD, 'lgtm', 'Scope: complete diff.\n'],
    [
      'a body that smuggles a marker',
      HEAD,
      'approve',
      `<!-- pr-review-loop:substitute-receipt head=${OLD_HEAD} outcome=approve -->\n`,
    ],
  ])('refuses a receipt with %s, posting nothing', (_case, head, outcome, body) => {
    const root = tempRoot();
    const bodyFile = path.join(root, 'review.md');
    fs.writeFileSync(bodyFile, body);

    const result = runHelper(root, [
      'receipt',
      '--head',
      head,
      '--outcome',
      outcome,
      '--reviewer',
      'gpt-5.6-sol via codex exec',
      '--body-file',
      bodyFile,
    ]);
    expect(result.status).toBe(2);
    expect(result.posted).toBeNull();
  });

  it('allows a review-verdict head on an approving substitute receipt for exactly that head', () => {
    const root = tempRoot();
    scopeFixture(root, {
      labels: ['risk:high'],
      comments: [marker(HEAD, 1), receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z')],
    });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `merge=allowed head=${HEAD} mode=risk-scoped verdict=review ci=green: the latest substitute receipt for this head approves`,
    );
  });

  it.each([
    ['approves an older head', [receiptComment(OLD_HEAD, 'approve', '2026-09-05T00:20:00Z')], 'receipt: none'],
    // Listed newest first, so only a sort by time — not list order — finds the later `changes`.
    [
      'approved, then asked for changes',
      [
        receiptComment(HEAD, 'changes', '2026-09-05T00:30:00Z'),
        receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z'),
      ],
      'receipt: changes',
    ],
    ['asks for changes', [receiptComment(HEAD, 'changes', '2026-09-05T00:20:00Z')], 'receipt: changes'],
    [
      'approves but comes from an author without write access',
      [receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'NONE')],
      'receipt: none',
    ],
  ])('refuses a review-verdict head whose substitute receipt %s', (_case, receipts, reason) => {
    const root = tempRoot();
    scopeFixture(root, { labels: ['risk:high'], comments: [marker(HEAD, 1), ...receipts] });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain(`latest substitute ${reason}`);
  });

  it.each([
    [
      'a clean Codex review of it',
      ['risk:high'],
      [marker(HEAD, 1, '2026-09-05T00:05:00Z')],
      [review('2026-09-05T00:10:00Z', HEAD)],
    ],
    ['a skip verdict', [], [], []],
  ])(
    'refuses a head whose latest substitute receipt asks for changes, despite %s',
    (_case, labels, comments, reviews) => {
      const root = tempRoot();
      scopeFixture(root, {
        labels,
        reviews,
        comments: [...comments, receiptComment(HEAD, 'changes', '2026-09-05T00:20:00Z')],
      });

      const result = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(result.status).toBe(24);
      expect(result.stderr).toContain('latest substitute receipt: changes');
    },
  );

  it('lets a later approve receipt for the same head supersede its changes receipt', () => {
    const root = tempRoot();
    scopeFixture(root, {
      labels: ['risk:high'],
      comments: [
        receiptComment(HEAD, 'approve', '2026-09-05T00:30:00Z'),
        receiptComment(HEAD, 'changes', '2026-09-05T00:20:00Z'),
      ],
    });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('the latest substitute receipt for this head approves');
  });

  it('leaves legacy merge-check deferring without reading CI or receipts, whatever they say', () => {
    const root = tempRoot();
    scopeFixture(root, {
      baseConfig: null,
      labels: ['risk:high'],
      comments: [receiptComment(HEAD, 'changes', '2026-09-05T00:20:00Z')],
      ci: [workflowRun('CI', 'completed', 'failure')],
      statuses: [commitStatus('ci/external', 'pending')],
    });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('merge=defer mode=legacy');
    expect(result.calls).not.toContain('actions/runs');
    expect(result.calls).not.toContain('statuses');
    expect(result.calls).not.toMatch(/^comments /m);
  });
});
