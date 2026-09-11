#!/bin/bash
# nanoclaw-managed-hook: wiki-pre-push-secret-scan
# NanoClaw two-tier secret-scan `pre-push` hook for scan-policy canonical
# repositories (today: the wiki repo per workgroup).
#
# Not a security boundary — a safety net for accidents. `git push
# --no-verify` and `git push -c core.hooksPath=` both bypass this hook
# entirely, the same way `--no-verify` bypasses any git hook; nothing
# stops an agent (or a bug) from using either. What this DOES catch: an
# ordinary `git push` that would otherwise land a real secret on GitHub
# with no other gate on that path at all. If this hook blocks a push, the
# fix is to rewrite the unpushed commits so the secret never existed in
# them (`git rebase -i` / `git commit --amend`, then push again) — never
# `--no-verify`, which defeats the entire point of running this at all.
#
# Installed by src/managed-git-hooks.ts at host startup into
# data/managed-git-hooks/pre-push, alongside a byte-for-byte copy of
# scripts/lib/secret-scan.sh renamed to
# data/managed-git-hooks/nanoclaw-secret-patterns.sh — ONE host-managed
# directory, refreshed atomically on every host start (rename-in-place,
# never a directory swap, so a container that bind-mounted it before a
# restart never sees a stale inode) and asserted byte-identical to the
# shipped source before any spawn that would mount it
# (assertManagedGitHooksIntegrity in that module — git itself fails OPEN
# on a missing/non-executable hook, verified on git 2.43: rc=0 either way,
# so a spawn-time integrity check is the only thing that makes a broken
# managed hook a hard failure instead of a silent no-op). DO NOT hand-edit
# either installed copy — edit these sources in nanoclaw-v2 and restart
# the host; both installed files carry this same source content, which
# the integrity check compares against verbatim.
#
# Why this needs to be self-contained instead of sourcing nanoclaw-v2
# directly: agents push these repos from inside their own container, on a
# linked worktree of the canonical repo. Verified this actually fires
# there, not just on the host:
#   - src/repository-workspaces.ts:1-7 (doc comment) + src/container-runner.ts
#     ~4392-4415: every canonical repository's `.git` control paths —
#     config, HEAD, index, hooks/, objects/info — are bind-mounted into the
#     container at their EXACT host paths (src/container-runner.ts
#     canonicalGitControlMounts(), ~1464-1522), read-only. `hooks/` being in
#     that list is what makes this hook visible and executable in-container;
#     it also means the agent cannot edit or disable it from inside its own
#     sandbox (the mount is read-only there).
#   - MANAGED_GIT_HOOKS_DIR is mounted the same way, at its own identical
#     host path, ONLY for repos whose committed `core.hooksPath` already
#     points there (scanPolicyHookMounts in container-runner.ts — the
#     config value itself is the signal, read from the repo's own
#     .git/config, not re-derived from the repo name).
#   - Proven directly, not just cited: a `pre-push` hook installed on a
#     throwaway repo's `.git/hooks/` fires when `git push` runs from a
#     *separate linked worktree* of that same repo (`git worktree add`),
#     confirming hooks live in the shared common git dir regardless of
#     which worktree/process invokes the push — the same relationship a
#     container's mounted worktree has to its canonical repo.
#   - container/entrypoint.sh + container/Dockerfile: the agent image is
#     `node:22-slim`-based with bash and grep present (confirmed in the
#     built image: `/usr/bin/bash` GNU bash 5.2, `/usr/bin/grep` GNU grep
#     3.8; `--output-indicator-new` confirmed working against the image's
#     git 2.39.5, not just the host's 2.43.0), so this hook runs the same
#     in both places.
#
# Scope: this hook has NO repo-name check of its own (#666 review H7/P3-9 —
# an earlier version also matched its own common git dir against `*/wiki/.git`
# as a defensive fallback; removed deliberately). `core.hooksPath` pointing
# here at all IS the policy, decided once on the host
# (isScanPolicyRepositoryName in src/managed-git-hooks.ts) — this script
# scans UNCONDITIONALLY whenever git invokes it, so there is exactly one
# place the scan-policy decision is made, not two that could silently
# diverge. Widening scan-policy to code repos needs its own false-positive
# measurement first — SECRET_BLOCK_RE has real false-positive vectors in
# code (PEM/AWS example fixtures, test tokens named things like
# `token: string`) that a wiki's prose content doesn't; that measurement
# belongs in isScanPolicyRepositoryName, not a second predicate here.
#
# Protocol (githooks(5) `pre-push`): stdin carries one line per ref being
# pushed — "<local ref> <local sha1> <remote ref> <remote sha1>". A push is
# rejected as a whole (git refuses ALL refs in the attempt) if this script
# exits non-zero for any of them.
set -uo pipefail

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATTERNS_FILE="$HOOK_DIR/nanoclaw-secret-patterns.sh"
# shellcheck source=lib/secret-scan.sh
if ! source "$PATTERNS_FILE" 2>/dev/null; then
  echo "pre-push: cannot load $PATTERNS_FILE -- refusing to push without a working secret scanner" >&2
  exit 1
