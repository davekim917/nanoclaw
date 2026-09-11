#!/bin/bash
# nanoclaw-managed-hook: wiki-pre-push-secret-scan
# NanoClaw two-tier secret-scan `pre-push` hook.
#
# Installed by scripts/install-wiki-pre-push-hook.sh into a canonical
# repository's `.git/hooks/pre-push`, alongside a copy of
# scripts/lib/wiki-secret-patterns.sh renamed to
# `.git/hooks/nanoclaw-secret-patterns.sh`. DO NOT hand-edit either
# installed copy — edit the sources in nanoclaw-v2 and re-run the
# installer; both installed files carry a marker comment the installer
# uses to recognize (and safely re-run over) its own prior install.
#
# Why this needs to be self-contained instead of sourcing nanoclaw-v2
# directly: agents push these repos from inside their own container, on a
# linked worktree of the canonical repo. Verified this actually fires
# there, not just on the host:
#   - src/repository-workspaces.ts:1-7 (doc comment) + src/container-runner.ts
#     :4392-4415: every canonical repository's `.git` control paths —
#     config, HEAD, index, hooks/, objects/info — are bind-mounted into the
#     container at their EXACT host paths (src/container-runner.ts:1513-1519,
#     canonicalGitControlMounts()), read-only. `hooks/` being in that list is
#     exactly what makes this hook visible and executable in-container; it
#     also means the agent cannot edit or disable it from inside its own
#     sandbox (the mount is read-only there).
#   - Proven directly, not just cited: a `pre-push` hook installed on a
#     throwaway repo's `.git/hooks/` fires when `git push` runs from a
#     *separate linked worktree* of that same repo (`git worktree add`),
#     confirming hooks live in the shared common git dir regardless of
#     which worktree/process invokes the push — the same relationship a
#     container's mounted worktree has to its canonical repo.
#   - container/entrypoint.sh + container/Dockerfile: the agent image is
#     `node:22-slim`-based with bash and grep present (confirmed in the
#     built image: `/usr/bin/bash` GNU bash 5.2, `/usr/bin/grep` GNU grep
#     3.8), so this hook's shebang and greps run the same as on the host.
#   - The installer refuses to install into any repo whose
#     `core.hooksPath` is not the default `.git/hooks/` (see its own
#     comments) — several canonical repos on this host already redirect
#     hooksPath elsewhere (some to `/dev/null`, disabling hooks entirely;
#     one to a repo-tracked `.husky/_`), which would make an installed
#     `.git/hooks/pre-push` silently never run.
#
# Protocol (githooks(5) `pre-push`): stdin carries one line per ref being
# pushed — "<local ref> <local sha1> <remote ref> <remote sha1>". A push is
# rejected as a whole (git refuses ALL refs in the attempt) if this script
# exits non-zero for any of them.
set -uo pipefail

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATTERNS_FILE="$HOOK_DIR/nanoclaw-secret-patterns.sh"
# shellcheck source=/dev/null
if ! source "$PATTERNS_FILE" 2>/dev/null; then
  echo "pre-push: cannot load $PATTERNS_FILE -- refusing to push without a working secret scanner" >&2
  exit 1
fi

ZERO_SHA='0000000000000000000000000000000000000000'
# git's well-known hash of the empty tree — diffing against it for a
# brand-new ref (remote_sha is all zeros) treats every line the new ref
# introduces as "added", which is the correct scan scope: nothing existed
# on the remote to compare against.
EMPTY_TREE_SHA='4b825dc642cb6eb9a060e54bf8d69288fbee4904'

blocked=0
warned=0

while read -r local_ref local_sha remote_ref remote_sha; do
  [ -n "${local_ref:-}" ] || continue
  [ "$local_sha" = "$ZERO_SHA" ] && continue  # deleting a ref: nothing pushed, nothing to scan

  old_tree="$remote_sha"
  [ "$old_tree" = "$ZERO_SHA" ] && old_tree="$EMPTY_TREE_SHA"

  diff_text=$(LC_ALL=C git diff --no-color --text --no-ext-diff --no-textconv "$old_tree" "$local_sha" 2>/dev/null)
  [ -n "$diff_text" ] || continue

  block_hits=$(secret_scan_block_hits "$diff_text")
  if [ "${block_hits:-0}" -gt 0 ]; then
    echo "pre-push: BLOCKED $local_ref -> $remote_ref: $block_hits added line(s) look like a high-confidence secret." >&2
    echo "pre-push: review with: git diff $old_tree $local_sha" >&2
    blocked=1
    continue  # a blocked ref's lines aren't also worth a separate warning
  fi

  warn_hits=$(secret_scan_warn_hits "$diff_text")
  if [ "${warn_hits:-0}" -gt 0 ]; then
    echo "pre-push: WARNING $local_ref -> $remote_ref: $warn_hits added line(s) look secret-shaped but not high-confidence; not blocking." >&2
    warned=1
  fi
done

[ "$blocked" -eq 0 ] || exit 1
exit 0
