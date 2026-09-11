#!/usr/bin/env bash
# main-provenance.yml's gate-audit jobs. For each PR a push to main merged, run
# the merge gate's own after-the-fact check — codex-review.sh audit, the
# helpers merge-check decides with, judged as of the merge by the audit code
# that merge commit carries — and file ONE `gate-bypass` issue per PR it flags.
# Detection, not prevention: the merge already happened, so this blocks
# nothing. It is loud when it cannot judge a merge (a red job, never a quiet
# pass), and it never files twice for one PR: a re-run, the daily backstop, or
# the same PR seen by two pushes, finds the first issue by its marker, and two
# runs that file at the same moment leave only the lowest-numbered issue open.
#
# Two modes:
# - `gate-audit.sh <sha>`, the gate-audit job on every push: the PR(s) whose
#   merge commit <sha> is, with the helper in the checkout of <sha>.
# - `gate-audit.sh --sweep [hours=50]`, the daily gate-audit-sweep job: every
#   `pr_merge` the Activity API recorded on main in the last <hours> whose
#   push-triggered audit left no result, because its run never started (a
#   skip-CI marker in the merge commit's message, an Actions outage), was
#   cancelled, or failed. Each is audited with the helper its merge commit
#   carries, extracted with `git archive`, so it gets the rules its own job
#   would have applied; a merge commit with no gate-audit.sh predates the audit
#   and is skipped. A merge under an hour old is left to its own job, which may
#   still be running, and the next day's sweep still covers it. A lagging feed
#   is `sweep`'s to catch (sweep-main-activity.sh's freshness guard): the next
#   day's window overlaps this one.
#
# Usage: gate-audit.sh <sha> | gate-audit.sh --sweep [hours]
# Env: GH_TOKEN, REPO. CODEX_REVIEW overrides the push mode's helper path (tests only).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$here/../.." && pwd)

