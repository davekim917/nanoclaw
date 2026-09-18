#!/usr/bin/env bash
# Run a repository's declared CI on this machine against a PR's exact head, and
# post the answer as the commit status `CI (host)` on that head.
#
#   run-host-ci.sh [--pr <n>] [--head <sha>] [--repo <owner/name>]
#
# Exit codes: 0 the declared CI passed and `success` was posted; 1 it failed (or
# the status could not be posted) and `failure` was posted where possible;
# 2 usage; 3 the repository declares no host CI at that head (nothing posted);
# 12 the PR head is not --head.
#
# What merge-check does with it (codex-review.sh, ci_verdict and
# legacy_precheck): a `CI (host)` success on the exact head stands in for a
# required Actions workflow ONLY when GitHub never started that workflow's jobs
# (no runner assigned, no step run — the billing lockout's shape). A workflow
# that ran and failed stays red whatever this posts, and a `CI (host)` failure
# is a red status like any other.
#
# The commands are the repository's, never this script's: `.github/host-ci.sh`
# at the PR head, run with bash from the checkout root. A repository without one
# is refused — declare host CI in that repository rather than have this guess.
# The declaration is read from the head for the same reason a `pull_request`
# workflow is: the PR's own CI definition is what CI runs.
#
# It never touches a checkout you are working in: the head is fetched by its
# sha into a fresh scratch repository under $HOST_CI_SCRATCH (default
# $TMPDIR or /tmp), removed on exit however this ends. One run at a time per
# machine (flock on $HOST_CI_LOCK), at idle IO and lowered CPU priority, so it
# cannot starve a production host. A declaration that runs vitest must take
# `flock "$HOST_CI_VITEST_LOCK"` and pass `--maxWorkers=2` itself.
#
# Works on the host and inside an agent container alike: it needs git, gh (with
# a token that can read the repo and write commit statuses), jq, flock, ionice,
# nice and timeout, and fetches over the same https remote gh authenticates.
set -euo pipefail

HOST_CI_CONTEXT='CI (host)'
DECLARATION='.github/host-ci.sh'

usage() { echo "usage: run-host-ci.sh [--pr <n>] [--head <sha>] [--repo <owner/name>]" >&2; exit 2; }

want="" pr="${PR:-}" repo="${REPO:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --pr) [ $# -ge 2 ] && [[ "$2" =~ ^[1-9][0-9]*$ ]] || usage; pr="$2"; shift 2 ;;
    --head) [ $# -ge 2 ] && [[ "$2" =~ ^[0-9a-f]{40}$ ]] || { echo "run-host-ci: --head must be a full 40-character sha" >&2; exit 2; }; want="$2"; shift 2 ;;
    --repo) [ $# -ge 2 ] && [[ "$2" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || usage; repo="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "run-host-ci: unknown argument $1" >&2; usage ;;
  esac
done
timeout_s="${HOST_CI_TIMEOUT_SECONDS:-2400}"
[[ "$timeout_s" =~ ^[1-9][0-9]*$ ]] || { echo "run-host-ci: HOST_CI_TIMEOUT_SECONDS must be a positive whole number" >&2; exit 2; }

for tool in git gh jq flock ionice nice timeout mktemp; do
  command -v "$tool" >/dev/null || { echo "run-host-ci: $tool is not installed" >&2; exit 1; }
done

[ -n "$repo" ] || repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
[ -n "$pr" ] || pr=$(gh pr view --repo "$repo" --json number -q .number)
[[ "$pr" =~ ^[1-9][0-9]*$ ]] || { echo "run-host-ci: could not resolve the PR number" >&2; exit 1; }

pr_json=$(gh pr view "$pr" --repo "$repo" --json state,headRefOid)
state=$(printf '%s' "$pr_json" | jq -er .state)
head=$(printf '%s' "$pr_json" | jq -er .headRefOid)
[[ "$head" =~ ^[0-9a-f]{40}$ ]] || { echo "run-host-ci: PR #$pr reported head \"$head\"" >&2; exit 1; }
[ "$state" = OPEN ] || { echo "run-host-ci: PR #$pr is $state; there is no head to run CI on" >&2; exit 1; }
if [ -n "$want" ] && [ "$want" != "$head" ]; then
  echo "run-host-ci: PR #$pr's head is $head, not $want — capture the new head and run again" >&2
  exit 12
fi

scratch=""
posted_pending=0
finished=0
host_name=$(hostname 2>/dev/null || echo unknown)

post_status() { # <state> <description>
  local desc="$2"
  [ "${#desc}" -le 140 ] || desc="${desc:0:137}..."
  gh api -X POST "repos/$repo/statuses/$head" -f state="$1" -f context="$HOST_CI_CONTEXT" -f description="$desc" >/dev/null
}

cleanup() {
  local status=$?
  if [ "$posted_pending" = 1 ] && [ "$finished" = 0 ]; then
    # Interrupted or failed between pending and a verdict: never leave the
    # pending status looking like a run in progress, and never leave it green.
    post_status failure "host CI did not finish (exit $status) on $host_name" || true
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
# way pull/<n>/head can. Checked again after checkout.
git -C "$src" fetch -q --depth=1 --no-tags "https://github.com/$repo.git" "$head"
git -C "$src" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
got=$(git -C "$src" rev-parse HEAD)
[ "$got" = "$head" ] || { echo "run-host-ci: fetched $got, not $head" >&2; exit 1; }

if [ ! -f "$src/$DECLARATION" ]; then
  echo "run-host-ci: $repo declares no host CI at $head — add $DECLARATION (the CI-equivalent commands, run with bash from the repo root) in that repository. Refusing to guess its commands." >&2
  exit 3
fi

post_status pending "running $DECLARATION on $host_name"
posted_pending=1

lock="${HOST_CI_LOCK:-${TMPDIR:-/tmp}/host-ci.lock}"
echo "run-host-ci: $repo PR #$pr head $head — running $DECLARATION (waiting for $lock)" >&2
start=$(date +%s)
rc=0
(
  cd "$src"
  export CI=true HOST_CI=1 HOST_CI_REPO="$repo" HOST_CI_PR="$pr" HOST_CI_HEAD="$head"
  export HOST_CI_VITEST_LOCK="${HOST_CI_VITEST_LOCK:-${TMPDIR:-/tmp}/vitest.lock}"
  flock "$lock" timeout --kill-after=30 "$timeout_s" ionice -c3 nice -n 10 bash "$DECLARATION"
) || rc=$?
elapsed=$(( $(date +%s) - start ))

if [ "$rc" -eq 0 ]; then
  post_status success "$DECLARATION passed in ${elapsed}s on $host_name"
  finished=1
  echo "host-ci=success repo=$repo pr=$pr head=$head elapsed=${elapsed}s context=\"$HOST_CI_CONTEXT\""
  exit 0
fi
why="exit $rc"
[ "$rc" -eq 124 ] && why="timed out after ${timeout_s}s"
post_status failure "$DECLARATION failed ($why) after ${elapsed}s on $host_name"
finished=1
echo "host-ci=failure repo=$repo pr=$pr head=$head elapsed=${elapsed}s ($why) context=\"$HOST_CI_CONTEXT\"" >&2
exit 1
