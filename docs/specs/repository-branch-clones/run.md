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

## 2026-09-10 — /team-review --implementation (Phase 1)

- Target: approved plan rev 2 / build-time rev 2.1 + `git diff 4f5c1d795 a5c215872 -- src/` (2994 lines). Lenses: correctness, simplicity, plan fidelity, failure handling, verification quality + security/data-loss, state & rollback, performance (named risks: file renames/deletes inside live production workspaces; spawn races; first-pass I/O).
- Fresh risk-selected checks (lead): related storage suites that consume the changed `dirSizeBytes`/`StoragePolicy` — `vitest run src/storage-activity.test.ts src/storage-gc.test.ts src/storage-maintenance-worker.test.ts src/storage-pressure-alert.test.ts src/worktree-cleanup.test.ts` (flock + ionice + `--maxWorkers=2`) → **5 files, 144/144 passed**. `dirSizeBytes` callers: storage-manager.ts:1818,1828,1854,2053,2061,2489,2604; worktree-cleanup.ts:900,970 (all want reclaimable bytes).

### Reviewers

| Reviewer | Transport / model / effort | Status | Raw verdict |
|---|---|---|---|
| Codex (other family, contract reviewer) | `codex exec --ignore-user-config --model gpt-6-astra -c model_reasoning_effort="high" --ephemeral --yolo --output-schema … --output-last-message …` from the worktree, prompt+bundle on stdin (184,920 bytes), timeout 3600000 | `completed`, 188 s; header model gpt-6-astra / openai / high (matches) | `needs-attention`, 2 findings (both high) → `must_fix` |
| Fable 5.1 adversarial (same family, added coverage — named risk: data loss in live workspaces) | Agent worker-frontier, read-only | running | — |

### Codex findings — lead verification

- **CX1 (high) inventory equality ≠ content equality.** Verified: `inventoryFromWalk` records `[rel, type, size]` only (`src/dependency-cache.ts:273-275`); `convertVerified` compares that digest (`:965`) then deletes `.old` (`:1006`). Same-size different-content files (or symlink targets) pass and are replaced. Violates the plan's own rev-2.1 premise ("only identical installs merge", §5.7.3) that justifies the optional-only rule. ACCEPTED MUST-FIX.
- **CX2 (high) unsafe cache states fall through to the 2-day delete.** Verified in the storage-manager diff: `recoverPackageDir` results are discarded and the keep-set covers only farm/adopted/converted outcomes; the delete loop iterates every target, including `node_modules` of package dirs that still hold `.node_modules.nanoclaw-old` (recovery `blocked`/`failed`, interrupted convert). Deleting that `node_modules` can drop private entries already moved into it, making later recovery lossy; applies in `off` and flag-`report` passes too. ACCEPTED MUST-FIX. The sub-claim that `convert-mismatch`/deferred trees are deleted after 2 idle days is today's regenerable rule and the plan's stated behavior (§5.7.5) — REJECTED as a finding (not a regression).

### Fable adversarial findings — lead verification

Raw verdict `clear`, 4 SHOULD-FIX (no MUST-FIX).

