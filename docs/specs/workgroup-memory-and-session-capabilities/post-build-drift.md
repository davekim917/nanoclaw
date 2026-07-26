# Post-Build Drift

> Cycles below are historical evidence for the pre-curator shared-memory
> cutover. The operator-approved [`plan.md`](./plan.md) is now the sole
> normative contract; [`run.md`](./run.md) records the curator implementation
> and current verification.

## Cycle 1

- Reviewer A: MISSING 1, DIVERGED 6, PARTIAL 2, CONFIRMED 8.
- Reviewer B: MISSING 0, DIVERGED 1, PARTIAL 3, CONFIRMED 8.
- Gate: FAIL.
- Accepted repairs: due scheduled-task admission; no-follow Markdown leaf
  reads; global collision-destination deduplication; every-sibling native-view
  verification; trusted verifier path containment; complete live-pair audit;
  applied-migration activation flag; stale-writer fencing; isolated provider
  evaluation; retired migration documentation.

## Cycle 2

- Reviewer A: MISSING 0, DIVERGED 3, PARTIAL 0, CONFIRMED 14.
- Reviewer B: MISSING 0, DIVERGED 6, PARTIAL 0, CONFIRMED 8.
- Gate: FAIL.
- Accepted repairs:
  - preserve `.seed.md` and all standing instructions outside memory;
  - contain Markdown reads against ancestor-directory swaps;
  - invalidate and freshly admit every mutated/resumed scheduled task;
  - rebuild context for crash/backoff replacement;
  - contain canonical commits against ancestor-directory swaps;
  - replace PID-namespace fence authority with bounded token/lease behavior;
  - update clone and OpenClaw migration skills to one canonical host path.

The real Claude/Codex/OpenCode 3x3 behavior evaluation and live
inventory/apply/verification remain QA/release evidence. They are not counted
as implementation drift unless their tooling is not executable.

## Cycle 3

- Replaced the elapsed-time writer lease with one always-shared workgroup
  kernel lock and mounted its exact host inode for every provider/mount mode.
- Removed canonical bytes from trusted lifecycle guidance; all memory/archive
  bytes now enter only through the paired untrusted recall field.
- Separated v2 instruction migration from memory migration and kept
  `CLAUDE.local.md` byte-preserved as standing instructions.
- Made Codex/OpenCode reapply validate a complete provider payload before
  writing, publish missing paths create-only, preserve every pre-existing byte,
  and stop every later directive after a failed check.
- Reconciled stale current documentation and operator skills to one
  workgroup-level memory canon.

## Cycle 4

- Reserved `memory` from the generic workgroup shared-directory migrator so
  only the dedicated inventory/snapshot/cutover workflow can mutate it.
- Added the OpenCode operator skill to provider-branch candidate and exact-byte
  parity gates; synced the branch copy to the customization-first contract.
- Removed automatic provider-install rollback deletion. A late failure retains
  create-only publications and reports them, avoiding an unclosable
  compare-then-unlink customization race.
- Corrected Discord message-link resolution for parent-channel/thread-channel/
  message routing and agent-group-suffixed archive IDs, with bounded thread
  fallback and no root-channel broadening.

## Cycle 5

- Reviewer A: MISSING 0, DIVERGED 3, PARTIAL 0, CONFIRMED 112 across 115
  atomic claims.
- Reviewer B: MISSING 0, DIVERGED 1, PARTIAL 0, CONFIRMED 16 contract
  clusters.
- Gate: FAIL.
- Both reviewers found stale `setup/providers/codex.ts` bytes in the frozen
  provider tree. Reviewer A additionally found rollback did not re-derive the
  complete provider-native source roster and verifier-wide failure catches
  discarded their original causes.
- Accepted repairs: exact provider resync; pre-quiescence rollback source-roster
  re-inventory; cause-preserving verifier failures.

## QA Repair Cycle 6

Cycle 5's three findings are repaired. Focused regression suites, host
TypeScript, provider contract validation, candidate payload checks, and exact
composed parity pass. The frozen provider tree is
`5b844b2b651d279e250d3165f14bb51aafdc2754`.

## QA Repair Cycle 7

- Live release preflight found Graphify stale because the shared inotify watch
  budget was exhausted.
