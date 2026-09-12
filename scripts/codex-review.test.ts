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
# MOCK_SWAP_SCRIPT: at the run's first gh call, overwrite that file in place with evil.sh.
if [ -n "\${MOCK_SWAP_SCRIPT:-}" ] && [ ! -f "$MOCK_DIR/swapped" ]; then
  cat "$MOCK_DIR/evil.sh" > "$MOCK_SWAP_SCRIPT"
  touch "$MOCK_DIR/swapped"
fi
if [ "$1" = pr ]; then
  printf 'pr %s\\n' "$2" >> "$MOCK_CALLS"
  if [ "$2" = view ]; then
    n=$(grep -c '^pr view$' "$MOCK_CALLS")
    if [ -f "$MOCK_DIR/merged" ] && [ -f "$MOCK_DIR/pr-merged.json" ]; then cat "$MOCK_DIR/pr-merged.json"
    elif [ -f "$MOCK_DIR/pr-$n.json" ]; then cat "$MOCK_DIR/pr-$n.json"; else cat "$MOCK_DIR/pr.json"; fi
  elif [ "$2" = merge ]; then
    # merge-args records exactly what merged; MOCK_MERGE_STATUS makes the merge fail.
    printf 'merge-args %s\\n' "$*" >> "$MOCK_CALLS"
    if [ "\${MOCK_MERGE_STATUS:-0}" != 0 ]; then echo 'gh: merge failed' >&2; exit "$MOCK_MERGE_STATUS"; fi
    touch "$MOCK_DIR/merged"
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
      # labeler--<ref>.yml is the file at that ref. A .nocommit marker answers as
      # GitHub does for a ref it cannot find, and a .error marker fails another way.
      ref="\${rest##*ref=}"
      if [ -f "$MOCK_DIR/labeler--$ref.nocommit" ]; then
        printf '{"message":"No commit found for the ref %s","status":"404"}\\n' "$ref"
        echo 'gh: No commit found for the ref (HTTP 404)' >&2
        exit 1
      fi
      if [ -f "$MOCK_DIR/labeler--$ref.error" ]; then
        echo '{"message":"Server Error","status":"500"}'
        echo 'gh: Server Error (HTTP 500)' >&2
        exit 1
      fi
      config="$MOCK_DIR/labeler--$ref.yml"
      if [ -f "$config" ]; then cat "$config"; exit 0; fi
      echo '{"message":"Not Found","status":"404"}'
      echo 'gh: Not Found (HTTP 404)' >&2
      exit 1
      ;;
    */actions/runs\\?*)
      # runs-<n>.json answers the nth read of this endpoint in this run;
      # runs.json otherwise. Mirrors the git/ref/heads nth-read pattern below.
      n=$(grep -c '^rest repos/[^ ]*/actions/runs?' "$MOCK_CALLS")
      src="$MOCK_DIR/runs.json"
      if [ -f "$MOCK_DIR/runs-$n.json" ]; then src="$MOCK_DIR/runs-$n.json"; fi
      if printf '%s\\n' "$@" | grep -qx -- --slurp; then printf '['; cat "$src"; printf ']'; else cat "$src"; fi
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
    */git/ref/heads/*)
      # ref--<branch> holds the commit the branch points at; ref--<branch>-<n>, when
      # present, answers the nth read of it in this run instead. Absent = no such branch.
      branch="\${rest#*/git/ref/heads/}"
      target="$MOCK_DIR/ref--$branch"
      n=$(grep -c "^rest $rest\\$" "$MOCK_CALLS")
      if [ -f "$target-$n" ]; then target="$target-$n"; fi
      if [ ! -f "$target" ]; then
        echo '{"message":"Not Found","status":"404"}'
        echo 'gh: Not Found (HTTP 404)' >&2
        exit 1
      fi
      printf '{"ref":"refs/heads/%s","object":{"sha":"%s","type":"commit"}}\\n' "$branch" "$(cat "$target")"
      exit 0
      ;;
    */compare/*)
      # compare--<base>...<head>.json is the comparison of exactly those two. Absent = the read fails.
      basehead="\${rest#*/compare/}"
      basehead="\${basehead%%\\?*}"
      pinned="$MOCK_DIR/compare--$basehead.json"
      if [ ! -f "$pinned" ]; then
        echo '{"message":"Not Found","status":"404"}'
        echo 'gh: Not Found (HTTP 404)' >&2
        exit 1
      fi
      cat "$pinned"
      exit 0
      ;;
    */pulls/*/files\\?*)
      # What the unpinned listing serves: whatever the head is at that moment.
      # files.json holds every page, as --paginate --slurp prints them. Absent = the read fails.
      if [ ! -f "$MOCK_DIR/files.json" ]; then
        echo '{"message":"Server Error","status":"500"}'
        echo 'gh: Server Error (HTTP 500)' >&2
        exit 1
      fi
      if printf '%s\\n' "$@" | grep -qx -- --slurp; then cat "$MOCK_DIR/files.json"; else jq -c '.[0]' "$MOCK_DIR/files.json"; fi
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
  *userContentEdits*) connection=audit ;;
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
// The base branch's commit now, which scope resolves once and reads both base
// files at; and the PR's own baseRefOid, the base as of its last push, which it
// must not use.
const BASE_OID = 'ffffffffffffffffffffffffffffffffffffffff';
const STALE_BASE = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const MOVED_BASE = '9999999999999999999999999999999999999999';
// A merge: its commit, the base commit it merged onto, and when.
const MERGE_OID = '7777777777777777777777777777777777777777';
const MERGE_PARENT = '8888888888888888888888888888888888888888';
const MERGED_AT = '2026-09-05T01:00:00Z';
const RISK_CONFIG =
  "risk:high:\n- changed-files:\n  - any-glob-to-any-file:\n    - 'src/router.ts'\n    - '.github/**'\n";

function writeJson(root: string, name: string, value: unknown): void {
  fs.writeFileSync(path.join(root, name), JSON.stringify(value));
}

function prState(
  labels: string[],
  head = HEAD,
  title = 'feat: route a new message kind',
  body = '',
  changedFiles = 1,
): Page {
  return {
    headRefOid: head,
    baseRefName: 'main',
    baseRefOid: STALE_BASE,
    headRefName: 'feat',
    title,
    body,
    changedFiles,
    labels: labels.map((name) => ({ name })),
  };
}

// A PR as ci-wait's mergeability read sees it: state, headRefOid, baseRefName
// and mergeable, on top of prState's other fields (unused by ci-wait, but
// harmless to carry so the same fixture also serves the labeler/comparison
// reads the fake gh dispatches on `pr view`).
function ciPr(opts: { mergeable?: string; head?: string; state?: string } = {}): Page {
  const { mergeable = 'MERGEABLE', head = HEAD, state = 'OPEN' } = opts;
  return { ...prState([], head), state, mergeable };
}

// One entry of `pulls/<n>/files`; a rename also names the path it left.
function changedFile(filename: string, previousFilename?: string): Page {
  return previousFilename
    ? { filename, previous_filename: previousFilename, status: 'renamed' }
    : { filename, status: 'modified' };
}

// The Risk label workflow's run on a head, as `actions/runs` lists it. The
// workflow only labels the PR now, and merge-check must leave it out of CI.
function labelRun(status: string, conclusion: string | null, head = HEAD, name = 'Risk label'): Page {
  return {
    id: 1,
    name,
    event: 'pull_request_target',
    head_sha: head,
    status,
    conclusion,
    created_at: '2026-09-05T00:00:30Z',
    updated_at: '2026-09-05T00:00:30Z',
  };
}

function marker(head: string, round: number, createdAt = '2026-09-05T00:05:00Z'): Page {
  return comment(
    createdAt,
    `@codex review\n\n<!-- pr-review-loop:request head=${head} round=${round} -->`,
    'davekim917',
  );
}

// An Actions run of one workflow on a head, as `actions/runs?head_sha=` lists it;
// updatedAt is when it last changed, which for a finished run is when it finished.
function workflowRun(
  name: string,
  status: string,
  conclusion: string | null,
  startedAt = '2026-09-05T00:01:00Z',
  head = HEAD,
  updatedAt = startedAt,
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
    updated_at: updatedAt,
  };
}

function commitStatus(context: string, state: string, createdAt = '2026-09-05T00:02:00Z'): Page {
  return { id: Date.parse(createdAt) / 1000, context, state, created_at: createdAt };
}

// `reviewer` defaults to an allowed worker-high model so existing approve-path
// fixtures keep passing the model-allowlist check merge-check now applies;
// tests of the allowlist itself pass a disallowed (or omitted) reviewer.
// `databaseId` is the comment's posting order, which receipts are ordered by;
// by default it follows createdAt, to the second.
function receiptComment(
  head: string,
  outcome: string,
  createdAt: string,
  authorAssociation = 'OWNER',
  reviewer = 'claude-opus-5 (worker-high)',
  // `null` reproduces a real GraphQL null fullDatabaseId (the nullable BigInt
  // case); a non-digit string reproduces a malformed one. Either must fail the
  // gate closed rather than sort as if it were "0".
  databaseId: string | null = String(Date.parse(createdAt) / 1000),
): Page {
  return {
    author: { login: 'davekim917' },
    authorAssociation,
    createdAt,
    fullDatabaseId: databaseId,
    body: `### Substitute review receipt\n\n- **Reviewer and runtime:** ${reviewer}\n- **Outcome:** ${outcome}\n\n<!-- pr-review-loop:substitute-receipt head=${head} outcome=${outcome} -->`,
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

// One PR: its base-branch labeler config (null = absent), its changed files,
// its labels, its Actions runs, and every GraphQL connection.
function scopeFixture(
  root: string,
  opts: {
    labels?: string[];
    baseConfig?: string | null;
    files?: Page[] | null;
    unpinnedFiles?: Page[];
    changedFiles?: number;
    ci?: Page[];
    statuses?: Page[];
    comments?: Page[];
    reviews?: Page[];
    reactions?: Page[];
    threads?: Page[];
    title?: string;
    body?: string;
  } = {},
): void {
  // The files HEAD changes, as the comparison from BASE_OID lists them; null =
  // that read fails. The unpinned `pulls/<n>/files` serves the same list unless
  // a test moves the head underneath it (unpinnedFiles). The PR's file count
  // defaults to what is listed.
  const files = opts.files === undefined ? [changedFile('docs/notes.md')] : opts.files;
  writeJson(
    root,
    'pr.json',
    prState(opts.labels ?? [], HEAD, opts.title, opts.body, opts.changedFiles ?? files?.length ?? 1),
  );
  // The base branch points at BASE_OID. Its labeler.yml (null = absent) and the
  // comparison are served at that commit, under the branch name, and at the PR's
  // stale baseRefOid too, unless a test sets them apart; so a base read by the
  // wrong name fails on the content a test gives it, not on a missing fixture.
  for (const name of fs.readdirSync(root))
    if (/^ref--|^labeler--.*\.(nocommit|error)$/.test(name)) fs.rmSync(path.join(root, name));
  fs.writeFileSync(path.join(root, 'ref--main'), BASE_OID);
  const bases = [BASE_OID, 'main', STALE_BASE];
  const compares = bases.map((base) => `compare--${base}...${HEAD}.json`);
  for (const name of [...compares, 'files.json']) fs.rmSync(path.join(root, name), { force: true });
  if (files !== null) for (const name of compares) writeJson(root, name, { status: 'ahead', files });
  if (files !== null || opts.unpinnedFiles) writeJson(root, 'files.json', [opts.unpinnedFiles ?? files]);
  for (const ref of bases) {
    const labeler = path.join(root, `labeler--${ref}.yml`);
    if (opts.baseConfig === null) fs.rmSync(labeler, { force: true });
    else fs.writeFileSync(labeler, opts.baseConfig ?? RISK_CONFIG);
  }
  // One Actions listing, as the API returns it: the Risk label run, which
  // merge-check leaves out of CI, and the CI runs it requires green.
  const runs = [labelRun('completed', 'success'), ...(opts.ci ?? [workflowRun('CI', 'completed', 'success')])];
  writeJson(root, 'runs.json', { total_count: runs.length, workflow_runs: runs });
  writeJson(root, `statuses--${HEAD}.json`, opts.statuses ?? []);
  writePage(root, 'comments', 1, connectionPage('comments', opts.comments ?? []));
  writePage(root, 'reviews', 1, connectionPage('reviews', opts.reviews ?? []));
  writePage(root, 'reactions', 1, connectionPage('reactions', opts.reactions ?? []));
  writePage(root, 'reviewThreads', 1, threadsPage(opts.threads ?? []));
}

// Runs the helper with any arguments. Each run starts a fresh call log and
// posted-comment slot, so assertions describe that run alone. `node` is a stub
// for the churn classifier (exit MOCK_GATE_STATUS).
function runHelper(root: string, args: string[], env: Record<string, string> = {}, script = HELPER) {
  const { bin, calls, sleepLog } = writeMocks(root);
  const posted = path.join(root, 'posted');
  for (const file of [calls, sleepLog, posted, path.join(root, 'merged'), path.join(root, 'swapped')])
    fs.rmSync(file, { force: true });
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
  const result = spawnSync('bash', [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    // A mutation that loops forever (e.g. a bad deadline check) fails this
    // test instead of hanging the worker — spawnSync blocks, so vitest's own
    // per-test timeout cannot interrupt it.
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      REPO: 'example/repository',
      PR: '1',
      MOCK_DIR: root,
      MOCK_CALLS: calls,
      MOCK_SLEEP_LOG: sleepLog,
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

// Runs `ci-wait`, feeding it exactly the epoch seconds (§2.3's clock calls)
// the fake `date` should hand back, one per line, in call order.
function ciWait(root: string, args: string[], dates: number[], env: Record<string, string> = {}) {
  const dateValues = path.join(root, 'dates');
  fs.writeFileSync(dateValues, dates.map((d) => `${d}\n`).join(''));
  return runHelper(root, ['ci-wait', ...args], { MOCK_DATE_VALUES: dateValues, ...env });
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

describe('codex-review ci-wait, the only way to wait on CI', () => {
  // One Actions listing, as the API returns it — the Risk label run
  // (excluded from CI) plus whatever ci_verdict must actually judge.
  function writeRuns(root: string, name: string, runs: Page[]): void {
    writeJson(root, name, { total_count: runs.length + 1, workflow_runs: [labelRun('completed', 'success'), ...runs] });
  }

  it('reports green on the first poll (mutation: an empty verdict read as pending, so it times out)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    writeRuns(root, 'runs.json', [workflowRun('CI', 'completed', 'success')]);

    const result = ciWait(root, ['--head', HEAD], [0, 0]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`ci=green head=${HEAD}`);
    expect(result.sleep).toBe('');
  });

  it('polls again after a pending verdict instead of stopping (mutation: exits on the first pending, or never re-polls)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    writeRuns(root, 'runs-1.json', [workflowRun('CI', 'in_progress', null)]);
    writeRuns(root, 'runs-2.json', [workflowRun('CI', 'completed', 'success')]);

    const result = ciWait(root, ['--head', HEAD], [0, 0, 0, 30]);
    expect(result.status).toBe(0);
    expect(result.sleep).toBe('30\n');
    expect(result.stdout).toContain('tick=0');
  });

  it('sleeps CODEX_REVIEW_CI_POLL_SECONDS between ticks, not a hard-coded interval (mutation: a hard-coded sleep)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    writeRuns(root, 'runs-1.json', [workflowRun('CI', 'in_progress', null)]);
    writeRuns(root, 'runs-2.json', [workflowRun('CI', 'completed', 'success')]);

    const result = ciWait(root, ['--head', HEAD], [0, 0, 0, 10], { CODEX_REVIEW_CI_POLL_SECONDS: '10' });
    expect(result.status).toBe(0);
    expect(result.sleep).toBe('10\n');
  });

  it('exits 29 on red CI, never 24 (mutation: red mapped to 24, or polling on after red)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    writeRuns(root, 'runs.json', [workflowRun('CI', 'completed', 'failure')]);

    const result = ciWait(root, ['--head', HEAD], [0, 0]);
    expect(result.status).toBe(29);
    expect(result.stderr).toContain(`ci=red head=${HEAD}: ci_red: CI=failure (required)`);
  });

  it('exits 30 when no run at all ever registers before the window closes (mutation: ci_missing treated as pending until timeout)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    writeJson(root, 'runs.json', { total_count: 1, workflow_runs: [labelRun('completed', 'success')] });

    const result = ciWait(root, ['--head', HEAD], [0, 0, 0, 30, 30, 60], { CODEX_REVIEW_CI_REGISTER_SECONDS: '60' });
    expect(result.status).toBe(30);
    expect(result.stderr).toContain(
      `ci=none head=${HEAD} after 60s: ci_missing: no workflow run or commit status on this head`,
    );
    expect(result.sleep).toBe('30\n30\n');
  });

  it('exits 30 when a required workflow never ran, though another finished (mutation: same as above)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    writeJson(root, 'runs.json', {
      total_count: 2,
      workflow_runs: [labelRun('completed', 'success'), workflowRun('Lint', 'completed', 'success')],
    });

    const result = ciWait(root, ['--head', HEAD], [0, 0, 0, 30, 30, 60], { CODEX_REVIEW_CI_REGISTER_SECONDS: '60' });
    expect(result.status).toBe(30);
    expect(result.stderr).toContain('ci_missing: CI — required, but no run on this head');
  });

  it('reports "not registered yet" before the window, then green once CI shows up (mutation: exit 30 on the first ci_missing, with no window)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    writeJson(root, 'runs-1.json', { total_count: 1, workflow_runs: [labelRun('completed', 'success')] });
    writeRuns(root, 'runs-2.json', [workflowRun('CI', 'in_progress', null)]);
    writeRuns(root, 'runs-3.json', [workflowRun('CI', 'completed', 'success')]);

    const result = ciWait(root, ['--head', HEAD], [0, 0, 0, 30, 30, 60]);
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')[0]).toContain('not registered yet');
  });

  it('fails fast on a conflicting PR at the start (mutation: no mergeability check, so it waits out the window)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr({ mergeable: 'CONFLICTING' }));

    const result = ciWait(root, ['--head', HEAD], [0]);
    expect(result.status).toBe(31);
    expect(result.stderr).toContain(
      `ci=conflicting head=${HEAD}: PR #1 conflicts with main; merge the base in first. No pull_request CI will run`,
    );
    expect(result.calls).not.toContain('actions/runs');
    expect(result.sleep).toBe('');
  });

  it('catches a PR that goes conflicting mid-wait (mutation: mergeability checked only once, so it exits 11 instead)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    writeJson(root, 'pr-3.json', ciPr({ mergeable: 'CONFLICTING' }));
    writeRuns(root, 'runs.json', [workflowRun('CI', 'in_progress', null)]);

    const result = ciWait(root, ['--head', HEAD, '--timeout', '120'], [0, 0, 0, 30]);
    expect(result.status).toBe(31);
    expect(result.calls.match(/^pr view$/gm)).toHaveLength(3);
  });

  it('retries an UNKNOWN mergeability read before polling CI (mutation: UNKNOWN read as CONFLICTING or as fatal)', () => {
    const root = tempRoot();
    writeJson(root, 'pr-1.json', ciPr({ mergeable: 'UNKNOWN' }));
    writeJson(root, 'pr-2.json', ciPr({ mergeable: 'UNKNOWN' }));
    writeJson(root, 'pr-3.json', ciPr());
    writeJson(root, 'pr.json', ciPr());
    writeRuns(root, 'runs.json', [workflowRun('CI', 'completed', 'success')]);

    const result = ciWait(root, ['--head', HEAD], [0, 0]);
    expect(result.status).toBe(0);
    expect(result.sleep).toBe('5\n5\n');
  });

  it('gives up retrying UNKNOWN after 6 reads and waits on CI anyway (mutation: retried without a bound, or failing at the bound)', () => {
    const root = tempRoot();
    for (const n of [1, 2, 3, 4, 5, 6]) writeJson(root, `pr-${n}.json`, ciPr({ mergeable: 'UNKNOWN' }));
    writeJson(root, 'pr.json', ciPr({ mergeable: 'UNKNOWN' }));
    writeRuns(root, 'runs.json', [workflowRun('CI', 'completed', 'success')]);

    const result = ciWait(root, ['--head', HEAD], [0, 0]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('mergeable=UNKNOWN after 6 reads; waiting on CI anyway');
    expect(result.sleep).toBe('5\n5\n5\n5\n5\n');
  });

  it("exits 12 when the PR's head moves off --head, without ever reading CI (mutation: no head re-check each tick)", () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    writeJson(root, 'pr-2.json', ciPr({ head: OTHER_HEAD }));
    writeRuns(root, 'runs.json', [workflowRun('CI', 'completed', 'success')]);

    const result = ciWait(root, ['--head', HEAD], [0, 0]);
    expect(result.status).toBe(12);
    expect(result.stderr).toContain(`ci=head-changed head=${OTHER_HEAD} want=${HEAD}`);
    expect(result.calls).not.toContain('actions/runs');
  });

  it('times out while CI is still pending at --timeout (mutation: the deadline ignored)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    writeRuns(root, 'runs.json', [workflowRun('CI', 'in_progress', null)]);

    const result = ciWait(root, ['--head', HEAD, '--timeout', '60'], [0, 0, 0, 30, 30, 60, 60]);
    expect(result.status).toBe(11);
    expect(result.stderr).toContain(`ci=timeout head=${HEAD} after 60s: ci_pending: CI=in_progress`);
  });

  it('exits 1 when the PR is no longer open (mutation: a merged PR treated as waitable)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr({ state: 'MERGED' }));

    const result = ciWait(root, ['--head', HEAD], [0]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PR #1 is MERGED');
  });

  it('gives up after three CI reads fail in a row (mutation: never giving up, so it loops until it times out)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());

    const result = ciWait(root, ['--head', HEAD], [0, 0, 0, 30, 30, 60]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the CI read failed 3 times in a row');
  });

  it('recovers from one failed CI read (mutation: exit 1 on the first failed read)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    writeRuns(root, 'runs-2.json', [workflowRun('CI', 'completed', 'success')]);

    const result = ciWait(root, ['--head', HEAD], [0, 0, 0, 30]);
    expect(result.status).toBe(0);
  });

  it.each([
    ['no --head', []],
    ['a short head', ['--head', HEAD.slice(0, 12)]],
    ['a zero timeout', ['--head', HEAD, '--timeout', '0']],
    ['a non-numeric timeout', ['--head', HEAD, '--timeout', 'x']],
    ['an unknown argument', ['--head', HEAD, '--bogus']],
  ])('refuses %s, reading nothing (mutation: validation after the first read)', (_case, args) => {
    const root = tempRoot();

    const result = ciWait(root, args, [0]);
    expect(result.status).toBe(2);
    expect(result.calls).toBe('');
  });
});

describe('receipt-order.jq', () => {
  const SCRIPTS_DIR = path.dirname(HELPER);

  // Through bash, because the test harness allows only bash subprocesses
  // (allowSubprocess(['bash']) above) — never a direct jq spawn.
  function runJq(program: string) {
    return spawnSync('bash', ['-c', 'jq -nc -L "$1" "$2"', '_', SCRIPTS_DIR, program], {
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  it('keys posting order by [length, idstr], typed — never through tonumber (mutation: def posting_key: tonumber; fails on jq 1.7 too)', () => {
    const result = runJq('include "receipt-order"; ["12345678901234567891","12345678901234567890"] | map(posting_key)');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      [20, '12345678901234567891'],
      [20, '12345678901234567890'],
    ]);
  });

  it('sorts the later 20-digit id after the earlier one, past double precision', () => {
    const result = runJq(
      'include "receipt-order"; ["12345678901234567891","12345678901234567890"] | sort_by(posting_key) | map(.)',
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['12345678901234567890', '12345678901234567891']);
  });

  it.each([
    ['100', true],
    ['1\n', false],
    ['099', false],
    ['0', false],
    ['abc', false],
    ['', false],
    [null, false],
  ])('reads %s as canonical=%s', (input, expected) => {
    const result = runJq(`include "receipt-order"; ${JSON.stringify(input)} | canonical_id`);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe(expected);
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
    expect(scope.calls).not.toContain('/files');

    const request = runHelper(root, ['request']);
    expect(request.status).toBe(20);
    expect(request.stderr).toContain('automatic review handles this repo; never request');
    expect(request.posted).toBeNull();
    expect(request.calls).not.toMatch(/^(node|pr comment)/m);

    const merge = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(merge.status).toBe(26);
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
    ['on the base without risk:high anywhere', "docs:\n- changed-files:\n  - any-glob-to-any-file: ['docs/**']\n"],
  ])('treats a repo whose labeler.yml is %s as legacy', (_case, baseConfig) => {
    const root = tempRoot();
    scopeFixture(root, { baseConfig, labels: ['risk:high'] });
    fs.writeFileSync(path.join(root, 'labeler--feat.yml'), RISK_CONFIG);

    const result = runHelper(root, ['scope']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'legacy', verdict: 'auto' });
    expect(result.calls).toContain('rest repos/example/repository/git/ref/heads/main\n');
    expect(result.calls).toContain(`rest repos/example/repository/contents/.github/labeler.yml?ref=${BASE_OID}\n`);
    expect(result.calls).not.toMatch(/ref=(feat|main)/);
  });

  it.each([
    [
      'nested under another label',
      "docs:\n- changed-files:\n  - any-glob-to-any-file: ['docs/**']\n  risk:high: nested\n",
    ],
    [
      'in an indented document',
      "  risk:high:\n  - changed-files:\n    - any-glob-to-any-file:\n      - 'src/router.ts'\n",
    ],
    ['as an explicit key', "? risk:high\n: - changed-files:\n    - any-glob-to-any-file:\n      - 'src/router.ts'\n"],
    ['with a hex escape', `"\\x72isk:high":\n- changed-files:\n  - any-glob-to-any-file:\n    - 'src/router.ts'\n`],
    [
      'with a unicode escape',
      `"\\u0072isk:high":\n- changed-files:\n  - any-glob-to-any-file:\n    - 'src/router.ts'\n`,
    ],
    [
      'across an escaped line break',
      `? "ri\\\n  sk:high"\n: - changed-files:\n    - any-glob-to-any-file:\n      - 'src/router.ts'\n`,
    ],
  ])(
    'treats a base labeler.yml that names risk:high %s as risk-scoped, and fails closed to review',
    (_case, baseConfig) => {
      const root = tempRoot();
      scopeFixture(root, { baseConfig, labels: [] });

      const scope = runHelper(root, ['scope']);
      expect(scope.status).toBe(0);
      const out = JSON.parse(scope.stdout) as { reason: string };
      expect(out).toMatchObject({ mode: 'risk-scoped', verdict: 'review' });
      expect(out.reason).toContain(
        'fail closed: risk:high in .github/labeler.yml is not the one top-level `risk:high:` key codex-review.sh reads',
      );

      const merge = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(merge.status).toBe(24);
    },
  );

  it.each([
    [['risk:high'], 'labeled risk:high'],
    [['review:requested'], 'labeled review:requested'],
    [['review:requested', 'risk:high'], 'labeled review:requested; labeled risk:high'],
  ])('reviews a head labeled %j that changes no risky file: a label only adds review', (labels, reason) => {
    const root = tempRoot();
    scopeFixture(root, { labels });

    const result = runHelper(root, ['scope']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      repo: 'example/repository',
      pr: 1,
      head: HEAD,
      mode: 'risk-scoped',
      verdict: 'review',
      labels,
      reason,
    });
  });

  it('skips a head that changes no risky file and carries neither scope label, waiting on no labeler run', () => {
    const root = tempRoot();
    scopeFixture(root, {
      labels: ['PR: Fix'],
      files: [changedFile('docs/notes.md'), changedFile('src/routes.ts'), changedFile('github/ci.yml')],
    });

    const scope = runHelper(root, ['scope']);
    expect(scope.status).toBe(0);
    const out = JSON.parse(scope.stdout) as { reason: string };
    expect(out).toMatchObject({ mode: 'risk-scoped', verdict: 'skip', head: HEAD, labels: ['PR: Fix'] });
    expect(out.reason).toContain('no changed file matches a risk:high glob');
    expect(scope.calls).toContain(`rest repos/example/repository/compare/${BASE_OID}...${HEAD}?per_page=1\n`);
    expect(scope.calls).not.toContain('/pulls/1/files');
    expect(scope.calls).not.toContain('actions/runs');
    expect(scope.sleep).toBe('');

    const merge = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(merge.status).toBe(0);
    expect(merge.stdout).toContain(`merge=allowed head=${HEAD} mode=risk-scoped verdict=skip ci=green`);
  });

  it.each([
    ['a file on a risky path', [changedFile('src/router.ts')], 'src/router.ts'],
    ['a new workflow under a dot directory', [changedFile('.github/workflows/new.yml')], '.github/workflows/new.yml'],
    ['a rename off a risky path', [changedFile('src/routing.ts', 'src/router.ts')], 'src/router.ts'],
  ])('reviews a head with no label that changes %s', (_case, files, file) => {
    const root = tempRoot();
    scopeFixture(root, { labels: [], files });

    const scope = runHelper(root, ['scope']);
    expect(scope.status).toBe(0);
    expect(JSON.parse(scope.stdout)).toMatchObject({
      verdict: 'review',
      labels: [],
      reason: `changes risk:high path ${file}`,
    });

    const merge = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(merge.status).toBe(24);
    expect(merge.stderr).toContain(`no review of this head was requested`);
    expect(merge.stderr).toContain(`changes risk:high path ${file}`);
  });

  it('names the first three risky paths, counts the rest, then the scope labels', () => {
    const root = tempRoot();
    scopeFixture(root, {
      labels: ['review:requested'],
      files: [...['e', 'd', 'c', 'b', 'a'].map((n) => changedFile(`.github/${n}.yml`)), changedFile('docs/x.md')],
    });

    const scope = runHelper(root, ['scope']);
    expect(JSON.parse(scope.stdout)).toMatchObject({
      verdict: 'review',
      reason:
        'changes risk:high paths .github/a.yml, .github/b.yml, .github/c.yml and 2 more; labeled review:requested',
    });
  });

  it.each([
    ['the changed files cannot be listed', { files: null }, 'fail closed: could not list the files this head changes'],
    [
      "the comparison reaches GitHub's 300-file cap",
      { files: Array.from({ length: 300 }, (_, i) => changedFile(`docs/${i}.md`)) },
      'fail closed: the comparison lists 300 files, the most GitHub lists',
    ],
    [
      'the PR changes more files than GitHub listed',
      { files: [changedFile('docs/a.md')], changedFiles: 3001 },
      'fail closed: the PR changes 3001 files but the comparison lists 1',
    ],
    [
      'the comparison lists more files than the PR changes',
      { files: [changedFile('docs/a.md'), changedFile('docs/b.md')], changedFiles: 1 },
      'fail closed: the PR changes 1 files but the comparison lists 2',
    ],
    [
      "the base branch's risk:high holds a second rule, which the labeler would AND",
      { baseConfig: `${RISK_CONFIG}- changed-files:\n  - any-glob-to-any-file:\n    - 'docs/**'\n` },
      'is not the one shape codex-review.sh reads',
    ],
    [
      'a base branch risk:high glob uses syntax the matcher does not read',
      { baseConfig: "risk:high:\n- changed-files:\n  - any-glob-to-any-file:\n    - 'src/{router,delivery}.ts'\n" },
      'uses syntax codex-review.sh does not match',
    ],
  ])('fails closed to review when %s', (_case, fixture, reason) => {
    const root = tempRoot();
    scopeFixture(root, { labels: [], ...fixture });

    const scope = runHelper(root, ['scope']);
    expect(scope.status).toBe(0);
    const out = JSON.parse(scope.stdout) as { verdict: string; reason: string };
    expect(out.verdict).toBe('review');
    expect(out.reason).toContain(reason);

    const merge = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(merge.status).toBe(24);
  });

  it('judges the files of the head it read, not what the unpinned listing serves meanwhile', () => {
    // The head it read changes src/router.ts. Between the two head reads the
    // branch is pushed to a harmless commit with as many files and back again, so
    // both reads see the same head while pulls/<n>/files lists the other commit.
    const root = tempRoot();
    scopeFixture(root, {
      labels: [],
      files: [changedFile('src/router.ts')],
      unpinnedFiles: [changedFile('docs/notes.md')],
    });

    const scope = runHelper(root, ['scope']);
    expect(scope.status).toBe(0);
    expect(JSON.parse(scope.stdout)).toMatchObject({
      head: HEAD,
      verdict: 'review',
      reason: 'changes risk:high path src/router.ts',
    });
    expect(scope.calls).toContain(`rest repos/example/repository/compare/${BASE_OID}...${HEAD}?per_page=1\n`);
    expect(scope.calls).not.toContain('/pulls/1/files');
    expect(scope.calls.match(/^pr view$/gm)).toHaveLength(2);
  });

  it('reads labeler.yml and the comparison at the one base commit it resolved, whatever the branch name serves', () => {
    // The base branch moves after scope resolves it: read by name now, labeler.yml
    // has no risky glob and the comparison shows only a harmless file. Both base
    // reads must use the commit it resolved, where src/router.ts is risky.
    const root = tempRoot();
    scopeFixture(root, { labels: [], files: [changedFile('src/router.ts')] });
    fs.writeFileSync(
      path.join(root, 'labeler--main.yml'),
      "risk:high:\n- changed-files:\n  - any-glob-to-any-file:\n    - 'nothing/**'\n",
    );
    writeJson(root, `compare--main...${HEAD}.json`, { status: 'ahead', files: [changedFile('docs/notes.md')] });

    const scope = runHelper(root, ['scope']);
    expect(scope.status).toBe(0);
    expect(JSON.parse(scope.stdout)).toMatchObject({
      head: HEAD,
      verdict: 'review',
      reason: 'changes risk:high path src/router.ts',
    });
    const baseReads = scope.calls.split('\n').filter((line) => /git\/ref|labeler\.yml|\/compare\//.test(line));
    expect(baseReads).toEqual([
      'rest repos/example/repository/git/ref/heads/main',
      `rest repos/example/repository/contents/.github/labeler.yml?ref=${BASE_OID}`,
      `rest repos/example/repository/compare/${BASE_OID}...${HEAD}?per_page=1`,
    ]);
  });

  it("judges an open PR by the base branch's rules now, not those at its last push", () => {
    // .mcp.json became risky on main after this PR's last push, so the labeler.yml
    // at the PR's own baseRefOid (STALE_BASE) has no rule for it.
    const root = tempRoot();
    scopeFixture(root, {
      labels: [],
      files: [changedFile('.mcp.json')],
      baseConfig: "risk:high:\n- changed-files:\n  - any-glob-to-any-file:\n    - 'src/router.ts'\n    - '.mcp.json'\n",
    });
    fs.writeFileSync(path.join(root, `labeler--${STALE_BASE}.yml`), RISK_CONFIG);
    writeJson(root, `compare--${STALE_BASE}...${HEAD}.json`, { status: 'ahead', files: [changedFile('.mcp.json')] });

    const scope = runHelper(root, ['scope']);
    expect(JSON.parse(scope.stdout)).toMatchObject({ verdict: 'review', reason: 'changes risk:high path .mcp.json' });
    expect(scope.calls).not.toContain(STALE_BASE);
  });

  it('calls a repo legacy when the base commit it resolved has no labeler.yml, as in a repo that never opted in', () => {
    const root = tempRoot();
    scopeFixture(root, { baseConfig: null, labels: [] });

    const scope = runHelper(root, ['scope']);
    expect(scope.status).toBe(0);
    expect(JSON.parse(scope.stdout)).toMatchObject({ mode: 'legacy', verdict: 'auto' });
    expect(scope.calls).toContain(`rest repos/example/repository/contents/.github/labeler.yml?ref=${BASE_OID}\n`);

    const merge = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(merge.status).toBe(26);
    expect(merge.stdout).toContain('merge=defer mode=legacy');
  });

  it.each([
    [
      'the base branch does not resolve to a commit',
      (root: string) => fs.rmSync(path.join(root, 'ref--main')),
      'fail closed: could not resolve base branch main to a commit',
    ],
    [
      'GitHub finds no commit for the base it resolved',
      (root: string) => fs.writeFileSync(path.join(root, `labeler--${BASE_OID}.nocommit`), ''),
      `fail closed: could not read .github/labeler.yml at ${BASE_OID}`,
    ],
    [
      'reading labeler.yml fails with anything but path-not-found',
      (root: string) => fs.writeFileSync(path.join(root, `labeler--${BASE_OID}.error`), ''),
      `fail closed: could not read .github/labeler.yml at ${BASE_OID}`,
    ],
  ])('fails closed to review, not legacy, when %s', (_case, breakBase, reason) => {
    const root = tempRoot();
    scopeFixture(root, { baseConfig: null, labels: [] });
    breakBase(root);

    const scope = runHelper(root, ['scope']);
    expect(scope.status).toBe(0);
    expect(JSON.parse(scope.stdout)).toMatchObject({ mode: 'risk-scoped', verdict: 'review', reason });

    const merge = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(merge.status).toBe(24);
    expect(merge.stdout).not.toContain('merge=');
  });

  it('refuses the merge when the base branch moves while merge-check runs, and names the base it allowed on', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: [] });

    const allowed = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toContain(
      `merge=allowed head=${HEAD} mode=risk-scoped verdict=skip ci=green base=${BASE_OID}:`,
    );
    expect(allowed.calls.match(/^rest repos\/example\/repository\/git\/ref\/heads\/main$/gm)).toHaveLength(2);

    // main moves to a commit whose labeler.yml would select this head, between
    // the verdict's read and the one merge-check makes before allowing.
    fs.writeFileSync(path.join(root, 'ref--main-2'), MOVED_BASE);
    const moved = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(moved.status).toBe(25);
    expect(moved.stderr).toContain(
      `base=${BASE_OID}: base moved during check (main is now ${MOVED_BASE}); re-run merge-check`,
    );
    expect(moved.stdout).not.toContain('merge=allowed');
  });

  it('defers a legacy repo with exit 26, never 0, after re-reading its base', () => {
    const root = tempRoot();
    scopeFixture(root, { baseConfig: null, labels: [] });

    const merge = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(merge.status).toBe(26);
    expect(merge.stdout).toContain('merge=defer mode=legacy: example/repository is not risk-scoped');
    expect(merge.stdout).not.toContain('merge=allowed');
    expect(merge.calls.match(/^rest repos\/example\/repository\/git\/ref\/heads\/main$/gm)).toHaveLength(2);
  });

  it('refuses a legacy defer with exit 25 when the base moves while merge-check runs', () => {
    // The moved base may be the commit that opts the repo in, so the defer is stale.
    const root = tempRoot();
    scopeFixture(root, { baseConfig: null, labels: [] });
    fs.writeFileSync(path.join(root, 'ref--main-2'), MOVED_BASE);

    const merge = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(merge.status).toBe(25);
    expect(merge.stderr).toContain(`base moved during check (main is now ${MOVED_BASE}); re-run merge-check`);
    expect(merge.stdout).not.toContain('merge=');
  });

  it('fails closed when the head moves while its changed files are listed', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: [] });
    writeJson(root, 'pr-2.json', prState([], OTHER_HEAD));

    const result = runHelper(root, ['scope']);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { reason: string };
    expect(out).toMatchObject({ verdict: 'review', head: OTHER_HEAD });
    expect(out.reason).toContain(`the head moved from ${HEAD} while its changed files were listed`);
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
      `merge=allowed head=${HEAD} mode=risk-scoped verdict=review ci=green base=${BASE_OID}: codex=clean head=${HEAD} open=0`,
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
    ['fix: close the gate', ''],
    ['fix(runner): keep the stream open', 'Follows up on #608.'],
    ['Fix(hooks)!: refuse rewritten remotes', 'Fixes-PR: 611'],
    ['FIX: a typo', 'See Fixes-PR: #12 above.'],
    ['fix: split value', 'Fixes-PR:\n#12'],
    ['fix: glued value', 'Fixes-PR: #12abc'],
    ['fix: fenced example', 'Write it like this:\n\n```\nFixes-PR: #12\n```'],
    ['fix: unclosed fence', 'Example:\n```\nFixes-PR: #12'],
    ['fix: template comment', '<!-- Fixes-PR: none -->'],
    ['fix: tilde fence', 'Like this:\n~~~\nFixes-PR: #12\n~~~'],
    ['fix: four-backtick fence around a three-backtick line', '````md\n```\nFixes-PR: #12\n```\n````'],
    ['fix: indented fence', 'Like this:\n   ```\nFixes-PR: #12\n   ```'],
    ['fix: fence with CRLF endings', 'Like this:\r\n```\r\nFixes-PR: #12\r\n```\r\n'],
    ['fix: a tilde line does not close a backtick fence', '```\n~~~\nFixes-PR: #12\n~~~'],
  ])('refuses the fix PR %j with body %j, which names no Fixes-PR', (title, body) => {
    const root = tempRoot();
    scopeFixture(root, { labels: [], title, body });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain("a fix PR needs a 'Fixes-PR: #<n>' line in its body");
  });

  it.each([
    ['fix: close the gate', 'Summary.\n\nFixes-PR: #608'],
    ['fix(runner): a new bug', 'fixes-pr: none'],
    ['fix: windows line endings', 'Summary.\r\n\r\nFixes-PR:#12\r\nMore.'],
    ['fix: a real line after an example', '```\nFixes-PR: #1\n```\n\nFixes-PR: #608'],
    ['fix: a real line after a tilde fence', '~~~\nFixes-PR: #1\n~~~\nFixes-PR: #608'],
    ['fix: a real line after a CRLF fence', '```\r\nx\r\n```\r\nFixes-PR: none\r\n'],
    ['feat: add a gate', ''],
    ['docs: fix a typo', ''],
  ])('allows %j with body %j', (title, body) => {
    const root = tempRoot();
    scopeFixture(root, { labels: [], title, body });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`merge=allowed head=${HEAD} mode=risk-scoped verdict=skip ci=green`);
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

  it.each([
    ['an embedded newline (a\\nb)', 'a\nb'],
    ['an embedded newline (b\\na)', 'b\na'],
    ['a trailing carriage return', 'claude-opus-5\r'],
    ['an embedded carriage return', 'claude-opus-5\rmore'],
  ])('refuses a receipt whose --reviewer contains %s, posting nothing', (_case, reviewer) => {
    const root = tempRoot();
    const bodyFile = path.join(root, 'review.md');
    fs.writeFileSync(bodyFile, 'Scope: complete diff.\n');

    const result = runHelper(root, [
      'receipt',
      '--head',
      HEAD,
      '--outcome',
      'approve',
      '--reviewer',
      reviewer,
      '--body-file',
      bodyFile,
    ]);
    expect(result.status).toBe(2);
    expect(result.posted).toBeNull();
    expect(result.stderr).toContain('newline or carriage return');
  });

  it.each([
    ['claude-sonnet-5', 'claude-sonnet-5'],
    ['claude-haiku-4-5', 'claude-haiku-4-5 (worker-fast)'],
    ['gpt-5.6-luna', 'gpt-5.6-luna via codex exec'],
    ['gpt-5.6-terra', 'gpt-5.6-terra via codex exec'],
    ['a bare model name with no id', 'Opus 5'],
    // Mutation evidence for the grep-argument-injection fix: these tokens, if
    // ever handed to grep as a bare pattern argument again (no `-e`/`--`),
    // would be parsed as grep's OWN flags and exit 0 on no real match —
    // "fixed" nothing, posted anyway. Pure-bash string comparison never does
    // that regardless of what the token looks like.
    ['a grep -V flag token', 'claude-sonnet-5 -V'],
    ['a bare grep --version flag token', '--version'],
    ['a grep --help flag token', 'claude-haiku-4-5 --help'],
    ['a grep -v flag token', 'claude-sonnet-5 -v x'],
    // Mutation evidence for first-token-only matching: an allowed id appearing
    // ANYWHERE but the first word must still refuse — the documented receipt
    // format leads with the id, so this is not a legitimate reviewer string.
    ['an allowed id mentioned after a disallowed first token', 'claude-sonnet-5 (fallback from claude-opus-5)'],
  ])('refuses a receipt whose --reviewer names %s, a non-allowlisted model, posting nothing', (_case, reviewer) => {
    const root = tempRoot();
    const bodyFile = path.join(root, 'review.md');
    fs.writeFileSync(bodyFile, 'Scope: complete diff.\n');

    const result = runHelper(root, [
      'receipt',
      '--head',
      HEAD,
      '--outcome',
      'approve',
      '--reviewer',
      reviewer,
      '--body-file',
      bodyFile,
    ]);
    expect(result.status).toBe(2);
    expect(result.posted).toBeNull();
    expect(result.stderr).toContain('reviewer-models.txt');
  });

  it('accepts a receipt whose --reviewer names every listed model id, including a [1m] form', () => {
    const modelsFile = path.resolve('container/skills/pr-review-loop/reviewer-models.txt');
    const ids = fs
      .readFileSync(modelsFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    expect(ids.length).toBeGreaterThan(0);

    // Every plain listed id, plus one with the [1m] context-window suffix appended.
    const reviewers = [...ids.map((id) => `${id} (worker-high)`), `${ids[0]}[1m] (worker-high)`];
    for (const reviewer of reviewers) {
      const root = tempRoot();
      const bodyFile = path.join(root, 'review.md');
      fs.writeFileSync(bodyFile, 'Scope: complete diff.\n');

      const result = runHelper(root, [
        'receipt',
        '--head',
        HEAD,
        '--outcome',
        'approve',
        '--reviewer',
        reviewer,
        '--body-file',
        bodyFile,
      ]);
      expect(result.status, `reviewer "${reviewer}" was refused: ${result.stderr}`).toBe(0);
      expect(result.posted).toContain(`- **Reviewer and runtime:** ${reviewer}`);
    }
  });

  it('refuses a review-verdict head whose approving receipt names a disallowed reviewer model', () => {
    const root = tempRoot();
    scopeFixture(root, {
      labels: ['risk:high'],
      comments: [marker(HEAD, 1), receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'OWNER', 'claude-sonnet-5')],
    });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain('disallowed reviewer');
    expect(result.stderr).toContain('reviewer-models.txt');
  });

  it.each([
    ['a grep -V flag token', 'claude-sonnet-5 -V'],
    ['a bare grep --version flag token', '--version'],
    ['a grep --help flag token', 'claude-haiku-4-5 --help'],
    ['a grep -v flag token', 'claude-sonnet-5 -v x'],
    ['an allowed id mentioned after a disallowed first token', 'claude-sonnet-5 (fallback from claude-opus-5)'],
  ])(
    'refuses a review-verdict head whose approving receipt reviewer is %s (mutation evidence for the grep-injection/first-token fix)',
    (_case, reviewer) => {
      const root = tempRoot();
      scopeFixture(root, {
        labels: ['risk:high'],
        comments: [marker(HEAD, 1), receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'OWNER', reviewer)],
      });

      const result = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(result.status, `reviewer "${reviewer}" was wrongly allowed: ${result.stdout}`).toBe(24);
      expect(result.stderr).toContain('disallowed reviewer');
    },
  );

  it('allows a review-verdict head on an approving substitute receipt for exactly that head', () => {
    const root = tempRoot();
    scopeFixture(root, {
      labels: ['risk:high'],
      comments: [marker(HEAD, 1), receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z')],
    });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `merge=allowed head=${HEAD} mode=risk-scoped verdict=review ci=green base=${BASE_OID}: the latest substitute receipt for this head approves`,
    );
  });

  it.each([
    ['approves an older head', [receiptComment(OLD_HEAD, 'approve', '2026-09-05T00:20:00Z')], 'receipt: none'],
    // Listed newest first, so only a sort by posting order — not list order — finds the later `changes`.
    [
      'approved, then asked for changes',
      [
        receiptComment(HEAD, 'changes', '2026-09-05T00:30:00Z'),
        receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z'),
      ],
      'receipt: changes',
    ],
    // One second, listed out of posting order: only the comment's database id finds the later `changes`.
    [
      'approved, then asked for changes within the same second',
      [
        receiptComment(HEAD, 'changes', '2026-09-05T00:20:00Z', 'OWNER', 'claude-opus-5 (worker-high)', '101'),
        receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'OWNER', 'claude-opus-5 (worker-high)', '100'),
      ],
      'receipt: changes',
    ],
    // 20-digit ids differ only in the last digit — past 2^53, `tonumber` is a
    // jq double and can round both to the same value. Listed with the later
    // (higher) id first, so only an exact digit-string comparison, not list
    // order and not a lossy numeric one, finds it the later `changes`.
    [
      'approved, then asked for changes within the same second, with ids past double precision',
      [
        receiptComment(
          HEAD,
          'changes',
          '2026-09-05T00:20:00Z',
          'OWNER',
          'claude-opus-5 (worker-high)',
          '12345678901234567891',
        ),
        receiptComment(
          HEAD,
          'approve',
          '2026-09-05T00:20:00Z',
          'OWNER',
          'claude-opus-5 (worker-high)',
          '12345678901234567890',
        ),
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

  // Codex's round-3 repro (#679): page 1 carries an approval (id "100"); a
  // later same-second `changes` receipt lands on page 2 with a null
  // fullDatabaseId — GraphQL's real behavior for that nullable BigInt field.
  // `(.fullDatabaseId // "0") | tonumber` used to read the null as 0, ranking
  // it below the approval and merging over a rejection. It must instead
  // refuse: no order is inferred for it.
  it('refuses to merge when a same-second receipt has a null database id, split across comment pages', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: ['risk:high'] });
    writePage(
      root,
      'comments',
      1,
      connectionPage(
        'comments',
        [receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'OWNER', 'claude-opus-5 (worker-high)', '100')],
        true,
        'comments-2',
      ),
    );
    writePage(
      root,
      'comments',
      2,
      connectionPage('comments', [
        receiptComment(HEAD, 'changes', '2026-09-05T00:20:00Z', 'OWNER', 'claude-opus-5 (worker-high)', null),
      ]),
    );

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain('receipt_order_unknown');
  });

  it.each([
    ['a non-digit id', 'abc'],
    ['an empty-string id', ''],
    ['an id with a trailing newline', '1\n'],
    ['an id with a leading zero', '099'],
    ['a zero id', '0'],
  ])('refuses to merge when a receipt has %s instead of a database id', (_case, badId) => {
    const root = tempRoot();
    scopeFixture(root, {
      labels: ['risk:high'],
      comments: [
        receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'OWNER', 'claude-opus-5 (worker-high)', '100'),
        receiptComment(HEAD, 'changes', '2026-09-05T00:20:00Z', 'OWNER', 'claude-opus-5 (worker-high)', badId),
      ],
    });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain('receipt_order_unknown');
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
      title: 'fix: a fix with no Fixes-PR line',
      comments: [receiptComment(HEAD, 'changes', '2026-09-05T00:20:00Z')],
      ci: [workflowRun('CI', 'completed', 'failure')],
      statuses: [commitStatus('ci/external', 'pending')],
    });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(26);
    expect(result.stdout).toContain('merge=defer mode=legacy');
    expect(result.calls).not.toContain('actions/runs');
    expect(result.calls).not.toContain('statuses');
    expect(result.calls).not.toContain('/files');
    expect(result.calls).not.toMatch(/^comments /m);
  });
});

// After `gh pr merge` succeeds, the PR reads as merged into MERGE_OID.
function mergesTo(root: string): void {
  writeJson(root, 'pr-merged.json', { ...prState([]), state: 'MERGED', mergeCommit: { oid: MERGE_OID } });
}

// How a PR can land: a merge commit whose second parent is the head, or a squash
// GitHub signed, both of which `merge` makes; a rebase merge, one unsigned parent
// that may be one of the PR's own commits; and a merge made by hand of another commit.
const MERGE_SHAPES = {
  merge: { parents: [MERGE_PARENT, HEAD], signature: { isValid: true, wasSignedByGitHub: true } },
  squash: { parents: [MERGE_PARENT], signature: { isValid: true, wasSignedByGitHub: true } },
  rebase: { parents: [OTHER_HEAD], signature: null },
  manual: { parents: [MERGE_PARENT, OTHER_HEAD], signature: null },
};

// A label event on the PR's timeline.
function labelEvent(name: string, createdAt: string, removed = false): Page {
  return { __typename: removed ? 'UnlabeledEvent' : 'LabeledEvent', createdAt, label: { name } };
}

// A merged PR as `audit` reads it: merged at MERGED_AT onto MERGE_PARENT, by
// default through a merge commit, with its body's revisions (none = never
// edited), title renames and label events (by default, its labels added before
// the merge). labeler.yml and the comparison at MERGE_PARENT are the base's as
// of the merge.
function auditFixture(
  root: string,
  opts: NonNullable<Parameters<typeof scopeFixture>[1]> & {
    state?: string;
    edits?: Page[];
    renames?: Page[];
    labelEvents?: Page[];
    shape?: keyof typeof MERGE_SHAPES;
    parentConfig?: string | null;
  } = {},
): void {
  scopeFixture(root, opts);
  const files = opts.files ?? [changedFile('docs/notes.md')];
  writeJson(root, `compare--${MERGE_PARENT}...${HEAD}.json`, { status: 'ahead', files });
  const labeler = path.join(root, `labeler--${MERGE_PARENT}.yml`);
  if (opts.parentConfig === null) fs.rmSync(labeler, { force: true });
  else fs.writeFileSync(labeler, opts.parentConfig ?? RISK_CONFIG);
  const shape = MERGE_SHAPES[opts.shape ?? 'merge'];
  writePage(root, 'audit', 1, {
    data: {
      repository: {
        pullRequest: {
          state: opts.state ?? 'MERGED',
          mergedAt: MERGED_AT,
          headRefOid: HEAD,
          title: opts.title ?? 'feat: route a new message kind',
          body: opts.body ?? '',
          mergeCommit: {
            oid: MERGE_OID,
            parents: { totalCount: shape.parents.length, nodes: shape.parents.map((oid) => ({ oid })) },
            signature: shape.signature,
          },
          userContentEdits: { pageInfo: { hasNextPage: false }, nodes: opts.edits ?? [] },
          renames: { pageInfo: { hasNextPage: false }, nodes: opts.renames ?? [] },
          labelEvents: {
            pageInfo: { hasNextPage: false },
            nodes: opts.labelEvents ?? (opts.labels ?? []).map((name) => labelEvent(name, '2026-09-05T00:00:10Z')),
          },
        },
      },
    },
  });
}

describe('codex-review merge, the only merge path for a risk-scoped repo', () => {
  it('merges a head merge-check allows, pinned to that head, and prints the merge commit', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: [] });
    mergesTo(root);

    const result = runHelper(root, ['merge', '--head', HEAD]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `merge=allowed head=${HEAD} mode=risk-scoped verdict=skip ci=green base=${BASE_OID}`,
    );
    expect(result.stdout).toContain(`merged pr=1 head=${HEAD} method=merge commit=${MERGE_OID}`);
    expect(result.calls.match(/^merge-args .*$/gm)).toEqual([
      `merge-args pr merge 1 --repo example/repository --merge --match-head-commit ${HEAD}`,
    ]);
  });

  it('squashes when asked', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: [] });
    mergesTo(root);

    const result = runHelper(root, ['merge', '--head', HEAD, '--method', 'squash']);
    expect(result.status).toBe(0);
    expect(result.calls).toContain(
      `merge-args pr merge 1 --repo example/repository --squash --match-head-commit ${HEAD}`,
    );
  });

  it.each([
    ['CI is red on the head', { ci: [workflowRun('CI', 'completed', 'failure')] }, 24],
    ['a fix PR names no Fixes-PR', { title: 'fix: close the gate' }, 24],
    ['a review-verdict head has no review', { labels: ['risk:high'] }, 24],
    ['a receipt asked for changes', { comments: [receiptComment(HEAD, 'changes', '2026-09-05T00:20:00Z')] }, 24],
    ['the repo is legacy', { baseConfig: null }, 26],
  ])('never merges, and passes the code through, when merge-check refuses because %s', (_case, fixture, code) => {
    const root = tempRoot();
    scopeFixture(root, { labels: [], ...fixture });
    mergesTo(root);

    const result = runHelper(root, ['merge', '--head', HEAD]);
    expect(result.status).toBe(code);
    expect(result.calls).not.toContain('merge-args');
    expect(result.stdout).not.toContain('merged pr=');
  });

  it('never merges when merge-check reaches no verdict', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: [] });
    mergesTo(root);
    fs.rmSync(path.join(root, 'runs.json'));

    const result = runHelper(root, ['merge', '--head', HEAD]);
    expect(result.status).toBe(1);
    expect(result.calls).not.toContain('merge-args');
  });

  it('checks once more when the base moves during the check, and merges on that allow', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: [] });
    mergesTo(root);
    fs.writeFileSync(path.join(root, 'ref--main-2'), MOVED_BASE);

    const result = runHelper(root, ['merge', '--head', HEAD]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('base moved during check');
    expect(result.stderr).toContain('merge: the base moved while merge-check ran; checking once more');
    expect(result.calls.match(/^rest repos\/example\/repository\/git\/ref\/heads\/main$/gm)).toHaveLength(4);
    expect(result.calls.match(/^merge-args /gm)).toHaveLength(1);
  });

  it('runs merge-check inside this process, so a script replaced on disk mid-merge changes nothing', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: [] });
    mergesTo(root);
    // The base moves during the first check (exit 25) to a commit whose labeler.yml
    // selects docs/notes.md, so the second check refuses: no review of this head.
    for (const n of [2, 3, 4]) fs.writeFileSync(path.join(root, `ref--main-${n}`), MOVED_BASE);
    fs.writeFileSync(
      path.join(root, `labeler--${MOVED_BASE}.yml`),
      "risk:high:\n- changed-files:\n  - any-glob-to-any-file:\n    - 'docs/**'\n",
    );
    writeJson(root, `compare--${MOVED_BASE}...${HEAD}.json`, {
      status: 'ahead',
      files: [changedFile('docs/notes.md')],
    });
    // A copy of the skill to run, whose script the first gh call overwrites with one
    // that allows everything.
    const skill = path.join(root, 'skill');
    fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
    for (const name of ['codex-review.sh', 'risk-scope.jq', 'receipt-order.jq'])
      fs.copyFileSync(path.join(path.dirname(HELPER), name), path.join(skill, 'scripts', name));
    fs.copyFileSync(
      path.join(path.dirname(HELPER), '..', 'reviewer-models.txt'),
      path.join(skill, 'reviewer-models.txt'),
    );
    const script = path.join(skill, 'scripts', 'codex-review.sh');
    fs.writeFileSync(
      path.join(root, 'evil.sh'),
      '#!/usr/bin/env bash\ntouch "$MOCK_DIR/evil-ran"\necho merge=allowed\nexit 0\n',
    );

    const result = runHelper(root, ['merge', '--head', HEAD], { MOCK_SWAP_SCRIPT: script }, script);
    expect(fs.readFileSync(script, 'utf8')).toContain('evil-ran');
    expect(result.stderr).toContain('merge: the base moved while merge-check ran; checking once more');
    expect(result.stderr).toContain(`merge=refused head=${HEAD} verdict=review: no review of this head was requested`);
    expect(result.status).toBe(24);
    expect(fs.existsSync(path.join(root, 'evil-ran'))).toBe(false);
    expect(result.calls).not.toContain('merge-args');
  });

  it('never merges when the base moves during both checks', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: [] });
    mergesTo(root);
    fs.writeFileSync(path.join(root, 'ref--main-2'), MOVED_BASE);
    fs.writeFileSync(path.join(root, 'ref--main-4'), MOVED_BASE);

    const result = runHelper(root, ['merge', '--head', HEAD]);
    expect(result.status).toBe(25);
    expect(result.calls).not.toContain('merge-args');
  });

  it('exits 27 when gh pr merge fails after merge-check allows the head', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: [] });
    mergesTo(root);

    const result = runHelper(root, ['merge', '--head', HEAD], { MOCK_MERGE_STATUS: '1' });
    expect(result.status).toBe(27);
    expect(result.stderr).toContain(
      `merge=failed head=${HEAD}: merge-check allowed it, but gh pr merge did not merge PR #1`,
    );
  });

  it('exits 27 when gh pr merge returns but GitHub does not show the PR merged', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: [] });

    const result = runHelper(root, ['merge', '--head', HEAD]);
    expect(result.status).toBe(27);
    expect(result.stderr).toContain('does not read as merged');
  });

  it.each([
    ['no --head', ['merge']],
    ['a short head', ['merge', '--head', HEAD.slice(0, 12)]],
    ['a rebase merge', ['merge', '--head', HEAD, '--method', 'rebase']],
    ['an unknown argument', ['merge', '--head', HEAD, '--delete-branch']],
  ])('refuses %s before reading anything', (_case, args) => {
    const root = tempRoot();
    scopeFixture(root, { labels: [] });
    mergesTo(root);

    const result = runHelper(root, args);
    expect(result.status).toBe(2);
    expect(result.calls).toBe('');
  });
});

describe('codex-review audit, the gate re-judged as of a merge', () => {
  it('passes a merge the gate would have allowed, judged from the commit it merged onto', () => {
    const root = tempRoot();
    auditFixture(root, { labels: [] });
    // Today's main has a rule that would select docs/notes.md; the merge predates it.
    fs.writeFileSync(
      path.join(root, `labeler--${BASE_OID}.yml`),
      "risk:high:\n- changed-files:\n  - any-glob-to-any-file:\n    - 'docs/**'\n",
    );

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `audit=pass pr=1 head=${HEAD} base=${MERGE_PARENT} merged=${MERGED_AT} verdict=skip: no changed file matches`,
    );
    expect(result.calls).toContain(`rest repos/example/repository/contents/.github/labeler.yml?ref=${MERGE_PARENT}\n`);
    expect(result.calls).toContain(`rest repos/example/repository/compare/${MERGE_PARENT}...${HEAD}?per_page=1\n`);
    expect(result.calls).not.toContain('git/ref');
  });

  it('flags a fix PR whose body had no Fixes-PR line at its merge, though one was added after (#675)', () => {
    const root = tempRoot();
    auditFixture(root, {
      labels: [],
      title: 'fix(agents): the fleet workers are never reviewers',
      body: 'Why.\n\nFixes-PR: none',
      edits: [
        { editedAt: '2026-09-05T01:00:29Z', deletedAt: null, diff: 'Why.\n\nFixes-PR: none' },
        { editedAt: '2026-09-05T00:30:00Z', deletedAt: null, diff: 'Why.' },
      ],
    });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(28);
    expect(result.stdout).toContain(
      `audit=violation pr=1 head=${HEAD} base=${MERGE_PARENT} merged=${MERGED_AT} verdict=skip: a fix PR merged with no 'Fixes-PR:' line in its body at merge time`,
    );
  });

  it('passes a fix PR whose Fixes-PR line was in place before its merge', () => {
    const root = tempRoot();
    auditFixture(root, {
      labels: [],
      title: 'fix: close the gate',
      body: 'Why.\n\nFixes-PR: #12',
      edits: [
        { editedAt: '2026-09-05T00:50:00Z', deletedAt: null, diff: 'Why.\n\nFixes-PR: #12' },
        { editedAt: '2026-09-05T00:30:00Z', deletedAt: null, diff: 'Why.' },
      ],
    });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('audit=pass');
  });

  it('judges the title the PR had at its merge, not one it was renamed to after', () => {
    const root = tempRoot();
    auditFixture(root, {
      labels: [],
      title: 'feat: renamed after the merge',
      body: 'Why.',
      renames: [{ createdAt: '2026-09-05T02:00:00Z', previousTitle: 'fix: the title it merged with' }],
    });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(28);
    expect(result.stdout).toContain("no 'Fixes-PR:' line in its body at merge time");
  });

  it('flags a merge whose head CI was not green', () => {
    const root = tempRoot();
    auditFixture(root, { labels: [], ci: [workflowRun('CI', 'completed', 'failure')] });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(28);
    expect(result.stdout).toContain('verdict=skip: ci_red: CI=failure (required)');
  });

  it('counts only the CI that ran before the merge, not a run the merge itself set off', () => {
    const root = tempRoot();
    auditFixture(root, {
      labels: [],
      ci: [
        workflowRun('CI', 'completed', 'success', '2026-09-05T00:01:00Z'),
        // shadow-review.yml runs on pull_request_target: closed — on the head, seconds after the merge.
        workflowRun('Shadow review', 'completed', 'failure', '2026-09-05T01:00:03Z'),
      ],
    });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('audit=pass');
  });

  it.each([
    [
      'an approving receipt from an allowed reviewer, before the merge',
      { comments: [receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z')] },
      0,
      'an approving substitute receipt before the merge (claude-opus-5 (worker-high))',
    ],
    [
      'a clean Codex review, requested and given before the merge',
      { comments: [marker(HEAD, 1, '2026-09-05T00:05:00Z')], reviews: [review('2026-09-05T00:10:00Z', HEAD)] },
      0,
      'codex=clean',
    ],
    [
      'an approving receipt posted only after the merge',
      { comments: [receiptComment(HEAD, 'approve', '2026-09-05T02:00:00Z')] },
      28,
      'it merged with no review of this head requested and no approving receipt before the merge',
    ],
    [
      'a Codex review that came only after the merge',
      { comments: [marker(HEAD, 1, '2026-09-05T00:05:00Z')], reviews: [review('2026-09-05T02:00:00Z', HEAD)] },
      28,
      'codex=pending',
    ],
    [
      'a review request edited after the merge',
      {
        comments: [{ ...marker(HEAD, 1, '2026-09-05T00:05:00Z'), lastEditedAt: '2026-09-05T02:00:00Z' }],
        reviews: [review('2026-09-05T00:10:00Z', HEAD)],
      },
      28,
      'it merged with no review of this head requested and no approving receipt before the merge',
    ],
    [
      'an approving receipt from a disallowed reviewer',
      { comments: [receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'OWNER', 'claude-sonnet-5 (worker)')] },
      28,
      'the approving substitute receipt names a disallowed reviewer ("claude-sonnet-5 (worker)")',
    ],
    [
      'a receipt that asked for changes',
      { comments: [receiptComment(HEAD, 'changes', '2026-09-05T00:20:00Z')] },
      28,
      'the latest substitute receipt before the merge asked for changes',
    ],
  ])('judges a review-verdict merge with %s', (_case, fixture, code, reason) => {
    const root = tempRoot();
    auditFixture(root, { labels: ['risk:high'], ...fixture });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(code);
    expect(result.stdout).toContain(`verdict=review: ${reason}`);
  });

  it.each([
    [
      'the only approving receipt was edited after the merge',
      [{ ...receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z'), lastEditedAt: '2026-09-05T02:00:00Z' }],
      '2026-09-05T00:20:00Z',
    ],
    [
      'a comment after the approving receipt was edited after the merge, and may have asked for changes',
      [
        receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z'),
        { ...receiptComment(HEAD, 'approve', '2026-09-05T00:30:00Z'), lastEditedAt: '2026-09-05T02:00:00Z' },
      ],
      '2026-09-05T00:30:00Z',
    ],
    [
      'a changes receipt posted in the same second as the approval was edited after the merge',
      [
        receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'OWNER', 'claude-opus-5 (worker-high)', '100'),
        {
          ...receiptComment(HEAD, 'changes', '2026-09-05T00:20:00Z', 'OWNER', 'claude-opus-5 (worker-high)', '101'),
          lastEditedAt: '2026-09-05T02:00:00Z',
        },
      ],
      '2026-09-05T00:20:00Z',
    ],
  ])('flags a review-verdict merge when %s', (_case, comments, postedAt) => {
    const root = tempRoot();
    auditFixture(root, { labels: ['risk:high'], comments });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(28);
    expect(result.stdout).toContain(
      `verdict=review: davekim917 posted a comment at ${postedAt} and edited it at 2026-09-05T02:00:00Z after the merge; that comment could have been a later substitute receipt`,
    );
  });

  // Same repro as merge-check's: a null fullDatabaseId must not be read as an
  // earlier receipt, so a merge the gate would have refused isn't audited as
  // clean either.
  it('flags a merge when a same-second receipt has a null database id, split across comment pages', () => {
    const root = tempRoot();
    auditFixture(root, { labels: ['risk:high'] });
    writePage(
      root,
      'comments',
      1,
      connectionPage(
        'comments',
        [receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'OWNER', 'claude-opus-5 (worker-high)', '100')],
        true,
        'comments-2',
      ),
    );
    writePage(
      root,
      'comments',
      2,
      connectionPage('comments', [
        receiptComment(HEAD, 'changes', '2026-09-05T00:20:00Z', 'OWNER', 'claude-opus-5 (worker-high)', null),
      ]),
    );

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(28);
    expect(result.stdout).toContain('receipt_order_unknown');
  });

  it.each([
    ['a non-digit id', 'abc'],
    ['an empty-string id', ''],
    ['an id with a trailing newline', '1\n'],
    ['an id with a leading zero', '099'],
    ['a zero id', '0'],
  ])('flags a merge when a receipt has %s instead of a database id', (_case, badId) => {
    const root = tempRoot();
    auditFixture(root, {
      labels: ['risk:high'],
      comments: [
        receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'OWNER', 'claude-opus-5 (worker-high)', '100'),
        receiptComment(HEAD, 'changes', '2026-09-05T00:20:00Z', 'OWNER', 'claude-opus-5 (worker-high)', badId),
      ],
    });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(28);
    expect(result.stdout).toContain('receipt_order_unknown');
  });

  // #689 P3-3: canonical_id must guard the $unread comparison too, not just
  // $bad — an id that only coincidentally shares its length with the latest
  // receipt's must never let a non-canonical id outrank it (a 3-char "abc"
  // sorts lexicographically after a 3-char "100").
  it('still reads an approving receipt when an earlier, non-canonical-id comment was edited after the merge (mutation: remove the canonical_id guard from $unread)', () => {
    const root = tempRoot();
    auditFixture(root, {
      labels: ['risk:high'],
      comments: [
        {
          author: { login: 'davekim917' },
          authorAssociation: 'OWNER',
          createdAt: '2026-09-05T00:10:00Z',
          lastEditedAt: '2026-09-05T02:00:00Z',
          fullDatabaseId: 'abc',
          body: 'CI is green.',
        },
        receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'OWNER', 'claude-opus-5 (worker-high)', '100'),
      ],
    });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('verdict=review: an approving substitute receipt before the merge');
  });

  // #689 P3-4: a receipt posted in the merge's own second may have landed
  // after it — GitHub's timestamp has no sub-second precision — so it fails
  // closed the same way an edited-after-merge receipt does.
  it("flags a lone approval posted in the merge's own second (mutation: the pre-fix <= read set passes it)", () => {
    const root = tempRoot();
    auditFixture(root, {
      labels: ['risk:high'],
      comments: [receiptComment(HEAD, 'approve', MERGED_AT, 'OWNER', 'claude-opus-5 (worker-high)', '100')],
    });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(28);
    expect(result.stdout).toContain(`posted a comment at ${MERGED_AT}, the second the PR merged`);
  });

  it("flags a changes receipt posted in the merge's own second over an earlier approval (mutation: a plain < without the same-second join lets the approve win)", () => {
    const root = tempRoot();
    auditFixture(root, {
      labels: ['risk:high'],
      comments: [
        receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'OWNER', 'claude-opus-5 (worker-high)', '100'),
        receiptComment(HEAD, 'changes', MERGED_AT, 'OWNER', 'claude-opus-5 (worker-high)', '101'),
      ],
    });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(28);
    expect(result.stdout).toContain(`posted a comment at ${MERGED_AT}, the second the PR merged`);
  });

  it('passes a lone approval one second before the merge (mutation: an off-by-one pushes the boundary a second early)', () => {
    const root = tempRoot();
    auditFixture(root, {
      labels: ['risk:high'],
      comments: [
        receiptComment(HEAD, 'approve', '2026-09-05T00:59:59Z', 'OWNER', 'claude-opus-5 (worker-high)', '100'),
      ],
    });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('verdict=review: an approving substitute receipt before the merge');
  });

  it('still reads an approving receipt that postdates the only comment edited after the merge', () => {
    const root = tempRoot();
    auditFixture(root, {
      labels: ['risk:high'],
      comments: [
        {
          author: { login: 'davekim917' },
          authorAssociation: 'OWNER',
          createdAt: '2026-09-05T00:10:00Z',
          lastEditedAt: '2026-09-05T02:00:00Z',
          body: 'CI is green.',
        },
        receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z'),
      ],
    });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('verdict=review: an approving substitute receipt before the merge');
  });

  it('counts a run that finished only after the merge as pending at it, however it ended', () => {
    const root = tempRoot();
    auditFixture(root, {
      labels: [],
      ci: [workflowRun('CI', 'completed', 'success', '2026-09-05T00:01:00Z', HEAD, '2026-09-05T01:30:00Z')],
    });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(28);
    expect(result.stdout).toContain('verdict=skip: ci_pending: CI=updated after the merge');
  });

  it('judges the labels the PR had at its merge, counting one removed after it', () => {
    const root = tempRoot();
    auditFixture(root, {
      labels: [],
      labelEvents: [
        labelEvent('risk:high', '2026-09-05T00:00:10Z'),
        labelEvent('risk:high', '2026-09-05T02:00:00Z', true),
      ],
    });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(28);
    expect(result.stdout).toContain(
      'verdict=review: it merged with no review of this head requested and no approving receipt before the merge (labeled risk:high)',
    );
  });

  it('does not count a label added after the merge', () => {
    const root = tempRoot();
    auditFixture(root, { labels: ['risk:high'], labelEvents: [labelEvent('risk:high', '2026-09-05T02:00:00Z')] });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `audit=pass pr=1 head=${HEAD} base=${MERGE_PARENT} merged=${MERGED_AT} verdict=skip`,
    );
  });

  it.each(['merge', 'squash'] as const)('judges a %s from the commit it merged onto', (shape) => {
    const root = tempRoot();
    auditFixture(root, { labels: [], shape });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`audit=pass pr=1 head=${HEAD} base=${MERGE_PARENT}`);
  });

  it.each([
    ['a rebase merge', 'rebase', `1 parent (${OTHER_HEAD}) and is not signed by GitHub`],
    [
      'a merge made by hand of another commit',
      'manual',
      `2 parents (${MERGE_PARENT}, ${OTHER_HEAD}) and is not signed by GitHub`,
    ],
  ] as const)('flags %s outright, never judging it from a guessed base', (_case, shape, detail) => {
    const root = tempRoot();
    auditFixture(root, { labels: [], shape });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(28);
    expect(result.stdout).toContain(
      `audit=violation pr=1 head=${HEAD} merged=${MERGED_AT}: merge method the gate does not authorize (rebase or manual): merge commit ${MERGE_OID} has ${detail}`,
    );
    expect(result.calls).not.toContain('labeler.yml');
  });

  it('calls a merge into a base that was not risk-scoped then legacy, not a bypass', () => {
    const root = tempRoot();
    auditFixture(root, { labels: [], parentConfig: null, title: 'fix: no link' });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`audit=legacy pr=1 head=${HEAD} base=${MERGE_PARENT}`);
  });

  it('refuses to audit a PR that has not merged', () => {
    const root = tempRoot();
    auditFixture(root, { labels: [], state: 'OPEN' });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('PR #1 is OPEN, not merged');
  });

  it('fails loudly, never passing, when the body revision current at the merge was deleted', () => {
    const root = tempRoot();
    auditFixture(root, {
      labels: [],
      title: 'fix: close the gate',
      edits: [
        { editedAt: '2026-09-05T01:30:00Z', deletedAt: null, diff: 'Fixes-PR: none' },
        { editedAt: '2026-09-05T00:30:00Z', deletedAt: '2026-09-05T03:00:00Z', diff: null },
      ],
    });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('audit=error pr=1: could not reconstruct the PR as it stood at its merge');
    expect(result.stdout).not.toContain('audit=pass');
  });

  it('fails loudly, never passing, when CI on the head cannot be read', () => {
    const root = tempRoot();
    auditFixture(root, { labels: [] });
    fs.rmSync(path.join(root, 'runs.json'));

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not read CI on the head');
    expect(result.stdout).not.toContain('audit=pass');
  });
});
