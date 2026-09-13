# Source-admission execution record

- Stage: authorized local implementation; no production configuration or activation.
- Base: `7ba62ab5741c7bc788b191600dfe107738394d7f`.
- Worktree: `/tmp/nanoclaw-wiki-source-admission`, branch `codex/wiki-source-admission`.
- Retained owner: native `gpt-6-astra`, requested medium reasoning. Parent dispatched
  these native settings; actual provider metadata beyond native dispatch is unverified.
- Instructions used: current Bootstrap team-plan and shared workflow/review contracts,
  WWBD, supplied AGENTS.md, CONTRIBUTING.md, exact-base review policy. No redelegation.
- User explicitly accepts fresh Astra review despite same-family limitation. Do not
  call that cross-family diversity.
- Prior rejected MCP-only plan counts as corrective round 1 of the shared maximum 3.
  This replacement is repair batch 2, pending independent review; stage changes do not
  reset that budget. No tests are claimed for a planning artifact.
- Authority: root requested investigation and planning artifacts only for this stage.
  Worktree creation first failed on read-only .git; authorized scoped sandbox escalation
  succeeded. Canonical main/dist and the separate user-owned trial were untouched.
- Read primary source: credential resolution/spawn mounts, guarded delivery registry,
  repository action registration/job runner, host Git execution policy, managed wiki
  scan-hook contract, source archive writer, task creation/session identity and paused
  task movement. Private incident/previous plans were treated as leads, not correctness
  evidence. No credentials, environment values or auth files read; no production DB
  access or network mutation.
- Design decision: host constructs candidate from bounded Markdown replacements.
  Removes untrusted Git bundle/config ingestion and per-fact grammar. Host source bodies
  and fresh verifier identity own provenance; a writer-authored receipt is never proof.
- Explicit limitation: public primary documents supported first; archive identity alone
  does not prove human origin, and inaccessible private analytics stay no-source.
- New authority decision: bounded host publication with existing credential plus
  constrained maintenance actors; no source capability expansion.
- Remaining: independent raw-plan review; resolve the concrete authority decision;
  then same-owner implementation, exact-artifact acceptance and implementation review.
- Elapsed time, tokens/cost: unknown from runtime metering; no outcome/savings claim.

## Independent plan review and implementation authority

Reviewed plan SHA256: `9b1ad75c2ade73373fb4f93697ad7213fecbab90f6478c197e043ae4cc0ae09a`.
Fresh native reviewer `/root/astra_review_wiki_admission_replacement`, dispatched
`gpt-6-astra` with medium reasoning. Root validated the native JSON; no CLI schema
enforcement is claimed. Same-family substitution was explicitly user-approved.

Raw verdict:
```json
{"verdict":"approve","summary":"Approve this scoped plan. No material blocking finding is supported by the exact-hash plan and cited source contracts. This was a read-only plan review; implementation enforcement, behavioral controls and production activation remain unverified.","findings":[],"next_steps":["Implement the stated boundaries without expanding source eligibility or maintenance-actor authority; retain the separate authorization requirement for production configuration where existing authority does not cover it.","Before activation, complete the specified real-container capability tests, fresh-model positive and negative source-review controls, crash/replay tests and independent exact-head implementation review."]}
```

Root authorized source implementation and hermetic checks in this isolated worktree,
without commits/publication, actual groups, task moves/resumes, live database/config
writes, credential assignments, real wiki publication or lifecycle actions. Initial
implementation does not itself consume a corrective round. Qodo configuration remains
absent; no Qodo rules could be loaded and no credential setup is requested.

## Correction record

- Round 3: repaired the new logger mock, test-only optional-path narrowing, and
  explicit sweep registration/count/one-line budget accounting. Retained the complete
  inventory assertion. Also made publication-notice failure explicit in the receipt
  and checked that the pinned ref remains the remote default. Verification: 104/104
  focused candidate, policy, guarded-delivery and sweep-registry tests passed.
- Additional original acceptance coverage passed 93/93 tests: actual restricted mount
  construction, primary-fetch transport checks, the shipped secret-scan hook, candidate
  engine and policy tests. This was hermetic; no actual maintenance container/model ran.
