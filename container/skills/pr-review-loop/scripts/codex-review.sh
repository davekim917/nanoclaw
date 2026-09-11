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
#   codex-review.sh scope                     # risk-scoped repos: JSON {repo,pr,head,mode,verdict,labels,reason} for the current head
#   codex-review.sh request                   # risk-scoped repos: post `@codex review` for the current head when every rule allows it
#   codex-review.sh merge-check [--head <sha>]
#                                             # exit 0 only when merging exactly that head is allowed
#   codex-review.sh merge --head <sha> [--method merge|squash]
#                                             # risk-scoped repos' only merge path: merge-check, then gh pr merge on its exit 0 alone
#   codex-review.sh audit                     # a merged PR against merge-check's rules as of its merge; exit 28 = it bypassed the gate
#   codex-review.sh receipt --head <sha> --outcome approve|changes --reviewer "<model + runtime>" --body-file <file>
#                                             # post a substitute review's durable receipt for exactly that head
#
# Exit codes, one contract across commands (0 and 3 are the originals):
#   0   pass; verdict printed; merge allowed. For merge-check, only `merge=allowed`
#   1   no verdict — a GitHub read or validation failed; never read it as a pass
#   2   usage, no JS runtime, or a push shape the churn gate cannot judge
#   3   REFRAME REQUIRED — the churn gate refused (gate, push, request)
#   10  wait: findings   11 wait: timeout   12 wait: head changed   13 wait: connector unavailable
#   20  request: not risk-scoped — automatic review handles this repo; never request
#   21  request: scope verdict is skip — this head merges on green CI, no round
#   22  request: a review of this head was already requested
#   23  request: REVIEW_ROUND_CAP reached — stop, summarize, escalate or reframe
#   24  merge-check: merging this head is not allowed — CI is not green on it, it has
#       neither a clean Codex review nor an approving substitute receipt, or it is a
#       fix PR whose body has no Fixes-PR line
#   25  merge-check: the base branch moved while the check ran, or could not be
#       re-read, so the verdict may be stale — re-run merge-check
#   26  merge-check: `merge=defer mode=legacy` — not risk-scoped, so SKILL.md Step 6's
#       evidence rules decide this merge; never chain it into `gh pr merge`
#   27  merge: merge-check allowed the head, but `gh pr merge` did not merge it
#   28  audit: merge-check would have refused this PR at its merge — a gate bypass
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
          author{login} createdAt body
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
# `request` refuses, `merge-check` defers, and no command above this block
# reads any of it.
RISK_LABEL_WORKFLOW='Risk label'
# release-policy.py's own contexts are a policy gate, not CI: a pending human approval must never read as ci_pending.
CI_EXCLUDED_CONTEXTS='["Release policy","Release approval"]'
# The request marker, hidden in the rendered comment. It is how `request`
# dedupes per head and counts rounds, and how `merge-check` learns when THIS
# head's review was asked for.
REQUEST_MARKER_RE='(^|\n)<!-- pr-review-loop:request head=(?<head>[0-9a-f]{40}) round=(?<round>[0-9]+) -->'
# A substitute review's receipt (docs/review-policy.md, "Review availability").
# When Codex cannot review, the latest receipt for exactly this head decides
# instead. Only an author with write access counts: a receipt unlocks a merge,
# and anyone who can read a public repo can comment on its PRs.
RECEIPT_MARKER_RE='(^|\n)<!-- pr-review-loop:substitute-receipt head=(?<head>[0-9a-f]{40}) outcome=(?<outcome>approve|changes) -->'
# The receipt body's human-readable "who reviewed" line, used to recover the
# reviewer text for a model-allowlist check — the marker itself carries only
# head/outcome, never the reviewer, so this is read separately from the body
# `receipt` has always written. A receipt posted before the allowlist gate
# existed still carries this line; it passes the gate only if its FIRST token
# already happens to be a model this file now lists — otherwise post a fresh
# receipt (`codex-review.sh receipt ...`) with an allowlisted `--reviewer`.
RECEIPT_REVIEWER_LINE_RE='\*\*Reviewer and runtime:\*\* (?<reviewer>[^\n]+)'
# A conventional-commit fix title, and the body line `merge-check` requires of
# one: the PR it fixes, or `none`. The follow-up measurement in
# docs/specs/risk-based-review/plan.md links a fix to its PR through this line.
FIX_TITLE_RE='^\s*fix(\([^)]*\))?!?:'
FIXES_PR_LINE_RE='(^|\n)Fixes-PR:[ \t]*(#[0-9]+|none)\b'

