# Server-wide canonical clones with per-topic Git worktrees

Status: approved; implementation in progress

## Summary

- One host-owned canonical clone per `(workgroup, repo)`.
- One linked worktree per `(workgroup, topic/thread, repo)`, created on demand.
- Same-topic sibling agents share that worktree.
- Different topics receive different checkout paths, branches, HEADs, indexes,
  and Git administration directories.
- Per-workgroup claims remain optional coordination inside a shared topic worktree;
  they are not the isolation mechanism.
- Preserve all existing Git-visible work through cleanup and migration.

## 1. Back up and clean the abandoned implementation

- Freeze writers to `/home/ubuntu/nanoclaw-v2` and
  `/home/ubuntu/plugins/bootstrap`. This source-maintenance window is separate
  from the fleet outage. Abort if either checkout changes during capture.
- Create timestamped, permission-restricted backups under
  `/home/ubuntu/backups/nanoclaw-worktree-recovery/` containing complete `.git`
  directories, cached and working binary diffs, tracked and non-ignored
  untracked files, NUL-safe status/inventories, mode/type/size/hash/symlink
  manifests, and `dist.wip-backup`.
- Restore each capsule into a disposable checkout and require matching
  checksums, `git fsck --full`, HEAD, status, staged/unstaged diffs, untracked
  inventory, modes, and symlinks.
- Reconstruct NanoClaw from current `HEAD`; then apply the verified 16-file
  pre-implementation unrelated delta plus concurrent Slack, permissions,
  self-mod, delivery, worker/provider-fallback, dashboard, and Observatory work
  captured during the freeze.
- Remove only proven abandoned repository-store paths and hunks. Preserve
  ambiguous hunks as blockers. Never use blanket reset, restore, clean, or
  stash.
- Back up and remove the four abandoned OpenCode snapshot-guard changes from
  Bootstrap.
- Run focused tests and an independent cleanup-diff review. Keep backups until
  the corrected workflow is pushed, activated, stable for at least seven days,
  and explicitly approved for deletion.

## 2. Runtime architecture and interfaces

### Canonical and worktree layout

- Store canonicals outside agent-writable workgroup files at
  `data/repositories/<workgroup>/<repo>`.
- Canonical working trees remain host-only. Graphify reads them on the host.
  Containers receive only their topic worktree at
  `/workspace/worktrees/<repo>` and the canonical Git metadata required by
  linked worktrees.
- Dual-mount the topic worktree root and canonical `.git` at their exact host
  absolute paths inside the container. `create_worktree` operates through those
  exact paths, so standard Git records host-native paths. The agent-facing
  `/workspace/worktrees` path remains stable.
- Use one shared host-created lock inode per canonical. Container creation and
  fetch plus host refresh and cleanup take the same lock.
- Disable automatic Git GC while worktrees are active; cleanup and explicit
  maintenance own pruning.

### Topic identity

Use one canonical work-unit resolver for path, branch, mount, Graphify,
cleanup, and transfer, in this order:

1. External platform thread when present.
2. Platform/messaging-group identity for threadless conversations.
3. Stable task anchor for scheduled-task sessions.
4. Session ID for private, administrative, or otherwise unanchored sessions.

Default branch names derive from a stable hash of
`(workgroup, work-unit, repo)`, never agent/session identity. Existing
worktrees are never automatically rebased or branch-switched.

### Existing MCP tools

Keep `clone_repo`, `create_worktree`, `git_commit`, `git_push`, and `open_pr`.

`clone_repo`:

- performs authenticated network cloning inside the requesting container
  through its scoped OneCLI identity;
- clones into a request-specific staging directory;
- publishes through a narrow, durable, idempotent host action rather than the
  synchronous 30-second CLI bridge;
- validates origin and repository identity, atomically publishes the host
  canonical, then quiesces and respawns the workgroup so every sibling receives
  consistent mounts (the #655 fix narrowed this to the requester's thread; other
  threads see the canonical at their next container start); and
- stores credential-free origin pins atomically in a host-only directory.

`create_worktree`:

- fetches the pinned origin through the requesting container's scoped OneCLI
  identity;
- resolves the remote default from `origin/HEAD`;
- creates a standard linked worktree at the exact host-native topic path under
  the shared lock;
- idempotently reuses the same-topic checkout and refuses an explicitly
  requested branch already owned by another worktree; and
- emits a nonblocking host refresh marker so the canonical/Graphify copy
  advances locally from fetched refs. Refresh failure is surfaced rather than
  reported as fresh.

Host Git never falls back to ambient credentials. Network operations remain
scoped to the requesting container; host actions operate on validated local
objects and pinned origins.

### Topic transfer

Extend `create_worktree` with optional `continueFromThreadId`.

- Acquire source and destination lifecycle claims in stable order, followed by
  the repository lock.
- Require every sibling session in the source topic to be non-running,
  non-spawning, non-processing, and free of active tools or continuations.
- Require an empty destination and matching workgroup/canonical.
- Move the exact linked worktree and preserve branch/detached state, index,
  staged/unstaged changes, untracked files, and modes.