- Root explicitly authorized one additional mechanical round (4), without resetting
  the prior count: the new Bun test queried processing_ack in inbound rather than
  outbound. Source proof: runner db/messages-in.ts:113 delegates markCompleted to the
  mailbox; mailbox/sqlite/operations.ts:62 writes processing_ack through outbound.
  The correction changes the DB selector, retaining all request/action/response and
  acknowledgement assertions. This extension covers deterministic validation and
  measured-floor recording only; another substantive failure requires a freeze.

The detached acknowledgement defect was concrete: the baseline GuardedDeliveryHandler
and runGuarded declarations promised void (src/delivery-guard.ts:21, :59), and the final
await discarded a handler's deferAck result (:92). getDeliveryAction returned that
wrapper to handleSystemAction, whose caller acknowledges unless deferAck survives.
The implementation propagates the result without changing ordinary allow/deny/hold
semantics. All four paths are covered by src/delivery-guard.test.ts; this is not a
general dispatch refactor.

## Round 4 validation and mandatory source freeze

The mechanical outbound selector correction passed the real in-memory runner
transport test: `bun test src/mcp-tools/wiki-admission.test.ts --coverage
--coverage-reporter=lcov` returned 1 pass, 0 fail, 4 assertions. The root's corrected
schema citation is mailbox/sqlite/connection.ts:223 for the outbound database and
:239 for processing_ack; operations.ts:110 reads those acknowledgements.
Runner TypeScript validation returned exit 0. Host TypeScript validation and scoped
ESLint returned exit 0 (ESLint still reports nonblocking catch-all warnings).
`git diff --check` returned exit 0.

The final focused host coverage run passed 50/50 tests across engine, policy,
sources and delivery-guard. Measured aggregate: statements 87.29%, branches 80.64%,
functions 95.89%, lines 91.27%. This is NOT whole-integration coverage. Per-file
branch measurements: delivery-guard 75%, engine 76.84%, git 76.56%, policy 88.6%,
runtime 52.38%, sources 100%, store 77.77%. No new enforced coverage floor was
installed before the freeze; existing risk-floor compliance remains unverified.

A subsequent read-only-in-production, hermetic temporary-database probe confirmed
a substantive recovery liveness defect. CandidateStore.recoverable at
src/wiki-admission/store.ts:97-102 always selects the oldest 16 nonterminal rows,
including uncertain rows whose two publication attempts are exhausted.
WikiAdmission.promote at src/wiki-admission/engine.ts:209 leaves those rows unchanged
when the remote still equals the candidate base. recover at :231-240 therefore
never reaches a newer accepted row behind 16 such rows.

The probe used the real CandidateStore and WikiAdmission with a temporary SQLite
database and fake local Git effects (no network, credentials, or live databases).
It inserted 16 older uncertain/attempts=2 rows and one newer accepted/attempts=0
row, all with matching policy, bound acceptance and immutable-input digests, then
called recover twice. Exact output:
```json
{"recoveryPasses":2,"remoteReads":32,"pushes":0,"newerCandidateState":"accepted","selectedCount":16,"selectedLast":"candidate-15","temporaryEvidenceRoot":"/tmp/wiki-recovery-probe-sVtyjS"}
```
The temporary evidence database remains at that path. This is a confirmed local
implementation defect, not evidence of a production incident. Source is frozen
without a behavior correction, as required by the explicit round-4 stop condition.
No round has been reset or hidden. The implementation is NOT ready for activation.

Remaining before completion: correct and regress recovery fairness under renewed
bounded direction; integrate/measure risk coverage floors and regenerate the
upstream divergence ratchet; complete independent exact-artifact implementation
review. Real-container capability checks and fresh-model positive/negative semantic
controls remain unrun. Production enrollment, new host publication boundary and
activation still require the unresolved authority; no live change was made.

## Round 5: bounded review-class correction, then freeze

Root reported the independent unchanged-artifact review of `3785ecb6...` as
`needs-attention`, with three cohesive classes: recovery/state/deadline handling,
policy-failure isolation, and invalid verifier responses. The retained owner read
the exact sources and accepted all three. The raw reviewer JSON remains with root;
this paragraph records its communicated disposition, not an invented raw verdict.

Root explicitly authorized ONE correction round 5 for classes 1 and 3 only. Prior
round count 4 remains recorded. Class 2 remains frozen pending the scope/design
decision: no roster, marker shortcut, identity persistence or fail-open policy
handling was added. No production or publication authority was added. The owner
remained the same native Astra/medium session without delegation. Current team-build
and shared workflow instructions were read. Qodo configuration is still absent;
no Qodo rules were loaded and no credentials or setup were accessed.

