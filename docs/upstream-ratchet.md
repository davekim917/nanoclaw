# Upstream divergence ratchet

The fork carries a large, deliberate divergence from upstream `nanocoai/nanoclaw`. The ratchet does not
try to shrink it. It makes every step of it visible and one-directional: an upstream-owned file may move
back toward upstream freely, and may only move further away as a named, justified act.

## What it measures

`src/upstream-ratchet.json` is an allowlist with one entry for **every** path upstream owns at a single
**pinned** commit — no exclusions, so nothing can diverge by being left off the list. Paths the fork
*added* are out of scope: they are not upstream-owned and there is nothing to ratchet against.

```json
{
  "upstream": "b76fcb3db0236b36a4d50bed02e89eff472d0e67",
  "files": {
    "src/host-sweep.ts": { "diff": 1462, "sha256": "…" },
    "docs/gone.md":      { "diff": 40, "sha256": null, "deleted": true },
    "assets/logo.png":   { "diff": 1, "sha256": "…", "binary": true }
  }
}
```

| Field | Meaning |
|---|---|
| `upstream` | the pinned commit. **Not** `upstream/main` — a moving base measures upstream's activity, not the fork's divergence. Re-pinning is a deliberate act (`--upstream <sha>`), done by the sync orchestrator when a theme lands. |
| `diff` | added + deleted lines vs the pinned commit. `0` is byte-identical. For a path the fork deleted, upstream's own line count. For a binary path, `1` when the bytes differ. |
| `sha256` | sha256 of the **fork's** current bytes, `null` when the fork deleted the path. For a symlink it is the hash of the link *target string*, which is what git stores for a mode-120000 blob. |
| `deleted` | present only when the fork deleted the path. |
| `binary` | present only when git reported the path as binary. |

## Two halves, and why

`src/upstream-ratchet.test.ts` runs in the ordinary host vitest suite and has **no git**:
`src/test-hermeticity.ts` mocks `child_process` for every host suite, and the fork's CI clone carries no
upstream commit objects at all. So it cannot measure a diff. What it proves is that the manifest is
**current** — every upstream-owned file still hashes to what it hashed when its `diff` was recorded,
deleted stays deleted, present stays present, every entry is well formed. That is what makes a recorded
`diff` trustworthy without git.

`scripts/upstream-ratchet-report.ts` has git, and does the arbitration. It recomputes every entry against
the pinned commit with one `git diff --numstat` for the whole tree (about a quarter of a second warm) and
classifies each path.

## The three commands

```bash
pnpm run ratchet:report                      # report; exit 1 on GROWTH or NEW
pnpm run ratchet:report -- --write           # regenerate the manifest
pnpm run ratchet:report -- --upstream <sha>  # re-pin to a newer upstream commit
```

Useful flags: `--accept <path>` (repeatable) and `--accept-all` permit growth in `--write`; `--root <dir>`
points at another checkout or worktree; `--json` gives machine output.

The pinned commit has to be in the local clone. If it is not, the script exits **2** and prints the
`git fetch upstream <sha>` to run.

## Reading the verdicts

| Verdict | Meaning | Effect |
|---|---|---|
| **GROWTH** | the fork diverged further in that file | fails (exit 1) |
| **NEW** | a byte-identical file is now divergent, or a present file is now deleted | fails (exit 1) |
| **SHRINK** | the fork moved back toward upstream | always allowed |
| **STALE** | recorded as divergent, now byte-identical | allowed; the manifest owes a `--write` |
| **UNCHANGED** | same divergence as recorded | — |
| **DROPPED** | the path left upstream's tree | only possible on a re-pin; never a failure |

`--write` refuses, with the offending paths named, while any GROWTH or NEW path is not covered by
`--accept` or `--accept-all`. Shrinks and stales are written without ceremony. `--upstream <sha>` implies
both `--write` and `--accept-all`, because re-pinning moves the base under every number at once for
reasons that have nothing to do with the fork; it prints the full delta for review.

## The PR rule

A PR that touches an upstream-owned file regenerates `src/upstream-ratchet.json` in the same commit.
A PR that **grows** a diff carries the `--accept` in that manifest change and one line of justification in
the PR body. Shrink needs neither.

## From a linked worktree

Run the boundary check as

```
node_modules/.bin/tsx scripts/check-public-boundary.ts -- --root "$W" --index
```

with root = the worktree, so its own index is scanned (the identifier registry falls back to the main
checkout through git commondir). `--root /home/ubuntu/nanoclaw-v2` from a worktree scans the live index and
proves nothing. A report saying `structural patterns only — no identifier registry found` means blind —
hold the push.
