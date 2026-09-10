# repository-branch-clones — run record

## 2026-09-10 — /team-plan

- Primary runtime: Claude Code, Opus 5 (claude-opus-5[1m]).
- Artifacts written untracked in the live checkout (docs-only; no git state change). Build happens in a worktree.

### Grounding evidence gathered (fresh, this session)

| Check | Command (abridged) | Result |
|---|---|---|
| Filesystem | `df -hT /`, `lsblk -f` | single ext4 `/dev/vda3`, 2.0T, 21% used; netcup KVM VM |
| Reflink | `cp --reflink=always` on ext4 | `Operation not supported` |
| Local clone hardlinks | `git clone --local` tiny repo; `stat -c %h` pack | link count 2 in both; same branch checked out in both clones OK |
| Hardlink rules | `sysctl fs.protected_hardlinks`; `man 2 link` | `1`; EXDEV across different mounts even on same fs |
| Second root mount | `findmnt /mnt/nc-native-root`; absolute-symlink scan of `data/` depth 4 | vda3 also at `/mnt/nc-native-root`; no `data/` path crosses into it |
| node_modules footprint | `find data/v2-topics -mindepth 5 -maxdepth 6 -name node_modules` + `du -sc` | 43 trees, 27,416,744 KB (~26 GB) |
| Lockfile diversity | sha256 of each topic's lockfiles (largest JS repo) | 280 worktrees: root 1, backend 2, frontend 2 distinct |
| Farm cost | `cp -al` of backend node_modules | 1.881 s; 6,784 dirs / 56,458 files; 27.0 MB new blocks |
| Farm semantics | tiny npm project, `chmod a-w`, `cp -al` | in-place append EACCES; new file OK; `npm ci` exit 0 cache intact; `npm install <pkg>` exit 0; no-op install exit 0; `.package-lock.json` replaced not edited |
| Legacy admin dirs | scan `worktrees/*/.git` pointers | 236 OK, 99 missing admin dir, 18 container-path |
| Storage GC | `journalctl -u nanoclaw-storage-gc` | daily 09:00 UTC apply run active |
| Container privileges | `container-runner.ts` | `--user hostUid:hostGid`; `no-new-privileges:true`; no sudo in image |

Research workers (read-only, Sonnet): host repository lifecycle; container/agent surface; GC/storage. Findings cited in plan §4.

### Plan-stage cross-model review (on raw revision 1, sha 0159534240ffc76d)

| Reviewer | Transport / model / effort | Status | Raw verdict |
|---|---|---|---|
| Codex (other family, contract reviewer) — attempt 1 | `codex exec --ignore-user-config --model gpt-6-astra -c model_reasoning_effort="high" --ephemeral --yolo --output-schema … --output-last-message …`, timeout 3600000 | `nonzero-exit` (usage limit until 2026-09-15 01:23) | — |
| OpenCode fallback per operator rule | `opencode run -m opencode/gemini-3.7-flash` (NO_PROXY bypass), timeout 3600000 | `timeout` (60-min ceiling reached; task stopped) | — |
| Codex — attempt 2, after operator reported credits restored | same command; header reported model gpt-6-astra, provider openai, effort high (matches) | `completed`, 231 s | `needs-attention`, 6 findings → recorded `must_fix` |
| Fable 5.1 fresh-context adversarial (same family — added coverage, not diversity) | Agent worker-frontier, read-only brief | `completed` | `must_fix`, 2 MUST + 6 SHOULD |

Coverage: **complete** (Codex other-family completed). Gemini recorded as timeout; not counted.

### Finding dispositions (lead-verified against source)