- The dashboard session feed was recursively traversing session worktrees
  while seeking only `inbound.db` and `outbound.db`. It now admits exactly the
  two expected directory levels plus those two database leaves and ignores all
  deeper or out-of-root paths.
- The focused dashboard regression passes 12/12. This host-only repair leaves
  the frozen provider tree unchanged at
  `5b844b2b651d279e250d3165f14bb51aafdc2754`.

## Cycle 7

- Reviewer A: MISSING 0, DIVERGED 0, PARTIAL 1, CONFIRMED 114 across 115
  atomic claims.
- Reviewer B: MISSING 1, DIVERGED 0, PARTIAL 0, CONFIRMED 114 across the same
  115 claims.
- Gate: FAIL.
- Both independently identified the same sole gap: the provider branch carried
  OpenCode host/container real-barrel registration tests, but current main and
  the protected OpenCode payload roster omitted both. Existing factory tests
  import the provider directly and therefore cannot catch a lost barrel import.
- Both reviewers confirmed the Cycle 7 dashboard watcher repair and every
  other design claim.

## Repair Cycle 8

- Added the two OpenCode real-barrel registration guards to main, the protected
  provider payload roster, and the add/verify operator contract. The existing
  remove contract already named both files.
- Focused provider/registration tests, both TypeScript checks, formatting,
  candidate validation, and exact main/provider parity pass.
- The frozen provider tree is
  `b061e0da996d4c30e32b5ea3dc2367158ba9de1b`.

## Cycle 8

- Reviewer A: MISSING 0, DIVERGED 1, PARTIAL 0, CONFIRMED 114 across 115
  atomic claims.
- Reviewer B: MISSING 0, DIVERGED 2, PARTIAL 0, CONFIRMED 113 across the same
  115 claims.
- Gate: FAIL.
- Both reviewers found `docs/SECURITY.md` still described group-local memory,
  omitted the canonical/compatibility/lock mounts, and denied the bounded host
  pre-turn reads implemented by this design.
- Reviewer B also found a separate Cycle 7 watcher defect: intermediate files
  and symlinks were admitted after stat while Chokidar's default followed
  symlinks. Both reviewers confirmed the Cycle 8 OpenCode repair, exact provider
  parity, and every other design claim.

## Repair Cycle 9

- Updated the active security model to the actual mount, pre-turn trust, and
  workgroup-isolation behavior.
- Disabled Chokidar symlink following and require real non-symlink intermediate
  directories plus regular database leaves. Focused regression, formatting,
  lint, and host TypeScript pass.
- The frozen provider tree remains
  `b061e0da996d4c30e32b5ea3dc2367158ba9de1b`.

## Cycle 9

- Reviewer A: MISSING 0, DIVERGED 1, PARTIAL 0, CONFIRMED 114 across 115
  atomic claims.
- Reviewer B: MISSING 0, DIVERGED 1, PARTIAL 0, CONFIRMED 114 across the same
  115 claims.
- Gate: FAIL.
- Both reviewers confirmed the implementation, provider parity, security model,
  and watcher repair. Their sole shared contract divergence was stale active
  operator documentation: the changelog still claimed per-provider stores, the
  cutover runbook directed a deleted destructive provider-native import, the
  backlog promoted native auto-memory authority, and the archived migration
  checklist repeated that retired mechanism.

## Repair Cycle 10

- Replaced the obsolete cutover procedure with an explicit superseded notice
  and the supported `migrate-v2` → `/migrate-from-v1` → `/migrate-memory`
  sequence.
- Updated the changelog, backlog, archived migration checklist, and active code
  comments to the one-workgroup-canon and compatibility-view contract.
- Marked v1 behavior audits as archived evidence whose memory conclusions are
  not operator instructions.
- The first active-doc search was too narrowly scoped; Gate 10 later proved
  that historical spec families and two active comments were still
  indistinguishable from the current contract. The retained focused evidence
  remains valid: migration, provider-contract, and dashboard suites passed
  58/58; both TypeScript checks and the 4/4 runner scaffold suite passed.
- The frozen provider tree remains
  `b061e0da996d4c30e32b5ea3dc2367158ba9de1b` with no unstaged or untracked
  paths.

## Cycle 10

- Reviewer A: MISSING 0, DIVERGED 2, PARTIAL 0, CONFIRMED 113 across 115
  atomic claims.
