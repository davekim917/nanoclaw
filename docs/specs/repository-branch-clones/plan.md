# Repository branch clones and shared node_modules

**Status:** APPROVED, revision 2 (2026-09-10, operator), with build-time criterion corrections
rev 2.1: §5.7.3 optional packages, §5.7.4 recovery, the §5.7.5 cap, §5.7.8 `off`, and P1-4/9/19–21.
None changes intent, scope, or an invariant (see `run.md`). Implementation-review corrections
rev 2.2 are in §5.7.3–§5.7.5 and §5.7.8, and add P1-10's second case plus P1-22–25. Rev 2.3
(NEW-1, approved by the operator) bounds content reads by the cap and adds P1-26. It applies the plan-review corrections
M1–M7 plus S2, S5, and S6 (see `run.md`). The corrections themselves are cross-model reviewed
at `/team-review --implementation`. Build order: Phase 1, then Phase 2 after Phase 1 is applied.
Rev 2.7 (2026-09-11, operator decision after the PR #657 review) drops the host's refresh from a
clone: containers fetch into the canonical instead, as linked worktrees do (§5.3, §5.4, §5.5,
P2-8, P2-9).

**Change type:** behavior-changing. The acceptance criteria in §9 are the exact test cases
`/team-build` materializes first.

## 1. Outcome

Agents working in the same chat thread, or in different threads, never block each other on a
repository checkout, and never clobber each other's branch. A dependency install for a given
lockfile exists on disk once per workgroup, not once per workspace.

Two changes deliver this, each shippable and reversible on its own:

- **Phase 1: shared `node_modules`.** One read-only copy per lockfile, hardlinked into each
  workspace ("farm"). Works with today's worktrees.
- **Phase 2: branch clones.** Each (thread, branch) gets an independent Git clone instead of a
  shared linked worktree. Git history is shared on disk through hardlinks, and any number of
  checkouts may hold the same branch.

**Phase 3** (a separate plan, gated on §5.10) migrates the remaining linked worktrees and deletes
the linked-worktree machinery.

## 2. Scope

In scope:

- Host-side dependency cache for npm projects: key, verify, adopt, convert-to-farm, link, seal,
  tamper check, and GC.
- Host-side creation and full initialization of independent clones per (thread, branch). This
  covers the `create_worktree`/`git_commit`/`git_push`/`open_pr` tool changes, clone GC, and
  keeping the canonical current through container-side fetches, as linked worktrees do (rev 2.7).
- One checkout-layout primitive and one disposability primitive, used by every scanner.
- Byte accounting that stays correct with hardlinks.
- Agent-facing tool descriptions and instruction text.

Non-goals, each with the trigger that would reopen it:

- **Copy-on-write filesystem (XFS/Btrfs).** ext4 cannot reflink (verified, §4.6). Reopen if
  workspace setup time or host install load becomes the bottleneck, or disk passes 60%.
- **A guard that intercepts raw `npm ci`/`npm install`, or `chmod` under `node_modules`.** Reopen
  on either of two triggers:
  - the Phase 1 report shows more than 15 private trees or more than 15 GB of private
    `node_modules` in mounted topics on 3 consecutive days;
  - any tamper quarantine happens in production.

  The pattern to follow would be `managed-git-guard.ts`: three wiring sites plus the parity test
  (§4.5).
- **Root-owned cache files through a privileged helper.** Reopen on the first tamper quarantine
  in production (§5.7.6).
- **Sharing for pnpm, yarn, bun, and npm-workspaces projects.** Those keep today's behavior.
- **Converting linked worktrees in place.** That is Phase 3 (§5.10).
- **Removing publish quiescence and canonical mounts.** Also Phase 3.
- **Changing work-unit resolution.** The thread stays the unit (`src/repository-workspaces.ts:277-307`).
- **Hosts whose containers do not run as the host uid.** Clone mode refuses to enable there
  (§5.2).

## 3. Requirements and invariants

- **R1 Independence.** A checkout for branch B in thread T is unaffected by any other checkout:
  different branch, same branch in another thread, or another repo. Two threads can both have B
  checked out. A checkout request is never delayed by an unrelated repository job.
- **R2 Same-thread sharing.** Siblings in one thread asking for the same (repo, branch) get the
  same checkout path, including while that checkout is still being created.
- **R3 No silent branch switch.** A tool never changes the branch of an existing checkout. If a
  checkout's current branch differs from its recorded branch, the tool reports it and never
  serves that checkout for a different branch.
- **R4 Lossless start.** A new checkout for B starts from the most complete known state (§5.2),
  including committed-but-unpushed legacy work in canonical `refs/heads/B`, and reports which
  source it used.
- **R5 One dependency copy per lockfile per workgroup.** An eligible npm project's
  `node_modules` in a workspace is, once the topic is idle, either a farm of the verified sealed
  entry for its key or the source of that entry.
- **R6 Shared bytes are never edited in place or trusted when incomplete.** Sealed files are
  read-only, and a sealed entry's inventory is verified before every use. Any modification,
  deletion, or mismatch quarantines the entry, which is then never linked again.
- **R7 Workgroup isolation.** Cache entries and clones never cross workgroups.
- **R8 No lost work.** Conversion, adoption, clone creation, and GC never delete uncommitted,
  unpushed, or stashed work, including private files under `node_modules`. Every multi-step
  mutation is crash-safe and recoverable, however many times it is interrupted.
- **R9 Accurate reclaim numbers.** Per-candidate reclaimable bytes exclude files that are still
  hardlinked elsewhere.
- **R10 Legacy keeps working.** Existing linked worktrees keep working unchanged, including
  transfer, and so do local-only (no-origin) canonicals. Clones created in clone mode stay
  usable after a rollback to worktree mode.

**Invariant ownership.** Each invariant is enforced in exactly one primitive:

| Invariant | Primitive |
|---|---|
| Checkout naming, parsing, and enumeration | `checkoutDirName` / `parseCheckoutDirName` / `listTopicCheckouts` (§5.1) |
| Disposability | `proveCheckoutDisposable` (§5.8) |
| Clone creation and initialization | the `repository_checkout` host action, on its own lane (§5.2) |
| Shape- and branch-aware resolution | `resolveCheckout` (§5.3) |
| Verify, adopt, convert, link, seal, and recovery | `src/dependency-cache.ts` (§5.7) |
| Reclaimable bytes | `dirSizeBytes` (§5.8) |

No call site re-derives any of these.

## 4. Current architecture (evidence)

### 4.1 Topology

There is one canonical clone per (workgroup, repo) at `data/repositories/<wg>/<repo>`. There is
one linked worktree per (workgroup, thread, repo) at
`data/v2-topics/<wg>/<kind>-<id>/worktrees/<repo>`. Same-thread siblings share it
(`docs/specs/server-wide-repository-workspaces/plan.md:1-14`). The work unit is keyed by
(platform, thread) (`src/repository-workspaces.ts:286-288`). Canonical metadata is mounted at
exact host paths because a linked worktree's `.git` pointer is absolute
(`server-wide-repository-workspaces/plan.md:53-55`). No alternative topology was recorded as
considered or rejected in that spec.

### 4.2 Why agents block today

- `create_worktree` refuses to switch an existing checkout's branch (`container/agent-runner/src/mcp-tools/git-worktrees.ts:313-320`).
- It refuses a branch checked out by another topic, and points at `continueFromThreadId` (`git-worktrees.ts:501-521`).
- Raw `git worktree add` is denied (`container/agent-runner/src/managed-git-guard.ts:7,320-323`).
- Transfer requires every source session to be idle: not running, spawning, processing, active
  in a tool, or continuing (`src/modules/repository-workspaces/index.ts:382-389`).
- `git_commit` stages everything in the shared checkout (`git-worktrees.ts:732`).

Observed in the last 14 days of transcripts: a checkout was switched to unrelated branches twice
mid-run, putting one commit on the wrong branch (2026-09-04). A transfer timed out twice
(2026-09-06). A transfer failed with `Invalid cross-device link`
(`logs/nanoclaw.error.log:2163`, 2026-09-09).

On 2026-09-10, 99 of 335 host-path topic worktrees had lost their canonical admin dir, so Git
cannot serve them.

### 4.3 Host actions

- **Registration.** `repository_publish`, `repository_refresh`, and `repository_transfer` all run
  on one global FIFO chain (`src/modules/repository-workspaces/job-runner.ts:26-30,44,151-160`),
  with dedup through `inFlight` and a deferred ack (`job-runner.ts:43,142`).
- **Publish** quiesces and restarts every container in the workgroup, and waits for admitted
  tools to finish (`index.ts:608-621`), because every container mounts every canonical.
- **Refresh** fast-forwards the canonical from its own refs (`index.ts:319-346,692-723`). The
  canonical checkout is detached (`index.ts:302,338`).
- **Local-only canonicals** start new worktrees from canonical `HEAD^{commit}` and skip refresh
  (`git-worktrees.ts:465-468,541-547`).
- **Responses.** The helper `response()` writes `repository-action-response-<id>` into the
  requester's inbound (`index.ts:508`).

### 4.4 Container surface

- The topic root is mounted at `/workspace/worktrees` and at its exact host path
  (`src/container-runner.ts:4381-4386`).
- For every canonical: `.git` read-write, control files read-only, lock read-write, pin
  read-only, tombstones read-only (`container-runner.ts:4392-4415`).
- Env: `NANOCLAW_HOST_DATA_DIR`, `NANOCLAW_HOST_TOPIC_WORKTREES_DIR`, `NANOCLAW_WORK_UNIT_KEY`
  (`container-runner.ts:5992-5996`).
- Containers run as the host uid when `containerRunsAsHostUser` (`container-runner.ts:6622-6630`;
  `src/github-token-file.ts:66-68`), with `no-new-privileges` (`container-runner.ts:7003`).
- Tools derive paths in `contextFor` (`git-worktrees.ts:199-255`). Today's resolver refuses a
  checkout whose `.git` is a directory (`git-worktrees.ts:299-307,695-705`).
- A request/response precedent over the session DBs exists: `writeRequest`/`pollResponse`
  (`container/agent-runner/src/cli/ncl.ts:52-95`), with the host writer at
  `src/cli/delivery-action.ts:24,72`.

### 4.5 Guards and instructions

`managed-git-guard.ts` is wired for Claude (`providers/claude.ts:2555`), Codex
(`codex-hooks/runner.ts:399`), and OpenCode (`providers/opencode.ts:925`). Parity is pinned by
`managed-git-guard.test.ts:153-174`.

Agent-facing repo text lives in:

- `container/CLAUDE.md:73-75`
- the tool descriptions in `git-worktrees.ts`
- `container/skills/smoke-test/SKILL.md:321-329`

It is pinned by `instruction-fragment-migration.test.ts:123-148`. Codex trusts
`/workspace/worktrees` (`src/providers/codex.ts:51,81`). No instruction tells agents to run
`npm ci`. They do it on their own.

### 4.6 Storage and filesystem facts (measured on this host, 2026-09-10)

- **Filesystem.** The host is a single ext4 disk, 2.0 TB, 21% used. `cp --reflink=always` fails
  with "Operation not supported". `fs.protected_hardlinks=1`. `link(2)` fails with `EXDEV` across
  different mounts even on the same filesystem (`man 2 link`). No path under `data/` resolves
  through the second mount of the root filesystem.
- **Local clones.** `git clone --local` hardlinks packs (link count 2), and two independent
  clones can check out the same branch. **`git clone <canonical>` maps the canonical's
  `refs/heads/*` into the clone's `refs/remotes/origin/*`**, and a non-pruning local fetch leaves
  them there (verified with a scratch repo).
- **`node_modules` today.** 43 trees under topics use about 26 GB. In the largest JS repository,
  280 worktrees contain exactly 2 distinct backend lockfiles and 2 distinct frontend lockfiles.
  Its backend `node_modules` has 56,458 files and 6,784 dirs. `cp -al` of it takes 1.9 s and uses
  27 MB of new blocks. The frontend uses vite, whose default cache dir is `node_modules/.vite`.
- **Read-only hardlinked farm experiments:**
  - an in-place write fails with EACCES;
  - creating a new file works;
  - `npm ci` works and leaves the cache intact;
  - `npm install <new pkg>` works;
  - a no-op `npm install` works;
  - npm replaces `.package-lock.json` instead of editing it in place.
- **Cleanup.** `isLinkedToCanonical` refuses a clone-shaped checkout (`src/worktree-cleanup.ts:439-448,481-484`).
  The orphan-topic loop proves every entry with `provenDisposable(…,'head')`
  (`worktree-cleanup.ts:884-885`), and scope `'all'` adds the `--branches` check
  (`worktree-cleanup.ts:649-655`). Both scopes trust `--remotes`.
- **Byte accounting.** `dirSizeBytes` sums `st.size` and ignores hardlinks (`src/storage-manager.ts:674-700`).
- **Regenerable sweep.** It deletes `node_modules` idle for 2 days or more when a lockfile sits
  beside it and it is not mounted (`storage-manager.ts:2057-2062,2075-2098,2238-2268,2328-2416`).
- **Ownership.** None of the repository-workspace files are upstream-owned (checked against `src/upstream-ratchet.json`).

## 5. Design

### 5.1 Checkout layout primitive

The layout is `worktrees/<repo>` for the thread's primary checkout and `worktrees/<repo>@<slug>`
for any other branch. `@` falls outside the repository-name charset
(`src/repository-workspaces.ts:16`), so parsing is unambiguous. The host-owned staging area is
`worktrees/.staging/`. **Build rev 2.5:** staging moved to `<topic>/checkout-staging/`, beside
`worktrees/` and outside every container mount; wherever this plan says `.staging`, read that
(run.md, "Phase 2 integration").

- **`checkoutDirName(repo, branch | null)`.**
  - With `null`, it returns `<repo>`.
  - Otherwise it returns `<repo>@<slug>`. The slug is the branch with every character outside
    `[A-Za-z0-9._-]` replaced by `-`, leading non-alphanumerics stripped, and truncated to 80
    characters. When the slug differs from the branch, `-<first 8 hex of sha256(branch)>` is
    appended, so `feat/x` and `feat-x` never collide.
- **`parseCheckoutDirName(name)`** returns `{repo, slug|null}` or `null`. It returns `null` for
  every dot-prefixed name, including `.staging` and `.pnpm-store`.
- **`listTopicCheckouts(topicWorktreesDir)`** returns
  `{name, repo, slug, path, shape: 'clone'|'linked'|'unknown'}[]`, only for names that parse. The
  shape is decided by whether `.git` is a directory or a file, and a missing `.git` gives
  `unknown`. It is the only enumerator: worktree cleanup discovery, orphan-topic GC, the
  dependency sweep, and the tools all go through it.

The host copy lives in `src/repository-workspaces.ts`. The container copy lives in
`container/agent-runner/src/mcp-tools/checkout-layout.ts`, duplicated on purpose like
`managed-git-command-guard.ts`. Both are pinned by one vector file,
`container/agent-runner/src/mcp-tools/checkout-layout.fixtures.json`, which both test suites
read.

Which checkout serves `(repo, branch)`, for both creation and resolution:

1. No branch: `<repo>`.
2. `<repo>` does not exist yet: `<repo>`, created on `branch`.
3. `<repo>`'s recorded branch (for a clone) or current branch (for a linked worktree) is
   `branch`: `<repo>`.
4. Otherwise: `<repo>@<slug>`.

### 5.2 Clone creation: the `repository_checkout` host action

**Lane (M6).** `repository_checkout` is registered as a delivery action, but its jobs run on a
lane keyed by (workgroup, work unit), not on the global FIFO. `job-runner.ts` gains a lane key:
chains are held in a map, and the `inFlight` dedup and deferred ack are unchanged. The existing
three actions keep the `'global'` lane. Requests from one work unit are serialized, which gives
R2 during creation. Requests from different work units run in parallel. The handler takes
`withRepositoryLifecycleClaims([unit])` and the repo flock, and never quiesces. If the claim is
held by a transfer or by cleanup, it responds `{ok:false, retryable:true}`, and the tool retries
once after 5 s.

**Preconditions.**

- The session maps to a workgroup and work unit through the trusted DB. Payload paths are never
  trusted.
- The repo name is valid, the canonical and its pin exist, and `containerRunsAsHostUser()` is
  true. Clone mode refuses to enable at host start otherwise, so host-created files are always
  owned by the container uid.

**Existing directory.**

1. Validate its shape through `resolveCheckout` rules (§5.3).
2. Enforce R3.
3. Link nothing (build rev 2.6). A published checkout is live and container-writable, so the host
   writes no farm into it; a lost farm is reinstalled by npm and converted by the sweep once the
   topic is idle.
4. Respond `{ok, path, branch, created:false}`.

**New directory: the host fully initializes it, then publishes (M5).**

1. `git clone --no-checkout <canonical> worktrees/.staging/<requestId>/<name>`. This is an
   implicit local clone: objects are hardlinked, with a copy fallback. Record `objectsLinked`
   from a pack's link count.
2. **Remote-ref hygiene (M2).** Delete every `refs/remotes/origin/*` in the clone. Then:
   - **network pin:** local-fetch the canonical's `refs/remotes/origin/*` into the clone's
     `refs/remotes/origin/*`, copy `origin/HEAD`, and set `remote.origin.url` to the pin. The
     clone's remote-tracking set then equals the canonical's exactly.
   - **local-only pin (M7):** remove `origin` entirely, so the clone has no remote refs.
3. **Start point (R4).**
   - Canonical `refs/heads/B` exists: copy it to local `B` (committed legacy work stays reachable).
   - Else `origin/B` exists: create local `B` at `origin/B` with upstream set.
   - Else: create `B` at `origin/HEAD` (network pin) or at canonical `HEAD^{commit}` (local-only,
     today's rule at `git-worktrees.ts:465-468`).
4. `git checkout B` to materialize the working tree. Set `gc.auto=0`. Write
   `.git/nanoclaw-checkout.json`: `{version:1, repo, branch:B, startCommit, startedFrom:'canonical-local'|'origin-branch'|'origin-head'|'local-head'}`.
5. Link dependency farms for package dirs with a verified sealed entry (§5.7.4). The manifests
   exist now, because the working tree has been checked out.
6. Rename `.staging/<requestId>/<name>` to `worktrees/<name>` atomically (same directory tree),
   fsync the parent, and remove the empty staging dir.
7. Respond `{ok, path, branch:B, created:true, startedFrom, objectsLinked, farmsLinked}`.

Any failure removes that request's staging dir and mutates nothing else. A crash leaves only
`.staging/<requestId>`, which no lister returns. A staging entry older than 1 h with no in-flight
job on its lane is deleted by the next checkout or sweep pass. Readiness is existence: a checkout
is published only once it is fully initialized.

Clone creation runs on the host because inside a container the canonical and the topic root are
different bind mounts. `link(2)` would return `EXDEV` and Git would copy every object into every
clone (§4.6).

### 5.3 Container tools

**Mode flag (M1).** `NANOCLAW_CHECKOUT_MODE=worktree|clone` controls creation only.

- In `worktree` mode, new checkouts are linked worktrees, created exactly as today.
- In `clone` mode, new checkouts go through `repository_checkout`.
- Resolution is shape-aware and branch-aware in both modes, so clones stay fully usable after a
  rollback to `worktree` mode.

**`resolveCheckout(repo, branch?)`** picks the checkout with the §5.1 rule, without creating
anything:

- **Clone:** the recorded branch must equal the current branch (R3), and `remote.origin.url`
  must equal the pin for a network pin or be absent for a local-only one.
- **Linked worktree:** today's validation (`git-worktrees.ts:299-324`).
- **Unknown shape or mismatch:** an error, with nothing mutated.

**`create_worktree` in `clone` mode:**

1. Network pin only: fetch origin into the canonical (§5.5). Then write `repository_checkout`.
2. Poll for `repository-action-response-<requestId>` for up to 120 s, through a new mailbox op
   `findRepositoryActionResponse` that mirrors `findCliResponse` (`ncl.ts:75-95`). On a retryable
   error, retry once.
3. **Network pin only, under the per-checkout lock (idempotent):**
   1. `git fetch origin --prune` with the container's scoped identity.
   2. When the checkout is pristine (HEAD equals `startCommit` and status is clean), move it to
      fresh remote state:
      - `startedFrom:'origin-branch'`: fast-forward to `origin/B` if that is a descendant.
      - `startedFrom:'origin-head'`: `reset --keep` to the fresh `origin/HEAD`.

      Then update `startCommit`.
   3. When the checkout is not pristine, or `startedFrom` is `'canonical-local'`, never move it.
      Report "left as-is", and whether `origin/B` diverged.
   4. Emit `repository_refresh`. It names no checkout (§5.5, rev 2.7).
4. Local-only pins skip step 3 entirely, including refresh (today's `git-worktrees.ts:541-547`).
5. Return the path, the branch, and the start-point note.

A late host completion after a tool timeout is harmless: the next call finds the initialized
checkout and gets `created:false`. `continueFromThreadId` remains in its legacy-only meaning
(R10).

**`git_commit`, `git_push`, `open_pr`** gain an optional `branch` parameter that selects the
checkout through `resolveCheckout`, defaulting to `<repo>`. `capturedIdentity` and the refspec
push are unchanged. Push and PR stay refused for local-only pins, as today. After a clone's push,
the canonical fetches origin, then a refresh is queued (§5.5).

**Locking.**

- A linked checkout keeps the canonical lock (`git-worktrees.ts:269-293`).
- A clone uses the same flock loop on `<checkout>/.git/nanoclaw-checkout.lock`, created on demand
  inside the clone, with no host mount.

### 5.4 Mounts

No mount changes in Phase 2. Clone-mode tools use the canonical mount only to fetch origin into it
(§5.5, rev 2.7). Removing that mount belongs to Phase 3.

### 5.5 Canonical freshness (S5, rev 2.7)

Containers keep the canonical current by fetching into it, exactly as linked worktrees do today:
`git fetch origin --prune`, then `git remote set-head origin --auto`, under the canonical's
repository lock. That fetch is one container helper (`fetchCanonical` in `git-worktrees.ts`), and
it runs in three places:

- a linked `create_worktree`, as today;
- a clone-mode `create_worktree`, before `repository_checkout` is written, so the host stages from
  current refs and starts B from `origin/B` when another thread already pushed it;
- after a clone's `git_push`, so the canonical learns the pushed branch. The fetch runs once the
  clone's lock is released, so the two locks never nest. The push has already landed, so a failed
  fetch is reported in the tool result, not raised.

The fetch goes through the canonical Git mount. In both checkout modes, its config, HEAD, index,
hooks and `objects/info` are read-only overlays (`container-runner.ts` `canonicalGitControlMounts`,
`:4413`), so a container writes only refs and objects there. Local-only pins fetch nothing and
emit no refresh, as today.

`repository_refresh` carries `{requestId, repo, workUnitKey}`. Refresh never reads or fetches from
an agent checkout; the host still validates reused checkouts and proves cleanup candidates, as it
does for linked worktrees. Refresh moves the canonical's own checkout to `origin/HEAD` from the refs
already there, as it did before Phase 2. A payload that still carries `checkout`, sent by a container that has not restarted since
this change, is a plain refresh.

**Why the host no longer absorbs from a clone.** Rev 2.6 had the host run
`git fetch <clone> 'refs/remotes/origin/*:refs/remotes/origin/*'` into the canonical. A clone's
`.git` is container-writable, and Git follows what it finds there. If a `.git/commondir`, an
`objects/info/alternates` entry or a symlinked `.git/objects` points at another repository, that
fetch copies the other repository's refs and objects. All three routes were reproduced on git 2.43
in a scratch dir, so an agent could pull another workgroup's refs and objects into its own
canonical. The operator dropped absorb on 2026-09-11.

**Residual.** The canonical `.git` is still mounted read-write (`container-runner.ts:4406`), so a
container could plant `commondir` there too. `assertNormalClone` refuses any repository whose
`.git` holds `commondir`, before any host Git command runs. It guards every caller: the canonical
before a clone is staged, refresh, publish and transfer. That is a fail-closed check on a
container-writable mount, not a structural fix. A separate issue tracks the mount.

### 5.6 Publish

Unchanged in Phase 2.

### 5.7 Dependency cache (`src/dependency-cache.ts`)

#### 5.7.1 Eligibility

A package dir qualifies when it has `package.json` without a `workspaces` field and a
`package-lock.json` with `lockfileVersion` ≥ 2.

#### 5.7.2 Key

sha256 over:

- `package-lock.json` bytes;
- `package.json` bytes;
- `.npmrc` bytes from the package dir (empty when absent);
- an environment fingerprint: the agent image's `NODE_VERSION` from `docker image inspect`,
  memoized per host process, plus `linux` and `process.arch`.

The cache root is `data/dependency-cache/<wg>/<key>/`, holding `node_modules/` and `SEALED`.
Everything lives on the same filesystem and mount as `data/v2-topics` (§4.6).

#### 5.7.3 Verified completeness (M4)

A tree is complete when all of these hold:

1. `node_modules/.package-lock.json` exists. Every entry in its `packages` map, minus the root
   entry, exists in `package-lock.json` with equal `{version, resolved, integrity}`. Every
   `package-lock.json` entry absent from the hidden lockfile has `optional: true`. This matches
   npm's own contract: an install is complete even when optional packages are skipped or fail.
   *(Build-time correction, rev 2.1. The literal "maps match" rule refused 34 of 37 real trees.
   A platform-aware variant, which accepts only absent optionals whose `os`/`cpu`/`libc` excludes
   linux-x64-glibc, accepted 12 of 35 against 33 of 35 for optional-only. Some refusals were wrong:
   transitive dependencies of skipped packages, and musl builds whose lockfile entries omit
   `libc`. Others were correct: native binaries really missing, such as `@esbuild/linux-x64` in 14
   trees.)* Optional-only is sufficient in Phase 1 because no Phase 1 operation changes a
   workspace's file set: adopt shares the source tree's own inodes, and convert requires
   byte-for-byte equality (inventory and content manifest). Phase 2's link-at-checkout does hand content to a workspace that never
   installed it, so it needs a strict rule (§5.7.5). The evidence and the platform-aware
   implementation are kept for it.
2. Every package path in that map exists as a directory whose `package.json` `name` and `version`
   match the lockfile entry.
3. No regular file under `node_modules` has an mtime newer than the hidden lockfile's.
4. Every installed package that declares `os` or `cpu` accepts `linux` and `process.arch`. That
   is every entry in the hidden lockfile's `packages` map with those fields. They're matched the
   way npm matches them (npm-install-checks `checkList`): a `!value` naming the platform refuses,
   and otherwise the list must name it, consist only of negations, or be `any`. `libc` is not
   checked, because real trees hold the -gnu and -musl builds of a native package side by side.
   *(Report-mode correction, rev 2.4.)*
   - **What the first report pass found.** 12 of 37 topic installs held arm64 native packages
     under keys whose fingerprint says x64: the same lockfile, installed for another CPU. Rules 1–3
     accept them, so a first-come adopt could seal an arm64 entry for an x64 key. Every x64 tree
     would then mismatch that entry forever, and Phase 2's link would hand arm64 binaries to an
     x64 workspace.
   - **Why this rule has no false refusals.** It checks installed packages, not absent ones, so
     the refusals described under rule 1 can't occur. Without `--force`, npm never installs a
     package whose `os`/`cpu` excludes the platform it installs for.

Root-level dot entries other than `.bin` and `.package-lock.json`, such as `.vite` and `.cache`,
are workspace-private. They are excluded from every check and never shared.

The hidden lockfile `.package-lock.json` is checked like any other file but is **never
hardlinked**. npm rewrites it in place on every reify (`@npmcli/arborist` `reify.js:254` →
`shrinkwrap.js:1164`), and on a read-only shared inode npm unlinks it instead. Every farm and
adopted source therefore keeps its own writable copy, with its mtime preserved (rev 2.2).

An **inventory** is the sorted list of `(relative path, type, size)` for every regular file and
symlink, private dot entries excluded. A **content manifest** adds each item's sha256 (for a
symlink, its target string) and its executable bits. It is computed only when a tree is adopted
or converted (rev 2.2).

#### 5.7.4 Operations

All operations are host-side, on one mount, and use `cp -al` semantics.

- **Verify entry.** This is the precondition of every link, convert, and GC decision. It walks
  the entry once and checks all of the following:
  - no write permission bits;
  - no mtime later than `sealedAt`;
  - the inventory equals the one recorded in `SEALED`.

  Any failure quarantines the entry (§5.7.6).
- **Adopt.** For a complete, untampered tree with no sealed entry for its key:
  1. link it into `<key>.tmp/node_modules`, skipping private dot entries, and copying the
     hidden lockfile instead of linking it;
  2. `chmod a-w` every regular file in the entry;
  3. write `SEALED` with the key inputs, the source, `sealedAt`, the inventory with its sha256,
     and the content manifest's sha256 (from one read of the tree);
  4. rename `<key>.tmp` to `<key>`.

  A link failure (`EPERM`/`EXDEV`) aborts with the tree untouched and a WARN.
- **Convert (M3).** For a complete private tree whose key has a verified entry, and whose
  inventory and content manifest both equal the entry's, so only byte-identical installs merge
  (rev 2.2). On any mismatch the tree is kept private, with a WARN and a `convert-mismatch`
  count. Otherwise:
  1. link the entry to `<pkg>/.node_modules.nanoclaw-new`. This dir only ever holds shared farm
     links and a copy of the entry's hidden lockfile, never private bytes;
  2. rename `node_modules` to `<pkg>/.node_modules.nanoclaw-old`;
  3. rename `.new` to `node_modules`;
  4. move each private root dot entry from `.old` into `node_modules`, one rename each;
  5. delete `.old` only when it holds no private root dot entry.
- **Recovery**, run first on every pass for every package dir that has either temp name:
  - `node_modules` missing and `.old` present: rename `.old` back. Private entries have not moved
    yet, because step 4 only runs after step 3.
  - `node_modules` and `.old` both present: finish steps 4 and 5. If a private name already exists
    in `node_modules`, keep `.old`, WARN, and stop.
  - `.new` present and `node_modules` present: delete `.new` (farm links only).
  - `.new` present, `node_modules` missing, `.old` missing: rename `.new` to `node_modules` only
    if its inventory equals a verified entry's, otherwise delete it. A crash mid-link must never
    publish a half-built farm. With no fingerprint this case is skipped, with a WARN.

  Recovery is idempotent. After a crash at step 1 or 2 it restores the original private tree.
  After step 3, or midway through step 4, it completes the move. The same pass may then convert
  again.
- **Link.** For a package dir with no `node_modules` whose key has a verified entry: link it to
  `.new`, then rename to `node_modules`.
- **Already a farm.** The first regular file in the entry's inventory, other than the hidden
  lockfile, shares its inode with the workspace's copy. Nothing to do.

#### 5.7.5 Triggers

- **Phase 1:** the topic regenerable sweep, hourly per `scanCadenceMs`. It runs recovery, then
  adopt or convert, on eligible npm trees that pass the existing "not under a live container
  mount" and storage-claim eligibility. These operations preserve content, so no idle-days
  threshold applies. Farms are exempt from the 2-day delete. That rule still applies to
  non-eligible trees and to farms of quarantined entries.
- **Per-pass cap:** at most `DEPENDENCY_CACHE_MAX_MUTATIONS_PER_PASS = 5` adopts plus converts per
  pass, which bounds the first `apply` pass (about 37 trees at about 4–6 s of metadata I/O each)
  on the production disk. Further eligible trees are counted as `deferred` and follow today's
  delete rule until a later pass takes them. Recovery, verification, and GC are uncapped. The
  pass runs in the storage maintenance worker thread (`src/storage-maintenance-worker.ts`), off
  the host event loop. Each adopt or convert also reads its tree once to hash contents.
  **The cap counts content reads (rev 2.3, NEW-1).** Every adopt and every convert attempt that
  reads a tree's bytes takes a slot, including one that ends in `convert-mismatch`. A
  content-mismatch verdict is remembered, keyed by the package dir, its inventory sha, its
  hidden-lockfile mtime, and the entry's content sha, so an unchanged mismatched tree is never
  read again. Each pass reports a `contentReads` counter.
- **Pending conversions are never swept (rev 2.2):** in any flag mode, the 2-day delete never
  removes a `node_modules` whose package dir holds `.node_modules.nanoclaw-new` or
  `.node_modules.nanoclaw-old`. The regenerable delete action enforces this in its apply-time
  recheck under the claim, so recovery always finds what it needs.
- **Phase 2:** additionally, **link** during `repository_checkout` (§5.2 step 5, and reuse).
  Linking gives a workspace content it did not install, so the entry must first pass a strict
  completeness rule: no absent optional that this platform would install. Its exact definition
  belongs to the Phase 2 build, informed by the rev 2.1 evidence. That evidence covers the
  transitive-skip and musl-without-`libc` false refusals, and the native binaries really missing
  from production trees.

#### 5.7.6 Seal and tamper

Verify-entry failures quarantine: the entry is renamed to `<key>.quarantined-<ts>` with a WARN
naming the first offending path, and it is never linked again. The next complete private tree
for the key re-adopts. Farms of a quarantined entry are deleted at the next idle sweep, since the
lockfile beside them makes them regenerable.

Enforcement is by permission bits because agents share the host uid, so this is proof against
accidents, not a security boundary. The residual risk is an agent that `chmod`s and edits a
shared file. Other active workspaces read that edit until the next verify, which runs at every
link or convert and at least hourly. The instructions (§5.9) tell agents never to `chmod`
`node_modules`. The escalation trigger is the first quarantine (§2).

#### 5.7.7 Cache GC

Delete an entry when every regular file has `nlink==1` (no farm shares it) and it is at least 14
days past `sealedAt` or its last link. Quarantined entries go after 7 days.

#### 5.7.8 Flag

`NANOCLAW_DEPENDENCY_CACHE=off|report|apply`, default `off`, read at policy resolution like
`NANOCLAW_REGENERABLE_SWEEP_DAYS`.

- **`apply`:** recovery, adopt, convert, the farm exemption, and GC.
- **`report`:** logs every decision an `apply` pass would make, including recovery and GC, plus
  the estimated bytes. On a cold cache, a key the pass would adopt counts as sealed for later
  trees, so the report shows the real adopt-then-convert split (rev 2.2). It mutates nothing,
  including recovery, which waits for `apply` or `off`. Pending conversions are protected from
  the delete (§5.7.5). Otherwise today's delete behavior applies, following the
  `NANOCLAW_STORAGE_GC` convention.
- **`off`:** no new sharing (no adopt, convert, link, or farm exemption). An applying storage
  pass still runs **recovery** and **cache GC**, so a rollback never strands an interrupted
  conversion and entries age out (§7). On a host that never enabled the cache, both are no-ops.

### 5.8 GC and accounting

- **`dirSizeBytes`** counts `st.size` only for regular files with `nlink===1`. Deleting a path
  cannot free bytes another link still holds (R9). Real usage keeps coming from `df`
  (`storage-manager.ts:651-663`).
- **`proveCheckoutDisposable(checkout)` (M2)** is the one disposability primitive:
  - `clone` → `provenDisposable(path,'all')`. Invariant: every local ref's commits must be on
    origin. `git log --all HEAD --not --remotes=origin` counts HEAD, every branch, tag, note and
    replace ref, the stash and other remotes' refs against origin's remote-tracking refs only
    (`--remotes=origin`, build rev 2.6; `--all` since the PR #657 review round 2, because
    `--branches HEAD` read a commit only a tag reached as pushed). `HEAD` stays named, so an
    unborn HEAD is unprovable. The stash is read first and keeps its own reason. A clone keeps the
    canonical's tags (§5.2 step 1 deletes only heads and remote refs). Since #672 a tag the clone
    holds unchanged from its canonical, the same name at the same object, is dropped from the
    roots, and the rest go to `git log HEAD --stdin --not --remotes=origin`. The canonical's tag
    targets are not subtracted: a sibling topic can write the canonical's refs, and a tag it
    planted on this clone's branch commit would read that branch as pushed. An unreadable
    canonical, or one holding `commondir`, withdraws the exemption, fail-closed;
  - `linked` → `provenDisposable(path,'head')`, as today;
  - `unknown` → refuse, fail-closed.

  Every caller uses it: the orphan-topic loop (today `'head'` for every entry,
  `worktree-cleanup.ts:884-885`), the new clone branch of worktree cleanup, and the post-move
  re-proof. `.staging` and other non-parsing names are not checkouts. `.staging` is host-owned and
  goes with its topic. Any other non-parsing entry keeps today's behavior: it is probed and refuses
  the topic.
- **Clone cleanup branch.** For `shape==='clone'`: the existing topic side-(a) evidence, 7 or more
  days idle, `proveCheckoutDisposable`, then quarantine-then-trash as in `finalizeCloneCollection`
  (`worktree-cleanup.ts:1733-1793`). The linked path is unchanged.
- **Why the `--remotes` proof holds for clones.** Remote-ref hygiene (§5.2 step 2) guarantees a
  clone's `refs/remotes/origin/*` never contains canonical local branches. Local-only clones have
  no remote refs, so any local ref with commits is "unpushed" and is never collected.
  **Build rev 2.6:** hygiene holds at creation only, because an agent can add remotes or rewrite
  remote-tracking refs later. So the proof trusts only `origin`'s refs and refuses a checkout that
  holds an embedded repository (`submodule`). It also runs nothing the repository configures:
  signature programs are off for every host git call, and every filter the repository defines is
  neutralized by name. An agent that deliberately forges `refs/remotes/origin/*` can still make its
  own unpushed commits look pushed; the trash keeps them for 30 days.
- **No alternates.** Clones never use `objects/info/alternates` (`git clone` without `--shared`),
  so canonical GC cannot break them. This is asserted in §9.

### 5.9 Instructions (S2)

The `create_worktree` description is replaced with one paragraph covering:

- no `branch` gives the thread's checkout at `/workspace/worktrees/<repo>`;
- with `branch`, that branch's own independent checkout (`<repo>` when already on it, otherwise
  `<repo>@<branch>`);
- any number of threads may hold the same branch, and work is shared by pushing;
- never switch the branch of a checkout that others may be using: request the branch instead;
- `node_modules` files may be shared and read-only. Never `chmod` them. Run `npm ci` or
  `npm install` to get a private copy when dependencies must change.

The `git_commit`, `git_push`, and `open_pr` descriptions gain `branch`.
`container/CLAUDE.md:73-75` becomes one line: one checkout per thread and branch under
`/workspace/worktrees/`, never an ad-hoc clone. Update `instruction-fragment-migration.test.ts`,
`docs/workgroups.md:152`, and `CHANGELOG.md`. Tool descriptions stay true in both modes.

### 5.10 Legacy coexistence and the Phase 3 gate (S6)

In `clone` mode, a legacy linked `<repo>` is reused for requests without a branch or with its
own branch. Other branches get clones, and transfer keeps working for linked checkouts. Every
tool resolution logs the checkout's shape.

Phase 3, a separate plan, becomes eligible when two conditions hold:

- no `linked` checkout has been resolved by any tool for 14 consecutive days;
- every remaining linked checkout is listed in an operator triage report, which separates those
  with a missing admin dir.

Phase 3 must include a lossless migrate-linked-to-clone operation. Long-lived topics, such as
`conversation`-kind work units (`src/repository-workspaces.ts:293-295`), otherwise keep their
linked worktree indefinitely. It then deletes:

- worktree-mode creation;
- transfer and tombstones;
- canonical `.git`, control, and lock mounts;
- the container canonical lock;
- the checkout-mode flag.

It also redesigns pin visibility, so publish no longer quiesces the workgroup.

## 6. Alternatives considered

| Option | Verdict | Reason |
|---|---|---|
| Extra linked worktree per branch | Rejected | Keeps cross-thread branch exclusivity, transfer, and shared admin dirs (99 of 335 already unservable). |
| Copy-on-write clones | Deferred | ext4 has no reflink. Needs a new filesystem under production data. Trigger in §2. |
| One shared `node_modules` per repo | Rejected | Branches differ in dependencies. A shared writable `node_modules` broke every session on this host on 2026-08-25. |
| Read-only bind-mount or symlink of the cache | Rejected | `npm ci` and vite's `node_modules/.vite` writes fail. Mount-time binding goes stale when a lockfile changes mid-session. |
| Move the repos to pnpm | Rejected | The repositories' own CI uses npm. The toolchain is not this fleet's to change. |
| Container-side `git clone --local` | Rejected | `EXDEV` across bind mounts means a full object copy per clone. |
| Checkout on the global action FIFO | Rejected | It would queue behind unrelated publish and transfer quiescence (§4.3), which is itself waiting on the requester's in-flight tool. |
| Host publishes a bare clone and the container initializes it | Rejected | A sibling could see an uninitialized checkout on the wrong branch (breaks R2), and farms cannot link without manifests. |
| Guard on raw `npm ci` / `chmod` | Deferred | Idle conversion deduplicates without changing agent behavior. Trigger in §2. |
| Root-owned cache via privileged helper | Deferred | `protected_hardlinks=1` would require root for every link, and no privileged helper exists today. Trigger in §2. |

## 7. Safety, rollout, rollback, observability

**Data-loss boundaries.**

- Adopt only adds links and removes write bits.
- Convert never places private bytes in a disposable temp dir. Recovery completes or reverses
  every interruption point.
- Clone creation writes only inside the caller's own topic `.staging` until a single atomic
  rename.
- Clone GC goes through `proveCheckoutDisposable` (all branches for clones) with
  quarantine-then-trash.
- Nothing deletes a tree that is incomplete, differs from its entry, or sits under a live mount.

**Rollout.**

- **Phase 1.** Deploy with `off`, then `report` for 24 h, reviewing the log against a manual audit
  of 5 trees, including the largest repository's backend (native builds), then `apply`. Record
  `df` before and after, plus counts of private trees, farms, entries, quarantines, and
  convert-mismatches.
- **Phase 2.** Deploy with `worktree` (creation unchanged) and run the full suite. Flip to `clone`
  in a quiet window after an end-to-end smoke in a scratch thread: primary checkout, second
  branch, the same branch from two threads, commit/push/PR against a test repository, and one
  local-only fixture. Watch `logs/nanoclaw.error.log` and create_worktree latency for 48 h.

**Rollback.**

- **Phase 1:** set `off`. Farms are ordinary `node_modules` trees and stay valid. Farms lose their
  exemption and follow the 2-day delete. Recovery and cache GC keep running, so entries age out and
  no interrupted conversion is stranded (§5.7.8).
- **Phase 2:** set `worktree` and restart. Existing clones stay usable, because resolution is
  shape-aware in both modes (P2-18). No data migration either way.

**Observability.**

- A single INFO line per checkout with the lane, mode, `created`, `startedFrom`, `objectsLinked`,
  farms linked, and ms.
- One INFO line per tool resolution with its shape.
- Sweep counters: recovered, adopted, converted, convert-mismatch, linked, quarantined,
  private-in-mounted-topics count and bytes, and the `df` delta.
- WARN on every link failure, quarantine, mismatch, and `objectsLinked:false`.

## 8. Implementation path

Build in a git worktree, never in the live checkout.

### Phase 1: host only, one PR

1. **`src/dependency-cache.ts` and `src/dependency-cache.test.ts`**: eligibility, key and
   fingerprint, verified completeness, inventory, verify entry, adopt, convert with recovery,
   link, quarantine, and cache GC. Tests use real temp dirs with hand-built trees and no network.
2. **`src/storage-manager.ts`**: the `dirSizeBytes` `nlink` rule, sweep integration behind the
   flag (recovery first), the farm exemption from the 2-day delete, cache GC in the same pass, and
   the counters.
3. **Checks:** focused vitest with `--maxWorkers=2`, `pnpm exec tsc --noEmit`, lint, and
   `pnpm run ratchet:report`.

### Phase 2: one PR, after Phase 1 is applied

1. **Layout primitive**, host and container, with the shared fixture file. This lands first
   because every other step depends on it.
2. **Host:**
   - the `job-runner.ts` lane key;
   - the `repository_checkout` handler, including staging, remote-ref hygiene, start point,
     metadata, farm link, and publish;
   - refresh that never reads a checkout, and the `commondir` refusal (rev 2.7);
   - the clone-mode startup precondition (`src/modules/repository-workspaces/index.ts`, `job-runner.ts`).
3. **Container:**
   - `findRepositoryActionResponse`;
   - the clone path of `create_worktree` and its post-step;
   - `resolveCheckout` for both shapes in both modes;
   - the `branch` params, the per-checkout lock, and local-only handling;
   - the mode env (`container/agent-runner/src/mcp-tools/git-worktrees.ts` plus the mailbox ops).
4. **`src/container-runner.ts`**: pass `NANOCLAW_CHECKOUT_MODE`.
5. **`src/worktree-cleanup.ts`**: `proveCheckoutDisposable` used at every call site, the clone
   branch, and lister use in `discover()` and `collectOrphanTopics`.
6. **Instructions:** tool descriptions, `container/CLAUDE.md`, the instruction test, docs, and
   CHANGELOG. Regenerate the ratchet if `container/CLAUDE.md` is upstream-owned.
7. **Checks:** vitest with `--maxWorkers=2`, `cd container/agent-runner && bun test`,
   `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`, and the ratchet report.

Steps 2 and 3 can run in parallel once step 1 is on the branch. They share only the fixture file,
the action payload and response shapes (§5.2), and `nanoclaw-checkout.json` (§5.2 step 4).

## 9. Acceptance criteria (exact test cases)

### Phase 1: `src/dependency-cache.test.ts` unless noted

| # | Test name | Assertion |
|---|---|---|
| P1-1 | `key changes with package-lock, package.json, .npmrc, or node fingerprint and is otherwise stable` | Four single-input mutations give four new keys. Identical inputs give an equal key. |
| P1-2 | `adopts a verified complete private tree as a sealed read-only entry sharing inodes with the source` | Entry files share the source's inodes and have no write bits. `SEALED`'s inventory equals the tree's inventory. |
| P1-3 | `refuses to adopt a tree with a file newer than its hidden lockfile` | No entry dir exists and the source is byte-identical. |
| P1-4 | `refuses to adopt a tree whose hidden lockfile is missing or differs from package-lock.json` | No entry is created in any of three cases: the hidden lockfile is missing, a shared entry differs, or a package-lock entry that is not optional is absent. |
| P1-5 | `converts a complete private tree into a farm of the matching entry` | Every workspace file shares its inode with the entry, and the old private inodes are gone. |
| P1-6 | `conversion preserves workspace-private .vite and .cache dirs and never shares them` | Sentinel bytes and inodes in those dirs are unchanged after conversion, and absent from the entry. |
| P1-7 | `in-place writes to a farm file fail and unlink-then-create leaves the entry unchanged` | Append throws `EACCES`. After unlink and recreate, the entry bytes and inode are unchanged. |
| P1-8 | `quarantines an entry with a file modified after sealedAt and never links it again` | The entry is renamed `*.quarantined-*`, and a following link/convert for that key is a no-op with a WARN. |
| P1-9 | `conversion survives interruption at every step with private bytes intact` | Simulate a crash after steps 1, 2, 3, and midway through step 4 (one of two private entries moved), with sentinel bytes in `.vite` and `.cache`. After steps 1–2, recovery restores the original private tree. After step 3 or mid-step 4, it completes the move. A second recovery run is a no-op. In every case the same pass then ends with a farm `node_modules` holding both private entries with their original bytes and inodes, and no `.new` or `.old`. |
| P1-10 | `never adopts or converts under a live container mount or held storage claim` | With the mount/claim fixture present, trees are untouched. Second case: a container mounts the topic between the scan and the mutation. The mount lookup returns nothing at scan time and the topic on the re-check under the claim, so the tree stays untouched while a control topic is adopted. `storage-manager` suite. |
| P1-11 | `entries never cross workgroups` | A key sealed in workgroup A is not linked into a workgroup B tree with an identical lockfile. B adopts its own. |
| P1-12 | `cache GC deletes an entry only when no farm links remain and it is aged` | An entry with a linked farm survives. After the farm is removed and the age passes, it is deleted. |
| P1-13 | `reclaimable bytes exclude files hardlinked elsewhere` | `dirSizeBytes` of a farm counts 0 for shared files and full size for private files. `storage-manager` suite. |
| P1-14 | `npm-workspaces, pnpm, and lockfile-less projects are left to the existing sweep rule` | Adopt/convert are not invoked and the 2-day delete behavior holds. |
| P1-15 | `report mode logs decisions and mutates nothing` | Every tree and cache dir is byte- and inode-identical before and after, and the log lists the decisions. |
| P1-16 | `refuses to adopt a tree with a declared package directory missing or at the wrong version` | Two fixtures: a deleted package dir, and a `package.json` version edited with its mtime preserved. No entry is created in either. |
| P1-17 | `a sealed entry with a deleted or resized file is quarantined before any link or convert` | After a file is removed from the entry, the next link attempt quarantines it, and the target workspace's `node_modules` is untouched. |
| P1-18 | `conversion keeps a private tree whose inventory differs from the entry` | A private tree with one extra file keeps all original inodes, and `convert-mismatch` is counted. |
| P1-19 | `accepts a tree whose only absent packages are optional` | With package-lock entries `node_modules/@esbuild/linux-x64` `{optional:true, os:["linux"], cpu:["x64"]}` and `node_modules/@esbuild/aix-ppc64` `{optional:true, os:["aix"], cpu:["ppc64"]}` both absent from the hidden lockfile, the tree is adopted. |
| P1-20 | `off still recovers interrupted conversions and garbage-collects unlinked entries` | With the flag `off`: a package dir with `.old` and no `node_modules` is restored, an aged unlinked entry is deleted, and a complete private tree is not adopted or converted. |
| P1-21 | `a pass mutates at most the per-pass cap and defers the rest` | With 7 eligible trees, one pass mutates 5 and counts 2 `deferred`. The next pass finishes the other 2. |
| P1-22 | `conversion keeps a private tree whose file contents or symlink targets differ at equal size` | Two fixtures: a same-size file with different bytes, and a symlink with a same-length different target. Neither tree is converted, every original inode and byte remains, and `convert-mismatch` is counted. |
| P1-23 | `the 2-day delete never removes node_modules beside a pending conversion, in any flag mode` | An aged idle topic's package dir holds `.node_modules.nanoclaw-old` with a private sentinel, next to a `node_modules` holding a moved private sentinel, and recovery is blocked. With the flag at `apply`, `off`, and `report`, both dirs and both sentinels survive the sweep. `storage-manager` suite. |
| P1-24 | `a cold-cache report predicts one adopt and converts the rest with estimated bytes` | With two same-key trees, an empty cache, and the flag at `report`, the decisions are 1 adopt and 1 convert with `estimatedBytes > 0`, and nothing on disk changes. |
| P1-26 | `content reads count against the per-pass cap and an unchanged mismatched tree is not re-read` | With 7 trees whose inventory matches the entry but whose bytes differ, pass 1 reports `contentReads` of 5 and 2 `deferred`. Pass 2 reads only the 2 unread trees (`contentReads` 2). Pass 3 reads 0. After one tree's hidden lockfile mtime changes, pass 4 reads that tree alone. |
| P1-25 | `an npm-style rewrite of the hidden lockfile keeps a farm a farm and leaves the entry untouched` | After unlinking and rewriting `node_modules/.package-lock.json` in a farm, the package dir is still detected as a farm, and the entry's hidden lockfile bytes and inode are unchanged. |

### Phase 2

Host tests go in `src/modules/repository-workspaces/index.test.ts`, `job-runner` tests,
`src/worktree-cleanup.test.ts`, and `src/repository-workspaces.test.ts`. Container tests go in
`container/agent-runner/src/mcp-tools/git-worktrees.test.ts`.

| # | Test name | Assertion |
|---|---|---|
| P2-1 | `checkout names round-trip and never collide` | Every fixture vector parses back in both runtimes. `feat/x` and `feat-x` give different names. `.staging`, `.pnpm-store`, and `<repo>.tmp-x` under a dot-prefix parse to `null`. |
| P2-2 | `repository_checkout publishes a fully initialized self-contained clone` | `.git` is a directory, there is no `objects/info/alternates`, and a pack's `nlink` is 2 or more. `refs/remotes/origin/*` equals the canonical's set exactly, with no canonical heads. HEAD is on B with the working tree checked out, and `nanoclaw-checkout.json` matches. |
| P2-3 | `a second branch in the same thread gets <repo>@<slug> and the primary is untouched` | The primary's HEAD, branch, index, and working-tree bytes are identical before and after. |
| P2-4 | `two threads check out the same branch concurrently` | Both calls succeed and both clones are on B. No transfer and no error. |
| P2-5 | `same-thread siblings get one path, including while the first checkout is still initializing` | With the first host job paused inside staging, a second request for the same branch waits on the lane, then returns the same `path` with `created:false`. One dir exists, with correct HEAD and files. |
| P2-6 | `start point prefers canonical refs/heads/B, then origin/B, then origin/HEAD, and the post-fetch step only moves pristine checkouts` | Four fixtures assert the resulting HEAD and note, including a non-pristine checkout that is left as-is. |
| P2-7 | `a checkout whose current branch differs from its recorded branch is refused, not reused` | After a manual `git switch` inside `<repo>@<slug>`, `create_worktree(branch)` and `git_push(branch)` return the R3 error, and nothing is mutated. |
| P2-8 | `git_commit, git_push, and open_pr act on the checkout selected by branch and default to the primary` | A commit lands in the selected clone only. A push refspec names that clone's HEAD. A clone's push queues a refresh with no `checkout`, and canonical `origin/B` equals the pushed commit (rev 2.7). |
| P2-9 | `refresh never reads a checkout: a clone redirecting to another repository leaks nothing` | Rev 2.7. In the caller's topic, `<repo>@x` clones redirect Git to another workgroup's repository through `.git/commondir`, `objects/info/alternates` and a symlinked `.git/objects`. A refresh naming each one as `checkout` succeeds as a plain refresh, and the canonical gains none of the other repository's refs or objects. Also: `a canonical whose .git holds a commondir file is refused, and nothing is staged` (checkout and refresh), and, in the container, `clone-mode create_worktree fetches the canonical before requesting the checkout`: `origin/B`, pushed after the canonical's last fetch, is in the canonical when `repository_checkout` is queued. |
| P2-10 | `worktree mode creates linked worktrees exactly as today` | The existing linked-worktree creation tests pass unchanged under `NANOCLAW_CHECKOUT_MODE=worktree`. |
| P2-11 | `legacy linked checkouts are reused in clone mode and transfer still works for them` | The existing transfer tests pass with clone mode on. |
| P2-12 | `clone disposability refuses dirty, unpushed, stashed, non-HEAD unpushed branches, and copied legacy branches` | Fixtures: dirty tree; unpushed HEAD; an unpushed non-HEAD local branch; a copied canonical `refs/heads/B` absent from the remote; a stash. All are refused with their reason, in both the clone branch and the orphan-topic loop. Only a clean pushed clone is trashed. An unpushed commit only a sibling remote holds is refused (`unpushed`), and so is a checkout holding an embedded repository (`submodule`) (rev 2.6). |
| P2-13 | `orphan-topic GC enumerates through the lister, proves clones with scope all, and refuses unknown shapes` | Spies show `listTopicCheckouts` and `proveCheckoutDisposable` as the only enumerator and prover. An `unknown` entry refuses the topic, and `.staging` does not. |
| P2-14 | `repository_checkout links node_modules farms for package dirs with a verified entry` | After a new checkout, `<pkg>/node_modules` files share inodes with the entry. Reuse links nothing (rev 2.6). |
| P2-15 | `create_worktree waits for the host response, retries a retryable error once, and times out cleanly` | A response at 1 s resolves the tool. A retryable response is retried once. No response within the injected timeout returns an error naming the request id. |
| P2-16 | `a crash before publication leaves no enumerated checkout and a retry creates normally` | With the host job killed after staging is populated: `listTopicCheckouts` returns nothing for it, a later pass removes the stale staging, and a retry creates the checkout. |
| P2-17 | `local-only canonicals: clone has no origin, starts from preserved refs, skips fetch and refresh, refuses push/PR` | A new branch starts at canonical `HEAD^{commit}`, an existing canonical `refs/heads/B` is preserved exactly, reuse succeeds, and push and open_pr are refused. |
| P2-18 | `clones stay usable after rollback to worktree mode` | Create a primary and a secondary clone in clone mode, with dirty bytes and a stash. Switch to worktree mode. `create_worktree` (no branch and branch B), `git_commit`, `git_push`, and `open_pr` succeed on them, and the dirty bytes, refs, and stash are preserved. |
| P2-19 | `a host completion after the tool timed out is served on the next call` | The tool times out and the host finishes later. The next `create_worktree` returns `created:false` with correct HEAD, index, and files. |
| P2-20 | `a checkout is not delayed by an unrelated repository job` | With a held global-lane publish job, a checkout on another work unit's lane completes, asserted by ordering rather than timing. |
| P2-21 | `the disposability proof runs nothing a clone configures: filters, signature programs, or a submodule` | Rev 2.6. Clones configure a clean filter selected by an attribute, `log.showSignature` with `gpg.program` on a signed commit, and an embedded repository with its own filter. The proof runs and no program writes its sentinel. The verdicts are `clean-and-pushed`, `unpushed` and `submodule`. |

## 10. Risks and open questions

- **npm writes after the hidden lockfile.** A native lifecycle script, for example for bcrypt or
  sharp, could write files after `.package-lock.json`. Completeness then fails and the tree is
  never shared. That is fail-closed. Verify with the largest repository's backend during the
  Phase 1 `report` window. If it happens, exclude only those script outputs, by path as recorded
  in the report.
- **Adoption trusts an agent-produced tree.** It is scoped per workgroup, which is the same trust
  boundary as today's shared canonical. Verified completeness and the inventory checks catch
  incompleteness, not deliberate tampering before adoption.
- **The chmod residual risk** (§5.7.6) is accepted with an explicit trigger.
- **Stale fingerprint.** It is memoized per host process, so an image rebuild that changes
  `NODE_VERSION` keeps the old keys until the next host restart. Image rebuilds normally
  accompany a restarting deploy. Per-group self-mod rebuilds share the base image's Node.
- **Delivery latency.** `create_worktree` becomes a host round trip plus a host-side checkout.
  Measure it in the smoke run. Above 30 s p95 is a finding.
- **Codex trust.** It should cover `/workspace/worktrees/<repo>@<slug>` as a subdirectory of the
  trusted project (`src/providers/codex.ts:51`). Verify in the smoke run.
- **Open:** is `container/CLAUDE.md` upstream-owned? The ratchet report decides.

## 11. Verification commands

```bash
pnpm exec vitest run src/dependency-cache.test.ts src/storage-manager*.test.ts \
  src/worktree-cleanup.test.ts src/repository-workspaces.test.ts \
  src/modules/repository-workspaces/ --maxWorkers=2
cd container/agent-runner && bun test src/mcp-tools/git-worktrees.test.ts \
  src/mcp-tools/instruction-fragment-migration.test.ts
pnpm exec tsc --noEmit && pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm run ratchet:report
# Production evidence (after Phase 1 apply):
df -h / ; journalctl -u nanoclaw-v2 --since '-2h' | grep -E 'dependency-cache|checkout'
```
