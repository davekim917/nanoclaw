# Observatory Signal execution

## 2026-09-05 — grounding
- User selected Signal and authorized full build with real-data end-to-end verification through persistent goal.
- Previous turn was design selection/intent only; this turn creates isolated authoritative implementation worktree and grounded plan.
- Worktree `/tmp/observatory-signal-build`, branch `feat/observatory-signal`, base `1c11776c6`; host main initially clean. Worktree creation required sandbox escalation and was automatically approved.
- Reused installed dependency trees via symlinks; no installs or service changes.
- Read CONTRIBUTING, current frontend entry/console/API/SSE, dashboard route/auth registration, approval primitive and DB driver boundaries. Backend investigation by Astra Medium independently checked source/live release data.
- Critical gap: non-PR human decisions are absent from the thread attention producer despite existing in real release-state. Preserve them in the new decision inbox.
- Review model policy: user explicitly requires Astra Medium for all orchestration, overriding skill cross-family requirement. Coverage will be same-family independent; no model substitutions.
- No live data mutations, agent messages, commits, builds into live dist or restarts performed.

## Plan review and build start
Independent Astra Medium review found four material gaps: workgroup scope predicate, material evidence identity, persisted project management, atomic history/dispatch recovery. Accepted all four after tracing to current sources. Normative implementation contract appended to plan with explicit predicates, endpoints/shared types, row-local atomic history and durable dispatch reservation. User's explicit full-build goal authorizes implementation without a further ceremony-only permission stop. Same-family review coverage is intentional under the user's model pin.

## Baseline regression evidence
- `gh pr list --repo nanocoai/nanoclaw --search observatory --json number,title,url` and matching issue search returned no open matches.
- `pnpm exec vitest run src/dashboard/thread-message.test.ts src/dashboard/auth/compute-scopes.test.ts src/dashboard/observatory-steer.test.ts src/db/raw-db-ratchet.test.ts`: 4 files, 52 tests passed (9.27s); log `/tmp/observatory-signal-regression.log`. Includes fresh additive migration path while backend work is in progress. This is baseline regression evidence, not full Signal acceptance.
- Parallel exclusive write sets: backend `src/dashboard/observatory-v2`, migration and registration; frontend `dashboard`; verification `scripts/observatory-signal-*`. All workers Astra Medium. Lead owns plan/run and convergence.

## Integration findings and corrections in progress
- Lead source review found question envelopes store `kind=chat-sdk`, `content.type=ask_question`; transcript helper sorts newest-first. Backend corrected exact mailbox question identity rather than matching a nonexistent kind or reversing to oldest question.
- Real-data preview initially returned zero release items. Authoritative the shared workgroup file has 49 items / 38 human-next; legacy scene reader only checked per-agent folders that no longer contain it. Backend added canonical configured release-source resolution with containment and regression coverage.
- Lead flagged material hash including freshness metadata, invalid timestamps reading available, board channel names mismatching canonical thread keys, source-disappearance history and invisible release-review control. Backend/frontend corrections underway.
- Independent implementation reviewer found failed-delivery retry was not CAS-locked before IO and concurrent slower failure could downgrade sent. Also separated definite failed retries (require fresh evidence) from uncertain pending reconciliation (immutable old delivery). Findings accepted against actual dispatch code; regression tests being added.
- First browser pass exercised six views at desktop/mobile without overflow or console errors, but captured premature evidence loading and pre-fix release source data. Not accepted as final visual/source completeness proof. Repeat after stable build.
- Preview uses isolated central online backup, GET-only adapter, and scoped live runtime observation from authenticated localhost API. Production cookie remains in memory only. It does not prove new production API activation or live central refresh; isolated HTTP mutation suite is being added separately.

## Real-data and HTTP evidence
- Browser preview source parity now confirms all 38 human-next the shared workgroup release IDs from canonical 49-item board; total 53 decision records (38 release, 13 approval, 2 thread). Seven visible workgroups, 24 agents, three exact repository mappings plus seven unmapped buckets. Snapshot mapping covers 30 release items; 19 remain explicitly unmapped. No invented goals.
- Latest browser pass across six desktop/mobile views reports no overflow, missing navigation, console errors, failed requests or unfinished loading views. This precedes final timezone/scheduled-runtime refinements and is not final completion audit.
- Isolated HTTP E2E passes with real signed cookie scopes and CAS persistence: unauthenticated401, wrong-origin403, member write denial, cross-workgroup concealment, two-reviewer claim race, shared ownership reload, answer without dispatch, crash-after-send/retry exactly once, project persistence/revision conflict, material evidence change409 and retained prior note. Only downstream transport and source fixtures are fake; no live mutations.
- Host build's first attempt failed script response typing while the HTTP test was being authored; script author fixed types and reports fresh script typecheck pass. Full host build will be rerun after stable edits.
- Upstream ratchet reports exactly +2 lines in migration registry for the additive Signal schema. Accepted that bounded growth for migration import/registration; no unrelated upstream changes. Preserve this reason in any future PR description.