Changes are limited to engine.ts, store.ts, engine.test.ts and the recovery result
logging in modules/wiki-admission/index.ts, plus this record:

- The existing candidate database now holds one recovery cursor row. Selection
  advances it transactionally before IO and wraps in bounded 16-row batches; reopening
  the store retains progress. Candidate identity/state columns are unchanged. Creating
  the cursor table is additive and accepts an existing candidate database unchanged.
- Each recovery candidate has an isolated failure boundary; the engine returns a
  failure count and the module logs a bounded host warning. Invalid policy/artifact/
  receipt rows cannot abort processing of later rows. Unknown outcomes remain
  recoverable. Exhausted attempts become terminal rejected only after the existing
  identity/artifact checks and remote equality with base establish the known outcome;
  exact remote-head success and moved-base handling remain ahead of this branch.
- The 30-minute candidate deadline is enforced before submission preparation, again
  before sealing after asynchronous preparation, and before verifier acceptance.
  Expiry no longer depends on a successful sweep. It clears verification input and
  produces no publication or human notice.
- Accept requires a nonblank string reason of at most 2048 characters and the existing
  complete response bindings/coverage. Source-ID values/counts are also bounded.
  Invalid reasons are rejected rather than truncated into an accepted receipt.

Verification:

1. Initial focused engine run: 44/44 passed, exit 0.
2. Final command:
   `pnpm exec vitest run src/wiki-admission/engine.test.ts src/wiki-admission/policy.test.ts src/wiki-admission/sources.test.ts src/delivery-guard.test.ts src/host-sweep-registry.test.ts --maxWorkers=1 --coverage --coverage.include='src/wiki-admission/*.ts' --coverage.include='src/delivery-guard.ts' --coverage.reporter=json-summary --coverage.reporter=text-summary`
   returned 140/140 tests across five files, exit 0. This includes 20 exhausted,
   unreachable, obsolete-policy, invalid-artifact and invalid-receipt candidates
   before an eligible candidate; store reopen; failed review delivery; expired work
   behind an invalid candidate; old-database cursor initialization; deadline boundary
   and months-late verdicts without a sweep; expiry during asynchronous preparation;
   malformed reasons and response fields with zero push calls; a valid 2048-character
   reason; and the earlier exact-tree/lease/crash/secret-scanner controls.
   Sweep-registry fixtures emitted expected diagnostic warnings about uninitialized
   test databases; the suite passed. No production database was opened for these tests.
3. `pnpm exec tsc --noEmit --pretty false`, scoped ESLint `--quiet` on the four changed
   TypeScript files, and `git diff --check` returned exit 0 after final test edits.
4. Focused coverage: statements 89%, branches 82.97%, functions 96.05%, lines 92.62%.
   These are measurements, not an installed risk floor or whole-integration proof.
5. SHA256 checks confirm policy.ts, container-runner.ts and delivery.ts are unchanged
   from the prior frozen artifact; the approved plan remains
   `9b1ad75c2ade73373fb4f93697ad7213fecbab90f6478c197e043ae4cc0ae09a`.

Round 5 is now frozen for independent affected-surface review. Class 2 is still an
accepted unresolved finding, so the task is not complete or activation-ready.
Risk-floor integration, ratchet regeneration, real-container capability checks,
fresh-model positive/negative semantic controls, and the explicit production boundary
decision remain outstanding. Nothing was committed, pushed, enrolled, resumed or
activated. No new substantive test failure occurred in this bounded correction.

## User-approved identity revision (round 6; no count reset)

After the independent delta review approved classes 1/3 at `1c80beec...`, the user
explicitly approved a separate host-owned durable actor identity record and the
restricted publisher using existing GitHub capability, enabled only after review and
testing. Root authorized the retained owner to implement this revision locally.
Production enrollment, tasks, credentials, publication and restart remain excluded.
This is the newly authorized class-2 design correction, recorded as round 6 rather
than resetting or hiding the previous five rounds.

