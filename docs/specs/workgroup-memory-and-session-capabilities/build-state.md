## Build State Checkpoint

Last updated: 2026-07-26T11:39:19Z

> Earlier cycles below describe the pre-curator shared-memory cutover. The
> operator-approved [`plan.md`](./plan.md) is the sole normative contract for
> the current system; [`run.md`](./run.md) carries the curator implementation
> and final verification evidence.

### Build

- Namespace: `[team-build:workgroup-memory-and-session-capabilities]`
- Pre-build drift: MISSING 0; DIVERGED 2 acknowledged; effective DIVERGED 0; PARTIAL 6

### Groups Completed

- Group A: validated 2026-07-25T23:54:15Z — spec compliance and code quality
  cleared after the migration path was completed against the full lossless
  cutover contract. The final implementation inventories group-local and every
  recognized Claude-native project-hash store, permanently snapshots all
  inputs, preserves distinct collisions and exact-duplicate origins, replaces
  all provider-native readers with the one workgroup canon, and restores exact
  originals on rollback. The final pre-cutover gate now re-proves quiescence,
  re-inventories sources, and verifies every staged destination byte before the
  first destructive mutation. The independent focused Group A suite passed
  128/128 and its scoped diff check passed. No production migration/runtime
  command was run. Post-build repair added path-identity-aware exact-byte
  deduplication while retaining every source origin. Same-relative-path origins
  and exact replay of an already-imported lineage may share their intended
  canonical destination; distinct intended canonical paths remain distinct.
- Group C: validated 2026-07-25T23:35:37Z — spec compliance and code quality
  cleared after two fix passes. All 9 named tests passed individually; focused
  Group C suites passed 165/165 Bun and 8/8 Vitest; the full agent-runner suite
  passed 910/910 with 4 pre-existing skips; container TypeScript and scoped
  diff checks passed. The real 3-provider x 3-trial behavior run remains an
  explicit pre-QA-clear gate and has not been represented as unit evidence.
  Post-build repair fenced stale-lock reclamation against commit/release,
  isolated every evaluator home/config/data/cache/temp surface, staged only
  provider authentication, redacted it from evidence, and measured the full
  writable evaluation root. The memory-write suite passes 9/9, the fake-runtime
  evaluator suite passes 10/10, and container typecheck and host build pass.
- Group B: validated 2026-07-26T01:15:36Z — spec compliance, code quality, and
  integration cleared after two fix passes. The independent four-file Q2
  regression suite passed 82/82; the full owned memory surface passed 132/132;
  and the full host suite passed all 217 files with 2,893 passing tests, 1
  skipped, and 1 todo. Typecheck, build, formatting, scoped lint, and diff
  checks passed. Existing routing tests now inspect trigger rows while proving
  the exact adjacent recall pair instead of hiding the new row. Post-build
  repair makes every scheduled-task writer persist inert rows, admits due work
  through the same fresh context seam before wake classification, and resets
  rescheduled admitted rows without retaining stale recall. It also replaced
  Markdown path-check-then-open with a no-follow descriptor read. The final
  focused context/scheduling suite passes 221/221; typecheck and build pass.
- Group D1: validated 2026-07-26T01:32:44Z — the tracked Claude/Codex/OpenCode
  operator contract now uses the real lossless inventory/apply/verify flow,
  preserves the customization-first full-merge audit, and deletes the old
  semantic organizer. RED was 11 failures and 1 pre-existing pass; GREEN was
  12/12 contract tests, 50/50 relevant host tests, 3/3 runner memory tests, both
  skill validators, host build, formatting, lint, and diff checks. Lead reread
  all eight owned surfaces end-to-end and independently reran the contract,
  validators, and diff check. Post-build repair removed retired semantic
  organizer/reverse-migration claims from the remaining operator surfaces:
  only canonical/group and recognized provider-native memory are inventory
  inputs; `.seed.md`, instruction files, and customizations remain separate and
  byte-preserved. Contract tests pass 14/14, focused tests 28/28,
  directive/apply tests 132/132, all validators pass, and host build passes.
- Group D2: validated 2026-07-26T02:07:55Z — the read-only trusted-config
  verifier checks canonical bytes, every sibling compatibility path,
  recognized native views, permanent rollback bytes, migration outcomes, and
  complete session recall pairs without exposing memory bodies. The isolated
  end-to-end fixtures prove actual messaging-group capability scope,
  same-workgroup Claude/Codex/OpenCode visibility, cross-workgroup isolation,
  exact Slack/Discord links, Wix/SipTrue and Snowflake GSC recall, degraded
  source notices, and first/warm/rotation/replacement shapes. RED was 4/4 on
  the missing verifier; GREEN was 10/10 across both D2 files. Build, runner
  typecheck, formatting, zero-warning lint, diff checks, and an independent
  lead rerun passed. Post-build repair now checks recognized provider-native
  views for every sibling, rejects symlink escapes throughout trusted marker,
  report, snapshot, and canon paths, audits every live unpaired trigger, and
  exposes `--require-applied-migration` as the activation gate. Verifier tests
  pass 21/21 and the combined D2/integration suite passes 24/24. No live
  migration/runtime/provider-eval action was run.

