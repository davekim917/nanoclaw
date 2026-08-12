#!/usr/bin/env bash
# Cut a "freeze PR" — an on-demand frozen preview environment for an
# arbitrary develop SHA, for smoke-pr-gate.sh to poll like any other labeled
# PR. See groups/_ops/specs/fleet-hardening/phase5-preview-envs.md ("Freeze
# PRs") for the verified mechanics this implements:
#
#   - An EMPTY commit on a branch produces zero previews (verified live,
#     PR #759: 35 minutes, zero preview events). Render only builds a preview
#     when the PR diff touches the service's rootDir, so this script instead
#     adds ONE marker commit creating `.render-freeze` (containing the target
#     SHA) under both XZO-BACKEND/ and XZO-FRONTEND/ — build-inert (nothing
#     imports a dotfile), but a real diff.
#   - Draft PRs DO trigger previews (verified live, PR #775: draft from
#     creation, labeled at creation, both previews within 30s). Draft is also
#     the right shape independent of that fact: a placeholder that can't be
#     merged by accident and never enters review lanes.
#   - The marker commit is built via the git data API (blobs/trees/commits/
#     refs) rather than a local checkout, so this script needs nothing but
#     `gh` and network — no worktree, no clone.
#
# Usage: smoke-freeze-pr.sh <target-sha>
#   <target-sha>  full 40-character SHA on SMOKE_GATE_BRANCH to freeze.
#
# Env (same family as smoke-pr-gate.sh):
#   SMOKE_GATE_REPO    required, "owner/repo".
#   SMOKE_GATE_BRANCH  base branch for the draft PR (default: develop).
#   SMOKE_GATE_LABEL   label that opts the PR into Render previews
#                      (default: render-preview). Must already exist on the
#                      repo — this script does not create labels.
#
# Output: one JSON line on success —
#   {"prNumber":<n>,"branch":"smoke/freeze-<sha12>","freezeSha":"<40char>","targetSha":"<40char>"}
# or {"ok":false,"error":"..."} (plus whatever partial state was created, so
# a failure after the branch exists can be cleaned up or retried by hand —
# this script does not force-push or roll back a partial freeze).
#
# Teardown: closing the PR is the CALLER's job. Render auto-deletes the
# preview services on PR close (verified) — this script and smoke-pr-gate.sh
# never delete anything.
set -u

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  sed -n '2,39p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

REPO="${SMOKE_GATE_REPO:-}"
BRANCH="${SMOKE_GATE_BRANCH:-develop}"
LABEL="${SMOKE_GATE_LABEL:-render-preview}"
TARGET_SHA="${1:-}"

if [ -z "$REPO" ]; then
  jq -cn '{ok:false,error:"SMOKE_GATE_REPO is required"}'
  exit 2
fi
if ! printf '%s' "$TARGET_SHA" | grep -Eq '^[0-9a-f]{40}$'; then
  jq -cn '{ok:false,error:"usage: smoke-freeze-pr.sh <40-character-target-sha>"}'
  exit 2
fi

SHA12="${TARGET_SHA:0:12}"
FREEZE_BRANCH="smoke/freeze-$SHA12"

# Idempotent-ish: refuse rather than force-push over an existing freeze
# branch for this SHA. A caller that wants a fresh freeze deletes the old
# branch/PR first — this script never overwrites one silently.
if timeout 10 gh api "repos/$REPO/git/ref/heads/$FREEZE_BRANCH" >/dev/null 2>&1; then
  jq -cn --arg branch "$FREEZE_BRANCH" \
    '{ok:false,error:"branch already exists — delete it first or pick a different target",branch:$branch}'
  exit 1
fi

BASE_TREE="$(timeout 10 gh api "repos/$REPO/git/commits/$TARGET_SHA" --jq '.tree.sha // empty' 2>/dev/null)"
if [ -z "$BASE_TREE" ]; then
  jq -cn --arg sha "$TARGET_SHA" '{ok:false,error:"target sha not found in repo",targetSha:$sha}'
  exit 1
fi

# One blob, reused for both marker paths — Git blobs are content-addressed,
# so identical content (the target SHA) always hashes to the same blob sha
# regardless of how many tree entries point at it.
BLOB_SHA="$(jq -cn --arg content "$TARGET_SHA" '{content:$content,encoding:"utf-8"}' | \
  timeout 10 gh api "repos/$REPO/git/blobs" --input - --jq '.sha // empty' 2>/dev/null)"
if [ -z "$BLOB_SHA" ]; then
  jq -cn '{ok:false,error:"failed to create marker blob"}'
  exit 1
fi

NEW_TREE="$(jq -cn \
  --arg base "$BASE_TREE" --arg sha "$BLOB_SHA" \
  '{base_tree:$base,tree:[
    {path:"XZO-BACKEND/.render-freeze",mode:"100644",type:"blob",sha:$sha},
    {path:"XZO-FRONTEND/.render-freeze",mode:"100644",type:"blob",sha:$sha}
  ]}' | timeout 10 gh api "repos/$REPO/git/trees" --input - --jq '.sha // empty' 2>/dev/null)"
if [ -z "$NEW_TREE" ]; then
  jq -cn '{ok:false,error:"failed to create marker tree"}'
  exit 1
fi

FREEZE_SHA="$(jq -cn \
  --arg msg "smoke freeze: pin develop @ $SHA12 for a QA campaign" \
  --arg tree "$NEW_TREE" --arg parent "$TARGET_SHA" \
  '{message:$msg,tree:$tree,parents:[$parent]}' | \
  timeout 10 gh api "repos/$REPO/git/commits" --input - --jq '.sha // empty' 2>/dev/null)"
if [ -z "$FREEZE_SHA" ]; then
  jq -cn '{ok:false,error:"failed to create marker commit"}'
  exit 1
fi

REF_OK="$(jq -cn --arg ref "refs/heads/$FREEZE_BRANCH" --arg sha "$FREEZE_SHA" '{ref:$ref,sha:$sha}' | \
  timeout 10 gh api "repos/$REPO/git/refs" --input - --jq '.ref // empty' 2>/dev/null)"
if [ -z "$REF_OK" ]; then
  jq -cn --arg sha "$FREEZE_SHA" \
    '{ok:false,error:"failed to create branch ref (marker commit exists but is unreferenced)",freezeSha:$sha}'
  exit 1
fi

PR_TITLE="[smoke freeze] $BRANCH @ $SHA12 (do not merge)"
PR_BODY="Frozen preview environment for a QA smoke campaign. Pins $BRANCH at \`$TARGET_SHA\`. Never merge this PR — close it when the campaign is done; Render tears the preview down automatically on close."
PR_NUMBER="$(timeout 20 gh pr create -R "$REPO" --base "$BRANCH" --head "$FREEZE_BRANCH" --draft \
  --title "$PR_TITLE" --body "$PR_BODY" --label "$LABEL" 2>/dev/null | grep -Eo '[0-9]+$' | tail -1)"
if [ -z "$PR_NUMBER" ]; then
  jq -cn --arg branch "$FREEZE_BRANCH" --arg sha "$FREEZE_SHA" \
    '{ok:false,error:"branch and marker commit created but PR creation failed — retry `gh pr create` by hand or clean up the branch",branch:$branch,freezeSha:$sha}'
  exit 1
fi

jq -cn \
  --argjson pr "$PR_NUMBER" --arg branch "$FREEZE_BRANCH" \
  --arg freezeSha "$FREEZE_SHA" --arg targetSha "$TARGET_SHA" \
  '{prNumber:$pr,branch:$branch,freezeSha:$freezeSha,targetSha:$targetSha}'