The same isolated worktree was fast-forward rebased with autostash onto
`96ce72e8e2caac007fb1521040f237d07d3cb8ad`; Git reapplied the patch successfully.
The sandboxed first attempt could not autostash; the permitted escalated retry
succeeded. No authored commit or remote mutation was made. Main's independently
merged frontier changes remain in the worktree, including both overlapping files
(container-runner.ts and provider-surfaces.test.ts). The updated review policy was
read in full before editing. The approved plan is now revised to record the new
identity authority and conservative failure contract; the old plan hash remains
historical evidence, not approval of these new bytes.

The existing restricted publisher remains the sole publication implementation;
there is no second writer. All its policy reads now require both durable identity
and publication records, bound into the candidate policy digest. Ordinary groups
are classified from identity before parsing publication policy. Listed/retired
actors remain restricted when policy or their marker disappears. Invalid identity
itself fails closed because safe classification is then unknown; it is not silently
reconstructed from policy/markers. No identity file is created on the live host.

Round-6 checks and disposition:

- `pnpm exec vitest run src/wiki-admission/policy.test.ts src/wiki-admission/engine.test.ts src/provider-surfaces.test.ts src/delivery.test.ts --maxWorkers=1 --silent`:
  188/188 passed. These exercise real ordinary delivery and real mount construction
  with malformed publication policy, deny listed actors with missing markers, and
  validate missing/malformed/symlinked identities, retained actor IDs, and publication
  digest binding. The logger writes directly, so `--silent` did not suppress fixture
  diagnostics; no actual production state was involved.
- Added the module integration test through the actual registered action with real
  policy/identity readers, real candidate SQLite and real admission engine. Git,
  credential resolution, group/session transport and delivery are mocked. Its two
  controls verify accepted exact-head publication through the existing host credential
  callback and identity revocation before credential resolution. Credentials never
  enter the mocked agent response stream. This is not a live credential/model test.
- Final focused coverage command adds `src/modules/wiki-admission/index.test.ts` to
  engine/policy/sources/delivery-guard/provider-surfaces/host-sweep-registry tests,
  with `--maxWorkers=1 --coverage --coverage.include='src/wiki-admission/*.ts'
  --coverage.include='src/delivery-guard.ts'
  --coverage.include='src/modules/wiki-admission/index.ts'
  --coverage.reporter=json-summary --coverage.reporter=text-summary`:
  199/199 passed, seven files. Aggregate: statements 87.75%, branches 83.94%,
  functions 93.2%, lines 92.75%. Existing sweep fixtures emit expected diagnostics.
- `bun test src/mcp-tools/wiki-admission.test.ts --coverage --coverage-reporter=lcov`
  in the runner: 1 pass, 0 fail, 4 assertions; 63/67 measured lines (94.03%).
- Host and separate runner TypeScript checks exited 0. Scoped ESLint `--quiet` for
  admission source/tests and affected delivery/mount tests exited 0. `git diff --check`
  exited 0. No full production-host suite or dependency installation was run.
- Recorded measured floors only for the eight new risky files, and raised the
  previously untested delivery-guard floor to its measured 100%. Existing unrelated
  floors are unchanged. Added floors: module 83, engine 95.7, git 90.5, policy 90.3,
  runtime 96.2, sources 100, store 96.4, runner transport 94. The existing coverage
  checker exports parsed the focused host/Bun reports and evaluated these nine paths:
  passed=true, failures=[]. This is a narrow floor check, not a full CI coverage result.
- Regenerated the upstream ratchet with explicit accepts for the ten measured growth
  paths: .github/labeler.yml, runner mcp-tools/index.ts, container-config.ts,
  container-runner.ts, delivery-guard.ts, delivery.test.ts, delivery.ts, host-sweep.ts,
  modules/index.ts, provider-surfaces.test.ts. The growth is the scoped maintenance
  profile, protocol registration, deferred acknowledgements, risk labels and their
  regression tests; no unrelated frontier change was reaccepted. The initial report
  correctly refused unrecorded growth. After regeneration the report exited 0 with
  zero delta, no blocking/unaccepted paths; upstream-ratchet.test.ts passed 17/17.
- SHA256 verifies the reviewed class-1/3 engine.ts and store.ts bytes are unchanged
  from `1c80beec...`; only their test coverage was expanded. The Git implementation
  also remains unchanged. Rebase preserved the newer main worker definitions and
  provider-surface assertions rather than copying back the old baseline.