| ID | Source | Finding | Lead evidence | Disposition |
|---|---|---|---|---|
| M1 | Codex #5, Fable F1 | Rollback promise contradicts "worktree mode = exactly today" | `git-worktrees.ts:299-307,695-705` refuse `.git` dir | ACCEPTED MUST-FIX → mode controls creation only; resolution shape-aware in both modes; P2-18 |
| M2 | Fable F2 | Clone GC can trash unpushed work: orphan loop uses `'head'` for every entry; clone's `origin/*` polluted with canonical heads | `worktree-cleanup.ts:884-885,649-655`; scratch test: `git clone` maps canonical `refs/heads/*` → `refs/remotes/origin/*`, non-pruning fetch keeps them | ACCEPTED MUST-FIX → `proveCheckoutDisposable` (clone⇒'all', unknown⇒refuse) at every caller; remote-ref hygiene; P2-2, P2-12, P2-13 |
| M3 | Codex #1 | Conversion recovery deletes private dot entries | plan rev1 §5.7.4 step order + recovery rule | ACCEPTED MUST-FIX → `.new` farm-only, private entries moved only after swap, total recovery; P1-9 all interruption points |
| M4 | Codex #2, Fable S3 | Completeness/seal blind to missing package files | plan rev1 §5.7.3/§5.7.6 | ACCEPTED MUST-FIX → package-dir verification, SEALED inventory, verify-entry before use, convert inventory match; P1-16..18 |
| M5 | Codex #3, Fable S4 | Checkout published before initialization; tmp names parse as checkouts | plan rev1 §5.2/§5.3; `repository-workspaces.ts:16` | ACCEPTED MUST-FIX (violates R2) → host fully initializes in `.staging/`, atomic publish, metadata, idempotent pristine-only post-step; P2-5, P2-16, P2-19 |
| M6 | Codex #4, Fable S1 | Checkout on global FIFO blocks behind unrelated publish/transfer (circular wait with publish tool quiescence) | `job-runner.ts:26-30,44,151-160`; `index.ts:614-621` | ACCEPTED MUST-FIX (violates R1/outcome) → per-work-unit lane; P2-20 |
| M7 | Codex #6 | Local-only canonicals have no valid clone-mode path | `git-worktrees.ts:465-468,541-547` | ACCEPTED MUST-FIX (violates R10) → local-only rules throughout; P2-17 |
| S2 | Fable S2 | EACCES provokes `chmod` on shared inodes | `container-runner.ts:6626-6629` | ACCEPTED SHOULD-FIX → explicit instruction; residual risk + trigger recorded; guard/root stay deferred |
| S5 | Fable S5 | Forced refresh refspec can rewind canonical | plan rev1 §5.5; `index.ts:332-338` | ACCEPTED SHOULD-FIX → ff-only refspec; P2-9 |
| S6 | Fable S6 | Phase 3 gate unreachable for long-lived topics | `repository-workspaces.ts:293-295` | ACCEPTED SHOULD-FIX → usage-based gate + triage; Phase 3 must include lossless migration |

Open question from rev1 §10 (job chain semantics) answered from source: global serial FIFO (`job-runner.ts:26-30,44,151-160`).

### Correction batch

One bounded batch applied → plan revision 2. No re-review loop (contract: one correction batch). No workflow-only blocker created.
Added machinery justified by the findings: per-work-unit lane (concurrency, R1), staging + metadata (crash safety, R2), inventory (data integrity, R6/R8), `proveCheckoutDisposable` (data loss, R8).

### Approval

2026-09-10 — operator approved plan revision 2 ("has this been reviewed already? If so then approve"), after being told review ran on rev 1 and the rev-2 corrections are not separately re-reviewed until `/team-review --implementation`. `/team-build` starts with Phase 1.

## 2026-09-10 — /team-build, Phase 1 (dependency cache)

- Approved plan: `docs/specs/repository-branch-clones/plan.md` revision 2.
- Worktree: `/home/ubuntu/nanoclaw-v2/.claude/worktrees/dependency-cache`, branch `feat/dependency-cache` from `origin/main` 4f5c1d795. Spec files moved here from the live checkout (live checkout left clean).
- Git state before build: live checkout HEAD 781f493a9 (behind origin/main; deployer-owned), no user changes.
- Ratchet: `src/config.ts` is upstream-tracked → flag read without editing it; touched files (`src/dependency-cache.ts`, `src/storage-manager.ts`) are fork-only.
- Builder: one cohesive builder (worker-high), exclusive ownership of the worktree; lead owns plan.md/run.md, integration, and final evidence. Rationale for tier: crash-recovery protocol + sweep/spawn eligibility races.

### Build round 1 — builder result and lead verification (2026-09-10)

- Builder commit `45f9fd1ce` (4 files, +2533/−3 vs base 4f5c1d795: `src/dependency-cache.ts` 1221, test 902, `src/storage-manager.ts` +224, test +189). Tests materialized first; initial run 18/18 dependency-cache failed "not implemented", storage-manager 3 failed/115 passed (P1-13 `expected 1300 to be 300`, exemption test, P1-10 stub).
- Lead re-run (fresh, from worktree): `flock …/vitest.lock ionice -c3 nice -n 10 …/vitest run --maxWorkers=2 src/dependency-cache.test.ts src/storage-manager.test.ts` → **2 files, 136/136 passed**; `tsc --noEmit -p <wt>/tsconfig.json` → exit 0, no output; `eslint` on the 4 files → 0 errors, 65 warnings (warn-level `no-catch-all`; 24 on new lines); `tsx scripts/upstream-ratchet-report.ts` → `UNCHANGED 959 … (Δ 0)`.
- Diff inspected: `src/storage-manager.ts` full diff read (policy flag parse mirrors `parseRegenerableSweepDays`, `dirSizeBytes` nlink rule, temp names never descended, cache pass under `tryRunWithStorageCleanupClaim` + `topicIsUnmounted` re-check, farm exemption). Sweep runs in the storage worker thread (`src/storage-maintenance-worker.ts:47-60`, `storage-maintenance-worker-thread.ts:67`).
- Builder deviations accepted: `.new`-alone recovery inventory check (safer); P1-9 literal wording impossible for step-1/2 crashes (recovery restores); farm test via hidden-lockfile inode; quarantined-entry farms never re-adopted; package-dir mtime preserved across our renames (protects the idle signal); future-dated files refused; lastLinkedAt throttled hourly; `dependencyCacheMode` optional in `StoragePolicy` (foreign test builds full policies).
- Corrections required (plan updated first → rev 2.1, then builder round 2):
  1. **Completeness criterion wrong** — builder's read-only scan: literal rule refuses 34/37 real trees; every refusal an optional platform package npm omits from the hidden lockfile. Corrected §5.7.3 rule 1 (absent entries must be optional AND platform-excluded via os/cpu/libc); P1-4 extended, P1-19 added. Intent (R5/R6) unchanged — the check now matches npm's semantics; fail-closed for platform-allowed absent optionals.
  2. **`off` stranded rollback state** (builder deviation 3: `off` did nothing, contradicting §7 "entries age out") → §5.7.8 `off` still runs recovery + GC; P1-20.
  3. **First `apply` pass unbounded** (~37 converts × verify+link in one pass on the production disk) → §5.7.5 per-pass cap 5; P1-21.
