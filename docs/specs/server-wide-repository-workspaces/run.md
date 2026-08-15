# Server-wide canonical clones with per-topic Git worktrees: build run

## Build start

- User approval: explicit implementation request for the plan above.
- Workflow: `bootstrap-workflow-agents:team-build`.
- Frozen NanoClaw state: branch `main`, HEAD
  `b19844110102598a128cedeca77d03df7c58cffa`.
- Frozen Bootstrap state: HEAD `5a260908c6b93febda65cb66698998fd3e888d13`.
- Isolated implementation worktree:
  `/tmp/nanoclaw-topic-worktrees-20260814` on
  `infra/server-wide-topic-worktrees-20260814`.

## Lossless source backup gate

- Reversibly paused the source watcher, six Claude source sessions, the prior
  repo-store Codex session, and their process groups. The NanoClaw service and
  agent fleet stayed online.
- Backup root:
  `/home/ubuntu/backups/nanoclaw-worktree-recovery/20260814T032103Z`.
- `nanoclaw-v2` and `bootstrap` capsules each contain complete `.git`, a
  Git-visible worktree archive, cached/working binary diffs, NUL-safe status and
  inventories, index entries/hash, content/mode/type/size/symlink manifests,
  and `git fsck --full` output. NanoClaw also has the generated
  `dist.wip-backup-20260813T152811Z` as both part of the visible archive and a
  separate archive.
- Both capsules were extracted into disposable directories. Before Git opened
  each restore, the complete `.git` manifest matched. After Git validation,
  HEAD, branch/detached state, status, index entries, staged/unstaged binary
  diffs, tracked/untracked inventories, modes, hashes, and symlinks matched.
  `git fsck --full` matched and the capsule-level SHA-256 checks passed.
- Capsule directories are mode `0700`; archives and manifests are not
  group/other accessible.
- The exact reviewed cleanup script and final recovery inputs are retained at
  `control-plane-preflight/` inside the capsule (directory mode `0700`, files
  mode `0600`). The cleanup script SHA-256 is
  `339f602897578fc15bbd6078ea045a0fd21be2cc2f6fc4db7cacc6d3f34d40b5`;
  copied stage-13 and work-unit mapping hashes match their reviewed originals.
- The first NanoClaw verifier run was retained with a failed label because Git
  refreshed the restored index stat cache after the raw `.git` comparison. It
  found no archive loss. The corrected successful verifier separates the exact
  pre-open `.git` comparison from post-open semantic Git comparison.

## Cleanup reconstruction ledger

- The verified pre-implementation unrelated tree was
  `ec7f028ba9c48d4e666b6623fed63f0afed7c583`, created from build-start HEAD
  `9c3b503a7541fd21484d6ae4e45ea5c4f7a526f7`.
- Its old planning artifacts were excluded. The remaining 16-file delta is
  reapplied to the current HEAD in the isolated worktree.
- Worker-tier and provider-fallback changes were reconstructed separately from
  their exact current hunks. Dashboard and Observatory work was already present
  in the frozen current HEAD. Concurrent Slack, permissions, self-mod,
  delivery, and provider work captured during the source window is preserved.
- Proven abandoned repository-store files were excluded from the clean
  reconstruction. Bootstrap's four abandoned OpenCode guard changes were
  independently backed up and removed from the reconstructed source state.

## Reconstruction verification before cleanup

- Focused host preservation suites: 7 files, 239 tests passed.
- Focused Bun preservation suites: 2 files, 119 tests passed.
- Host TypeScript check: passed.
- Agent-runner TypeScript check: passed.
- `git diff --check`: passed.
- Independent cleanup reconstruction review: `clear`. The reviewer checked the
  backup hashes; every preserved 16-file, Slack, permissions, self-mod,
  delivery, worker-tier, provider-fallback, dashboard, and Observatory surface;
  the three mixed files; and Bootstrap. It confirmed that no ambiguous hunk was
  deleted and that every excluded hunk is evidence-backed abandoned work.

## Final preservation-diff audit before source replacement

- Live and candidate source HEAD:
  `b19844110102598a128cedeca77d03df7c58cffa`.
- All 26 current Git-visible live paths are present in the candidate; missing
  paths: zero. After the runbook itself was updated, twenty are byte-and-mode
  identical and six are intentionally co-edited by the corrected worktree
  implementation (`self-mod.ts`, `self-mod.test.ts`, `poll-loop.ts`,
  `container-runner.ts`, `provider-surfaces.test.ts`, and this runbook). Direct
  diff review confirmed that the prior behavior remains present.
- The frozen 2,381-entry abandoned working state remains fully recoverable:
  60/60 tracked records and 2,321/2,321 non-ignored untracked records are in the
  protected ledger; 33/33 backup checksums pass; the complete `.git` and
  restored worktree pass `git fsck --full` and semantic comparison.