The source is frozen for independent review of the revised plan and complete artifact.
No remaining accepted class-2 defect is asserted fixed in production: local controls
pass, but actual maintenance containers, model semantics, host credential access and
live activation remain unverified. Full CI coverage remains required. No commit,
push, PR, live enrollment/config/task/credential write, wiki publication or restart
was performed. The user-approved publication design does not itself authorize those
excluded operations in this implementation turn.

Additional target assessment: the host publisher uses a fresh host-only repository
and its own explicit helper, not a workgroup agent's URL-scoped helper. A separately
owned repository can therefore be the exact registered target without widening any
agent's general GitHub scope, provided the existing host-resolved credential has
access to that exact target. This must be verified separately; access reported for
a group's collaborator credential does not establish the host resolver's identity.
The current policy supports ONE repository/series at a time. Simultaneous second-wiki
enrollment is not implemented and must not silently replace the first wiki's policy.
Private target names/URLs are deliberately excluded from this public-source record.

## Round 7: pre-dispatch revocation race

Independent final review found a high-severity race: credentials were awaited after
the engine's last authority check, allowing revoked publication authority to reach
the push subprocess. Root authorized one narrow correction at the existing Git/engine
boundary, preserving all production holds and prior round counts.

WikiGit.push now requires an authority callback. After credential resolution and
command/environment construction, WikiGit invokes it synchronously immediately before
execFile (git.ts:75-81), with no intervening await. The engine supplies the callback
from its one promote path (engine.ts:238-242), reloading the combined identity/policy
digest and origin via assertCurrent and checking both the expected ref and the Git
instance's exact origin/ref. Thus verdict-driven publication and recovery share the
same final check. Missing authority callback is refused. No new publisher or config
was introduced; the module integration test double now honors this callback contract.

The real-Git regression pauses the second remote credential resolution (the first
reads the remote head, the second would launch push), changes one of durable actor
identity, publication-policy presence, origin or ref, then releases credentials.
Both verdict and recovery entry points are exercised: eight cases total. The test
wraps actual execFile and asserts ZERO push subprocess invocations, unchanged local
bare-remote head and no publication notice. Candidate outcome remains fail-closed
and recoverable, never falsely published. All repositories, credentials and identity
files in this test are disposable synthetic fixtures.

Verification: initial engine/module integration run passed 55/55. Final seven-file
focused coverage command (same scope/options as round 6) passed 201/201, exit 0.
Coverage measured lines 92.64%, branches 83.88%, statements 87.54%, functions 93.26%.
Host and runner typechecks, scoped ESLint --quiet and git diff --check exited 0.
The upstream ratchet report remains zero delta with no blocking paths; no regeneration
was needed because only fork-owned implementation/test files changed. Independent
review and real production/model/container controls remain required before activation.
No commit, PR, config, credential, task, publication or lifecycle mutation occurred.

The first narrow floor comparison identified engine line coverage 95.00% versus its
95.7 floor (a 0.7-point regression), despite passing tests. Added two direct rejection
controls for a Git instance whose origin/ref differs from the accepted target; no
production behavior or coverage floor was weakened. Final focused run: 203/203,
lines 92.87%, branches 84.12%, statements 87.74%, functions 93.26%. Final host typecheck,
scoped lint and whitespace validation again exited 0. This is the same bounded round,
not a reset or a new product change. The final nine-path floor comparison returned
passed=true with no failures; all floors are unchanged. Freeze follows these final
artifact checks.

## Target-workgroup activation correction

The requested target workgroup has an ordinary workgroup-level OneCLI roster. The
restricted runtime does not apply OneCLI: its dedicated Docker-argument branch builds
only the explicitly allowed model-authentication environment and returns before the
ordinary gateway configuration (`src/container-runner.ts:6019-6065`). Rejecting an
actor merely because that target roster exists would therefore make the approved
restricted publisher impossible to enroll while adding no protection.

The enrollment-time rejection was removed. The mount regression now sets a non-empty
workgroup roster and proves the wiki actor still receives the same isolated mount set;
the existing runtime-environment controls continue to reject proxy and GitHub credential
variables. This does not give the maintenance actor OneCLI access: it corrects a false
configuration precondition in a path that bypasses OneCLI by construction. Production
enrollment, credential access verification, task movement and live publication remain
separate post-merge controls.
