#!/usr/bin/env bash
# main-provenance.yml's gate-audit job. For the PR a push to main just merged,
# run the merge gate's own after-the-fact check — codex-review.sh audit, the
# helpers merge-check decides with, judged as of the merge — and file ONE
# `gate-bypass` issue per PR it flags. Detection, not prevention: the merge
# already happened, so this blocks nothing. It is loud when it cannot judge a
# merge (a red job, never a quiet pass), and it never files twice for one PR:
# a re-run, or the same PR seen by two pushes, finds the first issue by its
# marker.
#
# Usage: gate-audit.sh <sha>
# Env: GH_TOKEN, REPO. CODEX_REVIEW overrides the helper's path (tests only).
set -euo pipefail

sha="$1"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
helper="${CODEX_REVIEW:-$here/../../container/skills/pr-review-loop/scripts/codex-review.sh}"

# One issue per PR, ever. Found through the issues endpoint rather than search:
# search is eventually consistent, so a re-run seconds after a filing could miss
# it and file again. Every step returns its own failure: the caller runs this
# under `||`, which switches `set -e` off inside it.
file_bypass() {
  local pr="$1" finding="$2" mark filed url
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
  echo "::warning::#$pr merged without the merge gate's evidence; filed $url"
}

# The merged PR(s) whose merge commit this push landed. GitHub links them as
# asynchronously as check-provenance-commit.sh waits for, so give it the same
# two minutes.
prs=""
for attempt in $(seq 1 13); do
  prs=$(gh api "repos/$REPO/commits/$sha/pulls" | jq -r --arg sha "$sha" '
    [ .[] | select(.merged_at != null and .base.ref == "main" and .merge_commit_sha == $sha) | .number ] | .[]')
  if [ -n "$prs" ]; then break; fi
  if [ "$attempt" -lt 13 ]; then sleep 10; fi
done
if [ -z "$prs" ]; then
  echo "$sha is no merged PR's merge commit, so there is no merge to audit (the provenance job judges that)"
  exit 0
fi

failed=0
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
exit "$failed"
