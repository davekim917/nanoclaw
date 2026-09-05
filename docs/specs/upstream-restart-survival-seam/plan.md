# Plan: Restart survival (convergence seam 4 — upstream #3653 + session adoption)

Status: **proposed** (revision 1 — §3/§4.1/§4.2/§5/§6/§7 filled for series A, B, C, A′ and D against `origin/main` `08aad9f93`; §4.3/§8-E/§8-F/§8-G still skeleton, gated on the §9 driver-seam decision). Not yet reviewed.
Approval state: not requested. The theme itself is a committed operator must-have (relayed 2026-09-04 by `update-nanoclaw`): both halves — the durable-host rollup and `adoptRunningSessions()` — including the redesign of boot-time workgroup shared-FS reconciliation so it stops requiring every container down.
Primary runtime: Claude (orchestrator: Fable 5.1; builders: worker tiers; cross-model review: Codex gpt-5.6-sol high)
Program: upstream convergence, sync phase (memory `project_upstream_sync_phase_2026_09_04`); follows seam 3 (`docs/specs/upstream-async-central-db-seam/plan.md`).
Upstream target: `nanocoai/nanoclaw` rollup `07f2dda5d` "the durable host" (#3653, ten commits) and the session-driver seam (`src/drivers/**`, 15 files) as they stand on `upstream/main` `b76fcb3d`.
Fork base: `origin/main` `08aad9f93` (seam 3 PRs 1, 2, 3 and 6a merged and deployed; PR 4 open as #411).
Grounding: read-only scout `seam4-restart-survival-scout.md` (orchestrator scratchpad, 2026-09-04), plus the line-anchored source read recorded in §3, re-verified against `origin/main` `08aad9f93` and `upstream/main` on 2026-09-05.
Executable acceptance criteria: **required** (live wake/spawn/delivery paths). For A, B, C, A′ and D the named cases with their assertions are stated inline in §7.A–§7.D; §8 carries E/F/G when the §9 decision lands.

## 1. Outcome

Two user-visible milestones, in order:

1. **A host restart during an idle session no longer kills and respawns it.** Today every host start runs `cleanupOrphansStrict()` inside the workgroup-memory startup gate (`src/main.ts:162`) and graceful shutdown runs `stopAllContainers()` (`src/main.ts:656`); both stop every install-labeled container. After milestone 1 the host stops only sessions whose mounts must change, and a surviving container keeps running across the restart.
2. **A turn in flight when the host goes away finishes and its output is delivered when the host returns.** The runner already keeps running (no host-liveness check anywhere in `poll-loop.ts`; heartbeat, `provider_executing`, `processing_ack` live in the container-owned `outbound.db`), and delivery already drains a surviving container's outbound rows on the next sweep without adoption (`src/delivery.ts:730-748`). What milestone 2 adds is **lifecycle** ownership of the surviving container — kill, ceiling accounting, restart, stale detection — via adoption fenced by `session_claims`.

Plus one small independent fix the operator will feel: **poison messages** — the fork's delivery attempt counter is an in-memory `Map` that resets on restart (`src/delivery.ts:70-71`, give-up at `:649`), so a crash-looping host retries a poison message forever; upstream moved the count into `delivery_attempts` rows.

**Correction carried by this revision:** milestone 1 does **not** land with series D. D delivers the scoping — the host computes, proves and logs exactly which containers it _must_ stop — but the flip to actually leaving the rest running is unsafe until adoption (E) and the adopted-container `on_wake` trigger (F) are in. Two independent reasons, both evidenced in §3: a survivor the host does not track is not fenced against a duplicate spawn (divergence 3), and graceful shutdown would leak it (divergence 8). §4.1 carries the argument; §7.D splits D into D1 (this batch) and D2 (after E and F).

## 2. Scope and non-goals

In scope (ordered — see §4.1 for why the order is the safety argument):

- **A — coordination accessors + host lease.** `src/db/coordination.ts` (upstream 303 L) and `src/host-instance.ts` (85 L: lease start/renew 30 s/TTL 90 s/stop, wired into `main()` and `shutdown()`). Both land **byte-identical to upstream**: seam 3 PR 1 put upstream's `DbDriver` in the fork unchanged, so upstream's already-`Promise`-returning bodies compile against the fork's `getDb()` with no re-derivation (§3, divergence 6 resolved in our favour). Tables already exist after seam 3 PR 2 (`071-host-coordination`, shadow schema). Write-only at first.
- **B — poison-message fix.** `delivery_attempts` rows become the authority for retry counts (upstream `bad032365`); correct the fork's quiet-delivery-cache comment at `src/delivery.ts:84-87`, which justifies itself by the counter being in-memory.
- **C — labels and names.** Stamp `nanoclaw-group`, `nanoclaw-session`, `nanoclaw-workgroup`, `nanoclaw-role=agent` beside the existing install label (`src/container-runner.ts:3693`). **Keep the `nanoclaw-v2-` name prefix**: `src/agent-runner-source.ts:107` filters live containers by that prefix to protect mounted runner snapshots; adopting upstream's `ncl-…` grammar would silently delete a running container's snapshot (divergence 1).
- **A′ — claim-first spawn.** `tryClaimSession` CAS on `incarnation` at spawn and release on finish (upstream `6b0411c47`), so no unfenced window exists between two live host processes or between a stale `finish()` and a fresh spawn.
- **D — scoped startup quiescence (the reconcile redesign).** Replace the fleet-wide `cleanupOrphansStrict()` with inspect-then-scope: compute, per workgroup, whether the boot reconcile would change anything (a new pure predicate beside the existing non-mutating inventory `src/modules/workgroup/shared-dirs.ts:291`), then quiesce only the containers belonging to workgroups that would change. The stop set is derived from the **container runtime by label** (C), not from the in-process registry, because that registry is empty at boot (divergence 2). D1 ships the primitive, the predicate and the measurement with the stop set unchanged; D2 flips the scope once E and F are in. Graceful shutdown keeps `stopAllContainers()` until E (divergence 8).
- **E — adoption (second milestone).** `adoptRunningSessions()` (upstream `src/container-runner.ts:619`): enumerate by label, claim before adopting, lost CAS → leave the container alone, failed claim write → `pendingAdoptions` retried on the wake path; terminal detection for a handle with **no supervision child** via the docker-events hub + resync (`src/drivers/session-events.ts`). Design choice still open (§9): port the driver seam wholesale (~180 KB, 15 files, `docker run` → `create`+`start --attach`, `SessionSpec` admission, `reapResidue`) vs re-derive adoption minimally over the fork's `activeContainers` entry, which is built around `entry.process` / `process.once('close')` (`src/container-runner.ts:1315-1320`, `:1419-1430`).
- **F — `on_wake` for adopted containers.** `on_wake` rows fire only on a fresh container's first poll (`container/agent-runner/src/poll-loop.ts:374,386-396`); an adopted container has spent its first poll, so restart notes, `ceiling-respawn-*` and `groups restart --message` become inert unless the host converts them to a trigger. Runner-side change; runner source is a boot snapshot, so it activates at the same restart.
- **G — narrow `host-restart-warn`.** After adoption it fires only for sessions genuinely stopped, not every marked-running session (`src/host-restart-warn.ts:344`); its header describes the world seam 4 removes.

Non-goals: `src/channels/chat-sdk-bridge.ts` (9 hunks, unrelated theme); the `poll-loop.ts` mid-turn "one content door" vs the fork's busy-flag discipline (mailbox theme, seam 1 backlog); the three sweep commits of #3653 (seam-2 territory, already fork-owned); `wake_signals` authority flip (unwired even upstream at `b76fcb3d`, and its accessors land inert with A).

## 3. Current architecture (source evidence)

Every line number below was read on `origin/main` `08aad9f93` (fork) or `upstream/main` (upstream) on 2026-09-05.

### 3.1 What the host does at boot, in order

`src/main.ts:213` `main()`, in call order: `enforceStartupBackoff()` `:225` → `loadEnvIntoProcess()` `:231` → `enforceUpgradeTripwire()` `:238` → `await initDb(dbPath)` `:242`, `getRawDb()` `:243`, `runMigrations(db)` `:244` → `ensureArchiveSchema()` `:264` → `activateAgentRunnerSource()` `:269` → `reconcileWorkgroupFsState(db)` `:277` → **`reconcileWorkgroupSharedDirs(db)` `:289`** (flag-gated, `WORKGROUP_SHARED_FS`, `src/config.ts:82-83`, default off) → `warnMarkedRunningSessionsOfStartup(...)` `:304` → **`runWorkgroupMemoryStartupGate(db)` `:308`** → `pruneAgentRunnerSnapshots()` `:317`.

`runWorkgroupMemoryStartupGate` (`src/main.ts:153-164`) is three calls: `ensureContainerRuntimeRunning()`, **`cleanupOrphansStrict()`**, `reconcileWorkgroupMemory(db)`.

`cleanupOrphansStrict` (`src/container-runtime.ts:114-133`) lists every container carrying `CONTAINER_INSTALL_LABEL` (`src/config.ts:141`, `nanoclaw-install=<slug>`), stops each, re-lists, and throws if anything survives. Both listings fail closed (`:102-104` "Cannot prove install-scoped container absence"). It is the fleet-wide stop this seam exists to scope down, and it is also the only thing standing between a live container and a mount cutover.

Graceful shutdown (`src/main.ts:620-667`): host modules → delivery/sweep/recovery stops → `teardownChannelAdapters()` → `warnActiveContainersOfShutdown(...)` `:648` → **`stopAllContainers()` `:656`** → `resetCircuitBreaker()`, `process.exit(0)`. `stopAllContainers` (`src/container-runner.ts:1527-1571`) is documented as load-bearing for systemd `TimeoutStopSec` (`:1514-1526`).

### 3.2 The invariant that forces "all containers down"

It is **the mount set fixed at spawn**, not inode pinning and not lock files.

`prepareWorkgroupMemoryMember` (`src/modules/workgroup/shared-dirs.ts:205-256`) replaces a group's local `groups/<folder>/memory` with a symlink whose target is `WORKGROUP_MEMORY_CONTAINER_PATH` (`:44`, a **container-absolute** path under `/workspace/workgroup`) at `:245`, and may create the canonical directory at `:232-240` and the `preferences/` directory at `:250-254`. The symlink target resolves only inside a container that was spawned with the workgroup bind mount. A container spawned before the cutover therefore ends up with a dangling `/workspace/agent/memory`. Scope is per workgroup: `reconcileWorkgroupMemory` (`:370-403`) iterates workgroups and already accepts a `workgroupIds` selector (`:376`, type at `:66-69`).

`reconcileWorkgroupSharedDirs` (`:421-431`) has **no** selector and no report; it iterates every workgroup and calls `migrateWorkgroup` (`:433`), which re-runs every startup by design (`:439-451`).

### 3.3 What the fork already has that upstream's plan assumes

- **The scoped runtime barrier.** `quiesceAgentGroupsForRepositoryMounts` (`src/container-restart.ts:363-369`) → `quiesceSessionsForRepositoryMounts` (`:372-478`): fences each session's inbound DB with an epoch, waits for the exact activation token (`:296-302`, `:427-436`), kills the running subset (`:437-439`), waits for them to be gone (`:440-444`), and releases with a wake (`releaseRepositoryMountQuiescence` `:318-356`, `wakeRepositoryMountSessions` `:480-486`). It reasons about a "fresh/adopted activation token" already (`:50`).
- **Delivery does not need adoption.** `sweepDeliverSession` (`src/delivery.ts:730-748`) treats `isContainerRunning(session.id) || session.container_status === 'running' | 'idle'` as "a live container is about to write" and drains regardless; the drain itself opens the session's own SQLite files.
- **Snapshot pruning is adoption-safe except for one filter.** `pruneAgentRunnerSnapshots` (`src/agent-runner-source.ts:143-180`) skips anything a running container has bind-mounted, and its `defaultReferencedPaths` (`:105-131`) returns `null` — prune nothing — when docker itself cannot be queried. It finds those containers with `docker ps -q --filter name=nanoclaw-v2-` (`:107`). The spawn-time name is `nanoclaw-v2-${agentGroup.folder}-${Date.now()}` (`src/container-runner.ts:1215`).
- **The spawn path's guard discipline.** `spawnContainer` (`src/container-runner.ts:1020`) ends with three checks and then `spawn()`: shutdown-in-progress `:1293-1295`, late kill cancellation `:1302-1303`, the wake guard `:1304-1312`, then `spawn(CONTAINER_RUNTIME_BIN, args, …)` `:1313` and `activeContainers.set(...)` `:1315-1320`. The comment at `:1296-1301` states the contract: nothing awaits between the last check and the registration. Seam 3 §4.5 I-1 keeps that guard synchronous.
- **Registry, kill and finalize.** `activeContainers` (`:185-193`) holds `{ process: ChildProcess; containerName; spawnedAt; storageActivity }`. `isContainerRunning` `:430-431` and `getActiveContainerSessionIds` `:457` read it. `killContainer` `:1444-1454` → `stopRunningContainer` `:1419-1430` attaches `onExit` to `entry.process.once('close', …)` and falls back to `entry.process.kill('SIGKILL')`. `finalizeContainer` `:1346-1368` runs on `close`/`error`, and its `active?.process === container` comparison `:1354` is already an in-process stale-finish fence.
- **`buildContainerArgs`** (`:3637-3689`) is module-private with exactly one call site (`:1245-1266`); it receives `agentGroup` and `resolvedWgId` but **not** the session id. Its first emitted flags are at `:3693`.

### 3.4 The coordination tables and their upstream accessors

Migration `071-host-coordination` (`src/db/migrations/071-host-coordination.ts`) creates `host_instances`, `session_claims`, `delivery_attempts`, `wake_signals` with **zero fork readers and zero fork writers** (`:26-30`). `src/db/coordination.ts` does not exist in the fork.

Upstream `src/db/coordination.ts` (303 L) is the only sanctioned accessor set. Shapes that matter here: `tryClaimSession` (`:143-179`) inserts at `expectedIncarnation === 0` with `ON CONFLICT DO NOTHING`, otherwise `UPDATE … WHERE session_id = ? AND incarnation = ?`, returning the new incarnation or `null`; `releaseSessionClaim` (`:182-197`) is scoped `AND claimed_by = ? AND incarnation = ?`; `recordDeliveryAttempt` (`:223-250`) upserts and returns the new count; `getLiveHostInstance` (`:114-120`) filters `stopped_at IS NULL AND lease_expires_at > ?` and its doc comment (`:108-113`) is explicit that an unknown id reads as not-live. Every function takes `now` as a parameter and every timestamp is an ISO-8601 UTC string compared lexicographically (`:9-11`) — the fork's own rule (CLAUDE.md, Timestamps).

Upstream `src/host-instance.ts` (85 L): `RENEW_INTERVAL_MS` 30 000, `LEASE_TTL_MS` 90 000 with the 3× rationale at `:18-19`; `startHostInstanceLease` throws on a second start (`:36`), registers, then `setInterval` + `renewTimer.unref?.()` (`:55`); `stopHostInstanceLease` clears the timer and stamps `stopped_at`, swallowing failures (`:70-85`). Both renewal and stop failures are WARN-only by design.

Upstream `bad032365` (poison fix) replaces the in-memory map with `recordAttemptRow`/`clearAttemptRow` wrappers whose failures are swallowed, and changes the give-up test to `attempts !== null && attempts >= MAX_DELIVERY_ATTEMPTS` — a bookkeeping failure skips the give-up decision for that tick rather than dropping the message.

Upstream `6b0411c47` (claim-first spawn) puts `claimSessionRun` before the heartbeat clear ("winning it is what licenses touching the session's runtime state (the heartbeat clear below included)"), releases the claim if `driver.prepare` throws, binds `finishAndResolve` to a specific runtime rather than looking the session up, and adds a durable incarnation fence inside `finish` before any bookkeeping.

### 3.5 The eight divergences from upstream's assumptions

1. **The `nanoclaw-v2-` name prefix is load-bearing.** `src/agent-runner-source.ts:107` selects live containers by `name=nanoclaw-v2-`. A _successful_ listing that matches nothing returns an empty set, and only a docker _failure_ returns `null` (`:125-130`) — so renaming containers to upstream's `ncl-…` grammar makes the pruner delete every snapshot except the active one, including one a live container has bind-mounted. **Resolution:** keep the prefix; add labels beside it (C), and make the prefix a single exported constant both sites import so the two cannot drift (§7.C).
2. **`activeContainers` is empty at boot, so the fork's scoped barrier cannot see a survivor.** `quiesceSessionsForRepositoryMounts` derives its stop set from `isContainerRunning(session.id) || isContainerSpawning(session.id)` (`src/container-restart.ts:382`), both of which read the in-process map (`src/container-runner.ts:430-431`, `:434`). At startup that map is empty, so routing the boot reconcile through the existing barrier — as revision 0 of §2 proposed — would stop nothing and run the mount cutover under live containers. **Resolution:** D introduces a second door, `quiesceWorkgroupsForBootMountChange`, whose stop set comes from the container runtime by label (C). The existing barrier stays the _runtime_ door for mount changes while the host is up; §4.2's structural test names both.
3. **`tryClaimSession` does not fence a container that outlived its host.** The CAS is on `incarnation` alone; nothing in the predicate asks whether `claimed_by` is a live instance or whether `container_ref` still exists. A restarted host reads the survivor's claim at incarnation N and wins a CAS at N, so `wakeContainer` (`src/container-runner.ts:608-611`, map empty) spawns a second container against the same session directory. The fresh container's `clearStaleProcessingAcks()` (`container/agent-runner/src/poll-loop.ts:371`) then clears the survivor's in-flight claims, so both re-process the same rows — the exact double-reply class `wakePromises` exists to prevent (`src/container-runner.ts:230-238`). **Resolution:** A′ ships the CAS unchanged, because it does fence the two races upstream wrote it for; D2 (the flip that creates survivors) is gated on E, which registers the survivor in the map and makes the fast path at `:608` true again.
4. **The shared-FS consolidation already runs outside the quiescence proof.** `src/main.ts:289` calls `reconcileWorkgroupSharedDirs(db)` _before_ `runWorkgroupMemoryStartupGate` at `:308` runs `cleanupOrphansStrict()`. Its own doc comment ("runs at startup BEFORE any container spawns", `shared-dirs.ts:418-419`) is true only for spawns _this_ process makes; containers left by the previous host are still live at that point. Masked today because the flag defaults off (`src/config.ts:82-83`). **Resolution:** D moves both reconciles behind the one boot primitive, which makes the ordering an asserted property instead of an incidental one, and gives `reconcileWorkgroupSharedDirs` the `workgroupIds` selector `reconcileWorkgroupMemory` already has.
5. **`changed` is a post-hoc report field, not a scope input.** `reconcileWorkgroupMemory` computes `changed` after mutating (`shared-dirs.ts:388-400`). `inspectWorkgroupMemoryState` (`:291-344`) is non-mutating but answers a different question — a workgroup can report `canonical` and still need a member's symlink written, because the status is computed from the canon plus "substantive" sources and an already-exact member is not substantive. **Resolution:** D adds a pure predicate over the same `lstat` facts, and its acceptance test asserts the predicate equals the observed `changed` across a fixture matrix.
6. **Upstream's coordination code needs no re-derivation.** §2 revision 0 said "re-derived over the fork's driver with SQL byte-for-byte and `Promise`-returning signatures over sync bodies". Seam 3 PR 1 landed upstream's `src/db/driver.ts` byte-identical (`DbDriver.get/all/run/exec/transaction/hasTable/close`, all `Promise`, `:49-63`), so upstream's `coordination.ts` and `host-instance.ts` compile in the fork **verbatim**, imports included (`./connection.js`, `../log.js`, `./config.js` `INSTALL_SLUG` at `src/config.ts:140`). The `no-catch-all` inline disables they carry match the fork's plugin registration (`eslint.config.js:4,13,28`). **Resolution:** A is a copy plus two wiring lines, and both files join the upstream ratchet as byte-identical adds.
7. **A container spawned before C carries no scope label.** On the first restart after C deploys, every live container has only `nanoclaw-install`. **Resolution:** the boot inventory treats an unlabeled container as unknown scope and stops it, fail-closed; and C and D **cannot ride the same restart** (§7, restart batching).
8. **Graceful shutdown would leak a survivor.** `stopAllContainers` (`src/container-runner.ts:1527`) iterates `activeContainers`, so under D2-without-E a container this host did not adopt is neither stopped at shutdown nor tracked at boot — it survives every subsequent restart, unmanaged, and accumulates. The normal restart path is `systemctl restart` → SIGTERM → `shutdown()`, so D2 without E does not even deliver milestone 1 for the ordinary case; it only changes the crash path, and makes it worse. **Resolution:** D2 lands with E, and the `TimeoutStopSec` question (§9) is answered in the same PR.

## 4. Design

### 4.1 Ordering is the safety argument

The biggest risk is **two writers on one session** (a host and an orphan, or two hosts). Today `cleanupOrphansStrict`'s fail-closed proof is the only thing preventing it.

The order that keeps the proof intact at every deployed state:

- **A** adds durable state nobody reads. It cannot change behavior; its worst failure is a WARN.
- **B** moves one counter from process memory to a row. It changes retry arithmetic and nothing else.
- **C** adds labels and pins the name prefix. It is the vocabulary D needs, and it must be _deployed one restart earlier_ than D so live containers actually carry it (divergence 7).
- **A′** makes `tryClaimSession` the only path that may start a container, with a ratchet test pinning its callers. It closes the two-live-hosts and stale-`finish()` races **while `cleanupOrphansStrict` is still running**, so it is a strict addition of safety with no window of its own.
- **D1** replaces the fleet-wide stop with a primitive that computes the scoped set, proves it, logs the counterfactual, and then stops exactly what `cleanupOrphansStrict` stopped. Behavior identical; the scope decision runs in production before it is allowed to skip a stop.
- **D2** flips the primitive to honour its own scope. This is the first state in which a container outlives a host restart, and divergences 3 and 8 say that state is only safe once **E** re-registers survivors in `activeContainers` (restoring the `wakeContainer` fast path at `src/container-runner.ts:608` and the `stopAllContainers` inventory) and **F** makes `on_wake` reach a container that has spent its first poll.

Invariant in a primitive, part 1: `tryClaimSession` (CAS on `incarnation`, `changes > 0`) is the only path that may start or adopt a container. `src/session-claim-callers.test.ts` pins its caller set as a file list (shrink-or-equal), the same ratchet shape seam 3 uses for `getRawDb` and seam 2 uses for `computeOffenders`.

### 4.2 Mount changes go only through a quiescence door

Invariant in a primitive, part 2: `reconcileWorkgroupMemory` and `reconcileWorkgroupSharedDirs` may run only from inside one of exactly two doors —

- **the boot door**, `quiesceWorkgroupsForBootMountChange(changedWorkgroupIds)`, whose stop set comes from the container runtime by label, or
- **the runtime door**, `quiesceAgentGroupsForRepositoryMounts` / `quiesceSessionsForRepositoryMounts` (`src/container-restart.ts:363,372`), whose stop set comes from the in-process registry,

or from the no-container path when the boot predicate reports no workgroup would change. `src/workgroup-reconcile-doors.test.ts` pins the caller file set for both reconcilers and asserts the boot call order (`quiesce…` resolves before either reconciler is entered, and `pruneAgentRunnerSnapshots` runs after both). Two doors rather than one because the two stop sets have different authorities and the fork cannot merge them until adoption makes the registry complete at boot (divergence 2).

The boot door does **not** fence session ingress and does not wait for a barrier ack, unlike the runtime door. Deliberate: today's boot path (`cleanupOrphansStrict`) stops the same population with no fence and no drain, so adding one at boot would be new behavior on the startup critical path with a 120 s per-session timeout (`src/container-restart.ts:375`), and the sessions being stopped are exactly the ones whose mounts are changing. The boot door is a scoped `cleanupOrphansStrict`, not a scoped `quiesceSessionsForRepositoryMounts`.

### 4.3 Adoption without a supervision child — decision pending (§9)

## 5. Safety, rollout, rollback

- Every PR leaves the tree building and independently deployable. Rollback = revert the `--no-ff` merge, build, restart; anchors as in seam 3 §5, plus the deployer's pre-restart `data/v2.db` copy for any restart that carries a schema-touching PR (none in this batch — 071 is already applied).
- **A, B, C** are additive at the schema level and inert on revert: the rows they write are ignored by the previous build. **A′** leaves `session_claims` rows behind on revert; harmless, because a build without A′ never reads them and a re-deployed build with A′ reads the current incarnation and CASes on it. **D1** restores `cleanupOrphansStrict()` into `runWorkgroupMemoryStartupGate` on revert.
- **Live-user risk ranking:** D1 (a throw in the new primitive blocks startup) > A′ (every spawn now takes a DB write before the guard point) > B (a message that already failed twice under a previous host now gives up on its first attempt after a restart — intended, but the operator will see fewer retries across a restart) > C (five extra `--label` flags per spawn) > A (write-only).
- **Restart approval:** the operator's standing window closed 2026-09-04 23:59 ET, so every restart in this batch needs an explicit go. This batch needs **three** restarts (§7) on a production-critical install; that budget is the one item only the operator can settle (§9).
- **Seam 3 interaction:** PR 4 (#411, ~147 files including `delivery.ts` and `container-runner.ts`) is open. Every series here branches from a base that already contains PR 4, or rebases onto it before review. New code uses `getDb()` and `await`; it must never import `getRawDb` — `src/db/raw-db-ratchet.test.ts` pins 219 importer files shrink-only, and an added importer fails the build.
- **Upstream ratchet:** A adds two upstream-owned files byte-identical, so `pnpm run ratchet:report -- --write` should report no growth. B, C, A′ and D touch upstream-owned files (`delivery.ts`, `container-runner.ts`, `main.ts`) and each PR regenerates the report; growth needs `--accept` and a reason in the PR body (CLAUDE.md).

## 6. Observability

Nothing new in the hot path. The post-restart gate already counts `ERROR`/`WARN` classes, `preflight ok`, spawned/delivered and the seam counters. This seam adds, per series:

| Series | Signal                                                                                                                              | Expected                                                                |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A      | `Host instance lease started` (new INFO, instance id + ttl)                                                                         | exactly 1 per boot                                                      |
| A      | `Host instance lease row missing on renewal` / `Host instance lease renewal failed` / `Failed to mark host instance stopped` (WARN) | 0                                                                       |
| A      | `host_instances`: one row with `stopped_at IS NULL`; the previous boot's row stamped (graceful) or lease-expired (crash)            | this is the fork's first durable clean-vs-unclean-restart signal        |
| B      | `Failed to record delivery attempt — retrying next poll without a count` (ERROR)                                                    | 0                                                                       |
| B      | `Failed to clear delivery attempt row` (WARN)                                                                                       | 0                                                                       |
| B      | `Message delivery failed permanently, giving up`                                                                                    | unchanged vs the prior boot                                             |
| B      | `SELECT count(*) FROM delivery_attempts` a few minutes after boot                                                                   | ≈0 (rows clear on delivery and on give-up)                              |
| C      | `docker inspect` the newest container: five labels present; containers whose name lacks `nanoclaw-v2-`                              | 5 / 0                                                                   |
| A′     | `is claimed by another live host process — not spawning a duplicate` (ERROR via `trackWake`)                                        | 0                                                                       |
| A′     | `Ignoring stale session finish` (WARN)                                                                                              | 0                                                                       |
| A′     | `session_claims` rows with `claimed_by IS NOT NULL` vs `getActiveContainerCount()`                                                  | equal at steady state — a durable-vs-memory agreement check             |
| D1     | `Boot quiescence scope` (new INFO, once per boot): `{ workgroups, changed, containers, stopped, survivable, unlabeled }`            | `stopped == containers`; `survivable` is the milestone-1 counterfactual |

**Milestone 1 evidence, once D2 + E + F are deployed.** After a `systemctl restart`, the milestone is proven by all six of:

1. `Boot quiescence scope` with `changed: 0`, `stopped: 0`, `survivable: N` (N > 0).
2. Absence of `Stopped orphaned containers and proved install quiescence` (`src/container-runtime.ts:128`) — the fleet-wide stop did not run.
3. `Reconciled sessions at startup` with `adopted: N, stopped: 0` (upstream's line in `adoptRunningSessions`).
4. For each survivor's session id: **no** `Spawning container` line in the post-restart window, and `Container already running` (`src/container-runner.ts:609`) on its first wake.
5. `docker inspect` on each survivor: the same container id, and `State.StartedAt` earlier than the host's `NanoClaw starting` line.
6. Zero `Ignoring stale session finish` and no session id appearing twice in `Spawning container`.

Until D2 ships, line 1 is the only one available and its `survivable` count is the measurement D1 exists to take.

## 7. Implementation path

| PR  | Scope                                                                                 | Depends on                    | Restart           | Owner                                                            |
| --- | ------------------------------------------------------------------------------------- | ----------------------------- | ----------------- | ---------------------------------------------------------------- |
| A   | coordination accessors + host lease (write-only)                                      | seam 3 PR 2 (tables, merged)  | restart 1         | runner-mailbox owner                                             |
| B   | poison-message fix onto `delivery_attempts`                                           | A merged                      | restart 1         | runner-mailbox owner                                             |
| C   | labels; `nanoclaw-v2-` prefix pinned in one constant                                  | —                             | restart 1         | runner-mailbox owner                                             |
| A′  | claim-first spawn + release on finish                                                 | A deployed                    | restart 2         | runner-mailbox owner                                             |
| D1  | boot quiescence primitive + `wouldChange` predicate + measurement; stop set unchanged | C **deployed**, A′ deployed   | restart 3         | runner-mailbox owner; seam-2 owner reviews the sweep interaction |
| D2  | the flip: honour the scope                                                            | E, F                          | with E            | runner-mailbox owner                                             |
| E   | adoption                                                                              | D1, driver-seam decision (§9) | high              | runner-mailbox owner                                             |
| F   | `on_wake` for adopted containers (runner)                                             | E                             | same restart as E | runner-mailbox owner                                             |
| G   | narrow host-restart-warn                                                              | E                             | rides any         | runner-mailbox owner                                             |

**Restart batching.** Minimum three restarts for this batch. A + B + C share **restart 1** (all additive, B the only behavior change and it is bounded to retry counts). A′ takes **restart 2** alone: it puts a DB write in front of every spawn, and a spawn regression must not be confounded with a delivery or labelling change. D1 takes **restart 3**: C must have been live for at least one restart cycle or every container the boot inventory sees is unlabeled (divergence 7) and the `survivable` measurement is meaningless. D2/E/F share a later restart, decided after §9.

Per-PR mechanics, unchanged from seam 3 §7: scratch worktree, `git -C`, boundary check from the worktree root (`node_modules/.bin/tsx scripts/check-public-boundary.ts -- --root "$W" --index`), `pnpm run ratchet:report -- --write`, Codex `pr-review-loop` with the churn gate, fallback reviewer after 15 minutes of Codex silence, one test file at a time under `ionice -c3 nice -n 10`.

### 7.A — coordination accessors + host lease

**Files.**

| File                                                       | Change                                   |
| ---------------------------------------------------------- | ---------------------------------------- |
| `src/db/coordination.ts`                                   | **new**, upstream byte-identical (303 L) |
| `src/host-instance.ts`                                     | **new**, upstream byte-identical (85 L)  |
| `src/main.ts`                                              | start the lease; stop it in `shutdown()` |
| `src/durable-host-seam-manifest.ts`                        | **new**, the two files' upstream hashes  |
| `src/durable-host-seam.test.ts`                            | **new**, drift tripwire                  |
| `src/db/coordination.test.ts`, `src/host-instance.test.ts` | **new**                                  |
| `src/upstream-ratchet.json`                                | regenerated                              |

**Insertion points.** `src/main.ts:244` — immediately after `runMigrations(db)` and before `ensureArchiveSchema()` (`:264`), so the lease row exists before anything that can spawn:

```ts
await startHostInstanceLease();
```

`src/main.ts:660-664` — as the **first** statement of `shutdown()`'s `finally` block, ahead of `resetCircuitBreaker()`. In the `finally` rather than the `try`, because a throw from `teardownChannelAdapters()` (`:643`) would otherwise skip the stop stamp and leave the row looking crash-ended for 90 s:

```ts
await stopHostInstanceLease();
```

**Signature shape.** No re-derivation. Every export is already `Promise`-returning against `DbDriver` (`src/db/driver.ts:56-58`), and every timestamp is an ISO-8601 UTC string the caller passes in (divergence 6). The fork adds nothing to either file.

**Ordering and safety.** Write-only: no fork code reads `host_instances`, `session_claims`, `delivery_attempts` or `wake_signals` after this PR. `startHostInstanceLease` throws on a double start, which in `main()` is unreachable (one call). A renewal or stop failure is WARN-only and never propagates (`host-instance.ts:59-68`, `:78-84`). The renew timer is `unref`'d (`:55`) so it cannot hold the process open.

**Acceptance tests.**

`src/db/coordination.test.ts` (in-memory driver via `initTestDb()` + `runMigrations`):

- _"registerHostInstance is idempotent on instance_id and clears stopped_at"_ — register, `markHostInstanceStopped`, register again with a later lease; assert one row, `stopped_at` null, `lease_expires_at` equals the later value.
- _"renewHostInstanceLease returns false for a stopped row and for a missing id"_.
- _"getLiveHostInstance hides an expired lease"_ — `lease_expires_at` equal to `now`; assert `undefined` (the comparison is strict `>`).
- _"tryClaimSession creates the row at expectedIncarnation 0 and returns 1"_.
- _"tryClaimSession returns null on a stale expected incarnation and leaves the row untouched"_ — claim 0→1, claim again expecting 0; assert `null` and `incarnation === 1` and `claimed_by` unchanged.
- _"releaseSessionClaim releases only the holder's own incarnation"_ — release with the wrong instance id, then the wrong incarnation, then the right pair; assert `false, false, true` and that `claimed_by` is null only after the third.
- _"recordDeliveryAttempt returns the running count and clearDeliveryAttempt removes the row"_.
- _"setStopIntent upserts without disturbing an existing incarnation"_.
- _"every timestamp written is ISO-8601 UTC"_ — read back `started_at`, `lease_expires_at`, `claimed_at`, `updated_at`, `last_attempt_at`, `created_at`; assert each matches `/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/` (CLAUDE.md Timestamps).

`src/host-instance.test.ts` (mock `./db/coordination.js`, **not** `os` — a fake-timer test runs the real body, and mocking `os` is inert here; memory `feedback_fake_timer_tests_run_real_bodies`):

- _"start registers a row and returns the instance id"_; _"a second start throws"_.
- _"the renew timer extends the lease on its interval"_ — inject `renewIntervalMs: 10`, advance fake timers, assert `renewHostInstanceLease` called with a later expiry.
- _"a rejected renewal logs a warning and does not throw"_ — assert the interval callback settles and the timer keeps running.
- _"a renewal that reports the row missing logs `Host instance lease row missing on renewal`"_.
- _"stop clears the timer, stamps stopped_at, and makes getHostInstanceId null"_.
- _"a rejected stop stamp does not throw"_.
- _"the renew timer is unref'd"_ — assert `unref` was called on the returned handle.

`src/durable-host-seam.test.ts`:

- _"coordination.ts and host-instance.ts are byte-identical to upstream"_ — same manifest-hash shape as `src/host-lifecycle-seam.test.ts` / `src/mailbox-seam-manifest.ts`; a local patch to either file fails the build.

**Rollback.** Revert the merge, build, restart. The rows written stay and are ignored; the next build with A re-registers under a fresh instance id.

### 7.B — poison-message fix

**Files.** `src/delivery.ts`; `src/delivery-attempts-authority.test.ts` (new); `src/delivery.test.ts` (unchanged cases must stay green); `src/upstream-ratchet.json`.

**Insertion points, all in `src/delivery.ts`.**

| Line today | Change                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `:70-71`   | delete the `deliveryAttempts` map; add `recordAttemptRow(messageId, sessionId, err): Promise<number \| null>` and `clearAttemptRow(messageId): Promise<void>`, both swallowing their own failures (upstream `bad032365`)                                                                                                                         |
| `:84-87`   | rewrite the quiet-cache comment: rule 1's justification changes ("retry state lives only in `deliveryAttempts` (in memory)") but **the rule does not** — a failed delivery still does not move the session's `outbound.db` mtime, so arming only after a clean drain is still required. Say that explicitly so the next reader does not relax it |
| `:634`     | `deliveryAttempts.delete(msg.id)` → `await clearAttemptRow(msg.id)`                                                                                                                                                                                                                                                                              |
| `:647-648` | → `const attempts = await recordAttemptRow(msg.id, session.id, err);`                                                                                                                                                                                                                                                                            |
| `:649`     | → `if (attempts !== null && attempts >= MAX_DELIVERY_ATTEMPTS)`                                                                                                                                                                                                                                                                                  |
| `:658`     | `deliveryAttempts.delete(msg.id)` → `await clearAttemptRow(msg.id)`                                                                                                                                                                                                                                                                              |
| `:682`     | `attempt: attempts` may now be `null`; keep upstream's comment naming that case                                                                                                                                                                                                                                                                  |

The fork's `markDeliveryFailed(msg.id, errMsg)` takes two arguments where upstream's takes one (`:657`), and the fork calls it through `ackDelivery` rather than `withExistingMailboxSession` directly — both stay as they are. The orphaned repo-fence recovery after a dropped delivery (`:659-677`, the 2026-09-01 incident) is untouched and its position after `clearAttemptRow` is preserved.

**Ordering and safety.** `recordAttemptRow` runs _before_ the give-up test, so the row is the authority for the decision in the same tick that produced the failure. A `null` return (the bookkeeping write itself failed) skips the give-up branch and takes the retry branch, which `break`s (`:690`) and preserves outbound ordering — the fork-specific rule upstream does not have. A failed clear leaves a stale row that the next lifecycle of the same message id overwrites.

**Behavior the operator can feel, and it is intended:** a message that failed twice under a previous host now gives up on its first attempt after a restart, instead of getting three fresh attempts per process lifetime. That is the fix. Record it in the PR body so the first `giving up` line after deploy is not read as a regression.

**Acceptance tests** — `src/delivery-attempts-authority.test.ts`:

- _"attempt counts survive a process restart"_ — fail delivery twice, `vi.resetModules()` and re-import `delivery.ts` against the same DB, fail once more; assert `markDeliveryFailed` was called and `Message delivery failed permanently, giving up` logged with `attempts: 3`.
- _"three restarts each burning one attempt still give up"_ — the incident shape from upstream's commit message: three fresh module instances, one failure each; assert give-up on the third, not never.
- _"a successful delivery clears the row"_ — assert `delivery_attempts` has no row for that message id.
- _"a failed record skips the give-up decision for that tick"_ — make `recordDeliveryAttempt` reject; assert no `markDeliveryFailed`, an ERROR log, and that the drain still `break`s (the next message in the batch was not attempted).
- _"a failed clear does not break delivery"_ — make `clearDeliveryAttempt` reject; assert the message is still counted delivered and only a WARN is logged.
- _"outbound ordering is preserved on retry"_ — two undelivered rows, the first fails below the cap; assert the second was not attempted.
- _"the give-up path still runs orphaned repository-fence recovery"_ — the `:668-677` guard, unchanged.

In `src/delivery.test.ts`, the quiet-delivery-cache cases stay as they are and must pass unmodified: _"arming requires a clean drain"_ and _"a delivery error never arms"_ are the regression guard that B did not relax rule 1.

**Rollback.** Revert; the map returns and the rows go inert. A message mid-retry gets a fresh count, which is the pre-B behavior.

### 7.C — labels and names

**Files.** `src/config.ts`; `src/container-runner.ts`; `src/agent-runner-source.ts`; `src/container-labels.test.ts` (new); `src/container-runner.test.ts`; `src/upstream-ratchet.json`.

**Insertion points.**

`src/config.ts:141`, beside `CONTAINER_INSTALL_LABEL`:

```ts
export const CONTAINER_NAME_PREFIX = 'nanoclaw-v2-';
export const CONTAINER_GROUP_LABEL_KEY = 'nanoclaw-group';
export const CONTAINER_SESSION_LABEL_KEY = 'nanoclaw-session';
export const CONTAINER_WORKGROUP_LABEL_KEY = 'nanoclaw-workgroup';
export const CONTAINER_ROLE_LABEL_KEY = 'nanoclaw-role';
```

`src/container-runner.ts:1215` — build the name from the constant: `` `${CONTAINER_NAME_PREFIX}${agentGroup.folder}-${Date.now()}` ``.

`src/agent-runner-source.ts:107` — the pruner's filter becomes `` `name=${CONTAINER_NAME_PREFIX}` ``. One constant, two importers: divergence 1 becomes a type error rather than a silent data loss.

`src/container-runner.ts:3637-3689` — `buildContainerArgs` gains a required `sessionId: string` as the third parameter, after `containerName`. It is module-private with exactly one call site (`:1245-1266`) and no test constructs it, so the ripple is that one call.

`src/container-runner.ts:3693` — the flag list:

```ts
const args: string[] = [
  'run',
  '--rm',
  '--init',
  '--name',
  containerName,
  '--label',
  CONTAINER_INSTALL_LABEL,
  '--label',
  `${CONTAINER_GROUP_LABEL_KEY}=${agentGroup.id}`,
  '--label',
  `${CONTAINER_SESSION_LABEL_KEY}=${sessionId}`,
  '--label',
  `${CONTAINER_WORKGROUP_LABEL_KEY}=${resolvedWgId ?? ''}`,
  '--label',
  `${CONTAINER_ROLE_LABEL_KEY}=agent`,
];
```

`resolvedWgId` is already threaded (`:3656`) and is what D scopes by, so the workgroup label costs nothing here and saves a group→workgroup lookup at boot. An empty value is emitted rather than the label being dropped, so "no workgroup" and "old container" stay distinguishable at the inventory.

**Ordering and safety.** Labels are metadata; nothing reads them until D. The name is unchanged, which is the point. Upstream's `ncl-…` grammar is explicitly **not** adopted (divergence 1) — record that in the PR body and in a comment at the constant, because a later upstream port will propose it again.

**Acceptance tests** — `src/container-labels.test.ts`:

- _"spawn args carry install, group, session, workgroup and role labels"_ — assert the five `--label` pairs and their values for a fixture group/session.
- _"the container name uses the pinned prefix"_ — assert the built name starts with `CONTAINER_NAME_PREFIX`.
- _"the snapshot pruner and the spawn name share one prefix constant"_ — pin the importer file set of `CONTAINER_NAME_PREFIX` to exactly `src/container-runner.ts` and `src/agent-runner-source.ts` (shrink-or-equal ratchet); a third importer or a literal re-introduced at either site fails.
- _"a workgroup-less session still emits the workgroup label with an empty value"_.

In `src/agent-runner-source.test.ts` (existing): the pruner cases must pass unmodified — _"a snapshot mounted by a running container is never removed"_ is the case divergence 1 is about.

**Rollback.** Revert; containers spawned by the reverted build simply carry fewer labels, and D is not deployed yet.

### 7.A′ — claim-first spawn

**Files.** `src/container-runner.ts`; `src/session-claim-spawn.test.ts` (new); `src/session-claim-callers.test.ts` (new ratchet); `src/upstream-ratchet.json`.

**Insertion points, all in `src/container-runner.ts`.**

1. `:185-193` — the `activeContainers` value type gains `claimIncarnation?: number`.
2. Near `:119` — the claimant id. **Fork-forward on upstream:** upstream `6b0411c47` uses `` `${os.hostname()}:${process.pid}` `` and its own later commit `692a0b603` ("claims answer to the host-instance lease") replaces that with the lease id. The fork takes the end state directly — `getHostInstanceId() ?? \`${os.hostname()}:${process.pid}\``— so the claimant vocabulary never has to be migrated. The fallback exists for tests and for any path that runs before`startHostInstanceLease()`.
3. Two helpers, upstream's shapes: `claimSessionRun(sessionId, containerRef): Promise<number | null>` (read the current claim, `tryClaimSession` on `current?.incarnation ?? 0`; **throws** on a write failure — a claim that cannot be recorded is a claim not held) and `releaseClaimQuietly(sessionId, incarnation): Promise<void>` (`releaseSessionClaim` wrapped so a failed release never throws; the next claimant's CAS supersedes it).
4. `:1282-1313` — the claim goes **after** `log.info('Spawning container', …)` (`:1282`) and **before** the heartbeat clear (`:1288`), for upstream's reason: winning the claim is what licenses touching this session's runtime state, and the heartbeat file is runtime state. Everything from the heartbeat clear through the guard point stays synchronous and is wrapped so any throw releases:

```ts
const claimIncarnation = await claimSessionRun(session.id, containerName);
if (claimIncarnation === null) {
  throw new Error(`session ${session.id} is claimed by another live host process — not spawning a duplicate`);
}
try {
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true }); // was :1288
  if (containerShutdownInProgress) throw new Error('Container spawn cancelled because host shutdown is in progress');
  const lateCancellation = pendingKillCancellation(session.id);
  if (lateCancellation) throw lateCancellation;
  const guardRefusal = wakeRefusalFrom(guard);
  if (guardRefusal !== null) throw new Error(`Container spawn refused by its guard: ${guardRefusal}`);
} catch (err) {
  await releaseClaimQuietly(session.id, claimIncarnation);
  throw err;
}
const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
```

This is the ordering argument: the claim is the **last `await`** in the spawn path, so the guard evaluation at `:1309` and `spawn()` at `:1313` remain adjacent with nothing awaited between them — the contract the comment at `:1296-1308` states and seam 3 §4.5 I-1 pins. 5. `:1315-1320` — `activeContainers.set(...)` gains `claimIncarnation`. 6. `:1346-1368` — `finalizeContainer` stays **synchronous** (it runs from `close`/`error` handlers). Its `active?.process === container` comparison at `:1354` is already the in-process stale-finish fence and is strictly stronger than upstream's registry-identity check, because it compares the actual child process. The durable half is a detached tail: inside the `active?.process === container` branch, `void finalizeClaim(session.id, active.claimIncarnation)`, where `finalizeClaim` reads the claim, skips the release if the row's incarnation has moved on (upstream's durable fence, `6b0411c47` `finish`), and otherwise releases at its own incarnation. Cross-process staleness is not reachable while the fork spawns from one host, but the lease from A is exactly what makes an overlap observable, so the fence lands with the release rather than after the first incident. 7. Cancelled-spawn path: `settlePendingKill` (`:1479-1512`) needs no change — a spawn that never registered a process threw out of the block in point 4 and released there. 8. The throw surfaces through `trackWake` (`:766-771`) as `false` plus `wakeContainer failed — host-sweep will retry`, which is the existing contract for a refused wake.

**Acceptance tests** — `src/session-claim-spawn.test.ts`:

- _"a spawn claims before it touches session runtime state"_ — call-order log; assert the `tryClaimSession` write resolved before `fs.rmSync` on the heartbeat path.
- _"a lost claim starts no container"_ — pre-write a claim at incarnation 5 held by another instance; drive `wakeContainer`; assert `spawn` never called, the promise resolved `false`, and the retry log fired.
- _"a claim write failure starts no container"_ — make `tryClaimSession` reject; same assertions.
- _"nothing is awaited between the guard and spawn"_ — AST case over `spawnContainer`: no `AwaitExpression` between the `wakeRefusalFrom(guard)` call and the `spawn(` call. Same shape as seam 3 §8.6's guard/insert case.
- _"a guard refusal releases the claim"_ — assert `claimed_by` null afterwards, and that a subsequent spawn wins by expecting the bumped incarnation.
- _"a late kill cancellation releases the claim"_.
- _"a shutdown-in-progress refusal releases the claim"_.
- _"container exit releases the claim at its own incarnation"_ — spawn, emit `close`, assert released.
- _"a stale finish does not release a fresh claim"_ — register runtime A at incarnation 1, replace it with runtime B at incarnation 2, emit A's `close`; assert `markContainerStopped` not called for the session, B's claim intact, and `Ignoring stale session finish` logged.
- _"the claimant id is the host instance id when the lease is running"_.

`src/session-claim-callers.test.ts` (§4.1 ratchet):

- _"tryClaimSession has exactly one caller"_ — the caller file/function set is pinned to `claimSessionRun` in `src/container-runner.ts`; the list may shrink, never grow. E adds `adoptRunningSessions` to it in its own PR, deliberately and visibly.

**Rollback.** Revert; `session_claims` rows are ignored by the reverted build. Re-deploying A′ later reads the current incarnation and CASes on it, so the rows left behind cost nothing.

### 7.D — scoped startup quiescence

D1 ships in this batch. D2 is the flip and is gated on E and F (§4.1, divergences 3 and 8).

**Files.**

| File                                   | Change                                                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/workgroup/shared-dirs.ts` | add `workgroupMemoryReconcileWouldChange`; add `workgroupIds` selector + `sharedDirsReconcileWouldChange` to the shared-dirs side                    |
| `src/container-runtime.ts`             | add `listInstallContainersWithScope()`; keep `cleanupOrphansStrict` (D1 still calls its stop-and-prove body)                                         |
| `src/container-restart.ts`             | add `quiesceWorkgroupsForBootMountChange` after `:478`, beside the runtime door                                                                      |
| `src/main.ts`                          | restructure `:283-317`; `runWorkgroupMemoryStartupGate` (`:153-164`) loses `cleanupOrphansStrict` from its body                                      |
| new tests                              | `shared-dirs.wouldchange.test.ts`, `container-restart.boot-quiescence.test.ts`, `boot-quiescence-order.test.ts`, `workgroup-reconcile-doors.test.ts` |

**Insertion points.**

`src/modules/workgroup/shared-dirs.ts`, next to `inspectWorkgroupMemoryState` (`:291`):

```ts
export function workgroupMemoryReconcileWouldChange(
  db: Database.Database,
  workgroupId: string,
  dirs: WorkgroupMemoryDirs = {},
): boolean;
```

Pure: it re-reads the same `lstat` facts `reconcileWorkgroupMemory` (`:370-403`) acts on and returns true when any of the mutations at `:232-240` (canon missing), `:242-247` (a member's local path is not already the exact container-absolute link), `:250-254` (`preferences/` missing) or `:390-393` (`exact-empty` with zero members) would fire. `migration-required` returns false — the reconcile skips those workgroups (`:383-386`), so nothing must be stopped for them. The predicate is deliberately a **superset** of the dangerous case: only the `:242-247` branch actually invalidates a live container's mount targets, but over-stopping is safe and under-stopping is not.

`src/container-runtime.ts`, after `listInstallContainersStrict` (`:105`):

```ts
export interface InstallContainerScope {
  name: string;
  workgroupId: string | null;
  sessionId: string | null;
  groupId: string | null;
}
export function listInstallContainersWithScope(): InstallContainerScope[];
```

One `docker ps --filter label=<install> --format` call emitting name plus `{{.Label "nanoclaw-workgroup"}}`, `{{.Label "nanoclaw-session"}}`, `{{.Label "nanoclaw-group"}}`. It fails closed exactly as `listInstallContainersStrict` does (`:102-104`); an empty label reads as `null`.

`src/container-restart.ts`, after `:478`:

```ts
export async function quiesceWorkgroupsForBootMountChange(
  changedWorkgroupIds: string[],
): Promise<{ containers: number; stopped: number; survivable: number; unlabeled: number }>;
```

Body: list with scope → partition into `mustStop` (workgroup id is `null` — unknown scope, fail-closed, divergence 7 — or in `changedWorkgroupIds`) and `survivable` (labeled and not in the changed set) → **D1: stop everything, count `survivable` as the counterfactual; D2: stop only `mustStop`** → re-list and throw if anything in the stop set survives, reusing `cleanupOrphansStrict`'s proof shape (`container-runtime.ts:123-126`) → emit one `Boot quiescence scope` INFO with the counts.

`src/main.ts` — the new boot order replacing `:283-317`:

```
const changed = workgroups.filter(id => memoryWouldChange(id) || (WORKGROUP_SHARED_FS && sharedWouldChange(id)));
const scope   = await quiesceWorkgroupsForBootMountChange(changed);
await warnMarkedRunningSessionsOfStartup(...)          // unchanged, still :304
if (WORKGROUP_SHARED_FS) reconcileWorkgroupSharedDirs(db, { workgroupIds: changed });
const memoryReports = runWorkgroupMemoryStartupGate(db, { workgroupIds: changed });
pruneAgentRunnerSnapshots();
```

`runWorkgroupMemoryStartupGate` keeps `ensureContainerRuntimeRunning()` and `reconcileWorkgroupMemory`, and drops `cleanupOrphansStrict()` — the quiescence has already happened, in one place, with its scope proved.

**Ordering and safety.** Four properties, each asserted:

1. **Nothing mutates before the quiescence returns.** This fixes divergence 4 as a side effect: `reconcileWorkgroupSharedDirs` moves from `:289` (before the proof) to after it.
2. **The predicate never under-reports.** Its acceptance test compares it against the observed `changed` flag on a fixture matrix, and a mismatch fails the build.
3. **Unknown scope is stopped.** A container with no workgroup label — every container on the first restart after C — is in `mustStop`.
4. **The proof still fails closed.** A runtime listing failure, or a stop that does not take, throws and startup stops before any reconcile runs, exactly as today (`container-runtime.ts:102-104`, `:123-126`).

`pruneAgentRunnerSnapshots` stays after both reconciles and is safe under D2 as well, because `defaultReferencedPaths` reads docker rather than the host's registry (`agent-runner-source.ts:105-131`) — provided divergence 1 holds, which C pins. Update the stale comment at `src/main.ts:310-316` and `agent-runner-source.ts:137-141` in this PR.

**Acceptance tests.**

`src/modules/workgroup/shared-dirs.wouldchange.test.ts` — the case that carries D:

- _"the predicate matches the observed changed flag across the fixture matrix"_ — for each of: canon missing; canon present and a member holding the exact shipped scaffold; a member already holding the exact link; `preferences/` missing; `migration-required`; `exact-empty` with zero members — build the tree in a temp dir, run the predicate, copy the tree, run `reconcileWorkgroupMemory` on the copy, assert `predicate === report.changed`.
- _"the predicate mutates nothing"_ — hash the tree before and after; assert equal.
- _"a migration-required workgroup reports no change"_.
- _"the shared-dirs predicate matches its reconcile"_ — same matrix shape for `sharedDirsReconcileWouldChange`.
- _"the selector confines the reconcile to the named workgroups"_ — two workgroups, one selected; assert the other's tree is byte-identical afterwards.

`src/container-restart.boot-quiescence.test.ts` (fake runtime listing):

- _"a container in a changed workgroup is stopped"_.
- _"a container in an unchanged workgroup is counted survivable"_ — and, **D1**, still stopped; the D2 PR flips this assertion and that flip is the D2 acceptance criterion.
- _"a container with no workgroup label is always stopped"_ (divergence 7).
- _"a runtime listing failure fails closed"_ — the listing throws; assert the primitive throws and no reconcile ran.
- _"a stop that does not take fails closed"_ — the post-stop re-list still shows the container; assert the throw.
- _"the scope log carries every count"_ — assert one `Boot quiescence scope` line with `containers`, `stopped`, `survivable`, `unlabeled`, `changed`.

`src/boot-quiescence-order.test.ts`:

- _"the boot reconciles run only after the quiescence primitive resolves"_ — call-order log across the primitive, `reconcileWorkgroupSharedDirs`, `reconcileWorkgroupMemory`, `pruneAgentRunnerSnapshots`.
- _"shared-FS consolidation no longer runs before the quiescence proof"_ — the divergence-4 regression guard.
- _"a boot where nothing would change stops nothing"_ — **D1**: assert the primitive was called with an empty changed set and reported `stopped == containers`; the D2 PR changes this to `stopped == 0`.

`src/workgroup-reconcile-doors.test.ts` (§4.2 invariant):

- _"reconcileWorkgroupMemory and reconcileWorkgroupSharedDirs have exactly the pinned callers"_ — the file/function set is the boot continuation in `src/main.ts` plus the existing runtime callers; shrink-or-equal.
- _"the boot caller is reached only after a quiescence door"_ — AST over `main()`: no call to either reconciler precedes the `quiesceWorkgroupsForBootMountChange` await.

**Rollback.** Revert; `cleanupOrphansStrict()` returns to `runWorkgroupMemoryStartupGate` and `reconcileWorkgroupSharedDirs` returns to `:289`. No durable state is involved.

## 8. Executable acceptance criteria

For A, B, C, A′ and D the named cases and their assertions are stated inline in §7.A–§7.D; they are the executable criteria and are materialized by `/team-build` before implementing, per PR. E, F and G are written here once §9's driver-seam decision lands.

## 9. Open decisions

- **D2 depends on E and F, not on A′ alone (new, highest).** Evidence: divergence 3 (a survivor is not fenced against a duplicate spawn — the CAS is on `incarnation`, not on claimant liveness) and divergence 8 (`stopAllContainers` iterates `activeContainers`, so an unadopted survivor is leaked at every subsequent shutdown, and the ordinary `systemctl restart` path kills tracked containers anyway). Recommendation: land D1 in this batch as the measurement, and open D2 as a one-assertion flip inside E's restart window.
- **E shape:** wholesale driver-seam port vs minimal adoption over the fork's `activeContainers`. The fork's blocker is concrete and now measurable: an adopted entry needs a stand-in for `entry.process` that emits `close` when the container exits (`src/container-runner.ts:1422`, `:1539`) and that `stopRunningContainer`'s SIGKILL fallback (`:1428`) does not mis-target. Investigation item for the orchestrator, not the operator: measure how much of `docker-driver.ts`/`session-events.ts` the fork's spawn path can absorb without re-deriving the 28-hunk `container-runner.ts` conflict twice. Recommendation to be stated after seam 3 PR 6 is planned.
- **Graceful shutdown semantics:** with adoption, `stopAllContainers()` on SIGTERM becomes wrong (it is what adoption exists to avoid); the systemd `TimeoutStopSec` concern documented at `src/container-runner.ts:1514-1526` must be re-verified against detached supervision before D2 ships.
- **Operator decision — restart budget.** This batch needs three restarts on a production-critical install (§7), and C and D1 cannot share one (divergence 7). Everything else here is an engineering call under the standing delegation.

## 10. Verification commands

```
# per PR, in the worktree $W, one file at a time
ionice -c3 nice -n 10 node_modules/.bin/vitest run <file> --maxWorkers=1
ionice -c3 nice -n 10 node_modules/.bin/eslint src/ --quiet
node_modules/.bin/tsx scripts/check-public-boundary.ts -- --root "$W" --index
pnpm run ratchet:report -- --write            # growth needs --accept + a reason in the PR body
# post-restart gate: existing counters + the §6 table for the series in the batch
```