# One issue per PR, ever. Found through the issues endpoint rather than search:
# search is eventually consistent, so a re-run seconds after a filing could miss
# it and file again. Every step returns its own failure: the callers run this
# under `||`, which switches `set -e` off inside it.
file_bypass() {
  local pr="$1" finding="$2" mark filed url mine open keep n
  mark="<!-- gate-bypass pr=$pr -->"
  filed=$(gh api --paginate "repos/$REPO/issues?labels=gate-bypass&state=all&per_page=100" \
    | jq -rs --arg mark "$mark" '[ .[][] | select((.body // "") | contains($mark)) | .number ] | first // empty') || return 1
  if [ -n "$filed" ]; then
    echo "#$pr is already filed as #$filed"
    return 0
  fi
  gh label create gate-bypass --repo "$REPO" --force --color B60205 \
    --description "A PR merged without the evidence the merge gate requires" >/dev/null || return 1
  url=$(gh issue create --repo "$REPO" --label gate-bypass \
    --title "Gate bypass: #$pr merged without the merge gate's evidence" \
    --body "#$pr merged, but \`codex-review.sh merge-check\` would have refused it at its merge:

\`\`\`
$finding
\`\`\`

Found by main-provenance.yml's gate-audit job (\`codex-review.sh audit\`). Close this with what happened: a review after the fact, a follow-up fix, or why the evidence was sound.

$mark") || return 1
  mine="${url##*/}"
  [[ "$mine" =~ ^[0-9]+$ ]] || { echo "::error::filed an issue for #$pr, but gh returned no issue number ($url)"; return 1; }
  # The check above and the filing are two calls, so two runs can both pass the
  # check and both file. Settle it after the fact: the lowest-numbered open
  # issue with this PR's marker is the one, and each newer one is closed as its
  # duplicate. Every run that filed does this, so the last to finish leaves one
  # open. A re-list that fails fails the job, since a duplicate may be left
  # open; a close that fails is a warning.
  open=$(gh api --paginate "repos/$REPO/issues?labels=gate-bypass&state=open&per_page=100" \
    | jq -rs --arg mark "$mark" --argjson mine "$mine" '
      [ .[][] | select((.body // "") | contains($mark)) | .number ] + [ $mine ] | unique | .[]') || {
    echo "::error::filed $url for #$pr, but could not re-list gate-bypass issues to close a duplicate filed alongside it"
    return 1
  }
  keep=$(printf '%s\n' "$open" | head -n 1)
  for n in $open; do
    [ "$n" = "$keep" ] && continue
    gh issue close "$n" --repo "$REPO" --comment "Duplicate of #$keep: both were filed for #$pr at the same time." >/dev/null \
      || echo "::warning::could not close #$n, a duplicate of #$keep"
  done
  echo "::warning::#$pr merged without the merge gate's evidence; filed #$keep"
}

# The merged PR(s) whose merge commit $1 is. GitHub links them as
# asynchronously as check-provenance-commit.sh waits for, so give it the same
# two minutes. Prints nothing when none is linked by then.
merged_prs() {
  local attempt prs
  for attempt in $(seq 1 13); do
    prs=$(gh api "repos/$REPO/commits/$1/pulls" | jq -r --arg sha "$1" '
      [ .[] | select(.merged_at != null and .base.ref == "main" and .merge_commit_sha == $sha) | .number ] | .[]') || return 1
    if [ -n "$prs" ]; then
      printf '%s\n' "$prs"
      return 0
    fi
    if [ "$attempt" -lt 13 ]; then sleep 10; fi
  done
}

# Audits every PR merge commit $1 landed, with helper $2, and files each one
# the audit flags. Non-zero when any cannot be judged or filed, and when $1 is
# no merged PR's merge commit: a merge the audit cannot tie to a PR is one it
# cannot judge, never a pass.
audit_commit() {
  local sha="$1" helper="$2" prs pr status finding failed=0
  prs=$(merged_prs "$sha") || { echo "::error::could not read which PR $sha merged"; return 1; }
  if [ -z "$prs" ]; then
    echo "::error::$sha is no merged PR's merge commit after two minutes of waiting for GitHub to link one, so the gate audit cannot judge it (the provenance job says whether main moved outside a PR)"
    return 1
  fi
  for pr in $prs; do
    status=0
    finding=$(REPO="$REPO" PR="$pr" bash "$helper" audit) || status=$?
    printf '%s\n' "$finding"
    case "$status" in
      0) ;;
      28) file_bypass "$pr" "$finding" || failed=1 ;;
      *)
        echo "::error::the gate audit could not judge #$pr (exit $status); the output above says why"
        failed=1
        ;;
    esac
  done
  return "$failed"
}

# `done` when a push-triggered gate-audit job on $1 finished green, `running`
# when one is still queued or running, `none` otherwise: no run, or only jobs
# that were cancelled or failed.
push_audit_state() {
  local runs id jobs='[]'
  runs=$(gh api "repos/$REPO/actions/runs?head_sha=$1&event=push&per_page=100" \
    | jq -c '[ .workflow_runs[] | select(.path == ".github/workflows/main-provenance.yml") | { id, status } ]') || return 1
  for id in $(jq -r '.[].id' <<<"$runs"); do
    jobs=$( { printf '%s\n' "$jobs"; gh api "repos/$REPO/actions/runs/$id/jobs?filter=all&per_page=100"; } \
      | jq -cs '.[0] + [ .[1].jobs[] | select(.name == "gate-audit") | { status, conclusion } ]') || return 1
  done
  jq -rn --argjson runs "$runs" --argjson jobs "$jobs" '
    if any($jobs[]; .conclusion == "success") then "done"
    elif any($runs[]; .status != "completed") or any($jobs[]; .status != "completed") then "running"
    else "none" end'
}

sweep() {
  local hours="$1" now records sha state tree failed=0
  now=$(date -u +%s)
  records=$(gh api --paginate "repos/$REPO/activity?ref=refs/heads/main&time_period=week&per_page=100" \
    | jq -rs --argjson from "$((now - hours * 3600))" --argjson to "$((now - 3600))" '
      [ .[][] | select(.activity_type == "pr_merge")
        | select((.timestamp | fromdateiso8601) as $t | $t >= $from and $t <= $to) | .after ] | unique | .[]') || {
    echo "::error::could not read main's activity"
    return 1
  }
  echo "checking $(printf '%s' "$records" | grep -c .) PR merge(s) on main from the last ${hours}h, older than an hour"
  for sha in $records; do
    if ! git -C "$repo_root" cat-file -e "$sha^{commit}" 2>/dev/null; then
      echo "::error::$sha is not in this checkout, so its audit code cannot be read"
      failed=1
      continue
    fi
    if ! git -C "$repo_root" cat-file -e "$sha:.github/scripts/gate-audit.sh" 2>/dev/null; then
      echo "$sha predates the gate audit"
      continue
    fi
    state=$(push_audit_state "$sha") || {
      echo "::error::could not read whether $sha's push-triggered gate audit ran"
      failed=1
      continue
    }
    case "$state" in
      done) echo "$sha: its push-triggered gate audit finished"; continue ;;
      running) echo "$sha: its push-triggered gate audit is still running"; continue ;;
    esac
    echo "$sha: its push-triggered gate audit left no result; auditing it here"
    tree=$(mktemp -d)
    if ! git -C "$repo_root" archive "$sha" container/skills/pr-review-loop | tar -x -C "$tree"; then
      echo "::error::could not extract the audit code $sha carries"
      failed=1
      continue
    fi
    audit_commit "$sha" "$tree/container/skills/pr-review-loop/scripts/codex-review.sh" || failed=1
  done
  return "$failed"
}

if [ "${1:-}" = --sweep ]; then
  hours="${2:-50}"
  if ! [[ "$hours" =~ ^[0-9]+$ ]] || [ "$hours" -lt 1 ] || [ "$hours" -gt 168 ]; then
    echo "::error::--sweep takes 1 to 168 hours, the week the Activity API's feed covers; got $hours" >&2
    exit 2
  fi
  sweep "$hours" || exit 1
  exit 0
fi

sha="${1:?usage: gate-audit.sh <sha> | gate-audit.sh --sweep [hours]}"
audit_commit "$sha" "${CODEX_REVIEW:-$here/../../container/skills/pr-review-loop/scripts/codex-review.sh}" || exit 1