- Atomically record a host-only transfer tombstone consulted by spawn, create,
  cleanup, reverse transfer, and crash recovery.
- The source topic may not silently recreate the transferred branch.

## 3. Lossless server-wide migration

### Before the outage

- Implement and test in an isolated NanoClaw development worktree.
- Forward-replace committed mirror/standalone behavior without rewriting Git
  history.
- Inventory every canonical, mirror, standalone clone, group-local clone, and
  thread/session checkout.
- Measure allocated bytes on the actual filesystem. Include existing retained
  topology, source and migration backups, canonical/object import, one rescue
  bundle per repository, renamed-old plus replacement overlap, journal/temp
  files, filesystem overhead, and a safety margin.
- Process repositories serially and refuse before the first mutation if the
  upper bound fails.

### Controlled outage

- Stop admission, the service, and containers; recursively prove no repository
  writers remain.
- Back up DB/config and regenerate a hash-bound execution manifest under
  quiescence.
- For every physical checkout capture original branch/detached state, HEAD,
  raw index state/tree, NUL-safe tracked/untracked classification, working-tree
  bytes, modes, and symlinks. Use explicit `--git-dir`, `--work-tree`, and
  temporary indexes rather than trusting collided admin back-pointers.
- Wrap original HEAD, index tree, and full non-ignored worktree tree in
  synthetic commits under unique rescue refs.
- Import every reachable object into the selected workgroup canonical and emit
  one deduplicated external bundle per repository.
- Deduplicate same-topic physical checkouts. If different topics claim the same
  branch, record the original name and assign unique work-unit branches because
  Git forbids one branch in two worktrees.
- Convert dirty canonicals into named rescue worktrees before cleaning the host
  canonical. Convert normal legacy clones in place. For mirror-backed
  workgroups, import mirror and standalone refs into the validated normal
  snapshot before selecting it as canonical.
- For each checkout, rename the old directory aside, create the correct linked
  worktree, restore exact HEAD/index/worktree state, and verify status/hashes.
- Keep the entire renamed old topology through offline audit and live canaries.
  Do not reconstruct rollback from bundles during an incident.
- Journal every durable boundary and resume idempotently. Any failure restores
  that repository's original paths and keeps the fleet stopped.

### Activation

The offline audit must prove:

- exactly one canonical per workgroup/repository;
- different topics have different host paths and Git admin directories;
- same-topic siblings resolve the same worktree;
- no active topic worktree contains a standalone `.git` directory;
- no live bare-mirror topology remains;
- every migrated HEAD, index, staged/unstaged/untracked classification, mode,
  and status matches its manifest; and
- cross-workgroup paths and mounts fail closed.

Activate a temporary-worktree-built host distribution. Canary two active
workgroups and one formerly legacy workgroup before releasing the fleet. Verify
mounts, preserved statuses, same-topic sharing, cross-topic isolation, host
cleanup visibility, Graphify scoping, container spawns, and logs. Rollback
restores the prior distribution and renamed topology while the service remains
stopped.

## 4. Executable acceptance cases

- `same-topic-siblings-share-one-worktree`
- `different-topics-have-distinct-path-head-index-and-admin-dir`
- `branch-switch-or-commit-in-one-topic-does-not-affect-another`
- `threadless-task-and-private-sessions-resolve-distinct-work-units`
- `canonical-working-tree-is-not-container-accessible`
- `linked-worktree-fetch-commit-push-works-through-scoped-git-metadata`
- `origin-pin-drift-symlink-escape-cross-workgroup-and-invalid-name-fail-closed`
- `clone-is-idempotent-and-conflicting-origin-rejects`
- `clone-publication-is-crash-resumable-and-workgroup-mounts-remain-consistent`
- `new-worktree-starts-at-fresh-origin-head-and-existing-worktree-is-untouched`
- `transfer-preserves-exact-state-and-active-source-rejects-without-mutation`
- `host-list-move-remove-works-with-container-created-host-native-metadata`
- `migration-recovers-the-live-Madison-shared-admin-collision`
- `migration-preserves-dirty-staged-unstaged-untracked-detached-and-unpushed-state`
- `migration-resumes-or-rolls-back-at-every-durable-boundary`
- `capacity-gate-rejects-before-mutation`
- `source-cleanup-preserves-the-ledger-and-removes-only-abandoned-work`

Fresh focused tests, both TypeScript checks, the full host and Bun suites,
`git diff --check`, a temporary host build, independent implementation review,
offline audit, and live canaries must all pass.

## Review and assumptions

- The independent subagent returned eight blocking findings and one rollback
  improvement; all were accepted and incorporated.
- Cross-model Claude review did not run because the current Git guard blocked
  the review prompt itself. Independent same-model coverage is accepted by the
  user.
- Ignored build caches are intentionally excluded; all Git-visible work is
  preserved.
- Claims remain single-workgroup coordination inside a shared topic worktree.
- Source-checkout writer freezing is separate from the final fleet outage.