### Groups Remaining

- None. Groups A, B, C, D1, and D2 are repaired and locally validated. Cycle
  9's accepted drift findings are repaired and locally validated. The
  final provider payload, including the customization-preserving OpenCode
  operator skill, is byte-pinned to pending provider-branch merge tree
  `b061e0da996d4c30e32b5ea3dc2367158ba9de1b`. The exact final tree now awaits
  its mandatory two-reviewer zero-drift confirmation before the remaining QA
  and release gates.

### Post-Build Drift Repair Cycle 1

- Reviewer A initially reported MISSING 1, DIVERGED 6, PARTIAL 2, CONFIRMED 8.
- Reviewer B initially reported MISSING 0, DIVERGED 1, PARTIAL 3, CONFIRMED 8.
- Accepted blockers were repaired in the owning groups: scheduled-task
  admission, Markdown no-follow reads, global collision deduplication,
  all-sibling native-view verification, trusted-path containment, complete live
  pair auditing, applied-migration activation gating, stale-writer fencing,
  evaluator credential/state isolation, and stale operator documentation.
- The required real Claude/Codex/OpenCode 3x3 run and live inventory/migration
  remain release evidence for QA, not substitutes for this code-drift rerun.

### Post-Build Drift Repair Cycle 2

- Group A stopped reading, transforming, or deleting `.seed.md`; explicit
  creation instructions use the existing `instructions.prepend.md` surface and
  cannot overwrite existing standing instructions. Its focused surface/init
  suite passed 50/50 with one pre-existing todo, and the final provider
  regression passed 15/15.
- Group B pins Markdown leaf descriptors and verifies canonical containment
  plus device/inode identity before reading. Task edits and resumes atomically
  invalidate recall and become inert; crash retries retain only an inert marker
  and rebuild fresh context when due. Dashboard run-now admits and verifies its
  fresh pair before wake or returns 503 without firing. Its focused suite passed
  189/189 and the broader affected suite passed 286/286.
- Group C removed PID authority, added bounded token/time commit-fence recovery,
  and anchors temp, lock, and final rename operations through opened Linux
  directory descriptors. The exact final-window ancestor-swap and reused-PID
  regressions pass; the full memory-write suite passed 11/11.
- Group D1 updated clone and OpenClaw migration contracts to one workgroup
  canon while preserving instruction files separately and byte-for-byte. Its
  contract tests passed 18/18, directive/apply/contract tests passed 150/150,
  and all three skill validators passed. Lead stale-surface scanning then found
  and repaired the OpenClaw `REMOVE.md` path/rollback wording; the expanded
  contract suite passes 19/19.
- Lead verification passed 234 focused host tests with one pre-existing todo,
  all 11 memory-write tests, host build, container-runner typecheck, and
  `git diff --check`.

### Post-Build Drift Repair Cycle 3

- Replaced the time-based writer lease with a stable workgroup-wide kernel
  `flock` sidecar that is mounted by exact inode in every provider and mount
  mode. Cross-process exclusion, expected-hash conflict, ancestor-swap,
  symlink, cleanup, and SIGKILL-release regressions pass.
- Limited provider lifecycle injection to trusted static handling guidance.
  Canonical/index/definition and archive bytes now enter only through the
  paired collision-safe untrusted recall field across Claude, Codex, and
  OpenCode startup, clear, compact, resume, warm, rotation, and replacement
  paths.
- Corrected v2 migration language so `CLAUDE.local.md` remains byte-preserved
  standing instructions and is never a `/migrate-memory` input.
- Added complete candidate validation, create-only provider installs, exact
  fetched-ref parity for Codex, and fail-closed directive
  sequencing. The pending provider branch was merged with upstream, customized
  provider bytes and the fork's exact Codex Dockerfile pin were retained, and
  the setup verifier now checks all three barrels plus that pin. Main's Codex
  and OpenCode payloads were installed create-only from and verified
  byte-for-byte against the then-current tree. The composed scratch passed
  21/21 host/setup tests, 349/349 runner provider tests, both typechecks/builds,
  and both diff checks; the final main setup/provider subset passed 25/25.
