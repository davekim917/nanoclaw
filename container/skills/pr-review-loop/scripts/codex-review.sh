#!/usr/bin/env bash
# Codex PR review-loop helpers. Run from inside the repo worktree, or set REPO/PR.
#
#   codex-review.sh open                      # unresolved Codex threads, TSV: thread_id, comment_id, file:line, outdated?, severity, title
#   codex-review.sh body <comment_id>         # full comment body for one finding
#   codex-review.sh churn                     # files drawing findings across 3+ rounds — the churn detector
#   codex-review.sh reply <comment_id> <text> # reply on that thread
#   codex-review.sh resolve <thread_id>       # mark the thread resolved
#   codex-review.sh status <sha> <since_iso>  # codex=<pending|clean|findings> open=<n> review=<n> reaction=<n> rounds=<n>
#                                             # open/status print a STOP banner at rounds>=4 — diagnose, do not push
#
# The reviewer is `chatgpt-codex-connector` in GraphQL and
# `chatgpt-codex-connector[bot]` in REST, so every login match here is a
# case-insensitive prefix or regex, never equality against one spelling.
# Likewise `commit_id` comes back as a full 40-char SHA — matched with
# startswith so a short SHA still matches.
set -euo pipefail

REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
PR="${PR:-$(gh pr view --json number -q .number)}"
OWNER="${REPO%/*}"
NAME="${REPO#*/}"

# Unresolved review threads opened by Codex, as raw JSON objects (one per line).
# Capped at 100 threads — a PR past that is deep in "real defects" territory, so
# the cap warns loudly on stderr rather than silently under-reporting.
threads() {
  local raw
  raw=$(gh api graphql -f query='
    query($owner:String!,$name:String!,$pr:Int!){
      repository(owner:$owner,name:$name){ pullRequest(number:$pr){
        reviewThreads(first:100){ totalCount nodes{
          id isResolved isOutdated
          comments(first:1){ nodes{ databaseId author{login} path line body } } } } } } }' \
    -F owner="$OWNER" -F name="$NAME" -F pr="$PR")
  local total
  total=$(printf '%s' "$raw" | jq '.data.repository.pullRequest.reviewThreads.totalCount')
  if [ "$total" -gt 100 ]; then
    echo "warning: PR has $total review threads; only the first 100 were read" >&2
  fi
  printf '%s' "$raw" | jq -c '.data.repository.pullRequest.reviewThreads.nodes[]
          | select(.isResolved | not)
          | select(.comments.nodes[0].author.login | ascii_downcase | startswith("chatgpt-codex-connector"))'
}

# Distinct Codex reviews that produced findings — the PR's round count.
# Printed on open/status so the number is impossible to not see; at 4+ the
# banner mandates the stop-and-diagnose path in SKILL.md instead of a push.
rounds_count() {
  gh api --paginate --slurp "repos/$REPO/pulls/$PR/comments" \
    | jq '[.[][] | select(.user.login | test("codex";"i")) | .pull_request_review_id] | unique | length'
}

rounds_banner() {
  local n="$1"
  if [ "$n" -ge 4 ]; then
    {
      echo "=================================================================="
      echo "STOP: $n distinct review rounds on this PR. Do not push another"
      echo "patch. Run 'codex-review.sh churn', name the one invariant the"
      echo "findings are circling, and escalate per SKILL.md (round 4+ path)."
      echo "=================================================================="
    } >&2
  fi
}

case "${1:?usage: open|churn|body|reply|resolve|status}" in
  open)
    # thread_id  comment_id  file:line  outdated?  severity  title
    rounds_banner "$(rounds_count)"
    threads | jq -r '.comments.nodes[0] as $c
      | [ .id,
          ($c.databaseId | tostring),
          "\($c.path):\($c.line)",
          (if .isOutdated then "outdated" else "current" end),
          ([$c.body | scan("badge/(P[0-9])")] | flatten | .[0] // "P?"),
          ($c.body | split("\n") | .[0] | sub("^.*</sub></sub>\\s*";"") | sub("\\*\\*\\s*$";"") | .[0:120])
        ] | @tsv'
    ;;
  churn)
    # Which files keep coming back? Rounds are grouped by review id (exact),
    # not timestamp. A file flagged CHURN has drawn findings in 3+ separate
    # reviews, which means the fixes are landing in the wrong place — see
    # "When the fixes are causing the findings" in SKILL.md.
    gh api --paginate --slurp "repos/$REPO/pulls/$PR/comments" \
      | jq -r '[.[][] | select(.user.login | test("codex";"i"))]
          | group_by(.path)
          | map({ path: .[0].path,
                  rounds: ([.[].pull_request_review_id] | unique | length),
                  findings: length })
          | sort_by(-.rounds, -.findings)
          | .[]
          | "\(if .rounds >= 3 then "CHURN" else "ok   " end)  \(.rounds) rounds  \(.findings) findings  \(.path)"'
    ;;
  body)
    # A single review comment is NOT nested under the PR number; the reply
    # endpoint below is. Mixing them up 404s.
    gh api "repos/$REPO/pulls/comments/${2:?comment id}" --jq .body
    ;;
  reply)
    gh api "repos/$REPO/pulls/$PR/comments/${2:?comment id}/replies" \
      -f body="${3:?reply text}" --jq '"replied: \(.html_url)"'
    ;;
  resolve)
    gh api graphql -f query='mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }' \
      -F id="${2:?thread id}" --jq '"resolved: \(.data.resolveReviewThread.thread.isResolved)"'
    ;;
  status)
    # Prints: codex=<pending|clean|findings> open=<n> review=<n> reaction=<n> rounds=<n>
    #
    # `codex=` is only about whether the reviewer answered THIS commit; `open=`
    # is the separate merge gate. They are printed apart on purpose: a 👍 on a
    # fresh commit does not mean the PR is clean if threads from an earlier
    # round are still unresolved, and collapsing the two hides exactly that.
    # Wait until codex= leaves pending. Merge only on codex=clean open=0.
    sha="${2:?head sha}"; since="${3:?iso timestamp captured before you asked for the review}"
    # --paginate is load-bearing: both endpoints return 30 per page, oldest
    # first, so on a long PR the newest review sits on the LAST page and a
    # page-1-only query reports "no review" forever. (--slurp can't be combined
    # with gh's --jq, hence the pipe into jq.)
    review=$(gh api --paginate --slurp "repos/$REPO/pulls/$PR/reviews" \
      | jq --arg sha "$sha" --arg since "$since" \
           '[.[][] | select(.commit_id | startswith($sha))
                   | select(.user.login | test("codex";"i"))
                   | select(.submitted_at > $since)] | length')
    reaction=$(gh api --paginate --slurp "repos/$REPO/issues/$PR/reactions" \
      | jq --arg since "$since" \
           '[.[][] | select(.user.login | test("codex";"i"))
                   | select(.content == "+1")
                   | select(.created_at > $since)] | length')
    open_count=$(threads | grep -c . || true)
    if [ "$review" -gt 0 ]; then
      [ "$open_count" -gt 0 ] && codex=findings || codex=clean
    elif [ "$reaction" -gt 0 ]; then
      codex=clean
    else
      codex=pending
    fi
    rounds=$(rounds_count)
    rounds_banner "$rounds"
    echo "codex=$codex open=$open_count review=$review reaction=$reaction rounds=$rounds"
    ;;
  *) echo "unknown command: $1" >&2; exit 2 ;;
esac