- Deferred (not in this build): stale-fingerprint-until-restart recorded in §10; Phase 2 GC-vs-link race is Phase 2 scope.

### Build round 2 — completeness rule measured, decided (2026-09-10)

- Builder implemented fixes 2 (off = recovery + GC) and 3 (cap 5, `deferred`) and the platform-aware completeness rule as specified; 139/139 tests, tsc 0, eslint 0 errors, ratchet Δ0 on the uncommitted state. Stopped before committing per the lead's 90% rule.
- Read-only measurement over all 35 hidden lockfiles in `data/v2-topics`: (i) optional-only **33/35**; (ii) platform-aware **12/35** (36%). Real `checkCompleteness` agreed with the probe on all 35.
- (ii)-only refusals, three groups: wrongly refused transitive deps of skipped packages (`@emnapi/*`, `@napi-rs/wasm-runtime`, `@tybys/wasm-util`, `bindings`, …); wrongly refused musl builds whose lockfile entries omit `libc`; **correctly** refused native binaries genuinely missing on linux-x64 (`@esbuild/linux-x64` ×14, `@img/sharp-linux-x64` ×5, `@duckdb/node-bindings-linux-x64` ×5, `@rollup/rollup-linux-x64-gnu` ×3, …; spot-checked not on disk while the parent is installed; cause unverified — npm/cli#4828 pattern or optional fetch failure).
- **Decision (lead):** Phase 1 uses rule (i). Sound because no Phase 1 operation changes a workspace's file set (adopt shares the source's own inodes; convert requires inventory equality — only identical installs merge). The strict rule moves to Phase 2 link-at-checkout (§5.7.5), where content reaches a workspace that never installed it. Platform-aware implementation + evidence saved to the session scratchpad for Phase 2. Plan §5.7.3, §5.7.5, P1-4, P1-19 updated first.
- Side finding for the operator: many agent workspaces carry installs missing their native optional binaries (esbuild, sharp, rollup, duckdb). Not in scope; candidate follow-up.

### Build gate — Phase 1 ready for /team-review --implementation (2026-09-10)

- Commits on `feat/dependency-cache` (base `4f5c1d795`): `45f9fd1ce` feat, `cd352ae7e` fix (rev 2.1 corrections). Files: `src/dependency-cache.ts` (new), `src/dependency-cache.test.ts` (new), `src/storage-manager.ts`, `src/storage-manager.test.ts`.
- Lead re-run on `cd352ae7e` (fresh): vitest `src/dependency-cache.test.ts src/storage-manager.test.ts` (flock + ionice -c3 + nice 10 + `--maxWorkers=2`) → **2 files, 139/139 passed**; `tsc --noEmit` → exit 0, no output; eslint on the 4 files → 0 errors, 65 warnings (warn-level `no-catch-all`); ratchet → `UNCHANGED 959 … (Δ 0)`; live checkout `status --porcelain` empty.
- Round-2 diff inspected (`45f9fd1ce..cd352ae7e`, src only): `checkCompleteness` rule (1) optional-only plus hidden⊆package-lock; `takeMutation` cap (report mode counts too, so report predicts apply); lazy per-pass fingerprint (off/recovery-only passes never inspect the image; `fingerprintAvailable` reported); flag `off` in an applying pass = `cleanupOnly` (recovery + GC, no targets, no exemption); `.new`-alone recovery waits for a fingerprint.
- Real-tree check (builder, read-only): implemented `checkCompleteness` accepts **32/35**. 2 refusals = non-optional entry absent (genuinely incomplete); 1 = rule (3), a Prisma engine `.so.node` written after the hidden lockfile by a postinstall — the §10-predicted case, fail-closed; "exclude by path" left as an operator follow-up.
- Accepted builder deviations (round 2): fingerprint resolved lazily; cap counts report-mode decisions; `off` pass logs only when it recovered or collected; tests extend P1-4/P1-9/P1-19 beyond the letter; npm platform semantics cited (`npm-install-checks/lib/index.js:34-38,59-82`).
- Edge cases covered by tests: interruption at every convert step incl. mid-step-4 (P1-9); off-mode recovery/GC (P1-20); cap/deferral across passes (P1-21); quarantine on modify/delete/resize (P1-8, P1-17); inventory mismatch keeps private (P1-18); workgroup isolation (P1-11); mount/claim guard (P1-10); report mode inode-identical (P1-15); fingerprint fail-closed; package-dir mtime preserved.
- Remaining risks: first-apply I/O bounded by cap (5/pass); stale fingerprint until host restart; chmod residual (accident-proof only); Phase 2 GC-vs-link race (Phase 2 scope); Prisma-style postinstall trees stay private until an exclude-by-path follow-up.