- Final stale-contract scanning found current docs/skill surfaces that still
  called group `CLAUDE.md` memory. Those surfaces now consistently describe
  one workgroup canon while retaining agent-scoped instructions.
- Replaced the lock regression's timing-sensitive child-startup assumption
  with deterministic in-process contention plus bounded process watchdogs.
  Five isolated suite repeats passed 55/55, eight concurrent suites passed
  88/88, and no production lock behavior changed.

### Post-Build Drift Repair Cycle 4

- Reserved `memory` from every discovery and crash-recovery path in the older
  generic workgroup shared-directory consolidator. First-run and already-
  present-canon regressions prove it cannot move, adopt, repoint, or report
  memory before the dedicated lossless migrator owns cutover.
- Added the OpenCode operator skill to the provider-branch payload roster and
  candidate validator. Stale `AGENT_PROVIDER`, old 1.4.17 pins, skip-if-
  installed behavior, wholesale redirects, and customization-destructive
  language now fail before publication. The staged provider branch is clean
  and byte-pinned to tree `95af1412d5ab95f7b19feda7fb63c4c60f432f9f`.
- Simplified provider-install failure safety: existing differing files fail
  before any write; missing files publish atomically create-only; already
  published paths are never automatically deleted after a later failure
  because no portable atomic compare-and-unlink can prove continued ownership.
  The failure reports retained paths for inspection and a retry accepts only
  candidate-identical bytes.
- Corrected Discord permalink resolution to the real Chat SDK archive shape:
  the URL channel may be the thread while `platform_id` remains the parent
  channel, `thread_id` ends in the thread channel, and inbound archive IDs add
  an agent-group suffix to the platform message ID. Exact message, bounded
  thread fallback, foreign-workgroup exclusion, and unknown root-message
  no-broadening regressions pass.
- Removed the last misleading transactional/reversible provider-installer
  labels. Code, tests, operator skills, and the staged provider payload now
  describe the actual create-only retention contract consistently.
- Focused host regressions pass 47/47; the isolated three-provider memory
  integration passes 3/3. Both provider candidate/composed/exact-tree gates,
  host build, container-runner typecheck, and both diff checks pass.

### QA Repair Cycle 5

- Replaced the migration report's unsafe compile-time cast with a complete
  runtime parser shared by apply, rollback, and the independent runtime
  verifier.
- Made destructive migration paths evidence-only. Apply and rollback now
  re-derive the database, data, group, canonical, group-source, provider-native
  source, and workgroup-member roster from trusted runtime configuration before
  quiescence or filesystem mutation.
- Rollback now authenticates the permanent snapshot manifest, exact source
  roster, contained snapshot paths, source types, and complete tree checksums
  before touching live paths. It builds and verifies every restoration in
  sibling staging paths before replacement. Malformed reports, redirected
  roots, redirected sources, and corrupted snapshots are covered explicitly.
- One generic best-passage ranking primitive now drives the formal recall
  corpus, live Markdown recall, and live archive ordering. The stale Discord
  exact-link fixture was corrected to use the archived message-id shape.
- Verifier failure mappings retain the original error detail, obsolete
  lease-era write options and contradictory Codex project-document comments
  are removed, and data-rollback guidance keeps the current one-canon runtime
  inactive until code rollback or a corrected fresh migration.
- Focused evidence: migration 27/27, runtime verifier 21/21, recall 19/19,
  provider contract 24/24, host TypeScript, both provider payload checks, and
  exact composed parity at
  `80dd67f1528d48bd594af430391016c552fe8fdc`.

### QA Repair Cycle 6

- Rollback re-inventories the complete current canonical, group, and
  provider-native source identity roster before quiescence. A report and
  snapshot manifest that jointly omit a recognized Claude-native store now
  fail before any filesystem mutation.
- Activation-blocking verifier mappings retain the original database,
  filesystem, schema, and session-audit error detail instead of collapsing it
  into a generic code.
- Provider behavior evaluation keeps the real workspace read-only while
  isolating provider caches, logs, and copied authentication in a disposable
  root. Provider self-state churn remains recorded but is not confused with a
  workspace write.
- Focused evidence: migration 28/28, runtime verifier 23/23, provider behavior
  evaluator 11/11, provider contract 24/24, host TypeScript, both provider
  payload checks, and exact composed parity at
  `5b844b2b651d279e250d3165f14bb51aafdc2754`.
- Live provider evidence: Codex passed 3/3 and OpenCode passed 3/3 with fresh
  sessions, no unauthorized actions, no workspace mutation, and no third-party
  credential exposure. Claude is release-blocked by the host account's weekly
  429 limit; the assigned OneCLI Anthropic path independently returned 401
  because the gateway did not inject the required `x-api-key` header.

### QA Repair Cycle 7

