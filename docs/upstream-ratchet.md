# Upstream divergence ratchet

The fork carries a large, deliberate divergence from upstream `nanocoai/nanoclaw`. The ratchet does not
try to shrink it. It makes every step of it visible and one-directional: an upstream-owned file may move
back toward upstream freely, and may only move further away as a named, justified act.

## What it measures

`src/upstream-ratchet.json` is an allowlist with one entry for **every** path upstream owns at a single
**pinned** commit — no exclusions, so nothing can diverge by being left off the list. Paths the fork
*added* are out of scope: they are not upstream-owned and there is nothing to ratchet against.

```
{"upstream":"b76fcb3db0236b36a4d50bed02e89eff472d0e67","paths":"04812c26…","files":{
"assets/logo.png":{"diff":1,"mode":"100644","sha256":"…","binary":true},
".claude/scheduled_tasks.lock":{"diff":1,"mode":"100644","sha256":null,"deleted":true,"ignored":true},
"docs/gone.md":{"diff":40,"mode":"100644","sha256":null,"deleted":true},
"src/host-sweep.ts":{"diff":1504,"mode":"100644","sha256":"…"}
}}
```

**One line per file entry, sorted by path, and nothing but `upstream`, `paths` and `files`.** That layout is the
point, not a quirk: pretty-printed JSON spreads each entry over four to six indented lines, so two PRs that
each regenerate the manifest after touching unrelated upstream-owned files collide on the braces between
their entries. One line per path lets git merge them, and two regenerations conflict only on the paths they
**both** touched. The three top-level fields are `upstream` (the pinned commit), `paths` (the coverage
seal) and `files`. No totals, no counts, no timestamps — an aggregate would change on every regeneration
whatever moved, so every PR would conflict on it, and the report derives those numbers from the entries
anyway. The seal is not an aggregate in that sense: it covers the key SET, not the entries' contents, so it
moves only on a re-pin.

The file is written by `serializeManifest` (`src/upstream-ratchet.ts`) and is in `.prettierignore`, because
prettier would reflow it straight back into the indented shape. It is still ordinary JSON — `readManifest` is
a plain `JSON.parse`. Never hand-edit or reformat it; regenerate it. The serializer is deterministic (sorted
paths, fixed key order, optional flags only when true), so `--write` twice on an unchanged tree produces
byte-identical output, and `src/upstream-ratchet.test.ts` fails if the committed bytes are not exactly what
the serializer would emit.

| Field | Meaning |
|---|---|
| `upstream` | the pinned commit, always a full 40-hex sha. **Not** `upstream/main` — a moving base measures upstream's activity, not the fork's divergence. Re-pinning is a deliberate act (`--upstream <rev>`), done by the sync orchestrator when a theme lands. |
| `paths` | coverage seal: sha256 of the pinned commit's sorted path list. Without it, deleting one entry line leaves valid, sorted, canonical JSON that every other check passes, and that path is then silently unprotected. Stable across ordinary regenerations; it moves only on a re-pin. |
| `diff` | added + deleted lines vs the pinned commit, **plus one unit when the fork's file mode differs from upstream's**. `0` is byte- and mode-identical. For a path the fork deleted, upstream's own line count. For a binary path, `1` for the bytes. |
| `mode` | the **fork's** working-tree mode (`100644`, `100755` or `120000`), or upstream's when the fork deleted the path. A `chmod -x` changes no bytes and no lines, so without this field it is invisible to every other check. Taken from `lstat`, not from the index, so an unstaged chmod is caught rather than hidden until it is committed. |
| `sha256` | sha256 of the **fork's** current bytes, `null` when the fork deleted the path. For a symlink it is the hash of the link *target string*, which is what git stores for a mode-120000 blob. |
| `deleted` | present only when the fork deleted the path. |
| `ignored` | present only when the fork's `.gitignore` covers the path. Always alongside `deleted`. |
| `binary` | present only when git reported the path as binary. |

**Submodules are not supported.** A gitlink has no bytes to hash and no lines to count, so every check would
be vacuously true for it. One on either side is refused loudly rather than recorded as something it is not.

### Ignored upstream paths

An upstream-owned path the fork **deleted and then gitignored** is recorded with `ignored: true`, and neither
the test nor the report looks at the working tree for it. There is exactly one today:
`.claude/scheduled_tasks.lock`, a runtime lock file that a running system recreates on its own checkout.

Checking it would be worse than useless. Present, it reads as `resurrected` and turns the host suite red on
a file that is not source; absent, it reads as deleted. Both answers describe what the runtime last did, not
what the fork decided. The divergence that IS real is the `.gitignore` rule, and that is already counted —
`.gitignore` is an upstream-owned file with its own entry, so adding or removing the rule moves a diff there.

`ignored` always implies `deleted`, and that is a consequence rather than a convention: `git check-ignore` is
index-aware and never reports a tracked path, so an ignored upstream path is by definition one the fork does
not track. The manifest is rejected if the two ever come apart.

#### The objection, and why it does not land

Skipping those checks looks like a hole, and a reviewer read it as one, so the argument is written down
rather than left implicit.

*The objection:* a deleted upstream path matched by an ignore rule can be recreated with arbitrary bytes,
and those bytes can change again later, and neither the test nor the report says a word. Resurrection checks
exist precisely to catch a deleted upstream file coming back.

*Why it does not apply:* **a gitignored path cannot be committed.** Whatever sits there is not, and cannot
become, fork source without someone first editing `.gitignore` — and that file is upstream-owned with its
own entry, so the edit moves a diff and goes through the ratchet like any other change. This tool measures
the divergence of the fork's *source*. Untracked bytes are not source; they are whatever the machine
happened to be doing. For the one real instance, "did it come back?" answers "is the system running?", which
is not a question about divergence, and answering it turned the host suite red on a production checkout.

