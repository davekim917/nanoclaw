#!/usr/bin/env bash
# Local pre-check of a PR diff through the OpenCode CLI, before spending a
# gate-eligible reviewer round on it.
#
# WHY THIS EXISTS. A gate review is scarce in two ways: it costs a frontier
# reviewer's capacity, and on 2026-09-22 every Anthropic and OpenAI reviewer hit
# a rate limit inside the same hour, so a one-line test fix on a green PR was
# briefly unmergeable. OpenCode is a third pool and a cheap first pass: it reads
# the diff and answers whether the PR body's claims match the code. Catching a
# wrong claim here means the paid round starts from a correct PR body.
#
# SAFETY, AND ITS LIMIT. `opencode run` is an agent with write tools, so this
# script runs it with `--dir` pointed at an empty scratch directory, never the
# caller's checkout. See the comment on the invocation below for what happened
# when it was not.
#
# `--dir` IS ADVISORY, NOT ENFORCEMENT. `opencode run --help` calls it
# "directory to run in"; nothing calls it a sandbox. OpenCode has a permission
# category named `external_directory` precisely because reaching outside the
# project root is a supported thing to permit — enumerated at
# container/agent-runner/src/providers/opencode.ts:168 and set to `allow` at
# :205. On the host this was written for, ~/.config/opencode/opencode.jsonc
# declared no `permission` block at all, so nothing narrowed that default;
# check your own before assuming otherwise. Bash and absolute paths run as the
# host user either way.
#
# So `--dir` removes the MECHANISM of the incident below — the agent no longer
# has our checkout as its project root, so "edit the files I see" cannot reach
# the worktree — but it does NOT confine the process. Do not read it as a
# sandbox, and do not point this at a live repo on the strength of it.
#
# This is a PRE-CHECK, not a review. It writes no receipt and the merge gate
# neither reads nor honours its output — `codex-review.sh receipt` is still the
# only thing that can satisfy the gate. Any frontier model is gate-eligible
# (codex-review.sh refuses only the small tiers in REVIEWER_DENIED_TIERS), so a
# run on one can be promoted to a receipt by passing its findings to `receipt
# --reviewer "<model id> ..."` — but that is a deliberate act, never implied by
# running this.
#
# Usage:
#   precheck-opencode.sh --pr <n> [--repo <owner/name>] [--model <provider/id>]
#
# The model is --model, else $PRECHECK_MODEL, else opencode/deepseek-v4.1-flash.
# The default is only a starting point, not an eligibility list: pass any model
# `opencode models` lists and nothing else needs to change.
set -uo pipefail

PR=""
REPO=""
MODEL="${PRECHECK_MODEL:-opencode/deepseek-v4.1-flash}"

# A trailing flag with no value used to hang forever: `shift 2` with `$#=1`
# fails and shifts nothing, and `set -uo pipefail` above carries no `-e`, so the
# loop spun on the same argument until killed. Demand the value before
# consuming it.
while [ $# -gt 0 ]; do
  case "$1" in
    --pr|--repo|--model)
      [ $# -ge 2 ] || { echo "precheck-opencode.sh: $1 needs a value" >&2; exit 2; }
      case "$1" in
        --pr) PR="$2" ;;
        --repo) REPO="$2" ;;
        --model) MODEL="$2" ;;
      esac
      shift 2 ;;
    *) echo "precheck-opencode.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

[ -n "$PR" ] || { echo "precheck-opencode.sh: --pr <n> is required" >&2; exit 2; }
command -v opencode >/dev/null 2>&1 || { echo "precheck-opencode.sh: opencode is not on PATH" >&2; exit 2; }
# git is not optional here: it is how the scratch-directory check below decides
# whether the agent would land inside a repository. Without it that check would
# silently answer "not a repo" for every path and fail open.
command -v git >/dev/null 2>&1 || { echo "precheck-opencode.sh: git is not on PATH — it is required to verify the agent's working directory is not inside a repository" >&2; exit 2; }

GH_ARGS=(pr view "$PR" --json title,body)
DIFF_ARGS=(pr diff "$PR")
if [ -n "$REPO" ]; then
  GH_ARGS+=(--repo "$REPO")
  DIFF_ARGS+=(--repo "$REPO")
fi

BODY=$(gh "${GH_ARGS[@]}" -q '"TITLE: " + .title + "\n\nBODY:\n" + .body') || {
  echo "precheck-opencode.sh: could not read PR #$PR" >&2; exit 1; }
DIFF=$(gh "${DIFF_ARGS[@]}") || { echo "precheck-opencode.sh: could not read the diff for PR #$PR" >&2; exit 1; }

