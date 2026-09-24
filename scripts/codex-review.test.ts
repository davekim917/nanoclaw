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
# gh api user: the account the gate runs as, MOCK_GH_USER; unset = the read fails.
if [ "$1" = api ] && [ "$2" = user ]; then
  printf 'api user\\n' >> "$MOCK_CALLS"
  [ -n "\${MOCK_GH_USER:-}" ] || { echo 'gh: Bad credentials (HTTP 401)' >&2; exit 1; }
  echo "$MOCK_GH_USER"
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
    */actions/runs/*/attempts/*/jobs\\?*)
      # jobs--<run id>--attempt-<n>.json is that attempt's jobs page. A run
      # with no attempt pages at all is a single-attempt run, and its
      # jobs--<run id>.json answers for attempt 1. Absent = the read fails.
      id="\${rest#*/actions/runs/}"
      attempt="\${id#*/attempts/}"; attempt="\${attempt%%/*}"
      id="\${id%%/*}"
      src="$MOCK_DIR/jobs--$id--attempt-$attempt.json"
      if [ ! -f "$src" ] && [ "$attempt" = 1 ] && ! compgen -G "$MOCK_DIR/jobs--$id--attempt-*.json" >/dev/null; then
        src="$MOCK_DIR/jobs--$id.json"
      fi
      if [ ! -f "$src" ]; then
        echo '{"message":"Not Found","status":"404"}'
        echo 'gh: Not Found (HTTP 404)' >&2
        exit 1
      fi
      if printf '%s\\n' "$@" | grep -qx -- --slurp; then printf '['; cat "$src"; printf ']'; else cat "$src"; fi
      exit 0
      ;;
    */actions/runs/*/jobs\\?*)
      # jobs--<run id>.json is that run's jobs page. Absent = the read fails.
      id="\${rest#*/actions/runs/}"
      id="\${id%%/*}"
      if [ ! -f "$MOCK_DIR/jobs--$id.json" ]; then
        echo '{"message":"Not Found","status":"404"}'
        echo 'gh: Not Found (HTTP 404)' >&2
        exit 1
      fi
      if printf '%s\\n' "$@" | grep -qx -- --slurp; then printf '['; cat "$MOCK_DIR/jobs--$id.json"; printf ']'; else cat "$MOCK_DIR/jobs--$id.json"; fi
      exit 0
      ;;
    */actions/jobs/*)
      # job--<job id>.json is that one job. Absent = the read fails.
      id="\${rest##*/}"
      if [ ! -f "$MOCK_DIR/job--$id.json" ]; then
        echo '{"message":"Not Found","status":"404"}'
        echo 'gh: Not Found (HTTP 404)' >&2
        exit 1
      fi
      cat "$MOCK_DIR/job--$id.json"
      exit 0
      ;;
    */actions/runs/*/rerun)
      # POST re-run of a whole run: recorded; MOCK_RERUN_STATUS makes it fail.
      [[ " $* " == *" -X POST "* ]] || { echo 'mock: a re-run must be a POST' >&2; exit 9; }
      id="\${rest#*/actions/runs/}"
      id="\${id%%/*}"
      printf 'rerun %s\\n' "$id" >> "$MOCK_CALLS"
      if [ "\${MOCK_RERUN_STATUS:-0}" != 0 ]; then echo 'gh: Resource not accessible by personal access token (HTTP 403)' >&2; exit "$MOCK_RERUN_STATUS"; fi
      exit 0
      ;;
    */actions/runs/[0-9]*)
      # One run, as the script's --jq prints it (status<TAB>run_attempt):
      # run--<id>-<n>.tsv answers the nth read of it, run--<id>.tsv otherwise.
      # Absent = the read fails.
      id="\${rest##*/}"
      n=$(grep -c "^rest repos/[^ ]*/actions/runs/$id$" "$MOCK_CALLS")
      src="$MOCK_DIR/run--$id.tsv"
      if [ -f "$MOCK_DIR/run--$id-$n.tsv" ]; then src="$MOCK_DIR/run--$id-$n.tsv"; fi
      if [ ! -f "$src" ]; then echo '{"message":"Not Found","status":"404"}'; echo 'gh: Not Found (HTTP 404)' >&2; exit 1; fi
      cat "$src"
      exit 0
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
    */collaborators/*/permission)
      # permission--<login> holds that login's repository permission (absent = write), as the
      # script's --jq .permission prints it; a .error marker makes the lookup fail.
      login="\${rest#*/collaborators/}"
      login="\${login%/permission}"
      if [ -f "$MOCK_DIR/permission--$login.error" ]; then
        echo '{"message":"Not Found","status":"404"}'
        echo 'gh: Not Found (HTTP 404)' >&2
        exit 1
      fi
      if [ -f "$MOCK_DIR/permission--$login" ]; then cat "$MOCK_DIR/permission--$login"; else echo write; fi
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
    */rules/branches/*)
      # rules--<branch>.json is the branch's active rules. Absent = the read fails.
      branch="\${rest##*/rules/branches/}"
      [ -f "$MOCK_DIR/rules--$branch.json" ] || { echo '{"message":"Not Found","status":"404"}'; echo 'gh: Not Found (HTTP 404)' >&2; exit 1; }
      printf '['; cat "$MOCK_DIR/rules--$branch.json"; printf ']'
      exit 0
      ;;
    */branches/*/protection)
      # protection.json = classic protection is on; absent = GitHub's "Branch not protected" 404.
      if [ -f "$MOCK_DIR/protection.json" ]; then cat "$MOCK_DIR/protection.json"; exit 0; fi
      echo '{"message":"Branch not protected","status":"404"}'
      echo 'gh: Branch not protected (HTTP 404)' >&2
      exit 1
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
  *statusCheckRollup*) connection=rollup ;;
  *adminReadiness*) connection=adminReadiness ;;
  *reviewThreads*) connection=reviewThreads ;;
  *reviews*) connection=reviews ;;
  *reactions*) connection=reactions ;;
  *comments*) connection=comments ;;
  *) echo "unexpected GraphQL query" >&2; exit 64 ;;
esac
page=1
[ "$after" = "null" ] || page=2
printf '%s %s\\n' "$connection" "$after" >> "$MOCK_CALLS"
# <connection>-fail-<n>: the nth read of that connection in this run fails, as a GraphQL error would.
n=$(grep -c "^$connection " "$MOCK_CALLS")
if [ -f "$MOCK_DIR/$connection-fail-$n" ]; then echo 'gh: GraphQL request failed (HTTP 502)' >&2; exit 1; fi
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
if [ -n "\${MOCK_DATE_VALUES:-}" ] && [ -s "$MOCK_DATE_VALUES" ]; then
  value=$(head -n 1 "$MOCK_DATE_VALUES")
  sed -i '1d' "$MOCK_DATE_VALUES"
  printf '%s\\n' "$value"
elif [[ "$*" == *'-d '* ]]; then
  printf 'date %s\\n' "$*" >> "$MOCK_CALLS"
  if [ "\${MOCK_CLAIM_CLOCK_ROLLOVER:-0}" = 1 ] && [[ "$*" != *'2026-09-13T01:00:00Z'* ]]; then
    printf '%s\\n' '2026-09-13T01:45:01Z'
  else
    printf '%s\\n' "\${MOCK_CLAIM_EXPIRES:-2026-09-13T01:45:00Z}"
  fi
elif [[ "$*" == *'+%Y-%m-%dT%H:%M:%SZ'* ]]; then
  printf '%s\\n' "\${MOCK_CLAIM_NOW:-2026-09-13T01:00:00Z}"
else
  /bin/date "$@"
fi
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

function reviewClaim(
  id: string,
  owner: string,
  head = HEAD,
  started = '2026-09-13T01:00:00Z',
  expires = '2026-09-13T01:45:00Z',
  repo = 'example/repository',
  pr = 1,
): Page {
  return comment(
    started,
    `<!-- pr-review-loop:claim id=${id} repo=${repo} pr=${pr} head=${head} owner=${owner} started=${started} expires=${expires} -->`,
    'davekim917',
  );
}

function completedClaim(id: string, owner: string, head = HEAD, at = '2026-09-13T01:05:00Z'): Page {
  return comment(
    at,
    `### Substitute review receipt\n\n<!-- pr-review-loop:substitute-receipt head=${head} outcome=approve -->\n<!-- pr-review-loop:claim-complete id=${id} owner=${owner} head=${head} -->`,
    'davekim917',
  );
}

function bareClaimCompletion(id: string, owner: string, head = HEAD, at = '2026-09-13T01:05:00Z'): Page {
  return comment(at, `<!-- pr-review-loop:claim-complete id=${id} owner=${owner} head=${head} -->`, 'davekim917');
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

// `creator` defaults to the account runHelper allows to post host CI
// (CODEX_REVIEW_HOST_CI_POSTERS=fleet-bot); only a CI (host) status reads it.
function commitStatus(context: string, state: string, createdAt = '2026-09-05T00:02:00Z', creator = 'fleet-bot'): Page {
  return { id: Date.parse(createdAt) / 1000, context, state, created_at: createdAt, creator: { login: creator } };
}

// `reviewer` defaults to an allowed model so existing approve-path fixtures
// keep passing the model-allowlist check merge-check now applies; tests of the
// allowlist itself pass a disallowed (or omitted) reviewer. The parenthetical
// after the model id is free text — only the FIRST word is checked — and the
// default here deliberately carries the historical `(worker-frontier)`
// spelling, so every merge-check case below doubles as proof that receipts
// written before the label change still unlock their head.
// `databaseId` is the comment's posting order, which receipts are ordered by;
// by default it follows createdAt, to the second.
function receiptComment(
  head: string,
  outcome: string,
  createdAt: string,
  authorAssociation = 'OWNER',
  reviewer = 'claude-fable-5-1 (worker-frontier)',
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

// A review desk's receipt in the shape that can clear: the v1 marker first, one
// fenced JSON object, and the desk's prose after it. `json` replaces the
// object's text, for a block that does not parse.
function independentReceipt(
  head: string,
  verdict: string,
  blockingFindings: number,
  createdAt: string,
  authorAssociation = 'MEMBER',
  databaseId: string | null = String(Date.parse(createdAt) / 1000),
  json = JSON.stringify(
    { head, fresh_context: true, scope: 'full-final-head', verdict, blocking_findings: blockingFindings },
    null,
    2,
  ),
): Page {
  return {
    author: { login: 'release-desk' },
    authorAssociation,
    createdAt,
    fullDatabaseId: databaseId,
    body: `<!-- independent-review-receipt:v1 -->\n\`\`\`json\n${json}\n\`\`\`\n\nIndependent review at head \`${head.slice(0, 8)}\`: ${verdict}.\n`,
  };
}

// The PR head's status rollup as GraphQL returns it: every check run and commit
// status, each with GitHub's own `isRequired` for this PR. `null` = a head
// nothing has reported on, which has no rollup at all.
function rollupPage(nodes: Page[] | null, head = HEAD, hasNextPage = false, endCursor: string | null = null): Page {
  return {
    data: {
      repository: {
        pullRequest: {
          headRefOid: head,
          statusCheckRollup: nodes === null ? null : { contexts: { pageInfo: { hasNextPage, endCursor }, nodes } },
        },
      },
    },
  };
}

function rollupRun(name: string, status: string, conclusion: string | null, isRequired = true): Page {
  return { __typename: 'CheckRun', name, status, conclusion, isRequired };
}

function rollupStatus(context: string, state: string, isRequired = true, creator = 'fleet-bot'): Page {
  return { __typename: 'StatusContext', context, state, isRequired, creator: { login: creator } };
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
    rollup?: Page[] | null;
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
  writePage(root, 'rollup', 1, rollupPage(opts.rollup === undefined ? [] : opts.rollup));
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
      CODEX_REVIEW_HOST_CI_POSTERS: 'fleet-bot',
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

  // #692 P3-3: the accepted --timeout form is capped at 6 digits so the
  // deadline arithmetic (start + timeout) cannot overflow; the maximum value
  // that cap allows must still be accepted, not refused as out of range.
  it('accepts the maximum allowed --timeout (999999) and still reports green', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    writeRuns(root, 'runs.json', [workflowRun('CI', 'completed', 'success')]);

    const result = ciWait(root, ['--head', HEAD, '--timeout', '999999'], [0, 0]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`ci=green head=${HEAD}`);
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
    // #692 P3-2: a bare --head (no value follows) must exit the usage code 2,
    // not bash's ${2:?} exit 1 — a validation failure is never read as a
    // GitHub-read failure by a caller branching on exit code.
    ['a bare --head', ['--head']],
    ['a short head', ['--head', HEAD.slice(0, 12)]],
    ['a zero timeout', ['--head', HEAD, '--timeout', '0']],
    ['a non-numeric timeout', ['--head', HEAD, '--timeout', 'x']],
    // #692 P3-3: a 20-digit timeout passes the old unbounded regex and
    // overflows the deadline arithmetic; it must be refused as out of range.
    ['a 20-digit timeout', ['--head', HEAD, '--timeout', '12345678901234567890']],
    ['an unknown argument', ['--head', HEAD, '--bogus']],
  ])('refuses %s, reading nothing (mutation: validation after the first read)', (_case, args) => {
    const root = tempRoot();

    const result = ciWait(root, args, [0]);
    expect(result.status).toBe(2);
    expect(result.calls).toBe('');
  });
});

describe('codex-review ci-wait: a quick-tier head requests the full suite', () => {
  // A tiered repo's ci.yml runs a pull request's first attempt on a commit as
  // the quick tier: plan + spelling, then a `CI Quick` gate whose verdict step
  // passes and whose `Full CI has not run on this commit` step fails on
  // purpose. A re-run of that run is the full suite, which reports CI Gate.
  const QUICK = Date.parse('2026-09-05T00:01:00Z') / 1000;
  const VERDICT_STEP = 'Every selected job passed and every other one was skipped';
  const QUICK_STEP = 'Full CI has not run on this commit';
  function job(name: string, conclusion: string, steps?: Page[]): Page {
    const ran = conclusion !== 'skipped';
    return {
      id: 7000 + name.length,
      name,
      status: 'completed',
      conclusion,
      runner_id: ran ? 1000006727 : 0,
      runner_name: ran ? 'GitHub Actions 1000006727' : '',
      steps: steps ?? (ran ? [{ name: 'step', status: 'completed', conclusion }] : []),
    };
  }
  // The gate as it really ends: its verdict step failing skips the quick step.
  function gate(verdict: 'success' | 'failure'): Page {
    return job('CI Quick', 'failure', [
      { name: 'Set up job', status: 'completed', conclusion: 'success' },
      { name: VERDICT_STEP, status: 'completed', conclusion: verdict },
      { name: QUICK_STEP, status: 'completed', conclusion: verdict === 'success' ? 'failure' : 'skipped' },
    ]);
  }
  const quickJobs = (spelling = 'success') => [
    job('plan', 'success'),
    job('spelling / en-US spelling', spelling),
    job('backend-ci', 'skipped'),
    gate(spelling === 'success' ? 'success' : 'failure'),
  ];
  const neverStarted = (attempt?: number) => ({
    id: 1,
    status: 'completed',
    conclusion: 'failure',
    runner_id: 0,
    runner_name: '',
    steps: [],
    ...(attempt === undefined ? {} : { run_attempt: attempt }),
  });
  function quickRun(root: string, jobs = quickJobs(), attempt = 1, name = 'CI', startedAt = '2026-09-05T00:01:00Z'): Page {
    const run = { ...workflowRun(name, 'completed', 'failure', startedAt), run_attempt: attempt };
    writeJson(root, `jobs--${run.id as number}--attempt-${attempt}.json`, { total_count: jobs.length, jobs });
    return run;
  }
  function runs(root: string, name: string, list: Page[]): void {
    writeJson(root, name, { total_count: list.length + 1, workflow_runs: [labelRun('completed', 'success'), ...list] });
  }
  function runState(root: string, id: number, status: string, attempt: number, nth?: number): void {
    fs.writeFileSync(path.join(root, nth === undefined ? `run--${id}.tsv` : `run--${id}-${nth}.tsv`), `${status}\t${attempt}\n`);
  }
  const reruns = (calls: string) => calls.split('\n').filter((l) => l.startsWith('rerun ')).length;

  it('re-runs the quick run once, then waits for the full suite and reads it green (mutation: quick read as red, or as green)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    runs(root, 'runs-1.json', [quickRun(root)]);
    runs(root, 'runs-2.json', [{ ...workflowRun('CI', 'in_progress', null), run_attempt: 2 }]);
    runs(root, 'runs-3.json', [{ ...workflowRun('CI', 'completed', 'success'), run_attempt: 2 }]);
    runState(root, QUICK, 'completed', 1, 1);
    runState(root, QUICK, 'queued', 2);

    const result = ciWait(root, ['--head', HEAD], [0, 0, 0, 0, 30, 30, 60]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`requested the full suite on ${HEAD} by re-running run ${QUICK}`);
    expect(result.stdout).toContain(`ci=green head=${HEAD}`);
    expect(reruns(result.calls)).toBe(1);
  });

  it('gives the full suite the whole --timeout from after the request, not from the tick (mutation: request_at taken before the reads)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    runs(root, 'runs-1.json', [quickRun(root)]);
    runs(root, 'runs-2.json', [{ ...workflowRun('CI', 'in_progress', null), run_attempt: 2 }]);
    runs(root, 'runs-3.json', [{ ...workflowRun('CI', 'completed', 'success'), run_attempt: 2 }]);
    runState(root, QUICK, 'completed', 1, 1);
    runState(root, QUICK, 'queued', 2);

    // The tick starts at 50; the reads and the POST take until 95.
    const result = ciWait(root, ['--head', HEAD, '--timeout', '60'], [0, 50, 95, 95, 125, 125, 155]);
    expect(result.status).toBe(0);
    expect(result.sleep).toBe('30\n30\n');
  });

  it('does not re-run a quick run whose own checks failed: that is red (mutation: any CI Quick run re-run)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    runs(root, 'runs.json', [quickRun(root, quickJobs('failure'))]);

    const result = ciWait(root, ['--head', HEAD], [0, 0]);
    expect(result.status).toBe(29);
    expect(result.stderr).toContain(`ci=red head=${HEAD}: ci_red: CI=failure (required)`);
    expect(reruns(result.calls)).toBe(0);
  });

  it('a gate whose own verdict failed is red even when every job looks right (mutation: quick_only by names alone)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    runs(root, 'runs.json', [quickRun(root, [job('plan', 'success'), job('spelling / en-US spelling', 'success'), gate('failure')])]);

    const result = ciWait(root, ['--head', HEAD], [0, 0]);
    expect(result.status).toBe(29);
    expect(reruns(result.calls)).toBe(0);
  });

  it('fails closed to red when the jobs read fails (mutation: an unreadable run assumed quick)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    runs(root, 'runs.json', [workflowRun('CI', 'completed', 'failure')]);

    const result = ciWait(root, ['--head', HEAD], [0, 0]);
    expect(result.status).toBe(29);
    expect(reruns(result.calls)).toBe(0);
  });

  it('exits 1 and says to re-run by hand when the re-run is refused (mutation: a failed POST read as requested)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    runs(root, 'runs.json', [quickRun(root)]);
    runState(root, QUICK, 'completed', 1);

    const result = ciWait(root, ['--head', HEAD], [0, 0, 0], { MOCK_RERUN_STATUS: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`could not re-run run ${QUICK} to request the full suite`);
  });

  it('exits 30 when the requested re-run never starts, and asks only once (mutation: re-requests every tick)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    runs(root, 'runs.json', [quickRun(root)]);
    runState(root, QUICK, 'completed', 1);

    const result = ciWait(root, ['--head', HEAD], [0, 0, 0, 0, 30, 30, 60], { CODEX_REVIEW_CI_REGISTER_SECONDS: '60' });
    expect(result.status).toBe(30);
    expect(result.stderr).toContain(`ci=none head=${HEAD}: the full-suite re-run of ${QUICK}:1 requested`);
    expect(reruns(result.calls)).toBe(1);
  });

  it('another workflow still pending does not hide a re-run that never started (mutation: registration checked only while quick)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    runs(root, 'runs-1.json', [quickRun(root)]);
    runs(root, 'runs.json', [quickRun(root), workflowRun('Lint', 'in_progress', null, '2026-09-05T00:02:00Z')]);
    runState(root, QUICK, 'completed', 1);

    const result = ciWait(root, ['--head', HEAD, '--timeout', '120'], [0, 0, 0, 0, 30, 30, 60], {
      CODEX_REVIEW_CI_REGISTER_SECONDS: '60',
    });
    expect(result.status).toBe(30);
    expect(reruns(result.calls)).toBe(1);
  });

  it('asks again for a new quick attempt of a run, but at most twice per run (mutation: no cap)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    runs(root, 'runs-1.json', [quickRun(root, quickJobs(), 1)]);
    runs(root, 'runs-2.json', [quickRun(root, quickJobs(), 2)]);
    runs(root, 'runs-3.json', [quickRun(root, quickJobs(), 3)]);
    runState(root, QUICK, 'completed', 1, 1);
    runState(root, QUICK, 'in_progress', 2, 2);
    runState(root, QUICK, 'completed', 2, 3);
    runState(root, QUICK, 'in_progress', 3, 4);

    const result = ciWait(root, ['--head', HEAD], [0, 0, 0, 0, 30, 30, 30, 60]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`re-ran run ${QUICK} twice and it came back quick again`);
    expect(reruns(result.calls)).toBe(2);
  });

  it('requests every required quick workflow, however many there are (mutation: one cap across all runs)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    const starts = ['2026-09-05T00:01:00Z', '2026-09-05T00:01:10Z', '2026-09-05T00:01:20Z'];
    const names = ['CI', 'CI2', 'CI3'];
    const quick = names.map((n, i) => quickRun(root, quickJobs(), 1, n, starts[i]));
    for (const run of quick) {
      runState(root, run.id as number, 'completed', 1, 1);
      runState(root, run.id as number, 'queued', 2);
    }
    runs(root, 'runs-1.json', quick);
    runs(root, 'runs-2.json', names.map((n, i) => ({ ...workflowRun(n, 'completed', 'success', starts[i]), run_attempt: 2 })));

    const result = ciWait(root, ['--head', HEAD], [0, 0, 0, 0, 0, 0, 30], { CODEX_REVIEW_REQUIRED_WORKFLOWS: 'CI,CI2,CI3' });
    expect(result.status).toBe(0);
    expect(reruns(result.calls)).toBe(3);
  });

  it('a newer run of the workflow from another event does not stand for the PR\'s full suite (mutation: newest run of any event wins)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    const push = { ...workflowRun('CI', 'completed', 'success', '2026-09-05T00:05:00Z'), event: 'push' };
    runs(root, 'runs-1.json', [quickRun(root), push]);
    runs(root, 'runs-2.json', [{ ...workflowRun('CI', 'completed', 'success', '2026-09-05T00:09:00Z'), run_attempt: 2 }, push]);
    runState(root, QUICK, 'completed', 1, 1);
    runState(root, QUICK, 'queued', 2);

    const result = ciWait(root, ['--head', HEAD], [0, 0, 0, 0, 30]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`requested the full suite on ${HEAD} by re-running run ${QUICK}`);
    expect(reruns(result.calls)).toBe(1);
  });

  it('an unreadable quick run is still judged over a newer push run: red, never green (mutation: other events win when evidence is missing)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    const push = { ...workflowRun('CI', 'completed', 'success', '2026-09-05T00:05:00Z'), event: 'push' };
    // No jobs fixture for the PR run: its quick evidence cannot be read.
    runs(root, 'runs.json', [workflowRun('CI', 'completed', 'failure'), push]);

    const result = ciWait(root, ['--head', HEAD], [0, 0]);
    expect(result.status).toBe(29);
    expect(reruns(result.calls)).toBe(0);
  });

  it('a pending pull_request run is not masked by a newer push success (mutation: newest run of any event wins)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    const push = { ...workflowRun('CI', 'completed', 'success', '2026-09-05T00:05:00Z'), event: 'push' };
    runs(root, 'runs-1.json', [workflowRun('CI', 'in_progress', null), push]);
    runs(root, 'runs-2.json', [workflowRun('CI', 'completed', 'success'), push]);

    const result = ciWait(root, ['--head', HEAD], [0, 0, 0, 30]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ci_pending: CI=in_progress');
  });

  it('a newer failed or pending run from another event still blocks a passing pull_request run (mutation: pull_request runs judged alone)', () => {
    const failed = tempRoot();
    writeJson(failed, 'pr.json', ciPr());
    runs(failed, 'runs.json', [
      workflowRun('CI', 'completed', 'success'),
      { ...workflowRun('CI', 'completed', 'failure', '2026-09-05T00:05:00Z'), event: 'push' },
    ]);
    expect(ciWait(failed, ['--head', HEAD], [0, 0]).status).toBe(29);

    const pending = tempRoot();
    writeJson(pending, 'pr.json', ciPr());
    runs(pending, 'runs-1.json', [
      workflowRun('CI', 'completed', 'success'),
      { ...workflowRun('CI', 'in_progress', null, '2026-09-05T00:05:00Z'), event: 'push' },
    ]);
    runs(pending, 'runs-2.json', [
      workflowRun('CI', 'completed', 'success'),
      { ...workflowRun('CI', 'completed', 'success', '2026-09-05T00:05:00Z'), event: 'push' },
    ]);
    const result = ciWait(pending, ['--head', HEAD], [0, 0, 0, 30]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ci_pending: CI=in_progress');
  });

  it('a workflow with no pull_request run on the head is judged by its newest run of any event, as before', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    runs(root, 'runs.json', [{ ...workflowRun('CI', 'completed', 'success'), event: 'push' }]);

    const result = ciWait(root, ['--head', HEAD], [0, 0]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`ci=green head=${HEAD}`);
  });

  it('merge-check refuses a quick-tier head: the full suite never ran on it (mutation: ci_quick read as green)', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: [], ci: [quickRun(root)], statuses: [] });
    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain(`ci_quick: runs=${QUICK}:1: CI ran only its quick checks on this head`);
  });

  it('does not re-run a run someone already re-ran; the next tick judges the new attempt (mutation: stale verdict re-run)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    runs(root, 'runs-1.json', [quickRun(root)]);
    runs(root, 'runs-2.json', [{ ...workflowRun('CI', 'completed', 'success'), run_attempt: 2 }]);
    runState(root, QUICK, 'in_progress', 2);

    const result = ciWait(root, ['--head', HEAD], [0, 0, 0, 30]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`run ${QUICK} has already moved past attempt 1; not re-running it`);
    expect(reruns(result.calls)).toBe(0);
  });

  it('does not re-run when it cannot read the run first; it asks again next tick (mutation: a failed read taken as unchanged)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    runs(root, 'runs-1.json', [quickRun(root)]);
    runs(root, 'runs-2.json', [{ ...workflowRun('CI', 'completed', 'success'), run_attempt: 2 }]);
    // No run fixture: every read of the run fails.

    const result = ciWait(root, ['--head', HEAD], [0, 0, 0, 30]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`could not read run ${QUICK}'s current attempt; not re-running it this tick`);
    expect(reruns(result.calls)).toBe(0);
  });

  it('a refused re-run is not an error when the run started another attempt meanwhile (mutation: refusal always exits 1)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    runs(root, 'runs-1.json', [quickRun(root)]);
    runs(root, 'runs-2.json', [{ ...workflowRun('CI', 'completed', 'success'), run_attempt: 2 }]);
    runState(root, QUICK, 'completed', 1, 1);
    runState(root, QUICK, 'in_progress', 2);

    const result = ciWait(root, ['--head', HEAD], [0, 0, 0, 30], { MOCK_RERUN_STATUS: '1' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`run ${QUICK} started another attempt while this asked`);
  });

  it('a repo without a CI Quick job reads an ordinary failure red, exactly as before (mutation: tier handling leaks to untiered repos)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    runs(root, 'runs.json', [quickRun(root, [job('build', 'failure'), job('lint', 'success')], 2)]);

    const result = ciWait(root, ['--head', HEAD], [0, 0]);
    expect(result.status).toBe(29);
    expect(result.stderr).toContain(`ci=red head=${HEAD}: ci_red: CI=failure (required)`);
    expect(reruns(result.calls)).toBe(0);
  });

  it('an earlier quick attempt does not disqualify a full re-run GitHub never started from CI (host) (mutation: quick counted as a genuine red)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    const run = { ...workflowRun('CI', 'completed', 'failure'), run_attempt: 2 };
    const jobs = quickJobs();
    writeJson(root, `jobs--${QUICK}--attempt-1.json`, { total_count: jobs.length, jobs });
    writeJson(root, `jobs--${QUICK}--attempt-2.json`, { total_count: 1, jobs: [neverStarted(2)] });
    runs(root, 'runs.json', [run]);
    writeJson(root, `statuses--${HEAD}.json`, [commitStatus('CI (host)', 'success')]);

    const result = ciWait(root, ['--head', HEAD], [0, 0]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`ci=host head=${HEAD}: ci_host:`);
    expect(reruns(result.calls)).toBe(0);
  });

  it('an earlier attempt whose gate verdict really failed still disqualifies CI (host) (mutation: quick_only by names alone)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    const run = { ...workflowRun('CI', 'completed', 'failure'), run_attempt: 2 };
    const jobs = [job('plan', 'success'), job('spelling / en-US spelling', 'success'), gate('failure')];
    writeJson(root, `jobs--${QUICK}--attempt-1.json`, { total_count: jobs.length, jobs });
    writeJson(root, `jobs--${QUICK}--attempt-2.json`, { total_count: 1, jobs: [neverStarted(2)] });
    runs(root, 'runs.json', [run]);
    writeJson(root, `statuses--${HEAD}.json`, [commitStatus('CI (host)', 'success')]);

    const result = ciWait(root, ['--head', HEAD], [0, 0]);
    expect(result.status).toBe(29);
  });

  it('a latest-attempt page that is not the attempt the listing reported never excuses anything (mutation: /jobs trusted as that attempt)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    // Listing: attempt 2, a genuine failure. The plain /jobs route has moved
    // on to a never-started attempt 3 (with no run_attempt field to say so).
    const run = { ...workflowRun('CI', 'completed', 'failure'), run_attempt: 2 };
    const jobs = quickJobs();
    writeJson(root, `jobs--${QUICK}--attempt-1.json`, { total_count: jobs.length, jobs });
    writeJson(root, `jobs--${QUICK}--attempt-2.json`, { total_count: 1, jobs: [job('build', 'failure')] });
    writeJson(root, `jobs--${QUICK}.json`, { total_count: 1, jobs: [neverStarted()] });
    runs(root, 'runs.json', [run]);
    writeJson(root, `statuses--${HEAD}.json`, [commitStatus('CI (host)', 'success')]);

    const result = ciWait(root, ['--head', HEAD], [0, 0]);
    expect(result.status).toBe(29);
    expect(result.stdout).not.toContain('ci=host');
  });

  it('a never-started page from a later attempt does not excuse a failed workflow run (mutation: never_started_runs trusts /jobs as the listed attempt)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    // Lint (not required) failed on attempt 2 per the listing; /jobs has moved on to attempt 3.
    const lint = { ...workflowRun('Lint', 'completed', 'failure', '2026-09-05T00:03:00Z'), run_attempt: 2 };
    const lintId = lint.id as number;
    writeJson(root, `jobs--${lintId}--attempt-1.json`, { total_count: 1, jobs: [neverStarted(1)] });
    writeJson(root, `jobs--${lintId}--attempt-2.json`, { total_count: 1, jobs: [job('lint', 'failure')] });
    writeJson(root, `jobs--${lintId}.json`, { total_count: 1, jobs: [neverStarted()] });
    runs(root, 'runs.json', [workflowRun('CI', 'completed', 'success'), lint]);

    const result = ciWait(root, ['--head', HEAD], [0, 0]);
    expect(result.status).toBe(29);
    expect(result.stderr).toContain('Lint=failure');
  });

  it('an earlier quick RUN (e.g. before a reopen) does not disqualify a newer run GitHub never started (mutation: only same-run attempts skipped)', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    const quick = quickRun(root);
    const later = workflowRun('CI', 'completed', 'failure', '2026-09-05T00:09:00Z');
    writeJson(root, `jobs--${later.id as number}.json`, { total_count: 1, jobs: [neverStarted()] });
    runs(root, 'runs.json', [quick, later]);
    writeJson(root, `statuses--${HEAD}.json`, [commitStatus('CI (host)', 'success')]);

    const result = ciWait(root, ['--head', HEAD], [0, 0]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`ci=host head=${HEAD}: ci_host:`);
    expect(reruns(result.calls)).toBe(0);
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
    // The precheck reads the comments for a desk receipt; the Codex verdict stays Step 6's.
    expect(merge.calls).not.toMatch(/^(reviews|reactions|reviewThreads) /m);
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

  // #651: the dashboard's own authorization seams (globalAdmin/canReview, the
  // observatory.signal.mutate guard and demand(), requireAuth's CSRF/cookie gate,
  // and thread-message.ts's canSteer gate) joined risk:high. Read this repo's own
  // .github/labeler.yml, rather than the synthetic RISK_CONFIG every other test
  // here uses, so a PR touching each of them really does classify as risk:high
  // through codex-review.sh's real glob replay, not just a fixture that says so.
  const REAL_LABELER_YML = fs.readFileSync(path.resolve('.github/labeler.yml'), 'utf8');

  it.each([
    'src/dashboard/observatory-v2/sources.ts',
    'src/dashboard/observatory-v2/api.ts',
    'src/dashboard/router.ts',
    'src/dashboard/thread-message.ts',
  ])("scopes a PR touching %s to review under this repo's real labeler.yml", (file) => {
    const root = tempRoot();
    scopeFixture(root, { labels: [], baseConfig: REAL_LABELER_YML, files: [changedFile(file)] });

    const scope = runHelper(root, ['scope']);
    expect(scope.status).toBe(0);
    expect(JSON.parse(scope.stdout)).toMatchObject({
      mode: 'risk-scoped',
      verdict: 'review',
      reason: `changes risk:high path ${file}`,
    });
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

  it('shows a live local claim in scope and merge-check without changing either verdict', () => {
    const root = tempRoot();
    const claim = reviewClaim('review-710', 'adversarial-session');
    scopeFixture(root, { labels: [], comments: [claim] });

    const scope = runHelper(root, ['scope']);
    expect(scope.status).toBe(0);
    expect(JSON.parse(scope.stdout)).toMatchObject({
      verdict: 'skip',
      reviewClaims: [{ id: 'review-710', owner: 'adversarial-session', head: HEAD, kind: 'explicit' }],
    });

    const merge = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(merge.status).toBe(0);
    expect(merge.stdout).toContain(`merge=allowed head=${HEAD}`);
    expect(merge.stderr).toContain('review_claim=advisory');
    expect(merge.stderr).toContain('id=review-710 owner=adversarial-session');
  });

  it('surfaces an existing connector request marker as its one in-flight claim', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: [], comments: [marker(HEAD, 1, '2026-09-13T01:00:00Z')] });

    const scope = runHelper(root, ['scope']);
    expect(scope.status).toBe(0);
    expect(JSON.parse(scope.stdout)).toMatchObject({
      reviewClaims: [
        {
          id: 'connector-1-20260913010000',
          owner: 'connector',
          head: HEAD,
          started: '2026-09-13T01:00:00Z',
          expires: '2026-09-13T01:45:00Z',
          kind: 'connector',
        },
      ],
    });
  });

  it('retires an existing connector request claim after its connector review of that exact head submits', () => {
    const root = tempRoot();
    scopeFixture(root, {
      labels: [],
      comments: [marker(HEAD, 1, '2026-09-13T01:00:00Z')],
      reviews: [review('2026-09-13T01:05:00Z', HEAD)],
    });

    const scope = runHelper(root, ['scope']);
    expect(scope.status).toBe(0);
    expect(JSON.parse(scope.stdout)).not.toHaveProperty('reviewClaims');
  });

  it('retires an existing connector request claim from its matching substitute completion', () => {
    const root = tempRoot();
    scopeFixture(root, {
      labels: [],
      comments: [marker(HEAD, 1, '2026-09-13T01:00:00Z'), completedClaim('connector-1-20260913010000', 'connector')],
    });

    const scope = runHelper(root, ['scope']);
    expect(scope.status).toBe(0);
    expect(JSON.parse(scope.stdout)).not.toHaveProperty('reviewClaims');
  });

  it('warns about a live claim before request spends the PR-wide round budget, but still requests', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: ['risk:high'], comments: [reviewClaim('review-710', 'adversarial-session')] });

    const result = runHelper(root, ['request']);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('warning: review_claim=advisory');
    expect(result.stderr).toContain('this request spends round 1/3');
    expect(result.posted).toBe(`@codex review\n\n<!-- pr-review-loop:request head=${HEAD} round=1 -->`);
    expect(result.calls.indexOf('comments null')).toBeLessThan(result.calls.indexOf('node '));
  });

  it('keeps the PR-wide request cap unchanged when a claim is live', () => {
    const root = tempRoot();
    const heads = ['1', '2', '3'].map((c) => c.repeat(40));
    scopeFixture(root, {
      labels: ['risk:high'],
      comments: [...heads.map((head, i) => marker(head, i + 1)), reviewClaim('review-710', 'adversarial-session')],
    });

    const result = runHelper(root, ['request']);
    expect(result.status).toBe(23);
    expect(result.stderr).toContain('CAP: 3 of 3 review rounds already requested');
    expect(result.stderr).not.toContain('review_claim=advisory');
    expect(result.posted).toBeNull();
    expect(result.calls).not.toMatch(/^node /m);
  });

  it('creates one bounded explicit claim with its required session owner label', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: [] });

    const result = runHelper(root, ['claim', '--head', HEAD, '--owner', 'adversarial-session']);
    expect(result.status).toBe(0);
    expect(result.posted).toBe(
      `<!-- pr-review-loop:claim id=adversarial-session-20260913010000 repo=example/repository pr=1 head=${HEAD} owner=adversarial-session started=2026-09-13T01:00:00Z expires=2026-09-13T01:45:00Z -->`,
    );
    expect(result.stdout).toContain('claim: id=adversarial-session-20260913010000 owner=adversarial-session');

    const tooLong = runHelper(root, [
      'claim',
      '--head',
      HEAD,
      '--owner',
      'adversarial-session',
      '--ttl-minutes',
      '121',
    ]);
    expect(tooLong.status).toBe(2);
    expect(tooLong.stderr).toContain('whole number from 1 to 120');
    expect(tooLong.posted).toBeNull();
  });

  it('dedupes only a live claim from the same owner, allowing another review owner to announce independently', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: [], comments: [reviewClaim('other-review', 'other-session')] });

    const differentOwner = runHelper(root, ['claim', '--head', HEAD, '--owner', 'adversarial-session']);
    expect(differentOwner.status).toBe(0);
    expect(differentOwner.posted).toContain('id=adversarial-session-20260913010000');

    scopeFixture(root, { labels: [], comments: [reviewClaim('same-review', 'adversarial-session')] });
    const sameOwner = runHelper(root, ['claim', '--head', HEAD, '--owner', 'adversarial-session']);
    expect(sameOwner.status).toBe(0);
    expect(sameOwner.posted).toBeNull();
    expect(sameOwner.stdout).toContain('this owner already has a live marker');
  });

  it.each([
    [
      'a foreign repo',
      reviewClaim('foreign-repo', 'other', HEAD, '2026-09-13T01:00:00Z', '2026-09-13T01:45:00Z', 'other/repository'),
    ],
    [
      'a different PR',
      reviewClaim('foreign-pr', 'other', HEAD, '2026-09-13T01:00:00Z', '2026-09-13T01:45:00Z', 'example/repository', 2),
    ],
    ['an expired claim', reviewClaim('expired', 'other', HEAD, '2026-09-13T00:00:00Z', '2026-09-13T00:45:00Z')],
    ['a moved-head claim', reviewClaim('old-head', 'other', OLD_HEAD)],
    ['a claim whose ISO date cannot be parsed', reviewClaim('bad-date', 'other', HEAD, '2026-02-30T01:00:00Z')],
    ['a claim that starts in the future', reviewClaim('future-start', 'other', HEAD, '2026-09-13T01:01:00Z')],
    [
      'a claim lasting more than the maximum 120 minutes',
      reviewClaim('long-ttl', 'other', HEAD, '2026-09-13T01:00:00Z', '2026-09-13T03:01:00Z'),
    ],
  ])('does not surface %s or change no-claim behavior', (_case, claim) => {
    const root = tempRoot();
    scopeFixture(root, { labels: [], comments: [claim] });

    const scope = runHelper(root, ['scope']);
    expect(scope.status).toBe(0);
    expect(JSON.parse(scope.stdout)).toEqual({
      repo: 'example/repository',
      pr: 1,
      head: HEAD,
      mode: 'risk-scoped',
      verdict: 'skip',
      labels: [],
      reason:
        'no changed file matches a risk:high glob in .github/labeler.yml, and neither risk:high nor review:requested is on the PR',
    });

    const merge = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(merge.status).toBe(0);
    expect(merge.stderr).not.toContain('review_claim=advisory');
  });

  it('keeps scope and merge-check byte-for-byte advisory-free when no claim exists', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: [] });

    const scope = runHelper(root, ['scope']);
    expect(scope.status).toBe(0);
    expect(scope.stdout).not.toContain('reviewClaims');

    const merge = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(merge.status).toBe(0);
    expect(merge.stderr).not.toContain('review_claim=advisory');
  });

  it('retires only the matching claim id and owner, never an unrelated same-head receipt', () => {
    const root = tempRoot();
    const live = reviewClaim('review-710', 'adversarial-session');
    scopeFixture(root, { labels: [], comments: [live, receiptComment(HEAD, 'approve', '2026-09-13T01:05:00Z')] });

    const stillLive = runHelper(root, ['scope']);
    expect(JSON.parse(stillLive.stdout)).toMatchObject({
      reviewClaims: [{ id: 'review-710', owner: 'adversarial-session' }],
    });

    scopeFixture(root, {
      labels: [],
      comments: [
        live,
        receiptComment(HEAD, 'approve', '2026-09-13T01:05:00Z'),
        completedClaim('review-710', 'adversarial-session'),
      ],
    });
    const retired = runHelper(root, ['scope']);
    expect(JSON.parse(retired.stdout)).not.toHaveProperty('reviewClaims');
  });

  it('does not retire an explicit claim from bare completion text outside a substitute receipt', () => {
    const root = tempRoot();
    const live = reviewClaim('review-710', 'adversarial-session');
    scopeFixture(root, { labels: [], comments: [live, bareClaimCompletion('review-710', 'adversarial-session')] });

    const scope = runHelper(root, ['scope']);
    expect(JSON.parse(scope.stdout)).toMatchObject({
      reviewClaims: [{ id: 'review-710', owner: 'adversarial-session' }],
    });
  });

  describe('review claim producer and visibility correction contract', () => {
    it.each([1, 45, 46, 60, 120])(
      'round-trips a successfully produced %i-minute explicit claim through the shared reader',
      (ttl) => {
        const root = tempRoot();
        const started = '2026-09-13T01:00:00Z';
        const expires = new Date(Date.parse(started) + ttl * 60_000).toISOString().replace('.000Z', 'Z');
        scopeFixture(root);

        const created = runHelper(
          root,
          ['claim', '--head', HEAD, '--owner', 'session-a', '--ttl-minutes', String(ttl)],
          { MOCK_CLAIM_NOW: started, MOCK_CLAIM_EXPIRES: expires },
        );
        expect(created.status).toBe(0);
        expect(created.posted).toContain(`started=${started} expires=${expires}`);

        scopeFixture(root, { comments: [comment(started, created.posted!, 'shared-account')] });
        const observed = runHelper(root, ['scope'], { MOCK_CLAIM_NOW: started });
        expect(observed.status).toBe(0);
        expect(JSON.parse(observed.stdout).reviewClaims).toMatchObject([
          { owner: 'session-a', started, expires, kind: 'explicit' },
        ]);
      },
    );

    it('derives expiry from its one captured start when the wall clock crosses a second', () => {
      const root = tempRoot();
      scopeFixture(root);

      const created = runHelper(root, ['claim', '--head', HEAD, '--owner', 'session-a'], {
        MOCK_CLAIM_NOW: '2026-09-13T01:00:00Z',
        MOCK_CLAIM_CLOCK_ROLLOVER: '1',
      });
      expect(created.status).toBe(0);
      expect(created.posted).toContain('started=2026-09-13T01:00:00Z expires=2026-09-13T01:45:00Z');
      expect(created.calls).toContain('date -u -d 2026-09-13T01:00:00Z + 45 minutes +%Y-%m-%dT%H:%M:%SZ');

      scopeFixture(root, { comments: [comment('2026-09-13T01:00:01Z', created.posted!, 'shared-account')] });
      const observed = runHelper(root, ['scope'], { MOCK_CLAIM_NOW: '2026-09-13T01:00:01Z' });
      expect(JSON.parse(observed.stdout).reviewClaims).toMatchObject([{ owner: 'session-a' }]);
    });

    it.each(['scope', 'request', 'merge-check'])(
      'surfaces every live owner through %s despite their shared GitHub actor',
      (command) => {
        const root = tempRoot();
        scopeFixture(root, {
          labels: command === 'request' ? ['risk:high'] : [],
          comments: [reviewClaim('a', 'session-a'), reviewClaim('b', 'session-b')],
        });

        const observed = runHelper(root, [command, ...(command === 'merge-check' ? ['--head', HEAD] : [])]);
        expect(observed.status).toBe(0);
        if (command === 'scope') {
          expect(JSON.parse(observed.stdout).reviewClaims).toMatchObject([
            { id: 'a', owner: 'session-a' },
            { id: 'b', owner: 'session-b' },
          ]);
        } else {
          expect(observed.stderr).toContain('id=a owner=session-a');
          expect(observed.stderr).toContain('id=b owner=session-b');
        }
      },
    );

    it('retires only the implicit connector claim on the existing thumbs-up-only clean path', () => {
      const root = tempRoot();
      scopeFixture(root, {
        labels: ['risk:high'],
        comments: [marker(HEAD, 1, '2026-09-13T01:00:00Z')],
        reactions: [reaction('2026-09-13T01:05:00Z')],
      });

      const merged = runHelper(root, ['merge-check', '--head', HEAD], {
        MOCK_CLAIM_NOW: '2026-09-13T01:06:00Z',
      });
      expect(merged.status).toBe(0);
      expect(merged.stdout).toContain('codex=clean');
      expect(merged.stderr).not.toContain('kind=connector');

      scopeFixture(root, {
        comments: [reviewClaim('local-a', 'session-a')],
        reactions: [reaction('2026-09-13T01:05:00Z')],
      });
      expect(JSON.parse(runHelper(root, ['scope']).stdout).reviewClaims).toMatchObject([
        { id: 'local-a', owner: 'session-a', kind: 'explicit' },
      ]);
    });

    it('lets an owner replace an expired claim and surfaces the replacement', () => {
      const root = tempRoot();
      scopeFixture(root, {
        comments: [reviewClaim('old', 'session-a', HEAD, '2026-09-13T00:00:00Z', '2026-09-13T00:45:00Z')],
      });

      const created = runHelper(root, ['claim', '--head', HEAD, '--owner', 'session-a']);
      expect(created.status).toBe(0);
      expect(created.posted).toContain('owner=session-a');
      scopeFixture(root, { comments: [comment('2026-09-13T01:00:00Z', created.posted!, 'shared-account')] });
      expect(JSON.parse(runHelper(root, ['scope']).stdout).reviewClaims).toMatchObject([{ owner: 'session-a' }]);
    });

    it('keeps another live owner after the newest owner retires', () => {
      const root = tempRoot();
      scopeFixture(root, {
        comments: [reviewClaim('a', 'session-a'), reviewClaim('b', 'session-b'), completedClaim('b', 'session-b')],
      });

      expect(JSON.parse(runHelper(root, ['scope']).stdout).reviewClaims).toMatchObject([
        { id: 'a', owner: 'session-a' },
      ]);
    });

    it('keeps a connector claim live for stale completion evidence or a review of another head', () => {
      const root = tempRoot();
      scopeFixture(root, {
        comments: [marker(HEAD, 2, '2026-09-13T01:00:00Z')],
        reviews: [review('2026-09-13T00:59:59Z', HEAD), review('2026-09-13T01:05:00Z', OLD_HEAD)],
        reactions: [reaction('2026-09-13T01:00:00Z')],
      });

      expect(JSON.parse(runHelper(root, ['scope']).stdout).reviewClaims).toMatchObject([
        { id: 'connector-2-20260913010000', owner: 'connector' },
      ]);
    });

    it('keeps the scope verdict unchanged when an advisory evidence read fails', () => {
      const root = tempRoot();
      scopeFixture(root, { comments: [reviewClaim('a', 'session-a')] });
      fs.writeFileSync(path.join(root, 'reviews-fail-1'), '');

      const observed = runHelper(root, ['scope']);
      expect(observed.status).toBe(0);
      expect(JSON.parse(observed.stdout)).toMatchObject({ verdict: 'skip' });
    });
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
      'gpt-6-astra via codex exec',
      '--body-file',
      bodyFile,
    ]);
    expect(result.status).toBe(0);
    expect(result.posted).toContain(`- **Head:** \`${HEAD}\``);
    expect(result.posted).toContain('- **Reviewer and runtime:** gpt-6-astra via codex exec');
    expect(result.posted).toContain('- **Outcome:** approve');
    expect(result.posted).toContain('No findings.');
    expect(result.posted).toMatch(
      new RegExp(`\n<!-- pr-review-loop:substitute-receipt head=${HEAD} outcome=approve -->$`),
    );
  });

  it('retires a review claim only when the receipt names both its id and owner', () => {
    const root = tempRoot();
    const bodyFile = path.join(root, 'review.md');
    fs.writeFileSync(bodyFile, 'Scope: complete diff.\n\nNo findings.\n');

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
      '--claim',
      'review-710',
      '--claim-owner',
      'adversarial-session',
    ]);
    expect(result.status).toBe(0);
    expect(result.posted).toContain(
      `<!-- pr-review-loop:claim-complete id=review-710 owner=adversarial-session head=${HEAD} -->`,
    );

    const missingOwner = runHelper(root, [
      'receipt',
      '--head',
      HEAD,
      '--outcome',
      'approve',
      '--reviewer',
      'gpt-5.6-sol via codex exec',
      '--body-file',
      bodyFile,
      '--claim',
      'review-710',
    ]);
    expect(missingOwner.status).toBe(2);
    expect(missingOwner.stderr).toContain('--claim and --claim-owner must be supplied together');
    expect(missingOwner.posted).toBeNull();
  });

  // #692 P3-2: a bare --head (no value follows) must exit the usage code 2,
  // not bash's ${2:?} exit 1.
  it('refuses a bare --head, posting nothing', () => {
    const root = tempRoot();

    const result = runHelper(root, ['receipt', '--head']);
    expect(result.status).toBe(2);
    expect(result.posted).toBeNull();
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
      'gpt-6-astra via codex exec',
      '--body-file',
      bodyFile,
    ]);
    expect(result.status).toBe(2);
    expect(result.posted).toBeNull();
  });

  it.each([
    ['an embedded newline (a\\nb)', 'a\nb'],
    ['an embedded newline (b\\na)', 'b\na'],
    ['a trailing carriage return', 'claude-fable-5-1\r'],
    ['an embedded carriage return', 'claude-fable-5-1\rmore'],
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
    ['an allowed id mentioned after a disallowed first token', 'claude-sonnet-5 (fallback from claude-fable-5-1)'],
    // Every denied tier, including ones reached through a provider path — the
    // path names the route, so stripping it must not launder a small model.
    ['a mini model', 'gpt-5.4-mini'],
    ['a mini model whose tier is not the last segment', 'gpt-5.1-codex-mini (codex exec)'],
    ['a nano model', 'gpt-5-nano'],
    ['a lite model behind a provider prefix', 'opencode/gemini-3.5-flash-lite (opencode run)'],
    ['a small model behind a two-level provider path', 'nvidia/mistralai/mistral-small-4-119b-2603'],
    ['a sonnet model behind a provider prefix', 'opencode/claude-sonnet-5 (opencode run)'],
    ['a bare alias with no version', 'opus (subagent)'],
    // A version fused onto the tier word is still that tier.
    ['a sonnet model with its version fused on', 'claude-sonnet5'],
    ['a small model with its version fused on', 'mistral-small3.1'],
    // A fullwidth `ｓ` passes bash's `[a-z]` in a UTF-8 locale; the rule runs
    // under LC_ALL=C so the lookalike is not an id character at all.
    ['a sonnet model spelled with a fullwidth lookalike', 'claude-ｓonnet-5'],
  ])('refuses a receipt whose --reviewer names %s, posting nothing', (_case, reviewer) => {
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
    expect(result.stderr).toContain('receipt: --reviewer refused');
  });

  // There is no list of approved models: any concrete id outside the denied
  // tiers may write a receipt, so a newly released frontier model works with no
  // edit. `gpt-7` and `claude-opus-6` stand in for models that do not exist yet —
  // they must pass, or the gate has quietly become an allowlist again.
  // `gemini-3.8-flash` is the substring guard: it contains "mini" and must still
  // pass, because tiers match whole id segments, never substrings.
  it.each([
    'claude-opus-5 (opus)',
    'claude-opus-5[1m] (worker-frontier)',
    'claude-fable-5-1',
    'claude-opus-5-5[1m] (opus)',
    'gpt-6-astra via codex exec',
    'gpt-5.6-sol',
    'deepseek-v4.1-flash (opencode run)',
    'opencode/deepseek-v4.1-flash (opencode run)',
    'opencode-go/gemini-3.8-flash',
    'gemini-3.1-pro',
    'gpt-7',
    'claude-opus-6 (opus)',
    // Case is not part of the id: a mixed-case spelling is the same model.
    'Claude-Opus-5 (opus)',
  ])('accepts a receipt from frontier model %s with no list to edit', (reviewer) => {
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
    expect(result.stderr).toContain('sonnet-tier');
  });

  it.each([
    ['a grep -V flag token', 'claude-sonnet-5 -V'],
    ['a bare grep --version flag token', '--version'],
    ['a grep --help flag token', 'claude-haiku-4-5 --help'],
    ['a grep -v flag token', 'claude-sonnet-5 -v x'],
    ['an allowed id mentioned after a disallowed first token', 'claude-sonnet-5 (fallback from claude-fable-5-1)'],
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

  it.each(['claude-opus-5 (prior worker-high)', 'gpt-5.6-sol via codex exec'])(
    'preserves an existing exact-head approval from prior eligible reviewer %s',
    (reviewer) => {
      const root = tempRoot();
      scopeFixture(root, {
        labels: ['risk:high'],
        comments: [marker(HEAD, 1), receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'OWNER', reviewer)],
      });
      const result = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`merge=allowed head=${HEAD}`);
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
        receiptComment(HEAD, 'changes', '2026-09-05T00:20:00Z', 'OWNER', 'claude-fable-5-1 (worker-frontier)', '101'),
        receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'OWNER', 'claude-fable-5-1 (worker-frontier)', '100'),
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
          'claude-fable-5-1 (worker-frontier)',
          '12345678901234567891',
        ),
        receiptComment(
          HEAD,
          'approve',
          '2026-09-05T00:20:00Z',
          'OWNER',
          'claude-fable-5-1 (worker-frontier)',
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
        [receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'OWNER', 'claude-fable-5-1 (worker-frontier)', '100')],
        true,
        'comments-2',
      ),
    );
    writePage(
      root,
      'comments',
      2,
      connectionPage('comments', [
        receiptComment(HEAD, 'changes', '2026-09-05T00:20:00Z', 'OWNER', 'claude-fable-5-1 (worker-frontier)', null),
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
        receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'OWNER', 'claude-fable-5-1 (worker-frontier)', '100'),
        receiptComment(HEAD, 'changes', '2026-09-05T00:20:00Z', 'OWNER', 'claude-fable-5-1 (worker-frontier)', badId),
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
      // The head records the lesson, so the review-notes rule is met and receipt
      // order alone decides.
      files: [changedFile('docs/review-notes/1.md')],
      comments: [
        receiptComment(HEAD, 'approve', '2026-09-05T00:30:00Z'),
        receiptComment(HEAD, 'changes', '2026-09-05T00:20:00Z'),
      ],
    });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('the latest substitute receipt for this head approves');
  });

  it('leaves legacy merge-check deferring over what Step 6 still judges: CI runs, substitute receipts, the Fixes-PR line', () => {
    const root = tempRoot();
    scopeFixture(root, {
      baseConfig: null,
      labels: ['risk:high'],
      title: 'fix: a fix with no Fixes-PR line',
      comments: [receiptComment(HEAD, 'changes', '2026-09-05T00:20:00Z')],
      ci: [workflowRun('CI', 'completed', 'failure')],
      statuses: [commitStatus('ci/external', 'pending'), commitStatus('ci/optional', 'failure')],
    });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(26);
    expect(result.stdout).toBe(
      'merge=defer mode=legacy: example/repository is not risk-scoped; the existing Step-6 evidence rules apply\n',
    );
    expect(result.calls).not.toContain('actions/runs');
    expect(result.calls).not.toContain('/files');
  });

  describe('legacy precheck: the two facts a legacy merge answers to mechanically', () => {
    function legacy(root: string, opts: { rollup?: Page[] | null; comments?: Page[] } = {}): void {
      scopeFixture(root, { baseConfig: null, labels: [], rollup: opts.rollup, comments: opts.comments });
    }

    // Which checks are required, and which report answers for each, is GitHub's
    // answer (`isRequired`); these cases fix only what is read as red.
    it.each([
      ['a required status is FAILURE', rollupStatus('Release policy', 'FAILURE'), 'Release policy=failure'],
      ['a required status is ERROR', rollupStatus('Release policy', 'ERROR'), 'Release policy=error'],
      [
        'a required status has a state GitHub adds later',
        rollupStatus('Release policy', 'SOME_FUTURE_STATE'),
        'Release policy=some_future_state',
      ],
      ['a required check run concluded FAILURE', rollupRun('CI Gate', 'COMPLETED', 'FAILURE'), 'CI Gate=failure'],
      ['a required check run concluded TIMED_OUT', rollupRun('CI Gate', 'COMPLETED', 'TIMED_OUT'), 'CI Gate=timed_out'],
      ['a required check run concluded CANCELLED', rollupRun('CI Gate', 'COMPLETED', 'CANCELLED'), 'CI Gate=cancelled'],
      [
        'a required check run concluded ACTION_REQUIRED',
        rollupRun('CI Gate', 'COMPLETED', 'ACTION_REQUIRED'),
        'CI Gate=action_required',
      ],
      [
        'a required check run concluded STARTUP_FAILURE',
        rollupRun('CI Gate', 'COMPLETED', 'STARTUP_FAILURE'),
        'CI Gate=startup_failure',
      ],
      ['a required check run concluded STALE', rollupRun('CI Gate', 'COMPLETED', 'STALE'), 'CI Gate=stale'],
      [
        'a required check run has a conclusion GitHub adds later',
        rollupRun('CI Gate', 'COMPLETED', 'SOME_FUTURE_CONCLUSION'),
        'CI Gate=some_future_conclusion',
      ],
      ['a required check run completed with no conclusion', rollupRun('CI Gate', 'COMPLETED', null), 'CI Gate=none'],
    ])('refuses (24) when %s, and never defers', (_case, node, named) => {
      const root = tempRoot();
      legacy(root, { rollup: [rollupStatus('Release approval', 'SUCCESS'), node] });

      const result = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(result.status).toBe(24);
      expect(result.stderr).toContain(`merge=refused head=${HEAD} mode=legacy: required_red: ${named}`);
      expect(result.stdout).not.toContain('merge=');
    });

    it.each([
      ['a required status PENDING', rollupStatus('Release approval', 'PENDING')],
      ['a required status EXPECTED', rollupStatus('Release approval', 'EXPECTED')],
      ['a required check run IN_PROGRESS', rollupRun('CI Gate', 'IN_PROGRESS', null)],
      ['a required check run QUEUED', rollupRun('CI Gate', 'QUEUED', null)],
      ['a required check run NEUTRAL', rollupRun('CI Gate', 'COMPLETED', 'NEUTRAL')],
      ['a required check run SKIPPED', rollupRun('CI Gate', 'COMPLETED', 'SKIPPED')],
      ['a red status GitHub does not require', rollupStatus('ci/optional', 'FAILURE', false)],
      ['a red check run GitHub does not require', rollupRun('lint', 'COMPLETED', 'FAILURE', false)],
    ])('does not refuse on %s', (_case, node) => {
      const root = tempRoot();
      legacy(root, { rollup: [node] });

      expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(26);
    });

    it('takes a status and a check run of one name as two requirements: either one red refuses, whichever is green', () => {
      const root = tempRoot();
      legacy(root, { rollup: [rollupStatus('CI Gate', 'SUCCESS'), rollupRun('CI Gate', 'COMPLETED', 'FAILURE')] });
      const redRun = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(redRun.status).toBe(24);
      expect(redRun.stderr).toContain('required_red: CI Gate=failure');

      legacy(root, { rollup: [rollupStatus('CI Gate', 'FAILURE'), rollupRun('CI Gate', 'COMPLETED', 'SUCCESS')] });
      expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(24);

      legacy(root, { rollup: [rollupStatus('CI Gate', 'SUCCESS'), rollupRun('CI Gate', 'COMPLETED', 'SUCCESS')] });
      expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(26);
    });

    it("leaves an app pin to GitHub: the pinned app's red run is the required one, another source's same-named green is not", () => {
      const root = tempRoot();
      legacy(root, {
        rollup: [
          rollupRun('CI Gate', 'COMPLETED', 'FAILURE', true),
          rollupRun('CI Gate', 'COMPLETED', 'SUCCESS', false),
        ],
      });
      expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(24);

      legacy(root, {
        rollup: [
          rollupRun('CI Gate', 'COMPLETED', 'FAILURE', false),
          rollupRun('CI Gate', 'COMPLETED', 'SUCCESS', true),
        ],
      });
      expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(26);
    });

    it('does not read a pending required Release approval as red: it defers, and ci-wait still reads green', () => {
      const root = tempRoot();
      legacy(root, {
        rollup: [rollupStatus('Release approval', 'PENDING'), rollupStatus('Release policy', 'SUCCESS')],
      });
      writeJson(root, `statuses--${HEAD}.json`, [
        commitStatus('Release approval', 'pending'),
        commitStatus('Release policy', 'success'),
      ]);

      const merge = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(merge.status).toBe(26);
      expect(merge.stderr).not.toContain('required_red');

      writeJson(root, 'pr.json', ciPr());
      const wait = ciWait(root, ['--head', HEAD], [0, 0, 0]);
      expect(wait.status).toBe(0);
      expect(wait.stdout).toContain(`ci=green head=${HEAD}`);
      expect(wait.stdout + wait.stderr).not.toContain('ci_pending');
    });

    it('reads every page of the rollup, and a head nothing has reported on as nothing red', () => {
      const root = tempRoot();
      legacy(root);
      writePage(root, 'rollup', 1, rollupPage([rollupStatus('Release policy', 'SUCCESS')], HEAD, true, 'rollup-2'));
      writePage(root, 'rollup', 2, rollupPage([rollupRun('CI Gate', 'COMPLETED', 'FAILURE')]));
      const paged = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(paged.status).toBe(24);
      expect(paged.stderr).toContain('required_red: CI Gate=failure');

      legacy(root, { rollup: null });
      expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(26);
    });

    it('gives no verdict (1), never a defer, when the rollup cannot be read or is for another head', () => {
      const root = tempRoot();
      legacy(root);
      fs.writeFileSync(path.join(root, 'rollup-fail-1'), '');
      const failed = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('could not read which required checks are red on this head');
      expect(failed.stdout).not.toContain('merge=');

      fs.rmSync(path.join(root, 'rollup-fail-1'));
      writePage(root, 'rollup', 1, rollupPage([rollupStatus('Release policy', 'SUCCESS')], OTHER_HEAD));
      const moved = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(moved.status).toBe(1);
      expect(moved.stderr).toContain(`the status rollup read is for another head than ${HEAD}`);
      expect(moved.stdout).not.toContain('merge=');
    });

    it('refuses (24) when a newer independent CHANGES receipt follows an older approving substitute receipt', () => {
      const root = tempRoot();
      legacy(root, {
        comments: [
          receiptComment(HEAD, 'approve', '2026-09-05T00:14:00Z', 'MEMBER'),
          independentReceipt(HEAD, 'CHANGES', 1, '2026-09-05T00:28:00Z'),
        ],
      });

      const result = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(result.status).toBe(24);
      expect(result.stderr).toContain(`merge=refused head=${HEAD} mode=legacy: independent_receipt_not_clear:`);
      expect(result.stderr).toContain('verdict CHANGES, blocking_findings 1');
      expect(result.stdout).not.toContain('merge=');
    });

    it('is not lifted by a substitute approve posted after the CHANGES receipt: only the desk clears its own no', () => {
      const root = tempRoot();
      legacy(root, {
        comments: [
          independentReceipt(HEAD, 'CHANGES', 1, '2026-09-05T00:28:00Z'),
          receiptComment(HEAD, 'approve', '2026-09-05T00:30:00Z', 'MEMBER'),
        ],
      });

      expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(24);
    });

    it('defers once a later CLEAR receipt for the head follows the CHANGES one, ordered by posting id, not createdAt', () => {
      const root = tempRoot();
      legacy(root, {
        comments: [
          // Same second: only the database id says which came last.
          independentReceipt(HEAD, 'CLEAR', 0, '2026-09-05T00:28:00Z', 'MEMBER', '9007199254740993'),
          independentReceipt(HEAD, 'CHANGES', 1, '2026-09-05T00:28:00Z', 'MEMBER', '9007199254740992'),
        ],
      });
      expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(26);

      legacy(root, {
        comments: [
          independentReceipt(HEAD, 'CLEAR', 0, '2026-09-05T00:28:00Z', 'MEMBER', '9007199254740992'),
          independentReceipt(HEAD, 'CHANGES', 1, '2026-09-05T00:28:00Z', 'MEMBER', '9007199254740993'),
        ],
      });
      expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(24);
    });

    it.each(['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR'])(
      'ignores an independent CHANGES receipt from an author without write access (%s)',
      (association) => {
        const root = tempRoot();
        legacy(root, { comments: [independentReceipt(HEAD, 'CHANGES', 1, '2026-09-05T00:28:00Z', association)] });

        expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(26);
      },
    );

    it('ignores a receipt for another head, and a marker only mentioned in prose', () => {
      const root = tempRoot();
      legacy(root, {
        comments: [
          independentReceipt(OLD_HEAD, 'CHANGES', 2, '2026-09-05T00:28:00Z'),
          {
            author: { login: 'davekim917' },
            authorAssociation: 'OWNER',
            createdAt: '2026-09-05T00:29:00Z',
            fullDatabaseId: '1788568140',
            body: 'merge-check does not read `<!-- independent-review-receipt:v1 -->` markers yet.',
          },
        ],
      });

      expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(26);
    });

    it.each([
      [
        'CLEAR with blocking findings',
        independentReceipt(HEAD, 'CLEAR', 1, '2026-09-05T00:28:00Z'),
        'blocking_findings 1',
      ],
      [
        'a JSON block that does not parse but names this head',
        independentReceipt(HEAD, 'CLEAR', 0, '2026-09-05T00:28:00Z', 'OWNER', '1788568080', `{ not json ${HEAD}`),
        'its JSON block does not parse',
      ],
      [
        'a receipt with no orderable database id',
        independentReceipt(HEAD, 'CLEAR', 0, '2026-09-05T00:28:00Z', 'OWNER', null),
        'receipt_order_unknown',
      ],
    ])('fails closed on %s', (_case, receipt, why) => {
      const root = tempRoot();
      legacy(root, { comments: [receipt] });

      const result = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(result.status).toBe(24);
      expect(result.stderr).toContain(why);
    });

    describe('who may clear: anyone trusted can block, only write access can clear', () => {
      const FORGED = [
        independentReceipt(HEAD, 'CHANGES', 1, '2026-09-05T00:28:00Z'),
        {
          ...independentReceipt(HEAD, 'CLEAR', 0, '2026-09-05T00:40:00Z', 'COLLABORATOR'),
          author: { login: 'reader' },
        },
      ];

      it.each(['read', 'triage', 'none'])(
        'ignores a later CLEAR from an author whose permission is %s: the CHANGES under it stands',
        (permission) => {
          const root = tempRoot();
          legacy(root, { comments: FORGED });
          fs.writeFileSync(path.join(root, 'permission--reader'), `${permission}\n`);

          const result = runHelper(root, ['merge-check', '--head', HEAD]);
          expect(result.status).toBe(24);
          expect(result.stderr).toContain('release-desk posted the newest independent-review receipt');
          expect(result.stderr).toContain('verdict CHANGES, blocking_findings 1');
        },
      );

      it.each(['write', 'admin'])(
        'counts a later CLEAR from an author with %s permission, after one lookup',
        (permission) => {
          const root = tempRoot();
          legacy(root, { comments: FORGED });
          fs.writeFileSync(path.join(root, 'permission--reader'), `${permission}\n`);

          const result = runHelper(root, ['merge-check', '--head', HEAD]);
          expect(result.status).toBe(26);
          expect(result.calls.match(/^rest .*\/permission$/gm)).toEqual([
            'rest repos/example/repository/collaborators/reader/permission',
          ]);
        },
      );

      it('does not count a CLEAR whose author cannot be looked up', () => {
        const root = tempRoot();
        legacy(root, { comments: FORGED });
        fs.writeFileSync(path.join(root, 'permission--reader.error'), '');

        expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(24);
      });

      it("lets a read-only author's CHANGES block over a writer's older CLEAR, with no lookup", () => {
        const root = tempRoot();
        legacy(root, {
          comments: [
            independentReceipt(HEAD, 'CLEAR', 0, '2026-09-05T00:28:00Z'),
            {
              ...independentReceipt(HEAD, 'CHANGES', 1, '2026-09-05T00:40:00Z', 'COLLABORATOR'),
              author: { login: 'reader' },
            },
          ],
        });
        fs.writeFileSync(path.join(root, 'permission--reader'), 'read\n');

        const result = runHelper(root, ['merge-check', '--head', HEAD]);
        expect(result.status).toBe(24);
        expect(result.stderr).toContain('reader posted the newest independent-review receipt');
        expect(result.calls).not.toContain('/permission');
      });

      it('defers when the only receipt is a CLEAR that does not count: nothing says no', () => {
        const root = tempRoot();
        legacy(root, { comments: [FORGED[1]] });
        fs.writeFileSync(path.join(root, 'permission--reader'), 'read\n');

        expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(26);
      });
    });

    // A trusted comment that only quotes a receipt, inside `wrap`.
    function quoted(wrap: (receipt: string) => string, verdict: string, findings: number, createdAt: string): Page {
      const real = independentReceipt(HEAD, verdict, findings, createdAt);
      const receipt = (real.body as string).slice((real.body as string).indexOf('<!--'));
      return { ...real, body: `For the record, the receipt shape is:\n\n${wrap(receipt)}\n` };
    }
    const FENCES: [string, (receipt: string) => string][] = [
      ['a longer backtick fence', (r) => `\`\`\`\`text\n${r}\`\`\`\`\n`],
      ['a tilde fence', (r) => `~~~\n${r}~~~\n`],
      ['an HTML comment', (r) => `<!--\n${r}-->\n`],
    ];

    it.each(FENCES)('still refuses when a CLEAR receipt quoted inside %s follows a real CHANGES one', (_case, wrap) => {
      const root = tempRoot();
      legacy(root, {
        comments: [
          independentReceipt(HEAD, 'CHANGES', 1, '2026-09-05T00:28:00Z'),
          quoted(wrap, 'CLEAR', 0, '2026-09-05T00:40:00Z'),
        ],
      });

      const result = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(result.status).toBe(24);
      expect(result.stderr).toContain('verdict CHANGES, blocking_findings 1');
    });

    it('drops a quoted CLEAR on its own, and reads the real receipt after a quoted one in the same comment', () => {
      const root = tempRoot();
      legacy(root, { comments: [quoted(FENCES[0][1], 'CLEAR', 0, '2026-09-05T00:40:00Z')] });
      expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(26);

      const real = independentReceipt(HEAD, 'CHANGES', 1, '2026-09-05T00:41:00Z');
      const sample = quoted(FENCES[0][1], 'CLEAR', 0, '2026-09-05T00:41:00Z');
      legacy(root, { comments: [{ ...real, body: `${sample.body as string}\n${real.body as string}` }] });
      const result = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(result.status).toBe(24);
      expect(result.stderr).toContain('verdict CHANGES, blocking_findings 1');
    });

    it('lets a hidden marker block but never clear: a CHANGES receipt under a fence left unclosed still refuses', () => {
      const root = tempRoot();
      const real = independentReceipt(HEAD, 'CHANGES', 1, '2026-09-05T00:41:00Z');
      legacy(root, { comments: [{ ...real, body: `\`\`\`ts\nconst unclosed = 1;\n\n${real.body as string}` }] });

      const result = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(result.status).toBe(24);
      expect(result.stderr).toContain('verdict CHANGES');
    });

    describe('hidden markers can only block, and every one of them is read', () => {
      const receiptText = (verdict: string, findings: number): string => {
        const body = independentReceipt(HEAD, verdict, findings, '2026-09-05T00:41:00Z').body as string;
        return body.slice(body.indexOf('<!--'));
      };
      // Four backticks: a receipt's own three-backtick JSON fence cannot close it.
      const unclosed = (...receipts: string[]): string => `\`\`\`\`ts\nconst unclosed = 1;\n\n${receipts.join('\n')}`;

      it('reads a hidden CHANGES after a hidden CLEAR example in one comment: the CLEAR suppresses nothing', () => {
        const root = tempRoot();
        const real = independentReceipt(HEAD, 'CHANGES', 1, '2026-09-05T00:41:00Z');
        legacy(root, { comments: [{ ...real, body: unclosed(receiptText('CLEAR', 0), receiptText('CHANGES', 1)) }] });

        const result = runHelper(root, ['merge-check', '--head', HEAD]);
        expect(result.status).toBe(24);
        expect(result.stderr).toContain('verdict CHANGES, blocking_findings 1');
      });

      it('reads a visible CHANGES after a visible CLEAR in one comment as a no', () => {
        const root = tempRoot();
        const real = independentReceipt(HEAD, 'CHANGES', 1, '2026-09-05T00:41:00Z');
        legacy(root, { comments: [{ ...real, body: `${receiptText('CLEAR', 0)}\n${receiptText('CHANGES', 1)}` }] });

        expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(24);
      });

      it('reads a hidden CHANGES beside a visible CLEAR in one comment: a visible marker does not excuse the hidden ones', () => {
        const root = tempRoot();
        const real = independentReceipt(HEAD, 'CLEAR', 0, '2026-09-05T00:41:00Z');
        legacy(root, {
          comments: [{ ...real, body: `${receiptText('CLEAR', 0)}\n${unclosed(receiptText('CHANGES', 1))}` }],
        });

        const result = runHelper(root, ['merge-check', '--head', HEAD]);
        expect(result.status).toBe(24);
        expect(result.stderr).toContain('verdict CHANGES, blocking_findings 1');
      });

      it.each([
        ['hidden', (body: string) => unclosed(body)],
        ['visible', (body: string) => body],
      ])('does not let a hidden CLEAR in a newer comment mask an older %s CHANGES', (_case, wrap) => {
        const root = tempRoot();
        const older = independentReceipt(HEAD, 'CHANGES', 1, '2026-09-05T00:28:00Z');
        const newer = independentReceipt(HEAD, 'CLEAR', 0, '2026-09-05T00:40:00Z');
        legacy(root, {
          comments: [
            { ...older, body: wrap(receiptText('CHANGES', 1)) },
            { ...newer, body: unclosed(receiptText('CLEAR', 0)) },
          ],
        });

        const result = runHelper(root, ['merge-check', '--head', HEAD]);
        expect(result.status).toBe(24);
        expect(result.stderr).toContain('verdict CHANGES, blocking_findings 1');
      });

      // A CLEAR clears only when its comment starts with the marker and holds no
      // other. Each of these is a newer write-author comment over a real CHANGES,
      // and none of them clears.
      it.each([
        ['an HTML comment and tilde fences interleaved', (r: string) => `<!--\n~~~\n-->\n~~~\n-->\n${r}`],
        ['a fence opened inside a blockquote', (r: string) => `> \`\`\`\n> quoted\n\n${r}`],
        ['a fence opened behind nested blockquote marks', (r: string) => `> > ~~~\n${r}`],
        ['an indented code line', (r: string) => `Steps:\n\n    example line\n${r}`],
        ['a tab-indented code line', (r: string) => `Steps:\n\n\texample line\n${r}`],
        ['a <details> block', (r: string) => `<details><summary>sample</summary>\n\n${r}`],
        ['a <pre> block', (r: string) => `<PRE>\n${r}`],
        ['a second CLEAR marker in the same comment', (r: string) => `${r}\n${r}`],
        ['a tag whose multiline attribute holds the receipt', (r: string) => `<div title='\n${r}'></div>`],
        ['one line of prose', (r: string) => `Cleared.\n${r}`],
        ['a zero-width space', (r: string) => `\u200B\n${r}`],
        ['a no-break space', (r: string) => `\u00A0\n${r}`],
        ['a second byte-order mark', (r: string) => `\uFEFF\uFEFF${r}`],
      ])('does not let a CLEAR preceded by %s clear the head', (_case, wrap) => {
        const root = tempRoot();
        const newer = independentReceipt(HEAD, 'CLEAR', 0, '2026-09-05T00:40:00Z');
        legacy(root, {
          comments: [
            independentReceipt(HEAD, 'CHANGES', 1, '2026-09-05T00:28:00Z'),
            { ...newer, body: wrap(receiptText('CLEAR', 0)) },
          ],
        });

        const result = runHelper(root, ['merge-check', '--head', HEAD]);
        expect(result.status).toBe(24);
        expect(result.stderr).toContain('verdict CHANGES, blocking_findings 1');
      });

      const PROSE_FIRST =
        'Release desk — **independent review at head `aaaaaaaa`: CLEAR, 0 blocking findings.**\n\n' +
        '1. **P2, non-blocking** — `repo.ts:848` authorizes only the current row.\n\n';

      it('does not let a prose-then-marker CLEAR clear: it blocks nothing either, so it defers only when nothing says no', () => {
        const root = tempRoot();
        const newer = independentReceipt(HEAD, 'CLEAR', 0, '2026-09-05T00:40:00Z');
        const proseFirst = { ...newer, body: PROSE_FIRST + receiptText('CLEAR', 0) };
        legacy(root, { comments: [independentReceipt(HEAD, 'CHANGES', 1, '2026-09-05T00:28:00Z'), proseFirst] });
        expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(24);

        legacy(root, { comments: [proseFirst] });
        expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(26);
      });

      it.each([
        ['write', 26],
        ['read', 24],
      ])('reads a marker-first CLEAR with its prose after it from a %s author as %i', (permission, code) => {
        const root = tempRoot();
        const newer = independentReceipt(HEAD, 'CLEAR', 0, '2026-09-05T00:40:00Z');
        legacy(root, {
          comments: [
            independentReceipt(HEAD, 'CHANGES', 1, '2026-09-05T00:28:00Z'),
            {
              ...newer,
              body: `${receiptText('CLEAR', 0)}\n${PROSE_FIRST}\n    an indented line\n\n~~~\nand a fence\n~~~\n`,
            },
          ],
        });
        fs.writeFileSync(path.join(root, 'permission--release-desk'), `${permission}\n`);

        expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(code);
      });

      it.each([
        ['blank lines', '\n\n'],
        ['CRLF blank lines', '\r\n\r\n'],
        ['a byte-order mark', '\uFEFF'],
        ['a byte-order mark and blank lines', '\uFEFF\n \t\n'],
      ])('still counts a CLEAR whose marker follows only %s', (_case, lead) => {
        const root = tempRoot();
        const newer = independentReceipt(HEAD, 'CLEAR', 0, '2026-09-05T00:40:00Z');
        legacy(root, {
          comments: [
            independentReceipt(HEAD, 'CHANGES', 1, '2026-09-05T00:28:00Z'),
            { ...newer, body: lead + receiptText('CLEAR', 0) },
          ],
        });

        expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(26);
      });

      it("still lets a writer's later visible CLEAR clear an older hidden CHANGES", () => {
        const root = tempRoot();
        const older = independentReceipt(HEAD, 'CHANGES', 1, '2026-09-05T00:28:00Z');
        legacy(root, {
          comments: [
            { ...older, body: unclosed(receiptText('CHANGES', 1)) },
            independentReceipt(HEAD, 'CLEAR', 0, '2026-09-05T00:40:00Z'),
          ],
        });

        expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(26);
      });
    });

    describe('which head a receipt is about, and what clears, is never left to a second parser', () => {
      const payload = (json: string, createdAt = '2026-09-05T00:40:00Z'): Page =>
        independentReceipt(HEAD, 'CLEAR', 0, createdAt, 'MEMBER', String(Date.parse(createdAt) / 1000), json);

      it.each([
        [
          'a trailing comma, with a nested head ahead of the real one',
          `{"previous":{"head":"${OLD_HEAD}"},"head":"${HEAD}","verdict":"CHANGES","blocking_findings":1,}`,
        ],
        [
          'a duplicate head key that parses to another head',
          `{"head":"${HEAD}","verdict":"CHANGES","blocking_findings":1,"head":"${OLD_HEAD}"}`,
        ],
        ['no JSON fence content at all beyond the head', `${HEAD} CHANGES`],
      ])('blocks on an unattributable CHANGES that names this head: %s', (_case, json) => {
        const root = tempRoot();
        legacy(root, { comments: [payload(json)] });

        const result = runHelper(root, ['merge-check', '--head', HEAD]);
        expect(result.status).toBe(24);
        expect(result.stderr).toContain('independent_receipt_not_clear');
      });

      it('ignores a payload that does not parse and does not name this head, like a parsed receipt for another head', () => {
        const root = tempRoot();
        legacy(root, { comments: [payload(`{"head":"${OLD_HEAD}","verdict":"CHANGES","blocking_findings":1,}`)] });

        expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(26);
      });

      it.each([
        ['a marker-first CLEAR that does not parse', `{"head":"${HEAD}","verdict":"CLEAR","blocking_findings":0,}`],
        [
          'a duplicate verdict key, CLEAR last',
          `{"head":"${HEAD}","verdict":"CHANGES","verdict":"CLEAR","blocking_findings":0}`,
        ],
        [
          'a verdict key spelled a second way with an escape',
          `{"head":"${HEAD}","verdict":"CHANGES","\\u0076erdict":"CLEAR","blocking_findings":0}`,
        ],
        [
          'a duplicate blocking_findings key, 0 last',
          `{"head":"${HEAD}","verdict":"CLEAR","blocking_findings":2,"blocking_findings":0}`,
        ],
        ['blocking_findings "0"', `{"head":"${HEAD}","verdict":"CLEAR","blocking_findings":"0"}`],
        ['blocking_findings null', `{"head":"${HEAD}","verdict":"CLEAR","blocking_findings":null}`],
        ['blocking_findings absent', `{"head":"${HEAD}","verdict":"CLEAR"}`],
        ['a lower-case verdict', `{"head":"${HEAD}","verdict":"clear","blocking_findings":0}`],
      ])('does not clear on %s: the older CHANGES stands, and alone it blocks', (_case, json) => {
        const root = tempRoot();
        legacy(root, { comments: [independentReceipt(HEAD, 'CHANGES', 1, '2026-09-05T00:28:00Z'), payload(json)] });
        expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(24);

        legacy(root, { comments: [payload(json)] });
        expect(runHelper(root, ['merge-check', '--head', HEAD]).status).toBe(24);
      });
    });

    it('refuses a legacy head that is not the one named, before judging it', () => {
      const root = tempRoot();
      legacy(root);

      const result = runHelper(root, ['merge-check', '--head', OTHER_HEAD]);
      expect(result.status).toBe(24);
      expect(result.stderr).toContain(`the PR head is not ${OTHER_HEAD}`);
      expect(result.calls).not.toMatch(/^rollup /m);
    });

    it('gives no verdict (1), never a defer, when the comments cannot be read', () => {
      const root = tempRoot();
      legacy(root);
      fs.writeFileSync(path.join(root, 'comments-fail-1'), '');

      const result = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain('merge=');
    });

    it('leaves a risk-scoped repo alone: no rollup read, and neither fact changes its verdict', () => {
      const root = tempRoot();
      scopeFixture(root, {
        labels: [],
        statuses: [commitStatus('Release policy', 'failure')],
        rollup: [rollupStatus('Release policy', 'FAILURE')],
        comments: [independentReceipt(HEAD, 'CHANGES', 1, '2026-09-05T00:28:00Z')],
      });

      const result = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`merge=allowed head=${HEAD} mode=risk-scoped verdict=skip ci=green`);
      expect(result.calls).not.toMatch(/^rollup /m);
    });
  });

  // merge-check's own --head (unlike ci-wait/merge/receipt) is optional, but a
  // bare --head with no value must still exit the usage code 2, not bash's
  // ${2:?} exit 1 (#698 fixed the same bug in ci-wait, merge and receipt).
  it('refuses a bare --head, reading nothing', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: [] });

    const result = runHelper(root, ['merge-check', '--head']);
    expect(result.status).toBe(2);
    expect(result.calls).toBe('');
  });
});

// Every subcommand whose --head parsing (its own case arm, or a function it
// dispatches to as `<fn>_main "$@"`) appears in codex-review.sh, derived from
// the script's own source rather than a hand-maintained list here — so a
// future subcommand that adds --head parsing without validating its format
// fails this test automatically, instead of depending on someone remembering
// to add a case (#713 P1; docs/review-notes.md's "usage exit code" class, a
// recurrence of #698's — a SHA argument not validated at the entry point).
//
// This discovery is deliberately narrow (a bare `  <name>)` top-level arm, a
// delegate named exactly `<fn>_main "$@"`, a function opened exactly
// `<name>() {`, and an inline pattern of exactly `--head)`) and so can miss a
// shape that still parses --head in bash: an aliased top-level arm
// (`merge-check|mc)`), a same-line arm, a helper not named `_main`, a
// `function name {` declaration, or a flag pattern aliased with a short form
// (`-H|--head)`). The cross-check below (#713 P3) catches exactly that: it
// scans the whole file for anything shaped like a --head case pattern,
// independent of this discovery, and fails loudly — naming the line — the
// moment one exists that this discovery did not attribute to a subcommand it
// also recognized as head-taking.
interface ArmBlock {
  name: string;
  // Inclusive [start, end] line-index ranges (0-based) attributed to this
  // arm: its own case-arm lines, plus a delegated function's body when one
  // was found.
  ranges: [number, number][];
}

/** The dispatcher's own case arms and, where resolvable, the function bodies they delegate to — the structural attribution the discovery above relies on. */
function discoverArmBlocks(lines: string[]): ArmBlock[] {
  const dispatchStart = lines.findIndex((l) => /^case "\$\{1:\?usage:/.test(l));
  if (dispatchStart === -1) throw new Error('codex-review.sh: could not find the command dispatcher');
  const dispatchEnd = lines.findIndex((l, i) => i > dispatchStart && l === 'esac');
  if (dispatchEnd === -1) throw new Error("codex-review.sh: could not find the dispatcher's closing esac");

  // Top-level arms are exactly two-space indented `<name>)`, never the `*)`
  // catch-all (which carries its body on the same line).
  const armRe = /^ {2}([a-z][a-z-]*)\)$/;
  const arms: { name: string; start: number }[] = [];
  for (let i = dispatchStart + 1; i < dispatchEnd; i++) {
    const m = armRe.exec(lines[i]);
    if (m) arms.push({ name: m[1], start: i });
  }
  if (arms.length === 0) throw new Error('codex-review.sh: found no top-level subcommand arms');

  // Any line at the dispatcher's own two-space indentation is a new
  // top-level arm boundary, whether armRe can name it or not — checked by
  // hand: within the dispatcher, only arm-pattern lines and the final `*)`
  // catch-all sit at this indentation, every arm's own body is indented
  // deeper. Bounding a recognized arm's range at the *next* such line, named
  // or not, keeps an arm armRe cannot name (an alias, a same-line arm) from
  // being silently swept into its neighbor's block — which would otherwise
  // still "attribute" its content, just to the wrong subcommand (#713 P3).
  const ARM_BOUNDARY_RE = /^ {2}\S/;
  function nextBoundary(afterLine: number): number {
    for (let i = afterLine + 1; i < dispatchEnd; i++) if (ARM_BOUNDARY_RE.test(lines[i])) return i;
    return dispatchEnd;
  }

  // Every function in this file opens and closes at column 0 (checked by hand
  // against merge_check_main and ci_wait_main), so its body is the lines from
  // `<name>() {` to the next `}` line.
  function functionBodyRange(name: string): [number, number] | null {
    const start = lines.findIndex((l) => l === `${name}() {`);
    if (start === -1) return null;
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return end === -1 ? null : [start, end];
  }

  return arms.map((arm) => {
    const end = nextBoundary(arm.start);
    const ranges: [number, number][] = [[arm.start, end - 1]];
    const blockText = lines.slice(arm.start, end).join('\n');
    const delegate = blockText.match(/(\w+_main)\s+"\$@"/);
    if (delegate) {
      const fnRange = functionBodyRange(delegate[1]);
      if (fnRange) ranges.push(fnRange);
    }
    return { name: arm.name, ranges };
  });
}

