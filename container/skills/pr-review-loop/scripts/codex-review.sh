#!/usr/bin/env bash
# Codex PR review-loop helpers. Run from inside the repo worktree, or set REPO/PR.
#
#   codex-review.sh open                      # unresolved Codex threads, TSV: thread_id, comment_id, file:line, outdated?, severity, title
#   codex-review.sh body <comment_id>         # full comment body for one finding
#   codex-review.sh churn                     # findings by file AND by class across rounds — the churn detector
#   codex-review.sh classes [--json]          # the class table alone (invariant signature @ seam)
#   codex-review.sh gate [--committed-only] [--head <sha>]
#                                             # REFRAME gate: exit 3 when a class has run 3 rounds unfixed
#   codex-review.sh push [git push args…]     # gate, then push — the loop's only push path
#   codex-review.sh reply <comment_id> <text> # reply on that thread
#   codex-review.sh resolve <thread_id>       # mark the thread resolved
#   codex-review.sh status <sha> <since_iso>  # codex=<pending|clean|findings|unavailable|head-changed> head=<sha> open=<n> review=<n> last_review_at=<iso|none> reaction=<n> last_thumbs_up_at=<iso|none> rounds=<n>
#   codex-review.sh wait <sha> <since_iso> [minutes]
#                                             # foreground GraphQL poll, default $CODEX_REVIEW_WAIT_MINUTES or 15
#                                             # open/status print a STOP banner at rounds>=4 — diagnose, do not push
#   codex-review.sh ci-wait --head <sha> [--timeout <sec>]
#                                             # wait for CI on exactly that head: 0 green, 29 red, 30 no run registered,
#                                             # 31 the PR conflicts with its base, 11 timeout, 12 head moved
#   codex-review.sh scope                     # risk-scoped repos: JSON {repo,pr,head,mode,verdict,labels,reason[,reviewClaims]} for the current head
#   codex-review.sh request                   # risk-scoped repos: post `@codex review` for the current head when every rule allows it
#   codex-review.sh merge-check [--head <sha>]
#                                             # exit 0 only when merging exactly that head is allowed
#   codex-review.sh merge --head <sha> [--method merge|squash]
#                                             # risk-scoped repos' only merge path: merge-check, then gh pr merge on its exit 0 alone
#   codex-review.sh audit                     # a merged PR as of its merge, by the merge-check rules of THIS copy; exit 28 = it bypassed the gate
#                                             # (review-thread resolution alone is read as it stands now; see the audit arm)
#   codex-review.sh receipt --head <sha> --outcome approve|changes --reviewer "<model + runtime>" --body-file <file>
#                                             # post a substitute review's receipt for exactly that head — --reviewer
#                                             # must start with a frontier model id (see REVIEWER_DENIED_TIERS)
#
# Exit codes, one contract across commands (0 and 3 are the originals):
#   0   pass; verdict printed; merge allowed. For merge-check, only `merge=allowed`
#   1   no verdict — a GitHub read or validation failed; never read it as a pass
#   2   usage, no JS runtime, or a push shape the churn gate cannot judge
#   3   REFRAME REQUIRED — the churn gate refused (gate, push, request)
#   10  wait: findings   11 wait/ci-wait: timeout   12 wait/ci-wait: head changed   13 wait: connector unavailable
#   20  request: not risk-scoped — automatic review handles this repo; never request
#   21  request: scope verdict is skip — this head merges on green CI, no round
#   22  request: a review of this head was already requested
#   23  request: REVIEW_ROUND_CAP reached — stop, summarize, escalate or reframe
#   24  merge-check: merging this head is not allowed — CI is not green on it, it has
#       neither a clean Codex review nor an approving substitute receipt, the
#       approving receipt's reviewer is not a frontier model id, it is a
#       fix PR whose body has no Fixes-PR line, or a substitute receipt on the PR
#       asked for changes and it neither adds docs/review-notes/<this PR>.md nor
#       carries a `Review-notes: none (<reason>)` line (`review_notes_missing`)
#   25  merge-check: the base branch moved while the check ran, or could not be
#       re-read, so the verdict may be stale — re-run merge-check
#   26  merge-check: `merge=defer mode=legacy` — not risk-scoped, so SKILL.md Step 6's
#       evidence rules decide this merge; never chain it into `gh pr merge`. With
#       `ci=host` it also says `admin=ready` or `admin=not-ready: <why>`
#       (admin_readiness); only `admin=ready` licenses `gh pr merge --admin`. A legacy
#       head still gets 24 first when a check GitHub marks required for the PR is red on it
#       (`required_red`) or the newest independent-review-receipt:v1 for it is not
#       CLEAR (`independent_receipt_not_clear`) — legacy_precheck
#   27  merge: merge-check allowed the head, but `gh pr merge` did not merge it
#   28  audit: merge-check would have refused this PR at its merge, or it merged by a
#       method the gate does not authorize (rebase or manual) — a gate bypass
#   29  ci-wait: CI finished red on the head (`ci_red`) — merge-check would refuse this
#       head with 24
#   30  ci-wait: no run registered — nothing at all, or no run of a required workflow, was
#       on the head within the registration window (`ci_missing`); waiting longer can't
#       help, so this is never a timeout
#   31  ci-wait: the PR conflicts with its base — GitHub runs no `pull_request` workflow
#       on a conflicting PR, so it fails fast rather than waiting out the window
#   `merge` passes merge-check's 1, 24, 25 (after one re-check) and 26 through unchanged,
#   and merges only on its 0.
#
# `gate` is the rule the advisory detector never was: three rounds on ONE
# finding class (or one seam, severity not falling) is a design defect at a
# seam, and the loop refuses another site patch until the primitive fix lands.
# It lifts on a commit that touches that primitive, or one whose message
# carries `Reframe: <invariant> enforced in <primitive>`.
# REVIEW_LOOP_ALLOW_SITE_PATCH=1 overrides it, loudly; `push` writes the
# override into the PR body once the push succeeds. `gate` alone writes
# nothing.
#
# The reviewer is `chatgpt-codex-connector` in GraphQL and
# `chatgpt-codex-connector[bot]` in REST, so every login match here is a
# case-insensitive prefix or regex, never equality against one spelling.
# Likewise `commit_id` comes back as a full 40-char SHA — matched with
# startswith so a short SHA still matches.
#
# The connector posts its capacity failure as an ordinary top-level PR comment,
# not as a finding. Match its stable, code-review-specific sentence at the
# start of a line. A generic "usage limit" matcher would let a real review that
# quotes code or documentation manufacture an unavailable verdict.
CODEX_REVIEW_USAGE_LIMIT_RE='(^|\n)\s*(?:you\s+have\s+reached\s+your\s+codex\s+usage\s+limits?\s+for\s+code\s+reviews?|codex\s+usage\s+limits?\s+have\s+been\s+reached\s+for\s+code\s+reviews?)\b'
set -euo pipefail

REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
# BRANCH resolves the PR from a named ref instead of the checkout. A caller that
# has pinned which branch it is about to push must get a verdict about THAT
# branch — `gh pr view` follows whatever is checked out at the moment it runs,
# which a sibling sharing the worktree can change underneath it. No open PR for
# the branch exits non-zero, which callers read as "no verdict", never as pass.
#
# One implementation, because the push path resolves a second time once it has
# parsed which branch the refspec actually updates — the checkout's branch and
# the pushed branch need not be the same, and a verdict about the wrong one is
# not a verdict.
#
# `--head` filters by branch NAME only ("<owner>:<branch>" syntax is not
# supported, per `gh pr list --help`), so a fork PR whose branch happens to
# share this name comes back alongside the first-party one; the source
# repository is what disambiguates, and it is matched explicitly. Every match
# is returned, not the first: one branch can have open PRs into two base
# branches, `--head` does not separate those either, and a push updates every
# one of them.
#
# The PR lives in the BASE repository, which is not always the one this clone
# points at — a fork clone's PR targets upstream — so the fork's parent is
# consulted when the fork itself has none. And the listing is bounded (`--limit`
# defaults to 30): the limit is raised and a full page is treated as possible
# truncation, which fails closed rather than gating a subset.
PR_LIST_LIMIT=200
resolve_pr_list() {
  local branch="$1" repo="$2" out
  out=$(gh pr list --repo "$repo" --head "$branch" --state open --limit "$PR_LIST_LIMIT" \
    --json number,headRepositoryOwner,headRepository \
    -q "[.[] | select(.headRepositoryOwner.login == \"${REPO%%/*}\" and .headRepository.name == \"${REPO##*/}\")] | .[].number")
  if [ "$(printf '%s' "$out" | grep -c .)" -ge "$PR_LIST_LIMIT" ]; then
    echo "branch $branch has at least $PR_LIST_LIMIT open PRs in $repo; the listing may be truncated and the gate will not judge a subset" >&2
    exit 1
  fi
  printf '%s' "$out"
}

# The base repository for this branch: this repo, or its parent when this is a
# fork with no PR of its own.
base_repo() {
  local parent
  if [ -n "$(resolve_pr_list "$1" "$REPO")" ]; then printf '%s' "$REPO"; return 0; fi
  parent=$(gh repo view "$REPO" --json parent -q 'if .parent then .parent.owner.login + "/" + .parent.name else "" end' 2>/dev/null || true)
  if [ -n "$parent" ] && [ -n "$(resolve_pr_list "$1" "$parent")" ]; then printf '%s' "$parent"; return 0; fi
  printf '%s' "$REPO"
}

if [ -z "${PR:-}" ] && [ -n "${BRANCH:-}" ]; then
  REPO=$(base_repo "$BRANCH")
  PR_LIST=$(resolve_pr_list "$BRANCH" "$REPO")
  [ -n "$PR_LIST" ] || { echo "no open PR for branch $BRANCH" >&2; exit 1; }
  PR=$(printf '%s\n' "$PR_LIST" | head -1)
fi
PR="${PR:-$(gh pr view --json number -q .number)}"
# An explicitly named PR is exactly one; a branch may have resolved to several.
PR_LIST="${PR_LIST:-$PR}"
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

# The status poll uses GraphQL for each connection rather than REST's separate
# /reviews and /reactions surfaces. Each connection paginates independently:
# `reviewThreads`, reviews, and reactions can all exceed one page at different
# times, so a shared cursor would either skip data or loop forever.
review_threads_page() {
  gh api graphql -f query='
    query($owner:String!,$name:String!,$pr:Int!,$after:String){
      repository(owner:$owner,name:$name){ pullRequest(number:$pr){
        headRefOid reviewThreads(first:100,after:$after){ pageInfo{hasNextPage endCursor} nodes{
          isResolved comments(first:1){ nodes{ author{login} pullRequestReview{id} } }
        } }
      } }
    }' \
    -F owner="$OWNER" -F name="$NAME" -F pr="$PR" -F after="$1"
}

reviews_page() {
  gh api graphql -f query='
    query($owner:String!,$name:String!,$pr:Int!,$after:String){
      repository(owner:$owner,name:$name){ pullRequest(number:$pr){
        headRefOid reviews(first:100,after:$after){ pageInfo{hasNextPage endCursor} nodes{
          author{login} submittedAt body commit{oid}
        } }
      } }
    }' \
    -F owner="$OWNER" -F name="$NAME" -F pr="$PR" -F after="$1"
}

comments_page() {
  gh api graphql -f query='
    query($owner:String!,$name:String!,$pr:Int!,$after:String){
      repository(owner:$owner,name:$name){ pullRequest(number:$pr){
        headRefOid comments(first:100,after:$after){ pageInfo{hasNextPage endCursor} nodes{
          author{login} createdAt lastEditedAt body
        } }
      } }
    }' \
    -F owner="$OWNER" -F name="$NAME" -F pr="$PR" -F after="$1"
}

reactions_page() {
  gh api graphql -f query='
    query($owner:String!,$name:String!,$pr:Int!,$after:String){
      repository(owner:$owner,name:$name){ pullRequest(number:$pr){
        headRefOid reactions(first:100,after:$after){ pageInfo{hasNextPage endCursor} nodes{
          content createdAt user{login}
        } }
      } }
    }' \
    -F owner="$OWNER" -F name="$NAME" -F pr="$PR" -F after="$1"
}

paginate_connection() {
  local connection="$1" page_fn="$2" cursor="null" page has_next next_cursor seen_cursors=$'\nnull\n'
  while :; do
    page=$("$page_fn" "$cursor") || {
      echo "GraphQL $connection request failed" >&2
      return 1
    }
    printf '%s\n' "$page"
    has_next=$(printf '%s' "$page" | jq -r ".data.repository.pullRequest.$connection.pageInfo.hasNextPage | if type == \"boolean\" then tostring else error(\"hasNextPage is not boolean\") end") || {
      echo "GraphQL $connection response is missing pagination metadata" >&2
      return 1
    }
    case "$has_next" in
      false) return 0 ;;
      true) ;;
      *)
        echo "GraphQL $connection pagination returned invalid hasNextPage=$has_next" >&2
        return 1
        ;;
    esac
    next_cursor=$(printf '%s' "$page" | jq -er ".data.repository.pullRequest.$connection.pageInfo.endCursor") || {
      echo "GraphQL $connection pagination returned no next cursor" >&2
      return 1
    }
    if [[ "$seen_cursors" == *$'\n'"$next_cursor"$'\n'* ]]; then
      echo "GraphQL $connection pagination repeated cursor $next_cursor" >&2
      return 1
    fi
    seen_cursors+="$next_cursor"$'\n'
    cursor="$next_cursor"
  done
}