# The prompt travels as ONE argv string, and Linux caps a single argument at
# MAX_ARG_STRLEN = 131072 bytes (measured on this host: 131000 ok, 131073
# E2BIG). A large PR would otherwise die with "Argument list too long" AFTER the
# two gh round-trips. Cap the diff instead, and say so in the prompt and on
# stderr — a pre-check that silently read half a diff would read as coverage it
# does not have.
PROMPT_BUDGET=${PRECHECK_PROMPT_BUDGET:-120000}
DIFF_BUDGET=$(( PROMPT_BUDGET - ${#BODY} - 2000 ))
DIFF_NOTE=""
if [ "$DIFF_BUDGET" -lt 4000 ]; then
  echo "precheck-opencode.sh: PR #$PR's body alone (${#BODY} bytes) leaves no room for a diff under the ${PROMPT_BUDGET}-byte prompt budget" >&2
  exit 1
fi
if [ "${#DIFF}" -gt "$DIFF_BUDGET" ]; then
  echo "precheck-opencode.sh: diff is ${#DIFF} bytes, truncating to $DIFF_BUDGET — THIS PRE-CHECK SAW A PARTIAL DIFF and its silence is not coverage" >&2
  DIFF="${DIFF:0:$DIFF_BUDGET}"
  DIFF_NOTE="

NOTE: the diff below was TRUNCATED to fit. Do not conclude that anything is absent from this PR; report only what you can see."
fi

PROMPT="You are pre-checking a pull request before a costly review round. Do not summarise the diff back; only report problems.

$BODY

DIFF:$DIFF_NOTE
$DIFF

Answer these, briefly, citing file:line:
1. Does the diff do what the body claims? Name any claim the code does not support.
2. Any number, file path, line number, commit sha or test count in the body that the diff or repo contradicts.
3. Does any changed test still fail if the behaviour it covers is broken, or was an assertion weakened/deleted to make something pass?
4. Anything obviously missing: a second site needing the same change, a manifest or baseline that regenerates with it, a dead reference left behind.
Say 'no findings' for any section that is clean. Be terse."

# `--dir` is load-bearing, and the reason is worth stating plainly: `opencode
# run` is an AGENT WITH WRITE TOOLS, not a read-only completion. Run from a
# checkout, it edits files and runs commands there. Observed on 2026-09-22
# against PR #1008: this pre-check reverted core.ts and
# instruction-fragment-migration.test.ts in the caller's worktree while
# "checking" the diff, and those reverts were then swept into the caller's next
# `add -A` commit. Give it an EMPTY scratch directory instead — the prompt
# already carries the body and the diff, so it needs no repo — and never the
# checkout the caller is working in.
#
# PRECHECK_DIR can point it at a THROWAWAY checkout when repo-grounded checking
# is worth it (it can then verify shas and run tests). Never pass a directory
# with work in it.
WORKDIR="${PRECHECK_DIR:-}"
CLEANUP_DIR=""
if [ -z "$WORKDIR" ]; then
  WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/precheck-opencode.XXXXXX") || {
    echo "precheck-opencode.sh: could not create a scratch directory" >&2; exit 1; }
  CLEANUP_DIR="$WORKDIR"
fi

# Remove only a directory this script created. A caller-supplied PRECHECK_DIR is
# theirs; the trap covers Ctrl-C and SIGTERM during a run that can last 900s,
# which previously leaked the scratch dir and whatever the agent wrote into it.
cleanup() { [ -n "$CLEANUP_DIR" ] && rm -rf "$CLEANUP_DIR"; CLEANUP_DIR=""; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# The whole point of `--dir` is that the agent's project root is not a checkout.
# `mktemp -d` inherits TMPDIR, so a TMPDIR inside a repository puts the scratch
# dir inside it, opencode's project detection walks up to the nearest `.git`,
# and the confinement is gone with NO error — the failure is silent, which is
# the worst kind here. A wrong PRECHECK_DIR does the same. Fail closed: refuse
# rather than run something that only looks isolated.
#
# The predicate is `--git-dir`, NOT `--show-toplevel`. `--show-toplevel` does
# not answer this question — it ERRORS ("fatal: this operation must be run in a
# work tree") for the two shapes with no work tree, so the `if` was false and
# the script sailed on. Measured here:
#
#   repo/               --show-toplevel: /…/repo        --git-dir: .git
#   repo/.git/scratch   --show-toplevel: fatal: …       --git-dir: /…/repo/.git
#   bare/               --show-toplevel: fatal: …       --git-dir: .
#
# Those are the worst two to fail open on: the agent gets a working directory
# inside an object store, which no `checkout` undoes. `--git-dir` succeeds in
# all three.
if gitdir=$(git -C "$WORKDIR" rev-parse --git-dir 2>/dev/null); then
  echo "precheck-opencode.sh: the agent's working directory $WORKDIR is inside a git repository (git dir: $gitdir) — refusing, because opencode would treat that repository as its project root and the isolation this script relies on would not exist. Set TMPDIR or PRECHECK_DIR to a path outside any checkout." >&2
  exit 2
fi

# `< /dev/null` is load-bearing too: with an open stdin the CLI waits for more
# prompt input and hangs silently until its timeout. That is a different hang
# from the argument-parsing one above; both are real.
#
# The output is CAPTURED rather than streamed so that empty output can be
# refused. An `opencode run` that exits 0 having printed nothing is a failure
# mode seen in practice, and streaming it produced a clean exit and a blank
# terminal — indistinguishable from "no findings", which is exactly the false
# confidence a pre-check must not manufacture right before a merge. The cost is
# that nothing appears until the run ends; the alternative is a silent pass.
out=$(timeout "${PRECHECK_TIMEOUT:-900}" opencode run --dir "$WORKDIR" -m "$MODEL" "$PROMPT" < /dev/null 2>&1)
rc=$?
cleanup
printf '%s\n' "$out"
if [ "$rc" -ne 0 ]; then
  echo "precheck-opencode.sh: opencode exited $rc (a rate limit or timeout is not a PASS — re-run or use another pool)" >&2
  exit "$rc"
fi
if [ -z "${out//[[:space:]]/}" ]; then
  echo "precheck-opencode.sh: opencode exited 0 but produced NO output — this is not a pass; re-run or use another pool" >&2
  exit 1
fi
exit 0