/** Which of `blocks`' arms are classified head-taking: their attributed text contains a bare `--head)` case pattern. */
function headTakingNames(lines: string[], blocks: ArmBlock[]): string[] {
  const headTaking: string[] = [];
  for (const b of blocks) {
    const text = b.ranges.map(([s, e]) => lines.slice(s, e + 1).join('\n')).join('\n');
    if (/^\s*--head\)/m.test(text)) headTaking.push(b.name);
  }
  return headTaking;
}

function headTakingSubcommands(source: string): string[] {
  const lines = source.split('\n');
  return headTakingNames(lines, discoverArmBlocks(lines));
}

// A comment line never counts, whichever shape below it happens to resemble
// — `#`, after only leading whitespace, is never code.
const COMMENT_LINE_RE = /^\s*#/;

// A case-arm pattern, anywhere in the file, that names --head as one of its
// alternatives: `--head)`, `-H|--head)`, `--head|--sha)`, a same-line arm
// (`--head) head="$2"; shift 2 ;;`), a quoted arm (`"--head")`, `'--head')`),
// spaces around `|` (`-H | --head)`), or an optional leading `(`
// (`(--head)`, bash's alternate case-pattern spelling) — independent of
// whether the narrow discovery above found the function it lives in.
// Anchored on the pattern starting the line (after indentation) so it never
// matches --head appearing inside a string or a usage message.
const HEAD_CASE_ARM_RE = /^\s*\(?(?:['"]?[\w.*-]+['"]?\s*\|\s*)*['"]?--head['"]?(?:\s*\|\s*['"]?[\w.*-]+['"]?)*\)/;