## Coverage and final-build work
- Canonical source parity verified: 38/38 human board IDs, no missing/extra. Latest stable pre-pagination capture uses bundle `index-mUXi19xz.js`, exposes UTC and eight agents with real next scheduled records. All six views at both viewport sizes pass loaded-state/navigation/overflow/console/request checks. Exact off-window thread route returns real evidence.
- Added source pagination with no arbitrary active-thread date cutoff; frontend load-more integration and refresh tests ongoing. This closes the earlier inaccessible-overview-limit gap rather than merely labelling it partial.
- Delivery review identified both overlapping-order permutations. Backend now preserves pending uncertainty for any non-202 after reservation and never downgrades sent, with tests for original-failure-first and retry-failure-first. Actual denied role, revoked recipient and wrong-owner tests cover missing-source reconciliation.
- Scoped lint found one real no-useless-assignment error in backend and expected failure-boundary warnings; backend owner correcting. Full host build handle97627 remains running at typecheck, observed with write_stdin; no restart assumed from slow output.
- Verification scripts now pass eslint (zero warnings/errors), scripts typecheck and isolated HTTP E2E. Production remains unchanged; no completion claim yet.
- Backend source stable 2026-09-05T20:13:33.844Z; post-fix API/state/existing-thread regression 145 passed, host tsc clean. Scoped lint zero errors,18 warnings (12 preexisting threads,6 intentional failure boundaries), no blanket suppression.
- Frontend latest bundle `index-D9Igbump.js` built successfully;19 targeted Signal/SSE tests cover burst coalescing, pre-mount connection, reconnect,30second refresh/failure, paging/reset and exact off-page selection.
- Superseded full build97627 intentionally interrupted (exit130) after source revisions completed; it began against changing source and without local dirty-build flags, so could not provide final artifact evidence. Started final isolated build with documented BUILD_ALLOW_DIRTY=1 BUILD_ALLOW_LOCAL=1 (per check-build-clean.ts sanctioned local preview path), preserving all typecheck/lint gates. No production build/restart.
- Independent final narrow review clear: universal pending/non202, terminal sent, both overlap permutations, retained authority during missing-source reconciliation and exact selection highlight verified. Fresh API/state21tests pass. Same-family coverage under explicit Astra Medium pin.
- Real-data paging API evidence: the shared workgroup thread_limit1 offsets0 and1 both200, has_more true, next_offset1/2, distinct exact thread IDs. Final browser run targets D9Igbump; preview snapshot20:15:50Z, process handle58591, browser30311. Full final host build handle97118 still in progress.

- Final dashboard suite:25files/395tests pass on stable source. Final D9Igbump real-data browser:12screens across6views, no overflow/console/HTTP/loading errors. Latest snapshot54decisions=38release+13approval+3questions; canonical IDs38/38 exact. Real paging browser1->2->1 validates load more then refresh.
- Host build97118 passed typecheck/lint then stopped at sandbox read-only shared FETCH_HEAD; rerun75309 approved with same local flags and all gates. This is an environment restriction, not an application compile failure.
- Final evidence limitations: preview is authenticated GET-only on localhost4318; production not activated. Mutations verified through isolated authenticated HTTP and component suites, not live approvals or messages. Preview SSE only confirms connection; coalescing/reconnect and filesystem polling use behavioral tests. Latest100activity is intentionally bounded; historical threads use pagination and coverage indicators.

- Final full host build75309 PASS(exit0): mandatory host/scripts typecheck and lint gates, TypeScript emission, SPA build, postbuild source-fingerprint verification and BUILD_INFO stamp completed. Source remains an intentional dirty local build at1c11776c6; origin/main has advanced to3f4f97d, so this is not publication or production integration evidence.
- Build-and-test deliverable complete: working real-data Signal preview on host localhost4318 plus twelve actual rendered screenshots and reusable isolated mutation harness. Production activation, merge/push and fleet restart are separate and remain unperformed.

## Production activation — 2026-09-05
- User explicitly authorized activation and withdrew the requested shared password change; existing per-user authentication and roles are preserved.
- Integrated onto current host HEAD1d5443fce008779bc839d11bcdd0d58d069bdfdf in /tmp/observatory-signal-activate, retaining concurrent host changes. Full build exit0, mandatory typecheck/lint/postbuild gates pass, backend208/dashboard395tests pass. Independent scope review38tests pass.
- Verified all35deployed source files against SHA256manifest before recording this note. Source remains local and uncommitted; no push/PR.
- Online central DB plus previous dist backup at /tmp/observatory-signal-rollback-1788642423964. Atomic dist switch state and old-dist path in /tmp/observatory-signal-deploy-state.json. Additive migration072 applied successfully.
- Service active/running MainPID1453891, start2026-09-05T21:13:15Z. Fresh OneCLI preflight succeeded. Public canonical URL the configured `/observatory/` URL.
- Production public and localhost scope proof passed: Owner7workgroups; existing Scoped reviewer scoped-admin and Member member onlythe shared workgroup; private workgroup aggregate0agents/decisions/projects; known private workgroup decision/thread404; unauthenticated401. No auth/role/password changes, no live decision or agent-message mutations.
- Final public desktop/mobile browser verification and source-backed project initialization in progress; evidence under /tmp/observatory-signal-evidence/live*.

- Final LIVE verification passed: public desktop/mobile all6views for Two authorized reviewers (24screens), no overflow/loading/console/API errors; pre-existing favicon.ico404 only. Owner7workgroups24agents54decisions; Scoped reviewer1workgroup6agents50decisions. Canonical human release IDs38/38 exact.
- Initialized exactly3missing source-backed repository mappings through authenticated owner PUT; allrevision1. Fixed initializer-only ID normalization (repository_<hash>, matching API validation); initial invalid colon ID returned400 with no write. Existing roles/passwords/decisions unchanged.
- Startup worktree cleanup blocked event-loop requests temporarily; unchanged pre-existing sync git scanning, confirmed pass complete2026-09-05T21:20:35.205Z examined300. Live browser verification passed afterward without another restart.
- Old localhost4318preview stopped; production is canonical. Evidence /tmp/observatory-signal-evidence/live-verification-summary.json and live-source-parity.json; public/local scope reports and both browser reports retained.
- Concurrent host main update26c0e8216 discarded tracked uncommitted Signal source during verification while live1d5443build stayed running. Restored Signal tracked patch cleanly on newer main and regenerated ratchet, preserving concurrent changes. Exact activated source is being preserved as a local feature commit in the isolated activation worktree; no remote publication.