- The live Graphify freshness check exposed `ENOSPC` from the shared inotify
  budget. Direct descriptor accounting traced 50,583 watches to the main
  service in addition to Graphify's source watches.
- The dashboard session feed had treated every extensionless path as an
  intermediate directory, recursively entering session worktrees and
  `node_modules`. On this install that exposed roughly 405,000 session-tree
  directories to Chokidar and starved Graphify's correctness-critical watcher.
- The feed now traverses exactly
  `v2-sessions/<agent-group>/<session>/{inbound.db,outbound.db}` and rejects
  other files, directory lookalikes, worktrees, deeper descendants, and paths
  outside the session root. Its focused regression passes 12/12; formatting,
  scoped lint, and host TypeScript pass.
- This repair changes no provider payload bytes, so the exact pending
  provider-branch tree remains
  `5b844b2b651d279e250d3165f14bb51aafdc2754`.

### Post-Build Drift Repair Cycle 8

- Gate 7's two fresh reviewers independently found the same sole gap across
  115 atomic design claims: OpenCode's provider branch contained host and
  container real-barrel registration guards, but main and the protected
  provider payload roster omitted both.
- Main now carries both guards. The OpenCode roster publishes and exact-byte
  validates both, the operator skill inventories and runs them, and its
  existing remove contract is again symmetric with install.
- Focused evidence: provider contract plus host registration 26/26, container
  registration 1/1, both TypeScript trees, formatting, diff checks, candidate
  validation, and exact composed parity for Codex and OpenCode.
- The exact pending provider-branch tree is now
  `b061e0da996d4c30e32b5ea3dc2367158ba9de1b`.

### Post-Build Drift Repair Cycle 9

- Gate 8's two fresh reviewers found one shared stale security-document
  cluster. `docs/SECURITY.md` now records the canonical/compatibility/native
  memory views, exact lock overlay, bounded host pre-turn reads, and workgroup
  rather than individual-agent sharing boundary.
- One reviewer additionally found the Cycle 7 dashboard filter admitted
  intermediate files and symlinks on Chokidar's post-stat callback while
  Chokidar followed symlinks by default. The watcher now disables symlink
  following and requires real non-symlink directories at both intermediate
  levels before admitting the two regular database leaves.
- The focused dashboard regression covers intermediate files, intermediate
  symlinks, database-leaf symlinks/directories, deep worktrees, and out-of-root
  lookalikes and passes 12/12. Formatting, scoped lint, and host TypeScript
  pass.
- No provider payload byte changed; the exact pending provider-branch tree
  remains `b061e0da996d4c30e32b5ea3dc2367158ba9de1b`.

### Post-Build Drift Cycle 9 and Repair Cycle 10

- Gate 9 completed with both fresh reviewers reporting the same exact count:
  MISSING 0, DIVERGED 1, PARTIAL 0, CONFIRMED 114 across the fixed 115-atom
  ledger.
- The implementation, provider payload, security model, and watcher repair all
  conformed. The only divergence was stale active operator documentation that
  still described provider-native memory as authority or directed the retired
  destructive import procedure.
- `docs/CUTOVER_RUNBOOK.md` is now an explicit superseded notice pointing only
  to the supported v2 and lossless memory migrations. `CHANGELOG.md`,
  `docs/V2_BACKLOG.md`, the archived v1 migration checklist, historical audit
  banners, and active source comments now agree on one canonical workgroup
  tree, compatibility-only native paths, and bounded host pre-turn recall.
- The initial current-surface search was too narrow. Gate 10 later found
  unbannered historical spec families and two stale active comments. The
  retained focused evidence remains valid: the migration, provider-contract,
  and dashboard suites passed 58/58; host and runner TypeScript checks passed;
  the runner scaffold suite passed 4/4; and `git diff --check` passed.
- The provider worktree remains frozen at
  `b061e0da996d4c30e32b5ea3dc2367158ba9de1b`, with zero unstaged or untracked
  paths.
- Recorded at 2026-07-26T08:01:01Z. Gate 10 requires exactly two entirely fresh
  isolated reviewers and literal MISSING 0 / DIVERGED 0 / PARTIAL 0 on this
  exact tree before live migration or release operations.

### Post-Build Drift Cycle 10 and Repair Cycle 11

- Gate 10 reviewer A reported MISSING 0, DIVERGED 2, PARTIAL 0, CONFIRMED 113;
  reviewer B reported MISSING 0, DIVERGED 4, PARTIAL 0, CONFIRMED 111 across
  the fixed 115-atom ledger.
