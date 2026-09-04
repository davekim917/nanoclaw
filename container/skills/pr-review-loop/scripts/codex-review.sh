#!/usr/bin/env bash
# Codex PR review-loop helpers. Run from inside the repo worktree, or set REPO/PR.
#
#   codex-review.sh open                      # unresolved Codex threads, TSV: thread_id, comment_id, file:line, outdated?, severity, title
#   codex-review.sh body <comment_id>         # full comment body for one finding
#   codex-review.sh churn                     # findings by file AND by class across rounds — the churn detector
#   codex-review.sh classes [--json]          # the class table alone (invariant signature @ seam)
#   codex-review.sh gate                      # REFRAME gate: exit 3 when a class has run 3 rounds unfixed
#   codex-review.sh push [git push args…]     # gate, then push — the loop's only push path
#   codex-review.sh reply <comment_id> <text> # reply on that thread
#   codex-review.sh resolve <thread_id>       # mark the thread resolved
#   codex-review.sh status <sha> <since_iso>  # codex=<pending|clean|findings> open=<n> review=<n> reaction=<n> rounds=<n>
#                                             # open/status print a STOP banner at rounds>=4 — diagnose, do not push
#
# `gate` is the rule the advisory detector never was: three rounds on ONE
# finding class (or one seam, severity not falling) is a design defect at a
# seam, and the loop refuses another site patch until the primitive fix lands.
# It lifts on a commit that touches that primitive, or one whose message
# carries `Reframe: <invariant> enforced in <primitive>`.
# REVIEW_LOOP_ALLOW_SITE_PATCH=1 overrides it, loudly, and writes the override
# into the PR body.
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

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHURN_JS="$HERE/review-churn.mjs"

# The classifier is dependency-free ESM so it runs on whatever JS runtime the
# box has — node on the host, node or bun inside an agent container. Nothing is
# installed for it, and jq stays the only other hard dependency.
runtime() {
  if command -v node >/dev/null 2>&1; then echo node
  elif command -v bun >/dev/null 2>&1; then echo bun
  else echo "codex-review: needs node or bun on PATH for the class/gate commands" >&2; return 1
  fi
}

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
    | jq '[.[][] | select(.user.login | ascii_downcase | startswith("chatgpt-codex-connector")) | .pull_request_review_id] | unique | length'
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

# Every Codex finding on the PR — resolved threads included, because a round
# that was answered is still a round that happened. `open` deliberately filters
# to unresolved; the class detector must not, or the history it counts resets
# every time the loop tidies up.
findings_json() {
  local raw total
  raw=$(gh api graphql -f query='
    query($owner:String!,$name:String!,$pr:Int!){
      repository(owner:$owner,name:$name){ pullRequest(number:$pr){
        reviewThreads(first:100){ totalCount nodes{
          id isResolved isOutdated
          comments(first:1){ nodes{
            databaseId author{login} path line body createdAt
            pullRequestReview{ id } } } } } } } }' \
    -F owner="$OWNER" -F name="$NAME" -F pr="$PR")
  total=$(printf '%s' "$raw" | jq '.data.repository.pullRequest.reviewThreads.totalCount')
  if [ "$total" -gt 100 ]; then
    echo "warning: PR has $total review threads; only the first 100 were read" >&2
  fi
  printf '%s' "$raw" | jq '[ .data.repository.pullRequest.reviewThreads.nodes[]
      | .comments.nodes[0] as $c
      | select($c.author.login | ascii_downcase | startswith("chatgpt-codex-connector"))
      | { threadId: .id, isResolved: .isResolved, isOutdated: .isOutdated,
          commentId: $c.databaseId, path: $c.path, line: $c.line, body: $c.body,
          createdAt: $c.createdAt, reviewId: ($c.pullRequestReview.id // null) } ]'
}

# The classifier reads the worktree to find the seam (which module the flagged
# sites import the shared callee from), so repoRoot must be the checkout the
# PR's branch is in.
payload_json() {
  jq -n --argjson findings "$(findings_json)" --arg root "$(git rev-parse --show-toplevel)" \
    '{ findings: $findings, repoRoot: $root }'
}

# An override is not a private decision: it goes in the PR body where the
# merge reviewer sees it. Idempotent — the same line is never appended twice.
record_site_patch_override() {
  local line="$1" body
  body=$(gh pr view "$PR" --repo "$REPO" --json body -q .body)
  case "$body" in
    *"$line"*) return 0 ;;
  esac
  gh pr edit "$PR" --repo "$REPO" --body "$body

$line" >/dev/null
  echo "recorded the override in the PR body" >&2
}

# Runs the gate and returns its exit status: 0 pass/override, 3 REFRAME
# REQUIRED. Human-readable output comes back on stderr from the classifier.
run_gate() {
  local node out status=0
  node=$(runtime) || return 2
  out=$(payload_json | "$node" "$CHURN_JS" gate --json) || status=$?
  if [ "$status" -eq 0 ] && [ "$(printf '%s' "$out" | jq -r .status)" = "override" ]; then
    local sha classes
    sha=$(git rev-parse --short HEAD)
    classes=$(printf '%s' "$out" | jq -r '[.unlifted[] | "`\(.key)`"] | join(", ")')
    record_site_patch_override "⚠️ \`REVIEW_LOOP_ALLOW_SITE_PATCH=1\` used at \`$sha\`: site patch pushed for $classes without the primitive fix."
  fi
  return "$status"
}

case "${1:?usage: open|churn|classes|gate|push|body|reply|resolve|status}" in
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
      | jq -r '[.[][] | select(.user.login | ascii_downcase | startswith("chatgpt-codex-connector"))]
          | group_by(.path)
          | map({ path: .[0].path,
                  rounds: ([.[].pull_request_review_id] | unique | length),
                  findings: length })
          | sort_by(-.rounds, -.findings)
          | .[]
          | "\(if .rounds >= 3 then "CHURN" else "ok   " end)  \(.rounds) rounds  \(.findings) findings  \(.path)"'
    # By CLASS. A file table misses the shape that actually runs away: one
    # invariant missing from a seam, reported at a different call site every
    # round, so no single file ever reaches 3. See review-churn.mjs.
    echo
    node_bin=$(runtime) && payload_json | "$node_bin" "$CHURN_JS" classify
    ;;
  classes)
    node_bin=$(runtime)
    payload_json | "$node_bin" "$CHURN_JS" classify ${2:+"$2"}
    ;;
  gate)
    # Exit 3 = REFRAME REQUIRED. Do not push a site patch past this; the next
    # commit is the primitive fix.
    run_gate
    ;;
  push)
    # The loop's push path. The gate runs first so a refusal costs nothing —
    # a site patch that reaches the remote has already generated next round.
    run_gate
    shift
    git push "$@"
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
                   | select(.user.login | ascii_downcase | startswith("chatgpt-codex-connector"))
                   | select(.submitted_at > $since)] | length')
    reaction=$(gh api --paginate --slurp "repos/$REPO/issues/$PR/reactions" \
      | jq --arg since "$since" \
           '[.[][] | select(.user.login | ascii_downcase | startswith("chatgpt-codex-connector"))
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