#### Phase 2 evidence: strict (platform-aware) completeness

(Recorded durably here; the implementation patch lived only in the session scratchpad and is re-derivable from the npm source cited below.)

## Rule (1) acceptance

| Rule (1) variant | Accepted | Refused |
|---|---|---|
| (i) hidden ⊆ package-lock with equal {version, resolved, integrity}; every absent entry `optional: true` | 33 | 2 |
| (ii) as (i), and every absent entry also has an `os`/`cpu`/`libc` constraint excluding linux/x64/glibc | 12 | 23 |
| (iii) rough: (ii) plus "absent optional accepted when every dependent is also absent" (dependents matched by name, so a lower bound) | ≥16 | ≤19 |

The implemented `checkCompleteness` (ii) agreed with an independent probe on all 35 trees.
Rules (2) and (3) refused none beyond rule (1). All 23 (ii) refusals were rule (1).

## Packages (ii) refuses but (i) accepts, by class (tree counts)

### A. Wrongly refused: transitive skip (optional, no own constraint, dependent itself skipped)
- `@emnapi/runtime` [15], `@emnapi/core` [6], `@emnapi/wasi-threads` [6], `@napi-rs/wasm-runtime` [6],
  `@tybys/wasm-util` [6]: dependents are wasm32 bindings (`@img/sharp-wasm32`, `@napi-rs/wasm-runtime`),
  themselves absent.
- `bindings` [8]: dependent `lzo`, itself absent.
- `msgpackr-extract` [1], `node-gyp-build-optional-packages` [1].

### B. Wrongly refused: musl build whose lockfile entry has no `libc`
The lockfile carries only `os:["linux"], cpu:["x64"]`, so exclusion cannot be proven from the lockfile.
npm skips them after reading the package manifest's `libc`.
- `@img/sharp-linuxmusl-x64`, `@img/sharp-libvips-linuxmusl-x64`, `@css-inline/css-inline-linux-x64-musl` [5-6 each]
- `@rollup/rollup-linux-x64-musl`, `@unrs/resolver-binding-linux-x64-musl`, `lightningcss-linux-x64-musl`

### C. Correctly refused: platform-allowed native binary genuinely missing, dependent installed
- `@esbuild/linux-x64` [14], `@img/sharp-linux-x64` [5], `@img/sharp-libvips-linux-x64` [5],
  `@duckdb/node-bindings-linux-x64` [5], `@css-inline/css-inline-linux-x64-gnu` [5],
  `@rollup/rollup-linux-x64-gnu` [3], `lightningcss-linux-x64-gnu` [2],
  `@unrs/resolver-binding-linux-x64-gnu` [2], `@expo/ngrok-bin-linux-x64` [2]
- Spot check, 8 trees missing `@esbuild/linux-x64`: not on disk, not under any nested hidden-lockfile
  key, no `optional=false`/`omit=optional` in the package `.npmrc`, and `esbuild` itself installed.
  The pattern fits npm/cli#4828 (platform optionals skipped from an existing lockfile); the cause
  was not verified.

## Implications for Phase 2 link-at-checkout

A strict rule for linking into a workspace that never installed must handle A (resolve transitive
skips through the lockfile's dependency graph by node resolution, not by name) and B (read `libc`
from the package manifest, since lockfiles may omit it) before it is usable. Otherwise it refuses
most real trees. Class C trees are genuinely degraded, and linking one into a fresh checkout would
hand that checkout a tree missing its native binary.

npm platform semantics used: `npm-install-checks/lib/index.js:34-38` (lists checked only when the
entry declares them; a declared libc with unknown local libc fails) and `:59-82` (`checkList`).