- Both independently reconfirmed the runtime implementation, watcher/security
  repairs, provider registration, 23/23 protected payload parity, and frozen
  provider tree. Their findings were stale-status defects: retired memory
  specs looked active, Graphify named alternate memory authorities, active
  comments cited a deleted module/old format, and one dead runtime accessor
  still advertised per-agent semantic memory.
- Cycle 11 adds a mechanical specification lifecycle rule, banners every
  retired memory-spec artifact, removes the dead accessor/types without
  deleting historical schema or data, corrects current docs/comments, and adds
  contract regressions for all three classes.
- Focused host suites pass 62/62; focused runner pairing/formatter/scaffold
  suites pass 157/157; both TypeScript boundaries and diff hygiene pass.
- The provider worktree remains frozen at
  `b061e0da996d4c30e32b5ea3dc2367158ba9de1b`, with zero unstaged or untracked
  paths.
- Recorded at 2026-07-26T08:22:18Z. Gate 11 requires exactly two entirely fresh
  isolated reviewers and literal MISSING 0 / DIVERGED 0 / PARTIAL 0 on this
  exact tree before live migration or release operations.

### Post-Build Drift Cycle 11 and Repair Cycle 12

- Gate 11 reviewer A reported MISSING 0, DIVERGED 2, PARTIAL 0, CONFIRMED 113;
  reviewer B reported MISSING 0, DIVERGED 2, PARTIAL 0, CONFIRMED 113 across
  the fixed 115-atom ledger.
- Both reconfirmed the runtime feature, mechanical spec lifecycle policy,
  archive banners, removed legacy accessor/types, preserved historical schema,
  Graphify boundary, watcher/security repairs, OpenCode registration, protected
  payload parity, and frozen provider tree.
- Cycle 12 repairs the four bounded status/comment defects: the root spike note
  is explicitly archived; the title-backend and recall-builder comments cite
  current code; the formatter comment identifies the structured branch as
  primary current behavior with legacy-row compatibility; and this file's
  top-level timestamp matches its latest evidence.
- Focused host suites pass 76/76; focused runner pairing/formatter/scaffold
  suites pass 157/157; both TypeScript boundaries and diff hygiene pass.
- The provider worktree remains frozen at
  `b061e0da996d4c30e32b5ea3dc2367158ba9de1b`, with zero unstaged or untracked
  paths.
- Recorded at 2026-07-26T08:34:54Z. Gate 12 requires exactly two entirely fresh
  isolated reviewers and literal MISSING 0 / DIVERGED 0 / PARTIAL 0 on this
  exact tree before live migration or release operations.

### Gate 12 Audit and Repair Cycle 13

- One valid fresh Gate 12 audit reported MISSING 0, DIVERGED 4, PARTIAL 1,
  CONFIRMED 114. The second attempted reviewer was interrupted before producing
  an independent result, so Gate 12 did not run and no two-reviewer conclusion
  was claimed.
- The accepted implementation findings were bounded but release-relevant:
  startup reconciliation opened legacy inbound databases without first lazily
  migrating their message schema; memory source ordering used locale-dependent
  comparison; and processing, scheduled-task, startup-order, legacy-schema, and
  deterministic-order cases lacked direct regressions.
- Startup reconciliation now opens the raw inbound database, applies the same
  lazy message-table migration used by normal session access, and only then
  admits pending upgrade contexts. Pre-turn Markdown selection and lossless
  migration inventory/base selection now use one codepoint comparator instead
  of locale-dependent ordering.
- RED reproduced the legacy-column and ordering failures. GREEN passes 108/108
  focused tests covering pending plus processing rows, scheduled-task
  exclusion, idempotence, startup ordering before channel wake, legacy inbound
  schema repair, and codepoint-stable source/path selection.
- Full evidence on the repaired tree: 225 host files passed with 3,017 passing,
  1 skipped, and 1 todo; host and container TypeScript passed; host build,
  Prettier, touched-file lint with zero errors, and `git diff --check` passed.
  The earlier unchanged container runtime suite remains 919 passing, 4 skipped,
  and 0 failed.
- The applied migration report
  `data/workgroup-memory-migration-reports/20260726T090928Z.json` records all
  eight workgroups as applied. The post-restart runtime verifier inspected 8
  workgroups, 21 members, and 2,542 sessions with 0 failures and no activation
  blocker. Its two warnings are the known historical missing session database
  and intentionally memberless demo workgroup.
- The live host restarted cleanly at 2026-07-26T09:42:58Z, reached
  `NanoClaw running`, and retained the independently running Graphify service.
  A live Codex sibling resolves `/workspace/agent/memory` to
  `/workspace/workgroup/memory`; the canonical, compatibility, native, and
  writer-lock mounts are present with the intended access modes.
