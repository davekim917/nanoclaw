#!/usr/bin/env bash
# Run a repository's declared CI on this machine against a PR's exact head, and
# post the answer as the commit status `CI (host)` on that head.
#
#   run-host-ci.sh [--pr <n>] [--head <sha>] [--repo <owner/name>] [--dry-run]
#
# Exit codes: 0 the declared CI passed and `success` was posted; 1 it failed (or
# the status could not be posted, or the PR was refused) and `failure` was
# posted where possible; 2 usage, or a declaration naming a context it may not
# stand in for; 3 the repository declares no host CI at that head (nothing
# posted); 12 the PR head is not --head.
#
# --dry-run runs everything the same way and reports what it would post, but
# posts nothing (no status, no comment) and also accepts a PR that is already
# merged or closed, so a declaration can be timed against history.
#
# What merge-check does with it (codex-review.sh, ci_verdict and
# legacy_precheck): a `CI (host)` success on the exact head stands in for a
# required Actions workflow ONLY when GitHub never started that workflow's jobs
# (no runner assigned, no step run — the billing lockout's shape), and only
# when the status was posted by an allowed account (host_ci_posters there:
# CODEX_REVIEW_HOST_CI_POSTERS, else the account the gate itself runs as). A
# workflow that ran and failed stays red whatever this posts, and a `CI (host)`
# failure is a red status like any other.
#
# Stand-in contexts. A declaration may name, in its leading comment block, the
# status contexts its run is equivalent to:
#
#   # host-ci-context: CI Gate
#
# (one per line). Each is posted alongside `CI (host)`, with the same state,
# ONLY when every Actions job of that name on this head is one GitHub never
# started (never-started.jq, the predicate merge-check uses) — so it can
# satisfy a branch rule that requires that context by name, and it is never
# posted over a real Actions result or while Actions is healthy. Decided once,
# before the run: a stand-in that got `pending` is always resolved with the
# run's verdict. `CI (host)`, `Release policy` and `Release approval` cannot
# be named.
#
# The commands are the repository's, never this script's: `.github/host-ci.sh`
# at the PR head, run with bash from the checkout root. A repository without one
# is refused — declare host CI in that repository rather than have this guess.
# The declaration is read from the head for the same reason a `pull_request`
# workflow is: the PR's own CI definition is what CI runs. Because it runs the
# head's code with this machine's credentials, a PR whose head lives in another
# repository (a fork) is refused.
#
# It never touches a checkout you are working in: the head is fetched by its
# sha into a fresh scratch repository under $HOST_CI_SCRATCH (default $TMPDIR
# or /tmp), removed on exit however this ends. The declaration gets
# HOST_CI_REPO, HOST_CI_PR, HOST_CI_HEAD, HOST_CI_BASE_REF and HOST_CI_BASE_SHA.
# One run at a time (flock on $HOST_CI_LOCK), at idle IO and lowered CPU
# priority, so it cannot starve a production host. A declaration that runs
# vitest must take `flock "$HOST_CI_VITEST_LOCK"` and pass `--maxWorkers=2`.
#
# Locks and logs live in the shared directory, $HOST_CI_SHARED_DIR: by default
# /workspace/workgroup when it is a writable directory — the one mount every
# agent container of a workgroup shares with its siblings (src/container-
# runner.ts, the `workgroupSharedDir` bind at WORKGROUP_CONTAINER_PATH), which
# the host sees as data/workgroups/<workgroup> — else $TMPDIR or /tmp. So runs
# are serialized across one workgroup's containers, not across workgroups: no
# directory is writable from every container of the install. The full log is
# kept at $HOST_CI_LOG_DIR (default <shared>/host-ci-logs); a finished run
# posts a PR comment with its tail and points the status's target_url at it.
#
# Works on the host and inside an agent container alike: it needs git, gh (with
# a token that can read the repo, its Actions runs, and write commit statuses
# and PR comments), jq, flock, ionice, nice, tail, tee and timeout, and fetches
# over the same https remote gh authenticates.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_CI_CONTEXT='CI (host)'
DECLARATION='.github/host-ci.sh'
RESERVED_CONTEXTS=("$HOST_CI_CONTEXT" 'Release policy' 'Release approval')

