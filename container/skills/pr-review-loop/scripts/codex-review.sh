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
#   codex-review.sh status <sha> <since_iso>  # codex=<pending|clean|findings> open=<n> review=<n> reaction=<n> rounds=<n>
#                                             # open/status print a STOP banner at rounds>=4 — diagnose, do not push
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
