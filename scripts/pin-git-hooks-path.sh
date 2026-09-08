#!/bin/sh
# Pin `core.hooksPath` to an ABSOLUTE path so the hooks in `.husky/` run from
# every linked worktree, not only from the main checkout.
#
# THE BUG THIS FIXES
# ------------------
# `husky` writes `core.hooksPath = .husky/_` — a RELATIVE path. One `.git/config`
# is shared by the main checkout and every linked worktree, and Git resolves a
# relative `core.hooksPath` against the invoking WORKING TREE's top level. So a
# worktree at `.claude/worktrees/<name>` resolves it to
# `.claude/worktrees/<name>/.husky/_`, which does not exist: `.husky/_/.gitignore`
# is `*`, so husky's shim directory is untracked and lives ONLY in the main
# checkout. Git does not warn about a missing hooks directory — it runs zero
# hooks and reports success.
#
# Every PR in this fork is developed in a worktree, so the pre-push gate
# (public-boundary scan, eslint, tsc) and the commit-msg gate had never run on a
# PR branch push. That is a gate whose absence is silent, which is the worst
# kind.
#
# WHY ABSOLUTE IS THE RIGHT SHAPE, AND WHY THE `_` SHIMS STAY UNTRACKED
# ---------------------------------------------------------------------
# Container agents share this repository's `.git` — `src/container-runner.ts:4405`
# bind-mounts `repository.gitDir` at its exact host path, but deliberately NOT
# the canonical working tree ("Canonical working trees stay host-only",
# container-runner.ts:4388). They therefore inherit whatever `core.hooksPath`
# says. That is fine, and load-bearing:
#
#   - An ABSOLUTE host path is UNRESOLVABLE inside a container (the host working
#     tree is not mounted), so Git finds no hook and no-ops — exactly today's
#     behaviour for container pushes.
#   - Tracking husky's `_` shims would instead make the hooks RESOLVE in a
#     container and then fail: `.husky/pre-push`'s `scan_message` does an
#     unconditional `ln -s "$repo_root/node_modules" ...` under `set -e`, and
#     `$repo_root/node_modules` is host-only. Every container push would hard-fail.
#
# So the fix is exactly this: absolutize, do not track.
#
# WHY THIS IS A `prepare` STEP AND NOT A ONE-OFF `git config`
# -----------------------------------------------------------
# `husky` rewrites `core.hooksPath` back to the relative `.husky/_` on every
# `pnpm install`. A one-off `git config` therefore survives only until the next
# install. This runs AFTER husky in the same `prepare` script and re-pins it.
#
# The main checkout is resolved with the same idiom both existing hooks already
# use (`.husky/pre-push:4`, `.husky/commit-msg:15`), so this works identically
# whether `pnpm install` is run from the main checkout or from a worktree.
#
# FAILURE POSTURE: never break an install.
# `prepare` also runs for a consumer installing this package from a git URL, so
# every branch here exits 0. A repository whose config cannot be written gets a
# loud stderr line instead of a hard failure — prevention is best-effort by
# design, and `scripts/check-remote-boundary.ts` is the backstop that detects
# what actually reached the remote whether or not this hook wiring held.
set -eu

# No git (or not inside a repository) — nothing to pin, and not an error.
command -v git >/dev/null 2>&1 || exit 0
git rev-parse --git-common-dir >/dev/null 2>&1 || exit 0

common_dir=$(git rev-parse --git-common-dir) || exit 0
repo_root=$(dirname "$(cd "$common_dir" && pwd)") || exit 0

# Only claim `core.hooksPath` in a checkout that actually carries `.husky/`.
# husky already claims it unconditionally, so this is strictly narrower than
# what running `husky` alone does — it just keeps a consumer's own repository
# out of scope if this ever runs somewhere unexpected.
[ -d "$repo_root/.husky" ] || exit 0

if ! git config core.hooksPath "$repo_root/.husky/_"; then
  echo "pin-git-hooks-path: could not set core.hooksPath in $repo_root — hooks will NOT run from linked worktrees" >&2
fi
exit 0