fi
if ! secret_scan_selftest 2>/dev/null; then
  echo "pre-push: secret-pattern self-test failed -- refusing to push without a validated scanner" >&2
  exit 1
fi

ZERO_SHA='0000000000000000000000000000000000000000'

# scan_range <local_sha>
# Prints, on stdout, ALL text this hook scans for the given ref: every
# commit's patch AND message body being introduced by this push, plus an
# annotated tag's own message if local_sha names one. Returns nonzero if
# ANY step failed (a git error while building the range) — callers must
# treat that as fail-closed and never scan the partial text that came
# through before the failure.
#
# --not --remotes (never --not --remotes=$1: when the push target is a
# bare URL rather than a configured remote name, $1 IS that URL, and using
# it as the exclusion spec would walk the entire history instead of just
# what's new — #666 review P2-3, reproduced as a 19.9MB single-tree diff
# on the largest wiki's first-ever push under the old design). This reads
# the CONTAINER'S OWN remote-tracking refs (refs/remotes/*, which live in
# the writable common git dir, not something this hook fetches itself) as
# the trust boundary for "already scanned" — the same class of trust as
# `--no-verify` bypassing this hook entirely: it catches accidents, not a
# deliberately falsified local view. Using the commit LOG (not an
# old-tree-vs-new-tree diff) is what makes "added then removed within this
# push", "added then redacted", and "survives only in a middle commit of a
# force-push" all still get scanned — each surviving commit's own patch is
# walked individually (#666 review P1-1).
scan_range() {
  local local_sha="$1"
  local rc=0

  # A ref that does not peel to a commit — a lightweight tag on a blob or
  # tree, or (rarer) an annotated tag whose own target is a blob or tree —
  # makes every commit-walk below silently produce NOTHING: verified
  # directly (not assumed), `git log <blob-sha> --not --remotes` exits 0
  # with empty output, it does not error (#666 review H5). That would let
  # this scan_range return rc=0 with an empty combined_text, and the caller
  # would read that as "nothing added" and allow the push — even though the
  # object's own raw content (what a lightweight blob tag actually pushes)
  # was never looked at. Refuse outright rather than guess how to scan an
  # object shape wiki content never legitimately takes; `^{commit}` peels
  # an annotated tag automatically, so a normal tag-on-a-commit is
  # unaffected.
  if ! LC_ALL=C git rev-parse --verify --quiet "${local_sha}^{commit}" >/dev/null 2>&1; then
    echo "pre-push: ${local_sha} does not resolve to a commit -- refusing to push a non-commit ref blind." >&2
    return 1
  fi

  # 1. Every new commit's patch, added lines marked via
  #    --output-indicator-new (see secret-scan.sh's comment on
  #    SECRET_SCAN_NEW_INDICATOR for why this replaces a header-exclusion
  #    regex entirely instead of trying to enumerate every header shape).
  #    --diff-merges=remerge (git >=2.36; the image has 2.39.5, the host
  #    2.43) makes a MERGE commit's own patch the "remerge diff" — the
  #    difference between what an automatic merge would have produced and
  #    what was actually recorded — so content that exists ONLY in a
  #    conflict resolution (never in either parent) gets scanned too (#666
  #    review H1). Non-merge commits are unaffected by this flag either way.
  LC_ALL=C git log -p --no-color --text --no-ext-diff --no-textconv \
    --src-prefix=a/ --dst-prefix=b/ --diff-merges=remerge \
    --output-indicator-new="$SECRET_SCAN_NEW_INDICATOR" --output-indicator-old=- --output-indicator-context=' ' \
    "$local_sha" --not --remotes || rc=$?
  # 1b. Octopus merges (3+ parents) print NOTHING under --diff-merges=remerge
  #     (confirmed by testing, not just documentation — #666 review H1) — a
  #     second, deliberately over-broad pass diffs an octopus merge against
  #     only its first parent instead, so content introduced by ANY parent
  #     still gets scanned even though this isn't isolated to just the
  #     resolution the way remerge is for an ordinary two-parent merge.
  #     --min-parents=3 means this pass touches nothing an ordinary merge or
  #     single-parent commit already had scanned in step 1 above.
  LC_ALL=C git log -p --no-color --text --no-ext-diff --no-textconv \
    --src-prefix=a/ --dst-prefix=b/ --min-parents=3 --diff-merges=first-parent \
    --output-indicator-new="$SECRET_SCAN_NEW_INDICATOR" --output-indicator-old=- --output-indicator-context=' ' \
    "$local_sha" --not --remotes || rc=$?
  # 2. Every new commit's own message body. `git log -p --format=%B` would
  #    interleave message text with the marked patch lines above, but
  #    --output-indicator-new only touches diff/patch content — message
  #    lines come through with no marker at all, so a secret typed
  #    directly into a commit message (never as file content) would be
  #    silently dropped by secret_scan_extract_added. Render every message
  #    line with the same marker ourselves (#666 review P3-1).
  LC_ALL=C git log --format='%B' "$local_sha" --not --remotes 2>/dev/null \
    | LC_ALL=C sed "s/^/${SECRET_SCAN_NEW_INDICATOR}/" || rc=$?
  # 3. An annotated tag's own message: git log never renders it (it only
  #    ever walks the peeled commit), so a token typed into a tag message
  #    would otherwise never be scanned at all (#666 review P3-1).
  if [ "$(LC_ALL=C git cat-file -t "$local_sha" 2>/dev/null)" = "tag" ]; then
    LC_ALL=C git cat-file -p "$local_sha" 2>/dev/null \
      | LC_ALL=C sed "s/^/${SECRET_SCAN_NEW_INDICATOR}/" || rc=$?
  fi
  return "$rc"
}