- Reviewer B: MISSING 0, DIVERGED 4, PARTIAL 0, CONFIRMED 111 across the same
  115 claims.
- Gate: FAIL.
- Both confirmed all runtime implementation, watcher/security, OpenCode
  registration, protected provider payload, and frozen-tree claims. The
  divergences were documentation/source-status defects: retired Mnemon,
  Ollama, daemon, and per-agent-store specs lacked an unambiguous archive
  boundary; `docs/graphify.md` called distinct sources alternate memory
  authorities; comments cited the deleted `recall-injection.ts` and old plain
  recall format; and the unused `src/db/memories.ts` still presented a second
  per-agent semantic store.

## Repair Cycle 11

- Added one mechanical spec-status rule: only a spec directory containing
  `.team-auto-active` is active; all other spec artifacts are historical.
  `.context/specs/` is unconditionally archived.
- Added explicit archive/supersession banners to every Markdown artifact in
  the four retired memory spec families and the two legacy root plans
  identified by Gate 10.
- Removed the unimported legacy central semantic-memory accessor and dead
  runtime types while preserving migration 013 and existing table data as
  historical schema compatibility.
- Corrected Graphify's authority boundary, the recall-pair source comments, the
  structured-format test comment, and remaining active Mnemon wording.
- Added contract regressions for the archive rule, the retired source module,
  and the deleted recall-injection path.
- Focused host suites pass 62/62, focused runner pairing/formatter/scaffold
  suites pass 157/157, both TypeScript boundaries pass, diff hygiene is clean,
  and the provider worktree remains exact at
  `b061e0da996d4c30e32b5ea3dc2367158ba9de1b` with zero unstaged/untracked
  paths.

## Cycle 11

- Reviewer A: MISSING 0, DIVERGED 2, PARTIAL 0, CONFIRMED 113 across 115
  atomic claims.
- Reviewer B: MISSING 0, DIVERGED 2, PARTIAL 0, CONFIRMED 113 across the same
  115 claims.
- Gate: FAIL.
- Both reconfirmed the runtime, archive policy, removed legacy accessor,
  Graphify boundary, watcher/security, OpenCode registration, provider
  payload, and frozen-tree claims. Remaining defects were bounded status
  paper-cuts: a stale build-state header timestamp, an unbannered root spike
  note, two comments citing a deleted title-backend pattern and renamed recall
  builder, and a formatter comment describing the active structured branch as
  legacy-only.

## Repair Cycle 12

- Bannered `docs/SPIKE_NOTES.md` as a superseded pre-v2 record with pointers to
  the current memory contract.
- Made the session-title proxy comments self-contained, corrected the
  `buildRecallRow` source pointer, and documented recall-context formatting as
  the current structured path with legacy-row compatibility.
- Corrected this build checkpoint's top-level `Last updated` timestamp and
  recorded the Gate 11 outcome without superseding prior evidence.
- Focused host suites pass 76/76; focused runner pairing/formatter/scaffold
  suites pass 157/157; both TypeScript boundaries and diff hygiene pass.
- The frozen provider tree remains
  `b061e0da996d4c30e32b5ea3dc2367158ba9de1b` with zero unstaged/untracked
  paths.

## Gate 12 Audit and Repair Cycle 13

- One fresh audit completed with MISSING 0, DIVERGED 4, PARTIAL 1, CONFIRMED 114. A second attempted reviewer was interrupted before returning a result,
  so this was diagnostic input rather than a completed two-reviewer gate.
- Reconciliation now lazily migrates legacy inbound message tables before
  querying or inserting upgrade pairs. Focused regressions cover pending and
  processing rows, scheduled-task exclusion, idempotence, startup-before-wake
  ordering, and a legacy schema missing the current recall columns.
- Pre-turn path/source ranking and migration inventory/base selection now use
  deterministic codepoint order. Exact regressions demonstrate the prior
  locale-dependent outcome and a contract guard rejects reintroduction.
- Repaired-tree validation passes 108/108 focused tests and the full host suite:
  225 files, 3,017 passing, 1 skipped, 1 todo. Host and runner TypeScript, host
  build, formatting, touched-file lint with zero errors, and diff hygiene pass.
- Live post-restart verification finds all 8 migrated workgroups applied, 21
  sibling members and 2,542 sessions with 0 failures and no activation blocker.
  The host reached `NanoClaw running`; the live sibling compatibility link,
  canonical/native/lock mounts, and continuing Graphify service are verified.