# One complete observation of the exact pushed head. Review and reaction
# evidence must be newer than SINCE so a previous round cannot bless this one.
# Unresolved Codex threads intentionally have no date filter: an older thread
# remains open work until it is replied to and resolved. Under `audit`, review
# and reaction evidence newer than GATE_AS_OF (the merge) does not count either.
status_observation() {
  local sha="$1" since="$2" thread_pages review_pages comment_pages reaction_pages
  local observed_heads head_count head_changed head_oid open_count review_matches review_count last_review_at last_valid_review_at last_valid_verdict_at quota_matches quota_count last_usage_limit_at reaction_matches reaction_count last_thumbs_up_at rounds codex

  # Read verdict evidence before threads: a review submitted between these
  # requests must have its findings included before we can declare it clean.
  review_pages=$(paginate_connection reviews reviews_page) || return 1
  reaction_pages=$(paginate_connection reactions reactions_page) || return 1
  comment_pages=$(paginate_connection comments comments_page) || return 1
  thread_pages=$(paginate_connection reviewThreads review_threads_page) || return 1

  observed_heads=$(printf '%s\n%s\n%s\n%s\n' "$thread_pages" "$review_pages" "$comment_pages" "$reaction_pages" | jq -ers '
    [ .[] | .data.repository.pullRequest.headRefOid ] | unique') || return 1
  head_count=$(printf '%s' "$observed_heads" | jq -er 'length') || return 1
  if [ "$head_count" -eq 0 ]; then
    echo "GraphQL poll did not return a PR head" >&2
    return 1
  fi
  if [ "$head_count" -ne 1 ]; then
    head_oid=inconsistent
    head_changed=1
  else
    head_oid=$(printf '%s' "$observed_heads" | jq -er '.[0]') || return 1
    if [[ "$head_oid" != "$sha"* ]]; then head_changed=1; else head_changed=0; fi
  fi

  open_count=$(printf '%s\n' "$thread_pages" | jq -s '
    [ .[] | .data.repository.pullRequest.reviewThreads.nodes[]
      | select(.isResolved | not)
      | select((.comments.nodes[0].author.login // "") | ascii_downcase | startswith("chatgpt-codex-connector"))
    ] | length') || return 1
  rounds=$(printf '%s\n' "$thread_pages" | jq -s '
    [ .[] | .data.repository.pullRequest.reviewThreads.nodes[]
      | select((.comments.nodes[0].author.login // "") | ascii_downcase | startswith("chatgpt-codex-connector"))
      | .comments.nodes[0].pullRequestReview.id // empty
    ] | unique | length') || return 1
  review_matches=$(printf '%s\n' "$review_pages" | jq -cs --arg sha "$head_oid" --arg since "$since" --arg until "$GATE_AS_OF" --arg usageLimitRe "$CODEX_REVIEW_USAGE_LIMIT_RE" '
    [ .[] | .data.repository.pullRequest.reviews.nodes[]
      | select((.author.login // "") | ascii_downcase | startswith("chatgpt-codex-connector"))
      | select((.commit.oid // "") | startswith($sha))
      | select(.submittedAt != null and .submittedAt > $since)
      | select($until == "" or .submittedAt <= $until)
      | select((.body // "") | test($usageLimitRe; "i") | not)
    ]') || return 1
  review_count=$(printf '%s' "$review_matches" | jq -er 'length') || return 1
  last_valid_review_at=$(printf '%s' "$review_matches" | jq -er '([.[].submittedAt] | max) // "none"') || return 1
  last_review_at=$(printf '%s\n' "$review_pages" | jq -ers '
    ([ .[] | .data.repository.pullRequest.reviews.nodes[]
       | select((.author.login // "") | ascii_downcase | startswith("chatgpt-codex-connector"))
       | .submittedAt
     ] | max) // "none"') || return 1
  reaction_matches=$(printf '%s\n' "$reaction_pages" | jq -cs --arg since "$since" --arg until "$GATE_AS_OF" '
    [ .[] | .data.repository.pullRequest.reactions.nodes[]
      | select((.user.login // "") | ascii_downcase | startswith("chatgpt-codex-connector"))
      | select(.content == "THUMBS_UP")
      | select(.createdAt > $since)
      | select($until == "" or .createdAt <= $until)
    ]') || return 1
  reaction_count=$(printf '%s' "$reaction_matches" | jq -er 'length') || return 1
  last_thumbs_up_at=$(printf '%s\n' "$reaction_pages" | jq -ers --arg until "$GATE_AS_OF" '
    ([ .[] | .data.repository.pullRequest.reactions.nodes[]
       | select((.user.login // "") | ascii_downcase | startswith("chatgpt-codex-connector"))
       | select(.content == "THUMBS_UP")
       | select($until == "" or .createdAt <= $until)
       | .createdAt
     ] | max) // "none"') || return 1
  last_valid_verdict_at="$last_valid_review_at"
  if [ "$last_thumbs_up_at" != "none" ] && { [ "$last_valid_verdict_at" = "none" ] || [[ "$last_thumbs_up_at" > "$last_valid_verdict_at" ]]; }; then
    last_valid_verdict_at="$last_thumbs_up_at"
  fi
  quota_matches=$(printf '%s\n%s\n' "$review_pages" "$comment_pages" | jq -cs --arg sha "$head_oid" --arg since "$since" --arg until "$GATE_AS_OF" --arg usageLimitRe "$CODEX_REVIEW_USAGE_LIMIT_RE" '
    [ .[] | .data.repository.pullRequest as $pr
      | ($pr.reviews.nodes[]?
          | select((.author.login // "") | ascii_downcase | startswith("chatgpt-codex-connector"))
          | select((.commit.oid // "") | startswith($sha))
          | select(.submittedAt != null and .submittedAt > $since)
          | select($until == "" or .submittedAt <= $until)
          | select((.body // "") | test($usageLimitRe; "i"))
          | { at: .submittedAt })
      , ($pr.comments.nodes[]?
          | select((.author.login // "") | ascii_downcase | startswith("chatgpt-codex-connector"))
          | select(.createdAt != null and .createdAt > $since)
          | select($until == "" or .createdAt <= $until)
          | select((.body // "") | test($usageLimitRe; "i"))
          | { at: .createdAt })
    ]') || return 1
  quota_count=$(printf '%s' "$quota_matches" | jq -er 'length') || return 1
  last_usage_limit_at=$(printf '%s' "$quota_matches" | jq -er '([.[].at] | max) // "none"') || return 1

  if [ "$head_changed" -eq 1 ]; then
    codex=head-changed
  elif [ "$open_count" -gt 0 ]; then
    codex=findings
  elif [ "$quota_count" -gt 0 ] && { [ "$last_valid_verdict_at" = "none" ] || [[ "$last_usage_limit_at" > "$last_valid_verdict_at" ]]; }; then
    codex=unavailable
  elif [ "$review_count" -gt 0 ] || [ "$reaction_count" -gt 0 ]; then
    codex=clean
  else
    codex=pending
  fi
  rounds_banner "$rounds"
  if [ "$codex" = unavailable ]; then
    echo "codex=$codex reason=usage_limit head=$head_oid open=$open_count review=$review_count last_review_at=$last_review_at reaction=$reaction_count last_thumbs_up_at=$last_thumbs_up_at rounds=$rounds"
  else
    echo "codex=$codex head=$head_oid open=$open_count review=$review_count last_review_at=$last_review_at reaction=$reaction_count last_thumbs_up_at=$last_thumbs_up_at rounds=$rounds"
  fi
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
#
# Evaluating the gate writes NOTHING. The override line claims a site patch was
# pushed, so only `push` records it, and only after the push succeeds — a
# rejected push must not leave that claim in the PR body. `run_gate` just hands
# the line back in GATE_OVERRIDE_LINE.
#
# Every PR in PR_LIST is judged, and the first refusal is the answer. A push
# updates every open PR whose head is this branch, so a verdict from one of
# them is not a verdict about the push — this is the seam both `gate` and
# `push` route through, which is why the loop lives here and not in either
# caller. Override lines come back per PR in GATE_OVERRIDE_LINES, tab-separated
# as `<pr>\t<line>`, since each PR body records its own.
GATE_OVERRIDE_LINE=""
GATE_OVERRIDE_LINES=()
PUSH_HEAD=""
PUSH_DEST=""
PUSH_DRY_RUN=0
run_gate() {
  local node out status=0 sha classes pr saved_pr="$PR"
  GATE_OVERRIDE_LINE=""
  GATE_OVERRIDE_LINES=()
  node=$(runtime) || return 2
  for pr in $PR_LIST; do
    PR="$pr"
    status=0
    out=$(payload_json | "$node" "$CHURN_JS" gate --json "$@") || status=$?
    if [ "$status" -ne 0 ]; then
      PR="$saved_pr"
      return "$status"
    fi
    if [ "$(printf '%s' "$out" | jq -r .status)" = "override" ]; then
      sha=$(git rev-parse --short "${PUSH_HEAD:-HEAD}")
      classes=$(printf '%s' "$out" | jq -r '[.unlifted[] | "`\(.key)`"] | join(", ")')
      GATE_OVERRIDE_LINE="⚠️ \`REVIEW_LOOP_ALLOW_SITE_PATCH=1\` used at \`$sha\`: site patch pushed for $classes without the primitive fix."
      GATE_OVERRIDE_LINES+=("$pr"$'\t'"$GATE_OVERRIDE_LINE")
    fi
  done
  PR="$saved_pr"
  return 0
}

# ── Risk-scoped repos ────────────────────────────────────────────────────────
# A repo opts in by naming `risk:high` in .github/labeler.yml on the PR's BASE
# branch. There Codex automatic review is off, a round happens
# only when `request` asks for one, and `scope` decides whether a head needs
# one by matching the PR's changed files against those globs itself
# (risk-scope.jq). The `Risk label` workflow puts the same answer on the PR as
# a label for people to read; the gate never takes a missing label as an
# answer. `risk:high` or `review:requested` being present adds review, and
# nothing takes it away. Every other repo is legacy: `scope` answers `auto`,
# `request` refuses, `merge-check` defers once legacy_precheck finds nothing to
# refuse, and no command above this block reads any of it.
RISK_LABEL_WORKFLOW='Risk label'
# release-policy.py's own contexts are a policy gate, not CI: a pending human approval must never read as ci_pending.
CI_EXCLUDED_CONTEXTS='["Release policy","Release approval"]'
# The commit status run-host-ci.sh posts: the repository's declared CI, run on
# a host against the exact head. It stands in for a required Actions workflow
# only when GitHub never started that workflow's jobs (never_started_runs);
# otherwise it is one more status, and red when it is red. What "never started"
# means is never-started.jq.
HOST_CI_CONTEXT='CI (host)'
# The request marker, hidden in the rendered comment. It is how `request`
# dedupes per head and counts rounds, and how `merge-check` learns when THIS
# head's review was asked for. Its existing creation timestamp is also the
# connector review's advisory claim start, so this marker stays unchanged.
REQUEST_MARKER_RE='(^|\n)<!-- pr-review-loop:request head=(?<head>[0-9a-f]{40}) round=(?<round>[0-9]+) -->'
# A local review must claim itself deliberately. GitHub comment authors are
# not enough: this installation uses one account for several agent sessions,
# so `owner` is a required bounded session/operator label. Comment claims are
# advisory only -- they never authorize, refuse, or otherwise gate a merge.
CLAIM_MARKER_RE='(^|\n)<!-- pr-review-loop:claim id=(?<id>[A-Za-z0-9._:-]{1,96}) repo=(?<repo>[^[:space:]]+) pr=(?<pr>[1-9][0-9]*) head=(?<head>[0-9a-f]{40}) owner=(?<owner>[A-Za-z0-9._:-]{1,64}) started=(?<started>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z) expires=(?<expires>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z) -->'
# A receipt retires only the particular claim and owner it names. Another
# review's same-head receipt must not hide a separate ongoing review.
CLAIM_COMPLETE_MARKER_RE='(^|\n)<!-- pr-review-loop:claim-complete id=(?<id>[A-Za-z0-9._:-]{1,96}) owner=(?<owner>[A-Za-z0-9._:-]{1,64}) head=(?<head>[0-9a-f]{40}) -->'
REVIEW_CLAIM_DEFAULT_TTL_MINUTES=45
REVIEW_CLAIM_MAX_TTL_MINUTES=120
# A substitute review's receipt (docs/review-policy.md, "Review availability").
# When Codex cannot review, the latest receipt for exactly this head decides
# instead. Only an author with write access counts: a receipt unlocks a merge,
# and anyone who can read a public repo can comment on its PRs.
RECEIPT_MARKER_RE='(^|\n)<!-- pr-review-loop:substitute-receipt head=(?<head>[0-9a-f]{40}) outcome=(?<outcome>approve|changes) -->'
# A review desk's receipt, which no command here writes: the marker on its own
# line, then one fenced JSON object carrying `head`, `verdict` and
# `blocking_findings`. The repo that uses it owns the full field contract; the
# legacy precheck (independent_receipt_state) reads only those three.
INDEPENDENT_RECEIPT_MARKER_RE='(^|\n)<!-- independent-review-receipt:v1 -->[ \t]*\r?(?=\n|\z)'
INDEPENDENT_RECEIPT_JSON_RE='\A\s*```json[ \t]*\r?\n(?<json>[\s\S]*?)\n[ \t]*```'
# The receipt body's human-readable "who reviewed" line, used to recover the
# reviewer text for a model-allowlist check — the marker itself carries only
# head/outcome, never the reviewer, so this is read separately from the body
# `receipt` has always written. A receipt posted before the allowlist gate
# existed still carries this line; it passes the gate only if its FIRST token
# already names a frontier model (reviewer_model_refusal) — otherwise post a
# fresh receipt (`codex-review.sh receipt ...`) from one.
RECEIPT_REVIEWER_LINE_RE='\*\*Reviewer and runtime:\*\* (?<reviewer>[^\n]+)'
# A conventional-commit fix title, and the body line `merge-check` requires of
# one: the PR it fixes, or `none`. The follow-up measurement in
# docs/specs/risk-based-review/plan.md links a fix to its PR through this line.
FIX_TITLE_RE='^\s*fix(\([^)]*\))?!?:'
FIXES_PR_LINE_RE='(^|\n)Fixes-PR:[ \t]*(#[0-9]+|none)\b'
# The review-notes rule (docs/review-policy.md, "Review notes and fix links"):
# a PR any substitute receipt asked for changes on adds a current-PR fragment
# under REVIEW_NOTES_DIR, or its body carries this line, read the way the Fixes-PR
# line is (review_notes_state). The reason is ONE parenthesised phrase, with no
# parenthesis inside it and nothing after it on the line, so `none ()x)` and
# `none ( ) )` never pass for one; review_notes_state strips every \p{Cf}
# (format) character from the reason first — a soft hyphen or an emoji ZWJ
# sequence must not sink an otherwise-visible reason — then requires at least
# one character that is not whitespace, a control character, a combining mark
# with no base of its own, or one of the specific blank-looking codepoints
# U+2800/U+3164/U+115F/U+1160/U+FFA0 (real_reason, #707 P3-b).
REVIEW_NOTES_FILE='docs/review-notes.md'
REVIEW_NOTES_DIR='docs/review-notes'
REVIEW_NOTES_NONE_LINE_RE='(^|\n)Review-notes:[ \t]*none[ \t]*\((?<reason>[^()\n]*)\)[ \t]*\r?(?=\n|\z)'
# Looser than REVIEW_NOTES_NONE_LINE_RE: matches an attempted line (up to end
# of line, whatever its shape) so review_notes_state can name which shape rule
# it failed, rather than a blanket "no verdict" (#707 P3-c).
REVIEW_NOTES_NONE_CANDIDATE_RE='(^|\n)Review-notes:[ \t]*none[ \t]*\((?<rest>[^\n]*)'
# Unanchored so it also finds an attempt GitHub's own line breaks would not
# otherwise show as line-initial — an inline HTML comment ("<!-- Review-notes:
# none (x) -->") never starts a physical line, so REVIEW_NOTES_NONE_CANDIDATE_RE's
# line anchor cannot see it either. Used only to tell "hidden by a fence or
# comment" apart from "no line at all", never to parse the reason itself.
REVIEW_NOTES_NONE_ANYWHERE_RE='Review-notes:[ \t]*none[ \t]*\('
# Splits a candidate's `rest` (everything after `none (`) into the reason and
# whatever follows the closing parenthesis, without jq's `index`/slice, which
# disagree on offsets below jq 1.8: `index` counts bytes, a slice counts
# codepoints, so a non-ASCII reason (multi-byte UTF-8) misaligned them and cut
# the reason short (#713 P3). No match at all — no unescaped `)`, or a `(`
# before one — means an unmatched or nested parenthesis, read by capture's
# empty result rather than a byte offset.
REVIEW_NOTES_REASON_SPLIT_RE='^(?<reason>[^()]*)\)(?<trailing>.*)$'

# `missing` when a fix title's body has no Fixes-PR line, else `ok`, for a
# {title, body} JSON object on stdin — merge-check's rule, and audit's. A line
# inside a code fence or an HTML comment is an example or a template, not a
# link, so both are cut first (pr_body_text, pr-body.jq).
fix_link_state() {
  jq -r -L "$HERE" --arg titleRe "$FIX_TITLE_RE" --arg lineRe "$FIXES_PR_LINE_RE" '
    include "pr-body";
    # pr_body_text checks its own shape inside pr-body.jq, but a stub or
    # replacement module can drop that check along with the rest of the
    # module (#707 P3-a). The boolean `and` below short-circuits away from
    # ever touching $body when the title is not a fix title, so a
    # wrong-typed pr_body_text on a feat PR would otherwise never surface as
    # an error — assert the shape up front, before ever reading .title,
    # whenever pr_body_text yields exactly one value of the wrong type.
    # Empty or doubled output is left alone: the case statement in each
    # caller of this function still reads that as "no verdict", same as before.
    (
      [pr_body_text] as $pr_body
      | if ($pr_body | length) == 1 and ($pr_body[0] | type) != "string"
        then error("pr_body_text (pr-body.jq) must yield exactly one string, got \($pr_body[0])")
        else empty end
    ),
    (
      pr_body_text as $body
      | if (.title | test($titleRe; "i")) and ($body | test($lineRe; "i") | not) then "missing" else "ok" end
    )'
}

# Reviewer eligibility is a tier rule stated as a DENYLIST: any model may write
# or unlock a receipt unless its id names a small tier. There is deliberately no
# list of approved models — vendors ship new frontier models constantly, and an
# allowlist refused every one of them until someone edited it (docs/review-policy.md).
# Matching is on whole id segments (split on `-`, `.`, `_`), never substrings:
# `mini` must refuse `gpt-5.4-mini` without refusing `gemini-3.8-flash`. `flash`
# is absent on purpose — it is a latency brand that spans tiers (DeepSeek and
# Gemini ship frontier `-flash` models), unlike `lite`/`mini`/`nano`, which mark a
# small model within its own family.
#
# The trade-off is stated, not hidden: a denylist fails OPEN. A new small model
# whose name carries none of these words passes until it is added here.
#
# The list lives in this script rather than a sibling file, so this one file
# carries the whole rule. The caller must still run main's copy at main's
# CURRENT tip — never the PR branch's (a PR could otherwise edit its own way
# past the gate) and never a stale checkout. The supported way:
#   SP=<scratch dir>
#   git -C <repo> fetch origin main
#   mkdir -p "$SP" && git -C <repo> archive origin/main container/skills/pr-review-loop | tar -x -C "$SP"
#   "$SP"/container/skills/pr-review-loop/scripts/codex-review.sh ...
REVIEWER_DENIED_TIERS=(sonnet haiku luna terra mini nano lite small)

# Prints why free-text $1 may not name a reviewer, or nothing when it may. Only
# the FIRST whitespace-delimited token is read — the documented receipt format
# leads with the model id (SKILL.md, review-policy.md) — so "claude-sonnet-5
# (fallback from claude-opus-5)" is refused even though it mentions a frontier id
# later. That token is lowercased, loses a trailing `[1m]` context-window suffix,
# and loses any provider path (`opencode/`, `opencode-go/`, `nvidia/mistralai/`),
# which names the route, not the model. What remains must be a concrete versioned
# id: id characters only, starting with a letter or digit, containing a digit. A
# bare alias ("opus", "inherit") names whatever the runtime defaults to, not the
# model that ran, so a receipt must record the id the runtime reported. Every
# comparison is pure bash, so no token is ever handed to an external command as
# an argument (no "-V"/"--help" smuggling).
reviewer_model_refusal() {
  local text="${1:-}" first id seg denied
  local -a segs=()
  first="${text%%[[:space:]]*}"
  id=$(printf '%s' "$first" | tr '[:upper:]' '[:lower:]')
  id="${id%\[1m\]}"
  id="${id##*/}"
  if [[ ! "$id" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || [[ ! "$id" =~ [0-9] ]]; then
    printf '"%s" is not a concrete versioned model id — lead with the id the runtime reported (e.g. claude-opus-5), not an alias or a display name' "$first"
    return 0
  fi
  IFS='-._' read -r -a segs <<< "$id"
  for seg in "${segs[@]}"; do
    for denied in "${REVIEWER_DENIED_TIERS[@]}"; do
      if [ "$seg" = "$denied" ]; then
        printf '"%s" is a %s-tier model; reviewers must be frontier-tier (denied tiers: %s)' "$first" "$denied" "${REVIEWER_DENIED_TIERS[*]}"
        return 0
      fi
    done
  done
}

reviewer_model_allowed() {
  [ -z "$(reviewer_model_refusal "${1:-}")" ]
}

# Sets SCOPE_MODE to `risk-scoped` or `legacy`, and LABELER_YML to the file it
# read, so the globs come from the same read as the mode. Read from BASE
# through the API, never the checkout, since a PR can edit its own copy, and
# only at the commit scope_eval resolved the base branch to, never by name.
# The file is absent (legacy) only on GitHub's plain path-not-found 404, which
# on a commit just resolved means that commit has no labeler.yml. A ref GitHub
# cannot find is a 404 too ("No commit found for the ref ..."), and that, like
# any other failure, returns non-zero for the caller to fail closed on. gh
# prints the error body on stdout.
#
# Detection is deliberately loose and parsing (risk-scope.jq) deliberately
# strict. Any doubt is risk-scoped: `risk:high` anywhere in the file, or any
# backslash, since a double-quoted YAML key can spell risk:high with escapes
# ("\x72isk:high") or an escaped line break, and the labeler decodes those. An
# indented document or an explicit `? risk:high` key is valid YAML too. A form
# the reader cannot parse fails closed to `review`, never through to legacy.
LABELER_YML=""
repo_mode() {
  local raw status=0
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || return 1
  raw=$(gh api -H 'Accept: application/vnd.github.raw+json' "repos/$REPO/contents/.github/labeler.yml?ref=$1" 2>/dev/null) || status=$?
  if [ "$status" -ne 0 ]; then
    if printf '%s' "$raw" | jq -e '.status == "404" and .message == "Not Found"' >/dev/null 2>&1; then
      SCOPE_MODE=legacy
      LABELER_YML=""
      return 0
    fi
    echo "could not read .github/labeler.yml at $1 in $REPO" >&2
    return 1
  fi
  LABELER_YML="$raw"
  if printf '%s\n' "$raw" | grep -qF -e 'risk:high' -e '\'; then
    SCOPE_MODE=risk-scoped
  else
    SCOPE_MODE=legacy
  fi
}

# Sets SCOPE_HEAD SCOPE_MODE SCOPE_VERDICT SCOPE_LABELS SCOPE_REASON for the
# PR's current head. Returns 1 only when there is no verdict at all.
#
# The verdict is computed from the diff, never read off a label: a label says
# only what whoever last edited it wanted, and a PR's own workflow can be the
# editor. `review` when a changed file matches a risk:high glob from BASE's
# labeler.yml — its path, or for a rename its old path too, since moving a file
# off a risky path changes that path — or when risk:high or review:requested is
# on the PR. Anything that keeps the files from being judged is `review` as
# well: a failed listing, one at GitHub's 300-file cap for a comparison or not
# matching the PR's file count, a head that moved while they were read, and a
# labeler.yml risk-scope.jq cannot read.
SCOPE_HEAD=""
SCOPE_BASE=""
SCOPE_BASE_REF=""
SCOPE_MODE=""
SCOPE_VERDICT=""
SCOPE_LABELS="[]"
SCOPE_REASON=""
# The post-image paths this head changes, as a JSON array, from the same pinned
# comparison and the same completeness checks the verdict reads; `null` when
# that listing was not read or did not pass them (every fail-closed return in
# scope_eval, and a legacy repo, which never lists files). The review-notes
# rule reads it, and never reads `null` as a touch.
SCOPE_FILES=null

# `audit` alone sets these, to judge a merged PR as of its merge: the commit it
# merged onto, the moment its evidence must predate, and the labels it had then
# (a JSON array of names). Assigned here rather than read from the environment,
# so no caller of merge-check can pin its base, backdate its evidence or name
# its labels.
SCOPE_PIN_BASE=""
GATE_AS_OF=""
GATE_LABELS=""

# The PR JSON $1, with the labels the PR had at its merge in place of the ones
# gh reports now, once `audit` has set them.
labels_as_of() {
  if [ -z "$GATE_LABELS" ]; then printf '%s' "$1"; return 0; fi
  printf '%s' "$1" | jq -c --argjson names "$GATE_LABELS" '.labels = [ $names[] | { name: . } ]'
}

# The commit branch $1 points at now, or non-zero.
base_tip() {
  gh api "repos/$REPO/git/ref/heads/$(jq -rn --arg r "$1" '$r | split("/") | map(@uri) | join("/")')" \
    | jq -er '.object.sha | strings | select(test("^[0-9a-f]{40}$"))'
}

scope_eval() {
  local pr_json base files after decision
  SCOPE_FILES=null
  pr_json=$(gh pr view "$PR" --repo "$REPO" --json headRefOid,baseRefName,labels) || return 1
  pr_json=$(labels_as_of "$pr_json") || return 1
  SCOPE_HEAD=$(printf '%s' "$pr_json" | jq -er .headRefOid) || return 1
  base=$(printf '%s' "$pr_json" | jq -er .baseRefName) || return 1
  SCOPE_LABELS=$(printf '%s' "$pr_json" | jq -c '[.labels[]?.name]') || return 1
  # The base branch as one commit, resolved once. labeler.yml and the comparison
  # both read that commit, so the globs and the file list come from one base
  # even when the branch moves between the reads. Not the PR's baseRefOid: that
  # is the base tip as of the PR's last push (REST `base.sha`), so a rule main
  # has added since would not bind an open PR until its author pushed again.
  # Any doubt about the base is risk-scoped and `review`, never `legacy`.
  # `audit` pins the base to the commit a merged PR merged onto instead.
  SCOPE_BASE_REF="$base"
  if [ -n "$SCOPE_PIN_BASE" ]; then
    SCOPE_BASE="$SCOPE_PIN_BASE"
  else
    SCOPE_BASE=$(base_tip "$base") || {
      SCOPE_MODE=risk-scoped
      SCOPE_VERDICT=review
      SCOPE_REASON="fail closed: could not resolve base branch $base to a commit"
      return 0
    }
  fi
  repo_mode "$SCOPE_BASE" || {
    SCOPE_MODE=risk-scoped
    SCOPE_VERDICT=review
    SCOPE_REASON="fail closed: could not read .github/labeler.yml at $SCOPE_BASE"
    return 0
  }
  if [ "$SCOPE_MODE" = legacy ]; then
    SCOPE_VERDICT=auto
    SCOPE_REASON="no risk:high in .github/labeler.yml on $base; automatic review handles this repo"
    return 0
  fi
  SCOPE_VERDICT=review
  # The files come from a comparison pinned to the head SHA read above, so they
  # are that commit's files and no other's. `pulls/<n>/files` is not pinned: it
  # lists whatever the head is when it is served, so a head pushed away and back
  # between the two head reads would pass another commit's files off as this
  # one's. A comparison lists its files on the first page only, at most 300 of
  # them (docs.github.com/en/rest/commits/commits#compare-two-commits), so
  # per_page=1 only trims the commit list.
  files=$(gh api "repos/$REPO/compare/$SCOPE_BASE...$SCOPE_HEAD?per_page=1") || {
    SCOPE_REASON="fail closed: could not list the files this head changes"
    return 0
  }
  # Head, labels and file count in ONE read, after the listing. The files are
  # already this head's; a head that has moved since means the verdict is about
  # a commit the PR no longer has.
  pr_json=$(gh pr view "$PR" --repo "$REPO" --json headRefOid,labels,changedFiles) || return 1
  pr_json=$(labels_as_of "$pr_json") || return 1
  after=$(printf '%s' "$pr_json" | jq -er .headRefOid) || return 1
  SCOPE_LABELS=$(printf '%s' "$pr_json" | jq -c '[.labels[]?.name]') || return 1
  if [ "$after" != "$SCOPE_HEAD" ]; then
    SCOPE_REASON="fail closed: the head moved from $SCOPE_HEAD while its changed files were listed"
    SCOPE_HEAD="$after"
    return 0
  fi
  # The comparison goes through stdin, not --argjson: with its patches it can
  # exceed the kernel's per-argument limit. The reason names the first few
  # matches. complete_listing is every check that makes the verdict fail
  # closed on the listing, defined once so the `files` this also returns (for
  # SCOPE_FILES) have passed exactly the checks the verdict's files did.
  decision=$(printf '%s' "$files" | jq -c -L "$HERE" --arg yml "$LABELER_YML" --argjson pr "$pr_json" '
    include "risk-scope";
    def complete_listing:
      if (.files | type) == "array" then .files else error("the comparison lists no files") end
      | if all(.[]; (.filename | type) == "string") then . else error("a changed file has no filename") end
      | ([ .[].filename ] | unique | length) as $listed
      | if $listed >= 300 then error("the comparison lists \($listed) files, the most GitHub lists, so some may be missing")
        elif ($pr.changedFiles | type) != "number" then error("GitHub did not say how many files this PR changes")
        elif $pr.changedFiles != $listed then error("the PR changes \($pr.changedFiles) files but the comparison lists \($listed)")
        else . end;
    [ $pr.labels[]?.name | select(. == "risk:high" or . == "review:requested") | "labeled \(.)" ] as $labeled
    | (try (complete_listing | [ .[] | select(.status != "removed") | .filename ]) catch null) as $present
    | (try (
        ($yml | risk_high_globs | map(glob_regex)) as $regexes
        | complete_listing
        | [ .[] | .filename, (.previous_filename // empty) ] | unique | matching($regexes)
        | if length == 0 then []
          else [ "changes risk:high path\(if length > 1 then "s" else "" end) \(.[:3] | join(", "))\(if length > 3 then " and \(length - 3) more" else "" end)" ] end
      ) catch [ "fail closed: \(.)" ])
    | . + $labeled
    | if length == 0 then { verdict: "skip", reason: "no changed file matches a risk:high glob in .github/labeler.yml, and neither risk:high nor review:requested is on the PR" }
      else { verdict: "review", reason: join("; ") } end
    | .files = $present') || return 1
  SCOPE_VERDICT=$(printf '%s' "$decision" | jq -er .verdict) || return 1
  SCOPE_REASON=$(printf '%s' "$decision" | jq -er .reason) || return 1
  SCOPE_FILES=$(printf '%s' "$decision" | jq -c .files) || return 1
}

# merge-check's last read before it allows a merge. `gh pr merge
# --match-head-commit` pins the head, but GitHub's merge endpoint takes no base
# SHA, so a verdict computed against one base commit could merge after the
# branch has moved on, say to a labeler.yml with a new glob. Re-reading the base
# here narrows that to the seconds between this read and the merge call; it
# cannot close it (SKILL.md, Risk-scoped repos). Exit 25 when the branch no
# longer points at the commit the verdict read, or cannot be re-read.
refuse_if_base_moved() {
  local now
  now=$(base_tip "$SCOPE_BASE_REF") || now=unreadable
  if [ "$now" != "$SCOPE_BASE" ]; then
    echo "merge=refused head=$SCOPE_HEAD base=${SCOPE_BASE:-unresolved}: base moved during check ($SCOPE_BASE_REF is now $now); re-run merge-check" >&2
    exit 25
  fi
}

# Review requests `request` has posted on this PR, oldest first:
# [{head, round, at}]. Read through the same paginated connection `status` uses.
# Under `audit`, a request made after GATE_AS_OF (the merge) never happened, and
# one edited since is not read: its text at the merge is unknown, and dropping
# it can only move the first request for a head later, or remove it.
request_markers() {
  local pages
  pages=$(paginate_connection comments comments_page) || return 1
  printf '%s\n' "$pages" | jq -cs --arg re "$REQUEST_MARKER_RE" --arg asof "$GATE_AS_OF" '
    [ .[] | .data.repository.pullRequest.comments.nodes[]
      | .createdAt as $at
      | select($asof == "" or ($at <= $asof and (.lastEditedAt // "") <= $asof))
      | [ (.body // "") | capture($re) ] | first // empty
      | { head, round: (.round | tonumber), at: $at } ]
    | sort_by(.at)'
}

# Live review claims for one exact PR head. This is coordination visibility,
# not review evidence: invalid or unreadable comments disappear from this
# advisory view, and a failed read must never change a gate decision.
live_review_claims() {
  local head="$1" now="$2" comment_pages review_pages reaction_pages
  comment_pages=$(paginate_connection comments comments_page) || return 1
  review_pages=$(paginate_connection reviews reviews_page) || return 1
  reaction_pages=$(paginate_connection reactions reactions_page) || return 1
  printf '%s\n%s\n%s\n' "$comment_pages" "$review_pages" "$reaction_pages" | jq -cs \
    --arg claimRe "$CLAIM_MARKER_RE" \
    --arg requestRe "$REQUEST_MARKER_RE" \
    --arg completeRe "$CLAIM_COMPLETE_MARKER_RE" \
    --arg receiptRe "$RECEIPT_MARKER_RE" \
    --arg repo "$REPO" --arg pr "$PR" --arg head "$head" --arg now "$now" \
    --argjson defaultTtl "$REVIEW_CLAIM_DEFAULT_TTL_MINUTES" \
    --argjson maxTtl "$REVIEW_CLAIM_MAX_TTL_MINUTES" '
      def epoch: try fromdateiso8601 catch null;
      ($now | epoch) as $nowEpoch
      | if $nowEpoch == null then error("invalid current claim time") else . end
      | [ .[] | .data.repository.pullRequest.comments.nodes[]? ] as $comments
      | [ .[] | .data.repository.pullRequest.reviews.nodes[]? ] as $reviews
      | [ .[] | .data.repository.pullRequest.reactions.nodes[]? ] as $reactions
      | (
          [ $comments[]
            | (.body // "") as $body
            | ((.author.login // "unknown") | tostring) as $actor
            | (try ($body | capture($claimRe)) catch empty)
            | select(.repo == $repo and .pr == $pr)
            | {id, owner, head, started, expires, actor: $actor, kind: "explicit"}
          ]
          +
          [ $comments[]
            | (.body // "") as $body
            | (.createdAt // "") as $at
            | ((.author.login // "unknown") | tostring) as $actor
            | (try ($body | capture($requestRe)) catch empty)
            | $at as $started
            | (try (($started | fromdateiso8601 + ($defaultTtl * 60)) | strftime("%Y-%m-%dT%H:%M:%SZ")) catch "") as $expires
            | select($expires != "")
            | {id: ("connector-" + .round + "-" + ($started | gsub("[^0-9]"; ""))),
               owner: "connector", head, started: $started, expires: $expires, actor: $actor, kind: "connector"}
          ]
        ) as $claims
      | [ $comments[]
          | (.body // "") as $body
          | (.createdAt // "") as $at
          | (try ($body | capture($completeRe)) catch empty)
          | . as $complete
          | (try ($body | capture($receiptRe)) catch empty) as $receipt
          | select($receipt.head == $complete.head)
          | ($at | epoch) as $atEpoch
          | select($atEpoch != null)
          | {id, owner, head, atEpoch: $atEpoch}
        ] as $completed
      | [ $claims[]
          | . as $claim
          | ($claim.started | epoch) as $startedEpoch
          | ($claim.expires | epoch) as $expiresEpoch
          | select($claim.head == $head)
          | select($startedEpoch != null and $expiresEpoch != null)
          | select($startedEpoch <= $nowEpoch and $expiresEpoch > $startedEpoch)
          | select(
              ($expiresEpoch - $startedEpoch) <=
                ((if $claim.kind == "connector" then $defaultTtl else $maxTtl end) * 60)
              and $expiresEpoch > $nowEpoch
            )
          | . as $claim
          | select(any($completed[]?;
              .id == $claim.id and .owner == $claim.owner and .head == $claim.head and .atEpoch >= $startedEpoch
            ) | not)
          | select(
              if $claim.kind == "connector" then
                (
                  any($reviews[]?;
                    ((.author.login // "") | ascii_downcase | startswith("chatgpt-codex-connector"))
                    and (.commit.oid // "") == $claim.head
                    and ((.submittedAt | epoch) as $submittedEpoch | $submittedEpoch != null and $submittedEpoch > $startedEpoch)
                  )
                  or any($reactions[]?;
                    ((.user.login // "") | ascii_downcase | startswith("chatgpt-codex-connector"))
                    and .content == "THUMBS_UP"
                    and ((.createdAt | epoch) as $createdEpoch | $createdEpoch != null and $createdEpoch > $startedEpoch)
                  )
                ) | not
              else true end
            )
        ]
      | sort_by(.started, .id)'
}

current_live_review_claim_for_owner() {
  local claims
  claims=$(live_review_claims "$1" "$2") || return 1
  printf '%s' "$claims" | jq -cer --arg owner "$3" '[ .[] | select(.owner == $owner) ] | last // empty'
}

review_claim_advisory() {
  printf '%s' "$1" | jq -er --arg repo "$REPO" --arg pr "$PR" '
    "review_claim=advisory repo=\($repo) pr=\($pr) head=\(.head) id=\(.id) owner=\(.owner) actor=\(.actor) started=\(.started) expires=\(.expires) kind=\(.kind)"'
}

review_claim_advisories() {
  local claims="$1" prefix="${2:-}" suffix="${3:-}" claim
  printf '%s' "$claims" | jq -e 'type == "array"' >/dev/null || return 1
  while IFS= read -r claim; do
    printf '%s%s%s\n' "$prefix" "$(review_claim_advisory "$claim")" "$suffix"
  done < <(printf '%s' "$claims" | jq -c '.[]')
}

claim_now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

claim_marker_fields() {
  local owner="$1" ttl="$2" compact
  CLAIM_STARTED=$(claim_now) || return 1
  CLAIM_EXPIRES=$(date -u -d "$CLAIM_STARTED + $ttl minutes" +%Y-%m-%dT%H:%M:%SZ) || return 1
  compact="${CLAIM_STARTED//[^0-9]/}"
  CLAIM_ID="$owner-$compact"
}

explicit_claim_marker() {
  printf '<!-- pr-review-loop:claim id=%s repo=%s pr=%s head=%s owner=%s started=%s expires=%s -->' \
    "$CLAIM_ID" "$REPO" "$PR" "$1" "$2" "$CLAIM_STARTED" "$CLAIM_EXPIRES"
}

# The comments connection again, with the author's relationship to the repo,
# which only receipts need.
receipt_comments_page() {
  gh api graphql -f query='
    query($owner:String!,$name:String!,$pr:Int!,$after:String){
      repository(owner:$owner,name:$name){ pullRequest(number:$pr){
        headRefOid comments(first:100,after:$after){ pageInfo{hasNextPage endCursor} nodes{
          author{login} authorAssociation createdAt lastEditedAt fullDatabaseId body
        } }
      } }
    }' \
    -F owner="$OWNER" -F name="$NAME" -F pr="$PR" -F after="$1"
}

# The outcome of the latest substitute-review receipt for exactly HEAD, or
# nothing, as "<outcome>\t<reviewer text>" (reviewer text empty for a receipt
# written before the reviewer line existed). A later `changes` supersedes an
# earlier `approve`, and a receipt for any other head says nothing about this
# one. `outcome` alone (no tab, no reviewer) means no receipt was found. Later
# means posted later: receipts are ordered by the comment's database id, which
# GitHub assigns in posting order (fullDatabaseId, a string of digits), never by
# createdAt, which is to the second, so an approve and the changes receipt after
# it can share one. The id is a BigInt bigger than 2^53 for a normal-sized repo's
# history, so it is compared as a digit string — sort by length, then
# lexicographically — never via `tonumber`, which is a jq double and would
# round two ids to the same value. A receipt whose fullDatabaseId is missing,
# null, empty, or not a canonical positive integer: digits only, no leading
# zero, nothing after (canonical_id, receipt-order.jq) cannot be placed in
# that order at all: rather than assign it a synthetic position (a null read
# as "0" ranks a real receipt below one posted earlier), every receipt
# matching this head is reported `unknown` — no order is inferred from any
# other field. Under `audit`, a receipt posted after GATE_AS_OF (the merge)
# did not gate it, and a comment edited since, or posted in the merge's own
# second, is not read at all: its text at the merge is unknown, and it could
# have been a receipt — a comment in the same second as the merge may have
# come after it, since GitHub's timestamp has no sub-second precision. When
# such a comment, from an author whose receipts count, was posted after the
# latest receipt that is read, or in the same second, or no receipt is read,
# the receipts at the merge are unknown: the outcome is `unknown`, and the
# reviewer text says which comment and why (edited after the merge, or posted
# in its own second). Dropping only the edited receipts would let a `changes`
# receipt, edited after the merge, hand the verdict back to the `approve`
# before it; reading a same-second receipt as before the merge would let a
# `changes` receipt posted the same second the PR merged pass as if it never
# happened.
receipt_outcome() {
  local pages
  pages=$(paginate_connection comments receipt_comments_page) || return 1
  printf '%s\n' "$pages" | jq -rs -L "$HERE" --arg re "$RECEIPT_MARKER_RE" --arg reviewerRe "$RECEIPT_REVIEWER_LINE_RE" --arg head "$1" --arg asof "$GATE_AS_OF" '
    include "receipt-order";
    [ .[] | .data.repository.pullRequest.comments.nodes[]
      | select(.authorAssociation == "OWNER" or .authorAssociation == "MEMBER" or .authorAssociation == "COLLABORATOR")
      | select($asof == "" or .createdAt <= $asof)
      | .idstr = ((.fullDatabaseId // "") | tostring) ] as $comments
    | [ $comments[] | select($asof != "" and ((.lastEditedAt // "") >= $asof or .createdAt == $asof)) ] as $unreadable
    | [ $comments[] | select($asof == "" or ((.lastEditedAt // "") < $asof and .createdAt < $asof))
        | .createdAt as $at
        | .idstr as $idstr
        | .author as $author
        | .body as $body
        | [ ($body // "" | capture($re)) ] | first // empty
        | select(.head == $head)
        | { outcome, at: $at, idstr: $idstr, author: $author, reviewer: (($body // "" | capture($reviewerRe)).reviewer // "") } ] as $matches
    | ([ $matches[] | select((.idstr | canonical_id) | not) ] | first) as $bad
    | if $bad != null then
        "unknown\treceipt_order_unknown: a receipt comment for this head from \($bad.author.login // "someone") has no usable database id (fullDatabaseId=\(if $bad.idstr == "" then "null" else $bad.idstr end)); receipt order cannot be determined without assigning it a synthetic position"
      else
        ( $matches | sort_by(.idstr | posting_key) | last ) as $latest
        | ( [ $unreadable[] | select($latest == null or .createdAt >= $latest.at
              or ((.idstr | canonical_id) and (.idstr | posting_key) > ($latest.idstr | posting_key))) ]
            | sort_by(.idstr | posting_key) | last ) as $unread
        | if $unread != null and ($unread.lastEditedAt // "") > $asof then
            "unknown\t\($unread.author.login // "someone") posted a comment at \($unread.createdAt) and edited it at \($unread.lastEditedAt) after the merge"
          elif $unread != null then
            "unknown\t\($unread.author.login // "someone") posted a comment at \($unread.createdAt), the second the PR merged, so it may have come after the merge"
          elif $latest == null then empty
          else "\($latest.outcome)\t\($latest.reviewer)" end
        end'
}

# Whether any substitute receipt on this PR, for ANY head, asked for changes —
# the review-notes rule's trigger (review_notes_state): `changes\t<who, which
# head, when>` when one did, `none` when none did, `unknown\t<why>` when that
# cannot be told. Read as receipt_outcome reads receipts: trusted authors only,
# and under `audit` nothing posted after GATE_AS_OF. A trusted comment posted
# in the merge's own second, or edited in or after it, is not read: GitHub's
# timestamps are to the second, so either may have landed after the merge, and
# its text at the merge is unknown. It could have been a `changes` receipt, so
# it makes the answer `unknown`, which the rule treats like `changes`, never
# like `none`. No posting order is needed, so a receipt without a usable
# database id counts like any other. Non-zero when the comments cannot be
# read; the caller never reads that as `none`.
changes_receipt_state() {
  local pages
  pages=$(paginate_connection comments receipt_comments_page) || return 1
  printf '%s\n' "$pages" | jq -rs --arg re "$RECEIPT_MARKER_RE" --arg asof "$GATE_AS_OF" '
    [ .[] | .data.repository.pullRequest.comments.nodes[]
      | select(.authorAssociation == "OWNER" or .authorAssociation == "MEMBER" or .authorAssociation == "COLLABORATOR")
      | select($asof == "" or .createdAt <= $asof) ] as $comments
    | [ $comments[] | select($asof != "" and ((.lastEditedAt // "") >= $asof or .createdAt == $asof)) ] as $unreadable
    | ([ $comments[] | select($asof == "" or ((.lastEditedAt // "") < $asof and .createdAt < $asof))
         | . as $c
         | [ (.body // "") | capture($re; "g") | select(.outcome == "changes") ] | first // empty
         | { head, login: ($c.author.login // "someone"), at: $c.createdAt } ] | first) as $changes
    | ($unreadable | first) as $unread
    | if $changes != null then "changes\t\($changes.login) asked for changes on \($changes.head[0:12]) at \($changes.at)"
      elif $unread != null then
        "unknown\t\($unread.author.login // "someone") posted a comment at \($unread.createdAt)\(if ($unread.lastEditedAt // "") >= $asof then " and edited it at \($unread.lastEditedAt)" else "" end), in or after the second the PR merged, and it may have been a changes receipt"
      else "none" end'
}

# The review-notes rule, merge-check's and audit's (docs/review-policy.md,
# "Review notes and fix links"): once any substitute receipt on the PR has
# asked for changes (changes_receipt_state), the current PR adds its own
# REVIEW_NOTES_DIR/<PR>.md fragment, or its body carries `Review-notes: none
# (<reason>)` with a non-empty reason, outside code fences and HTML comments
# as the Fixes-PR line is read. The touch comes from SCOPE_FILES — the pinned
# comparison scope_eval checked, containing only non-deleted post-image paths
# — and a listing it could not check never counts as one. `audit` deliberately
# applies this current rule too: normal push audits use the merged commit's own
# skill copy, while a manual newer-code backfill must expose its new rule.
# Prints exactly `ok` when the rule holds or does not apply — its callers read
# anything else but the reason as no verdict — else the reason,
# `review_notes_missing: …`. $1 is the PR as a {body} JSON object: now for
# merge-check, as it stood at the merge for audit. Non-zero when the receipts
# cannot be read.
review_notes_state() {
  local state
  state=$(changes_receipt_state) || return 1
  if [ "$state" = none ]; then echo ok; return 0; fi
  printf '%s' "$1" | jq -r -L "$HERE" --arg state "$state" --arg lineRe "$REVIEW_NOTES_NONE_LINE_RE" \
    --arg candidateRe "$REVIEW_NOTES_NONE_CANDIDATE_RE" --arg anywhereRe "$REVIEW_NOTES_NONE_ANYWHERE_RE" \
    --arg splitRe "$REVIEW_NOTES_REASON_SPLIT_RE" \
    --arg notes "$REVIEW_NOTES_FILE" --arg fragment "$REVIEW_NOTES_DIR/$PR.md" \
    --argjson files "$SCOPE_FILES" '
    include "pr-body";
    # Strip every format character first, then require at least one visible
    # one left: a soft hyphen or an emoji ZWJ sequence must not sink an
    # otherwise-visible reason. A handful of codepoints look blank but are
    # not \p{Cf}, so they are named explicitly; a combining mark is excluded
    # outright, since a real base character elsewhere already satisfies this
    # test on its own, and a combining mark with no base must not (#707 P3-b).
    def real_reason:
      gsub("\\p{Cf}"; "") as $stripped
      | ($stripped | test("[^\\s\\p{Z}\\p{Cc}\\p{M}\\x{2800}\\x{3164}\\x{115F}\\x{1160}\\x{FFA0}]"));
    # pr_body_text checks its own shape inside pr-body.jq, but a replacement
    # module can drop that check along with the rest of the module (#707
    # P3-a) — assert the shape up front, whenever pr_body_text yields exactly
    # one value of the wrong type. Empty or doubled output is left alone: the
    # case statement in each caller of this function still reads that as "no
    # verdict", same as before.
    (
      [pr_body_text] as $pr_body
      | if ($pr_body | length) == 1 and ($pr_body[0] | type) != "string"
        then error("pr_body_text (pr-body.jq) must yield exactly one string, got \($pr_body[0])")
        else empty end
    ),
    (
    ($state | split("\t")) as [$kind, $why]
      | pr_body_text as $body
      | if [ $body | capture($lineRe; "gi") ] | any(.reason | real_reason) then "ok"
      elif ($files | type) == "array" and any($files[]; . == $fragment) then "ok"
      else
        ( if $kind == "changes" then $why
          else "whether a substitute receipt asked for changes is unknown: \($why)" end ) as $whyText
        | ( if ($files | type) == "array" then "this head does not add or amend \($fragment)"
            else "the files this head changes could not be checked, so no addition of \($fragment) counts" end ) as $touch
        # Names which shape rule the line failed, instead of a blanket "no
        # reason" (#707 P3-c): the loose candidate regex finds an attempted
        # line even where the strict one refuses to, so its tail can be
        # inspected for what specifically is wrong with it.
        | ( [ $body | capture($candidateRe; "gi") ] ) as $candidates
        | ( ((.body // "") | test($anywhereRe; "i")) and (($body | test($anywhereRe; "i")) | not) ) as $hiddenByStripping
        | ( if ($candidates | length) > 0 then
              ($candidates[0].rest) as $rest
              # capture, not index/slice: a byte offset from index and a
              # codepoint offset from a slice disagree once $rest holds a
              # multi-byte UTF-8 reason, and this must never depend on which
              # one wins (#713 P3). No match — no unescaped `)`, or a `(`
              # before the first `)` — comes back as an empty array, same as
              # the old "unmatched or nested" branch.
              | ( [ $rest | capture($splitRe) ] ) as $split
              | if ($split | length) == 0 then
                  "the body carries a `Review-notes: none (...)` line, but its reason has an unmatched or nested parenthesis, which the check cannot parse. Remove the inner parenthesis, or add the lesson in \($fragment)"
                else
                  ($split[0].reason) as $reasonContent
                  | ($split[0].trailing | gsub("^[ \t]+"; "") | gsub("[ \t\r]+$"; "")) as $trailing
                  | if ($reasonContent | real_reason | not) then
                      "the body carries a `Review-notes: none ()` line, but its reason is empty or has no visible character. Give it a visible reason, or add the lesson in \($fragment)"
                    elif ($trailing | length) > 0 then
                      "the body carries a `Review-notes: none (<reason>)` line, but it has text after the closing parenthesis (\"\($trailing)\"), which the check reads as not ending the line\(if $trailing == "." then " (a trailing period counts as text after the parenthesis; drop it)" else "" end). Remove it, or add the lesson in \($fragment)"
                    else
                      "the body carries a `Review-notes: none (...)` line that does not count as a statement, for a reason the check could not name precisely. Add the lesson in \($fragment), or say why there is none in that body line"
                    end
                end
            elif $hiddenByStripping then
              "the body carries a `Review-notes: none (...)` line, but it is inside a code fence or an HTML comment, so it does not count as a statement. Move it outside both, or add the lesson in \($fragment)"
            else
              "the body has no `Review-notes: none (<reason>)` line at all. Add the lesson in \($fragment), or add that body line saying why there is none"
            end
          ) as $shapeDetail
        | "review_notes_missing: \($whyText); \($touch), and \($shapeDetail)"
      end
    )'
}

# Empty when CI on exactly HEAD is green; otherwise `ci_missing`, `ci_red` or
# `ci_pending` and what caused it. Workflow runs come from `actions/runs`, not
# `commits/<sha>/check-runs`: that 403s ("Resource not accessible by personal
# access token") under the narrower-scoped tokens container agents may hold,
# which fail-closed 13 PRs for the sibling release-policy.py on 2026-09-06.
# Commit statuses cover CI that is not Actions. Neither at all is refused: CI
# that never ran did not pass.
#
# Every workflow named in CODEX_REVIEW_REQUIRED_WORKFLOWS (comma-separated,
# default `CI`) must have a latest run on this head that concluded `success`.
# Green-so-far is not enough: a head checked before CI registered its run would
# otherwise pass on whatever else had already finished.
#
# Only the newest run per workflow name counts, since a rerun leaves the failed
# run it replaced in the list, and only the newest status per context, since
# /statuses keeps every status ever posted. The Risk label run is left out: it
# only labels the PR for people to read, and counting it would pass a head no
# CI ever ran on. The pages go through stdin, not --argjson, because a page of
# runs can exceed the kernel's per-argument limit. Under `audit`, a run or
# status created after GATE_AS_OF (the merge) did not gate it: shadow-review.yml
# runs on the head seconds after every merge, on `pull_request_target: closed`.
# A run created before the merge but last updated after it had not finished by
# the merge, or has been re-run since; its conclusion at the merge is unknown,
# so it counts as pending there. `actions/runs` gives no completion time, and a
# finished run's updated_at is when it finished: runs sampled from 2026-08-20/21
# each read updated_at within a second of their last job's completed_at, and a
# re-run moves it. A commit status never changes once posted.
#
# A run GitHub never started (never_started_runs: no runner, no step — the
# Actions billing lockout) is not evidence about the head either way. For a
# required workflow it is red unless the newest HOST_CI_CONTEXT status on the
# head is `pending` (a host run under way: ci_pending, so ci-wait waits) or
# `success`; then the verdict is `ci_host: <workflows> ...`, which
# every caller reads as green and reports as `ci=host`. A run that started and
# failed stays red whatever the host status says, and a red host status is red
# like any other. A non-required run that never started is left out, as if it
# had not been triggered.
#
# Which host status counts is decided by who posted it: only a HOST_CI_CONTEXT
# status whose creator is in host_ci_posters stands in, and the newest such
# status is the one judged. One from anyone else stands in for nothing (it is
# still an ordinary status, so it is red when it is red).
ci_verdict() {
  local runs statuses unstarted posters='[]' required="${CODEX_REVIEW_REQUIRED_WORKFLOWS:-CI}"
  runs=$(gh api --paginate --slurp "repos/$REPO/actions/runs?head_sha=$1&per_page=100") || return 1
  statuses=$(gh api --paginate --slurp "repos/$REPO/commits/$1/statuses?per_page=100") || return 1
  unstarted=$(never_started_runs "$1" "$runs" "$required") || return 1
  # Only asked when something could be excused, so a healthy head never pays
  # for (or fails on) the identity read.
  if [ "$unstarted" != '[]' ]; then posters=$(host_ci_posters); fi
  printf '%s\n%s\n' "$runs" "$statuses" | jq -rs --arg head "$1" --arg labeler "$RISK_LABEL_WORKFLOW" --arg requiredList "$required" --argjson excluded "$CI_EXCLUDED_CONTEXTS" --arg asof "$GATE_AS_OF" --argjson unstarted "$unstarted" --arg hostContext "$HOST_CI_CONTEXT" --argjson posters "$posters" '
    ( $requiredList | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0)) ) as $required
    | ( [ .[0][].workflow_runs[]?
        | select(.head_sha == $head)
        | select($asof == "" or (.created_at // "") <= $asof)
        | select((.name == $labeler and .event == "pull_request_target") | not)
        | if $asof != "" and ((.updated_at // "") as $u | $u == "" or $u > $asof)
          then .status = "updated after the merge" | .conclusion = null else . end ]
      | group_by(.name) | map(max_by([.run_started_at // .created_at // "", .id // 0])) ) as $runs
    | ( [ .[1][][]? | select(.context as $c | $excluded | index($c) | not)
          | select($asof == "" or (.created_at // "") <= $asof) ]
        | group_by(.context) | map(max_by([.created_at // "", .id // 0])) ) as $statuses
    | ( [ .[1][][]? | select(.context == $hostContext and ((.creator.login // "") | ascii_downcase | IN($posters[])))
          | select($asof == "" or (.created_at // "") <= $asof) ]
        | if length == 0 then "none" else max_by([.created_at // "", .id // 0]).state end ) as $hostState
    | ($hostState == "success") as $hostGreen
    | ( [ $runs[] | select(.status == "completed" and (.id | IN($unstarted[]))) ] ) as $never
    | ( [ $never[] | select(.name as $n | $required | index($n) != null) ] ) as $neverRequired
    | ( if $hostGreen then [ $neverRequired[] | .name ] else [] end ) as $hosted
    | ( [ $runs[] | select(.status == "completed" and (.id | IN($unstarted[]) | not))
          | (.name as $n | $required | index($n) != null) as $isRequired
          | select((.conclusion // "") as $c | if $isRequired then $c != "success" else ($c | IN("success", "neutral", "skipped") | not) end)
          | "\(.name)=\(.conclusion // "none")\(if $isRequired then " (required)" else "" end)" ]
        + ( if $hostGreen or $hostState == "pending" then [] else [ $neverRequired[] | "\(.name)=not started (required; GitHub never started its jobs and no \($hostContext) success from \(if ($posters | length) == 0 then "an allowed poster (none could be resolved: set CODEX_REVIEW_HOST_CI_POSTERS)" else ($posters | join("/")) end) is on this head — run run-host-ci.sh)" ] end )
        + [ $statuses[] | select(.state != "success" and .state != "pending") | "\(.context)=\(.state)" ] ) as $red
    | [ $required[] | . as $n | select(any($runs[]; .name == $n) | not) ] as $missing
    | ( [ $runs[] | select(.status != "completed") | "\(.name)=\(.status)" ]
        + [ $statuses[] | select(.state == "pending") | "\(.context)=pending" ] ) as $pending
    | if ($runs | length) == 0 and ($statuses | length) == 0 then "ci_missing: no workflow run or commit status on this head — CI never ran"
      elif ($red | length) > 0 then "ci_red: " + ($red | join(", "))
      elif ($missing | length) > 0 then "ci_missing: " + ($missing | join(", ")) + " — required, but no run on this head"
      elif ($pending | length) > 0 then "ci_pending: " + ($pending | join(", "))
      elif ($hosted | length) > 0 then "ci_host: " + ($hosted | join(", ")) + " never started on Actions; the \($hostContext) success on this head stands in"
      else empty end'
}

# Who may post a HOST_CI_CONTEXT status that stands in for Actions, as a JSON
# array of logins: CODEX_REVIEW_HOST_CI_POSTERS (comma-separated) when set,
# else the one account this script itself authenticates as. A commit status
# is writable by anything holding `statuses:write` on the repo — a
# collaborator's token, another App, or a PR's own workflow token posting as
# github-actions[bot] — and without this any of them could post `CI (host)`
# success on a head and excuse a required workflow that never ran. The
# default is this script's own login because the fleet runs this gate and
# run-host-ci.sh with the same credential: one GITHUB_TOKEN per agent group,
# resolved by resolveGitHubToken (src/github-token.ts:8-19) and handed to the
# container as one file every git/gh call reads (src/github-token-file.ts:
# 36-38), so the account run-host-ci.sh posts as is the account this reads
# here. The repo owner is not a usable default: in an org-owned repo the
# owner is the org, which never authors a status — only a user or App does. An empty answer (the identity
# read failed and nothing is configured) allows no one, so nothing stands in.
host_ci_posters() {
  local list="${CODEX_REVIEW_HOST_CI_POSTERS:-}"
  if [ -z "$list" ]; then
    list=$(gh api user --jq .login 2>/dev/null) || list=""
  fi
  # Lower-cased: GitHub logins are case-insensitive, and callers compare the
  # lower-cased creator.login against this.
  jq -cn --arg list "$list" '$list | split(",") | map(gsub("^\\s+|\\s+$"; "") | ascii_downcase) | map(select(length > 0))'
}

# The ids, as a JSON array, of the Actions runs on head $1 (from $2, the
# slurped actions/runs pages) that GitHub never started — the only runs a
# `CI (host)` success is allowed to stand in for. A run qualifies when every
# ATTEMPT of it is `run_never_started` (never-started.jq: at least one job,
# every job with no runner and no step, one of them `failure`) AND no other
# completed run of the same WORKFLOW on this head is a real red.
#
# "Real red" here is ci_verdict's own standard, which is PER-REQUIRED-NESS and
# is why $3 exists — the comma-separated required-workflow names, as
# ci_verdict resolved them. For a required workflow it is `.conclusion !=
# "success"`: a `timed_out`, `cancelled`, `neutral`, `skipped` or
# `startup_failure` run is red there, so letting one go by would excuse a newer
# never-started run over a genuine red. For every other workflow it is
# `.conclusion` not in success/neutral/skipped, exactly as ci_verdict scores
# them — applying the stricter rule to those would take the never-started
# excuse away from a workflow whose older run was merely skipped, or
# `cancelled` by an ordinary `concurrency: cancel-in-progress`, and refuse
# merges the gate used to allow. $3 empty means no workflow gets the strict
# rule.
#
# Only `failure` runs cost a jobs read: that is the only conclusion the lockout
# produces, so every other red conclusion disqualifies its workflow name
# outright, for free.
#
# Both of those are #937 C. A never-started run is evidence about GitHub, not
# about the head, so it is excusable — but a genuine red of the same required
# check on the same head is evidence about the head, and a re-run that never
# started must not hide it. Re-running takes both shapes: `Re-run jobs` keeps
# the run id and bumps `run_attempt` (so the earlier attempt's jobs are only
# visible under `/attempts/<n>/jobs`), a fresh trigger makes a second run of
# the same workflow name (and ci_verdict keeps only the newest per name, so
# the older one would go unseen). Either way ONE genuine failure disqualifies
# the whole workflow name here, not just that one run.
#
# Fail closed throughout: only failed runs are asked about, and anything that
# cannot be read or does not prove never-started — a failed jobs read, an
# unparseable id, a run with no jobs — disqualifies its workflow name rather
# than being skipped. Cost is one jobs read per failed run, plus one per
# earlier attempt of one. Under `audit`, runs created after GATE_AS_OF are not
# asked about (ci_verdict drops them anyway).
never_started_runs() {
  local rows kind id attempt name jobs a endpoint clean candidates='[]' disqualified='[]'
  rows=$(printf '%s\n' "$2" | jq -r --arg head "$1" --arg asof "$GATE_AS_OF" --arg requiredList "${3-}" '
    ( $requiredList | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0)) ) as $required
    | [ .[].workflow_runs[]? | select(.head_sha == $head and .status == "completed")
      | select($asof == "" or (.created_at // "") <= $asof)
      # ci_verdict scores a required workflow and any other one differently;
      # matching it exactly is the whole point of $required here.
      | select((.conclusion // "") as $c | if (.name // "") | IN($required[])
               then $c != "success" else ($c | IN("success", "neutral", "skipped") | not) end)
      # `ask` needs a jobs read to tell the lockout shape from a real failure;
      # `red` is already a real red and only costs its workflow name.
      | { kind: (if .conclusion == "failure" then "ask" else "red" end), id: .id, attempt: (.run_attempt // 1), name: (.name // "") } ]
    | unique_by(.id) | .[] | "\(.kind)\t\(.id)\t\(.attempt)\t\(.name)"') || return 1
  while IFS=$'\t' read -r kind id attempt name; do
    [ -n "$id" ] || continue
    if [ "$kind" = red ]; then
      disqualified=$(jq -cn --argjson d "$disqualified" --arg n "$name" '$d + [$n]') || return 1
      continue
    fi
    clean=1
    if [[ "$id" =~ ^[0-9]+$ ]]; then
      [[ "$attempt" =~ ^[0-9]+$ ]] && [ "$attempt" -ge 1 ] || attempt=1
      # Newest attempt first, so the common single-attempt run costs one read.
      for (( a = attempt; a >= 1; a-- )); do
        if [ "$a" -eq "$attempt" ]; then
          endpoint="repos/$REPO/actions/runs/$id/jobs?per_page=100"
        else
          endpoint="repos/$REPO/actions/runs/$id/attempts/$a/jobs?per_page=100"
        fi
        jobs=$(gh api --paginate --slurp "$endpoint" 2>/dev/null) || { clean=0; break; }
        printf '%s\n' "$jobs" | jq -e -L "$HERE" 'include "never-started"; run_never_started' >/dev/null 2>&1 || { clean=0; break; }
      done
    else
      clean=0
    fi
    if [ "$clean" = 1 ]; then
      candidates=$(jq -cn --argjson c "$candidates" --argjson id "$id" --arg n "$name" '$c + [{ id: $id, name: $n }]') || return 1
    else
      disqualified=$(jq -cn --argjson d "$disqualified" --arg n "$name" '$d + [$n]') || return 1
    fi
  done <<< "$rows"
  jq -cn --argjson c "$candidates" --argjson d "$disqualified" '[ $c[] | select(.name | IN($d[]) | not) | .id ]'
}

# The newest independent-review-receipt:v1 for exactly HEAD, from the authors
# receipt_outcome trusts and in the posting order it uses (receipt-order.jq):
# `none`, `clear`, `blocked\t<why>` or `unknown\t<why>`. Clear is verdict CLEAR
# with zero blocking findings; anything else the newest one says is blocked, a
# CHANGES verdict and a receipt whose JSON does not parse alike.
#
# One rule for what a comment says, with no reading of what Markdown shows:
# blocking takes no parsing, and a clearing receipt starts with the marker.
# Every marker in the comment is read, each against the JSON between it and
# the next marker, wherever it sits — quoted, fenced, commented out, inside a
# tag — and any receipt among them that applies to this head and is not clear
# makes the comment a no. A comment is clear only when it holds exactly one
# marker, that receipt is clear, and the marker is the first thing in the
# body, after nothing but a byte-order mark and ASCII whitespace: nothing
# precedes it, so nothing can hide it, and the desk's prose goes after the
# receipt. Any other comment is not a clear: it clears nothing and masks
# nothing. Modelling what GitHub renders, and then listing what could open a
# hidden context before the marker, each drew a finding a round; this models
# nothing. (The substitute receipt marker is matched against the raw body too,
# so a quoted `approve` counts there; it is left as it is here.)
#
# Who wrote it follows the same asymmetry. authorAssociation is not a
# permission: MEMBER is membership of the organisation, and a COLLABORATOR can
# hold read or triage only. So anyone in that set can block, and only an author
# whose permission on the repository is write or above can clear (may_clear),
# looked up for the clear receipt that would decide and for no other. A clear
# one that fails it is left out and the next newest decides, so a genuine
# CHANGES under a forged CLEAR still stands. (receipt_outcome trusts the same
# association set for a substitute `approve`, so the risk-scoped path shares
# this weakness too; it is left as it is here.)
#
# Which head a receipt is about is not left to a second parser either. A
# receipt applies to this head when its JSON text names the head's full SHA
# anywhere at all, or parses with no string `head`; one that does not mention
# it is about another head and says nothing here. So a payload that does not
# parse, or parses to another `head` while still naming this one (a nested
# object, a duplicate key), blocks rather than drops out. Clearing reads only
# the parsed top-level `head`, `verdict` and `blocking_findings` (the number
# 0, not "0" or null), and only from a text that spells each of those keys
# exactly once and holds no backslash: jq keeps the last of duplicate keys,
# and an escape can spell a key a second way, so neither can turn a CHANGES
# into a CLEAR. Substitute receipts are not
# read here, so an approving one, older or newer, never outvotes the desk. A
# receipt whose database id cannot be ordered makes the answer `unknown`, as
# in receipt_outcome. Only the legacy precheck calls this, and `audit` never
# reaches it (a legacy repo exits the audit arm first), so nothing is read as
# of a merge. Non-zero when the comments cannot be read.
independent_receipt_state() {
  local pages state login denied='[]'
  pages=$(paginate_connection comments receipt_comments_page) || return 1
  while :; do
    state=$(independent_receipt_newest "$pages" "$1" "$denied") || return 1
    case "$state" in
      clear$'\t'*)
        login="${state#*$'\t'}"
        if may_clear "$login"; then echo clear; return 0; fi
        denied=$(jq -cn --argjson d "$denied" --arg l "$login" '$d + [$l]') || return 1
        ;;
      *) printf '%s\n' "$state"; return 0 ;;
    esac
  done
}

# Whether LOGIN may clear a head: its permission on this repository, now, is
# write or above (`permission` folds maintain into write and triage into
# read). Anything else, a failed read included, is no: the clear receipt does
# not count and whatever it would have superseded stands.
may_clear() {
  local permission
  permission=$(gh api "repos/$REPO/collaborators/$(jq -rn --arg l "$1" '$l | @uri')/permission" --jq .permission 2>/dev/null) || return 1
  [ "$permission" = admin ] || [ "$permission" = write ]
}

# independent_receipt_state's one read of the comment pages $1 for head $2,
# with the clear receipts of every login in the JSON array $3 left out. Prints
# `clear\t<login>` for a clear newest receipt, so its author can be checked.
independent_receipt_newest() {
  printf '%s\n' "$1" | jq -rs -L "$HERE" --arg re "$INDEPENDENT_RECEIPT_MARKER_RE" --argjson denied "$3" \
    --arg jsonRe "$INDEPENDENT_RECEIPT_JSON_RE" --arg head "$2" '
    include "receipt-order";
    [ .[] | .data.repository.pullRequest.comments.nodes[]
      | select(.authorAssociation == "OWNER" or .authorAssociation == "MEMBER" or .authorAssociation == "COLLABORATOR")
      | { login: (.author.login // "someone"), at: .createdAt, idstr: ((.fullDatabaseId // "") | tostring) } as $c
      | [ (.body // "") | ltrimstr("\uFEFF") | splits($re) ] as $parts
      | select(($parts | length) > 1)
      | [ range(1; $parts | length) as $i
          | $parts[$i] as $rest
          | (([ $rest | capture($jsonRe) | .json ] | first) // $rest) as $text
          | ([ $text | try fromjson catch null | objects ] | first) as $doc
          | select(($text | contains($head)) or ($doc != null and ($doc.head | type) != "string"))
          | { clear: ($doc != null and $doc.head == $head and $doc.verdict == "CLEAR" and $doc.blocking_findings == 0
                      and ($text | contains("\\") | not)
                      and all("head", "verdict", "blocking_findings"; . as $k | [ $text | match("\"\($k)\""; "g") ] | length == 1)),
              said: (if $doc == null then "its JSON block does not parse"
                     else "verdict \($doc.verdict // "missing" | tostring), blocking_findings \($doc.blocking_findings // "missing" | tostring)" end) } ] as $receipts
      | ([ $receipts[] | select(.clear | not) ] | first) as $no
      | if $no != null then $c + { clear: false, said: $no.said }
        elif ($parts | length) == 2 and ($receipts | length) == 1 and ($parts[0] | test("\\A[ \t\r\n]*\\z"))
             and ($c.login as $l | $denied | index($l) | not) then $c + { clear: true, said: "" }
        else empty end ] as $matches
    | ([ $matches[] | select((.idstr | canonical_id) | not) ] | first) as $bad
    | if $bad != null then
        "unknown\treceipt_order_unknown: an independent-review receipt for this head from \($bad.login) has no usable database id (fullDatabaseId=\(if $bad.idstr == "" then "null" else $bad.idstr end)), so which receipt is newest cannot be determined"
      else
        ( $matches | sort_by(.idstr | posting_key) | last ) as $latest
        | if $latest == null then "none"
          elif $latest.clear then "clear\t\($latest.login)"
          else "blocked\t\($latest.login) posted the newest independent-review receipt for this head at \($latest.at): \($latest.said)" end
      end'
}

# One page of the PR head's status rollup: every check run and commit status
# GitHub counts on it, each with GitHub's own answer to whether this PR's base
# requires it. A head nothing has reported on has no rollup at all (null, read
# 2026-09-17 on a repo with no CI); that is an empty page, not a failed read.
rollup_page() {
  gh api graphql -f query='
    query($owner:String!,$name:String!,$pr:Int!,$after:String){
      repository(owner:$owner,name:$name){ pullRequest(number:$pr){
        headRefOid statusCheckRollup{ contexts(first:100,after:$after){ pageInfo{hasNextPage endCursor} nodes{
          __typename
          ... on CheckRun{ databaseId name status conclusion isRequired(pullRequestNumber:$pr) }
          ... on StatusContext{ context state creator{ login } isRequired(pullRequestNumber:$pr) }
        } } }
      } }
    }' \
    -F owner="$OWNER" -F name="$NAME" -F pr="$PR" -F after="$1" \
    | jq -c 'if .data.repository.pullRequest != null and .data.repository.pullRequest.statusCheckRollup == null
             then .data.repository.pullRequest.statusCheckRollup = { contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }
             else . end'
}

# The required checks that are red on exactly HEAD, as `<name>=<state>` joined
# by ", "; empty when none is. Which checks are required, and which report
# answers for each, is GitHub's to say and is asked, not re-derived:
# `isRequired(pullRequestNumber:)` is its evaluation across rulesets and
# classic protection, app pins, and a status and a check run sharing a name
# (it requires both). Three review rounds re-deriving those rules one case at
# a time is why none of them is restated here.
#
# Red is named by what is acceptable, as in ci_verdict, so a value GitHub adds
# later is red: a required check run that is COMPLETED with a conclusion other
# than SUCCESS, NEUTRAL or SKIPPED, or a required status whose state is not
# SUCCESS, PENDING or EXPECTED. What has not finished or not reported is left
# alone: a Release approval waiting on a person is not a defect in the head,
# which is what CI_EXCLUDED_CONTEXTS protects in ci_verdict too, and GitHub
# holds the merge for it anyway. The rollup is the PR head's, so every page
# must name HEAD as that head; a failed or partial read is no verdict, and
# there is no second source to fall back on.
#
# Output is `<red>\t<hosted>\t<hosted check-run ids as JSON>`. A required check run that concluded FAILURE
# because GitHub never started it (its Actions job, read by the check run's
# databaseId, is never_started — never-started.jq, AND its run is one
# never_started_runs vouches for on this head) is not red when the rollup's
# HOST_CI_CONTEXT status on this head is SUCCESS and was posted by an allowed
# poster (host_ci_posters); it is named in <hosted> instead. The rollup
# carries only the newest status per context, so a newer one from anyone else
# hides an allowed success and the check run stays red. As in ci_verdict, a
# job read that fails keeps it red.
required_status_red() {
  local pages rollup candidates id job posters='[]' unstarted='[]' runs excusable='[]'
  pages=$(paginate_connection statusCheckRollup.contexts rollup_page) || return 1
  rollup=$(printf '%s\n' "$pages" | jq -cs --arg head "$1" '
    if all(.[]; .data.repository.pullRequest.headRefOid == $head) | not
    then error("the status rollup read is for another head than \($head)") else . end
    | [ .[] | .data.repository.pullRequest.statusCheckRollup.contexts.nodes[] ]') || return 1
  if printf '%s\n' "$rollup" | jq -e --arg ctx "$HOST_CI_CONTEXT" 'any(.[]; .__typename == "StatusContext" and .context == $ctx and .state == "SUCCESS")' >/dev/null; then
    posters=$(host_ci_posters)
  fi
  candidates=$(printf '%s\n' "$rollup" | jq -r --arg ctx "$HOST_CI_CONTEXT" --argjson posters "$posters" '
    if any(.[]; .__typename == "StatusContext" and .context == $ctx and .state == "SUCCESS" and ((.creator.login // "") | ascii_downcase | IN($posters[])))
    then [ .[] | select(.__typename == "CheckRun" and .isRequired == true and .status == "COMPLETED" and .conclusion == "FAILURE")
           | .databaseId | select(type == "number") ] | unique | .[]
    else empty end') || return 1
  # Which RUNS on this head are excusable at all (#937 C). The check run alone
  # cannot answer it: its job never started, but an earlier attempt of the same
  # run, or an earlier run of the same workflow, may hold a genuine red that
  # the rollup no longer shows — the rollup carries only the newest check run
  # per name. Read once, and only when something could be excused.
  if [ -n "$candidates" ]; then
    runs=$(gh api --paginate --slurp "repos/$REPO/actions/runs?head_sha=$1&per_page=100") || return 1
    # No workflow gets the required-only standard here: on the rollup side a
    # check run that concluded NEUTRAL or SKIPPED is green whether or not it is
    # required (the `green` set below, and `ci_verdict`'s non-required set),
    # so an older neutral/skipped run must not disqualify its workflow.
    excusable=$(never_started_runs "$1" "$runs" "") || return 1
  fi
  for id in $candidates; do
    [[ "$id" =~ ^[0-9]+$ ]] || continue
    job=$(gh api "repos/$REPO/actions/jobs/$id" 2>/dev/null) || continue
    printf '%s\n' "$job" | jq -e -L "$HERE" 'include "never-started"; never_started and .conclusion == "failure"' >/dev/null 2>&1 || continue
    # And its run must be one of the excusable ones. A job whose run_id names
    # no such run — including a job read that carries no run_id — stays red.
    printf '%s\n' "$job" | jq -e --argjson excusable "$excusable" '(.run_id // null) as $r | $r != null and ($r | IN($excusable[]))' >/dev/null 2>&1 || continue
    unstarted=$(jq -cn --argjson o "$unstarted" --argjson id "$id" '$o + [$id]') || return 1
  done
  printf '%s\n' "$rollup" | jq -r --argjson unstarted "$unstarted" '
    [ .[] | select(.isRequired == true) ] as $required
    | [ $required[] | select(.__typename == "CheckRun" and (.databaseId | IN($unstarted[]))) | .name ] as $hosted
    | [ $required[] | select((.__typename == "CheckRun" and (.databaseId | IN($unstarted[]))) | not)
        | if .__typename == "CheckRun"
          then select(.status == "COMPLETED" and (.conclusion | IN("SUCCESS", "NEUTRAL", "SKIPPED") | not)) | "\(.name)=\(.conclusion // "none" | ascii_downcase)"
          else select(.state | IN("SUCCESS", "PENDING", "EXPECTED") | not) | "\(.context)=\(.state // "none" | ascii_downcase)" end ]
    | "\(unique | join(", "))\t\($hosted | unique | join(", "))\t\($unstarted | tojson)"'
}

# What a legacy merge still answers to mechanically. merge-check defers a
# legacy repo to SKILL.md Step 6, and Step 6 is prose: a PR merged there over a
# red required status and a desk receipt asking for changes, with the rule
# against both already written down. These two facts need no judgement, so
# they refuse (24) before the defer; everything else about a legacy merge is
# still Step 6's. No verdict (1) when either cannot be read.
LEGACY_CI_HOST=""
LEGACY_CI_HOST_IDS='[]'
legacy_precheck() {
  local red_out red receipt
  red_out=$(required_status_red "$SCOPE_HEAD") || {
    echo "merge=error head=$SCOPE_HEAD: could not read which required checks are red on this head (GitHub status rollup); no verdict" >&2
    exit 1
  }
  red="${red_out%%$'\t'*}"
  LEGACY_CI_HOST="${red_out#*$'\t'}"
  [ "$LEGACY_CI_HOST" != "$red_out" ] || LEGACY_CI_HOST=""
  LEGACY_CI_HOST_IDS="${LEGACY_CI_HOST#*$'\t'}"
  [ "$LEGACY_CI_HOST_IDS" != "$LEGACY_CI_HOST" ] || LEGACY_CI_HOST_IDS='[]'
  LEGACY_CI_HOST="${LEGACY_CI_HOST%%$'\t'*}"
  if [ -n "$red" ]; then
    echo "merge=refused head=$SCOPE_HEAD mode=legacy: required_red: $red — GitHub requires it for this PR and it is red on this head; fix what it reports, never merge around it" >&2
    exit 24
  fi
  receipt=$(independent_receipt_state "$SCOPE_HEAD") || exit 1
  case "$receipt" in
    none|clear) ;;
    blocked$'\t'*|unknown$'\t'*)
      echo "merge=refused head=$SCOPE_HEAD mode=legacy: independent_receipt_not_clear: ${receipt#*$'\t'}; only a later CLEAR independent-review receipt for this head, or a new head, lifts it" >&2
      exit 24
      ;;
    *)
      echo "merge=error head=$SCOPE_HEAD: the independent-receipt check gave no verdict (got \"$receipt\")" >&2
      exit 1
      ;;
  esac
}

# Whether an admin bypass (`gh pr merge --admin`) of the base branch's rules
# would skip ONLY what host CI already answered for: prints `ready` or
# `not-ready\t<why>`. required_status_red leaves PENDING/EXPECTED and
# unreported checks alone because GitHub holds the merge for them, and GitHub
# also holds it for unresolved review threads and missing approvals — but
# --admin lifts every hold at once. So `ready` needs, read live from the
# branch's rules (repos/<r>/rules/branches/<base>) and the PR:
#   - every required context (from the rules, plus every rollup context
#     GitHub marks required) reported and green, except the never-started
#     check runs an allowed CI (host) success covers ($1, their databaseIds);
#   - no unresolved review thread when the rules require resolution;
#   - `reviewDecision` APPROVED or null (#937 B3). This is GitHub's OWN
#     computed answer to "is the review requirement met" — APPROVED |
#     CHANGES_REQUESTED | REVIEW_REQUIRED, null when the PR requires no review
#     — and it already counts only approvals from accounts with write access,
#     which is the part this script has no business recomputing. It replaced
#     the approval ARITHMETIC that used to live here (approving reviews
#     counted against required_approving_review_count). A value outside that
#     set is a state GitHub added later, and is not-ready;
#   - no approving review owed by the base RULES, independently of the above:
#     `required_approving_review_count > 0`, or
#     require_extra_approval_for_unattributed_changes with a commit whose
#     author maps to no GitHub account. Both are fail-closed rather than
#     counted, because `reviewDecision` is NOT a substitute for reading them.
#     Measured, not assumed: a production repository has an `active` ruleset on
#     the default branch with `require_extra_approval_for_unattributed_changes:
#     true`, and an open PR based on that branch has three commits with
#     no GitHub-attributed author but reports `reviewDecision: null`. So
#     reviewDecision does not surface that rule's review parameters, and the
#     sibling parameter in the same rule object cannot be assumed to fare
#     better. Neither refuses anything on this fleet today
#     (required_approving_review_count is 0 everywhere);
#   - no CHANGES_REQUESTED review from anyone but the author (#937 B1). Kept
#     alongside reviewDecision, not folded into it: `reviewDecision` is null
#     on a repo whose rules require no review, so it says nothing there, while
#     a requested change is still a hold --admin would lift. Deliberately NOT
#     narrowed with `latestOpinionatedReviews(writersOnly: true)` — a
#     non-writer's "please change this" does not block GitHub, but it is
#     exactly the kind of thing an admin bypass should not run over;
#   - no strict_required_status_checks_policy (#937 B2): that is GitHub's
#     "require branches to be up to date before merging", which is a fact about
#     the base moving, not about this head, and nothing here evaluates it;
#   - no rule type, app-pinned check, or classic protection it does not model.
# Anything it cannot read is `not-ready`, never `ready`.
#
# Deliberately NOT modelled, because no repo in this fleet has the rule it
# would guard: a required_status_checks parameter allow-list.
admin_readiness() {
  local hosted="$1" rules protection pages rollup pr why
  rules=$(gh api --paginate --slurp "repos/$REPO/rules/branches/$SCOPE_BASE_REF" 2>/dev/null | jq -c 'flatten') || {
    printf 'not-ready\tcould not read the rules of %s' "$SCOPE_BASE_REF"; return 0; }
  if protection=$(gh api "repos/$REPO/branches/$SCOPE_BASE_REF/protection" 2>/dev/null); then
    printf 'not-ready\t%s has classic branch protection, which this does not evaluate' "$SCOPE_BASE_REF"; return 0
  fi
  printf '%s' "$protection" | jq -e '.message == "Branch not protected"' >/dev/null 2>&1 || {
    printf 'not-ready\tcould not read the classic protection of %s' "$SCOPE_BASE_REF"; return 0; }
  pages=$(paginate_connection statusCheckRollup.contexts rollup_page) || {
    printf 'not-ready\tcould not read the status rollup'; return 0; }
  rollup=$(printf '%s\n' "$pages" | jq -cs --arg head "$SCOPE_HEAD" '
    if all(.[]; .data.repository.pullRequest.headRefOid == $head) | not then error("rollup for another head") else . end
    | [ .[] | .data.repository.pullRequest.statusCheckRollup.contexts.nodes[] ]') || {
    printf 'not-ready\tcould not read the status rollup'; return 0; }
  pr=$(gh api graphql -f query='
    query adminReadiness($owner:String!,$name:String!,$pr:Int!){
      repository(owner:$owner,name:$name){ pullRequest(number:$pr){
        headRefOid author{ login } reviewDecision
        reviewThreads(first:100){ totalCount nodes{ isResolved } }
        latestOpinionatedReviews(first:100){ totalCount nodes{ state author{ login } } }
        commits(first:100){ totalCount nodes{ commit{ author{ user{ login } } } } }
      } }
    }' -F owner="$OWNER" -F name="$NAME" -F pr="$PR" 2>/dev/null | jq -ce '.data.repository.pullRequest | objects') || {
    printf 'not-ready\tcould not read the PR review threads, reviews and commits'; return 0; }
  why=$(jq -rn --argjson rules "$rules" --argjson rollup "$rollup" --argjson pr "$pr" --argjson hosted "$hosted" --arg head "$SCOPE_HEAD" '
    def green: if .__typename == "CheckRun"
      then (.databaseId | IN($hosted[])) or (.status == "COMPLETED" and (.conclusion | IN("SUCCESS", "NEUTRAL", "SKIPPED")))
      else .state == "SUCCESS" end;
    def ctxname: .name // .context;
    def shown: if .__typename == "CheckRun" then "\(.status // "none" | ascii_downcase)/\(.conclusion // "none" | ascii_downcase)" else (.state // "none" | ascii_downcase) end;
    ( [ $rules[] | .type ] - ["deletion", "non_fast_forward", "pull_request", "required_status_checks"] | unique ) as $unmodeled
    | ( [ $rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[] ] ) as $checks
    | ( any($rules[]; .type == "required_status_checks" and .parameters.strict_required_status_checks_policy == true) ) as $strict
    | ( [ $rules[] | select(.type == "pull_request") | .parameters ] ) as $prRules
    | ( [ $checks[] | .context ] + [ $rollup[] | select(.isRequired == true) | ctxname ] | unique ) as $required
    | ( [ $required[] | . as $c | [ $rollup[] | select(ctxname == $c) ] as $nodes
          | if ($nodes | length) == 0 then "\($c)=not reported"
            else ($nodes[] | select(green | not) | "\($c)=\(shown)") end ] | unique ) as $notGreen
    | ( [ $pr.commits.nodes[] | select(.commit.author.user == null) ] | length ) as $unattributed
    | ( [ $pr.latestOpinionatedReviews.nodes[] | select(.state == "CHANGES_REQUESTED" and (.author.login // "") != ($pr.author.login // "")) | .author.login // "(unknown)" ] | unique ) as $changesRequested
    | ( [ $pr.reviewThreads.nodes[] | select(.isResolved | not) ] | length ) as $unresolved
    | [ ( if $pr.headRefOid != $head then "the PR head moved to \($pr.headRefOid)" else empty end ),
        ( if ($unmodeled | length) > 0 then "rules this does not evaluate: \($unmodeled | join(", "))" else empty end ),
        ( $checks[] | select(.integration_id != null) | "required check \(.context) is pinned to an app, which this does not evaluate" ),
        ( if $strict then "the base requires the branch to be up to date, which this does not evaluate" else empty end ),
        ( if ($notGreen | length) > 0 then "required, not green: \($notGreen | join(", "))" else empty end ),
        ( if ($changesRequested | length) > 0 then "changes requested by \($changesRequested | join(", "))" else empty end ),
        ( if ($pr.reviewDecision // "none") | IN("none", "APPROVED") | not
          then "GitHub reports reviewDecision=\($pr.reviewDecision)" else empty end ),
        ( if $pr.reviewThreads.totalCount > 100 or $pr.latestOpinionatedReviews.totalCount > 100 or $pr.commits.totalCount > 100
          then "over 100 review threads, reviews or commits, not read in full" else empty end ),
        ( $prRules[]
          | ( if .required_review_thread_resolution == true and $unresolved > 0 then "\($unresolved) unresolved review thread(s), and the rules require resolution" else empty end ),
            ( if (.required_approving_review_count // 0) > 0
              then "the base rules require \(.required_approving_review_count) approving review(s), and reviewDecision does not surface that ruleset parameter" else empty end ),
            ( if .require_extra_approval_for_unattributed_changes == true and $unattributed > 0
              then "an extra approving review is required because \($unattributed) commit(s) have no GitHub-attributed author, and reviewDecision does not surface that ruleset parameter either" else empty end ),
            ( if .require_code_owner_review == true or .require_last_push_approval == true or ((.required_reviewers // []) | length) > 0
              then "code-owner, last-push or named-reviewer requirements, which this does not evaluate" else empty end ) )
      ] | join("; ")') || {
    printf 'not-ready\tcould not evaluate the rules'; return 0; }
  if [ -z "$why" ]; then printf 'ready'; else printf 'not-ready\t%s' "$why"; fi
}

# merge-check's decision, for the merge-check command and for `merge`, which
# runs it in a subshell of this same process. Exit 0 only when merging exactly
# this head is allowed; the merge then pins it with `gh pr merge
# --match-head-commit <head>`. A legacy repo exits 26, not 0: its merge is Step
# 6's evidence rules, and a caller chaining merge-check into `gh pr merge` must
# never read a defer as a pass. Its base is re-read first, since a base that
# moved may have opted in since.
merge_check_main() {
  local want="" pr_text fix_link ci ci_word receipt_raw receipt receipt_reviewer notes markers since observation claim_now_iso claims
  while [ $# -gt 0 ]; do
    case "$1" in
      --head)
        [ $# -ge 2 ] && [[ "$2" =~ ^[0-9a-f]{7,40}$ ]] || { echo "merge-check: --head needs a hex sha (7-40)" >&2; exit 2; }
        want="$2"; shift 2 ;;
      *) echo "merge-check: unknown argument $1" >&2; exit 2 ;;
    esac
  done
  scope_eval || exit 1
  if [ "$SCOPE_MODE" = legacy ]; then
    if [ -n "$want" ] && [[ "$SCOPE_HEAD" != "$want"* ]]; then
      echo "merge=refused head=$SCOPE_HEAD: the PR head is not $want" >&2
      exit 24
    fi
    legacy_precheck
    refuse_if_base_moved
    if [ -n "$LEGACY_CI_HOST" ]; then
      local admin
      echo "merge-check: required $LEGACY_CI_HOST never started on Actions; the $HOST_CI_CONTEXT success on this head stands in" >&2
      admin=$(admin_readiness "$LEGACY_CI_HOST_IDS")
      if [ "$admin" = ready ]; then
        echo "merge=defer mode=legacy ci=host admin=ready: $REPO is not risk-scoped; the existing Step-6 evidence rules apply, and every other rule on $SCOPE_BASE_REF is met, so an admin bypass skips only the never-started check"
      else
        echo "merge-check: admin=not-ready: ${admin#*$'\t'}" >&2
        echo "merge=defer mode=legacy ci=host admin=not-ready: $REPO is not risk-scoped; the existing Step-6 evidence rules apply; never bypass the rules for this head — ${admin#*$'\t'}"
      fi
      exit 26
    fi
    echo "merge=defer mode=legacy: $REPO is not risk-scoped; the existing Step-6 evidence rules apply"
    exit 26
  fi
  if [ -n "$want" ] && [[ "$SCOPE_HEAD" != "$want"* ]]; then
    echo "merge=refused head=$SCOPE_HEAD: the PR head is not $want" >&2
    exit 24
  fi
  # A claim is only coordination evidence. Its read is best-effort and cannot
  # alter this command's exit code or merge decision.
  claim_now_iso=$(claim_now) || claim_now_iso=""
  if [ -n "$claim_now_iso" ]; then
    claims=$(live_review_claims "$SCOPE_HEAD" "$claim_now_iso") || claims="[]"
    review_claim_advisories "$claims" >&2 || true
  fi
  # A fix PR names the PR it fixes, or says `none` (fix_link_state). Read at
  # merge time: the title and body can both change after the PR opens.
  pr_text=$(gh pr view "$PR" --repo "$REPO" --json title,body) || exit 1
  fix_link=$(printf '%s' "$pr_text" | fix_link_state) || exit 1
  # Exactly `ok` or `missing`. Anything else — no line, two lines — is no
  # verdict, never a pass: a pr-body.jq that yields nothing must not wave a fix
  # PR through.
  case "$fix_link" in
    ok) ;;
    missing)
      echo "merge=refused head=$SCOPE_HEAD: a fix PR needs a 'Fixes-PR: #<n>' line in its body naming the PR it fixes, or 'Fixes-PR: none'" >&2
      exit 24
      ;;
    *)
      echo "merge=error head=$SCOPE_HEAD: the Fixes-PR check gave no verdict (got \"$fix_link\")" >&2
      exit 1
      ;;
  esac
  # No branch protection holds this line, so merge-check does, whatever the
  # verdict: every check run on exactly this head, completed green.
  ci=$(ci_verdict "$SCOPE_HEAD") || exit 1
  case "$ci" in
    '') ci_word=green ;;
    ci_host:*)
      ci_word=host
      echo "merge-check: $ci" >&2
      ;;
    *)
      echo "merge=refused head=$SCOPE_HEAD: $ci" >&2
      exit 24
      ;;
  esac
  # A substitute reviewer who read exactly this head and said no outranks
  # everything else here: `changes` refuses under either verdict, a clean
  # Codex review included, until a later receipt for this head approves.
  receipt_raw=$(receipt_outcome "$SCOPE_HEAD") || exit 1
  receipt="${receipt_raw%%$'\t'*}"
  receipt_reviewer="${receipt_raw#*$'\t'}"
  # receipt_outcome fails closed rather than infer an order: never read that
  # as no receipt or an approval.
  if [ "$receipt" = unknown ]; then
    echo "merge=refused head=$SCOPE_HEAD: $receipt_reviewer" >&2
    exit 24
  fi
  if [ "$receipt" = changes ]; then
    echo "merge=refused head=$SCOPE_HEAD verdict=$SCOPE_VERDICT: latest substitute receipt: changes — a substitute reviewer said no on this head" >&2
    exit 24
  fi
  # A review that said no on any head leaves its lesson in this PR's
  # docs/review-notes/<PR>.md fragment,
  # or the body says why there is none (review_notes_state). Read at merge
  # time, like the Fixes-PR line, and under either verdict.
  notes=$(review_notes_state "$pr_text") || exit 1
  case "$notes" in
    ok) ;;
    review_notes_missing:*)
      echo "merge=refused head=$SCOPE_HEAD verdict=$SCOPE_VERDICT: $notes" >&2
      exit 24
      ;;
    *)
      echo "merge=error head=$SCOPE_HEAD: the review-notes check gave no verdict (got \"$notes\")" >&2
      exit 1
      ;;
  esac
  if [ "$SCOPE_VERDICT" = skip ]; then
    refuse_if_base_moved
    echo "merge=allowed head=$SCOPE_HEAD mode=risk-scoped verdict=skip ci=$ci_word base=$SCOPE_BASE: $SCOPE_REASON"
    exit 0
  fi
  # verdict=review: the latest substitute receipt for THIS head approves, or
  # the review requested for this head is clean. `status` is the loop's one
  # definition of clean — a review of this head (or a 👍) newer than the
  # request, no unresolved Codex thread from any round, the head unmoved — so
  # it is reused here, not restated.
  #
  # An approving receipt only unlocks the merge when its own reviewer field's
  # FIRST token names a frontier model — the tier rule in
  # reviewer_model_refusal above. A receipt whose first token is refused
  # (including one written before this gate existed) fails the
  # check, which is fine: this only reads the receipt for the head currently
  # being merged, never a historical one — post a fresh receipt instead.
  if [ "$receipt" = approve ]; then
    if ! reviewer_model_allowed "$receipt_reviewer"; then
      echo "merge=refused head=$SCOPE_HEAD verdict=$SCOPE_VERDICT: the approving substitute receipt names a disallowed reviewer — $(reviewer_model_refusal "$receipt_reviewer"). Post a new receipt (codex-review.sh receipt ...) from a frontier model" >&2
      exit 24
    fi
    refuse_if_base_moved
    echo "merge=allowed head=$SCOPE_HEAD mode=risk-scoped verdict=review ci=$ci_word base=$SCOPE_BASE: the latest substitute receipt for this head approves ($receipt_reviewer)"
    exit 0
  fi
  markers=$(request_markers) || exit 1
  since=$(printf '%s' "$markers" | jq -r --arg head "$SCOPE_HEAD" '[.[] | select(.head == $head)] | first | .at // empty') || exit 1
  if [ -z "$since" ]; then
    echo "merge=refused head=$SCOPE_HEAD verdict=review: no review of this head was requested and no substitute receipt approves it (latest receipt: ${receipt:-none}; $SCOPE_REASON)" >&2
    exit 24
  fi
  observation=$(status_observation "$SCOPE_HEAD" "$since") || exit 1
  case "$observation" in
    codex=clean*)
      refuse_if_base_moved
      echo "merge=allowed head=$SCOPE_HEAD mode=risk-scoped verdict=review ci=$ci_word base=$SCOPE_BASE: $observation"
      ;;
    *)
      echo "merge=refused head=$SCOPE_HEAD verdict=review: $observation; latest substitute receipt: ${receipt:-none}" >&2
      exit 24
      ;;
  esac
}

# One PR-mergeability read for ci-wait: state, the exact head it points at,
# mergeable (MERGEABLE/CONFLICTING/UNKNOWN) and its base branch name. Sets
# CI_WAIT_STATE CI_WAIT_HEAD CI_WAIT_MERGEABLE CI_WAIT_BASE and returns 0 on a
# clean read; returns 1 on anything else (gh fails, or the JSON does not
# parse) so the caller can count it toward the read-failure budget rather than
# reading a failure as pending or green.
ci_wait_read_pr() {
  local raw
  raw=$(gh pr view "$PR" --repo "$REPO" --json state,headRefOid,baseRefName,mergeable) || return 1
  CI_WAIT_STATE=$(printf '%s' "$raw" | jq -er .state) || return 1
  CI_WAIT_HEAD=$(printf '%s' "$raw" | jq -er .headRefOid) || return 1
  CI_WAIT_MERGEABLE=$(printf '%s' "$raw" | jq -er .mergeable) || return 1
  CI_WAIT_BASE=$(printf '%s' "$raw" | jq -er .baseRefName) || return 1
}

# ci-wait: the only way this loop waits on CI. It answers rather than times
# out when waiting cannot help — a conflicting PR (31, GitHub runs no
# `pull_request` workflow on one:
# docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows,
# "pull_request") or no run ever registered (30) — and tells red (29) apart
# from both, since each needs a different action from the caller. See
# ci_verdict above for the green predicate this reuses unchanged.
#
# Pending versus no run registered: `ci_missing` while still inside the
# registration window (measured from ci-wait's own start, not the push) is
# PENDING — GitHub can take seconds to minutes to register a `pull_request`
# run after a push. `ci_missing` once the window has passed is NO RUN
# REGISTERED: either nothing at all is registered on the head, or a workflow
# named in CODEX_REVIEW_REQUIRED_WORKFLOWS has no run on it, and waiting
# longer cannot help — the causes are the workflow's triggers or path
# filters, Actions being disabled, or a conflict GitHub hasn't reported yet
# (mergeable still UNKNOWN) — so this is exit 30, never a timeout. A conflict
# is caught before either case: on a conflicting PR a `pull_request` run can
# never register, so without that check ci-wait would wait out the whole
# window for nothing.
ci_wait_main() {
  local head="" timeout="${CODEX_REVIEW_CI_WAIT_SECONDS:-1800}"
  local poll="${CODEX_REVIEW_CI_POLL_SECONDS:-30}" register="${CODEX_REVIEW_CI_REGISTER_SECONDS:-180}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --head)
        [ $# -ge 2 ] || { echo "ci-wait: --head needs a sha" >&2; exit 2; }
        head="$2"; shift 2 ;;
      --timeout) timeout="${2:?--timeout needs seconds}"; shift 2 ;;
      *) echo "ci-wait: unknown argument $1" >&2; exit 2 ;;
    esac
  done
  # Validated before any read: a bad --head/--timeout/knob or an unknown
  # argument must cost nothing against GitHub.
  [[ "$head" =~ ^[0-9a-f]{40}$ ]] || { echo "ci-wait: --head must be the full 40-character SHA you pushed" >&2; exit 2; }
  [[ "$timeout" =~ ^[1-9][0-9]{0,5}$ ]] || { echo "ci-wait: --timeout must be a positive whole number of seconds, up to 999999" >&2; exit 2; }
  [[ "$poll" =~ ^[1-9][0-9]*$ ]] || { echo "ci-wait: CODEX_REVIEW_CI_POLL_SECONDS must be a positive whole number" >&2; exit 2; }
  [[ "$register" =~ ^[1-9][0-9]*$ ]] || { echo "ci-wait: CODEX_REVIEW_CI_REGISTER_SECONDS must be a positive whole number" >&2; exit 2; }

  local start deadline now elapsed tick=0 state verdict last_verdict=""
  local pr_fails=0 ci_fails=0 unk_reads=0
  start=$(date +%s) || exit 1
  # The deadline covers the whole command, including the mergeability phase
  # below.
  deadline=$((start + timeout))

  # Mergeability phase, ahead of the poll loop. A read failure here shares the
  # same read-failure budget the poll loop uses (pr_fails) — it is never read
  # as pending or as UNKNOWN. UNKNOWN itself never fails the run: it retries,
  # capped at 6 reads in all, and proceeds to the poll loop regardless once
  # the cap is hit.
  while :; do
    if ! ci_wait_read_pr; then
      pr_fails=$((pr_fails + 1))
      if [ "$pr_fails" -ge 3 ]; then
        echo "ci=error head=$head: the PR read failed 3 times in a row" >&2
        exit 1
      fi
      sleep 5
      continue
    fi
    pr_fails=0
    if [ "$CI_WAIT_STATE" != OPEN ]; then
      echo "ci=error head=$head: PR #$PR is $CI_WAIT_STATE; there is no head to wait on" >&2
      exit 1
    fi
    if [ "$CI_WAIT_HEAD" != "$head" ]; then
      echo "ci=head-changed head=$CI_WAIT_HEAD want=$head: the PR's head moved; capture the new head and wait on that" >&2
      exit 12
    fi
    case "$CI_WAIT_MERGEABLE" in
      CONFLICTING)
        # Conflict wins over green or red CI: the PR can't merge until it is
        # resolved, and resolving it makes a new head anyway. Read nothing else.
        echo "ci=conflicting head=$head: PR #$PR conflicts with $CI_WAIT_BASE; merge the base in first. No pull_request CI will run" >&2
        exit 31
        ;;
      MERGEABLE)
        break
        ;;
      UNKNOWN)
        unk_reads=$((unk_reads + 1))
        if [ "$unk_reads" -ge 6 ]; then
          echo "ci-wait: mergeable=UNKNOWN after 6 reads; waiting on CI anyway, re-checking it each poll"
          break
        fi
        sleep 5
        continue
        ;;
      *)
        echo "ci=error head=$head: PR #$PR reports mergeable=$CI_WAIT_MERGEABLE, which ci-wait does not recognise" >&2
        exit 1
        ;;
    esac
  done

  # Poll loop. Every tick re-checks mergeability and the head before checking
  # CI — a head that has moved off --head, or a PR that has gone conflicting
  # since the last tick, says nothing about the head this call was asked
  # about. In the loop, UNKNOWN never sleeps extra; it just carries on to the
  # CI read.
  while :; do
    now=$(date +%s) || exit 1
    elapsed=$((now - start))
    if ci_wait_read_pr; then
      pr_fails=0
      if [ "$CI_WAIT_STATE" != OPEN ]; then
        echo "ci=error head=$head: PR #$PR is $CI_WAIT_STATE; there is no head to wait on" >&2
        exit 1
      fi
      if [ "$CI_WAIT_HEAD" != "$head" ]; then
        echo "ci=head-changed head=$CI_WAIT_HEAD want=$head: the PR's head moved; capture the new head and wait on that" >&2
        exit 12
      fi
      if [ "$CI_WAIT_MERGEABLE" = CONFLICTING ]; then
        echo "ci=conflicting head=$head: PR #$PR conflicts with $CI_WAIT_BASE; merge the base in first. No pull_request CI will run" >&2
        exit 31
      fi
      state="$CI_WAIT_MERGEABLE"
      if verdict=$(ci_verdict "$head"); then
        ci_fails=0
        last_verdict="$verdict"
        case "$verdict" in
          '')
            echo "ci=green head=$head"
            exit 0
            ;;
          ci_host:*)
            echo "ci=host head=$head: $verdict"
            exit 0
            ;;
          ci_red:*)
            echo "ci=red head=$head: $verdict" >&2
            exit 29
            ;;
          ci_missing:*)
            if [ "$elapsed" -ge "$register" ]; then
              echo "ci=none head=$head after ${elapsed}s: $verdict; mergeable=$state" >&2
              exit 30
            fi
            echo "ci-wait tick=$tick elapsed=${elapsed}s/${timeout}s mergeable=$state $verdict (not registered yet; no-run after ${register}s)"
            ;;
          ci_pending:*)
            echo "ci-wait tick=$tick elapsed=${elapsed}s/${timeout}s mergeable=$state $verdict"
            ;;
        esac
      else
        # No observation this tick: never read as pending or green.
        ci_fails=$((ci_fails + 1))
        if [ "$ci_fails" -ge 3 ]; then
          echo "ci=error head=$head: the CI read failed 3 times in a row" >&2
          exit 1
        fi
      fi
    else
      pr_fails=$((pr_fails + 1))
      if [ "$pr_fails" -ge 3 ]; then
        echo "ci=error head=$head: the PR read failed 3 times in a row" >&2
        exit 1
      fi
    fi
    now=$(date +%s) || exit 1
    if [ "$now" -ge "$deadline" ]; then
      echo "ci=timeout head=$head after ${timeout}s: $last_verdict" >&2
      exit 11
    fi
    local remaining=$((deadline - now)) sleep_for="$poll"
    if [ "$remaining" -lt "$sleep_for" ]; then sleep_for="$remaining"; fi
    sleep "$sleep_for"
    tick=$((tick + 1))
  done
}

case "${1:?usage: open|churn|classes|gate|push|body|reply|resolve|status|wait|ci-wait|scope|request|claim|merge-check|merge|audit|receipt}" in
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
    # commit is the primitive fix. Read-only: see run_gate.
    #
    # Counts uncommitted work at the primitive as evidence, so it can be run
    # before committing. Pass --committed-only to judge only what a push would
    # actually send — which is what the push path and the container's git_push
    # tool both do.
    shift
    run_gate "$@"
    ;;
  push)
    # The loop's push path. The gate runs first so a refusal costs nothing —
    # a site patch that reaches the remote has already generated next round.
    # --committed-only because `git push` sends committed history: an edit to
    # the primitive still sitting in the working tree would otherwise lift the
    # gate for a push that leaves it behind.
    #
    # A `<sha>:refs/heads/<branch>` argument pins the gate to that commit as
    # well, so the verdict and the audit line describe what is being pushed
    # rather than whatever the checkout holds when this runs. Callers that pass
    # no refspec are pushing the checkout, and the gate reads it.
    #
    # Only those two shapes are accepted. `git push -h` permits
    # `[<repository> [<refspec>...]]` and exposes `--all`/`--mirror`/`--tags`,
    # and one verdict cannot describe many destinations: a second refspec would
    # ride to the remote unjudged, under a pass earned by the first. So the
    # many-ref forms are refused here rather than gated on the wrong ref.
    shift
    PUSH_HEAD=""
    PUSH_DEST=""
    PUSH_DRY_RUN=0
    push_refspecs=0
    push_positional=0
    for arg in "$@"; do
      case "$arg" in
        # Named for a precise message. Not the mechanism — that is the
        # allowlist below, because a denylist of ref-expanding options misses
        # aliases by construction: `--branches` is `--all` under another
        # spelling, and the next alias git adds would be a bypass again.
        --all|--branches|--no-branches|--mirror|--tags|--follow-tags|--prune|--delete|-d)
          echo "push $arg sends or removes refs the churn gate cannot name; push <sha>:refs/heads/<branch> instead" >&2
          exit 2
          ;;
        # Options known not to change WHICH refs are sent, known to be
        # self-contained — no separate value argument, which would otherwise be
        # counted below as the remote or a refspec — and known not to move the
        # repository out of the positional grammar. `--repo=<remote>` fails
        # that last test: it supplies the repository itself, so the first bare
        # word becomes the refspec rather than the remote, and the count below
        # would read a refspec as a remote and gate the checkout instead. It is
        # refused rather than special-cased, because one grammar is the point. An
        # option that is not on this list is refused rather than assumed
        # harmless: the gate's whole claim is that what reaches the remote is
        # what it judged, and an unrecognised option can break that claim.
        -n|--dry-run)
          # Allowed, but it updates nothing, so nothing may be recorded as
          # pushed. See PUSH_DRY_RUN below.
          PUSH_DRY_RUN=1
          continue
          ;;
        -f|--force|--force-with-lease|--force-with-lease=*|--force-if-includes|\
        -u|--set-upstream|-q|--quiet|-v|--verbose|--porcelain|\
        --atomic|--no-atomic|--verify|--no-verify|--progress|--no-progress|\
        --thin|--no-thin|-4|--ipv4|-6|--ipv6|--push-option=*)
          continue
          ;;
        -*)
          echo "push option '$arg' is not known to the churn gate to leave the ref set alone; drop it, use its =value form, or add it to the allowlist in codex-review.sh" >&2
          exit 2
          ;;
      esac
      push_positional=$((push_positional + 1))
      # `git push [<repository> [<refspec>...]]` — the first bare word is the
      # remote, never a ref. It must be `origin`: PR resolution describes one
      # repository, and a push to a second remote would be judged by the first
      # one's PRs. A container in this fork has exactly one remote, so refusing
      # is the whole answer — binding the resolution to an arbitrary remote
      # would be machinery for a target that does not exist.
      if [ "$push_positional" -eq 1 ]; then
        if [ "$arg" != "origin" ]; then
          echo "push remote '$arg' is not origin; the churn gate resolves PRs for one repository and does not judge a second remote" >&2
          exit 2
        fi
        continue
      fi
      push_refspecs=$((push_refspecs + 1))
      # A positive grammar, matching the option allowlist above: one literal
      # commit, one literal branch, and nothing that git will expand. Counting
      # arguments does not prove there is one destination — `refs/heads/*:refs/
      # heads/*` is a single argument that pushes every branch — and a source
      # that is a ref rather than a SHA can move between the verdict and the
      # push. Both are shapes the gate cannot pin a verdict to, so the rule is
      # what IS accepted rather than a list of what is not.
      if [[ "$arg" =~ ^([0-9a-f]{7,40}):refs/heads/([^*?[:space:]^~:\\]+)$ ]]; then
        PUSH_HEAD="${BASH_REMATCH[1]}"
        PUSH_DEST="${BASH_REMATCH[2]}"
      else
        echo "push refspec '$arg' is not <sha>:refs/heads/<branch> with a literal commit and no wildcard; the churn gate cannot pin a verdict to it" >&2
        exit 2
      fi
    done
    if [ "$push_refspecs" -gt 1 ]; then
      echo "push sends $push_refspecs refspecs; the churn gate judges one branch at one commit" >&2
      exit 2
    fi
    # No refspec is not "push the checkout": `push.default=matching` and a
    # configured `remote.<name>.push` both let a bare push update several
    # branches, so the gate would judge the checkout while git sent more. The
    # refspec is therefore always explicit — built here from the checkout when
    # the caller gave none — and git is never left to decide what a push means.
    # One `git status` for the pair, so the branch and the commit describe one
    # instant rather than two.
    if [ "$push_refspecs" -eq 0 ]; then
      push_status=$(git status --porcelain=v2 --branch --untracked-files=no)
      push_oid=$(printf '%s\n' "$push_status" | sed -n 's/^# branch\.oid //p')
      push_branch=$(printf '%s\n' "$push_status" | sed -n 's/^# branch\.head //p')
      if [ -z "$push_oid" ] || [ -z "$push_branch" ] || [ "$push_branch" = "(detached)" ] || [ "$push_oid" = "(initial)" ]; then
        echo "cannot push a detached HEAD; check out a branch or pass <sha>:refs/heads/<branch>" >&2
        exit 2
      fi
      PUSH_HEAD="$push_oid"
      PUSH_DEST="$push_branch"
      # Add the remote too when the caller named none, since a refspec without
      # one is read by git as the repository.
      if [ "$push_positional" -eq 0 ]; then
        set -- "$@" origin
      fi
      set -- "$@" "$push_oid:refs/heads/$push_branch"
    fi
    # The gate is about the branch this push UPDATES, which is the refspec's
    # destination — not the checkout's branch, and not BRANCH, either of which
    # can name a different branch whose PRs are clean. Resolving again from the
    # destination is what binds the verdict to the push; without it a clean
    # verdict for A authorises a push that updates B.
    if [ -n "$PUSH_DEST" ] && [ "$PUSH_DEST" != "${BRANCH:-}" ]; then
      REPO=$(base_repo "$PUSH_DEST")
      PR_LIST=$(resolve_pr_list "$PUSH_DEST" "$REPO")
      [ -n "$PR_LIST" ] || { echo "no open PR for branch $PUSH_DEST" >&2; exit 1; }
      PR=$(printf '%s\n' "$PR_LIST" | head -1)
    fi
    if [ -n "$PUSH_HEAD" ]; then
      run_gate --committed-only --head "$PUSH_HEAD"
    else
      run_gate --committed-only
    fi
    git push "$@"
    # One line per PR that was overridden — each body records its own. A dry
    # run updated no remote, so recording one would write a claim into the PR
    # body that nothing backs.
    if [ "$PUSH_DRY_RUN" -eq 1 ]; then
      if [ ${#GATE_OVERRIDE_LINES[@]} -gt 0 ]; then
        echo "dry run: the override was NOT recorded on the PR, because nothing was pushed" >&2
      fi
    else
      for override in ${GATE_OVERRIDE_LINES[@]+"${GATE_OVERRIDE_LINES[@]}"}; do
        PR="${override%%$'\t'*}"
        record_site_patch_override "${override#*$'\t'}"
      done
    fi
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
    # `codex=` is only about whether the reviewer answered THIS commit; `open=`
    # is the separate merge gate. A fresh THUMBS_UP says nothing about threads
    # left over from an earlier round, so unresolved threads win over clean
    # review/reaction evidence regardless of their age.
    sha="${2:?head sha}"; since="${3:?iso timestamp captured before the push}"
    status_observation "$sha" "$since"
    ;;
  wait)
    sha="${2:?head sha}"; since="${3:?iso timestamp captured before the push}"
    minutes="${4:-${CODEX_REVIEW_WAIT_MINUTES:-15}}"
    if ! [[ "$minutes" =~ ^[1-9][0-9]*$ ]]; then
      echo "wait minutes must be a positive whole number" >&2
      exit 2
    fi
    timeout_seconds=$((minutes * 60))
    start_seconds=$(date +%s) || exit 1
    deadline_seconds=$((start_seconds + timeout_seconds))
    tick=0
    while :; do
      now_seconds=$(date +%s) || exit 1
      elapsed_seconds=$((now_seconds - start_seconds))
      observation=$(status_observation "$sha" "$since") || exit 1
      echo "wait tick=$tick elapsed=${elapsed_seconds}s/${timeout_seconds}s $observation"
      case "$observation" in
        codex=findings*) exit 10 ;;
        codex=clean*) exit 0 ;;
        codex=head-changed*) exit 12 ;;
        codex=unavailable\ reason=usage_limit*) exit 13 ;;
      esac
      now_seconds=$(date +%s) || exit 1
      if [ "$now_seconds" -ge "$deadline_seconds" ]; then
        echo "wait timeout after ${minutes}m; last observation: $observation" >&2
        exit 11
      fi
      remaining_seconds=$((deadline_seconds - now_seconds))
      sleep_seconds=60
      if [ "$remaining_seconds" -lt "$sleep_seconds" ]; then sleep_seconds="$remaining_seconds"; fi
      sleep "$sleep_seconds"
      tick=$((tick + 1))
    done
    ;;
  ci-wait)
    shift
    ci_wait_main "$@"
    ;;
  scope)
    # The risk-scoped verdict for the PR's current head, as one JSON line.
    scope_eval || exit 1
    claim_now_iso=""
    claims="[]"
    if [ "$SCOPE_MODE" = risk-scoped ]; then
      claim_now_iso=$(claim_now) || claim_now_iso=""
      if [ -n "$claim_now_iso" ]; then
        claims=$(live_review_claims "$SCOPE_HEAD" "$claim_now_iso") || claims="[]"
      fi
    fi
    if printf '%s' "$claims" | jq -e 'length > 0' >/dev/null 2>&1; then
      jq -cn --arg repo "$REPO" --arg pr "$PR" --arg head "$SCOPE_HEAD" --arg mode "$SCOPE_MODE" \
        --arg verdict "$SCOPE_VERDICT" --argjson labels "$SCOPE_LABELS" --arg reason "$SCOPE_REASON" --argjson claims "$claims" \
        '{repo: $repo, pr: ($pr | tonumber), head: $head, mode: $mode, verdict: $verdict, labels: $labels, reason: $reason, reviewClaims: $claims}'
    else
      jq -cn --arg repo "$REPO" --arg pr "$PR" --arg head "$SCOPE_HEAD" --arg mode "$SCOPE_MODE" \
        --arg verdict "$SCOPE_VERDICT" --argjson labels "$SCOPE_LABELS" --arg reason "$SCOPE_REASON" \
        '{repo: $repo, pr: ($pr | tonumber), head: $head, mode: $mode, verdict: $verdict, labels: $labels, reason: $reason}'
    fi
    ;;
  request)
    # The only sanctioned way to ask for a round, and only in a risk-scoped
    # repo. Every refusal posts nothing and has its own exit code (header).
    scope_eval || exit 1
    if [ "$SCOPE_MODE" = legacy ]; then
      echo "request refused: $REPO is not risk-scoped — automatic review handles this repo; never request a review here" >&2
      exit 20
    fi
    if [ "$SCOPE_VERDICT" != review ]; then
      echo "request refused: scope verdict for $SCOPE_HEAD is $SCOPE_VERDICT ($SCOPE_REASON); it merges on green CI without a review round" >&2
      exit 21
    fi
    markers=$(request_markers) || exit 1
    if printf '%s' "$markers" | jq -e --arg head "$SCOPE_HEAD" 'any(.[]; .head == $head)' >/dev/null; then
      echo "request refused: a review of $SCOPE_HEAD was already requested; wait for it instead of asking twice" >&2
      exit 22
    fi
    # "After two failed corrections, stop correcting and reframe": the initial
    # review plus two correction rounds. This cap is also what bounds a class
    # the churn gate cannot see — the gate derives seams from imports, so
    # findings on Markdown/YAML sites never gate (PR #566: 12 rounds).
    cap="${REVIEW_ROUND_CAP:-3}"
    if ! [[ "$cap" =~ ^[1-9][0-9]*$ ]]; then
      echo "REVIEW_ROUND_CAP must be a positive whole number" >&2
      exit 2
    fi
    requested=$(printf '%s' "$markers" | jq -er 'length') || exit 1
    if [ "$requested" -ge "$cap" ]; then
      {
        echo "CAP: $requested of $cap review rounds already requested on PR #$PR — do not request another."
        echo "Stop the loop, summarize the open findings (codex-review.sh open), and escalate to the"
        echo "operator, or restart in a fresh session with a reframed prompt."
      } >&2
      exit 23
    fi
    round=$((requested + 1))
    # See a local review before burning this PR-wide round budget, but never
    # refuse: a crashed session cannot be allowed to strand the PR.
    claim_now_iso=$(claim_now) || claim_now_iso=""
    claims="[]"
    if [ -n "$claim_now_iso" ]; then
      claims=$(live_review_claims "$SCOPE_HEAD" "$claim_now_iso") || claims="[]"
    fi
    review_claim_advisories "$claims" "warning: " "; this request spends round $round/$cap" >&2 || true
    # A request starts a round, so the churn gate judges it as it judges a push:
    # committed history at the head the reviewer will read. Exit 3 propagates.
    run_gate --committed-only --head "$SCOPE_HEAD"
    url=$(gh pr comment "$PR" --repo "$REPO" --body "@codex review

<!-- pr-review-loop:request head=$SCOPE_HEAD round=$round -->")
    echo "requested: round=$round/$cap head=$SCOPE_HEAD $url"
    ;;
  claim)
    # A reviewer starts a local/adversarial review by creating one bounded
    # advisory marker. The shared GitHub account cannot identify that session,
    # hence the explicit owner label.
    shift
    head="" owner="" ttl="$REVIEW_CLAIM_DEFAULT_TTL_MINUTES"
    while [ $# -gt 0 ]; do
      case "$1" in
        --head)
          [ $# -ge 2 ] || { echo "claim: --head needs a full sha" >&2; exit 2; }
          head="$2"; shift 2 ;;
        --owner)
          [ $# -ge 2 ] || { echo "claim: --owner needs a session label" >&2; exit 2; }
          owner="$2"; shift 2 ;;
        --ttl-minutes)
          [ $# -ge 2 ] || { echo "claim: --ttl-minutes needs 1-$REVIEW_CLAIM_MAX_TTL_MINUTES" >&2; exit 2; }
          ttl="$2"; shift 2 ;;
        *) echo "claim: unknown argument $1" >&2; exit 2 ;;
      esac
    done
    if ! [[ "$head" =~ ^[0-9a-f]{40}$ ]]; then
      echo "claim: --head must be the full 40-character SHA" >&2
      exit 2
    fi
    if ! [[ "$owner" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$ ]]; then
      echo "claim: --owner must be a 1-64 character session label ([A-Za-z0-9._:-])" >&2
      exit 2
    fi
    if ! [[ "$ttl" =~ ^[1-9][0-9]*$ ]] || [ "$ttl" -gt "$REVIEW_CLAIM_MAX_TTL_MINUTES" ]; then
      echo "claim: --ttl-minutes must be a whole number from 1 to $REVIEW_CLAIM_MAX_TTL_MINUTES" >&2
      exit 2
    fi
    scope_eval || exit 1
    if [ "$head" != "$SCOPE_HEAD" ]; then
      echo "claim: --head $head is not the current PR head $SCOPE_HEAD" >&2
      exit 2
    fi
    claim_now_iso=$(claim_now) || exit 1
    claim=$(current_live_review_claim_for_owner "$SCOPE_HEAD" "$claim_now_iso" "$owner") || claim=""
    if [ -n "$claim" ]; then
      echo "claim: $(review_claim_advisory "$claim"); this owner already has a live marker"
      exit 0
    fi
    claim_marker_fields "$owner" "$ttl" || exit 1
    url=$(gh pr comment "$PR" --repo "$REPO" --body "$(explicit_claim_marker "$head" "$owner")")
    echo "claim: id=$CLAIM_ID owner=$owner head=$head started=$CLAIM_STARTED expires=$CLAIM_EXPIRES $url"
    ;;
  merge-check)
    shift
    merge_check_main "$@"
    ;;
  merge)
    # The one merge path for a risk-scoped repo (SKILL.md, Risk-scoped repos):
    # merge-check for exactly this head, and `gh pr merge --match-head-commit`
    # on its exit 0 and nothing else. Twice a pipeline swallowed a refusal —
    # `merge-check | tail -1 && gh pr merge` merged #675 over a missing
    # Fixes-PR line, and a grep pipe hid a red vitest before #401 merged — so
    # the decision and the merge are one command, and the decision is
    # merge-check itself, merge_check_main, not a restatement of it. Exit 25
    # (the base moved during the check) runs it once more; every other refusal
    # passes its own code through, and nothing merges. It never deletes the
    # branch: `gh pr merge --delete-branch` also switches the local checkout,
    # which in a shared worktree is not this command's to move.
    shift
    head="" method=merge
    while [ $# -gt 0 ]; do
      case "$1" in
        --head)
          [ $# -ge 2 ] || { echo "merge: --head needs a sha" >&2; exit 2; }
          head="$2"; shift 2 ;;
        --method) method="${2:?--method needs merge or squash}"; shift 2 ;;
        *) echo "merge: unknown argument $1" >&2; exit 2 ;;
      esac
    done
    if ! [[ "$head" =~ ^[0-9a-f]{40}$ ]]; then
      echo "merge: --head must be the full 40-character SHA you checked" >&2
      exit 2
    fi
    case "$method" in
      merge|squash) ;;
      # GitHub does not sign a rebase merge, so main-provenance.yml's
      # provenance job fails one (see that workflow's header).
      *) echo "merge: --method must be merge or squash; a rebase merge fails main provenance" >&2; exit 2 ;;
    esac
    # merge-check runs in a subshell of this process, never a new process: a
    # new one would read the script from disk again, and run whatever file sat
    # at that path by then, which another process could have replaced with one
    # that exits 0. The subshell runs the code this process has already read,
    # and contains merge-check's exits. Errexit stays on inside it, as when
    # merge-check runs on its own; `set +e` only keeps a refusal from ending
    # this shell before its code is read. `( ... ) || checked=$?` would not do:
    # bash ignores errexit in anything run on the left of `||`, a subshell
    # that sets it again included (bash(1), `set -e`).
    set +e
    ( set -e; merge_check_main --head "$head" )
    checked=$?
    set -e
    if [ "$checked" -eq 25 ]; then
      echo "merge: the base moved while merge-check ran; checking once more" >&2
      set +e
      ( set -e; merge_check_main --head "$head" )
      checked=$?
      set -e
    fi
    [ "$checked" -eq 0 ] || exit "$checked"
    gh pr merge "$PR" --repo "$REPO" "--$method" --match-head-commit "$head" || {
      echo "merge=failed head=$head: merge-check allowed it, but gh pr merge did not merge PR #$PR" >&2
      exit 27
    }
    merged=$(gh pr view "$PR" --repo "$REPO" --json state,mergeCommit) || merged='{}'
    commit=$(printf '%s' "$merged" | jq -r 'if .state == "MERGED" then (.mergeCommit.oid // empty) else empty end')
    if [ -z "$commit" ]; then
      echo "merge=failed head=$head: gh pr merge returned success, but PR #$PR does not read as merged" >&2
      exit 27
    fi
    echo "merged pr=$PR head=$head method=$method commit=$commit"
    ;;
  audit)
    # After the fact: would merge-check have allowed this merged PR, at its
    # merged head, as of its merge? main-provenance.yml's gate-audit job runs
    # it on every push to main, its daily gate-audit-sweep job runs it for any
    # merge whose push-triggered audit left no result, and
    # .github/scripts/gate-audit.sh files one `gate-bypass` issue per PR
    # either flags. The rules are merge-check's as written in the copy of this
    # script that runs, through the same helpers: the rules are the audit code
    # of the commit being judged. Both jobs run the copy that merge commit
    # carries, so an audit applies the rules that commit carries. A manual
    # backfill with newer code applies newer rules to older merges, such as
    # today's reviewer allowlist to a receipt posted before it existed.
    #
    # What IS pinned to the merge is the moment, and the commit the PR merged
    # onto. Only a merge or a squash names that commit: a merge commit whose
    # second parent is the PR's head merged onto its first parent, and a
    # single-parent commit GitHub signed is a squash onto its parent. Anything
    # else is a rebase merge, which GitHub does not sign (main-provenance.yml's
    # header) and whose first parent can be one of the PR's own commits, or a
    # merge made by hand. `merge` makes neither, so either is a violation,
    # never judged from a guessed base. As of mergedAt (GATE_AS_OF): the title
    # and body (#675's Fixes-PR line was added a minute after it merged); the
    # labels, replayed from the PR's labeled and unlabeled events; receipts and
    # review requests posted before it and not edited since; Codex reviews and
    # thumbs-up given before it; and CI runs created before it and finished by
    # it.
    #
    # Two things are read as they stand now. Review-thread resolution: GitHub
    # keeps whether a thread is resolved and by whom, never when (the
    # PullRequestReviewThread type has isResolved and resolvedBy, and no time),
    # so a merge over an open Codex thread that someone resolves afterwards
    # passes. What that cannot supply is the review itself: a Codex-review
    # basis still needs status_observation's clean review of this head, or its
    # thumbs-up, to predate the merge. And whether a receipt's author is an
    # owner, member or collaborator, which decides whether the receipt counts
    # at all. A legacy repo had no gate to bypass.
    shift
    [ $# -eq 0 ] || { echo "audit: takes no arguments; set PR" >&2; exit 2; }
    audit_pr=$(gh api graphql -f query='
      query($owner:String!,$name:String!,$pr:Int!){
        repository(owner:$owner,name:$name){ pullRequest(number:$pr){
          state mergedAt headRefOid title body
          mergeCommit{ oid parents(first:3){ totalCount nodes{ oid } } signature{ isValid wasSignedByGitHub } }
          userContentEdits(first:100){ pageInfo{hasNextPage} nodes{ editedAt deletedAt diff } }
          renames: timelineItems(itemTypes:[RENAMED_TITLE_EVENT],first:100){ pageInfo{hasNextPage} nodes{ ... on RenamedTitleEvent{ createdAt previousTitle } } }
          labelEvents: timelineItems(itemTypes:[LABELED_EVENT,UNLABELED_EVENT],first:100){ pageInfo{hasNextPage} nodes{
            __typename ... on LabeledEvent{ createdAt label{ name } } ... on UnlabeledEvent{ createdAt label{ name } } } }
        } } }' -F owner="$OWNER" -F name="$NAME" -F pr="$PR") || { echo "audit=error pr=$PR: could not read the PR" >&2; exit 1; }
    state=$(printf '%s' "$audit_pr" | jq -er '.data.repository.pullRequest.state') || { echo "audit=error pr=$PR: could not read the PR's state" >&2; exit 1; }
    if [ "$state" != MERGED ]; then
      echo "audit: PR #$PR is $state, not merged; there is no merge to audit" >&2
      exit 2
    fi
    # How it merged, and so onto what.
    shape=$(printf '%s' "$audit_pr" | jq -ce '
      .data.repository.pullRequest as $p
      | ($p.mergeCommit // error("no merge commit"))
      | { oid, mergedAt: $p.mergedAt, head: $p.headRefOid, count: .parents.totalCount, parents: [ .parents.nodes[].oid ],
          signed: (.signature.isValid == true and .signature.wasSignedByGitHub == true) }
      | .method = (if .count == 2 and .parents[1] == .head then "merge" elif .count == 1 and .signed then "squash" else null end)') \
      || { echo "audit=error pr=$PR: could not read its merge commit" >&2; exit 1; }
    if [ "$(printf '%s' "$shape" | jq -r '.method // "none"')" = none ]; then
      printf '%s' "$shape" | jq -r --arg pr "$PR" '
        "audit=violation pr=\($pr) head=\(.head) merged=\(.mergedAt): merge method the gate does not authorize (rebase or manual):"
        + " merge commit \(.oid) has \(.count) parent\(if .count == 1 then "" else "s" end) (\(.parents | join(", ")))"
        + " and \(if .signed then "is" else "is not" end) signed by GitHub"'
      exit 28
    fi
    # The PR as it stood at mergedAt. A body revision GitHub no longer shows (a
    # deleted edit), or a label event that names no label, is no answer, not a
    # pass.
    at_merge=$(printf '%s' "$audit_pr" | jq -ce --argjson shape "$shape" '
      .data.repository.pullRequest as $p
      | $p.mergedAt as $t
      | if $p.userContentEdits.pageInfo.hasNextPage or $p.renames.pageInfo.hasNextPage or $p.labelEvents.pageInfo.hasNextPage
        then error("more than 100 body edits, title renames or label events") else . end
      | ([ $p.userContentEdits.nodes[] | select(.editedAt <= $t) ] | max_by(.editedAt)) as $rev
      | { mergedAt: $t,
          head: $p.headRefOid,
          base: $shape.parents[0],
          title: (([ $p.renames.nodes[] | select(.createdAt > $t) ] | min_by(.createdAt) | .previousTitle) // $p.title),
          body: (if ($p.userContentEdits.nodes | length) == 0 then $p.body
                 elif $rev == null or $rev.deletedAt != null or $rev.diff == null then error("its body revision at the merge is gone")
                 else $rev.diff end),
          labels: (reduce ([ $p.labelEvents.nodes[] | select(.createdAt <= $t) ] | sort_by(.createdAt))[] as $e ([];
                     ($e.label.name // error("a label event names no label")) as $name
                     | if $e.__typename == "LabeledEvent" then . + [$name] | unique else . - [$name] end)) }') \
      || { echo "audit=error pr=$PR: could not reconstruct the PR as it stood at its merge" >&2; exit 1; }
    GATE_AS_OF=$(printf '%s' "$at_merge" | jq -r .mergedAt)
    SCOPE_PIN_BASE=$(printf '%s' "$at_merge" | jq -r .base)
    GATE_LABELS=$(printf '%s' "$at_merge" | jq -c .labels)
    audit_head=$(printf '%s' "$at_merge" | jq -r .head)
    where="pr=$PR head=$audit_head base=$SCOPE_PIN_BASE merged=$GATE_AS_OF"
    scope_eval || { echo "audit=error $where: no scope verdict" >&2; exit 1; }
    if [ "$SCOPE_MODE" = legacy ]; then
      echo "audit=legacy $where: not risk-scoped at the commit it merged onto, so merge-check deferred it to Step 6"
      exit 0
    fi
    if [ "$SCOPE_HEAD" != "$audit_head" ]; then
      echo "audit=error $where: GitHub now reports head $SCOPE_HEAD" >&2
      exit 1
    fi
    where="$where verdict=$SCOPE_VERDICT"
    fix_link=$(printf '%s' "$at_merge" | fix_link_state) || { echo "audit=error $where: could not read the title and body" >&2; exit 1; }
    case "$fix_link" in
      ok) ;;
      missing)
        echo "audit=violation $where: a fix PR merged with no 'Fixes-PR:' line in its body at merge time"
        exit 28
        ;;
      *)
        echo "audit=error $where: the Fixes-PR check gave no verdict (got \"$fix_link\")" >&2
        exit 1
        ;;
    esac
    ci=$(ci_verdict "$audit_head") || { echo "audit=error $where: could not read CI on the head" >&2; exit 1; }
    case "$ci" in
      '') ;;
      ci_host:*) where="$where ci=host" ;;
      *)
        echo "audit=violation $where: $ci"
        exit 28
        ;;
    esac
    receipt_raw=$(receipt_outcome "$audit_head") || { echo "audit=error $where: could not read receipts" >&2; exit 1; }
    receipt="${receipt_raw%%$'\t'*}"
    receipt_reviewer="${receipt_raw#*$'\t'}"
    if [ "$receipt" = unknown ]; then
      case "$receipt_reviewer" in
        receipt_order_unknown:*)
          # A receipt's own database id can't place it in posting order — never
          # inferred from createdAt or any other field.
          echo "audit=violation $where: $receipt_reviewer"
          ;;
        *)
          echo "audit=violation $where: $receipt_reviewer; that comment could have been a later substitute receipt, so what the receipts said at the merge is unknown"
          ;;
      esac
      exit 28
    fi
    if [ "$receipt" = changes ]; then
      echo "audit=violation $where: the latest substitute receipt before the merge asked for changes"
      exit 28
    fi
    # The review-notes rule, with the body at the merge and the comparison onto
    # the commit it merged onto; receipts as of the merge (changes_receipt_state).
    notes=$(review_notes_state "$at_merge") || { echo "audit=error $where: could not read receipts" >&2; exit 1; }
    case "$notes" in
      ok) ;;
      review_notes_missing:*)
        echo "audit=violation $where: $notes"
        exit 28
        ;;
      *)
        echo "audit=error $where: the review-notes check gave no verdict (got \"$notes\")" >&2
        exit 1
        ;;
    esac
    if [ "$SCOPE_VERDICT" = skip ]; then
      echo "audit=pass $where: $SCOPE_REASON"
      exit 0
    fi
    if [ "$receipt" = approve ]; then
      if reviewer_model_allowed "$receipt_reviewer"; then
        echo "audit=pass $where: an approving substitute receipt before the merge ($receipt_reviewer)"
        exit 0
      fi
      echo "audit=violation $where: the approving substitute receipt names a disallowed reviewer (\"$receipt_reviewer\")"
      exit 28
    fi
    markers=$(request_markers) || { echo "audit=error $where: could not read review requests" >&2; exit 1; }
    since=$(printf '%s' "$markers" | jq -r --arg head "$audit_head" '[.[] | select(.head == $head)] | first | .at // empty') || exit 1
    if [ -z "$since" ]; then
      echo "audit=violation $where: it merged with no review of this head requested and no approving receipt before the merge ($SCOPE_REASON)"
      exit 28
    fi
    observation=$(status_observation "$audit_head" "$since") || { echo "audit=error $where: could not read the Codex review" >&2; exit 1; }
    case "$observation" in
      codex=clean*) echo "audit=pass $where: $observation" ;;
      *)
        echo "audit=violation $where: $observation before the merge; latest substitute receipt: ${receipt:-none}"
        exit 28
        ;;
    esac
    ;;
  receipt)
    # A substitute review's durable receipt (docs/review-policy.md, "Review
    # availability"), tied to exactly one head. The reviewer is a fresh
    # context, never the implementing session; the body file carries its
    # complete-diff and relevant-file scope and every finding with its
    # disposition. `merge-check` reads the marker this writes.
    shift
    head="" outcome="" reviewer="" body_file="" claim_id="" claim_owner=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --head)
          [ $# -ge 2 ] || { echo "receipt: --head needs a sha" >&2; exit 2; }
          head="$2"; shift 2 ;;
        --outcome) outcome="${2:?--outcome needs approve or changes}"; shift 2 ;;
        --reviewer) reviewer="${2:?--reviewer needs the model and runtime}"; shift 2 ;;
        --body-file) body_file="${2:?--body-file needs a file}"; shift 2 ;;
        --claim)
          [ $# -ge 2 ] || { echo "receipt: --claim needs a claim id" >&2; exit 2; }
          claim_id="$2"; shift 2 ;;
        --claim-owner)
          [ $# -ge 2 ] || { echo "receipt: --claim-owner needs the claim owner label" >&2; exit 2; }
          claim_owner="$2"; shift 2 ;;
        *) echo "receipt: unknown argument $1" >&2; exit 2 ;;
      esac
    done
    if ! [[ "$head" =~ ^[0-9a-f]{40}$ ]]; then
      echo "receipt: --head must be the full 40-character SHA the substitute reviewer read" >&2
      exit 2
    fi
    case "$outcome" in
      approve|changes) ;;
      *) echo "receipt: --outcome must be approve or changes" >&2; exit 2 ;;
    esac
    if [ -z "$reviewer" ] || [ -z "$body_file" ] || [ ! -s "$body_file" ]; then
      echo "receipt: needs --reviewer and a non-empty --body-file (scope, then every finding with its disposition)" >&2
      exit 2
    fi
    if { [ -n "$claim_id" ] && [ -z "$claim_owner" ]; } || { [ -z "$claim_id" ] && [ -n "$claim_owner" ]; }; then
      echo "receipt: --claim and --claim-owner must be supplied together" >&2
      exit 2
    fi
    if [ -n "$claim_id" ] && ! [[ "$claim_id" =~ ^[A-Za-z0-9._:-]{1,96}$ ]]; then
      echo "receipt: --claim must be a 1-96 character claim id ([A-Za-z0-9._:-])" >&2
      exit 2
    fi
    if [ -n "$claim_owner" ] && ! [[ "$claim_owner" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$ ]]; then
      echo "receipt: --claim-owner must be a 1-64 character session label ([A-Za-z0-9._:-])" >&2
      exit 2
    fi
    # merge-check re-reads --reviewer back out of the posted comment body via a
    # single-line regex (RECEIPT_REVIEWER_LINE_RE); a newline or CR embedded in
    # --reviewer here would post fine but be read back differently there. Refuse
    # it at the source instead of letting the two ends disagree.
    case "$reviewer" in
      *$'\n'*|*$'\r'*)
        echo "receipt: --reviewer may not contain a newline or carriage return" >&2
        exit 2
        ;;
    esac
    # Reviewer eligibility is a tier rule, not prose: --reviewer's FIRST
    # whitespace-delimited token must be a concrete model id outside
    # REVIEWER_DENIED_TIERS. Only that token is read, so whatever follows it is
    # free text. See reviewer_model_refusal above and docs/review-policy.md.
    if ! reviewer_model_allowed "$reviewer"; then
      echo "receipt: --reviewer refused — $(reviewer_model_refusal "$reviewer")" >&2
      exit 2
    fi
    body=$(cat "$body_file")
    # This command writes the receipt's only marker. One smuggled in through the
    # body or the reviewer would be read first and could approve another head.
    case "$reviewer$body" in
      *pr-review-loop:*)
        echo "receipt: --reviewer and the body may not contain a pr-review-loop marker" >&2
        exit 2
        ;;
    esac
    claim_completion=""
    if [ -n "$claim_id" ]; then
      claim_completion="
<!-- pr-review-loop:claim-complete id=$claim_id owner=$claim_owner head=$head -->"
    fi
    url=$(gh pr comment "$PR" --repo "$REPO" --body "### Substitute review receipt

- **Head:** \`$head\`
- **Reviewer and runtime:** $reviewer
- **Outcome:** $outcome

$body

<!-- pr-review-loop:substitute-receipt head=$head outcome=$outcome -->$claim_completion")
    echo "receipt: outcome=$outcome head=$head $url"
    ;;
  *) echo "unknown command: $1" >&2; exit 2 ;;
esac
