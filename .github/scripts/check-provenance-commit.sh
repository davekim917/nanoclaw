#!/usr/bin/env bash
# The three checks a commit on main must pass before main-provenance.yml's `provenance`
# job — which runs on every push and checks only the tip that push just landed —
# considers it legitimate. Its `sweep` sibling does NOT call this script: a per-commit
# check like this one can't see a push that was hidden from `provenance` in the first
# place (a skip-CI commit-message marker, or a GitHub Actions outage), so `sweep` checks
# the repository Activity API instead (sweep-main-activity.sh). See main-provenance.yml's
# header comment for how the two jobs divide the work.
#
# Usage: check-provenance-commit.sh <sha>
# Env: GH_TOKEN, REPO (both already required by `gh api`/`gh` in the caller).
set -euo pipefail

sha="$1"

commit=$(gh api "repos/$REPO/commits/$sha")

# GitHub's test-merge commits (`refs/pull/N/merge`, e.g. #652's 7842e43a8, #653's
# 9bf66a601) are web-flow-signed and verified like a real merge, so the two checks
# below would pass one. Pushing one straight to main and having GitHub later record it
# as a PR's merge_commit_sha is the same evasion as a skip-CI commit-message marker, so
# refuse the format outright regardless of verification or PR linkage.
message=$(jq -r '.commit.message' <<<"$commit")
if [[ "$message" =~ ^Merge\ [0-9a-f]{40}\ into\ [0-9a-f]{40}$ ]]; then
  echo "::error::$sha's message (\"$message\") is GitHub's test-merge format (refs/pull/N/merge); that belongs on a PR ref, never pushed to main"
  exit 1
fi

# GitHub made the tip. A merge, squash or rebase through GitHub's UI/API is signed by
# GitHub and committed by its `web-flow` account. A local `git merge` of a PR branch
# pushed straight to main also marks that PR merged, with the local commit as its
# merge_commit_sha, so the PR-link check alone would pass it (it has, 5 times: #148,
# #255, #377, #380, #381). A local commit can borrow web-flow's email, never its
# signature.
made=$(jq -r '.commit.verification.verified == true and .committer.login == "web-flow"' <<<"$commit")
if [ "$made" != true ]; then
  echo "::error::$sha is a commit GitHub did not make (unsigned or not GitHub's); changes reach main only through a PR merge"
  exit 1
fi

# A merged PR into main names the tip as its merge_commit_sha, and the tip is not the
# PR's own head (pushing a PR's head straight to main also marks it merged). This
# rules out a commit GitHub made some other way, such as a web edit. GitHub links the
# commit to its PR asynchronously, so give it two minutes.
for attempt in $(seq 1 13); do
  prs=$(gh api "repos/$REPO/commits/$sha/pulls" | jq -r --arg sha "$sha" '
    [ .[] | select(.merged_at != null and .base.ref == "main"
                   and .merge_commit_sha == $sha and .head.sha != $sha)
      | "#\(.number)" ] | join(" ")')
  if [ -n "$prs" ]; then
    echo "$sha came from $prs"
    exit 0
  fi
  [ "$attempt" -lt 13 ] && sleep 10
done
echo "::error::$sha is a commit no merged PR into main produced; changes reach main only through a PR merge"
exit 1