blocked=0
warned=0

while read -r local_ref local_sha remote_ref remote_sha; do
  [ -n "${local_ref:-}" ] || continue
  [ "$local_sha" = "$ZERO_SHA" ] && continue # deleting a ref: nothing pushed, nothing to scan

  combined_text=$(scan_range "$local_sha")
  scan_rc=$?
  if [ "$scan_rc" -ne 0 ]; then
    # Fail closed on ANY git error while building the scan range (#666
    # review P1-2: a `push -f` retried after an earlier rejection can pass
    # a remote_sha this repo no longer has locally, and the old
    # end-state-diff design exited 128 with no output and silently skipped
    # the ref). Never scan whatever text DID come through before the
    # failure.
    echo "pre-push: BLOCKED $local_ref -> $remote_ref: could not build the scan range (git exit $scan_rc) -- refusing to push blind." >&2
    blocked=1
    continue
  fi

  added_text=$(secret_scan_extract_added "$combined_text")
  extract_rc=$?
  if [ "$extract_rc" -ge 2 ]; then
    # #666 review H6/P3-3: an extraction failure (grep exit >=2) must not
    # read the same as "legitimately nothing added" (extract's own exit 1)
    # — both produce empty output, but only one of them means there was
    # genuinely nothing to scan.
    echo "pre-push: BLOCKED $local_ref -> $remote_ref: the secret scanner itself failed -- refusing to push blind." >&2
    blocked=1
    continue
  fi
  [ -n "$added_text" ] || continue

  block_hits=$(secret_scan_count "$added_text" "$SECRET_BLOCK_RE" sensitive)
  count_rc=$?
  if [ "$count_rc" -ne 0 ]; then
    echo "pre-push: BLOCKED $local_ref -> $remote_ref: the secret scanner itself failed -- refusing to push blind." >&2
    blocked=1
    continue
  fi
  if [ "$block_hits" -gt 0 ]; then
    echo "pre-push: BLOCKED $local_ref -> $remote_ref: $block_hits added line(s) look like a high-confidence secret." >&2
    echo "pre-push: rewrite the unpushed commit(s) to remove it (git rebase -i / git commit --amend), then push again. Do not use --no-verify." >&2
    blocked=1
    continue # a blocked ref's lines aren't also worth a separate warning
  fi

  warn_hits=$(secret_scan_count "$added_text" "$SECRET_RE" insensitive)
  count_rc=$?
  if [ "$count_rc" -ne 0 ]; then
    echo "pre-push: BLOCKED $local_ref -> $remote_ref: the secret scanner itself failed -- refusing to push blind." >&2
    blocked=1
    continue
  fi
  if [ "$warn_hits" -gt 0 ]; then
    echo "pre-push: WARNING $local_ref -> $remote_ref: $warn_hits added line(s) look secret-shaped but not high-confidence; not blocking." >&2
    warned=1
  fi
done

[ "$blocked" -eq 0 ] || exit 1
exit 0