// A flag-equality test naming --head, anywhere on the line (unlike a case
// arm, the test is rarely the first token — `if `/`elif ` usually is):
// `[ "$1" = --head ]`, `[[ "$1" == --head ]]`, quoted or bare.
const HEAD_EQUALITY_TEST_RE = /={1,2}\s*['"]?--head['"]?\s*['"]?\s*\]/;

function lineNamesHeadPattern(line: string): boolean {
  if (COMMENT_LINE_RE.test(line)) return false;
  return HEAD_CASE_ARM_RE.test(line) || HEAD_EQUALITY_TEST_RE.test(line);
}

function findHeadCasePatternLines(lines: string[]): number[] {
  const found: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lineNamesHeadPattern(lines[i])) found.push(i);
  return found;
}

/**
 * 0-based line indices of every --head-shaped case pattern in `source` that
 * the parser cannot attribute to a subcommand it also classifies head-taking
 * — either no discovered arm's block contains the line at all (an alias arm,
 * a same-line arm, or a delegate/function discovery could not resolve), or
 * one does, but that arm's own bare-`--head)` detection missed this
 * pattern's shape (`-H|--head)`, say). Empty on the real script (#713 P3).
 */
function unattributedHeadPatternLines(source: string): number[] {
  const lines = source.split('\n');
  const blocks = discoverArmBlocks(lines);
  const headTaking = new Set(headTakingNames(lines, blocks));
  const ownerOf = new Map<number, string>();
  for (const b of blocks) for (const [s, e] of b.ranges) for (let i = s; i <= e; i++) ownerOf.set(i, b.name);

  return findHeadCasePatternLines(lines).filter((lineIdx) => {
    const owner = ownerOf.get(lineIdx);
    return owner === undefined || !headTaking.has(owner);
  });
}

