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
# This is a PRE-CHECK, not a review. It writes no receipt and the merge gate
# neither reads nor honours its output — `codex-review.sh receipt` is still the
# only thing that can satisfy the gate. Its model IS gate-eligible
# (`deepseek-v4.1-flash` in reviewer-models.txt), so the same run can be
# promoted to a receipt by passing its findings to `receipt --reviewer
# "deepseek-v4.1-flash ..."` — but that is a deliberate act, never implied by
# running this.
#
# Usage:
#   precheck-opencode.sh --pr <n> [--repo <owner/name>] [--model <id>]
#
# Defaults to the repo of the current directory and opencode/deepseek-v4.1-flash.
set -uo pipefail

PR=""
REPO=""
MODEL="opencode/deepseek-v4.1-flash"

while [ $# -gt 0 ]; do
  case "$1" in
    --pr) PR="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --model) MODEL="${2:-}"; shift 2 ;;
    *) echo "precheck-opencode.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

[ -n "$PR" ] || { echo "precheck-opencode.sh: --pr <n> is required" >&2; exit 2; }
command -v opencode >/dev/null 2>&1 || { echo "precheck-opencode.sh: opencode is not on PATH" >&2; exit 2; }

GH_ARGS=(pr view "$PR" --json title,body)
DIFF_ARGS=(pr diff "$PR")
if [ -n "$REPO" ]; then
  GH_ARGS+=(--repo "$REPO")
  DIFF_ARGS+=(--repo "$REPO")
fi

BODY=$(gh "${GH_ARGS[@]}" -q '"TITLE: " + .title + "\n\nBODY:\n" + .body') || {
  echo "precheck-opencode.sh: could not read PR #$PR" >&2; exit 1; }
DIFF=$(gh "${DIFF_ARGS[@]}") || { echo "precheck-opencode.sh: could not read the diff for PR #$PR" >&2; exit 1; }

PROMPT="You are pre-checking a pull request before a costly review round. Do not summarise the diff back; only report problems.

$BODY

DIFF:
$DIFF

Answer these, briefly, citing file:line:
1. Does the diff do what the body claims? Name any claim the code does not support.
2. Any number, file path, line number, commit sha or test count in the body that the diff or repo contradicts.
3. Does any changed test still fail if the behaviour it covers is broken, or was an assertion weakened/deleted to make something pass?
4. Anything obviously missing: a second site needing the same change, a manifest or baseline that regenerates with it, a dead reference left behind.
Say 'no findings' for any section that is clean. Be terse."

# `< /dev/null` is load-bearing: with an open stdin the CLI waits for more prompt
# input and hangs silently until its timeout.
timeout "${PRECHECK_TIMEOUT:-900}" opencode run -m "$MODEL" "$PROMPT" < /dev/null 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "precheck-opencode.sh: opencode exited $rc (a rate limit or timeout is not a PASS — re-run or use another pool)" >&2
fi
exit "$rc"