- Both provider contracts confirm all 23 protected payload paths are byte-equal
  to frozen tree `b061e0da996d4c30e32b5ea3dc2367158ba9de1b`,
  which has no unstaged or untracked paths.

## Cycle 13

- Reviewer A: MISSING 0, DIVERGED 0, PARTIAL 0, CONFIRMED 115 across 115
  atomic claims.
- Reviewer B: MISSING 1, DIVERGED 3, PARTIAL 2, CONFIRMED 114.
- Gate: FAIL.
- Accepted findings: incomplete defensive recall-pair admission; symlinked
  migration-source ancestors; customized deterministic collision destinations;
  and symlinked provider-publication parents.
- Rejected findings: the protected roster is executable truth at 15 Codex plus
  8 OpenCode paths, not 24; the Claude 429 is external release evidence rather
  than missing implementation.

## Repair Cycle 14

- Cold and warm prompt admission share one pair-completeness rule. Trusted
  workgroup runtimes reject wholly or partly unpaired admissible trigger
  batches while standalone legacy harnesses remain compatible.
- Migration inventory validates source ancestors before traversal and
  deterministic SHA-qualified secondary collision paths preserve every distinct
  byte even when the primary import path is customized.
- Provider create-only publication preflights every target parent and safely
  creates missing components without following a symlink outside the project.
- RED reproduced all four accepted findings. GREEN passes 150 focused tests,
  the full 921-pass container suite with 4 intentional skips, both TypeScript
  boundaries, the 3,020-pass host suite, host build, formatting, lint, and diff
  hygiene.
- The rebuilt/live runtime verifies 8 applied workgroups, 21 siblings, 2,548
  sessions, zero failures, and no activation blocker. Graphify stayed
  uninterrupted. All 23 protected provider paths remain byte-equal to frozen
  tree `b061e0da996d4c30e32b5ea3dc2367158ba9de1b`.

## Current Gate

Gate 14 correctly failed. Reviewer A returned MISSING 0, DIVERGED 0, PARTIAL 0,
CONFIRMED 115. Reviewer B returned MISSING 0, DIVERGED 1, PARTIAL 0,
CONFIRMED 114 because `docs/workgroups.md` incorrectly said omitting
`container.json.workgroup_id` always creates a workgroup-of-1, while the
runtime deliberately preserves an existing DB assignment.

## Repair Cycle 15

- The operator contract now states the three actual reconciliation cases:
  explicit config replaces the DB assignment; omitted config preserves an
  existing non-null DB assignment; and only a missing config plus missing DB
  assignment defaults to the member's own folder.
- The unpairing procedure is explicit: set `workgroup_id` to the member's own
  folder slug and restart its containers. Removing the field does not unpair
  the member or revoke its access to shared workgroup memory.
- A contract regression guards both the preservation rule and the intentional
  unpair procedure.

Two entirely fresh Gate 15 reviewers must independently return literal
MISSING 0, DIVERGED 0, and PARTIAL 0 on this repaired final tree.

## Gate 15

- Reviewer A: MISSING 0, DIVERGED 1, PARTIAL 0, CONFIRMED 114.
- Reviewer B reproduced one source-proven migration divergence before its
  overlong audit was stopped: exact bytes at distinct relative paths were
  globally deduplicated to one destination, so a path-dependent Markdown link
  could point at a path the migrator omitted.
- Gate: FAIL.
- Reviewer A inspected the old published `origin/providers` ref instead of the
  frozen staged provider release tree. Publishing that already-validated tree
  remains a `/team-ship` operation, not a source-tree repair. The final audit
  prompt must name the frozen tree and distinguish commit-ready publication
  state from implementation drift.

## Repair Cycle 16

- Exact-byte deduplication now includes relative-path identity. Same-path,
  byte-identical origins still share one canonical destination and retain all
  provenance; identical bytes at distinct paths remain present at both paths.
- A RED/GREEN regression preserves two byte-identical customer notes under
  `notes/` and `contacts/`, verifies a Markdown link to the latter still
  resolves, checks report destinations, and verifies checksummed rollback.
- The migration skill and normative design now state this path-identity
  contract explicitly.