# `missing` when a fix title's body has no Fixes-PR line, else `ok`, for a
# {title, body} JSON object on stdin — merge-check's rule, and audit's. A line
# inside a code fence or an HTML comment is an example or a template, not a
# link, so both are cut first. Fences follow CommonMark: up to 3 spaces, then
# 3+ backticks or 3+ tildes; only a bare run of the same character, at least
# as long, closes one; an unclosed fence runs to the end, as GitHub renders it.
fix_link_state() {
  jq -r --arg titleRe "$FIX_TITLE_RE" --arg lineRe "$FIXES_PR_LINE_RE" '
    def unfenced:
      reduce split("\n")[] as $line ({out: [], fence: null};
        ($line | capture("^ {0,3}(?<run>`{3,}|~{3,})") // null) as $open
        | if .fence == null then
            if $open then .fence = $open.run else .out += [$line] end
          elif $open and ($open.run[0:1] == .fence[0:1]) and (($open.run | length) >= (.fence | length))
               and ($line | test("^ {0,3}" + $open.run + "[ \t]*\r?$")) then .fence = null
          else . end)
      | .out | join("\n");
    (.body // "" | unfenced | gsub("<!--[\\s\\S]*?(-->|$)"; "")) as $body
    | if (.title | test($titleRe; "i")) and ($body | test($lineRe; "i") | not) then "missing" else "ok" end'
}

# The reviewer-model allowlist, generated by scripts/reviewer-models.ts from the
# worker-high/worker-frontier tier config — see that file's header. Read next to
# THIS script (via $HERE, already resolved above from BASH_SOURCE), not the
# caller's cwd or $REPO: a repo that vendors this skill carries its own copy
# next to the script, so the allowlist this reads is whichever copy of the
# skill directory $HERE sits in — the caller's job is to make sure that's
# main's copy at main's CURRENT tip, never the PR branch's (a PR could
# otherwise edit its own way past the gate) and never a stale checkout (which
# runs whatever the gate was at that older commit, silently — no failure).
#
# A merge-check run MUST extract the whole skill directory, not just this
# script, or REVIEWER_MODELS_FILE resolves to nothing next to it and every
# receipt/merge-check call fails closed (see reviewer_model_allowed's error
# below). The one supported extraction (mergers typically run this from
# outside the repo entirely, so the destination is a scratch dir):
#   SP=<scratch dir>
#   git -C <repo> fetch origin main
#   mkdir -p "$SP" && git -C <repo> archive origin/main container/skills/pr-review-loop | tar -x -C "$SP"
#   "$SP"/container/skills/pr-review-loop/scripts/codex-review.sh ...
# A single-file extraction (copying just codex-review.sh) or `bash <(git show
# origin/main:container/skills/pr-review-loop/scripts/codex-review.sh)` has no
# sibling reviewer-models.txt on disk and fails closed the same way.
REVIEWER_MODELS_FILE="$HERE/../reviewer-models.txt"

# True (exit 0) when free-text $1's FIRST whitespace-delimited token, with any
# trailing `[1m]` context-window suffix stripped, case-insensitively equals one
# of the model ids in REVIEWER_MODELS_FILE. Only the first token counts — the
# documented receipt format leads with the model id (SKILL.md, review-policy.md)
# — so "claude-sonnet-5 (fallback from claude-opus-5)" is refused even though it
# mentions an allowed id later in the string. This also closes off smuggling a
# grep-option-shaped token (e.g. "-V", "--help") anywhere but the first
# position: the whole comparison is pure bash string equality below, so no
# argument here — first token, file lines, or otherwise — is ever handed to an
# external command as an unguarded argument.
reviewer_model_allowed() {
  local text="${1:-}" first candidate line entry
  first="${text%%[[:space:]]*}"
  candidate=$(printf '%s' "$first" | tr '[:upper:]' '[:lower:]')
  candidate="${candidate%\[1m\]}"
  [ -f "$REVIEWER_MODELS_FILE" ] || {
    echo "reviewer_model_allowed: $REVIEWER_MODELS_FILE not found — the merge-check/receipt caller must extract the whole" \
         "container/skills/pr-review-loop directory from main (e.g. \`git archive origin/main container/skills/pr-review-loop |" \
         "tar -x -C <dir>\`), not just this script, so reviewer-models.txt is on disk next to it" >&2
    return 1
  }
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      ''|'#'*) continue ;;
    esac
    entry=$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')
    [ "$candidate" = "$entry" ] && return 0
  done < "$REVIEWER_MODELS_FILE"
  return 1
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

# `audit` alone sets these, to judge a merged PR as of its merge: the commit it
# merged onto, and the moment its evidence must predate. Assigned here rather
# than read from the environment, so no caller of merge-check can pin its base
# or backdate its evidence.
SCOPE_PIN_BASE=""
GATE_AS_OF=""

# The commit branch $1 points at now, or non-zero.
base_tip() {
  gh api "repos/$REPO/git/ref/heads/$(jq -rn --arg r "$1" '$r | split("/") | map(@uri) | join("/")')" \
    | jq -er '.object.sha | strings | select(test("^[0-9a-f]{40}$"))'
}

scope_eval() {
  local pr_json base files after decision
  pr_json=$(gh pr view "$PR" --repo "$REPO" --json headRefOid,baseRefName,labels) || return 1
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
  after=$(printf '%s' "$pr_json" | jq -er .headRefOid) || return 1
  SCOPE_LABELS=$(printf '%s' "$pr_json" | jq -c '[.labels[]?.name]') || return 1
  if [ "$after" != "$SCOPE_HEAD" ]; then
    SCOPE_REASON="fail closed: the head moved from $SCOPE_HEAD while its changed files were listed"
    SCOPE_HEAD="$after"
    return 0
  fi
  # The comparison goes through stdin, not --argjson: with its patches it can
  # exceed the kernel's per-argument limit. The reason names the first few
  # matches.
  decision=$(printf '%s' "$files" | jq -c -L "$HERE" --arg yml "$LABELER_YML" --argjson pr "$pr_json" '
    include "risk-scope";
    [ $pr.labels[]?.name | select(. == "risk:high" or . == "review:requested") | "labeled \(.)" ] as $labeled
    | (try (
        ($yml | risk_high_globs | map(glob_regex)) as $regexes
        | if (.files | type) == "array" then .files else error("the comparison lists no files") end
        | if all(.[]; (.filename | type) == "string") then . else error("a changed file has no filename") end
        | ([ .[].filename ] | unique | length) as $listed
        | if $listed >= 300 then error("the comparison lists \($listed) files, the most GitHub lists, so some may be missing")
          elif ($pr.changedFiles | type) != "number" then error("GitHub did not say how many files this PR changes")
          elif $pr.changedFiles != $listed then error("the PR changes \($pr.changedFiles) files but the comparison lists \($listed)")
          else . end
        | [ .[] | .filename, (.previous_filename // empty) ] | unique | matching($regexes)
        | if length == 0 then []
          else [ "changes risk:high path\(if length > 1 then "s" else "" end) \(.[:3] | join(", "))\(if length > 3 then " and \(length - 3) more" else "" end)" ] end
      ) catch [ "fail closed: \(.)" ])
    | . + $labeled
    | if length == 0 then { verdict: "skip", reason: "no changed file matches a risk:high glob in .github/labeler.yml, and neither risk:high nor review:requested is on the PR" }
      else { verdict: "review", reason: join("; ") } end') || return 1
  SCOPE_VERDICT=$(printf '%s' "$decision" | jq -er .verdict) || return 1
  SCOPE_REASON=$(printf '%s' "$decision" | jq -er .reason) || return 1
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
# Under `audit`, a request made after GATE_AS_OF (the merge) never happened.
request_markers() {
  local pages
  pages=$(paginate_connection comments comments_page) || return 1
  printf '%s\n' "$pages" | jq -cs --arg re "$REQUEST_MARKER_RE" --arg asof "$GATE_AS_OF" '
    [ .[] | .data.repository.pullRequest.comments.nodes[]
      | .createdAt as $at
      | select($asof == "" or $at <= $asof)
      | [ (.body // "") | capture($re) ] | first // empty
      | { head, round: (.round | tonumber), at: $at } ]
    | sort_by(.at)'
}

# The comments connection again, with the author's relationship to the repo,
# which only receipts need.
receipt_comments_page() {
  gh api graphql -f query='
    query($owner:String!,$name:String!,$pr:Int!,$after:String){
      repository(owner:$owner,name:$name){ pullRequest(number:$pr){
        headRefOid comments(first:100,after:$after){ pageInfo{hasNextPage endCursor} nodes{
          author{login} authorAssociation createdAt body
        } }
      } }
    }' \
    -F owner="$OWNER" -F name="$NAME" -F pr="$PR" -F after="$1"
}

# The outcome of the latest substitute-review receipt for exactly HEAD, or
# nothing, as "<outcome>\t<reviewer text>" (reviewer text empty for a receipt
# written before the reviewer line existed). A later `changes` supersedes an
# earlier `approve`, and a receipt for any other head says nothing about this
# one. `outcome` alone (no tab, no reviewer) means no receipt was found. Under
# `audit`, a receipt posted after GATE_AS_OF (the merge) did not gate it.
receipt_outcome() {
  local pages
  pages=$(paginate_connection comments receipt_comments_page) || return 1
  printf '%s\n' "$pages" | jq -rs --arg re "$RECEIPT_MARKER_RE" --arg reviewerRe "$RECEIPT_REVIEWER_LINE_RE" --arg head "$1" --arg asof "$GATE_AS_OF" '
    [ .[] | .data.repository.pullRequest.comments.nodes[]
      | select(.authorAssociation == "OWNER" or .authorAssociation == "MEMBER" or .authorAssociation == "COLLABORATOR")
      | select($asof == "" or .createdAt <= $asof)
      | .createdAt as $at
      | .body as $body
      | [ ($body // "" | capture($re)) ] | first // empty
      | select(.head == $head)
      | { outcome, at: $at, reviewer: (($body // "" | capture($reviewerRe)).reviewer // "") } ]
    | sort_by(.at) | last
    | if . == null then empty else "\(.outcome)\t\(.reviewer)" end'
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
ci_verdict() {
  local runs statuses required="${CODEX_REVIEW_REQUIRED_WORKFLOWS:-CI}"
  runs=$(gh api --paginate --slurp "repos/$REPO/actions/runs?head_sha=$1&per_page=100") || return 1
  statuses=$(gh api --paginate --slurp "repos/$REPO/commits/$1/statuses?per_page=100") || return 1
  printf '%s\n%s\n' "$runs" "$statuses" | jq -rs --arg head "$1" --arg labeler "$RISK_LABEL_WORKFLOW" --arg requiredList "$required" --argjson excluded "$CI_EXCLUDED_CONTEXTS" --arg asof "$GATE_AS_OF" '
    ( $requiredList | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0)) ) as $required
    | ( [ .[0][].workflow_runs[]?
        | select(.head_sha == $head)
        | select($asof == "" or (.created_at // "") <= $asof)
        | select((.name == $labeler and .event == "pull_request_target") | not) ]
      | group_by(.name) | map(max_by([.run_started_at // .created_at // "", .id // 0])) ) as $runs
    | ( [ .[1][][]? | select(.context as $c | $excluded | index($c) | not)
          | select($asof == "" or (.created_at // "") <= $asof) ]
        | group_by(.context) | map(max_by([.created_at // "", .id // 0])) ) as $statuses
    | ( [ $runs[] | select(.status == "completed")
          | (.name as $n | $required | index($n) != null) as $isRequired
          | select((.conclusion // "") as $c | if $isRequired then $c != "success" else ($c | IN("success", "neutral", "skipped") | not) end)
          | "\(.name)=\(.conclusion // "none")\(if $isRequired then " (required)" else "" end)" ]
        + [ $statuses[] | select(.state != "success" and .state != "pending") | "\(.context)=\(.state)" ] ) as $red
    | [ $required[] | . as $n | select(any($runs[]; .name == $n) | not) ] as $missing
    | ( [ $runs[] | select(.status != "completed") | "\(.name)=\(.status)" ]
        + [ $statuses[] | select(.state == "pending") | "\(.context)=pending" ] ) as $pending
    | if ($runs | length) == 0 and ($statuses | length) == 0 then "ci_missing: no workflow run or commit status on this head — CI never ran"
      elif ($red | length) > 0 then "ci_red: " + ($red | join(", "))
      elif ($missing | length) > 0 then "ci_missing: " + ($missing | join(", ")) + " — required, but no run on this head"
      elif ($pending | length) > 0 then "ci_pending: " + ($pending | join(", "))
      else empty end'
}

case "${1:?usage: open|churn|classes|gate|push|body|reply|resolve|status|wait|scope|request|merge-check|merge|audit|receipt}" in
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
  scope)
    # The risk-scoped verdict for the PR's current head, as one JSON line.
    scope_eval || exit 1
    jq -cn --arg repo "$REPO" --arg pr "$PR" --arg head "$SCOPE_HEAD" --arg mode "$SCOPE_MODE" \
      --arg verdict "$SCOPE_VERDICT" --argjson labels "$SCOPE_LABELS" --arg reason "$SCOPE_REASON" \
      '{repo: $repo, pr: ($pr | tonumber), head: $head, mode: $mode, verdict: $verdict, labels: $labels, reason: $reason}'
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
    # A request starts a round, so the churn gate judges it as it judges a push:
    # committed history at the head the reviewer will read. Exit 3 propagates.
    run_gate --committed-only --head "$SCOPE_HEAD"
    round=$((requested + 1))
    url=$(gh pr comment "$PR" --repo "$REPO" --body "@codex review

<!-- pr-review-loop:request head=$SCOPE_HEAD round=$round -->")
    echo "requested: round=$round/$cap head=$SCOPE_HEAD $url"
    ;;
  merge-check)
    # Exit 0 only when merging exactly this head is allowed; the merge then pins
    # it with `gh pr merge --match-head-commit <head>`. A legacy repo exits 26,
    # not 0: its merge is Step 6's evidence rules, and a caller chaining
    # merge-check into `gh pr merge` must never read a defer as a pass. Its base
    # is re-read first, since a base that moved may have opted in since.
    shift
    want=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --head) want="${2:?--head needs a sha}"; shift 2 ;;
        *) echo "merge-check: unknown argument $1" >&2; exit 2 ;;
      esac
    done
    scope_eval || exit 1
    if [ "$SCOPE_MODE" = legacy ]; then
      refuse_if_base_moved
      echo "merge=defer mode=legacy: $REPO is not risk-scoped; the existing Step-6 evidence rules apply"
      exit 26
    fi
    if [ -n "$want" ] && [[ "$SCOPE_HEAD" != "$want"* ]]; then
      echo "merge=refused head=$SCOPE_HEAD: the PR head is not $want" >&2
      exit 24
    fi
    # A fix PR names the PR it fixes, or says `none` (fix_link_state). Read at
    # merge time: the title and body can both change after the PR opens.
    pr_text=$(gh pr view "$PR" --repo "$REPO" --json title,body) || exit 1
    fix_link=$(printf '%s' "$pr_text" | fix_link_state) || exit 1
    if [ "$fix_link" = missing ]; then
      echo "merge=refused head=$SCOPE_HEAD: a fix PR needs a 'Fixes-PR: #<n>' line in its body naming the PR it fixes, or 'Fixes-PR: none'" >&2
      exit 24
    fi
    # No branch protection holds this line, so merge-check does, whatever the
    # verdict: every check run on exactly this head, completed green.
    ci=$(ci_verdict "$SCOPE_HEAD") || exit 1
    if [ -n "$ci" ]; then
      echo "merge=refused head=$SCOPE_HEAD: $ci" >&2
      exit 24
    fi
    # A substitute reviewer who read exactly this head and said no outranks
    # everything else here: `changes` refuses under either verdict, a clean
    # Codex review included, until a later receipt for this head approves.
    receipt_raw=$(receipt_outcome "$SCOPE_HEAD") || exit 1
    receipt="${receipt_raw%%$'\t'*}"
    receipt_reviewer="${receipt_raw#*$'\t'}"
    if [ "$receipt" = changes ]; then
      echo "merge=refused head=$SCOPE_HEAD verdict=$SCOPE_VERDICT: latest substitute receipt: changes — a substitute reviewer said no on this head" >&2
      exit 24
    fi
    if [ "$SCOPE_VERDICT" = skip ]; then
      refuse_if_base_moved
      echo "merge=allowed head=$SCOPE_HEAD mode=risk-scoped verdict=skip ci=green base=$SCOPE_BASE: $SCOPE_REASON"
      exit 0
    fi
    # verdict=review: the latest substitute receipt for THIS head approves, or
    # the review requested for this head is clean. `status` is the loop's one
    # definition of clean — a review of this head (or a 👍) newer than the
    # request, no unresolved Codex thread from any round, the head unmoved — so
    # it is reused here, not restated.
    #
    # An approving receipt only unlocks the merge when its own reviewer field's
    # FIRST token names an allowed model — the tier rule in
    # reviewer_model_allowed above. A receipt whose first token isn't
    # allowlisted (including one written before this gate existed) fails the
    # check, which is fine: this only reads the receipt for the head currently
    # being merged, never a historical one — post a fresh receipt instead.
    if [ "$receipt" = approve ]; then
      if ! reviewer_model_allowed "$receipt_reviewer"; then
        echo "merge=refused head=$SCOPE_HEAD verdict=$SCOPE_VERDICT: the approving substitute receipt names a disallowed reviewer (\"$receipt_reviewer\") — post a new receipt (codex-review.sh receipt ...) whose --reviewer starts with a model id listed in $REVIEWER_MODELS_FILE" >&2
        exit 24
      fi
      refuse_if_base_moved
      echo "merge=allowed head=$SCOPE_HEAD mode=risk-scoped verdict=review ci=green base=$SCOPE_BASE: the latest substitute receipt for this head approves ($receipt_reviewer)"
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
        echo "merge=allowed head=$SCOPE_HEAD mode=risk-scoped verdict=review ci=green base=$SCOPE_BASE: $observation"
        ;;
      *)
        echo "merge=refused head=$SCOPE_HEAD verdict=review: $observation; latest substitute receipt: ${receipt:-none}" >&2
        exit 24
        ;;
    esac
    ;;
  merge)
    # The one merge path for a risk-scoped repo (SKILL.md, Risk-scoped repos):
    # merge-check for exactly this head, and `gh pr merge --match-head-commit`
    # on its exit 0 and nothing else. Twice a pipeline swallowed a refusal —
    # `merge-check | tail -1 && gh pr merge` merged #675 over a missing
    # Fixes-PR line, and a grep pipe hid a red vitest before #401 merged — so
    # the decision and the merge are one command, and the decision is
    # merge-check itself, run as a child of this script rather than restated
    # here. Exit 25 (the base moved during the check) runs it once more; every
    # other refusal passes its own code through, and nothing merges. It never
    # deletes the branch: `gh pr merge --delete-branch` also switches the local
    # checkout, which in a shared worktree is not this command's to move.
    shift
    head="" method=merge
    while [ $# -gt 0 ]; do
      case "$1" in
        --head) head="${2:?--head needs a sha}"; shift 2 ;;
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
    self="$HERE/$(basename "${BASH_SOURCE[0]}")"
    checked=0
    REPO="$REPO" PR="$PR" BRANCH='' "$BASH" "$self" merge-check --head "$head" || checked=$?
    if [ "$checked" -eq 25 ]; then
      echo "merge: the base moved while merge-check ran; checking once more" >&2
      checked=0
      REPO="$REPO" PR="$PR" BRANCH='' "$BASH" "$self" merge-check --head "$head" || checked=$?
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
    # it on every push to main, and .github/scripts/gate-audit.sh files one
    # `gate-bypass` issue per PR it flags. The rules are merge-check's, through
    # the same helpers; only the moment is pinned to the merge. The base is
    # the commit the PR merged onto (the merge commit's first parent), the
    # title and body are the revisions current at mergedAt (#675's Fixes-PR
    # line was added a minute after it merged), and a receipt, a review
    # request or a Codex verdict counts only if it predates the merge
    # (GATE_AS_OF). Unresolved threads, labels and CI conclusions are read as
    # they stand now: GitHub keeps no history of them to replay cheaply. A
    # legacy repo had no gate to bypass.
    shift
    [ $# -eq 0 ] || { echo "audit: takes no arguments; set PR" >&2; exit 2; }
    audit_pr=$(gh api graphql -f query='
      query($owner:String!,$name:String!,$pr:Int!){
        repository(owner:$owner,name:$name){ pullRequest(number:$pr){
          state mergedAt headRefOid title body
          mergeCommit{ oid parents(first:1){ nodes{ oid } } }
          userContentEdits(first:100){ pageInfo{hasNextPage} nodes{ editedAt deletedAt diff } }
          timelineItems(itemTypes:[RENAMED_TITLE_EVENT],first:100){ pageInfo{hasNextPage} nodes{ ... on RenamedTitleEvent{ createdAt previousTitle } } }
        } } }' -F owner="$OWNER" -F name="$NAME" -F pr="$PR") || { echo "audit=error pr=$PR: could not read the PR" >&2; exit 1; }
    state=$(printf '%s' "$audit_pr" | jq -er '.data.repository.pullRequest.state') || { echo "audit=error pr=$PR: could not read the PR's state" >&2; exit 1; }
    if [ "$state" != MERGED ]; then
      echo "audit: PR #$PR is $state, not merged; there is no merge to audit" >&2
      exit 2
    fi
    # The PR as it stood at mergedAt. A body revision GitHub no longer shows (a
    # deleted edit) is no answer, not a pass.
    at_merge=$(printf '%s' "$audit_pr" | jq -ce '
      .data.repository.pullRequest as $p
      | $p.mergedAt as $t
      | if $p.userContentEdits.pageInfo.hasNextPage or $p.timelineItems.pageInfo.hasNextPage then error("more than 100 body edits or title renames") else . end
      | ([ $p.userContentEdits.nodes[] | select(.editedAt <= $t) ] | max_by(.editedAt)) as $rev
      | { mergedAt: $t,
          head: $p.headRefOid,
          base: ($p.mergeCommit.parents.nodes[0].oid // error("no merge commit parent")),
          title: (([ $p.timelineItems.nodes[] | select(.createdAt > $t) ] | min_by(.createdAt) | .previousTitle) // $p.title),
          body: (if ($p.userContentEdits.nodes | length) == 0 then $p.body
                 elif $rev == null or $rev.deletedAt != null or $rev.diff == null then error("its body revision at the merge is gone")
                 else $rev.diff end) }') || { echo "audit=error pr=$PR: could not reconstruct the PR as it stood at its merge" >&2; exit 1; }
    GATE_AS_OF=$(printf '%s' "$at_merge" | jq -r .mergedAt)
    SCOPE_PIN_BASE=$(printf '%s' "$at_merge" | jq -r .base)
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
    if [ "$fix_link" = missing ]; then
      echo "audit=violation $where: a fix PR merged with no 'Fixes-PR:' line in its body at merge time"
      exit 28
    fi
    ci=$(ci_verdict "$audit_head") || { echo "audit=error $where: could not read CI on the head" >&2; exit 1; }
    if [ -n "$ci" ]; then
      echo "audit=violation $where: $ci"
      exit 28
    fi
    receipt_raw=$(receipt_outcome "$audit_head") || { echo "audit=error $where: could not read receipts" >&2; exit 1; }
    receipt="${receipt_raw%%$'\t'*}"
    receipt_reviewer="${receipt_raw#*$'\t'}"
    if [ "$receipt" = changes ]; then
      echo "audit=violation $where: the latest substitute receipt before the merge asked for changes"
      exit 28
    fi
    if [ "$SCOPE_VERDICT" = skip ]; then
      echo "audit=pass $where: $SCOPE_REASON"
      exit 0
    fi
    if [ "$receipt" = approve ]; then
      [ -f "$REVIEWER_MODELS_FILE" ] || { echo "audit=error $where: $REVIEWER_MODELS_FILE not found" >&2; exit 1; }
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
    head="" outcome="" reviewer="" body_file=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --head) head="${2:?--head needs a sha}"; shift 2 ;;
        --outcome) outcome="${2:?--outcome needs approve or changes}"; shift 2 ;;
        --reviewer) reviewer="${2:?--reviewer needs the model and runtime}"; shift 2 ;;
        --body-file) body_file="${2:?--body-file needs a file}"; shift 2 ;;
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
    # whitespace-delimited token must name one of the models in
    # REVIEWER_MODELS_FILE (worker-high/worker-frontier, whichever vendor) —
    # never worker/worker-fast, Codex luna/terra, or a flash/mini model. See
    # docs/review-policy.md and reviewer_model_allowed above.
    if ! reviewer_model_allowed "$reviewer"; then
      echo "receipt: --reviewer (\"$reviewer\") must START with a model id listed in $REVIEWER_MODELS_FILE — only worker-high/worker-frontier models may write a receipt" >&2
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
    url=$(gh pr comment "$PR" --repo "$REPO" --body "### Substitute review receipt

- **Head:** \`$head\`
- **Reviewer and runtime:** $reviewer
- **Outcome:** $outcome

$body

<!-- pr-review-loop:substitute-receipt head=$head outcome=$outcome -->")
    echo "receipt: outcome=$outcome head=$head $url"
    ;;
  *) echo "unknown command: $1" >&2; exit 2 ;;
esac