usage() { echo "usage: run-host-ci.sh [--pr <n>] [--head <sha>] [--repo <owner/name>] [--dry-run]" >&2; exit 2; }

want="" pr="${PR:-}" repo="${REPO:-}" dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pr) [ $# -ge 2 ] && [[ "$2" =~ ^[1-9][0-9]*$ ]] || usage; pr="$2"; shift 2 ;;
    --head) [ $# -ge 2 ] && [[ "$2" =~ ^[0-9a-f]{40}$ ]] || { echo "run-host-ci: --head must be a full 40-character sha" >&2; exit 2; }; want="$2"; shift 2 ;;
    --repo) [ $# -ge 2 ] && [[ "$2" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || usage; repo="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage ;;
    *) echo "run-host-ci: unknown argument $1" >&2; usage ;;
  esac
done
timeout_s="${HOST_CI_TIMEOUT_SECONDS:-2400}"
[[ "$timeout_s" =~ ^[1-9][0-9]*$ ]] || { echo "run-host-ci: HOST_CI_TIMEOUT_SECONDS must be a positive whole number" >&2; exit 2; }

for tool in git gh jq flock ionice nice timeout mktemp tee tail; do
  command -v "$tool" >/dev/null || { echo "run-host-ci: $tool is not installed" >&2; exit 1; }
done

[ -n "$repo" ] || repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
[ -n "$pr" ] || pr=$(gh pr view --repo "$repo" --json number -q .number)
[[ "$pr" =~ ^[1-9][0-9]*$ ]] || { echo "run-host-ci: could not resolve the PR number" >&2; exit 1; }

