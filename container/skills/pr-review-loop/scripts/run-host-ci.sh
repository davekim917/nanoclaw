#!/usr/bin/env bash
# Run a repository's declared CI on this machine against a PR's exact head, and
# post the answer as the commit status `CI (host)` on that head.
#
#   run-host-ci.sh [--pr <n>] [--head <sha>] [--repo <owner/name>] [--dry-run]
#
# Exit codes: 0 the declared CI passed and `success` was posted; 1 it failed (or
# the status could not be posted, or the PR was refused) and `failure` was
# posted where possible; 2 usage; 3 the repository declares no host CI at that head (nothing
# posted); 12 the PR head is not --head.
#
# --dry-run runs everything the same way and reports what it would post, but
# posts nothing (no status, no comment) and also accepts a PR that is already
# merged or closed, so a declaration can be timed against history. With
# HOST_CI_OVERLAY=<dir> (--dry-run only) that directory's files are copied
# over the checked-out head first, uncommitted — how a declaration that is not
# on that head yet (a new one, under review) is tried against a past PR.
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
# It posts `CI (host)` only, never a context an Actions check also uses: a
# branch rule requiring a name that both a check run and a commit status carry
# needs BOTH to pass ("If a check and a commit status have the same name, both
# must pass when that name is required" — GitHub docs, Troubleshooting required
# status checks), so a status named after a never-started Actions check cannot
# satisfy that rule anyway. Such a repo merges through its rule's bypass once
# merge-check reads `ci=host` (SKILL.md).
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

HOST_CI_CONTEXT='CI (host)'
DECLARATION='.github/host-ci.sh'

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
overlay="${HOST_CI_OVERLAY:-}"
if [ -n "$overlay" ]; then
  [ "$dry_run" = 1 ] || { echo "run-host-ci: HOST_CI_OVERLAY is for --dry-run only — a posted status comes from the head's own declaration" >&2; exit 2; }
  [ -d "$overlay" ] || { echo "run-host-ci: HOST_CI_OVERLAY=$overlay is not a directory" >&2; exit 2; }
fi

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

scratch=$(mktemp -d "${HOST_CI_SCRATCH:-${TMPDIR:-/tmp}}/host-ci.XXXXXX")
src="$scratch/src"
git init -q "$src"
# By sha: GitHub serves any reachable commit, and a sha cannot move under us the
# way pull/<n>/head can. Checked again after checkout. Full history, not
# --depth=1: a declaration may run checks that need it, and a shallow clone
# makes scripts/review-notes.test.ts:232-237 skip every pinned `at <sha>`
# citation it cannot resolve — host CI would then pass a stale citation that
# ci.yml's `fetch-depth: 0` checkout (.github/workflows/ci.yml:48-50) fails.
git -C "$src" fetch -q --no-tags "https://github.com/$repo.git" "$head"
git -C "$src" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
got=$(git -C "$src" rev-parse HEAD)
[ "$got" = "$head" ] || { echo "run-host-ci: fetched $got, not $head" >&2; exit 1; }
if [ -n "$overlay" ]; then
  cp -R "$overlay/." "$src/"
  echo "run-host-ci: --dry-run with $overlay copied over the head (uncommitted)" >&2
fi

if [ ! -f "$src/$DECLARATION" ]; then
  echo "run-host-ci: $repo declares no host CI at $head — add $DECLARATION (the CI-equivalent commands, run with bash from the repo root) in that repository. Refusing to guess its commands." >&2
  exit 3
fi

contexts=("$HOST_CI_CONTEXT")

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
  # `timeout` makes itself a process-group leader (it calls setpgid unless
  # --foreground), so the declaration and everything it starts share one group
  # whose id is timeout's pid, recorded here through the exec. Anything the
  # declaration left running in the background still holds this pipe open,
  # and tee would wait on it forever; it is killed with its group once the
  # declaration itself has finished.
  pgid_file="$scratch/declaration.pgid"
  rc=0
  flock "$lock" bash -c 'echo "$$" > "$1"; shift; exec "$@"' _ "$pgid_file" \
    timeout --kill-after=30 "$timeout_s" ionice -c3 nice -n 10 bash "$DECLARATION" || rc=$?
  if [ -s "$pgid_file" ]; then kill -KILL -- "-$(cat "$pgid_file")" 2>/dev/null || true; fi
  exit "$rc"
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
  printf 'Posted as `%s`.\n\n' "$HOST_CI_CONTEXT"
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
