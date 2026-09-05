# Plan: Restart survival (convergence seam 4 — upstream #3653 + session adoption)

Status: **proposed** (revision 2 — §4.3 decided, series E, F and G filled to the same standard as A–D; §3/§4.1/§4.2/§5/§6/§7 unchanged from revision 1 except where E/F/G land in them). Re-verified against `origin/main` `a148fc005` on 2026-09-05. Not yet reviewed.
Approval state: not requested. The theme itself is a committed operator must-have (relayed 2026-09-04 by `update-nanoclaw`): both halves — the durable-host rollup and `adoptRunningSessions()` — including the redesign of boot-time workgroup shared-FS reconciliation so it stops requiring every container down.
Primary runtime: Claude (orchestrator: Fable 5.1; builders: worker tiers; cross-model review: Codex gpt-5.6-sol high)
Program: upstream convergence, sync phase (memory `project_upstream_sync_phase_2026_09_04`); follows seam 3 (`docs/specs/upstream-async-central-db-seam/plan.md`).
Upstream target: `nanocoai/nanoclaw` rollup `07f2dda5d` "the durable host" (#3653, ten commits) and the session-driver seam (`src/drivers/**`, 15 files) as they stand on `upstream/main` `b76fcb3d`.
Fork base: `origin/main` `08aad9f93` (seam 3 PRs 1, 2, 3 and 6a merged and deployed; PR 4 open as #411).
Grounding: read-only scout `seam4-restart-survival-scout.md` (orchestrator scratchpad, 2026-09-04), plus the line-anchored source read recorded in §3, re-verified against `origin/main` `08aad9f93` and `upstream/main` on 2026-09-05.
Executable acceptance criteria: **required** (live wake/spawn/delivery paths). The named cases with their assertions are stated inline in §7.A–§7.G; §8 records that and adds nothing of its own.

## 1. Outcome

Two user-visible milestones, in order:

1. **A host restart during an idle session no longer kills and respawns it.** Today every host start runs `cleanupOrphansStrict()` inside the workgroup-memory startup gate (`src/main.ts:162`) and graceful shutdown runs `stopAllContainers()` (`src/main.ts:656`); both stop every install-labeled container, and the systemd unit stops them twice more on its own (divergence 9). After milestone 1 the host stops only sessions whose mounts must change, and a surviving container keeps running across the restart.
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
- **E — adoption (second milestone).** `adoptRunningSessions()`, re-derived over the fork's `activeContainers` entry (§4.3, decision): enumerate by label, claim before adopting, lost CAS → leave the container alone, failed claim write → `pendingAdoptions` retried on the wake path. Terminal detection for an entry with **no supervision child** is one `docker wait <name>` child per adopted container, not upstream's docker-events hub. The same PR closes the three independent ways a survivor is killed today (§4.3, the three doors) and the claim's container fence (§4.3, P2).
- **F — `on_wake` and stop intent for adopted containers.** Three parts. F1: reconcile a survivor's unconsumed `on_wake = 1` rows — convert (re-seq the recall/trigger pair, clear `on_wake` on both halves) or withdraw, by the note's own `_system.kind`, because a container past its first poll can never select them (`container/agent-runner/src/modules/mailbox/selection.ts:188`). F2: the durable stop intent (`session_claims.stop_intent`), so a `groups restart --message` whose host died between the write and the kill is re-issued rather than stranded. F3: the ceiling's `spawnedAt` becomes an adoption-aware `startedAtMs`. Host-side; **the runner does not change**, correcting revision 1's §2 (see §7.F, "what revision 1 got wrong").
- **G — narrow `host-restart-warn`, both sides.** After adoption the startup backstop skips adopted sessions (`src/host-restart-warn.ts:344`) and the shutdown warn covers only the subset the host actually stops (`:326-334`, called from `src/main.ts:648`). The module header's first paragraph describes the world seam 4 removes.

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

### 3.5 The divergences from upstream's assumptions

Eight were found for revision 1; revision 2's E/F/G read added three more (9, 10, 11), all of which change what those series must contain.

1. **The `nanoclaw-v2-` name prefix is load-bearing.** `src/agent-runner-source.ts:107` selects live containers by `name=nanoclaw-v2-`. A _successful_ listing that matches nothing returns an empty set, and only a docker _failure_ returns `null` (`:125-130`) — so renaming containers to upstream's `ncl-…` grammar makes the pruner delete every snapshot except the active one, including one a live container has bind-mounted. **Resolution:** keep the prefix; add labels beside it (C), and make the prefix a single exported constant both sites import so the two cannot drift (§7.C).
2. **`activeContainers` is empty at boot, so the fork's scoped barrier cannot see a survivor.** `quiesceSessionsForRepositoryMounts` derives its stop set from `isContainerRunning(session.id) || isContainerSpawning(session.id)` (`src/container-restart.ts:382`), both of which read the in-process map (`src/container-runner.ts:430-431`, `:434`). At startup that map is empty, so routing the boot reconcile through the existing barrier — as revision 0 of §2 proposed — would stop nothing and run the mount cutover under live containers. **Resolution:** D introduces a second door, `quiesceWorkgroupsForBootMountChange`, whose stop set comes from the container runtime by label (C). The existing barrier stays the _runtime_ door for mount changes while the host is up; §4.2's structural test names both.
3. **`tryClaimSession` does not fence a container that outlived its host.** The CAS is on `incarnation` alone; nothing in the predicate asks whether `claimed_by` is a live instance or whether `container_ref` still exists. A restarted host reads the survivor's claim at incarnation N and wins a CAS at N, so `wakeContainer` (`src/container-runner.ts:608-611`, map empty) spawns a second container against the same session directory. The fresh container's `clearStaleProcessingAcks()` (`container/agent-runner/src/poll-loop.ts:371`) then clears the survivor's in-flight claims, so both re-process the same rows — the exact double-reply class `wakePromises` exists to prevent (`src/container-runner.ts:230-238`). **Resolution:** A′ ships the CAS unchanged, because it does fence the two races upstream wrote it for; D2 (the flip that creates survivors) is gated on E, which registers the survivor in the map and makes the fast path at `:608` true again.
4. **The shared-FS consolidation already runs outside the quiescence proof.** `src/main.ts:289` calls `reconcileWorkgroupSharedDirs(db)` _before_ `runWorkgroupMemoryStartupGate` at `:308` runs `cleanupOrphansStrict()`. Its own doc comment ("runs at startup BEFORE any container spawns", `shared-dirs.ts:418-419`) is true only for spawns _this_ process makes; containers left by the previous host are still live at that point. Masked today because the flag defaults off (`src/config.ts:82-83`). **Resolution:** D moves both reconciles behind the one boot primitive, which makes the ordering an asserted property instead of an incidental one, and gives `reconcileWorkgroupSharedDirs` the `workgroupIds` selector `reconcileWorkgroupMemory` already has.
5. **`changed` is a post-hoc report field, not a scope input.** `reconcileWorkgroupMemory` computes `changed` after mutating (`shared-dirs.ts:388-400`). `inspectWorkgroupMemoryState` (`:291-344`) is non-mutating but answers a different question — a workgroup can report `canonical` and still need a member's symlink written, because the status is computed from the canon plus "substantive" sources and an already-exact member is not substantive. **Resolution:** D adds a pure predicate over the same `lstat` facts, and its acceptance test asserts the predicate equals the observed `changed` across a fixture matrix.
6. **Upstream's coordination code needs no re-derivation.** §2 revision 0 said "re-derived over the fork's driver with SQL byte-for-byte and `Promise`-returning signatures over sync bodies". Seam 3 PR 1 landed upstream's `src/db/driver.ts` byte-identical (`DbDriver.get/all/run/exec/transaction/hasTable/close`, all `Promise`, `:49-63`), so upstream's `coordination.ts` and `host-instance.ts` compile in the fork **verbatim**, imports included (`./connection.js`, `../log.js`, `./config.js` `INSTALL_SLUG` at `src/config.ts:140`). The `no-catch-all` inline disables they carry match the fork's plugin registration (`eslint.config.js:4,13,28`). **Resolution:** A is a copy plus two wiring lines, and both files join the upstream ratchet as byte-identical adds.
7. **A container spawned before C carries no scope label.** On the first restart after C deploys, every live container has only `nanoclaw-install`. **Resolution:** the boot inventory treats an unlabeled container as unknown scope and stops it, fail-closed; and C and D **cannot ride the same restart** (§7, restart batching).
8. **Graceful shutdown would leak a survivor.** `stopAllContainers` (`src/container-runner.ts:1527`) iterates `activeContainers`, so under D2-without-E a container this host did not adopt is neither stopped at shutdown nor tracked at boot — it survives every subsequent restart, unmanaged, and accumulates. The normal restart path is `systemctl restart` → SIGTERM → `shutdown()`, so D2 without E does not even deliver milestone 1 for the ordinary case; it only changes the crash path, and makes it worse. **Resolution:** D2 lands with E, and the `TimeoutStopSec` question is answered in the same PR (§4.3).
9. **The host process is only ONE of three things that kill a container on restart, and it is not the decisive one.** `scripts/nanoclaw-v2.service:17` and its deployed copy `data/systemd/nanoclaw-v2.service:17` carry `ExecStop=/bin/sh -c 'docker ps --filter name=nanoclaw-v2- … | xargs … docker stop -t 10 {}'`, which stops every container of this install on `systemctl restart` regardless of what Node does. Neither file sets `KillMode`, so systemd's default `control-group` also SIGTERMs every process in the unit's cgroup — including each attached `docker run` client, which proxies signals to its container by default and so kills it a third way. **Resolution:** §4.3, "the three doors". Milestone 1 is unreachable without all three, and two of them are unit-file changes on an install-managed file, not code.
10. **`on_wake` is not the delivery mechanism for two of the three notes revision 1 named.** `host-restart-*` (`src/host-restart-warn.ts:286`) and `ceiling-respawn-*` (`src/modules/sweep-continuation/index.ts:289` → `writeSystemWake`, `src/host-sweep.ts:844`) both go through `insertDeferredMessageWithContextIfNew` (`src/modules/mailbox/ops/ingress.ts:123-141`), which writes `trigger = 0` plus an inert `recall-<id>` partner. The sweep's due admission (`admitDueRow`, `ops/admission.ts:129-150`) is what makes them wakeable, and it already sets `on_wake = 0` on both halves. Only `groups restart --message` writes a bare first-poll row (`src/container-restart.ts:526-544`, `trigger` defaults to 1 at `ops/ingress.ts:49`). **Resolution:** F handles one row shape, not three, and the residual risk is a stale note delivered to a survivor rather than an undelivered one — the opposite failure from the one revision 1 planned for.
11. **An adopted container's heartbeat reads as "from a prior container".** `decideStuckAction` (`src/modules/sweep-container-health/index.ts:440-500`) skips the ceiling kill when `heartbeatMtimeMs < spawnedAtMs` and the session is inside `SPAWN_GRACE_MS` (`src/host-sweep.ts:174`, 60 s). For an adopted entry `spawnedAtMs` is the adoption instant and the heartbeat is genuinely this container's, so the predicate is false by construction and a wedged survivor buys a free grace window on every restart. **Resolution:** F3 threads an `adopted` flag into the predicate.

## 4. Design

### 4.1 Ordering is the safety argument

The biggest risk is **two writers on one session** (a host and an orphan, or two hosts). Today `cleanupOrphansStrict`'s fail-closed proof is the only thing preventing it.

The order that keeps the proof intact at every deployed state:

- **A** adds durable state nobody reads. It cannot change behavior; its worst failure is a WARN.
- **B** moves one counter from process memory to a row. It changes retry arithmetic and nothing else.
- **C** adds labels and pins the name prefix. It is the vocabulary D needs, and it must be _deployed one restart earlier_ than D so live containers actually carry it (divergence 7).
- **A′** makes `tryClaimSession` the only path that may start a container, with a ratchet test pinning its callers. It closes the two-live-hosts and stale-`finish()` races **while `cleanupOrphansStrict` is still running**, so it is a strict addition of safety with no window of its own.
- **D1** replaces the fleet-wide stop with a primitive that computes the scoped set, proves it, logs the counterfactual, and then stops exactly what `cleanupOrphansStrict` stopped. Behavior identical; the scope decision runs in production before it is allowed to skip a stop.
- **D2** flips the primitive to honour its own scope. This is the first state in which a container outlives a host restart, and divergences 3, 8, 9 and 10 say that state is only safe once **E** re-registers survivors in `activeContainers` (restoring the `wakeContainer` fast path at `src/container-runner.ts:608`), **E** also closes the two unit-file doors that kill containers regardless of what Node does, **F** reconciles the `on_wake` rows a survivor can never select and makes an interrupted restart recoverable, and **G** stops the host telling an adopted session its container was stopped mid-work. Four merges, one restart (§7).

Invariant in a primitive, part 1: `tryClaimSession` (CAS on `incarnation`, `changes > 0`) is the only path that may start or adopt a container. `src/session-claim-callers.test.ts` pins its caller set as a file list (shrink-or-equal), the same ratchet shape seam 3 uses for `getRawDb` and seam 2 uses for `computeOffenders`.

### 4.2 Mount changes go only through a quiescence door

Invariant in a primitive, part 2: `reconcileWorkgroupMemory` and `reconcileWorkgroupSharedDirs` may run only from inside one of exactly two doors —

- **the boot door**, `quiesceWorkgroupsForBootMountChange(changedWorkgroupIds)`, whose stop set comes from the container runtime by label, or
- **the runtime door**, `quiesceAgentGroupsForRepositoryMounts` / `quiesceSessionsForRepositoryMounts` (`src/container-restart.ts:363,372`), whose stop set comes from the in-process registry,

or from the no-container path when the boot predicate reports no workgroup would change. `src/workgroup-reconcile-doors.test.ts` pins the caller file set for both reconcilers and asserts the boot call order (`quiesce…` resolves before either reconciler is entered, and `pruneAgentRunnerSnapshots` runs after both). Two doors rather than one because the two stop sets have different authorities and the fork cannot merge them until adoption makes the registry complete at boot (divergence 2).

The boot door does **not** fence session ingress and does not wait for a barrier ack, unlike the runtime door. Deliberate: today's boot path (`cleanupOrphansStrict`) stops the same population with no fence and no drain, so adding one at boot would be new behavior on the startup critical path with a 120 s per-session timeout (`src/container-restart.ts:375`), and the sessions being stopped are exactly the ones whose mounts are changing. The boot door is a scoped `cleanupOrphansStrict`, not a scoped `quiesceSessionsForRepositoryMounts`.

### 4.3 Adoption without a supervision child — decided

**Decision: option 2 — minimal adoption re-derived over the fork's `activeContainers` entry, with `docker wait` as the terminal channel for adopted entries.** Not the wholesale driver-seam port, and not the hybrid.

#### 4.3.1 Why, in three sentences

The fork's `src/container-runner.ts` is 4,921 lines to upstream's 1,257, and nearly all of the difference is fork-owned spawn policy — storage-activity leases, memory admission, the OneCLI gateway apply, repository mounts, capability snapshots, deferred kills, the guard point — so porting the driver seam means re-deriving that policy through upstream's `SessionSpec` and moving the fork's pinned "nothing awaits between the guard and `spawn()`" adjacency (`src/container-runner.ts:1296-1313`, seam 3 §4.5 I-1) behind an async `driver.prepare()` plus `handle.start()`. The only capability adoption actually needs from that seam is a terminal signal for a runtime with no supervision child, and one `docker wait <name>` child per adopted container supplies exactly that while keeping `entry.process.once('close', …)` working unchanged at all four sites that depend on it (`:1422`, `:1454`, `:1539`, `:1543`). Upstream's `session-events.ts` hub buys truth-verification, at-most-once delivery, stop-intent suppression and arming-order buffering over a lossy, replay-prone `docker events` stream — real value for a driver that may be remote, and a cost the fork does not have to pay against one local daemon and a per-container waiter, which is why the hybrid earns nothing but its own maintenance.

#### 4.3.2 The three options, costed

|                                      | Option 1 — wholesale port                                                                                                                                          | Option 2 — minimal adoption (**chosen**)                                                                                                     | Option 3 — hybrid (`session-events.ts` + `SessionSpec` admission)                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Files touched                        | `src/drivers/**` 15 new (~180 KB) + `container-runner.ts` restructured + `container-runtime.ts` absorbed + `container-restart.ts`, `main.ts`, `host-sweep` callers | `container-runner.ts`, `container-runtime.ts`, `main.ts`, `modules/sweep-container-health/index.ts`, both `nanoclaw-v2.service` files, tests | `src/drivers/types.ts` + `session-events.ts` + a fork adapter, then most of option 1 anyway |
| Upstream ratchet                     | 15 byte-identical adds, then immediate local divergence at the name grammar                                                                                        | no upstream-owned adds; `container-runner.ts` growth only                                                                                    | `types.ts` is 30 KB of contract the fork uses one interface from                            |
| `nanoclaw-v2-` prefix (divergence 1) | driver derives names itself; keeping the prefix forks `docker-driver.ts` and destroys the byte-identity that justified the port                                    | untouched — C's one constant stays authoritative                                                                                             | same as option 1                                                                            |
| Guard-point adjacency (seam 3 I-1)   | **broken** — `prepare`/`start` are both async                                                                                                                      | preserved; the claim is still the last `await`                                                                                               | broken, once `SessionSpec` admission lands                                                  |
| Mailbox seam                         | `withExistingMailboxSession` and I-10 unaffected either way; adoption must not provision an `outbound.db` for a session it adopts                                  | same                                                                                                                                         | same                                                                                        |
| Ceiling accountability               | `ActiveSessionRuntime.startedAtMs` already carries upstream's adoption semantics; the fork's `getContainerSpawnedAt` callers all move                              | `getContainerSpawnedAt` keeps its signature; F3 adds one `adopted` flag                                                                      | same as option 1                                                                            |
| Quiesce barrier                      | `quiesceSessionsForRepositoryMounts` reads `isContainerRunning`; a registry rebuilt by any option satisfies it                                                     | satisfied                                                                                                                                    | satisfied                                                                                   |
| Repository fences                    | unchanged by all three; see 4.3.6                                                                                                                                  |                                                                                                                                              |                                                                                             |
| Honest size                          | a rewrite of the fork's most-diverged file, inside a seam whose deliverable is "stop killing containers"                                                           | one new function, one new entry shape, two unit-file lines                                                                                   | option 1's cost with option 2's benefit                                                     |

Option 1 is the right end state for a project that will grow a second runtime. The fork has one runtime and no plan for a second, so paying for portability here buys nothing this seam can point at.

#### 4.3.3 The terminal channel

`activeContainers`'s value type becomes a discriminated union on how the runtime is supervised:

```ts
type SupervisionChannel =
  | { kind: 'spawned'; process: ChildProcess } // today: `docker run --rm`, close == terminal
  | { kind: 'adopted'; waiter: ChildProcess }; // `docker wait <name>`, close == terminal
```

`docker wait` is chosen over a `docker events` subscription for four reasons, in order of weight: its `close` **is** the terminal, so no hub is needed to verify a hint against truth; it preserves the `.once('close', cb)` shape the kill, shutdown and finalize paths already use; a per-container process fails independently, where one dropped events subscription ends supervision for every session of the install at once (upstream's own `#connectWatch` comment says exactly this); and it needs no reconnect backoff, no gap reconcile and no synthetic-hint replay. Its one weakness is that a docker-daemon restart exits every waiter at once and would read as a fleet-wide terminal, so the one piece of the hub's discipline that earns its place is kept: on a waiter `close`, re-read truth once (`docker inspect --format '{{.State.Running}}' <name>`) before finalizing, and on a listing failure treat the container as **still running** and re-arm the waiter. That is ten lines, not a hub.

Two channels rather than one is a real complexity cost and the honest from-scratch answer is one (§4.3.7). The union makes it explicit rather than implicit, and every site that must branch on it is named in §7.E.

#### 4.3.4 The claim fence — the exact predicate, and where it lives

Divergence 3's hole is that `tryClaimSession` CASes on `incarnation` alone. A crashed host's claim is **deliberately** takeover-able (`src/db/coordination.ts:108-113`, "an unknown claimant reads as not-live"), so incarnation cannot distinguish "nobody is running this session" from "a survivor is running it". The fence is two predicates inside one function, `claimSessionRun` in `src/container-runner.ts` (introduced by A′, §7.A′ point 3, extended here):

```ts
async function claimSessionRun(
  sessionId: string,
  containerRef: string,
  opts: { adopting?: boolean } = {},
): Promise<number | null> {
  const current = await getSessionClaim(sessionId);
  const self = claimantId();

  // P1 — a LIVE peer host already owns it. Two live hosts never trade a session.
  //      A stopped, lease-expired or unknown holder stays takeover-able: a
  //      crashed claimant must never wedge a session.
  if (current?.claimed_by && current.claimed_by !== self) {
    if (await getLiveHostInstance(current.claimed_by, new Date().toISOString())) return null;
  }

  // P2 — an UNTRACKED container is still running for this session. This is the
  //      divergence-3 fix: fence on the container, not on the incarnation.
  //      Skipped for the adopter, which is holding the survivor by definition.
  if (!opts.adopting && current?.container_ref && !activeContainers.has(sessionId)) {
    if (runtimeShowsRunning(current.container_ref)) return null; // fails CLOSED
  }

  return tryClaimSession({
    sessionId,
    instanceId: self,
    expectedIncarnation: current?.incarnation ?? 0,
    containerRef,
    now: new Date().toISOString(),
  });
}
```

P1 is upstream's, verbatim in shape (`upstream/main:src/container-runner.ts:142-161`). P2 is fork-added and is the answer to "fence on a live host lease **or** a live container".

**P2 costs nothing in steady state.** `releaseSessionClaim` nulls `container_ref` on every clean exit (`src/db/coordination.ts`, the release statement), so a session that ended normally reaches P2's first conjunct false and never touches the runtime. A session this host is running reaches the second conjunct false. The only path that pays one `docker ps` is exactly the post-crash case P2 exists for. `runtimeShowsRunning(name)` is a new export in `src/container-runtime.ts` beside `listInstallContainersStrict` (`:92-105`), sharing its fail-closed contract: a listing that throws returns `true`, refusing the spawn, because "cannot prove absence" must never read as "absent".

Three more layers stand behind P1/P2, and all four are asserted in §7.E:

- **P3 — ordering.** `adoptRunningSessions()` resolves before anything that can issue a wake: before `startDashboard()` (`src/main.ts:392`), before the channel adapters, before `startHostSweep()` and `startDeliveryPolls()`. A boot-order test pins it.
- **P4 — `pendingAdoptions`.** A survivor whose claim write failed is alive and untracked. It is held in a module-level `Set` and consulted by `wakeContainer` before the spawn path, which calls `retryPendingAdoption` (re-lists from the runtime; container gone → a fresh spawn is correct; claim lost → throw, no spawn; store still down → throw, the sweep retries). Upstream's shape, ported (`upstream/main:src/container-runner.ts:206-244`).
- **P5 — the boot inventory.** A container the host cannot map to an adoptable session is stopped by `quiesceWorkgroupsForBootMountChange` under D's unknown-scope rule (divergence 7).

#### 4.3.5 Shutdown — the three doors

Divergence 9 is the finding that reorders this section's priority: **Node's `stopAllContainers()` is not what kills containers on `systemctl restart`.** All three doors must close, and two of them are unit-file changes:

1. **`stopAllContainers()` on the shutdown path** (`src/main.ts:656`). Replaced by `beginContainerShutdown()`, which keeps the two things the flag actually buys — `containerShutdownInProgress = true`, read by the spawn path at `src/container-runner.ts:1293`, and `memoryAdmission?.shutdown()` — and then waits only for entries still **spawning** to settle, bounded by the existing grace. Running containers are left alone. `stopAllContainers` stays exported and keeps its tests; its only caller becomes the boot door's stop set.
2. **`ExecStop=` in the unit** (`scripts/nanoclaw-v2.service:17`, `data/systemd/nanoclaw-v2.service:17`). Removed. Its stated purpose is a belt-and-suspenders sweep for containers that escaped a crashed Node; under D2+E that sweep is the thing being removed, and the equivalent guarantee moves to boot: a container the fresh host cannot adopt is stopped by the boot door, fail-closed. Removing it is what makes milestone 1 observable at all.
3. **`KillMode`** (unset in both units, so systemd's default `control-group`). Set to `mixed`. The default SIGTERMs every process in the unit's cgroup, and each attached `docker run` client proxies signals to its container by default, so the container dies even with doors 1 and 2 closed. `mixed` sends SIGTERM to the main process only and reserves the cgroup-wide SIGKILL for the `TimeoutStopSec` expiry.

**`TimeoutStopSec` becomes 30, down from 60.** Its 60 s value was sized for door 1: `stopAllContainers` waits up to 10 s for close events and then hard-kills, and `ExecStop`'s parallel `docker stop -t 10` could take longer under load. With both gone, the stop path is Node's own `shutdown()` — module stops, adapter teardown, CLI server — none of which wait on a container. 30 s keeps a generous safety bound while halving the worst case a hung shutdown costs a deploy. It is a bound, not a budget: nothing in the new path is expected to use it.

Two runtime-version facts, **verified on the live host 2026-09-05 03:35Z (Docker Engine 29.3.1)** rather than asserted from source:

- `--rm` cleanup **is daemon-side** (`HostConfig.AutoRemove`): a `--rm` container whose client is gone leaves zero `docker ps -a` rows after exit, so an exited survivor leaves no record and the boot door has nothing to reap — no `reapResidue` equivalent is needed.
- `docker wait` on a container already removed **exits promptly** (exit 1, `No such container`, 20 ms), never hangs. The adopted-entry waiter therefore treats a non-zero `docker wait` exit with that error as terminal after the one `docker inspect` truth re-read (§4.3.3) — it must not be re-armed.

#### 4.3.6 What adoption must not silently paper over

- **Repository ingress fences.** A survivor can be sitting behind an **active** fence written by the host that died — the 2026-09-01 shape, 1401 sessions fenced with no publication left to release them. `releaseOrphanedRepoIngressFencesAtStartup()` (`src/main.ts:356`) already recovers those, and adoption must run **before** it stops being true that every active fence is orphaned — i.e. adoption goes after the boot quiescence and before the fence recovery, so the recovery's premise ("a fresh process holds no mount claims") still holds. Adoption emits a count of adopted-with-active-fence sessions so the case is visible rather than a silently deaf agent.
- **Processing claims are an argument FOR adoption.** A fresh container runs `clearStaleProcessingAcks()` on boot (`container/agent-runner/src/poll-loop.ts:371`) and re-processes the rows the previous one had claimed — the double-reply class. A survivor's claims are its own and still in flight, so adoption removes that hazard rather than adding one.
- **The prefix and the pruner.** `pruneAgentRunnerSnapshots()` finds live containers with `docker ps -q --filter name=nanoclaw-v2-` (`src/agent-runner-source.ts:107`) and returns `null` — prune nothing — when docker cannot be queried. That is already adoption-safe, and it is why C pins the prefix in one constant. The stale comment at `src/main.ts:314-316` ("when container adoption across restarts lands … this ordering assumption needs revisiting") is answered by E and rewritten in it.

#### 4.3.7 The from-scratch test

Built today, with no v1 residue:

- **Keep.** The `session_claims` row as the fence; boot-time adoption; the deferred recall/trigger admission pair; the fail-closed "cannot prove absence" discipline in every runtime listing.
- **Drop.** `docker run --rm` with the CLI child as the supervision channel. Nothing consumes the child's stdout (`src/container-runner.ts:1339`) and stderr is a ten-line tail; the child exists because v1 piped stdio. A from-scratch host runs detached and treats the runtime as the only source of truth. Also drop the unit's `ExecStop` sweep and stopping workers in order to restart the supervisor — a restart-survivable host does neither.
- **Simplify.** One supervision channel, not two. This plan ships two because converting the spawn path to detached-plus-waiter is a second large change to `container-runner.ts` inside a seam that already changes it three times. The follow-up is named rather than implied: after E is deployed and stable, a PR converts `'spawned'` to the same waiter channel and deletes the union. Filed at that point, not now.

#### 4.3.8 The trade in product terms

What the operator gives up and what they get, stated as the two failure modes rather than as a benefit list.

**Today's cost is certain and recurring.** Every host restart takes every mid-work session's turn, its in-container background work and its `/tmp`, and the sessions that show work-in-flight evidence each post a public "done / lost / next" accounting. That is the failure family `host-restart-warn.ts` exists to make survivable rather than to prevent, and it is why deploys are scheduled around quiet hours at all. During convergence work the install restarts often, so the cost is paid many times a week and it lands on live conversations.

**Adoption's cost is rare and bounded.** A wrong adoption has two shapes. The host adopts a container that is actually dead or unreachable, and the session goes quiet until the sweep's stale detection fires — bounded by the 30-minute ceiling, and the ceiling's follow-up wake then accounts for it publicly, so the worst case is a slow session rather than a silent one. Or two writers reach one session — the serious shape, and the one P1 through P5 exist to make unreachable; it is fenced durably (a live peer's claim is refused), by the runtime (an untracked live container refuses a spawn), by ordering (adoption precedes every wake source), by retry (`pendingAdoptions`) and by the boot door (unknown scope is stopped).

**The judgement.** Trading a certain per-restart interruption for a rare bounded stall is the right trade, and the reason to state it explicitly is that the two costs are not felt the same way: the current one is loud and expected, the new one is quiet and surprising. That asymmetry is why §6 gives E five counters of its own and why `adopted == survivable` from the same boot is the check that either agrees or does not.

## 5. Safety, rollout, rollback

- Every PR leaves the tree building and independently deployable. Rollback = revert the `--no-ff` merge, build, restart; anchors as in seam 3 §5, plus the deployer's pre-restart `data/v2.db` copy for any restart that carries a schema-touching PR (none in this batch — 071 is already applied).
- **A, B, C** are additive at the schema level and inert on revert: the rows they write are ignored by the previous build. **A′** leaves `session_claims` rows behind on revert; harmless, because a build without A′ never reads them and a re-deployed build with A′ reads the current incarnation and CASes on it. **D1** restores `cleanupOrphansStrict()` into `runWorkgroupMemoryStartupGate` on revert.
- **Live-user risk ranking:** E/D2 (a wrong adoption leaves a session deaf until the ceiling fires, and the unit-file changes are outside the build's rollback) > D1 (a throw in the new primitive blocks startup) > A′ (every spawn now takes a DB write before the guard point) > B (a message that already failed twice under a previous host now gives up on its first attempt after a restart — intended, but the operator will see fewer retries across a restart) > C (five extra `--label` flags per spawn) > F, G (note text and routing only) > A (write-only).
- **The E/D2 rollback is two-part and the unit half is not git.** Reverting the merge restores `stopAllContainers()` on the shutdown path, but a reverted build against a unit that still lacks `ExecStop` and carries `KillMode=mixed` leaves survivors nobody stops. The revert procedure is therefore: restore both `nanoclaw-v2.service` changes on the host, `systemctl daemon-reload`, then revert the merge, build and restart — in that order, because the unit is what actually kills the containers (divergence 9). The trunk template `scripts/nanoclaw-v2.service` and the deployed `data/systemd/nanoclaw-v2.service` are separate files and both change; the deployed copy is install data.
- **Restart approval:** the operator's standing window closed 2026-09-04 23:59 ET, so every restart in this batch needs an explicit go. This batch needs **four** restarts (§7) on a production-critical install; that budget is the one item only the operator can settle (§9).
- **Seam 3 interaction:** PR 4 (#411, ~147 files including `delivery.ts` and `container-runner.ts`) is open. Every series here branches from a base that already contains PR 4, or rebases onto it before review. New code uses `getDb()` and `await`; it must never import `getRawDb` — `src/db/raw-db-ratchet.test.ts` pins 219 importer files shrink-only, and an added importer fails the build.
- **Upstream ratchet:** A adds two upstream-owned files byte-identical, so `pnpm run ratchet:report -- --write` should report no growth. B, C, A′ and D touch upstream-owned files (`delivery.ts`, `container-runner.ts`, `main.ts`) and each PR regenerates the report; growth needs `--accept` and a reason in the PR body (CLAUDE.md).

## 6. Observability

Nothing new in the hot path. The post-restart gate already counts `ERROR`/`WARN` classes, `preflight ok`, spawned/delivered and the seam counters. This seam adds, per series:

| Series | Signal                                                                                                                              | Expected                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A      | `Host instance lease started` (new INFO, instance id + ttl)                                                                         | exactly 1 per boot                                                              |
| A      | `Host instance lease row missing on renewal` / `Host instance lease renewal failed` / `Failed to mark host instance stopped` (WARN) | 0                                                                               |
| A      | `host_instances`: one row with `stopped_at IS NULL`; the previous boot's row stamped (graceful) or lease-expired (crash)            | this is the fork's first durable clean-vs-unclean-restart signal                |
| B      | `Failed to record delivery attempt — retrying next poll without a count` (ERROR)                                                    | 0                                                                               |
| B      | `Failed to clear delivery attempt row` (WARN)                                                                                       | 0                                                                               |
| B      | `Message delivery failed permanently, giving up`                                                                                    | unchanged vs the prior boot                                                     |
| B      | `SELECT count(*) FROM delivery_attempts` a few minutes after boot                                                                   | ≈0 (rows clear on delivery and on give-up)                                      |
| C      | `docker inspect` the newest container: five labels present; containers whose name lacks `nanoclaw-v2-`                              | 5 / 0                                                                           |
| A′     | `is claimed by another live host process — not spawning a duplicate` (ERROR via `trackWake`)                                        | 0                                                                               |
| A′     | `Ignoring stale session finish` (WARN)                                                                                              | 0                                                                               |
| A′     | `session_claims` rows with `claimed_by IS NOT NULL` vs `getActiveContainerCount()`                                                  | equal at steady state — a durable-vs-memory agreement check                     |
| D1     | `Boot quiescence scope` (new INFO, once per boot): `{ workgroups, changed, containers, stopped, survivable, unlabeled }`            | `stopped == containers`; `survivable` is the milestone-1 counterfactual         |
| E      | `Reconciled sessions at startup` (new INFO, once per boot): `{ adopted, stopped, pendingClaim, fencedInbound }`                     | `adopted == survivable` from the same boot's D1 line                            |
| E      | `Session adoption skipped — another live host process holds the claim` (WARN)                                                       | 0 — a non-zero count means two hosts are live                                   |
| E      | `Session claim write failed during adoption — leaving the container unadopted for retry` (ERROR)                                    | 0                                                                               |
| E      | `Refusing session claim — a container is still running for this session` (WARN, P2)                                                 | 0 at steady state; non-zero only after a crash, and never twice for one session |
| E      | `Adopted container waiter exited but the container is still running — re-arming` (WARN)                                             | 0                                                                               |
| F      | `Reconciled on_wake rows for an adopted session` (new INFO): `{ converted, withdrawn }`                                             | small and bounded; `converted + withdrawn` never exceeds the adopted count      |
| F      | `Re-issuing interrupted restart` (INFO, the durable stop intent)                                                                    | 0 on a graceful restart; ≥1 only after a host died mid-restart                  |
| G      | `Wrote host-restart accountability note`                                                                                            | strictly fewer than the pre-E boot: adopted sessions get none                   |

**Milestone 1 evidence, once D2 + E + F are deployed.** After a `systemctl restart`, the milestone is proven by all six of:

1. `Boot quiescence scope` with `changed: 0`, `stopped: 0`, `survivable: N` (N > 0).
2. Absence of `Stopped orphaned containers and proved install quiescence` (`src/container-runtime.ts:128`) — the fleet-wide stop did not run.
3. `Reconciled sessions at startup` with `adopted: N, stopped: 0, pendingClaim: 0`.
4. For each survivor's session id: **no** `Spawning container` line in the post-restart window, and `Container already running` (`src/container-runner.ts:609`) on its first wake.
5. `docker inspect` on each survivor: the same container id, and `State.StartedAt` earlier than the host's `NanoClaw starting` line.
6. Zero `Ignoring stale session finish` and no session id appearing twice in `Spawning container`.

Until D2 ships, line 1 is the only one available and its `survivable` count is the measurement D1 exists to take.

## 7. Implementation path

| PR  | Scope                                                                                 | Depends on                    | Restart   | Owner                                                            |
| --- | ------------------------------------------------------------------------------------- | ----------------------------- | --------- | ---------------------------------------------------------------- |
| A   | coordination accessors + host lease (write-only)                                      | seam 3 PR 2 (tables, merged)  | restart 1 | runner-mailbox owner                                             |
| B   | poison-message fix onto `delivery_attempts`                                           | A merged                      | restart 1 | runner-mailbox owner                                             |
| C   | labels; `nanoclaw-v2-` prefix pinned in one constant                                  | —                             | restart 1 | runner-mailbox owner                                             |
| A′  | claim-first spawn + release on finish                                                 | A deployed                    | restart 2 | runner-mailbox owner                                             |
| D1  | boot quiescence primitive + `wouldChange` predicate + measurement; stop set unchanged | C **deployed**, A′ deployed   | restart 3 | runner-mailbox owner; seam-2 owner reviews the sweep interaction |
| E   | adoption + the three shutdown doors                                                   | D1 **deployed**               | restart 4 | runner-mailbox owner                                             |
| F   | `on_wake` reconciliation, stop intent, adoption-aware ceiling                         | E (same PR chain, own commit) | restart 4 | runner-mailbox owner                                             |
| G   | narrow host-restart-warn, both sides                                                  | E                             | restart 4 | runner-mailbox owner                                             |
| D2  | the flip: honour the scope (one assertion + one branch)                               | E, F, G                       | restart 4 | runner-mailbox owner                                             |

**Restart batching. Four restarts for this batch, not three.** A + B + C share **restart 1** (all additive, B the only behavior change and it is bounded to retry counts). A′ takes **restart 2** alone: it puts a DB write in front of every spawn, and a spawn regression must not be confounded with a delivery or labelling change. D1 takes **restart 3**: C must have been live for at least one restart cycle or every container the boot inventory sees is unlabeled (divergence 7) and the `survivable` measurement is meaningless.

**E, F, G and D2 share restart 4, and they cannot be split across restarts.** Each of the four is unsafe alone: E without D2 adopts containers the boot door then stops (harmless but pointless); D2 without E leaks survivors at every shutdown (divergence 8); D2 without F delivers a "your container was stopped mid-work" note to a container that was not (divergence 10); D2 without G writes that note for every adopted session. They are four merges and one restart. Restart 4 is also the first restart at which a container survives, so it is the one that needs the milestone-1 evidence block from §6 run in full, and the one whose rollback is two-part (§5).

The prior restart's survivors are the population restart 4 measures, so restart 4 must follow restart 3 by long enough for the `survivable` count to be non-trivial — in practice a normal working day, not a back-to-back deploy.

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

### 7.E — adoption

The second milestone. Ships with F, G and D2 on one restart (§7, restart batching).

**Files.**

| File                                | Change                                                                                                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/container-runner.ts`           | supervision union; `adoptRunningSessions`; `pendingAdoptions` + `retryPendingAdoption`; P2 in `claimSessionRun`; channel-aware kill/shutdown; `finalizeSession` lifted to module scope |
| `src/container-runtime.ts`          | `runtimeShowsRunning(name)`, `waitForContainerExit(name)`                                                                                                                              |
| `src/main.ts`                       | call `adoptRunningSessions()` after the boot door and before the fence recovery; `beginContainerShutdown()` at `:656`                                                                  |
| `scripts/nanoclaw-v2.service`       | drop `ExecStop=`; add `KillMode=mixed`; `TimeoutStopSec=30`                                                                                                                            |
| `data/systemd/nanoclaw-v2.service`  | same three lines (deployed copy, install data — called out in the PR body)                                                                                                             |
| new tests                           | `src/container-adoption.test.ts`, `src/adoption-order.test.ts`, `src/container-supervision-channel.test.ts`                                                                            |
| `src/session-claim-callers.test.ts` | the pinned caller set grows by exactly one, deliberately and visibly (§7.A′)                                                                                                           |
| `src/upstream-ratchet.json`         | regenerated                                                                                                                                                                            |

**Insertion points.**

`src/container-runner.ts:185-193` — the registry value type. `process: ChildProcess` becomes `channel: SupervisionChannel` (§4.3.3), and the entry gains `adopted: boolean` and `claimIncarnation?: number` (the latter from A′). `spawnedAt` keeps its name and its `getContainerSpawnedAt` accessor (`:224-226`); for an adopted entry it is the adoption instant, which is the honest answer — this host has no spawn time for a container a previous host started, and leaving it 0 would exempt every adopted session from the ceiling.

`src/container-runner.ts:1346-1368` — `finalizeContainer` is today a closure inside `spawnContainer`, and adoption has no such closure. Lift it to a module-level `finalizeSession(sessionId, channel: SupervisionChannel, storageActivity: StorageActivityLease | null)`. Its identity fence stays exactly as strong: `activeContainers.get(sessionId)?.channel === channel` compares the same object the caller registered, which is what `active?.process === container` compares today (`:1354`). Adopted entries pass `storageActivity: null` — this host holds no lease for a container it did not spawn, and acquiring one at adoption would double-count the session against the storage admission controller.

`src/container-runner.ts:1419-1430` — `stopRunningContainer`'s two channel-sensitive lines. `for (const callback of onExit) entry.process.once('close', callback)` becomes `channelOnClose(entry.channel, callback)`, and the SIGKILL fallback becomes channel-aware: killing an adopted entry's **waiter** would abandon the container, so the fallback for `'adopted'` is `docker kill <containerName>` and only then the waiter. This is the one place a naive union would be silently wrong, so it carries its own named case.

`src/container-runner.ts:1527-1571` — `stopAllContainers` keeps its body and stops being called at shutdown (§4.3.5, door 1). Its `entry.process.exitCode !== null` early-out (`:1533`) becomes `channelHasExited(entry.channel)`.

`src/container-runner.ts`, new export, placed after `killContainer` (`:1454`):

```ts
export async function adoptRunningSessions(): Promise<{
  adopted: number;
  stopped: number;
  pendingClaim: number;
  fencedInbound: number;
}>;
```

Body, in order — upstream's shape (`upstream/main:src/container-runner.ts:619-683`) re-derived over the fork's registry:

1. `listInstallContainersWithScope()` (D1's export). A listing failure logs WARN and returns all-zero: adoption that cannot see the runtime adopts nothing, and the boot door has already run its own fail-closed proof.
2. For each container: resolve `nanoclaw-session` → `getSession(id)`. No session, session not `active`, or no session label at all → `stopContainer(name)`, `stopped += 1`. An unlabeled container never reaches here — D's unknown-scope rule stopped it (divergence 7).
3. `claimSessionRun(session.id, name, { adopting: true })`. Write failure → `pendingAdoptions.add(session.id)`, ERROR, `pendingClaim += 1`, **leave the container alone**; a lost CAS → WARN, leave it alone. Fail-closed both ways: an unfenced adoption could stomp a newer claimant, while an unadopted-but-running container is safe because the spawn path is claim-first fail-closed too (P2) and the wake path reclaims it (P4).
4. Register: `activeContainers.set(id, { channel: { kind: 'adopted', waiter: waitForContainerExit(name) }, containerName: name, spawnedAt: Date.now(), adopted: true, storageActivity: null, claimIncarnation })`; `everSeenRunningSessions.add(id)`; `markContainerRunning(id)`; arm the waiter's `close` on `finalizeSession`.
5. Count `fencedInbound`: sessions whose inbound DB carries an active repository ingress fence (§4.3.6). Counted, not acted on — `releaseOrphanedRepoIngressFencesAtStartup()` at `src/main.ts:356` is the owner and runs after this.
6. One INFO, `Reconciled sessions at startup`, with all four counts.

`src/container-runner.ts`, `wakeContainer` (`:599-611`) — before the `isContainerRunning` fast path at `:608`, consult `pendingAdoptions`; a hit routes to `retryPendingAdoption(session)` and never to `spawnContainer`.

`src/main.ts` — between the boot door (D's `quiesceWorkgroupsForBootMountChange`, which replaces `:308`'s gate) and the fence recovery at `:355`:

```ts
const reconciled = await adoptRunningSessions();
```

Placed there for two reasons, both asserted: every wake source starts later (`startDashboard()` `:392`, the adapters, the sweep, delivery), and the fence recovery's premise — "a fresh process holds no mount claims, so every active fence is orphaned" (`:347-354`) — must still be true when it runs.

`src/main.ts:652-659` — `await stopAllContainers()` becomes `await beginContainerShutdown()` (§4.3.5, door 1). The comment above it, which explains the call by systemd `TimeoutStopSec`, is rewritten rather than deleted: the reason it existed is now the reason it is going.

**Ordering and safety.** Five properties, each asserted below:

1. **Claim before adopt, and never adopt unfenced.** Every path out of a failed or lost claim leaves the container running and untracked, never adopted.
2. **Adoption precedes every wake source.** P3.
3. **An untracked survivor cannot be spawned into.** P2 plus P4.
4. **A stop is not a terminal.** `docker wait` fires on the container's exit whatever caused it, and the fork has no stop-intent suppression to build because `finalizeSession`'s identity fence already makes a second finalize a no-op.
5. **A daemon restart is not a fleet-wide terminal.** The waiter-close truth re-read (§4.3.3).

**Acceptance tests.**

`src/container-adoption.test.ts` (fake runtime listing, fake waiter processes):

- _"a running container for an active session is adopted and registered"_ — assert `isContainerRunning(id)` true afterwards, `markContainerRunning` called, `adopted: 1`.
- _"a container whose session is archived is stopped, not adopted"_ — assert `stopContainer` called and the registry untouched.
- _"a container with no session label is stopped"_.
- _"a lost claim leaves the container running and unadopted"_ — pre-write a claim at incarnation 5 held by a live host instance; assert no `stopContainer`, no registry entry, and the WARN.
- _"a failed claim write records a pending adoption and stops nothing"_ — make `tryClaimSession` reject; assert `pendingAdoptions` holds the id, `pendingClaim: 1`, no `stopContainer`.
- _"a wake for a pending adoption retries the adoption instead of spawning"_ — assert `spawn` never called and the container is adopted on the retry.
- _"a pending adoption whose container has vanished falls through to a fresh spawn"_ — the re-list shows nothing; assert `spawn` called once.
- _"a pending adoption whose claim is lost to a live host throws rather than spawning"_.
- _"adoption counts a session whose inbound DB is fenced"_ — assert `fencedInbound: 1` and that the fence was not released here.
- _"a runtime listing failure adopts nothing and does not throw"_ — assert all-zero and one WARN.
- _"an adopted session's ceiling uses the adoption instant"_ — assert `getContainerSpawnedAt(id)` is the adoption time, not 0 (divergence 11's other half).

`src/adoption-order.test.ts` (P3 — the invariant, in a primitive):

- _"adoptRunningSessions resolves before any wake source starts"_ — call-order log across `adoptRunningSessions`, `startDashboard`, `startChannelAdapters`, `startHostSweep`, `startDeliveryPolls`; assert adoption is first.
- _"adoption runs after the boot quiescence door and before the orphaned-fence recovery"_ — the §4.3.6 ordering, as an assertion rather than a comment.
- _"nothing in main() calls wakeContainer before adoption resolves"_ — AST over `main()`, the same shape as §7.D's door test.

`src/container-supervision-channel.test.ts`:

- _"an adopted entry's SIGKILL fallback targets the container, not the waiter"_ — make `stopContainer` throw; assert `docker kill <name>` was issued and the waiter was not killed first. This is the case a naive union gets wrong.
- _"a spawned entry's fallback is unchanged"_ — assert `process.kill('SIGKILL')`, exactly as today.
- _"a waiter close finalizes the session"_ — emit `close`; assert `markContainerStopped`, registry entry gone, claim released at its own incarnation.
- _"a waiter close while the container is still running re-arms instead of finalizing"_ — the daemon-restart case; assert the WARN, no `markContainerStopped`, and a second waiter armed.
- _"a truth read that fails treats the container as running"_ — fail-closed.
- _"finalize is a no-op for a channel that is no longer registered"_ — register channel A, replace with B, close A; assert B intact and no `markContainerStopped` (the fork's stale-finish fence, preserved through the union).
- _"an adopted entry releases no storage-activity lease"_ — assert `storageActivity.release` was never called for a lease this host does not hold.

Extend `src/session-claim-spawn.test.ts` (A′) with P2:

- _"a spawn is refused while an untracked container is still running for the session"_ — claim row carries a `container_ref` the runtime shows running; assert `spawn` never called and the WARN.
- _"a claim with a null container_ref never queries the runtime"_ — assert zero runtime calls, the steady-state cost proof.
- _"a runtime listing failure refuses the spawn"_ — fail-closed.
- _"the adopter bypasses P2"_ — `{ adopting: true }`; assert the claim is taken.

Live verification, on the deploy that carries restart 4 (§4.3.5's two runtime-version questions):

```
docker inspect --format '{{.HostConfig.AutoRemove}}' <a live container>   # expect true
docker wait <a name that no longer exists>; echo $?                        # expect a prompt non-zero, not a hang
```

**Rollback.** Two-part and ordered — the unit half first, then the merge (§5). `session_claims` rows left behind are ignored by the reverted build.

### 7.F — `on_wake`, stop intent, and the adoption-aware ceiling

**What revision 1 got wrong.** §2 called F a runner-side change and named three note families that "become inert unless the host converts them". Divergence 10 shows that is true of exactly one. `host-restart-*` (`src/host-restart-warn.ts:286`) and `ceiling-respawn-*` (`src/host-sweep.ts:844`) are written by `insertDeferredMessageWithContextIfNew` as `trigger = 0` plus an inert `recall-<id>` partner, and the sweep's due admission already clears `on_wake` on both halves when it makes them wakeable (`src/modules/mailbox/ops/admission.ts:129-150`, and the contract is stated at `src/session-manager.ts:1510-1512`). Only `groups restart --message` writes a bare `trigger = 1, on_wake = 1` row (`src/container-restart.ts:526-544`; `trigger` defaults to 1 at `ops/ingress.ts:49`). So F is host-side, the runner does not change, and the residual risk is the opposite of the one revision 1 planned for: not an undelivered note, but a **stale** one delivered to a container that was never stopped.

**Files.** `src/modules/mailbox/ops/admission.ts`; `src/modules/mailbox/index.ts`; `src/container-runner.ts`; `src/container-restart.ts`; `src/modules/sweep-container-health/index.ts`; `src/on-wake-survivor.test.ts` (new); `src/stop-intent-recovery.test.ts` (new); `src/modules/sweep-container-health/*.test.ts` (existing cases stay green); `src/upstream-ratchet.json`.

#### F1 — reconcile a survivor's unconsumed `on_wake` rows

New op in `src/modules/mailbox/ops/admission.ts`, beside `admitDueRow` (`:129`):

```ts
export function reconcileSurvivorWakeRows(
  db: Database.Database,
  claimed: (messageId: string) => boolean,
): { converted: number; withdrawn: number };
```

Exposed on `NanoclawMailboxSession` (`src/modules/mailbox/index.ts:353`, beside `withdrawUnconsumedWake`) as `reconcileSurvivorWakeRows(): { converted: number; withdrawn: number }`, with the `claimed` probe wired the way `withdrawUnconsumedWake`'s is at `:1013-1031` — **minus its ownership half**. That subtraction is the load-bearing part and needs its reason on the line: `containerOwnsOutbound` short-circuits to "a claim is possible" for any running container (`:1018`), which is true of every adopted session, so reusing it would refuse every reconciliation. The honest probe is the ack half alone (`hasProcessingAck`), because a container past its first poll provably cannot select an `on_wake = 1` row — `selection.ts:188` adds `AND on_wake = 0` to all three of its queries from poll 2 onward. The residual case is a survivor still on its **first** poll when the host adopts it, and that is exactly what the ack read catches. Unprovable stays fail-closed: an unopenable `outbound.db` answers "claimed" and the row is left alone.

Per row, the rule is the note's own `_system.kind`:

- `agent_host_restart` → **withdraw** the pair. Its text says the host "stopped your container mid-work" and that any in-flight turn was lost (`src/host-restart-warn.ts:295-297`); delivering that to a container that is still running its turn would make the agent discard live work. G stops the note being written for adopted sessions going forward; this handles the one the previous host wrote on its way down.
- everything else → **convert**: re-seq the pair with `nextEvenSeq` (recall at `n`, trigger at `n + 2`, preserving the `recall.seq = task.seq - 2` pairing the admission checker relies on at `ops/admission.ts:160-166`) and set `on_wake = 0` on both halves. Re-seqing is not cosmetic: the selection queries are `ORDER BY seq DESC LIMIT n` (`selection.ts:193-197`), so a row left at its old seq can fall outside the survivor's window and never surface.

Called from `adoptRunningSessions`, per adopted session, through `withExistingMailboxSession` — existing-only, because provisioning a mailbox here would author an `outbound.db` the host must never create (invariant I-10), and a session with no mailbox is not adoptable in the first place.

#### F2 — the durable stop intent

`killContainer(sessionId, reason, onExit)` writes `setStopIntent(sessionId, onExit ? 'respawn_after_stop' : 'stop', now)` before issuing the stop, as a `shadowWrite` (A's accessors, `src/db/coordination.ts`). `honorPendingStopIntents()` — upstream's shape (`upstream/main:src/container-runner.ts:700-745`) — runs in `main()` immediately after `adoptRunningSessions()`. A session whose container is still up gets its kill re-issued with the respawn re-armed; one without a container gets the respawn directly; the intent clears only once the respawn wake succeeds, so a failed wake retries at the next startup while the sweep retries it sooner. A session sitting in `pendingAdoptions` is skipped with a WARN — its container is alive but not yet fenced, and acting on the intent could kill the wrong incarnation.

This is what makes the one genuinely first-poll row shape safe. `restartAgentGroupContainers` writes the wake row, then kills (`src/container-restart.ts:526-566`); a host that dies in that window leaves a row nothing will ever consume, because the container it was written for is still running and past its first poll. The stop intent re-issues the kill, the fresh container's first poll consumes the row, and the note lands where it was always meant to.

#### F3 — the adoption-aware ceiling

`decideStuckAction` (`src/modules/sweep-container-health/index.ts:440-500`) gains `adopted?: boolean`, and its prior-container test becomes `heartbeatFromPriorContainer = !adopted && spawnedAtMs > 0 && heartbeatMtimeMs < spawnedAtMs` (divergence 11). The caller at `:609` passes `isAdoptedContainer(session.id)`, a new one-line accessor beside `getContainerSpawnedAt` (`src/container-runner.ts:224-226`). The claim-grace branch at `:488` is deliberately **not** changed: a survivor's `processing_ack` rows are its own and still in flight, and the grace being briefly generous there is correct rather than a bug.

**Acceptance tests.**

`src/on-wake-survivor.test.ts`:

- _"an unconsumed restart-message row is converted and re-seqed to the front"_ — assert `on_wake = 0` on both halves, `trigger = 1`, and `recall.seq === trigger.seq - 2`.
- _"a host-restart accountability note is withdrawn, not converted"_ — assert both rows gone and nothing converted.
- _"a row with a processing_ack in any status is left untouched"_ — the ack half; assert neither converted nor withdrawn.
- _"an unopenable outbound.db leaves every row untouched"_ — fail-closed.
- _"a deferred pair the sweep already admitted is not touched twice"_ — `on_wake` already 0; assert zero changes.
- _"the reconciliation never runs against a session with no mailbox"_ — assert `withExistingMailboxSession` semantics, no `outbound.db` created (I-10).
- _"a converted row is selectable by a container past its first poll"_ — drive `getPendingMessages(false)` against the reconciled DB and assert the row comes back. This is the case the whole series exists for.

`src/stop-intent-recovery.test.ts`:

- _"killContainer records a respawn intent when an onExit is supplied, and a plain stop otherwise"_.
- _"a host that died between the wake write and the kill re-issues the kill at the next boot"_ — assert `Re-issuing interrupted restart` and that the fresh container's first poll consumes the wake row.
- _"the intent clears only after the respawn wake succeeds"_ — fail the wake; assert the row survives for the next pass.
- _"a session awaiting claim-fenced adoption defers its intent"_ — assert the WARN and that no kill was issued.
- _"an archived session's intent is cleared without a respawn"_.

In `src/modules/sweep-container-health/`:

- _"an adopted container past the ceiling is killed, not granted spawn grace"_ — the divergence-11 regression guard.
- _"a freshly spawned container still gets spawn grace"_ — the existing case, unmodified, proving F3 narrowed nothing else.

**Rollback.** Revert. Converted rows stay converted, which is harmless — they are ordinary pending rows. Withdrawn rows are gone; the cost is one missing accountability note for a session that was not interrupted, which is the note's correct absence anyway. `stop_intent` values left in `session_claims` are ignored by a build without F2.

### 7.G — narrow `host-restart-warn`, both sides

**Files.** `src/host-restart-warn.ts`; `src/main.ts`; `src/host-restart-warn.test.ts` (existing cases stay green); `src/upstream-ratchet.json`.

**Insertion points.**

`src/host-restart-warn.ts:326-334`, `warnActiveContainersOfShutdown(reason)` gains a required `stoppingSessionIds: ReadonlySet<string>` and iterates that instead of `getActiveContainerSessionIds()`. Required rather than optional: an omitted argument would silently restore today's fleet-wide behavior, and the whole point of the change is that "every tracked container" and "every container being stopped" have stopped being the same set. The call at `src/main.ts:648` passes the set `beginContainerShutdown()` will actually stop — spawning entries only, in the steady state.

`src/host-restart-warn.ts:340-348`, `warnMarkedRunningSessionsOfStartup(reason)` gains `adoptedSessionIds: ReadonlySet<string>` and skips them. Its call moves from `src/main.ts:304` to after `adoptRunningSessions()`, which is what makes the set knowable. That move is also a correctness fix independent of the note text: today the warn runs against `getRunningSessions()` before anything has proved which of those sessions still have containers.

`src/host-restart-warn.ts:1-35`, the module header. Its second paragraph ("Every host start stops all install-labeled containers — graceful shutdown via `stopAllContainers`, startup via `cleanupOrphansStrict`") describes precisely the world seam 4 removes, and it is the paragraph a future reader would reason from. Rewritten to state the new rule: a note is for a session whose container this host is stopping or has found dead, never for one it adopted. The "Known residual" paragraph gains the survivor case — a session adopted while genuinely mid-turn gets no note, which is correct, because nothing interrupted it.

**Ordering and safety.** The spam guard (`:20-28`) is untouched: G changes _which sessions are considered_, never _what counts as work in flight_. That separation is what keeps G reviewable independently of E, and both new parameters are sets computed by the caller, so `host-restart-warn.ts` gains no dependency on the container registry it does not already have (`:38`).

**Acceptance tests** — in `src/host-restart-warn.test.ts`:

- _"an adopted session gets no startup note"_ — the milestone-1 case.
- _"a session marked running whose container did not survive still gets one"_ — proving G narrowed and did not disable.
- _"the shutdown warn covers only the sessions being stopped"_ — two tracked sessions, one in the stopping set; assert exactly one note.
- _"an empty stopping set writes no notes"_ — the steady-state restart.
- _"the work-in-flight signals are unchanged"_ — the existing spam-guard cases pass unmodified, including the heartbeat-plus-`provider_executing` pair and the deliberate exclusion of narration.
- _"the dedupe id still collapses the shutdown and startup notes for one interruption"_ — the `:277-283` minute-bucket contract, which G must not break by moving the startup call later.

**Rollback.** Revert; both call sites return to their fleet-wide form. No durable state.

## 8. Executable acceptance criteria

The named cases and their assertions are stated inline in §7.A–§7.G. They are the executable criteria and are materialized by `/team-build` before implementing, per PR. This section adds nothing of its own; it exists so a reader looking for "where are the tests" is sent to the series that owns each one.

## 9. Open decisions

Two of revision 1's four are now closed and are recorded here with where the answer lives.

- **CLOSED — E shape.** Option 2: minimal adoption re-derived over the fork's `activeContainers` entry, with one `docker wait` child per adopted container as the terminal channel, and no `session-events` hub. Rationale, costing and the from-scratch test: §4.3. The fork's 4,921-line `container-runner.ts` is mostly fork-owned spawn policy, and porting the driver seam would move the guard-to-`spawn()` adjacency that seam 3 §4.5 I-1 pins behind two async driver calls.
- **CLOSED — graceful shutdown and `TimeoutStopSec`.** Three doors, not one, and the decisive two are unit-file lines rather than code (divergence 9): `stopAllContainers()` leaves the shutdown path, `ExecStop=` is removed from both `nanoclaw-v2.service` files, and `KillMode=mixed` stops systemd SIGTERMing the attached `docker run` clients, which proxy the signal into their containers. `TimeoutStopSec` becomes 30, down from 60, because nothing on the stop path waits on a container any more. §4.3.5.
- **CLOSED — D2 depends on E, F and G.** Revision 1 recommended D2 as a flip inside E's restart window; that stands, and §7's batching now states why the four cannot be split: each is unsafe alone, and together they are four merges and one restart.
- **OPEN — operator decision, the restart budget.** This batch needs **four** restarts on a production-critical install, up from revision 1's three, and none of the four can be merged into another: C before D1 (divergence 7), A′ alone so a spawn regression is not confounded, and E/F/G/D2 together on the last. Restart 4 should also follow restart 3 by about a working day, so the `survivable` population D1 measures is non-trivial. Everything else here is an engineering call under the standing delegation.
- **OPEN — operator decision, the deployed unit file.** `data/systemd/nanoclaw-v2.service` is install data, not trunk, and restart 4 changes three of its lines. That puts part of milestone 1 outside the build's rollback (§5 states the two-part revert order). The operator's call is whether that unit edit rides the same window as the merge or is staged and verified separately first.
- **OPEN — verification the plan cannot do read-only.** Two runtime-version facts gate E's residue handling: whether `--rm` cleanup is daemon-side and survives its client being killed, and whether `docker wait` on an already-removed container exits promptly. Both are one command each and are listed in §7.E; if `--rm` turns out to be client-side, E gains a boot-time reap of exited install-labeled containers, the fork's equivalent of upstream's `reapResidue`.

## 10. Verification commands

```
# per PR, in the worktree $W, one file at a time
ionice -c3 nice -n 10 node_modules/.bin/vitest run <file> --maxWorkers=1
ionice -c3 nice -n 10 node_modules/.bin/eslint src/ --quiet
node_modules/.bin/tsx scripts/check-public-boundary.ts -- --root "$W" --index
pnpm run ratchet:report -- --write            # growth needs --accept + a reason in the PR body
# post-restart gate: existing counters + the §6 table for the series in the batch
```