pr_json=$(gh pr view "$pr" --repo "$repo" --json state,headRefOid,baseRefName,baseRefOid,isCrossRepository)
state=$(printf '%s' "$pr_json" | jq -er .state)
head=$(printf '%s' "$pr_json" | jq -er .headRefOid)
base_ref=$(printf '%s' "$pr_json" | jq -er .baseRefName)
base_sha=$(printf '%s' "$pr_json" | jq -er .baseRefOid)
cross=$(printf '%s' "$pr_json" | jq -r '.isCrossRepository | tostring')
[[ "$head" =~ ^[0-9a-f]{40}$ ]] || { echo "run-host-ci: PR #$pr reported head \"$head\"" >&2; exit 1; }
[[ "$base_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "run-host-ci: PR #$pr reported base \"$base_sha\"" >&2; exit 1; }
if [ "$cross" != false ]; then
  echo "run-host-ci: PR #$pr's head is in another repository (isCrossRepository=$cross). This runs the head's own code with this machine's credentials, so a fork's PR is refused." >&2
  exit 1
fi
if [ "$state" != OPEN ] && [ "$dry_run" = 0 ]; then
  echo "run-host-ci: PR #$pr is $state; there is no head to run CI on (--dry-run times a closed PR without posting)" >&2
  exit 1
fi
if [ -n "$want" ] && [ "$want" != "$head" ]; then
  echo "run-host-ci: PR #$pr's head is $head, not $want — capture the new head and run again" >&2
  exit 12
fi

if [ "${HOST_CI_SHARED_DIR+set}" = set ]; then
  shared_dir="$HOST_CI_SHARED_DIR"
elif [ -d /workspace/workgroup ] && [ -w /workspace/workgroup ]; then
  shared_dir=/workspace/workgroup
else
  shared_dir=""
fi
state_dir="${shared_dir:-${TMPDIR:-/tmp}}"
lock="${HOST_CI_LOCK:-$state_dir/host-ci.lock}"
vitest_lock="${HOST_CI_VITEST_LOCK:-$state_dir/vitest.lock}"
log_dir="${HOST_CI_LOG_DIR:-$state_dir/host-ci-logs}"

scratch=""
posted=()        # contexts that have a `pending` from this run
finished=0
host_name=$(hostname 2>/dev/null || echo unknown)
log=""

post_status() { # <context> <state> <description> [<target_url>]
  local desc="$3"
  [ "${#desc}" -le 140 ] || desc="${desc:0:137}..."
  local args=(-f state="$2" -f context="$1" -f description="$desc")
  [ -z "${4:-}" ] || args+=(-f target_url="$4")
  gh api -X POST "repos/$repo/statuses/$head" "${args[@]}" >/dev/null
}

cleanup() {
  local status=$? ctx
  if [ "${#posted[@]}" -gt 0 ] && [ "$finished" = 0 ]; then
    # Interrupted or failed between pending and a verdict: never leave a
    # pending status looking like a run in progress, and never leave it green.
    for ctx in "${posted[@]}"; do
      post_status "$ctx" failure "host CI did not finish (exit $status) on $host_name; log ${log:-none}" || true
    done
  fi
  if [ -n "$scratch" ]; then rm -rf "$scratch"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Whether $1 may be posted as a stand-in: at least one Actions job of exactly
# that name on this head, and every one of them never started and failed.
# Read through actions/runs and each run's jobs — the endpoints merge-check
# reads — never commits/<sha>/check-runs, which 403s under the narrower
# tokens container agents hold. Any read that fails is a no. Sets `why`.
why=""
standin_allowed() {
  local runs ids id jobs verdict
  runs=$(gh api --paginate --slurp "repos/$repo/actions/runs?head_sha=$head&per_page=100" 2>/dev/null) || { why="could not read the Actions runs on this head"; return 1; }
  ids=$(printf '%s\n' "$runs" | jq -r --arg head "$head" '[ .[].workflow_runs[]? | select(.head_sha == $head) | .id ] | unique | .[]') || { why="could not read the Actions runs on this head"; return 1; }
  local found=0
  for id in $ids; do
    [[ "$id" =~ ^[0-9]+$ ]] || { why="an Actions run on this head has id \"$id\""; return 1; }
    jobs=$(gh api --paginate --slurp "repos/$repo/actions/runs/$id/jobs?per_page=100" 2>/dev/null) || { why="could not read the jobs of run $id"; return 1; }
    verdict=$(printf '%s\n' "$jobs" | jq -r -L "$HERE" --arg name "$1" 'include "never-started";
      [ .[].jobs[]? | select(.name == $name) ] | if length == 0 then "none" elif all(.[]; never_started and .conclusion == "failure") then "never" else "started" end') || { why="could not read the jobs of run $id"; return 1; }
    case "$verdict" in
      none) ;;
      never) found=1 ;;
      *) why="Actions started a \"$1\" job on this head (run $id) — a real result, never overwritten"; return 1 ;;
    esac
  done
  [ "$found" = 1 ] || { why="no Actions job named \"$1\" is on this head (yet)"; return 1; }
}

scratch=$(mktemp -d "${HOST_CI_SCRATCH:-${TMPDIR:-/tmp}}/host-ci.XXXXXX")
src="$scratch/src"
git init -q "$src"
# By sha: GitHub serves any reachable commit, and a sha cannot move under us the
# way pull/<n>/head can. Checked again after checkout.
git -C "$src" fetch -q --depth=1 --no-tags "https://github.com/$repo.git" "$head"
git -C "$src" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
got=$(git -C "$src" rev-parse HEAD)
[ "$got" = "$head" ] || { echo "run-host-ci: fetched $got, not $head" >&2; exit 1; }

if [ ! -f "$src/$DECLARATION" ]; then
  echo "run-host-ci: $repo declares no host CI at $head — add $DECLARATION (the CI-equivalent commands, run with bash from the repo root) in that repository. Refusing to guess its commands." >&2
  exit 3
fi

# The leading comment block only: the shebang, blank lines and `#` lines up
# to the first line of code.
mapfile -t declared < <(awk '
  NR == 1 && /^#!/ { next }
  /^[[:space:]]*$/ { next }
  /^#/ { if (match($0, /^#[[:space:]]*host-ci-context:[[:space:]]*/)) { v = substr($0, RLENGTH + 1); sub(/[[:space:]]+$/, "", v); print v }; next }
  { exit }' "$src/$DECLARATION")
standins=()
for ctx in "${declared[@]}"; do
  if [ -z "$ctx" ] || [ "${#ctx}" -gt 100 ]; then
    echo "run-host-ci: $DECLARATION declares an empty or over-long host-ci-context" >&2
    exit 2
  fi
  for reserved in "${RESERVED_CONTEXTS[@]}"; do
    if [ "$ctx" = "$reserved" ]; then
      echo "run-host-ci: $DECLARATION declares host-ci-context \"$ctx\", which host CI may never stand in for" >&2
      exit 2
    fi
  done
  if standin_allowed "$ctx"; then
    standins+=("$ctx")
    echo "run-host-ci: will stand in for \"$ctx\": Actions never started it on $head" >&2
  else
    echo "run-host-ci: not standing in for \"$ctx\": $why" >&2
  fi
done
contexts=("$HOST_CI_CONTEXT" "${standins[@]}")

mkdir -p "$log_dir"
log="$log_dir/${repo//\//_}-pr$pr-${head:0:12}-$(date -u +%Y%m%dT%H%M%SZ).log"
: > "$log"

if [ "$dry_run" = 0 ]; then
  for ctx in "${contexts[@]}"; do
    post_status "$ctx" pending "running $DECLARATION on $host_name"
    posted+=("$ctx")
  done
else
  echo "run-host-ci: --dry-run — posting nothing (would post: $(printf '"%s" ' "${contexts[@]}"))" >&2
fi

echo "run-host-ci: $repo PR #$pr head $head — running $DECLARATION (waiting for $lock; log $log)" >&2
start=$(date +%s)
rc=0
(
  cd "$src"
  export CI=true HOST_CI=1 HOST_CI_REPO="$repo" HOST_CI_PR="$pr" HOST_CI_HEAD="$head"
  export HOST_CI_BASE_REF="$base_ref" HOST_CI_BASE_SHA="$base_sha" HOST_CI_VITEST_LOCK="$vitest_lock"
  flock "$lock" timeout --kill-after=30 "$timeout_s" ionice -c3 nice -n 10 bash "$DECLARATION"
) 2>&1 | tee -a "$log" || rc=$?
elapsed=$(( $(date +%s) - start ))

if [ "$rc" -eq 0 ]; then
  verdict=success
  summary="$DECLARATION passed in ${elapsed}s on $host_name"
else
  verdict=failure
  why="exit $rc"
  [ "$rc" -eq 124 ] && why="timed out after ${timeout_s}s"
  summary="$DECLARATION failed ($why) after ${elapsed}s on $host_name"
fi

if [ "$dry_run" = 1 ]; then
  finished=1
  echo "host-ci=$verdict repo=$repo pr=$pr head=$head elapsed=${elapsed}s dry-run=1 log=$log would-post=\"$(IFS=,; echo "${contexts[*]}")\""
  [ "$verdict" = success ] && exit 0
  exit 1
fi

# The run's record on the PR, which the statuses link to: what ran, where,
# how it ended, the log's location and its tail. A comment that cannot be
# posted leaves the statuses without a link, never without a verdict.
body="$scratch/comment.md"
{
  printf '<!-- run-host-ci head=%s verdict=%s -->\n' "$head" "$verdict"
  printf '**Host CI: %s** on `%s` — %s.\n\n' "$verdict" "$head" "$summary"
  if [ "${#standins[@]}" -gt 0 ]; then
    printf 'Posted as `%s` and, standing in because Actions never started them on this head, %s.\n\n' "$HOST_CI_CONTEXT" "$(printf '`%s` ' "${standins[@]}")"
  else
    printf 'Posted as `%s`.\n\n' "$HOST_CI_CONTEXT"
  fi
  printf 'Full log on %s: `%s`\n\n<details><summary>Last 80 lines</summary>\n\n````text\n' "$host_name" "$log"
  tail -n 80 "$log" | sed 's/````/` ` ` `/g'
  printf '````\n\n</details>\n'
} > "$body"
target=$(gh api -X POST "repos/$repo/issues/$pr/comments" -F body=@"$body" --jq .html_url 2>/dev/null) || target=""
[[ "$target" =~ ^https:// ]] || target=""

for ctx in "${contexts[@]}"; do
  post_status "$ctx" "$verdict" "$summary" "$target"
done
finished=1
echo "host-ci=$verdict repo=$repo pr=$pr head=$head elapsed=${elapsed}s context=\"$(IFS=,; echo "${contexts[*]}")\" log=$log${target:+ comment=$target}"
[ "$verdict" = success ] && exit 0
exit 1
