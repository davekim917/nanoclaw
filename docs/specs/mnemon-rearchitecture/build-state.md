# Build State Checkpoint — mnemon-rearchitecture

Last updated: 2026-04-30T03:15:30Z

## Groups Completed

- **Group A (Foundation)**: validated 2026-04-30T02:38Z. 14/14 vitest tests pass; all A1-A8 ASSERTs verified by grep + test pass.
- **Group B (Container TS)**: validated 2026-04-30T02:55Z. 140 bun tests pass; all B1-B5 ASSERTs verified.
- **Group C (Container docs)**: validated 2026-04-30T02:42Z. All 9 markdown files updated correctly (legacy "mnemon remember" hits in C3 stub negation are expected, not drift).
- **Group D (Host integration)**: validated 2026-04-30T03:07Z after fix loop iteration 1 (writeSessionMessage made async to preserve recall ordering invariant). 411/1todo project tests pass.
- **Group E (Daemon foundation)**: validated 2026-04-30T02:55Z. 15 vitest tests pass; native fetch only (no @anthropic-ai/sdk); Haiku model hardcoded.
- **Group F (Daemon workers)**: validated 2026-04-30T03:09Z after fix loop iteration 1 (test rewrites from source-grep to behavioral). 12 vitest tests pass; F3 sweep interval, container.json re-reads, SIGTERM handler all present.
- **Group G (Operational)**: validated 2026-04-30T03:15Z. All G1-G5 ASSERTs pass; pnpm test 411/0; verify-memory-prereqs.sh exits 0 in current env.

## Groups Remaining

None — all 7 groups complete.

## Decisions Made During Build

1. **Group A blocker**: builder-A reported expected `container-runner.ts:32` import error after deleting `src/modules/mnemon/`. Lead directed isolation-only verification (per-file typecheck + module-scoped vitest) since full project compile is gated on Group D's D1 task.

2. **Group D fix loop iteration 1 (D3 ordering)**: builder-D initially used fire-and-forget `void maybeInjectRecall(...)`, which broke the recall ordering invariant (inbound row got lower seq than recall_context). Lead directed: make `writeSessionMessage` async with internal `await maybeInjectRecall`. The 9 production callers all fire-and-forget so no caller cascade. Builder-D also authorized to update `src/host-core.test.ts` (the only test caller, not in any group's ownership map). Recall now correctly inserts before inbound.

3. **Group F fix loop iteration 1 (F1 test rewrites)**: builder-F initially wrote 5 of 7 classifier tests as source-grep (`expect(src).toContain(...)`). Lead directed full behavioral rewrites with archive.db injection seam (`setArchiveDbForTest`). All 7 tests now exercise actual logic.

4. **Group E spec arithmetic typo**: builder-E correctly identified that `test_recallTopKDistribution_buckets` spec values `{0:2, 1-3:4, 4-5:2, 6+:1}` are arithmetically impossible for 9-element input `[0,0,1,2,3,4,4,5,6]`. Builder updated test expectations to match correct bucket logic. Implementation logic unchanged.

## Escalations

None — all fix loops resolved within iteration 1.

## Known Risks (Accumulated)

- **[K1-K11]** SHOULD-FIX from review carried forward (per plan.md Known Risks section).
- **[K12 — pre-build drift PARTIAL P1]** D2's `extractRecallQueryText` exported with first-turn 500-char cap and follow-up 800-char concatenation of last 3 user-runs (verified in implementation).
- **[K13 — pre-build drift PARTIAL P2]** G3 / F3 don't explicitly write unhealthy health JSON on prereq failure. F3 exits non-zero; that's sufficient.
- **[K14 — Group A residue]** `scripts/mnemon-restore.sh` was NOT in the plan's delete list but is PR #68 debris. QA should consider deleting as a follow-up.
- **[K15 — stale "mnemon-companion" references]** Builder-B noted residual references to "mnemon-companion" in docs/, groups/*/wiki/index.md, container/skills/wiki/SKILL.md, and .context/ — outside Group B's ownership. Stale doc/skill text references but no runtime dependency. Flag for QA cleanup.

## Pre-build drift findings (re-stated for build awareness)

- 3 DIVERGED entries acknowledged in `drift-acks.json`:
  - **B2** — `should-recall.ts` consolidated into `recall-injection.ts` (verified — exports `shouldRecall(text)` directly from recall-injection.ts)
  - **B3** — Memory module barrel `src/modules/memory/index.ts` not created (callers import named exports)
  - **B4** — systemd `Requires=nanoclaw-v2.service ollama.service` (cycle-2 fate-share resolution; G4 created with correct value)
- 2 PARTIAL findings tracked above as K12/K13.

## Build Outcome

- 7/7 groups validated.
- All acceptance criteria met (after 2 fix iterations on D and F).
- 411 host vitest tests pass; 140 container bun tests pass; 0 failures.
- `pnpm run build` clean.
- `bash scripts/verify-memory-prereqs.sh` returns 0.
- 0 cross-group file conflicts.