- Both provider memory contracts pass with all 23 protected files byte-equal to
  frozen provider tree `b061e0da996d4c30e32b5ea3dc2367158ba9de1b`.
  That worktree has zero unstaged or untracked paths.
- Codex and OpenCode behavioral release trials remain 3/3 each with no
  unauthorized action or workspace mutation. Claude's requested review and
  behavioral run remain externally blocked by the account's Anthropic 429
  weekly limit, not by code or runtime behavior; the final review attempt will
  be recorded at the ship gate.
- Recorded at 2026-07-26T09:45:58Z. Gate 13 requires exactly two entirely fresh
  isolated reviewers and literal MISSING 0 / DIVERGED 0 / PARTIAL 0 on this
  frozen tree.

### Gate 13 Review and Repair Cycle 14

- Gate 13 reviewer A returned MISSING 0, DIVERGED 0, PARTIAL 0, CONFIRMED 115.
  Reviewer B returned MISSING 1, DIVERGED 3, PARTIAL 2, CONFIRMED 114, so the
  gate correctly failed despite one clean result.
- Four implementation findings were accepted and reproduced before repair:
  prompt admission did not defensively reject every unpaired trigger;
  migration inventory could follow a symlinked source ancestor; a customized
  deterministic collision destination blocked a later distinct source; and
  provider create-only publication could follow a symlinked parent directory.
- Pair completeness now uses one shared cold/warm admission rule. A trusted
  workgroup runtime fails closed even when the entire observed trigger batch is
  unpaired; standalone pre-workgroup compatibility remains unchanged.
  Migration inventories reject symlinked ancestors before reading sources,
  distinct second-level collisions receive deterministic SHA-qualified
  destinations, and provider publication validates and creates every parent
  component without following symlinks.
- Reviewer B's protected-roster count was rejected by direct executable
  evidence: Codex has 15 paths and OpenCode has 8, for exactly 23. Its Claude
  behavioral-evidence item is an external Anthropic 429 release constraint,
  not missing implementation; the evaluator and deterministic provider
  contracts remain executable.
- RED reproduced all four accepted failures. GREEN passes 150/150 focused tests
  and the full container suite: 921 passing, 4 intentionally skipped, 0 failed.
  The unchanged host full gate passes all 225 files with 3,020 passing, 1
  skipped, and 1 todo. Both TypeScript boundaries, host build, Prettier,
  touched-file lint with zero errors, and diff hygiene pass.
- The rebuilt image is
  `sha256:2a08203b8dee755570cfd4b8a018cac6f114ca2651f014742c8baaac705e75cb`.
  Live verification after restart finds all 8 applied workgroups, 21 sibling
  members, and 2,548 sessions with 0 failures and no activation blocker. The
  two warnings remain the known historical missing session database and
  intentionally memberless demo workgroup. Graphify retained PID 852349
  throughout host activation.
- A live Codex sibling mounts the current runner source read-only, resolves
  `/workspace/agent/memory` to `/workspace/workgroup/memory`, and has the
  canonical, native, and writer-lock mounts at the intended access modes.
  Both provider contracts still prove all 23 protected paths byte-equal to
  frozen tree `b061e0da996d4c30e32b5ea3dc2367158ba9de1b`.
- Recorded at 2026-07-26T10:24:00Z. Gate 14 requires exactly two entirely fresh
  isolated reviewers and literal MISSING 0 / DIVERGED 0 / PARTIAL 0 on this
  repaired final tree.

### Gate 14 Review and Repair Cycle 15

- Gate 14 reviewer A returned MISSING 0, DIVERGED 0, PARTIAL 0, CONFIRMED 115.
  Reviewer B returned MISSING 0, DIVERGED 1, PARTIAL 0, CONFIRMED 114, so the
  gate correctly failed.
- The accepted divergence was an operator-documentation defect, not runtime
  drift: removing `container.json.workgroup_id` preserves an existing DB
  assignment, but the documentation incorrectly promised a workgroup-of-1.
  Following it could leave an intentionally unpaired sibling with shared
  workgroup memory and archive access.
- The documentation now describes explicit replacement, preservation on
  omission, and own-folder defaulting only when both sources are absent.
  Intentional unpairing requires an explicit own-folder `workgroup_id` followed
  by container restart. A focused contract regression protects this behavior.
- Recorded at 2026-07-26T10:43:59Z. Gate 15 requires exactly two entirely fresh
  isolated reviewers and literal MISSING 0 / DIVERGED 0 / PARTIAL 0 on this
  repaired final tree.

### Gate 15 Review and Repair Cycle 16

- Gate 15 reviewer A returned MISSING 0, DIVERGED 1, PARTIAL 0, CONFIRMED 114
  after auditing the old published `origin/providers` ref rather than the
  commit-ready frozen staged provider tree. Publication remains pending for
  `/team-ship`; the staged tree is the implementation target for the final
  audit.