/**
 * The dispatcher's own subcommand list, read from its usage string (the same
 * `${1:?usage:...}` text bash prints on a bad first argument) rather than
 * from `discoverArmBlocks`' `armRe` — an aliased or same-line arm can hide a
 * name from that structural discovery entirely (the mutations above prove as
 * much), but can't change what the usage string tells a caller the valid
 * subcommands are without also breaking that error message (#730 P3 round 3).
 */
function usageSubcommandNames(source: string): string[] {
  const m = /case "\$\{1:\?usage:([^}]+)\}" in/.exec(source);
  if (!m) throw new Error('codex-review.sh: could not find the dispatcher usage string');
  return m[1].split('|').map((name) => name.trim());
}

/**
 * True when `line` reads as parsing `--head` as ITS OWN flag — any
 * `--head`-shaped case-arm pattern (HEAD_CASE_ARM_RE, already broad across
 * quoting, aliasing, spacing and a leading paren), or any other mention of
 * `--head` that also tests the raw positional parameter `$1` on the same
 * line, whatever equality/regex operator or keyword does the testing
 * (`=`, `==`, `=~`, the `test` builtin, reversed operands — the three shapes
 * that escape HEAD_EQUALITY_TEST_RE all name `$1` right there with it).
 * Excludes a mention that only FORWARDS `--head` as a literal flag to
 * another call with an already-computed value — `run_gate --committed-only
 * --head "$PUSH_HEAD"` in `push`, `--head "$SCOPE_HEAD"` in `request` — never
 * `$1` there at all, because that call site is not reading argv itself.
 */