*What is not claimed:* that the tree is clean, or that nothing is sitting there. Only that the fork's
committed content is unchanged — the property the manifest exists to check.

*What holds it up:* the exemption is load-bearing only while `ignored` really means untracked, so that is
asserted rather than assumed. `buildManifest` refuses at write time if an ignored path is in the fork index
(an ignore rule over a tracked file is a misconfiguration — git honours the index over the rule), `checkTree`
rejects an `ignored` entry that is not also `deleted`, and the hermetic suite asserts that pairing across the
real manifest. A per-file exception list was considered and rejected: it needs a human to maintain and says
nothing about why.

If a runtime artefact can be moved out of the source tree instead, that is strictly better and this
exemption stops applying to it.

## Three parts, and why

`src/upstream-ratchet.test.ts` runs in the ordinary host vitest suite and has **no git**:
`src/test-hermeticity.ts` mocks `child_process` for every host suite, and the fork's CI clone carries no
upstream commit objects until the ratchet's own CI step fetches them. So it cannot measure a diff. What it
proves is that the manifest is **current** — every upstream-owned file still hashes *and still has the mode*
it had when its `diff` was recorded, deleted stays deleted, present stays present, the pinned path set is
complete, and every entry is well formed. That is what makes a recorded `diff` trustworthy without git.

`src/upstream-ratchet-core.ts` holds the arbitration as pure functions: parsing git's output, building
entries, classifying, and the `--write` gate. It lives apart from the script so the boundary matrix has
hermetic tests (`src/upstream-ratchet-core.test.ts`) — a test can never drive the CLI, because
`child_process` is mocked.

`scripts/upstream-ratchet-report.ts` runs git and picks an exit code, and holds no decisions of its own. It
recomputes every entry against the pinned commit with five whole-tree git calls (`rev-parse`, `ls-tree`,
`ls-files`, `diff --numstat`, `check-ignore --stdin` — about a third of a second warm) and classifies each
path.

**The numbers are checked in CI, not self-reported.** `.github/workflows/ci.yml` has an
`Upstream divergence ratchet` step that fetches the pinned commit by sha (`git fetch --depth=1 <url> <sha>`,
which GitHub serves in well under a second) and runs the report. Without it a PR could regenerate the
manifest with `--accept-all` and nothing would ever recheck the arithmetic. Exit 2 there means the fetch did
not land — an infrastructure failure, not a ratchet failure.

## The three commands

```bash
pnpm run ratchet:report                      # report; exit 1 on GROWTH or NEW
pnpm run ratchet:report -- --write           # regenerate the manifest
pnpm run ratchet:report -- --upstream <sha>  # re-pin to a newer upstream commit
```

Useful flags: `--accept <path>` (repeatable, and `--accept=<path>` for a path that starts with a dash) and
`--accept-all` permit growth in `--write`; `--root <dir>` points at another checkout or worktree; `--json`
gives machine output. Every path the tool prints back to you is shell-quoted, so a suggested command can be
pasted as-is even for a path with a space or a quote in it.

The default report prints a per-file table — verdict, path, recorded diff, current diff, delta — grouped by
verdict, then the one-line summary. Paste the table into the PR body when a diff moved:

```
GROWTH (1)
  GROWTH    .github/workflows/ci.yml                                   49 → 64 (+15)

959 upstream-owned files at b76fcb3d: 435 modified, 294 deleted in fork, 230 byte-identical, 0 binary
UNCHANGED 958   (measured in 269 ms)
729 divergent files, 127,348 diff lines vs b76fcb3d (Δ 15)
```

A GROWTH row that carries a parenthesised reason (`mode 100644 → 100755`, `binary bytes changed`,
`restored in fork`) is one where the line count alone did not move — those are the cases where added+deleted
is not a measurement. `binary bytes changed` fires when **either** side of the comparison is binary, not just
the current one: a divergent binary at diff 1 turning into divergent text at diff 1 changes the bytes while
every number stays put.

The pinned commit has to be in the local clone. If it is not, the script exits **2** — "cannot measure",
which is deliberately a different code from "the ratchet failed" — and prints the `git fetch upstream <sha>`
to run. `--upstream <rev>` accepts anything `git rev-parse` understands and persists the **resolved** 40-hex
commit, so a tag or a branch name can never end up in the manifest as a moving pin.

Manifest keys are validated before anything is read: lexically (absolute paths, `..`, empty segments, NULs,
backslashes) and then physically — the entry's nearest existing ancestor **directory** is resolved through
symlinks and must land inside the repo. The lexical rules alone are not enough, because an ancestor directory
can be a symlink pointing anywhere; this checkout's own `node_modules` is exactly that shape. The final
component is deliberately never followed, since a symlink entry is hashed by its target string.

Two things make the script refuse outright rather than measure something misleading: an upstream-owned path
that exists on disk but is **untracked and not ignored** (git would report it as deleted while its bytes are
read for the hash — this covers paths that have become directories), and a **submodule** on either side — including one that merely
stands *above* upstream-owned files, since a fork submodule replacing `vendor/` hides everything upstream
owns under it just as completely as one replacing a single file. An *ignored* path is exempt: see "Ignored
upstream paths" above.

## Reading the verdicts

| Verdict | Meaning | Effect |
|---|---|---|
| **GROWTH** | the fork diverged further in that file, its file mode changed, or a divergent binary's bytes changed | fails (exit 1) |
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