- Reviewer B independently reproduced a real migration defect: the global
  exact-byte key omitted relative-path identity, allowing byte-identical files
  at distinct paths to collapse to one canonical destination and break
  path-dependent references. The audit was stopped after the source-proven
  blocking defect to avoid further non-actionable review work.
- The dedupe key now includes relative path. Same-path identical origins still
  deduplicate with complete provenance; distinct paths always remain distinct.
  A direct regression preserves both paths, verifies a Markdown link, report
  destinations, and rollback hashes.
- A read-only audit of the already-applied migration report found no live path
  loss: each cross-path outcome had a different-byte occupant at the requested
  path and correctly used a deterministic collision destination.
- Focused migration and contract validation passes 59/59 tests; formatting and
  diff hygiene pass.
- Recorded at 2026-07-26T11:09:47Z. Gate 16 requires exactly two entirely fresh
  isolated reviewers and literal MISSING 0 / DIVERGED 0 / PARTIAL 0 on this
  repaired final tree. Reviewers must audit frozen provider tree
  `b061e0da996d4c30e32b5ea3dc2367158ba9de1b`; remote publication is reserved
  for `/team-ship`.

### Gate 16 Review and Repair Cycle 17

- Gate 16 reviewer A returned MISSING 0, DIVERGED 2, PARTIAL 0, CONFIRMED 113.
  Reviewer B returned MISSING 0, DIVERGED 0, PARTIAL 0, CONFIRMED 115, so the
  gate correctly failed.
- Reviewer A found the prior path-identity wording was too broad for replaying
  already-imported lineage: the live report safely shares a deterministic
  `imports/<source-group>/<relative-path>` identity while preserving the
  different custom bytes at the direct path. Forcing an extra per-file
  destination would duplicate bytes and could split relative-link trees.
- The migrator now reuses only an exact direct or deterministic import identity,
  still deduplicates exact same-relative-path origins with provenance, and
  never collapses distinct intended canonical paths. The runtime verifier now
  fails closed on an unsafe cross-path outcome collapse while accepting the
  three source-proven live lineage aliases.
- Reviewer A also found `docs/memory.md` described a per-path lock even though
  the implementation uses one kernel lock for the entire workgroup. The guide
  now states the actual workgroup-wide serialization contract.
- RED/GREEN coverage models both the live replay topology and an unsafe
  `notes/customer.md` to `contacts/customer.md` collapse. Focused migration,
  verifier, and contract suites pass 87/87. Live verification covers 8 applied
  workgroups, 21 members, and 2,551 sessions with 0 failures, no activation
  blocker, and only the two known historical warnings.
- Recorded at 2026-07-26T11:39:19Z. Gate 17 requires exactly two entirely fresh
  isolated reviewers and literal MISSING 0 / DIVERGED 0 / PARTIAL 0 on this
  repaired final tree.

### Builder Assignments

- builder-A: Group A only; 13 exclusive files from the plan after the
  provider-surface regression-test ownership correction.
- builder-B: Group B plus `src/host-core.test.ts`,
  `src/channels/channel-registry.test.ts`,
  `src/modules/agent-to-agent/agent-route.test.ts`, and
  `src/modules/agent-to-agent/message-gate.test.ts`. Scope ACK received before
  edits; live sources may be inspected read-only for the required retrieval
  inventory/benchmarks, but no live writes or runtime operations were
  authorized.
- builder-C: Group C only; 14 exclusive files from the plan.
- builder-D1: Group D1's eight exclusive files from the plan. Scope ACK
  received after reading the normative design, plan, and all owned files
  end-to-end. No live migration, runtime, service, provider-eval, commit, or
  push action is authorized.
- builder-D2: Group D2's three exclusive new files from the plan. Scope ACK
  received before edits. All fixture writes stayed under isolated temp roots;
  no live migration, runtime, service, provider-eval, commit, or push action
  was authorized or run.

### Decisions Made During Build

- 2026-07-25T22:49:59.883Z — Group C consumes the exact plan-level payload
  keys `trustedCapabilities`, `memoryEvidence`, `conversationEvidence`, and
  `notices`; only the first is trusted. Evidence internals remain opaque JSON
  so Group C does not invent a schema before Group B implements the producer.
- Group A owns `src/provider-surfaces.test.ts`: its old assertion dereferenced
  `groups/<folder>/memory` on the host, while the approved link is intentionally
  container-absolute. The test must verify canonical host bytes and exact link
  target; production behavior is unchanged.