function lineParsesHeadFlag(line: string): boolean {
  if (COMMENT_LINE_RE.test(line)) return false;
  if (HEAD_CASE_ARM_RE.test(line)) return true;
  return /--head\b/.test(line) && /\$1\b/.test(line);
}

/**
 * The bare identifier an arm's own text forwards its arguments to via a
 * standalone `<name> "$@"` statement (the same shape `merge_check_main
 * "$@"` and `ci_wait_main "$@"` already use) — by ANY name, not only one
 * ending in `_main`. discoverArmBlocks' own delegate regex is deliberately
 * narrower: the round-2 cross-check above depends on it staying that way
 * (its "catches a helper delegate not named _main" mutation pins exactly
 * this narrowness), so round 4 gives THIS test its own, separate, broader
 * attribution instead of loosening that shared one. Anchored to a whole
 * line (only whitespace before the name and after the closing quote) so it
 * can't mistake a real line elsewhere in this script — `for arg in "$@"; do`,
 * `git push "$@"` — for a delegate call (#730 P3 round 4 gap 2).
 */
function delegateCalledByArm(armOwnText: string): string | null {
  const m = /^[ \t]*([a-zA-Z_]\w*)[ \t]+"\$@"[ \t]*$/m.exec(armOwnText);
  return m ? m[1] : null;
}

/** `name`'s function body range in `lines` — the same shape as discoverArmBlocks' own (private) functionBodyRange, duplicated here so round 4's broader delegate names don't need that function exported or its `_main`-only caller changed. */
function functionBodyRangeByName(lines: string[], name: string): [number, number] | null {
  const start = lines.findIndex((l) => l === `${name}() {`);
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return end === -1 ? null : [start, end];
}

/**
 * Names of every subcommand — from the UNION of the usage string
 * (usageSubcommandNames) and discoverArmBlocks' own arm discovery, so an arm
 * present in the dispatcher but missing from an out-of-date usage string is
 * still tested (#730 P3 round 4 gap 1: bash's `case "$1" in` dispatches to
 * an arm exactly the same either way — the usage string is only ever the
 * error message `${1:?usage:...}` prints for a MISSING `$1`, never consulted
 * by case matching itself) — whose own code contains a line that parses
 * `--head` as its own flag (lineParsesHeadFlag): checked against the arm's
 * own span first and, when that alone shows nothing, against the body of
 * ANY function it forwards to by a bare `<name> "$@"` statement
 * (delegateCalledByArm) — not only a `_main`-suffixed one (round 4 gap 2).
 * A content check, not a shape match: deliberately broader than
 * headTakingNames' bare-`--head)`-only pattern, which is exactly what left
 * three parsing shapes unattributed in round 3, and needs no updating for a
 * new equality/case spelling because it never looks at the spelling.
 */
function mentionsHeadAnywhere(source: string, lines: string[]): Set<string> {
  const blocks = discoverArmBlocks(lines);
  const blockByName = new Map(blocks.map((b) => [b.name, b] as const));
  const allNames = new Set([...usageSubcommandNames(source), ...blocks.map((b) => b.name)]);
  const names = new Set<string>();
  for (const name of allNames) {
    const block = blockByName.get(name);
    if (!block) continue; // named in the usage string, but no arm text discoverArmBlocks could attribute — nothing to scan
    const [s, e] = block.ranges[0]; // the arm's own span — never discoverArmBlocks' own narrower _main-only delegate range
    let hit = false;
    for (let i = s; i <= e && !hit; i++) if (lineParsesHeadFlag(lines[i])) hit = true;
    if (!hit) {
      const delegateName = delegateCalledByArm(lines.slice(s, e + 1).join('\n'));
      const fnRange = delegateName ? functionBodyRangeByName(lines, delegateName) : null;
      if (fnRange) {
        const [fs, fe] = fnRange;
        for (let i = fs; i <= fe && !hit; i++) if (lineParsesHeadFlag(lines[i])) hit = true;
      }
    }
    if (hit) names.add(name);
  }
  return names;
}

describe('every subcommand that parses --head validates it as a hex sha before reading anything (#713 P1)', () => {
  const subcommands = headTakingSubcommands(fs.readFileSync(HELPER, 'utf8'));

  // A parser regression that silently found zero subcommands would make every
  // case below vacuous (it.each on an empty list runs nothing); pin the known
  // members so that failure mode is itself a visible test failure.
  it('found the subcommands this file is known to cover', () => {
    expect(subcommands).toEqual(expect.arrayContaining(['ci-wait', 'merge-check', 'merge', 'receipt']));
  });

  it.each(
    subcommands.flatMap((cmd) => [
      [cmd, ''],
      [cmd, 'zzz'],
      [cmd, 'a'],
    ]),
  )('%s --head %j exits 2, reading nothing', (cmd, value) => {
    const root = tempRoot();

    const result = runHelper(root, [cmd, '--head', value]);
    expect(result.status).toBe(2);
    expect(result.calls).toBe('');
  });
});

// #713 P3: a cross-check independent of headTakingSubcommands' own discovery
// heuristics — it finds every --head-shaped case pattern in the file by a
// separate, broader scan, and fails, naming the line, the moment one is not
// attributed to a subcommand the discovery above also classifies head-taking.
describe('cross-check: every --head-shaped case pattern is attributed to a discovered, head-taking subcommand (#713 P3)', () => {
  const source = fs.readFileSync(HELPER, 'utf8');
  const patternLines = findHeadCasePatternLines(source.split('\n'));
  const unattributed = new Set(unattributedHeadPatternLines(source));

  // A broad scan that silently matched nothing would make every case below
  // vacuous, the same failure mode the P1 test above guards against.
  it('found at least one --head case pattern (sanity: the scan is not vacuous)', () => {
    expect(patternLines.length).toBeGreaterThan(0);
  });

  it.each(patternLines)(
    'the --head case pattern on line %i is attributed to a discovered, head-taking subcommand',
    (lineIdx) => {
      expect(unattributed.has(lineIdx)).toBe(false);
    },
  );
});

// #713 P3: proof that the cross-check actually catches the five shapes that
// motivated it, each applied to an in-memory copy of the real script so a
// regression in the cross-check itself (not just in headTakingSubcommands)
// would show up here.
describe('the cross-check catches each shape that could let a --head parser escape (#713 P3)', () => {
  const realSource = fs.readFileSync(HELPER, 'utf8');

  it('finds nothing unattributed in the real, unmodified script', () => {
    expect(unattributedHeadPatternLines(realSource)).toEqual([]);
  });

  it('catches an aliased top-level arm ("merge-check|mc)") that hides its delegate entirely', () => {
    const mutated = realSource.replace(
      '  merge-check)\n    shift\n    merge_check_main "$@"\n    ;;',
      '  merge-check|mc)\n    shift\n    merge_check_main "$@"\n    ;;',
    );
    expect(mutated).not.toBe(realSource); // the replacement must actually have matched something
    expect(unattributedHeadPatternLines(mutated).length).toBeGreaterThan(0);
  });

  it('catches a same-line top-level arm that hides its delegate entirely', () => {
    const mutated = realSource.replace(
      '  merge-check)\n    shift\n    merge_check_main "$@"\n    ;;',
      '  merge-check) shift; merge_check_main "$@" ;;',
    );
    expect(mutated).not.toBe(realSource);
    expect(unattributedHeadPatternLines(mutated).length).toBeGreaterThan(0);
  });

  it('catches a helper delegate not named "_main"', () => {
    const mutated = realSource.replace(
      '  merge-check)\n    shift\n    merge_check_main "$@"\n    ;;',
      '  merge-check)\n    shift\n    merge_check_dispatch "$@"\n    ;;',
    );
    expect(mutated).not.toBe(realSource);
    expect(unattributedHeadPatternLines(mutated).length).toBeGreaterThan(0);
  });

  it('catches a "function name {" declaration in place of "name() {"', () => {
    const mutated = realSource.replace('merge_check_main() {', 'function merge_check_main {');
    expect(mutated).not.toBe(realSource);
    expect(unattributedHeadPatternLines(mutated).length).toBeGreaterThan(0);
  });

  it('catches a "-H|--head)" flag alias the narrow bare-"--head)" detection misses', () => {
    const mutated = realSource.replace(
      '      --head)\n        [ $# -ge 2 ] && [[ "$2" =~ ^[0-9a-f]{7,40}$ ]] || { echo "merge-check: --head needs a hex sha (7-40)" >&2; exit 2; }',
      '      -H|--head)\n        [ $# -ge 2 ] && [[ "$2" =~ ^[0-9a-f]{7,40}$ ]] || { echo "merge-check: --head needs a hex sha (7-40)" >&2; exit 2; }',
    );
    expect(mutated).not.toBe(realSource);
    expect(unattributedHeadPatternLines(mutated).length).toBeGreaterThan(0);
  });

  // #730 P3: these five prove the *broad scan* itself (findHeadCasePatternLines)
  // sees a shape, not just that a seen shape gets attributed correctly — each
  // appends a brand-new, never-dispatched-to helper containing the shape, so
  // it is unattributed by construction *if the scan finds it at all*. A scan
  // blind to the shape would report the same (empty) result as the pristine
  // script, silently passing; these fail on that regression.
  it('catches a double-quoted arm ("--head") a bare-string match misses', () => {
    const mutated = `${realSource}\nunrelated_helper() {\n  case "$1" in\n    "--head") shift 2 ;;\n  esac\n}\n`;
    expect(unattributedHeadPatternLines(mutated).length).toBeGreaterThan(0);
  });

  it("catches a single-quoted arm ('--head') a bare-string match misses", () => {
    const mutated = `${realSource}\nunrelated_helper() {\n  case "$1" in\n    '--head') shift 2 ;;\n  esac\n}\n`;
    expect(unattributedHeadPatternLines(mutated).length).toBeGreaterThan(0);
  });

  it('catches a space-joined flag alias ("-H | --head)") a no-space match misses', () => {
    const mutated = `${realSource}\nunrelated_helper() {\n  case "$1" in\n    -H | --head) shift 2 ;;\n  esac\n}\n`;
    expect(unattributedHeadPatternLines(mutated).length).toBeGreaterThan(0);
  });

  it('catches a paren-prefixed arm ("(--head)") the unparenthesized pattern misses', () => {
    const mutated = `${realSource}\nunrelated_helper() {\n  case "$1" in\n    (--head) shift 2 ;;\n  esac\n}\n`;
    expect(unattributedHeadPatternLines(mutated).length).toBeGreaterThan(0);
  });

  it('catches a flag-equality test ([ "$1" = --head ]) a case-arm-only match misses', () => {
    const mutated = `${realSource}\nunrelated_helper() {\n  if [ "$1" = --head ]; then shift 2; fi\n}\n`;
    expect(unattributedHeadPatternLines(mutated).length).toBeGreaterThan(0);
  });

  it('catches a double-bracket flag-equality test ([[ "$1" == --head ]])', () => {
    const mutated = `${realSource}\nunrelated_helper() {\n  if [[ "$1" == --head ]]; then shift 2; fi\n}\n`;
    expect(unattributedHeadPatternLines(mutated).length).toBeGreaterThan(0);
  });

  // Comment lines never count, whichever shape they resemble — otherwise a
  // mention of --head in prose would itself be an (unattributed) false
  // positive on every doc comment naming it.
  it('does not flag --head mentioned only in a comment', () => {
    const mutated = `${realSource}\n# case "$1" in\n#   "--head") shift 2 ;;\n# esac\n`;
    expect(unattributedHeadPatternLines(mutated)).toEqual([]);
  });
});