- Fresh expanded NUL-safe live status digest (26 individual records):
  `5466fa9cdb6b7e89b10826cccd83ab0be06834208ad312ae618cf0cf9bd004a9`.
- Fresh path/status/mode/type/size/content manifest digest:
  `63ef28def12f47914d9289d17741783173341b3ff8a0a86ba526f04651c56ab0`.
  Bootstrap is clean at `5a260908c6b93febda65cb66698998fd3e888d13`; its
  empty status digest is `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- The earlier path/mode/blob digest used a different collapsed-inventory
  serialization and is retained in the protected capsule. Source replacement
  is gated on a fresh expanded inventory under the final NanoClaw/Bootstrap
  writer freeze. Any drift aborts replacement and is carried forward
  explicitly.

## Corrected implementation safety evidence

- Acceptance coverage now includes cross-workgroup fail-closed mounts; durable
  clone-publication replay; detached/raw-index transfer preservation; rejection
  of spawning, processing, active-tool, and continuation sources; and host
  list/move/remove interoperability for container-created linked metadata.
- The independent cutover audit identified seven blockers. The candidate now
  includes hash-bound deterministic rollback paths, exact canonical/worktree
  enumeration, fail-closed systemd proof, persisted aggregate-capacity and
  recovery-seed evidence, a crash-resumable completed-run rollback command,
  exact canonical/pin namespace audit, and archive-only rollback verification.
- Focused migration and manifest-integrity suites: 2 files, 51 tests passed.
- Server-driver safety suite: 1 file, 9 tests passed.
- The final guard lane closes direct Claude, Codex, OpenCode, container-task,
  host-task, and nested peer-agent Git-maintenance paths. It blocks worktree
  administration, GC/maintenance, direct prune/repack/pack-refs, destructive
  reflog expiry, and destructive multi-pack-index operations while preserving
  ordinary topic Git commands and read-only maintenance. A real-Git regression
  demonstrates the formerly deletable staged-only sibling blob and proves the
  guard preserves the worktree admin directory, raw index, ref, blob, and file.
- Final independent review found and reproduced one static execution-wrapper
  bypass (`timeout 30 git worktree prune`, with analogous common wrappers).
  Host and runner parsers now recursively unwrap plain or absolute-path
  `timeout`, `nice`, `ionice`, `setsid`, `stdbuf`, and `time`, composing with
  the existing shell/env/command wrappers. Table regressions cover protected
  direct/nested and safe direct/nested forms for every wrapper plus explicit
  Claude, Codex, and OpenCode adapter paths. Final focused results were 42/42
  host and 20/20 runner tests (181 assertions); independent re-review accepted
  the fix with no remaining implementation blocker.
- Canonicals are stamped with `gc.worktreePruneExpire=never`; host cleanup no
  longer runs global `git worktree prune --expire now`, and inactive sessions
  cannot bypass persisted processing/tool/continuation checks.
- Publication and transfer now use a durable generation-token ingress fence.
  Already-admitted turns drain, new outer admissions stop, acknowledgements
  occur only at an idle boundary, and partial quiescence failure is recoverable.
- Origin pins and diagnostics reject or redact userinfo, URL authority,
  query/fragment credentials, and caller-supplied repository identity. Host Git
  never falls back to ambient credentials.
- Repository discovery classifies repositories named `dist`, `build`,
  `target`, or `.cache` before pruning; symlink escapes and initialized Git
  submodules fail before mutation. Nested repositories migrate deepest-first
  through an explicit containment DAG and roll back in reverse order.
- The XZO monorepo rule is explicit: `xzo-backend` is coalesced into `XZO`, not
  migrated as an independent repository. The three divergent same-thread
  XZO-Analytics states (`ANALYTICS-79`, `ANALYTICS-97`, and
  `XZO-ANALYTICS-54`) receive exact hash-bound archive decisions instead of
  invented agent work units. The reviewed stage-13 recovery ledger is
  `/tmp/serverwide-recovery-reviewed-stage13-20260814.json`, mode `0600`, SHA-256
  `c969a0b46e1afbd6867e349960fa1e9f77404d4b87687e00ed8824d868203cdc`.
- A diagnostic command accidentally allowed Git to refresh only the modes of
  the `ANALYTICS-79` and `ANALYTICS-97` raw index files from `0644` to `0600`.
  Their bytes, hashes, branches, pointers, and visible states never changed.
  The two proven original modes were restored exactly to `0644`; a subsequent
  `GIT_OPTIONAL_LOCKS=0` preflight reproduced the original visible hashes and
  left both raw indexes unchanged.

## Capacity and migration preflight

- The corrected full non-quiescent inventory measured `231.91 GiB` available
  and `21.68 GiB` required. It failed safely before mutation because scheduled
  cleanup changed three legacy paths during the live scan and because the XZO
  recovery decisions had not yet been merged.
- The final stage-13b focused XZO preflight inventoried 78 physical checkouts,
  exited zero, and measured `234.63 GiB` available and `4.84 GiB` required
  (`20.85 MiB` control-plane overhead). It emitted no unresolved proposal and
  changed no file, ref, service, container, or repository.
- Live cleanup means no server-wide inventory can be authoritative while the
  fleet is running. The complete capacity gate and execution manifest must be
  regenerated under the controlled outage and must refuse the first mutation
  if the bound fails.

## Final candidate validation

- Final post-review full host suite: 262/262 files passed; 3,725 tests passed,
  one skipped, one todo. The Madison shared-admin collision regression passed
  serially and now has an explicit 20-second filesystem-test budget instead of
  relying on the global five-second default.
- Final post-review full agent-runner Bun suite: 1,042 passed, four documented
  environment skips, zero failures.
- Post-format focused verification: 55/55 host migration/recovery tests,
  201/201 runner guard/provider tests (three environment skips), and 32/32
  discovery/mapping/cleanup/integrity tests passed.
- Host TypeScript, agent-runner TypeScript, temporary host build,
  candidate-only Prettier, focused candidate lint (zero errors; existing
  catch-policy warnings), and `git diff --check` all passed. Whole-repository
  Prettier/lint remain red on unrelated pre-existing vendored and historical
  files and are not treated as candidate regressions.
- The container image built successfully under the isolated, non-live tag
  `nanoclaw-agent-worktree-validation:20260814`, image ID
  `sha256:72cd6cbc4ca6e561c337bedbf776918ca9e91753f8b1c41cf9df2a74b4600190`.
  Its labels identify commit `b19844110102598a128cedeca77d03df7c58cffa`, role
  `candidate`, and owner `topic-worktrees-preflight`. Because the build ran
  before the candidate was committed, that commit label names the base commit,
  not the dirty candidate tree; this image is build evidence only and must
  never be activated. The controlled-outage artifact is rebuilt from the
  reviewed commit so its label is hash-accurate.
- Validation-only dependency symlinks were moved out of the candidate into the
  permission-restricted recovery directory
  `/tmp/nanoclaw-validation-symlink-recovery-20260814`; the live dependency
  directories remain intact.

Final independent implementation review is clear with no implementation
blocker. Final source reconciliation and publication, the controlled-outage
manifest and activation artifact, offline audit, and live canaries remain gated
and must be recorded before their respective states are declared complete.

## Controlled-outage canary constraint

- Canaries before the rollback decision are read-only against the exact
  migrated manifest. They may verify mounts, identities, preserved status,
  same-topic sharing, cross-topic isolation, Graphify visibility, spawn health,
  and logs, but must not create an unmanifested worktree, commit, fetch or
  advance a canonical, or run cleanup.
- Completed-run rollback re-audits the manifest before its first mutation and
  intentionally fails closed on any post-cutover state. If a canary changes
  repository state despite the constraint, rollback remains blocked until that
  new work is captured into a separate lossless ledger.

## Exact external Git-admin recovery

- Added a hash-bound host-only external-seed path for an exact linked-worktree
  Git admin when cleanup has already removed its original admin directory. The
  selected admin must be an immediate child of the seed common directory's
  `worktrees/` directory; the seed must be a real directory beneath the
  configured recovery root, match its reviewed SHA-256 inventory, pass
  `git fsck --full`, and contain no active `objects/info/alternates` or
  `http-alternates` escape hatch.
- Execution never writes rescue objects or refs into a reviewed seed. Synthetic
  rescues are built in deterministic migration-owned bare stores using a
  process-local object-read path, contain no persisted object alternates, and
  have their directory trees and parent entries fsynced before the `rescued`
  phase is journaled. The external seed digest is persisted in each applicable
  capture and revalidated before lock acquisition and again under the lock
  before the first migration-root mutation; protected seeds are never renamed.
- The successful recovery test regenerates the complete reviewed decision from
  the protected final seed through `createReviewedExactGitAdminRecoveryProposal`
  after the original admin is deleted. Capture, migration, and audit preserve
  HEAD, branch, raw index bytes/mode/auxiliary files, staged and unstaged state,
  untracked files, executable modes, symlinks, and the original broken pointer.
  Hash, path, seed-symlink, post-review mutation, and both object-alternate
  tamper cases fail closed.
- The external-seed regression performs a true child-process exit 86 after the
  durable `rescued` phase, reloads the hash-bound active descriptor, resumes to
  a successful audit, and rolls back while proving the seed digest remains
  unchanged throughout. A post-manifest seed mutation rejects before the
  manifest is durably written.
- Final fresh verification after the immutable-rescue-store correction: 53/53
  migration and recovery tests passed; host TypeScript, candidate Prettier, and
  `git diff --check` passed. Independent adversarial review cleared the final
  blocker. This lane made no live mutation, outage, commit, or push.