- **FB1 cold-cache report mispredicts** — verified `dependency-cache.ts:886-889` (report adopt creates no entry) and `:1067/:1085` (`isRealDir(entryDir)` sole entry signal): every same-key tree reports `adopt`, so the §7 24 h report cannot show converts/mismatches/bytes. ACCEPTED (the rollout gate depends on report truthfulness) → per-pass would-be-sealed keys; P1-24.
- **FB2 hidden lockfile shared read-only** — cited npm 10.9.8 `@npmcli/arborist` `reify.js:254` → `shrinkwrap.js:1164` (write in place; on error unlink). Consistent with the lead's earlier experiment (after `npm install <pkg>` in a farm the cache copy's link count dropped to 1). Every farm would lose farm detection + completeness on its first install. ACCEPTED → copy, never link, the hidden lockfile; farm detection by first non-lockfile inventory inode; P1-25.
- **FB3 flag `report` never recovers; delete sweeps beside pending temp names** — same class as CX2; ACCEPTED, folded into the CX2 fix (primitive: the regenerable delete's apply-time recheck, every flag mode). Report stays non-mutating; recovery waits for `apply`/`off`.
- **FB4 P1-10 not discriminating for the under-claim mount re-check** — verified: the scan-time `args.mounts` refusal (`storage-manager.ts:2588-2599`) already refuses the fixture, so removing the `topicIsUnmounted` re-check (`:2621`) stays green. ACCEPTED → mount-between-scan-and-mutation case, with a disable-and-fail confirmation.

### Correction batch (rev 2.2)

Plan updated first (§5.7.3 hidden lockfile + content manifest, §5.7.4 adopt/convert/farm detection, §5.7.5 pending-conversion protection + I/O note, §5.7.8 report semantics, §9 P1-10 second case + P1-22..25). One batch sent to the builder: CX1, CX2+FB3, FB1, FB2, FB4.

### Correction batch result — verification (2026-09-10)

- Builder commit `992965e07` (CX1, CX2+FB3, FB1, FB2, FB4). Lead re-run of affected checks (once, fresh): vitest on the 7 storage files → **7 files, 287/287 passed**; `tsc --noEmit` → exit 0, no output; eslint on the 4 files → 0 errors, 67 warnings (warn-level `no-catch-all`, 2 new); ratchet → `UNCHANGED 959 … (Δ 0)`; live checkout status empty. Builder reports P1-10's new case fails with the under-claim `topicIsUnmounted` re-check disabled (`storage-manager.test.ts:3316`) and passes restored.
- Real-tree count (read-only): 30/33 accepted (population shrank by one topic's two trees since the last count); the same 3 refusals.
- Accepted builder deviations: a tree whose only regular file is its hidden lockfile is `ineligible`; quarantined-entry farm check falls back to a short walk when SEALED is unreadable; no pending-conversion counter in `skipped` (foreign test literal); SEALED now requires `contentSha256` (no entries exist yet).
- **NEW-1 (created by the CX1 correction) — content reads escape the per-pass cap.** Verified `src/dependency-cache.ts:1107-1111`: `deferIfCapped` runs before the content read, but a content mismatch returns at `:1109` without consuming a slot (`pass.mutations` increments only at `:1111`). Every tree whose inventory matches its entry but whose bytes differ (e.g. per-install native-build outputs) is fully re-hashed (~0.7 GB each) on every hourly pass, apply and report alike — unbounded I/O on the production disk, contradicting §5.7.5's cap rationale. Classification: mechanism flaw (the cap bounds mutations, not reads), not an external invariant. Per the correction rule (one batch per review entry), stopped and brought to the operator with a proposed bounded fix: count every content read against the cap, and memoize mismatch verdicts keyed by (package dir, inventory sha, hidden-lockfile mtime, entry content sha) so an unchanged mismatched tree is not re-read.
- Review status: **must_fix (NEW-1) pending operator decision**; all six original findings verified fixed.
- 2026-09-10 — operator approved applying the NEW-1 fix ("yes, apply the fix"). Plan rev 2.3: §5.7.5 cap counts content reads + mismatch-verdict memo + `contentReads` counter; P1-26. Sent to the builder as a single scoped fix; affected checks to be re-run once afterwards.

### NEW-1 fix — verification and review conclusion (2026-09-10)

- Builder commit `b3be98d2b` (src/dependency-cache.ts +82/−7, test +45). Diff inspected: `convertVerified` takes the cap slot and counts `contentReads` before `contentManifestSha256`; a mismatch memoizes {inventory sha, hidden-lockfile mtime, entry content sha} per package dir; a matching memo returns `convert-mismatch` with no read and no slot; memo pruned each pass for vanished dirs; memo in module memory because the storage worker is persistent (`storage-maintenance-worker.ts:69,136,171`; `storage-maintenance-worker-thread.ts:45`). Stale verdicts fail closed (tree stays private, never deleted).
- Lead re-run of affected checks (once, fresh): vitest on the 7 storage files → **7 files, 288/288 passed**; `tsc --noEmit` → exit 0, no output; eslint on the 2 changed files → 0 errors, 25 warnings (warn-level `no-catch-all`, none new); ratchet → `UNCHANGED 959 … (Δ 0)`; live checkout status empty.
- Builder deviations accepted: memoized mismatches still counted in `convertMismatch` but log only the decision line; test-only `_convertMismatchMemoSizeForTesting`. Noted: one confirming test run by the builder ran at ionice/nice priority but outside the flock.

**Review verdict: clear.** Other-family coverage complete (Codex, gpt-6-astra/high, completed); same-family adversarial coverage (Fable) added. Findings: CX1, CX2 (MUST-FIX) and FB1–FB4 (SHOULD-FIX) accepted and verified fixed in `992965e07`; the CX2 sub-claim about deleting mismatched/deferred trees rejected (today's rule, plan §5.7.5); NEW-1 (created by the CX1 fix) fixed in `b3be98d2b` with operator approval.

Known risks carried to ship: stale fingerprint until host restart; chmod residual (accident-proof only); trees whose postinstall writes after the hidden lockfile stay private (Prisma case); Phase 2 GC-vs-link race and strict completeness (Phase 2 scope); origin/main has moved since base `4f5c1d795` — rebase before PR.

## 2026-09-11 — /team-ship (Phase 1)

- Operator selected: **PR to fork** (rebase onto current main, rerun checks, push branch, open PR; Codex GitHub review loop; no merge without the operator's go-ahead).
- Preflight: origin = davekim917/nanoclaw (default `main`, via `gh repo view`); branch 11 behind / 6 ahead; main's new commits touch none of our files; `git merge-tree --write-tree` clean.
- Rebased onto origin/main `aa7e6f75b` → HEAD `55a8af9b5`. Fresh checks on the rebased tree: vitest 7 storage files → **288/288**; tsc exit 0; eslint 0 errors (67 warnings, warn-level `no-catch-all`); ratchet `UNCHANGED 959 … (Δ 0)`.
- First push refused by the pre-push hook (`node_modules/.bin/tsx: not found`) — open issue #623: the worktree had a real `node_modules/` holding only vitest/unbash caches (31 entries, 272 KB, gitignored, not a symlink), so the hook did not link the main checkout's tooling. Removed that cache dir; retried.
- Push: `git push -u origin feat/dependency-cache:feat/dependency-cache` → public boundary check passed; remote head `55a8af9b52c606a948109017ec777c260703a8ad` == local HEAD.
- PR: **#625** https://github.com/davekim917/nanoclaw/pull/625 (OPEN, base main). Not merged, not deployed; flag defaults `off`.
- PR review mode: `codex-review.sh scope` → `{"mode":"risk-scoped","verdict":"skip"}` (Risk label run set neither `risk:high` nor `review:requested`) — no GitHub Codex round; cross-model coverage is the Codex CLI implementation review above. Gate = green CI + `merge-check`.
- CI run 34548175633: `bookkeeping` pass, `label` pass, **`correctness` fail** (Host tests, 12m58s): 2 failed / 470 passed files. Reproduced locally:
  - `src/mailbox-seam-unreachable-scripts.test.ts` › storage-manager.ts relative-import manifest — new `src/dependency-cache.ts` edge not pinned.
  - `src/db/raw-db-ratchet.test.ts` › raw-handle referrers — `src/dependency-cache.test.ts` newly references `getRawDb` (a `./db/connection.js` mock for its sweep-level tests). Ratchet only shrinks → move those tests into the already-pinned `storage-manager.test.ts` instead of widening `RAW_DB_IMPORTERS`.
  - Main's CI was green at the rebase base `aa7e6f75b` → failures are this branch's. Missed locally because only the targeted storage suites were run (host-safety rule: never the full suite); the repo's architecture guard tests must be in the targeted set for any change touching storage-manager imports or DB mocks.
- `merge-check --head 55a8af9b5` → exit 24 `ci_red`. Fix delegated to the builder (commit only; lead verifies and pushes via `codex-review.sh push`).
- CI fix: builder commit `63092438c` (tests only) — `src/dependency-cache.ts` pinned in storage-manager's import manifest (comment corrected by the builder: config.ts is not a leaf; the claim that holds is "reaches nothing storage-manager.ts did not already reach"); the three `getStorageReport`-based tests (P1-14, P1-20, P1-24) moved into the pinned `storage-manager.test.ts`, and the `getRawDb` mock removed from `dependency-cache.test.ts` (`RAW_DB_IMPORTERS` unchanged).
- Lead verification on `63092438c`: standing tripwire set (`raw-db-ratchet`, `raw-outside-lease`, `insert-or-adopt`, `transaction-closures`, `async-seam-tripwires`, `skill-resources-async-callers`, `wake-chokepoint`, `migrations/registry`) + `mailbox-seam-unreachable-scripts` + `mailbox-seam-ratchet` + 7 storage suites → **17 files, 410/410**; `tsc` host and scripts exit 0; prettier `--check` clean on changed files; eslint 0 errors; ratchet Δ 0.

## 2026-09-11 — Deploy, first report pass, rev 2.4 (Phase 1)

- The operator deployed with `scripts/deploy.sh` at 03:30:08Z. Build `306b0f8b7` == HEAD == origin/main (clean), with `NANOCLAW_DEPENDENCY_CACHE=report` in the live `.env`. OneCLI preflight ok; no new errors.
- First pass, 03:30Z:
  - `decisions=36 adopted=5 convertMismatch=5 deferred=22 contentReads=5 privateInMountedTopics=2 (1.09 GB) fingerprintAvailable=true`.
  - 4 trees incomplete: a hidden lockfile missing; a postinstall engine newer than the hidden lockfile (the known postinstall case); two nested non-optional package-lock entries absent from the hidden lockfile.
- **Finding: every one of the 5 convert-mismatches first differs at `.package-lock.json`.**
  - Diffing two pairs: the `packages` maps are identical except 5–6 keys. One tree holds `@esbuild/linux-x64` and `@rollup/rollup-linux-x64-*`; the other holds the `linux-arm64` builds.
  - Host `x86_64`, agent image `linux/amd64`, fingerprint `arch=x64` (`process.arch`, `src/dependency-cache.ts:76`).
  - Across all 37 topic installs: 24 x64, 10 arm64 (all installed 09-06..09-08), 2 mixed, 1 with no native packages. Two of the 5 predicted adopts were arm64 trees. What produced the arm64 installs is not identified.
- **Impact:** none in `report`. In `apply`, rules 1–3 would seal arm64 entries under x64 keys. Convert still fails closed on content equality, and `linkPackageDir` has no production caller in Phase 1. So the harm is x64 trees never deduplicating, plus a wrong-platform entry waiting for Phase 2's link.
- **Correction (rev 2.4):** plan §5.7.3 rule 4, where installed packages must accept the platform's `os`/`cpu`, matched as npm-install-checks 7.1.2 `checkList` does (`/usr/lib/node_modules/npm/node_modules/npm-install-checks/lib/index.js:59-83`). `apply` waits for this fix.
- Build, test-first. Before the fix the new tests failed as expected: the arm64 tree was `adopted`, and foreign `cpu`/`os` entries were accepted. They pass on `b3981864e`.
  - Storage suites plus the standing tripwire set: **17 files, 419/419**.
  - `tsc` exit 0; eslint 0 errors (25 pre-existing warnings); ratchet `UNCHANGED 959 (Δ 0)`.
  - prettier: code files clean. Both spec docs already fail prettier on main (pre-existing, left alone).
- Rule 4 over the 38 current topic installs (read-only): it accepts the 25 x64 trees and the one with no native packages, and refuses exactly the 10 arm64 and 2 mixed trees.
- Other-family review (Codex CLI): **clear**. One NIT, which needs no change: `platformListAccepts` skips non-string list entries, where npm's `checkList` would throw. That is reachable only with malformed lockfile data npm itself cannot produce.
- PR **#632**.

## 2026-09-11 — /team-build (Phase 2)

- Approved plan: `docs/specs/repository-branch-clones/plan.md`, revision 2 with corrections through rev 2.4. The Phase 2 precondition is met: Phase 1 was merged in #625 and #632, deployed, and set to `NANOCLAW_DEPENDENCY_CACHE=apply` at 2026-09-11 12:25Z. The first apply pass adopted 4, converted 1, with 0 mismatches. A production farm was verified to share inodes with its entry, with a private hidden lockfile.
- Worktree `.claude/worktrees/branch-clones`, branch `feat/repository-branch-clones`, base `04ae8a871` (origin/main). The live checkout is untouched.
- The one definition the plan leaves to this build is the strict completeness rule for link-at-checkout (§5.7.5), defined below once built.

### Builders and integration (2026-09-11)

- **Builders.**
  - H1: host checkout action, lanes, refresh absorb, strict link rule, mode flag and spawn env.
  - H2: storage sweep and worktree cleanup through the lister, plus clone GC.
  - C: container tools and instructions.

  Their reports are leads. Everything below was re-verified by the lead.
- **Strict link rule (§5.7.5), as built** (`checkLinkCompleteness`, `src/dependency-cache.ts`). A package-lock entry absent from the entry's hidden lockfile must be `optional`, and must be excused by one of:
  - (a) its lockfile `os`/`cpu`, or a declared `libc`, exclude linux/`process.arch`/glibc;
  - (b) it declares `os` or `cpu` with no `libc` and is named as a musl build;
  - (c) every entry that requires it, found by node resolution, is itself absent and excused (least fixpoint; a cycle excuses nothing).

  The platform is the agent image: Debian bookworm, glibc 2.36, x64, with no musl loader.
- **Lead fixes at integration.** Each was test-first and failed for the stated reason before the fix.
  1. **Staging moved out of `worktrees/` (security).**
     - The hole: `worktrees/` is mounted read-write into the topic's containers (`container-runner.ts:4386`), so `worktrees/.staging` was agent-writable. A planted `.staging` symlink led the checkout job's crash-residue removal to delete host data.
     - The proof: `stages outside the container-writable worktrees root, so a planted .staging is never followed` deleted `host-data/precious` before the fix.
     - The fix: staging is now `<topic>/checkout-staging/` (`checkoutStagingRoot`), which no container mounts. The host creates `worktrees/` before publishing.
     - Cleanup's `.staging` exclusions are gone. Anything the lister skips in `worktrees/` is reported, and refuses orphan-topic collection as `unknown`.
     - Plan note: rev 2.5 at §5.1.
  2. **A farm link never follows a symlinked package dir.**
     - The hole: on reuse of an existing, container-writable clone, the host linked a farm into a host directory the agent had symlinked in.
     - The proof: `never links a farm into a package dir an existing checkout reaches through a symlink` got farmsLinked 1 before the fix.
     - The fix: `checkoutPackageDirs` keeps only dirs whose realpath is their path inside the checkout.
  3. **Root-level regenerable stores are still swept.**
     - The hole: H2's lister-only walk stopped reclaiming `worktrees/.pnpm-store`, which production topics carry.
     - The fix: `findTopicRegenerableTargets` also takes a real directory with a regenerable name at the worktrees root.
     - The proof: `still sweeps a regenerable store at the worktrees root, beside the checkouts`.
  4. **No edits to upstream-ported mailbox files.**
     - The problem: C added `findRepositoryActionResponse` to `db/messages-in.ts` and to the three `mailbox/` files pinned by `UPSTREAM-MANIFEST.json`, which `mailbox-seam-upstream.test.ts` failed on.
     - The fix: reverted. The tool reads the response with the existing exact-id `getMessageIn`, which opens a fresh handle per call (`mailbox/sqlite/operations.ts:94-101`), and requires `status === 'pending'`.
  5. **`open_pr` keeps its documented contract.**
     - The problem: selecting the checkout by `branch` made `open_pr` fail when no checkout still holds the pushed branch, which is the very case `branch` exists for.
     - The fix: it falls back to the primary checkout as the `gh` cwd. `--head` is the named branch either way.
     - The proof: `open_pr opens the PR for a pushed branch that no checkout holds any more`.
  6. **Import pins.** `mailbox-seam-unreachable-scripts.test.ts` gains `listTopicCheckouts` for storage-manager and worktree-cleanup. Both are pure layout functions from a module those manifests already pin.
- **Decisions.**
  - **The strict rule stays fail-closed on build-script optionals.** H1 measured 36 real trees: Phase 1's rules accept 28 and the strict rule accepts 23. The 13 refusals:
    - 5 arm64 installs missing a linux-x64 binary: correct.
    - 2 trees missing a non-optional package: correct.
    - 6 x64 trees of one repository missing `lzo`. It is optional, has no `os`/`cpu`, and has an install script. It is absent in all 8 trees that lock it, so its source build evidently never succeeds in this image.

    Excusing absent build-script optionals would accept 29 of 36, but it would also excuse a build that failed only transiently. So those checkouts get no shared farm and install their own, and the sweep still dedupes them afterwards. **Re-raise if** clone-mode logs show `link refused … lzo` dominating farm misses.
  - Clone GC gets no `NANOCLAW_STORAGE_GC=apply` gate, the same as the linked path and the plan.
  - `disposability` is an exported seam for the P2-13 spies.
  - `GIT_CEILING_DIRECTORIES` is set on every git question about one checkout.
  - Clone scope `all` includes HEAD.
  - **H1 deviations, accepted:**
    - The flock covers only the steps that read the canonical.
    - Clone hygiene also detaches HEAD and drops the guessed branch and its config.
    - A refusal is an answer: `ok:false`, acked.
    - A transfer tombstone refuses a checkout.
    - `canonical-local` sets no upstream.
    - A network canonical without `origin/HEAD` is an error.
  - **C deviations, accepted:** test-only env overrides for the 120 s/5 s poll, and `CheckoutNotFoundError` to tell "nothing here" from "invalid here".
- **Known risks for review.**
  - **Absorb trusts a clone's remote-tracking refs (plan §5.5).** An agent that forges `refs/remotes/origin/*` in its clone can fast-forward the canonical's copy to an unpushed descendant, and the `--remotes` disposability proof then reads that commit as pushed. The update is fast-forward only, and the canonical's next real fetch force-updates it back.
  - **Path checks on container-writable trees are check-then-use.** For farm links and clone GC, an agent racing the host can still swap a directory between check and use, as with the existing sweep.
  - **Same-thread spawns retry during a checkout.** Holding the lifecycle claim for a whole checkout makes them retry for its duration (`container-runner.ts:1611-1612`).
- **Fresh results at integration.**
  - **Host vitest,** over storage-manager, worktree-cleanup, both repository-workspaces suites, dependency-cache, checkout-mode, container-runner*, ratchet, tripwire, mailbox-seam and host-sweep*: 21 files, 666 of 667 passed. The one failure was the ratchet pin on the CHANGELOG entry. After the accept, `upstream-ratchet.test.ts` passed 17/17.
  - **Container:** `bun test` over git-worktrees, checkout-layout and instruction-fragment-migration: 56/56. `tsc -p container/agent-runner/tsconfig.json` is clean.
  - **Host checks:** `tsc --noEmit` is clean, eslint `--quiet` on changed `src/` reports 0 errors, and prettier is clean.
  - **Ratchet:** growth accepted for `src/container-runner.ts` (+2: the mode env beside `NANOCLAW_WORK_UNIT_KEY`) and `CHANGELOG.md` (+2), leaving Δ 0.