// #730 P3 round 3: HEAD_EQUALITY_TEST_RE (and the cross-check above, which
// still leans on it for its own detection of a test-style pattern) matches
// only whichever --head-parsing *shapes* it was written and then widened
// for; three more escape it today — reversed equality operands
// (`[ --head = "$1" ]`), the `test` builtin (`test "$1" = --head`, which
// never has a literal `]` for the regex to anchor on at all), and a
// `[[ ... =~ ... ]]` regex match (`[[ $1 =~ ^--head$ ]]`, whose `=~` is not
// `={1,2}` and whose `$` before the closing `]]` breaks the tail match).
// Each new escaping shape found so far has been fixed by widening the
// pattern once more, which only means the NEXT shape escapes it too.
//
// This closes the whole class behaviourally instead of describing another
// shape: it reads the dispatcher's own usage string for the authoritative
// subcommand list (usageSubcommandNames — robust to an aliased or same-line
// arm hiding a name from armRe entirely, unlike relying on discoverArmBlocks'
// `arms` for enumeration), keeps only the names whose own attributed code
// mentions `--head` at all regardless of syntax (mentionsHeadAnywhere — a
// content check, not a shape match), and actually runs each with an empty
// value: whatever syntax a subcommand uses to test for `--head`, the one
// thing every correct implementation must do is exit 2 before touching gh.
// A subcommand that parses --head without validating it is caught this way,
// whatever the shape; one that never touches --head at all (open, churn,
// push, …) is never asked to satisfy an invariant it never claimed.
describe('every subcommand whose own code mentions --head, in any shape, rejects an empty value before touching gh (#730 P3 round 3)', () => {
  const source = fs.readFileSync(HELPER, 'utf8');
  const lines = source.split('\n');
  const usageNames = usageSubcommandNames(source);
  const headMentioning = [...mentionsHeadAnywhere(source, lines)];

  // A regression that emptied the usage string would still leave
  // mentionsHeadAnywhere's arm-derived side of the union finding these four
  // (discoverArmBlocks doesn't read the usage string at all) — so this is
  // its own guard, independent of that union, against exactly the failure
  // mode "renamed it must still exit 1" (usageSubcommandNames throws when it
  // can't find the pattern at all) does not cover: the pattern still
  // matches, but its captured list is empty or wrong.
  it('the usage string names at least the subcommands this file is known to cover', () => {
    expect(usageNames).toEqual(expect.arrayContaining(['ci-wait', 'merge-check', 'merge', 'receipt']));
  });

  // A regression that silently found zero subcommands (a broken usage-string
  // parse, or a discoverArmBlocks change that stopped finding arms at all)
  // would make every case below vacuous — the same failure mode the P1 test
  // and the cross-check above both guard against explicitly.
  it('found the subcommands this file is known to mention --head in', () => {
    expect(headMentioning).toEqual(expect.arrayContaining(['ci-wait', 'merge-check', 'merge', 'receipt']));
  });

  it.each(headMentioning)('%s --head "" exits 2 and makes no gh call, whatever shape it parses --head in', (cmd) => {
    const root = tempRoot();
    const result = runHelper(root, [cmd, '--head', '']);
    expect(result.status).toBe(2);
    expect(result.calls).toBe('');
  });

  // Proof this closes the class rather than describing a fourth shape: each
  // case below adds a brand-new subcommand (so no existing arm's own
  // validation can mask the result) whose --head check is one of the three
  // escaping shapes above and does nothing else on an empty value — no
  // length check, no hex check. HEAD_EQUALITY_TEST_RE misses every one of
  // these (that is what makes them the escaping shapes, asserted below); the
  // content-based discovery above still finds `--head` in the new arm's own
  // text, the probe above still runs it, and the missing validation is what
  // fails that probe — a real `gh` call reaches the mocked network with an
  // empty head, unvalidated, exactly as #730 P3 warned it could.
  const ESCAPING_SHAPES: Record<string, string> = {
    'reversed equality operands ([ --head = "$1" ])': `
  probe-reversed)
    shift
    head=""
    while [ $# -gt 0 ]; do
      if [ --head = "$1" ]; then head="$2"; shift 2; else shift; fi
    done
    gh api "repos/$REPO/pulls/$PR" >/dev/null 2>&1 || true
    ;;`,
    'the test builtin (test "$1" = --head)': `
  probe-test-builtin)
    shift
    head=""
    while [ $# -gt 0 ]; do
      if test "$1" = --head; then head="$2"; shift 2; else shift; fi
    done
    gh api "repos/$REPO/pulls/$PR" >/dev/null 2>&1 || true
    ;;`,
    'a [[ =~ ]] regex match ([[ $1 =~ ^--head$ ]])': `
  probe-regex-match)
    shift
    head=""
    while [ $# -gt 0 ]; do
      if [[ "$1" =~ ^--head$ ]]; then head="$2"; shift 2; else shift; fi
    done
    gh api "repos/$REPO/pulls/$PR" >/dev/null 2>&1 || true
    ;;`,
  };

  for (const [shapeName, armText] of Object.entries(ESCAPING_SHAPES)) {
    it(`fails for an unvalidated --head parsed via ${shapeName}`, () => {
      const cmd = /^\n {2}([a-z-]+)\)/.exec(armText)?.[1];
      if (!cmd) throw new Error(`test fixture bug: could not read the probe subcommand name from:\n${armText}`);

      // Sanity: HEAD_EQUALITY_TEST_RE really does miss this shape — otherwise
      // this proves nothing about closing a class the OLD check already covered.
      expect(HEAD_EQUALITY_TEST_RE.test(armText)).toBe(false);

      const mutatedUsage = source.replace(
        /(case "\$\{1:\?usage:[^}]+)(\}" in)/,
        (_all: string, head: string, tail: string) => `${head}|${cmd}${tail}`,
      );
      expect(mutatedUsage).not.toBe(source);
      const mutated = mutatedUsage.replace('  open)', `${armText}\n  open)`);
      expect(mutated).not.toBe(mutatedUsage);

      // Sanity: the new subcommand is discoverable and classified head-mentioning,
      // so it actually reaches the probe below the way a real regression would.
      const mutatedLines = mutated.split('\n');
      const mutatedUsageNames = usageSubcommandNames(mutated);
      const mutatedHeadMentioning = mentionsHeadAnywhere(mutated, mutatedLines);
      expect(mutatedUsageNames).toContain(cmd);
      expect(mutatedHeadMentioning.has(cmd)).toBe(true);

      const root = tempRoot();
      const scriptPath = path.join(root, 'codex-review.sh');
      fs.writeFileSync(scriptPath, mutated);
      const result = runHelper(root, [cmd, '--head', ''], {}, scriptPath);

      // The real invariant the it.each above enforces would fail here: an
      // unvalidated empty --head reached a real gh call instead of exiting 2
      // first.
      expect(result.calls).not.toBe('');
    });
  }

  // #730 P3 round 4 (the last placement gap the approval flagged): two more
  // ways an unvalidated --head parser hid from the probe above — neither a
  // new parsing SHAPE this time, a placement gap instead.
  //   1. mentionsHeadAnywhere used to intersect discoverArmBlocks' own arm
  //      names with the usage string's, so an arm added to the dispatcher
  //      without also updating the usage string's subcommand list vanished
  //      from the probe entirely — even though bash's `case "$1" in`
  //      dispatches to it exactly the same either way; the usage string is
  //      only ever the error message `${1:?usage:...}` prints for a MISSING
  //      $1, never consulted by case matching itself.
  //   2. discoverArmBlocks' own delegate detection requires a `_main`-
  //      suffixed function name by design (the round-2 cross-check above
  //      depends on that narrowness — its own "catches a helper delegate not
  //      named _main" mutation pins it), so a --head parser living inside a
  //      helper named anything else was invisible to it.
  // Fixed by probing the UNION of the usage string's names and
  // discoverArmBlocks' own arm names, and by giving mentionsHeadAnywhere its
  // own, separate delegate attribution (delegateCalledByArm /
  // functionBodyRangeByName) that accepts any bare `<name> "$@"` forwarding
  // statement, not only a `_main`-suffixed one — without touching
  // discoverArmBlocks itself, so the round-2 cross-check's own narrower
  // behavior stays exactly as its mutation test pins it. Each variant below
  // isolates one gap (or both at once, with --head parsed on a single line —
  // mid-line, past where the narrow case-arm-only pattern anchors, the shape
  // this whole class has been about since round 2): before this fix, all
  // four vanish from the probe entirely and the fake subcommand exits 0
  // after a real, unvalidated gh read.
  const PLACEMENT_GAPS: {
    label: string;
    cmd: string;
    addToUsage: boolean;
    armText: string;
    helperText?: string;
  }[] = [
    {
      label: 'an arm present in the dispatcher but missing from the usage string',
      cmd: 'probe-missing-usage',
      addToUsage: false,
      armText: `
  probe-missing-usage)
    shift
    head=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --head) head="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    gh api "repos/$REPO/pulls/$PR" >/dev/null 2>&1 || true
    ;;`,
    },
    {
      label: 'a delegate helper called by a name not ending in _main',
      cmd: 'probe-nonmain-delegate',
      addToUsage: true,
      armText: `
  probe-nonmain-delegate)
    shift
    probe_nonmain_helper "$@"
    ;;`,
      helperText: `
probe_nonmain_helper() {
  head=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --head) head="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  gh api "repos/$REPO/pulls/$PR" >/dev/null 2>&1 || true
}`,
    },
    {
      label: 'missing from the usage string, with --head parsed on a single-line case',
      cmd: 'probe-missing-usage-oneline',
      addToUsage: false,
      armText: `
  probe-missing-usage-oneline)
    shift
    head=""
    while [ $# -gt 0 ]; do case "$1" in --head) head="$2"; shift 2 ;; *) shift ;; esac; done
    gh api "repos/$REPO/pulls/$PR" >/dev/null 2>&1 || true
    ;;`,
    },
    {
      label: 'a non-_main delegate whose --head parsing is a single-line case',
      cmd: 'probe-nonmain-delegate-oneline',
      addToUsage: true,
      armText: `
  probe-nonmain-delegate-oneline)
    shift
    probe_nonmain_helper_oneline "$@"
    ;;`,
      helperText: `
probe_nonmain_helper_oneline() {
  head=""
  while [ $# -gt 0 ]; do case "$1" in --head) head="$2"; shift 2 ;; *) shift ;; esac; done
  gh api "repos/$REPO/pulls/$PR" >/dev/null 2>&1 || true
}`,
    },
  ];

  for (const gap of PLACEMENT_GAPS) {
    it(`catches ${gap.label}`, () => {
      let mutated = source.replace('  open)', `${gap.armText}\n  open)`);
      expect(mutated).not.toBe(source);

      if (gap.helperText) {
        // Defined immediately BEFORE the dispatcher, not appended at file
        // end: bash executes top-to-bottom, so a function definition placed
        // after the case statement that calls it would not exist yet at
        // call time — a real run would hit "command not found" (and exit,
        // under `set -e`, before ever reaching the gh call this test proves
        // happens instead).
        const withHelper = mutated.replace('case "${1:?usage:', `${gap.helperText}\ncase "\${1:?usage:`);
        expect(withHelper).not.toBe(mutated);
        mutated = withHelper;
      }

      if (gap.addToUsage) {
        const withUsage = mutated.replace(
          /(case "\$\{1:\?usage:[^}]+)(\}" in)/,
          (_all: string, head: string, tail: string) => `${head}|${gap.cmd}${tail}`,
        );
        expect(withUsage).not.toBe(mutated);
        mutated = withUsage;
      }

      // Sanity: this variant really does isolate the gap it claims to —
      // present in (or absent from) the usage string exactly as intended,
      // nothing more.
      const mutatedLines = mutated.split('\n');
      expect(usageSubcommandNames(mutated).includes(gap.cmd)).toBe(gap.addToUsage);
      expect(mentionsHeadAnywhere(mutated, mutatedLines).has(gap.cmd)).toBe(true);

      const root = tempRoot();
      const scriptPath = path.join(root, 'codex-review.sh');
      fs.writeFileSync(scriptPath, mutated);
      const result = runHelper(root, [gap.cmd, '--head', ''], {}, scriptPath);

      // The real invariant the it.each above enforces would fail here too:
      // an unvalidated empty --head reached a real gh call instead of
      // exiting 2 first.
      expect(result.calls).not.toBe('');
    });
  }
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
    for (const name of fs.readdirSync(path.dirname(HELPER)))
      fs.copyFileSync(path.join(path.dirname(HELPER), name), path.join(skill, 'scripts', name));
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
    // #692 P3-2: a bare --head must exit the usage code 2, not bash's ${2:?}
    // exit 1.
    ['a bare --head', ['merge', '--head']],
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
      'an approving substitute receipt before the merge (claude-fable-5-1 (worker-frontier))',
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
        receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'OWNER', 'claude-fable-5-1 (worker-frontier)', '100'),
        {
          ...receiptComment(
            HEAD,
            'changes',
            '2026-09-05T00:20:00Z',
            'OWNER',
            'claude-fable-5-1 (worker-frontier)',
            '101',
          ),
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
        [receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'OWNER', 'claude-fable-5-1 (worker-frontier)', '100')],
        true,
        'comments-2',
      ),
    );
    writePage(
      root,
      'comments',
      2,
      connectionPage('comments', [
        receiptComment(HEAD, 'changes', '2026-09-05T00:20:00Z', 'OWNER', 'claude-fable-5-1 (worker-frontier)', null),
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
        receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'OWNER', 'claude-fable-5-1 (worker-frontier)', '100'),
        receiptComment(HEAD, 'changes', '2026-09-05T00:20:00Z', 'OWNER', 'claude-fable-5-1 (worker-frontier)', badId),
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
      // A trusted comment edited after the merge could have been a changes
      // receipt, so the review-notes rule applies; the head meets it, and
      // receipt order alone decides.
      files: [changedFile('docs/review-notes/1.md')],
      comments: [
        {
          author: { login: 'davekim917' },
          authorAssociation: 'OWNER',
          createdAt: '2026-09-05T00:10:00Z',
          lastEditedAt: '2026-09-05T02:00:00Z',
          fullDatabaseId: 'abc',
          body: 'CI is green.',
        },
        receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'OWNER', 'claude-fable-5-1 (worker-frontier)', '100'),
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
      comments: [receiptComment(HEAD, 'approve', MERGED_AT, 'OWNER', 'claude-fable-5-1 (worker-frontier)', '100')],
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
        receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z', 'OWNER', 'claude-fable-5-1 (worker-frontier)', '100'),
        receiptComment(HEAD, 'changes', MERGED_AT, 'OWNER', 'claude-fable-5-1 (worker-frontier)', '101'),
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
        receiptComment(HEAD, 'approve', '2026-09-05T00:59:59Z', 'OWNER', 'claude-fable-5-1 (worker-frontier)', '100'),
      ],
    });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('verdict=review: an approving substitute receipt before the merge');
  });

  // #692 P3-1: an edit landing in the merge's OWN second must not be read as
  // "at or before" it — timestamps have second resolution, so an edit at
  // exactly MERGED_AT may have happened after the merge. Before the fix,
  // $unreadable only caught lastEditedAt > $asof, and $matches accepted
  // lastEditedAt <= $asof, so this receipt read as clean.
  it("flags a receipt edited in the merge's own second, even though it was posted well before the merge (mutation: the pre-fix <= read set passes it)", () => {
    const root = tempRoot();
    auditFixture(root, {
      labels: ['risk:high'],
      comments: [
        {
          ...receiptComment(
            HEAD,
            'approve',
            '2026-09-05T00:30:00Z',
            'OWNER',
            'claude-fable-5-1 (worker-frontier)',
            '100',
          ),
          lastEditedAt: MERGED_AT,
        },
      ],
    });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(28);
    expect(result.stdout).toContain('verdict=review:');
  });

  it('passes a receipt edited one second before the merge (mutation: an off-by-one pushes the edit boundary a second early)', () => {
    const root = tempRoot();
    auditFixture(root, {
      labels: ['risk:high'],
      comments: [
        {
          ...receiptComment(
            HEAD,
            'approve',
            '2026-09-05T00:30:00Z',
            'OWNER',
            'claude-fable-5-1 (worker-frontier)',
            '100',
          ),
          lastEditedAt: '2026-09-05T00:59:59Z',
        },
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
      // A trusted comment edited after the merge could have been a changes
      // receipt, so the review-notes rule applies; the head meets it, and
      // receipt order alone decides.
      files: [changedFile('docs/review-notes/1.md')],
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

describe('codex-review review-notes rule: a PR a reviewer said no to records its lesson', () => {
  // A substitute reviewer asked for changes on an earlier head; this head was then approved.
  const CHANGES_EARLIER = receiptComment(OLD_HEAD, 'changes', '2026-09-05T00:10:00Z');
  const APPROVED = receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z');
  const FRAGMENT = changedFile('docs/review-notes/1.md');
  const LEGACY_NOTES = changedFile('docs/review-notes.md');
  // The receipts' author, as receiptComment writes it.
  const LOGIN = (APPROVED.author as { login: string }).login;
  const MISSING = `review_notes_missing: ${LOGIN} asked for changes on ${OLD_HEAD.slice(0, 12)} at 2026-09-05T00:10:00Z`;

  it.each([
    ['a skip-verdict head with no receipt at all', [], []],
    ['approvals only', ['risk:high'], [receiptComment(OLD_HEAD, 'approve', '2026-09-05T00:10:00Z'), APPROVED]],
    [
      'a changes receipt from an author without write access',
      ['risk:high'],
      [receiptComment(OLD_HEAD, 'changes', '2026-09-05T00:10:00Z', 'NONE'), APPROVED],
    ],
  ])('asks nothing of a PR with %s', (_case, labels, comments) => {
    const root = tempRoot();
    scopeFixture(root, { labels, comments });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('merge=allowed');
  });

  it.each([
    ['review', ['risk:high']],
    ['skip', []],
  ])(
    'refuses (24) a %s-verdict head a receipt said changes on, with no notes touch and no body line (mutation: the merge-check requirement removed)',
    (verdict, labels) => {
      const root = tempRoot();
      scopeFixture(root, { labels, comments: [CHANGES_EARLIER, APPROVED] });

      const result = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(result.status).toBe(24);
      expect(result.stderr).toContain(
        `merge=refused head=${HEAD} verdict=${verdict}: ${MISSING}; this head does not add or amend docs/review-notes/1.md`,
      );
      expect(result.stdout).not.toContain('merge=allowed');
    },
  );

  it('allows it once the current PR adds its own review-notes fragment', () => {
    const root = tempRoot();
    scopeFixture(root, {
      labels: ['risk:high'],
      files: [changedFile('docs/notes.md'), FRAGMENT],
      comments: [CHANGES_EARLIER, APPROVED],
    });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('the latest substitute receipt for this head approves');
  });

  it("does not let another PR's fragment satisfy this PR's gate", () => {
    const root = tempRoot();
    scopeFixture(root, {
      labels: ['risk:high'],
      files: [changedFile('docs/review-notes/2.md')],
      comments: [CHANGES_EARLIER, APPROVED],
    });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain('this head does not add or amend docs/review-notes/1.md');
  });

  it('does not let a current PR use the shared historical notes file', () => {
    const root = tempRoot();
    scopeFixture(root, {
      labels: ['risk:high'],
      files: [LEGACY_NOTES],
      comments: [CHANGES_EARLIER, APPROVED],
    });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain('this head does not add or amend docs/review-notes/1.md');
  });

  it('does not count deleting the current PR fragment as recording the lesson', () => {
    const root = tempRoot();
    scopeFixture(root, {
      labels: ['risk:high'],
      files: [{ filename: 'docs/review-notes/1.md', status: 'removed' }],
      comments: [CHANGES_EARLIER, APPROVED],
    });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain('this head does not add or amend docs/review-notes/1.md');
  });

  it('allows it with a Review-notes: none line that gives a reason', () => {
    const root = tempRoot();
    scopeFixture(root, {
      labels: ['risk:high'],
      body: 'Why.\n\nReview-notes: none (the finding was a typo in a log message; no class to learn)',
      comments: [CHANGES_EARLIER, APPROVED],
    });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('merge=allowed');
  });

  it.each([
    ['trailing spaces', 'Review-notes: none (docs-only change)   '],
    ['a CRLF line ending before more text', 'Review-notes: none (docs-only change)\r\nMore text.'],
    ['a lower-case key', 'review-notes: none (docs-only change)'],
    // #707 P3-b: a format character (\p{Cf}) inside an otherwise-visible
    // reason must not sink it: it is stripped first, and what is left is
    // what is judged.
    ['a zero-width space inside a visible reason', 'Review-notes: none (docs\u200b only)'],
    ['a soft hyphen inside a word', 'Review-notes: none (this\u00adword had a typo)'],
    ['an emoji ZWJ sequence', 'Review-notes: none (fixed by \u{1F469}\u200d\u{1F4BB})'],
    ['a Unicode reason', 'Review-notes: none (na\u00efve fix, already covered)'],
  ])('allows a Review-notes: none line with %s', (_case, line) => {
    const root = tempRoot();
    scopeFixture(root, { labels: ['risk:high'], body: `Why.\n\n${line}`, comments: [CHANGES_EARLIER, APPROVED] });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('merge=allowed');
  });

  it.each([
    ['an empty reason', 'Review-notes: none ()'],
    ['a blank reason', 'Review-notes: none (   )'],
    ['no reason at all', 'Review-notes: none'],
    ['the line inside a code fence', '```\nReview-notes: none (an example)\n```'],
    ['the line inside an HTML comment', '<!-- Review-notes: none (a template) -->'],
    ['a stray parenthesis after the reason (mutation: the loose reason regex)', 'Review-notes: none ()x)'],
    ['a second closing parenthesis', 'Review-notes: none ( ) )'],
    ['text after the closing parenthesis', 'Review-notes: none (a reason) and more'],
    ['a nested parenthesis', 'Review-notes: none (see (the #679 line))'],
    ['a zero-width space for a reason', 'Review-notes: none (\u200b)'],
    ['a no-break space for a reason', 'Review-notes: none (\u00a0)'],
    // #707 P3-b: these look blank but are not \p{Cf}, so stripping alone
    // never removes them: real_reason must name them not-visible directly.
    ['a braille blank (U+2800) for a reason', 'Review-notes: none (\u2800)'],
    ['a Hangul filler (U+3164) for a reason', 'Review-notes: none (\u3164)'],
    ['a lone combining mark for a reason', 'Review-notes: none (\u0301)'],
  ])('refuses (24) a body line with %s', (_case, line) => {
    const root = tempRoot();
    scopeFixture(root, { labels: ['risk:high'], body: `Why.\n\n${line}`, comments: [CHANGES_EARLIER, APPROVED] });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain(MISSING);
  });

  // #707 P3-c: the refusal names which shape rule failed, instead of one
  // generic "no reason" line for every case.
  it.each([
    ['no body line at all', 'Why.', 'the body has no `Review-notes: none (<reason>)` line at all'],
    ['an empty reason', 'Why.\n\nReview-notes: none ()', 'its reason is empty or has no visible character'],
    [
      'text after the closing parenthesis',
      'Why.\n\nReview-notes: none (a reason) and more',
      'it has text after the closing parenthesis ("and more")',
    ],
    [
      'a nested parenthesis',
      'Why.\n\nReview-notes: none (see (the #679 line))',
      'its reason has an unmatched or nested parenthesis',
    ],
    // #713 P3: jq's `index` returns a byte offset below 1.8, but a slice
    // counts codepoints; a multi-byte reason made the two disagree. A
    // non-ASCII but invisible reason must still read as no visible character
    // (not, say, a truncated or off-by-several-bytes reason).
    [
      'a non-ASCII invisible reason (U+3164, Hangul filler)',
      'Why.\n\nReview-notes: none (ㅤ)',
      'its reason is empty or has no visible character',
    ],
    // A visible multi-byte reason with trailing text: the trailing text must
    // be quoted correctly, not shifted by the reason's byte length.
    [
      'a non-ASCII visible reason with text after the parenthesis',
      'Why.\n\nReview-notes: none (日本語) and more',
      'it has text after the closing parenthesis ("and more")',
    ],
    [
      'the line inside a code fence',
      'Why.\n\n```\nReview-notes: none (an example)\n```',
      'it is inside a code fence or an HTML comment',
    ],
    [
      'the line inside an HTML comment',
      'Why.\n\n<!-- Review-notes: none (a template) -->',
      'it is inside a code fence or an HTML comment',
    ],
  ])('names %s in the refusal message', (_case, body, detail) => {
    const root = tempRoot();
    scopeFixture(root, { labels: ['risk:high'], body, comments: [CHANGES_EARLIER, APPROVED] });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain(detail);
  });

  // A natural closing sentence ("none (typo only).") reads as text after the
  // parenthesis; the refusal calls out the trailing period specifically,
  // since it is the likeliest way to trip this over an ordinary sentence.
  it('hints at the trailing period on a natural `none (typo only).` line', () => {
    const root = tempRoot();
    scopeFixture(root, {
      labels: ['risk:high'],
      body: 'Why.\n\nReview-notes: none (typo only).',
      comments: [CHANGES_EARLIER, APPROVED],
    });

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain('text after the closing parenthesis (".")');
    expect(result.stderr).toContain('a trailing period counts as text after the parenthesis; drop it');
  });

  // merge-check reads the comments twice: receipt_outcome, then this rule. The
  // second read failing must never read as "no changes receipt".
  it('refuses, never allows, when the receipts cannot be read for the rule (mutation: a failed read taken as no receipts)', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: ['risk:high'], comments: [CHANGES_EARLIER, APPROVED] });
    fs.writeFileSync(path.join(root, 'comments-fail-2'), '');

    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GraphQL comments request failed');
    expect(result.stdout).not.toContain('merge=allowed');
    expect(result.calls.match(/^comments /gm)).toHaveLength(2);
  });

  it('never counts a file list it could not check as a touch, while the body line still counts', () => {
    const unread = tempRoot();
    scopeFixture(unread, { labels: ['risk:high'], files: null, comments: [CHANGES_EARLIER, APPROVED] });
    const refused = runHelper(unread, ['merge-check', '--head', HEAD]);
    expect(refused.status).toBe(24);
    expect(refused.stderr).toContain(
      `${MISSING}; the files this head changes could not be checked, so no addition of docs/review-notes/1.md counts`,
    );

    const said = tempRoot();
    scopeFixture(said, {
      labels: ['risk:high'],
      files: null,
      body: 'Review-notes: none (covered by the line #700 added)',
      comments: [CHANGES_EARLIER, APPROVED],
    });
    const allowed = runHelper(said, ['merge-check', '--head', HEAD]);
    expect(allowed.status).toBe(0);
  });

  it('audit flags a merge a receipt said changes on, with no notes touch and no body line at the merge', () => {
    const root = tempRoot();
    auditFixture(root, { labels: ['risk:high'], comments: [CHANGES_EARLIER, APPROVED] });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(28);
    expect(result.stdout).toContain(
      `audit=violation pr=1 head=${HEAD} base=${MERGE_PARENT} merged=${MERGED_AT} verdict=review: ${MISSING}`,
    );
  });

  it('audit rejects a merged head that only touched the shared historical notes file', () => {
    const root = tempRoot();
    auditFixture(root, { labels: ['risk:high'], files: [LEGACY_NOTES], comments: [CHANGES_EARLIER, APPROVED] });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(28);
    expect(result.stdout).toContain('this head does not add or amend docs/review-notes/1.md');
  });

  it('audit accepts a merged head that added its own fragment', () => {
    const root = tempRoot();
    auditFixture(root, {
      labels: ['risk:high'],
      files: [FRAGMENT],
      comments: [CHANGES_EARLIER, APPROVED],
    });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('audit=pass');
  });

  it('audit reads the body line as it stood at the merge, not one added after', () => {
    const line = 'Why.\n\nReview-notes: none (the lesson is already on the #679 line)';
    const late = tempRoot();
    auditFixture(late, {
      labels: ['risk:high'],
      body: line,
      edits: [
        { editedAt: '2026-09-05T02:00:00Z', deletedAt: null, diff: line },
        { editedAt: '2026-09-05T00:30:00Z', deletedAt: null, diff: 'Why.' },
      ],
      comments: [CHANGES_EARLIER, APPROVED],
    });
    const flagged = runHelper(late, ['audit']);
    expect(flagged.status).toBe(28);
    expect(flagged.stdout).toContain(MISSING);

    const early = tempRoot();
    auditFixture(early, {
      labels: ['risk:high'],
      body: line,
      edits: [
        { editedAt: '2026-09-05T00:50:00Z', deletedAt: null, diff: line },
        { editedAt: '2026-09-05T00:30:00Z', deletedAt: null, diff: 'Why.' },
      ],
      comments: [CHANGES_EARLIER, APPROVED],
    });
    const passed = runHelper(early, ['audit']);
    expect(passed.status).toBe(0);
  });

  it('audit treats a trusted comment edited after the merge as a possible changes receipt', () => {
    const root = tempRoot();
    auditFixture(root, {
      labels: ['risk:high'],
      comments: [
        {
          author: { login: LOGIN },
          authorAssociation: 'OWNER',
          createdAt: '2026-09-05T00:10:00Z',
          lastEditedAt: '2026-09-05T02:00:00Z',
          fullDatabaseId: '10',
          body: 'CI is green.',
        },
        APPROVED,
      ],
    });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(28);
    expect(result.stdout).toContain(
      `review_notes_missing: whether a substitute receipt asked for changes is unknown: ${LOGIN} posted a comment at 2026-09-05T00:10:00Z and edited it at 2026-09-05T02:00:00Z`,
    );
  });

  it('audit does not count a changes receipt posted after the merge', () => {
    const root = tempRoot();
    auditFixture(root, {
      labels: ['risk:high'],
      comments: [APPROVED, receiptComment(OLD_HEAD, 'changes', '2026-09-05T02:00:00Z')],
    });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('audit=pass');
  });

  it('audit reports an error, never a pass, when the receipts cannot be read for the rule', () => {
    const root = tempRoot();
    auditFixture(root, { labels: ['risk:high'], comments: [CHANGES_EARLIER, APPROVED] });
    fs.writeFileSync(path.join(root, 'comments-fail-2'), '');

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not read receipts');
    expect(result.stdout).not.toContain('audit=pass');
  });
});

describe('codex-review exact verdicts: a wrong pr-body.jq never passes a check open', () => {
  // A copy of the skill to run, with its pr-body.jq rewritten by `edit`.
  function skillWithPrBody(root: string, edit: (module: string) => string): string {
    const skill = path.join(root, 'skill');
    fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
    for (const name of fs.readdirSync(path.dirname(HELPER)))
      fs.copyFileSync(path.join(path.dirname(HELPER), name), path.join(skill, 'scripts', name));
    const module = path.join(skill, 'scripts', 'pr-body.jq');
    fs.writeFileSync(module, edit(fs.readFileSync(module, 'utf8')));
    return path.join(skill, 'scripts', 'codex-review.sh');
  }

  // Valid jq, wrong answer: the whole module replaced by one that yields no body,
  // or two. Before exact verdicts, either left fix_link empty or doubled, which
  // is not `missing`, so a fix PR with no Fixes-PR line merged and audited clean.
  const WRONG_MODULES: [string, () => string][] = [
    ['yields no body', () => 'def pr_body_text: empty;\n'],
    ['yields two bodies', () => 'def pr_body_text: (.body // ""), (.body // "");\n'],
  ];

  it.each(WRONG_MODULES)(
    'merge-check exits 1, never allowed, on a pr-body.jq that %s (mutation: the site tests only = missing)',
    (_case, stub) => {
      const root = tempRoot();
      scopeFixture(root, { labels: [], title: 'fix: a fix with no Fixes-PR line' });

      const result = runHelper(root, ['merge-check', '--head', HEAD], {}, skillWithPrBody(root, stub));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('the Fixes-PR check gave no verdict');
      expect(result.stdout).not.toContain('merge=allowed');
    },
  );

  it.each(WRONG_MODULES)(
    'audit exits 1, never passes, on a pr-body.jq that %s (mutation: the site tests only = missing)',
    (_case, stub) => {
      const root = tempRoot();
      auditFixture(root, { labels: [], title: 'fix: a fix with no Fixes-PR line', body: 'Why.' });

      const result = runHelper(root, ['audit'], {}, skillWithPrBody(root, stub));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('the Fixes-PR check gave no verdict');
      expect(result.stdout).not.toContain('audit=pass');
    },
  );

  it("fails loudly through pr-body.jq's own check when a refactor inside it yields two bodies", () => {
    const root = tempRoot();
    // With the real module this head merges: its body says Fixes-PR: none.
    scopeFixture(root, { labels: [], title: 'fix: a fix', body: 'Fixes-PR: none' });
    const script = skillWithPrBody(root, (module) => {
      const edited = module.replace('[ .body // "" | unfenced', '[ (.body // ""), (.body // "") | unfenced');
      if (edited === module) throw new Error('pr-body.jq no longer holds the expression this test edits');
      return edited;
    });

    const result = runHelper(root, ['merge-check', '--head', HEAD], {}, script);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pr_body_text must yield exactly one string, got 2');
    expect(result.stdout).not.toContain('merge=allowed');
  });

  // #707 P3-a: pr_body_text's own one-string check lives inside pr-body.jq, so
  // a module that replaces the whole def replaces the check too. On a feat PR
  // (fix_link_state's title test is false) with no changes receipt
  // (review_notes_state never even calls pr_body_text), the old callers never
  // evaluated $body at all — `and`'s short circuit meant a wrong-typed single
  // value never surfaced as an error. Both callers now assert the shape
  // themselves before ever branching on the title or the changes state.
  const WRONG_TYPE_MODULES: [string, () => string][] = [
    ['yields an object', () => 'def pr_body_text: {};\n'],
    ['yields a number', () => 'def pr_body_text: 5;\n'],
    ['yields null', () => 'def pr_body_text: null;\n'],
  ];

  it.each(WRONG_TYPE_MODULES)(
    'merge-check exits 1, never allowed, on a pr-body.jq that %s, on a feat PR with no changes receipt',
    (_case, stub) => {
      const root = tempRoot();
      scopeFixture(root, { labels: [], title: 'feat: a new feature' });

      const result = runHelper(root, ['merge-check', '--head', HEAD], {}, skillWithPrBody(root, stub));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('pr_body_text (pr-body.jq) must yield exactly one string');
      expect(result.stdout).not.toContain('merge=allowed');
    },
  );

  it.each(WRONG_TYPE_MODULES)(
    'audit exits 1, never passes, on a pr-body.jq that %s, on a feat PR with no changes receipt',
    (_case, stub) => {
      const root = tempRoot();
      auditFixture(root, { labels: [], title: 'feat: a new feature', body: 'Why.' });

      const result = runHelper(root, ['audit'], {}, skillWithPrBody(root, stub));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('pr_body_text (pr-body.jq) must yield exactly one string');
      expect(result.stdout).not.toContain('audit=pass');
    },
  );
});

describe('codex-review review-notes rule: the same-second edit boundary', () => {
  const APPROVED = receiptComment(HEAD, 'approve', '2026-09-05T00:20:00Z');
  const LOGIN = (APPROVED.author as { login: string }).login;

  // GitHub's timestamps are to the second, so an edit stamped with the merge's
  // own second may have landed after it: the comment's text at the merge is
  // unknown, and it could have been a changes receipt.
  it("audit reads a trusted comment edited in the merge's own second as a possible changes receipt (mutation: >= loosened to >)", () => {
    const root = tempRoot();
    auditFixture(root, {
      labels: ['risk:high'],
      comments: [
        {
          author: { login: LOGIN },
          authorAssociation: 'OWNER',
          createdAt: '2026-09-05T00:10:00Z',
          lastEditedAt: MERGED_AT,
          fullDatabaseId: '10',
          body: 'CI is green.',
        },
        APPROVED,
      ],
    });

    const result = runHelper(root, ['audit']);
    expect(result.status).toBe(28);
    expect(result.stdout).toContain(
      `review_notes_missing: whether a substitute receipt asked for changes is unknown: ${LOGIN} posted a comment at 2026-09-05T00:10:00Z and edited it at ${MERGED_AT}`,
    );
  });
});

// Host CI (run-host-ci.sh posts `CI (host)`) standing in for an Actions workflow
// GitHub never started. The never-started shape is the 2026-09-18 billing
// lockout's, read live from run 35388540873's jobs: completed `failure`,
// runner_id 0, runner_name "", no steps. A job that ran has a runner and steps.
describe('codex-review host CI: a CI (host) success stands in only for a workflow GitHub never started', () => {
  const HOST = 'CI (host)';

  // `runId` is the Actions run this job belongs to; required_status_red reads
  // it back off the job to ask whether that whole RUN is excusable (#937 C).
  function actionsJob(started: boolean, conclusion = 'failure', runId?: number): Page {
    const base = { id: 105741202176, status: 'completed', conclusion, ...(runId === undefined ? {} : { run_id: runId }) };
    return started
      ? {
          ...base,
          runner_id: 1000006727,
          runner_name: 'GitHub Actions 1000006727',
          steps: [{ name: 'Typecheck host', status: 'completed', conclusion }],
        }
      : { ...base, runner_id: 0, runner_name: '', steps: [] };
  }

  // A failed run on HEAD whose one job did (or did not) start.
  function failedRun(root: string, started: boolean, name = 'CI', startedAt = '2026-09-05T00:01:00Z'): Page {
    const run = workflowRun(name, 'completed', 'failure', startedAt);
    writeJson(root, `jobs--${run.id as number}.json`, {
      total_count: 1,
      jobs: [actionsJob(started, 'failure', run.id as number)],
    });
    return run;
  }

  // A failed run that has been re-run IN PLACE: one run id, `attempts.length`
  // attempts, `attempts[i]` saying whether attempt i+1 started. GitHub serves
  // every attempt's jobs at /attempts/<n>/jobs (the gate reads them there,
  // pinned) and the newest one also at the plain /jobs route; `undefined`
  // writes no fixture for an attempt, so that read 404s. The run id lives in one place here — it has to agree with three
  // file names, and the fixtures that spelled it out each time were the reason
  // this helper exists.
  function rerunRun(root: string, attempts: (boolean | undefined)[], name = 'CI'): Page {
    const run = workflowRun(name, 'completed', 'failure');
    const runId = run.id as number;
    run.run_attempt = attempts.length;
    attempts.forEach((started, i) => {
      if (started === undefined) return;
      const newest = i === attempts.length - 1;
      const page = { total_count: 1, jobs: [actionsJob(started, 'failure', runId)] };
      writeJson(root, `jobs--${runId}--attempt-${i + 1}.json`, page);
      if (newest) writeJson(root, `jobs--${runId}.json`, page);
    });
    return run;
  }

  function mergeCheck(root: string, ci: (root: string) => Page[], statuses: Page[]) {
    scopeFixture(root, { labels: [], ci: ci(root), statuses });
    return runHelper(root, ['merge-check', '--head', HEAD]);
  }

  it('allows a head whose required CI never started when CI (host) succeeded on it, and says ci=host', () => {
    const root = tempRoot();
    const result = mergeCheck(root, (r) => [failedRun(r, false)], [commitStatus(HOST, 'success')]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`merge=allowed head=${HEAD} mode=risk-scoped verdict=skip ci=host`);
    expect(result.stderr).toContain(
      'ci_host: CI never started on Actions; the CI (host) success on this head stands in',
    );
  });

  it('refuses a head whose required CI never started when no CI (host) status is on it', () => {
    const root = tempRoot();
    const result = mergeCheck(root, (r) => [failedRun(r, false)], []);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain('ci_red: CI=not started (required;');
    expect(result.stderr).toContain('run run-host-ci.sh');
  });

  it('refuses a required CI run that started and failed, whatever CI (host) says', () => {
    const root = tempRoot();
    const result = mergeCheck(root, (r) => [failedRun(r, true)], [commitStatus(HOST, 'success')]);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain('ci_red: CI=failure (required)');
  });

  it('refuses when CI (host) itself failed, even over a CI run that never started', () => {
    const root = tempRoot();
    const result = mergeCheck(root, (r) => [failedRun(r, false)], [commitStatus(HOST, 'failure')]);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain('CI (host)=failure');
  });

  it('judges only the newest CI (host) status: a failure superseded by a success allows, a success superseded by a failure refuses', () => {
    const root = tempRoot();
    const older = '2026-09-05T00:02:00Z';
    const newer = '2026-09-05T00:03:00Z';
    const recovered = mergeCheck(root, (r) => [failedRun(r, false)], [
      commitStatus(HOST, 'failure', older),
      commitStatus(HOST, 'success', newer),
    ]);
    expect(recovered.status).toBe(0);
    const regressed = mergeCheck(root, (r) => [failedRun(r, false)], [
      commitStatus(HOST, 'success', older),
      commitStatus(HOST, 'failure', newer),
    ]);
    expect(regressed.status).toBe(24);
  });

  it('waits on a CI (host) run still pending rather than allowing', () => {
    const root = tempRoot();
    const result = mergeCheck(root, (r) => [failedRun(r, false)], [commitStatus(HOST, 'pending')]);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain('ci_pending: CI (host)=pending');
  });

  it('keeps a failed run red when its jobs cannot be read: not knowing it never started excuses nothing', () => {
    const root = tempRoot();
    const result = mergeCheck(root, () => [workflowRun('CI', 'completed', 'failure')], [commitStatus(HOST, 'success')]);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain('ci_red: CI=failure (required)');
  });

  it('does not take a CI (host) success on another head', () => {
    const root = tempRoot();
    scopeFixture(root, { labels: [], ci: [failedRun(root, false)], statuses: [] });
    writeJson(root, `statuses--${OLD_HEAD}.json`, [commitStatus(HOST, 'success')]);
    const result = runHelper(root, ['merge-check', '--head', HEAD]);
    expect(result.status).toBe(24);
    expect(result.stderr).toContain('CI=not started (required;');
  });

  it('leaves normal Actions CI unchanged: green is ci=green, with or without a CI (host) status', () => {
    const root = tempRoot();
    const plain = mergeCheck(root, () => [workflowRun('CI', 'completed', 'success')], []);
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain('verdict=skip ci=green');
    const alongside = mergeCheck(root, () => [workflowRun('CI', 'completed', 'success')], [
      commitStatus(HOST, 'success'),
    ]);
    expect(alongside.status).toBe(0);
    expect(alongside.stdout).toContain('verdict=skip ci=green');
  });

  it('leaves out a non-required workflow GitHub never started, as if it had not been triggered', () => {
    const root = tempRoot();
    const result = mergeCheck(
      root,
      (r) => [workflowRun('CI', 'completed', 'success'), failedRun(r, false, 'Label PR', '2026-09-05T00:01:30Z')],
      [],
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ci=green');
  });

  it('ci-wait reads a host-substituted head as green, and says ci=host', () => {
    const root = tempRoot();
    writeJson(root, 'pr.json', ciPr());
    const run = failedRun(root, false);
    writeJson(root, 'runs.json', { total_count: 2, workflow_runs: [labelRun('completed', 'success'), run] });
    writeJson(root, `statuses--${HEAD}.json`, [commitStatus(HOST, 'success')]);
    const result = ciWait(root, ['--head', HEAD], [0, 0]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`ci=host head=${HEAD}: ci_host:`);
  });

  it('audit counts a CI (host) success posted before the merge, and not one posted after it', () => {
    const root = tempRoot();
    auditFixture(root, {
      labels: [],
      ci: [failedRun(root, false)],
      statuses: [commitStatus(HOST, 'success', '2026-09-05T02:00:00Z')],
    });
    const late = runHelper(root, ['audit']);
    expect(late.status).toBe(28);
    expect(late.stdout).toContain('CI=not started (required;');

    auditFixture(root, { labels: [], ci: [failedRun(root, false)], statuses: [commitStatus(HOST, 'success')] });
    const before = runHelper(root, ['audit']);
    expect(before.status).toBe(0);
    expect(before.stdout).toContain('ci=host');
  });

  // A run is excused only when EVERY job never started: a run with one job
  // that ran is a run that started (#931, found by an any-for-all mutation).
  it('keeps a run red when one of its jobs started, though another never did', () => {
    const root = tempRoot();
    const result = mergeCheck(
      root,
      (r) => {
        const run = workflowRun('CI', 'completed', 'failure');
        writeJson(r, `jobs--${run.id as number}.json`, { total_count: 2, jobs: [actionsJob(false), actionsJob(true)] });
        return [run];
      },
      [commitStatus(HOST, 'success')],
    );
    expect(result.status).toBe(24);
    expect(result.stderr).toContain('ci_red: CI=failure (required)');
  });

  // Each conjunct of never_started on its own: no runner id, no runner name,
  // and no step. A job with any one of them ran.
  it.each<[string, Page]>([
    ['a runner id, but no runner name and no step', { runner_id: 5, runner_name: '', steps: [] }],
    ['a runner name, but no runner id and no step', { runner_id: 0, runner_name: 'GitHub Actions 5', steps: [] }],
    ['a step, but no runner', { runner_id: 0, runner_name: '', steps: [{ name: 'Set up job', status: 'completed' }] }],
  ])('counts a job with %s as started, so its failure stays red', (_case, shape) => {
    const root = tempRoot();
    const result = mergeCheck(
      root,
      (r) => {
        const run = workflowRun('CI', 'completed', 'failure');
        writeJson(r, `jobs--${run.id as number}.json`, {
          total_count: 1,
          jobs: [{ ...actionsJob(false), ...shape }],
        });
        return [run];
      },
      [commitStatus(HOST, 'success')],
    );
    expect(result.status).toBe(24);
    expect(result.stderr).toContain('ci_red: CI=failure (required)');
  });

  // A run with no jobs at all proves nothing, and neither does one whose jobs
  // never reached a `failure` — the lockout's shape is a job GitHub FAILED
  // without starting, and `run_never_started` asks for exactly that (#937 D,
  // the `any(.conclusion == "failure")` conjunct, which no fixture exercised
  // on its own because every one of them concluded `failure`).
  it.each<[string, Page[]]>([
    ['its jobs listing is empty', []],
    [
      'no job of it concluded failure, only cancelled',
      [{ id: 1, status: 'completed', conclusion: 'cancelled', runner_id: 0, runner_name: '', steps: [] }],
    ],
  ])('keeps a failed run red when %s', (_case, jobs) => {
    const root = tempRoot();
    const result = mergeCheck(
      root,
      (r) => {
        const run = workflowRun('CI', 'completed', 'failure');
        writeJson(r, `jobs--${run.id as number}.json`, { total_count: jobs.length, jobs });
        return [run];
      },
      [commitStatus(HOST, 'success')],
    );
    expect(result.status).toBe(24);
    expect(result.stderr).toContain('ci_red: CI=failure (required)');
  });

  // #937 C: a never-started run must not HIDE a genuine red of the same
  // required workflow on the same head. Two shapes produce that, and both are
  // invisible to ci_verdict's own view, which keeps only the newest run per
  // workflow name and reads only the newest attempt of it.
  describe('a never-started run never excuses a genuine red of the same workflow', () => {
    it('refuses when an older run of the same workflow really failed', () => {
      const root = tempRoot();
      const result = mergeCheck(
        root,
        (r) => {
          // Newest first in the fixture, so the order of the listing is not
          // what is doing the work: ci_verdict keeps the newest by start time.
          const genuine = failedRun(r, true, 'CI', '2026-09-05T00:01:00Z');
          const rerun = failedRun(r, false, 'CI', '2026-09-05T00:05:00Z');
          return [genuine, rerun];
        },
        [commitStatus(HOST, 'success')],
      );
      expect(result.status).toBe(24);
      expect(result.stderr).toContain('ci_red: CI=failure (required)');
    });

    // ci_verdict's standard for a required workflow is `conclusion !=
    // "success"`, not just `failure`. A genuinely-executed older run that
    // ended any other way is red there, so it has to disqualify a newer
    // never-started run of the same name — otherwise the gate answers
    // `ci=host` over a real red. These cost no jobs read: the conclusion
    // alone settles it.
    it.each<[string, string | null]>([
      ['timed_out', 'timed_out'],
      ['cancelled', 'cancelled'],
      ['startup_failure', 'startup_failure'],
      ['neutral', 'neutral'],
      ['skipped', 'skipped'],
      ['action_required', 'action_required'],
      ['completed with no conclusion at all', null],
    ])('refuses when an older run of the same workflow ended %s', (_case, conclusion) => {
      const root = tempRoot();
      const result = mergeCheck(
        root,
        (r) => [
          workflowRun('CI', 'completed', conclusion, '2026-09-05T00:01:00Z'),
          failedRun(r, false, 'CI', '2026-09-05T00:05:00Z'),
        ],
        [commitStatus(HOST, 'success')],
      );
      expect(result.status).toBe(24);
      expect(result.stderr).toContain('ci_red: CI=failure (required)');
    });

    it('still allows when the older run of the same workflow SUCCEEDED', () => {
      const root = tempRoot();
      const result = mergeCheck(
        root,
        (r) => [
          workflowRun('CI', 'completed', 'success', '2026-09-05T00:01:00Z'),
          failedRun(r, false, 'CI', '2026-09-05T00:05:00Z'),
        ],
        [commitStatus(HOST, 'success')],
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('ci=host');
    });

    // …and the stricter standard is REQUIRED-ONLY, because ci_verdict scores
    // a non-required workflow with `neutral`/`skipped` as green. `cancelled`
    // is not green there, so it still disqualifies — it is the routine output
    // of `concurrency: cancel-in-progress`, and a non-required workflow whose
    // older run was cancelled is red on its own account anyway.
    it.each<[string, number]>([
      ['skipped', 0],
      ['neutral', 0],
      ['cancelled', 24],
    ])('scores a NON-required workflow whose older run was %s the way ci_verdict does', (conclusion, status) => {
      const root = tempRoot();
      const result = mergeCheck(
        root,
        (r) => [
          workflowRun('CI', 'completed', 'success'),
          workflowRun('Docs', 'completed', conclusion, '2026-09-05T00:01:30Z'),
          failedRun(r, false, 'Docs', '2026-09-05T00:05:00Z'),
        ],
        [commitStatus(HOST, 'success')],
      );
      expect(result.status).toBe(status);
      if (status === 0) {
        // The never-started Docs run keeps its excuse, and because Docs is not
        // required, an excused run is simply left out — the head is plain green.
        expect(result.stdout).toContain('ci=green');
      } else {
        expect(result.stderr).toContain('Docs=failure');
      }
    });

    it('refuses when an earlier ATTEMPT of the same run really failed', () => {
      const root = tempRoot();
      const result = mergeCheck(root, (r) => [rerunRun(r, [true, false])], [commitStatus(HOST, 'success')]);
      expect(result.status).toBe(24);
      expect(result.stderr).toContain('ci_red: CI=failure (required)');
    });

    it('refuses when an earlier attempt cannot be read at all', () => {
      const root = tempRoot();
      const result = mergeCheck(root, (r) => [rerunRun(r, [undefined, false])], [commitStatus(HOST, 'success')]);
      expect(result.status).toBe(24);
      expect(result.stderr).toContain('ci_red: CI=failure (required)');
    });

    it('still allows when every attempt of the run never started', () => {
      const root = tempRoot();
      const result = mergeCheck(root, (r) => [rerunRun(r, [false, false])], [commitStatus(HOST, 'success')]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('ci=host');
    });

    it('disqualifies only the workflow that really failed, not another that never started', () => {
      const root = tempRoot();
      scopeFixture(root, {
        labels: [],
        ci: [
          failedRun(root, true, 'Lint', '2026-09-05T00:01:00Z'),
          failedRun(root, false, 'CI', '2026-09-05T00:02:00Z'),
        ],
        statuses: [commitStatus(HOST, 'success')],
      });
      const result = runHelper(root, ['merge-check', '--head', HEAD], {
        CODEX_REVIEW_REQUIRED_WORKFLOWS: 'CI,Lint',
      });
      expect(result.status).toBe(24);
      // Lint really failed, so it is red…
      expect(result.stderr).toContain('ci_red: Lint=failure (required)');
      // …and it did not disqualify CI, which host CI still covers.
      expect(result.stderr).not.toContain('CI=failure');
      expect(result.stderr).not.toContain('CI=not started');
    });
  });

  // Who posted the CI (host) status (#931): a commit status is writable by any
  // token with statuses:write, so only an allowed poster's stands in.
  describe('who may post CI (host)', () => {
    function mergeCheckAs(root: string, statuses: Page[], env: Record<string, string>) {
      scopeFixture(root, { labels: [], ci: [failedRun(root, false)], statuses });
      return runHelper(root, ['merge-check', '--head', HEAD], env);
    }

    it('refuses a CI (host) success from an account that is not an allowed poster', () => {
      const root = tempRoot();
      const result = mergeCheckAs(root, [commitStatus(HOST, 'success', undefined, 'someone-else')], {});
      expect(result.status).toBe(24);
      expect(result.stderr).toContain('CI=not started (required;');
      expect(result.stderr).toContain('no CI (host) success from fleet-bot is on this head');
    });

    it("does not let a newer success from someone else hide an allowed poster's failure", () => {
      const root = tempRoot();
      const result = mergeCheckAs(
        root,
        [
          commitStatus(HOST, 'failure', '2026-09-05T00:02:00Z'),
          commitStatus(HOST, 'success', '2026-09-05T00:03:00Z', 'someone-else'),
        ],
        {},
      );
      expect(result.status).toBe(24);
      expect(result.stderr).toContain('CI=not started (required;');
    });

    it('compares logins case-insensitively, as GitHub does', () => {
      const root = tempRoot();
      const result = mergeCheckAs(root, [commitStatus(HOST, 'success', undefined, 'Fleet-Bot')], {
        CODEX_REVIEW_HOST_CI_POSTERS: 'FLEET-bot',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('ci=host');
    });

    it('takes the allowlist from CODEX_REVIEW_HOST_CI_POSTERS, comma-separated', () => {
      const root = tempRoot();
      const result = mergeCheckAs(root, [commitStatus(HOST, 'success', undefined, 'second')], {
        CODEX_REVIEW_HOST_CI_POSTERS: 'first, second',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('ci=host');
      expect(result.calls).not.toContain('api user');
    });

    it('defaults to the account the gate itself runs as', () => {
      const root = tempRoot();
      const same = mergeCheckAs(root, [commitStatus(HOST, 'success', undefined, 'gate-account')], {
        CODEX_REVIEW_HOST_CI_POSTERS: '',
        MOCK_GH_USER: 'gate-account',
      });
      expect(same.status).toBe(0);
      expect(same.stdout).toContain('ci=host');
      expect(same.calls).toContain('api user');
      const other = mergeCheckAs(root, [commitStatus(HOST, 'success', undefined, 'gate-account')], {
        CODEX_REVIEW_HOST_CI_POSTERS: '',
        MOCK_GH_USER: 'another-account',
      });
      expect(other.status).toBe(24);
    });

    it('allows no one when nothing is configured and the identity cannot be read', () => {
      const root = tempRoot();
      const result = mergeCheckAs(root, [commitStatus(HOST, 'success')], { CODEX_REVIEW_HOST_CI_POSTERS: '' });
      expect(result.status).toBe(24);
      expect(result.stderr).toContain('set CODEX_REVIEW_HOST_CI_POSTERS');
    });

    it('never reads the identity for a head with nothing to excuse', () => {
      const root = tempRoot();
      const result = mergeCheck(root, () => [workflowRun('CI', 'completed', 'success')], [
        commitStatus(HOST, 'success'),
      ]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('ci=green');
      expect(result.calls).not.toContain('api user');
    });
  });

  describe('legacy repos: a required check run GitHub never started', () => {
    const JOB = 105741202176;
    const RUN = 4242;
    const neverRun = (): Page => ({ ...rollupRun('CI Gate', 'COMPLETED', 'FAILURE'), databaseId: JOB });

    // The rollup's check run and the Actions run it belongs to. Both are read:
    // the check run's own job says whether IT started, and the run listing says
    // whether any other run or attempt of `CI Gate` on this head has a genuine
    // red the rollup no longer shows (#937 C). `runJobs` overrides what the
    // run's newest attempt looks like; by default it matches `started`.
    function legacy(
      root: string,
      rollup: Page[],
      started: boolean | null,
      opts: { runJobs?: Page[]; run?: Page; extraCi?: Page[] } = {},
    ): void {
      const run = { ...workflowRun('CI Gate', 'completed', 'failure'), id: RUN, ...(opts.run ?? {}) };
      scopeFixture(root, { baseConfig: null, labels: [], rollup, ci: [run, ...(opts.extraCi ?? [])] });
      writeJson(root, `jobs--${RUN}.json`, {
        total_count: 1,
        jobs: opts.runJobs ?? [actionsJob(started ?? false, 'failure', RUN)],
      });
      fs.rmSync(path.join(root, `job--${JOB}.json`), { force: true });
      if (started !== null) writeJson(root, `job--${JOB}.json`, actionsJob(started, 'failure', RUN));
    }

    it('defers with ci=host when CI (host) succeeded on the head', () => {
      const root = tempRoot();
      legacy(root, [neverRun(), rollupStatus(HOST, 'SUCCESS', false)], false);
      const result = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(result.status).toBe(26);
      expect(result.stdout).toContain('merge=defer mode=legacy ci=host admin=');
      expect(result.stderr).toContain('required CI Gate never started on Actions');
    });

    // admin=ready is the only verdict that licenses `gh pr merge --admin`:
    // the bypass lifts every hold, so every rule but the never-started check
    // must already be met. XZO's shape: required CI Gate, Release policy and
    // Release approval, and review threads that must be resolved.
    describe('admin readiness (the --admin bypass)', () => {
      const RULES = [
        { type: 'deletion', parameters: null },
        { type: 'non_fast_forward', parameters: null },
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 0,
            required_review_thread_resolution: true,
            require_extra_approval_for_unattributed_changes: true,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_reviewers: [],
          },
        },
        {
          type: 'required_status_checks',
          parameters: {
            required_status_checks: [
              { context: 'CI Gate' },
              { context: 'Release policy' },
              { context: 'Release approval' },
            ],
          },
        },
      ];
      type Pr = {
        threads?: boolean[];
        approvals?: string[];
        changesRequested?: string[];
        unattributed?: boolean;
        head?: string;
        // GitHub's own computed review state. `null` — the default, and what a
        // repo whose rules require no review reports — is what the existing
        // ready-path fixtures need.
        reviewDecision?: string | null;
      };
      function prPage(pr: Pr = {}): Page {
        const reviews = [
          ...(pr.approvals ?? []).map((login) => ({ state: 'APPROVED', author: { login } })),
          ...(pr.changesRequested ?? []).map((login) => ({ state: 'CHANGES_REQUESTED', author: { login } })),
        ];
        return {
          data: {
            repository: {
              pullRequest: {
                headRefOid: pr.head ?? HEAD,
                author: { login: 'author' },
                reviewDecision: pr.reviewDecision ?? null,
                reviewThreads: {
                  totalCount: (pr.threads ?? []).length,
                  nodes: (pr.threads ?? []).map((isResolved) => ({ isResolved })),
                },
                latestOpinionatedReviews: { totalCount: reviews.length, nodes: reviews },
                commits: {
                  totalCount: 1,
                  nodes: [{ commit: { author: { user: pr.unattributed ? null : { login: 'author' } } } }],
                },
              },
            },
          },
        };
      }
      const GREEN = [rollupStatus('Release policy', 'SUCCESS'), rollupStatus('Release approval', 'SUCCESS')];
      function admin(root: string, rollup: Page[], pr: Pr = {}, rules: Page[] | null = RULES) {
        legacy(root, [neverRun(), rollupStatus(HOST, 'SUCCESS', false), ...rollup], false);
        fs.rmSync(path.join(root, 'rules--main.json'), { force: true });
        if (rules !== null) writeJson(root, 'rules--main.json', rules);
        writeJson(root, 'adminReadiness-1.json', prPage(pr));
        return runHelper(root, ['merge-check', '--head', HEAD]);
      }

      it('is ready when the only non-green required check is the never-started one host CI covers', () => {
        const result = admin(tempRoot(), GREEN);
        expect(result.status).toBe(26);
        expect(result.stdout).toContain('merge=defer mode=legacy ci=host admin=ready:');
      });

      it.each<[string, Page[], Pr, string]>([
        [
          'Release approval pending',
          [rollupStatus('Release policy', 'SUCCESS'), rollupStatus('Release approval', 'PENDING')],
          {},
          'Release approval=pending',
        ],
        [
          'Release approval not yet posted',
          [rollupStatus('Release policy', 'SUCCESS')],
          {},
          'Release approval=not reported',
        ],
        ['an unresolved review thread', GREEN, { threads: [true, false] }, '1 unresolved review thread(s)'],
        [
          'an unattributed commit, which owes an extra approving review',
          GREEN,
          { unattributed: true },
          'an extra approving review is required because 1 commit(s) have no GitHub-attributed author',
        ],
        [
          'GitHub still requiring review',
          GREEN,
          { reviewDecision: 'REVIEW_REQUIRED' },
          'GitHub reports reviewDecision=REVIEW_REQUIRED',
        ],
        [
          'GitHub reporting changes requested',
          GREEN,
          { reviewDecision: 'CHANGES_REQUESTED' },
          'GitHub reports reviewDecision=CHANGES_REQUESTED',
        ],
        [
          'a review decision GitHub added after this was written',
          GREEN,
          { reviewDecision: 'SOMETHING_NEW' },
          'GitHub reports reviewDecision=SOMETHING_NEW',
        ],
        [
          'changes requested by a reviewer',
          GREEN,
          { changesRequested: ['reviewer'] },
          'changes requested by reviewer',
        ],
        [
          'another required check still running',
          [...GREEN, rollupRun('Lint', 'IN_PROGRESS', null)],
          {},
          'Lint=in_progress/none',
        ],
      ])('is not ready with %s', (_case, rollup, pr, why) => {
        const result = admin(tempRoot(), rollup, pr);
        expect(result.status).toBe(26);
        expect(result.stdout).toContain('merge=defer mode=legacy ci=host admin=not-ready:');
        expect(result.stdout).toContain(why);
        expect(result.stdout).not.toContain('admin=ready');
      });

      it('never gets as far as admin readiness when another required status is red', () => {
        const result = admin(tempRoot(), [
          rollupStatus('Release policy', 'FAILURE'),
          rollupStatus('Release approval', 'SUCCESS'),
        ]);
        expect(result.status).toBe(24);
        expect(result.stderr).toContain('required_red: Release policy=failure');
        expect(result.stdout).not.toContain('admin=');
      });

      // #937 B3. `reviewDecision` is GitHub's own answer to "is the review
      // requirement met", so it is asked rather than recomputed — but it is
      // NOT a substitute for reading the base rules. Measured: XZO ruleset
      // 21204871 is active on the default branch with
      // require_extra_approval_for_unattributed_changes: true, and XZO PR
      // #1965 (open, on that branch, 3 unattributed commits) reports
      // reviewDecision: null. So reviewDecision does not surface that rule's
      // review parameters, and the sibling parameter in the same rule object
      // cannot be assumed to fare better. Both authorities, both fail-closed.
      const withApprovalCount = (count: number): Page[] =>
        RULES.map((rule) =>
          rule.type === 'pull_request'
            ? { ...rule, parameters: { ...(rule.parameters as Page), required_approving_review_count: count } }
            : rule,
        );

      it('refuses a required_approving_review_count even when reviewDecision says APPROVED', () => {
        const result = admin(tempRoot(), GREEN, { reviewDecision: 'APPROVED' }, withApprovalCount(2));
        expect(result.stdout).toContain('admin=not-ready');
        expect(result.stdout).toContain('the base rules require 2 approving review(s)');
      });

      // The fail-open shape this guards: a rulesets-only repo with a non-zero
      // count, no approvals, and reviewDecision null as it is on XZO.
      it('refuses a required_approving_review_count when reviewDecision says nothing at all', () => {
        const result = admin(tempRoot(), GREEN, {}, withApprovalCount(2));
        expect(result.stdout).toContain('admin=not-ready');
        expect(result.stdout).toContain('the base rules require 2 approving review(s)');
      });

      it('does no counting of its own: approvals neither create nor satisfy a requirement', () => {
        // Approvals with the count at 0 (the fleet's actual shape) stay ready…
        expect(admin(tempRoot(), GREEN, { approvals: ['reviewer'] }).stdout).toContain('admin=ready');
        // …and approvals never satisfy a positive count.
        expect(
          admin(tempRoot(), GREEN, { approvals: ['a', 'b', 'c'] }, withApprovalCount(1)).stdout,
        ).toContain('admin=not-ready');
      });

      it('still refuses the extra approval an unattributed commit owes, whatever reviewDecision says', () => {
        const result = admin(tempRoot(), GREEN, { unattributed: true, reviewDecision: 'APPROVED' });
        expect(result.stdout).toContain('admin=not-ready');
        expect(result.stdout).toContain('an extra approving review is required because 1 commit(s)');
      });

      // #937 B1. A CHANGES_REQUESTED review is a hold --admin lifts, and the
      // author's own state is never one (GitHub does not let you request
      // changes on your own PR), so only a non-author's counts.
      it('is not ready on changes requested by anyone but the author, naming them', () => {
        const result = admin(tempRoot(), GREEN, { changesRequested: ['reviewer', 'other'] });
        expect(result.stdout).toContain('admin=not-ready');
        expect(result.stdout).toMatch(/changes requested by (other, reviewer|reviewer, other)/);
      });

      it('ignores a CHANGES_REQUESTED review whose author is the PR author', () => {
        expect(admin(tempRoot(), GREEN, { changesRequested: ['author'] }).stdout).toContain('admin=ready');
      });

      // #937 B2. `strict_required_status_checks_policy` is GitHub's "require
      // branches to be up to date before merging" — a fact about the base
      // having moved, which nothing here evaluates.
      it('is not ready when the base requires the branch to be up to date', () => {
        const rules = RULES.map((rule) =>
          rule.type === 'required_status_checks'
            ? {
                ...rule,
                parameters: { ...(rule.parameters as Page), strict_required_status_checks_policy: true },
              }
            : rule,
        );
        const result = admin(tempRoot(), GREEN, {}, rules);
        expect(result.stdout).toContain('admin=not-ready');
        expect(result.stdout).toContain('the base requires the branch to be up to date');
      });

      it('is ready when strict_required_status_checks_policy is explicitly false', () => {
        const rules = RULES.map((rule) =>
          rule.type === 'required_status_checks'
            ? {
                ...rule,
                parameters: { ...(rule.parameters as Page), strict_required_status_checks_policy: false },
              }
            : rule,
        );
        expect(admin(tempRoot(), GREEN, {}, rules).stdout).toContain('admin=ready');
      });

      it.each<[string, Page[] | null, boolean, string]>([
        ['the rules cannot be read', null, false, 'could not read the rules'],
        [
          'a rule type it does not model',
          [...RULES, { type: 'update', parameters: null }],
          false,
          'rules this does not evaluate: update',
        ],
        ['classic branch protection', RULES, true, 'classic branch protection'],
      ])('is not ready when %s', (_case, rules, classic, why) => {
        const root = tempRoot();
        if (classic) writeJson(root, 'protection.json', { url: 'x' });
        const result = admin(root, GREEN, {}, rules);
        expect(result.stdout).toContain('admin=not-ready');
        expect(result.stdout).toContain(why);
      });
    });

    it.each<[string, Page[], boolean | null]>([
      ['no CI (host) status', [], false],
      ['a CI (host) failure', [rollupStatus(HOST, 'FAILURE', false)], false],
      ['a job that started and failed', [rollupStatus(HOST, 'SUCCESS', false)], true],
      ['a job that cannot be read', [rollupStatus(HOST, 'SUCCESS', false)], null],
      [
        'a CI (host) success from an account that is not an allowed poster',
        [rollupStatus(HOST, 'SUCCESS', false, 'someone-else')],
        false,
      ],
    ])('refuses required_red with %s', (_case, extra, started) => {
      const root = tempRoot();
      legacy(root, [neverRun(), ...extra], started);
      const result = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(result.status).toBe(24);
      expect(result.stderr).toContain('required_red: CI Gate=failure');
    });

    // #937 C on the rollup side. The rollup carries only the NEWEST check run
    // per name, so a genuine red of the same required check earlier on this
    // head is invisible to it; required_status_red must go to the Actions runs
    // for the head to see it, and refuse.
    describe('a never-started check run never excuses a genuine red of the same workflow', () => {
      const HOST_OK = [rollupStatus(HOST, 'SUCCESS', false)];

      it('refuses when the run behind the check run really failed, whatever the one job says', () => {
        const root = tempRoot();
        // The job the rollup points at never started, but a SECOND job of the
        // same run did and failed — the run is not excusable.
        legacy(root, [neverRun(), ...HOST_OK], false, {
          runJobs: [actionsJob(false, 'failure', 4242), actionsJob(true, 'failure', 4242)],
        });
        const result = runHelper(root, ['merge-check', '--head', HEAD]);
        expect(result.status).toBe(24);
        expect(result.stderr).toContain('required_red: CI Gate=failure');
      });

      it('refuses when an earlier ATTEMPT of that run really failed', () => {
        const root = tempRoot();
        legacy(root, [neverRun(), ...HOST_OK], false, { run: { run_attempt: 2 } });
        writeJson(root, 'jobs--4242--attempt-1.json', {
          total_count: 1,
          jobs: [actionsJob(true, 'failure', 4242)],
        });
        const result = runHelper(root, ['merge-check', '--head', HEAD]);
        expect(result.status).toBe(24);
        expect(result.stderr).toContain('required_red: CI Gate=failure');
      });

      it('refuses when an older run of the same workflow really failed', () => {
        const root = tempRoot();
        const older = { ...workflowRun('CI Gate', 'completed', 'failure', '2026-09-04T00:01:00Z'), id: 4141 };
        legacy(root, [neverRun(), ...HOST_OK], false, { extraCi: [older] });
        writeJson(root, 'jobs--4141.json', { total_count: 1, jobs: [actionsJob(true, 'failure', 4141)] });
        const result = runHelper(root, ['merge-check', '--head', HEAD]);
        expect(result.status).toBe(24);
        expect(result.stderr).toContain('required_red: CI Gate=failure');
      });

      it('refuses when the job read carries no run_id to vouch for', () => {
        const root = tempRoot();
        legacy(root, [neverRun(), ...HOST_OK], false);
        // A job as GitHub returns it, minus run_id: nothing ties it to a run
        // this head has, so it cannot be excused.
        writeJson(root, `job--${JOB}.json`, actionsJob(false));
        const result = runHelper(root, ['merge-check', '--head', HEAD]);
        expect(result.status).toBe(24);
        expect(result.stderr).toContain('required_red: CI Gate=failure');
      });

      it('refuses when the head has no Actions run behind the check run at all', () => {
        const root = tempRoot();
        legacy(root, [neverRun(), ...HOST_OK], false, { run: { head_sha: OLD_HEAD } });
        const result = runHelper(root, ['merge-check', '--head', HEAD]);
        expect(result.status).toBe(24);
        expect(result.stderr).toContain('required_red: CI Gate=failure');
      });
    });

    // #937 D. On this side every fixture flipped both never_started conjuncts
    // together (`actionsJob(started)`), so a mutation that dropped either one
    // on its own went unseen.
    it.each<[string, Page]>([
      ['a runner id, but no runner name and no step', { runner_id: 5, runner_name: '', steps: [] }],
      ['a runner name, but no runner id and no step', { runner_id: 0, runner_name: 'GitHub Actions 5', steps: [] }],
      ['a step, but no runner', { runner_id: 0, runner_name: '', steps: [{ name: 'Set up job', status: 'completed' }] }],
    ])('refuses required_red for a check-run job with %s', (_case, shape) => {
      const root = tempRoot();
      const job = { ...actionsJob(false, 'failure', 4242), ...shape };
      legacy(root, [neverRun(), rollupStatus(HOST, 'SUCCESS', false)], false, { runJobs: [job] });
      writeJson(root, `job--${JOB}.json`, job);
      const result = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(result.status).toBe(24);
      expect(result.stderr).toContain('required_red: CI Gate=failure');
    });

    // #937 D. Every CI (host) fixture used the lower-case login
    // `fleet-bot`, so the `ascii_downcase` both sides of the poster compare
    // depend on was never exercised here. GitHub logins are case-insensitive.
    it('takes a CI (host) success whose creator login differs only in case', () => {
      const root = tempRoot();
      legacy(root, [neverRun(), rollupStatus(HOST, 'SUCCESS', false, 'Fleet-Bot')], false);
      const result = runHelper(root, ['merge-check', '--head', HEAD], {
        CODEX_REVIEW_HOST_CI_POSTERS: 'Fleet-BOT',
      });
      expect(result.status).toBe(26);
      expect(result.stdout).toContain('merge=defer mode=legacy ci=host');
    });

    // #937 D. One required context can be reported twice, as a check run AND
    // as a commit status. The never-started excuse covers the check run only —
    // a red status of the same name is still red.
    it('refuses when the excused check run shares its name with a red status context', () => {
      const root = tempRoot();
      legacy(root, [neverRun(), rollupStatus('CI Gate', 'FAILURE'), rollupStatus(HOST, 'SUCCESS', false)], false);
      const result = runHelper(root, ['merge-check', '--head', HEAD]);
      expect(result.status).toBe(24);
      expect(result.stderr).toContain('required_red: CI Gate=failure');
    });
  });
});