- Group A spec review attempt 1 rejected completion pending three migration
  contract fixes: nonzero CLI status for blocked reports, snapshot-only handling
  of nested symlinks, and exact restoration of a pre-existing canon.
- Group C spec review attempt 1 rejected completion pending real provider
  execution evidence and provider-facing lifecycle parity; pre-authored passing
  traces and provider-name-only loops are not accepted as evidence.
- Group C spec review attempt 2 cleared after the evaluator became a real,
  fail-closed CLI executor and lifecycle coverage instantiated all three
  registered providers.
- Group C code-quality attempt 1 rejected duplicate query/push wrappers and an
  unbounded pending-row load. The final implementation uses the existing
  `AgentProvider.query` / `AgentQuery.push` seam and bounded recent, wake, and
  exact-partner candidate queries. A 5,000-row trigger-zero-tail regression
  proves an older due recall pair remains visible within a bounded row budget.
- Group A final spec review found one shared integrity invariant rather than a
  provider-specific exception: recorded migration outcomes and the source tree
  both must still match the fully built staging tree immediately before
  cutover. One verifier now enforces exact source equality, one outcome per
  active leaf, and destination type/size/SHA/link-target parity after the final
  quiescence proof. Source changes or copy corruption block before mutation.
- Group B code-quality attempt 1 rejected four concrete retrieval defects:
  lexical archive rows exceeded their declared independent budget, core memory
  was excluded from conflict detection, Markdown excerpts could omit the
  passage that caused selection, and the declared Markdown candidate cap was
  not enforced. B-Q1 fixed all four and added five RED regressions.
- Group B integration attempt 1 exposed 24 stale assertions across four
  existing test files that counted only the trigger row. B-Q2 preserved the old
  routing assertions over trigger rows, added exact adjacent recall/trigger
  pair assertions, and cleared the full 217-file host suite without weakening
  production pair behavior.
- D1 preserves the real two-path failure state machine. An `apply` failure
  auto-restores any cutover-started paths and freezes the report as `blocked`;
  it requires inspection and a fresh inventory. Explicit rollback is only for
  an `applied` report whose D2 verification fails. Making rollback generic for
  blocked reports was rejected because it could overwrite later source changes.
- D2's simplicity pass removed unused path/time overrides from the verifier;
  the CLI and programmatic entry now derive roots only from trusted config.
  Exact recall/trigger status equality was also rejected as a migration
  invariant: task-script skip and orphan-drain can legitimately advance the
  trigger first. Structural adjacency, identity, scope, scheduling, routing,
  and payload completeness remain activation-blocking and have regression
  coverage.

### Escalations

- Group A spec-fix RED test initially called the production strict-quiescence
  path because `runCli` ignored its injected hook. It stopped three live
  `illysium` containers. The builder was interrupted immediately. The host
  service remained active; two sessions had already completed replies, and the
  active Codex session automatically respawned and resumed the same provider
  session. No live memory/content data changed; normal lifecycle-status rows
  did. `runCli` now accepts explicit migration hooks, and only isolated
  temp-fixture tests are authorized for the remainder of Group A review.

### Known Risks

- B1 retrieval must use headings as well as sorted paths/content.
- A2 preserves opaque provider sources in snapshot/report without activating them.
- B1 benchmarks cold and warm incident turns; scan-budget fallback stays in-process.
- B1 tunes tokenization, lexical score, source preference, and bounds.
- C4 scores recalled instructions as evidence-only even without tool/action traces.

### Repair Cycle 18

- Gate 17 proved that leaf-level collision placement preserved bytes but
  changed three relative Markdown link targets. It also found latent
  agent-shared route-scope loss, false capability claims for excluded universal
  MCPs, and an import-reuse branch conditional on a direct collision.
- Placement is now coherent per source tree, the verifier checks relative
  Markdown link identity from permanent snapshots, agent-shared turns carry
  actual host route scope, and capability snapshots honor `excludeMcpServers`.
- The retained old snapshots restored every workgroup. Fresh report
  `data/workgroup-memory-migration-reports/20260726T123255Z.json` reapplied all
  eight workgroups; the live verifier reports 21 members, 2,556 sessions, zero
  failures, and no activation blocker.
- Repaired risk tests pass 89/89. The full host gate passes 225 files and 3,028
  tests with one skip and one todo. Host build and TypeScript pass. Container
  runtime code did not change; the immediately prior full container gate
  remains 921 passing with four intentional skips.
- Gate 18 closed with two fresh independent zero-drift verdicts: both returned
  MISSING 0, DIVERGED 0, PARTIAL 0. Final MUST-FIX is zero. The requested
  `claude -p` review remains externally blocked by the weekly Anthropic limit
  resetting Jul 28 at 15:00 UTC.