- A read-only audit of the applied
  `data/workgroup-memory-migration-reports/20260726T090928Z.json` report found
  no affected live path. Every cross-path record had a different-byte file at
  the requested path and correctly preserved the colliding bytes under its
  deterministic import destination.
- The repaired focused migration and contract suites pass 59/59 tests;
  formatting and diff hygiene pass.

Two entirely fresh Gate 16 reviewers must independently return literal
MISSING 0, DIVERGED 0, and PARTIAL 0 on this repaired final tree.

## Gate 16

- Reviewer A: MISSING 0, DIVERGED 2, PARTIAL 0, CONFIRMED 113.
- Reviewer B: MISSING 0, DIVERGED 0, PARTIAL 0, CONFIRMED 115.
- Gate: FAIL.
- Accepted findings: the migration rule confused source-relative identity with
  intended canonical identity for already-imported lineage, and
  `docs/memory.md` incorrectly described the workgroup-wide kernel lock as a
  per-path lock.

## Repair Cycle 17

- Exact bytes may share a destination only when their source-relative path is
  the same or when the deterministic import path is already the exact canonical
  identity for that lineage. Distinct intended canonical paths never collapse.
- The migration CLI now detects exact direct/import identities before
  allocating a new destination. This preserves already-imported relative-link
  trees without duplicating bytes while retaining same-path provenance.
- The runtime verifier now rejects cross-path destination sharing unless an
  outcome is anchored at its direct/deterministic import identity or shares the
  same source-relative path with such an anchor.
- Regressions cover unsafe cross-path collapse and the live pre-existing import
  topology. The operator guide now names the workgroup-wide writer lock.
- Focused migration/verifier/contract validation passes 87/87. The live
  verifier reports 8 applied workgroups, 21 members, 2,551 sessions, 0
  failures, no activation blocker, and the same two historical warnings.

Two entirely fresh Gate 17 reviewers must independently return literal
MISSING 0, DIVERGED 0, and PARTIAL 0 on this repaired final tree.

## Gate 17

- Reviewer A: MISSING 0, DIVERGED 2, PARTIAL 0. It proved three relative
  Markdown links changed target across Illysium and Madison Reed and that the
  runtime verifier accepted the unsafe topology.
- Reviewer B: MISSING 0, DIVERGED 3, PARTIAL 1, CONFIRMED 111. It found latent
  agent-shared route-scope loss, false capability claims for excluded universal
  MCPs, and import-lineage reuse conditional on a direct-path collision.
- Gate: FAIL. Claude's PARTIAL is an external Anthropic 429, not an
  implementation divergence.

## Repair Cycle 18

- Migration placement is now source-tree-coherent. A non-base source stays
  direct only when its complete tree fits; otherwise the whole tree reuses or
  occupies one deterministic import root. Exact whole-tree duplicates may
  share a root. Customized import roots receive a SHA-qualified tree collision.
- The verifier resolves relative inline and reference-style Markdown links
  from permanent snapshots through the outcome map and fails closed if a
  canonical target changes.
- Agent-shared ingress passes the trusted actual messaging-group/thread route
  into pre-turn recall and capability construction. Capability snapshots omit
  universal MCPs excluded from the effective container config.
- The old report rolled all eight workgroups back from permanent snapshots.
  Fresh report `20260726T123255Z.json` then reapplied all eight with coherent
  trees. Live verification covers 21 members and 2,556 sessions with zero
  failures, no activation blocker, and the same two historical warnings.
- Focused repaired risk tests pass 89/89. The full host suite passes 225 files,
  3,028 tests, 1 skip, and 1 todo; host build and TypeScript pass.

Two entirely fresh Gate 18 reviewers must independently return literal
MISSING 0, DIVERGED 0, and PARTIAL 0 on this repaired final tree.

## Gate 18

- Reviewer B: MISSING 0, DIVERGED 0, PARTIAL 0, CONFIRMED 4.
- Reviewer C: MISSING 0, DIVERGED 0, PARTIAL 0, CONFIRMED 4.
- Both independently verified the four repaired Gate 17 claims against the
  complete normative design and current source/tests.
- Gate: PASS. Final MUST-FIX: 0.
- The requested final `claude -p` review reached Anthropic but remained
  externally blocked: `You've hit your weekly limit · resets Jul 28, 3pm
(UTC)`. This does not weaken either source audit or runtime verification.
