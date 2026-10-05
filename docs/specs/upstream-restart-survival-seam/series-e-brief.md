# Series E (adoption) — implementation brief, CODE half

Plan: `docs/specs/upstream-restart-survival-seam/plan.md` §4.3, §4.3.3–4.3.6, §7.E (+ §7.A′, §7.D1, §7.F, §7.G, §7.D2 ship-with).
Tree read 2026-09-05 at `origin/main` = HEAD = `e59df3284` (plan was read at `08aad9f93`; A/B/C are merged, A′ is PR #438 on
`origin/seam4/aprime-claim-first-spawn` head `559a381f8`, **D1 does not exist yet** — no `seam4/d*` branch, no
`listInstallContainersWithScope`, no `quiesceWorkgroupsForBootMountChange` anywhere in `src/`).

## 1. Current-tree anchors (main = e59df3284; A′ column = #438 head; plan column = stale)

| Insertion point                                               | plan                          | main today                                                                                                                                                                                                                                                                                                                                                                                                                                               | A′ branch                                                  | quoted anchor                                                                                                                                                                      |
| ------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| registry value type                                           | `:185-193`                    | `src/container-runner.ts:190-198`                                                                                                                                                                                                                                                                                                                                                                                                                        | `:200-209` (gains `claimIncarnation?: number`)             | `const activeContainers = new Map<string, { process: ChildProcess; containerName: string; spawnedAt: number; storageActivity: StorageActivityLease; }>()`                          |
| `getContainerSpawnedAt`                                       | `:224-226`                    | `:231-233`                                                                                                                                                                                                                                                                                                                                                                                                                                               | ~`:241`                                                    | `return activeContainers.get(sessionId)?.spawnedAt ?? 0;`                                                                                                                          |
| `isContainerRunning` / `getActiveContainerSessionIds`         | `:430-431`, `:457`            | `:450-452`, `:477-478`                                                                                                                                                                                                                                                                                                                                                                                                                                   | ~`:605`, ~`:632`                                           | `return activeContainers.has(sessionId);`                                                                                                                                          |
| `isContainerSpawning` / `spawningSessions`                    | —                             | `:454-456`, `:244`                                                                                                                                                                                                                                                                                                                                                                                                                                       | —                                                          | `return spawningSessions.has(sessionId) \|\| wakePromises.has(sessionId);`                                                                                                         |
| `wakeContainer` + fast path                                   | `:599-611`, `:608`            | `:619-631` (shutdown check `:624`, fast path `:628`)                                                                                                                                                                                                                                                                                                                                                                                                     | `:774`, fast path ~`:783`                                  | `if (activeContainers.has(session.id)) { log.debug('Container already running', …); return Promise.resolve(true); }`                                                               |
| `startReservedWake` fast path (second fast path, not in plan) | —                             | `:746`                                                                                                                                                                                                                                                                                                                                                                                                                                                   | ~`:901`                                                    | `if (activeContainers.has(session.id)) return Promise.resolve(true);`                                                                                                              |
| `claimSessionRun` / `releaseClaimQuietly`                     | §7.A′ pt 3                    | absent                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `:307-338`, `:340-353`                                     | `async function claimSessionRun(sessionId: string, containerRef: string): Promise<number \| null>`                                                                                 |
| spawn tail: claim → guard → `spawn(` → `activeContainers.set` | `:1282-1320`                  | `:1302-1341`                                                                                                                                                                                                                                                                                                                                                                                                                                             | `:1457-1526` (`spawn(` `:1516`, `set` `:1518`)             | `const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });`                                                                                     |
| `finalizeContainer` closure (to lift)                         | `:1346-1368`                  | `:1362-1387`, identity fence `:1370`                                                                                                                                                                                                                                                                                                                                                                                                                     | `:1546-1584` (`Ignoring stale session finish` `:1579`)     | `if (active?.process === container) { activeContainers.delete(session.id); … releaseMemoryReservation(session.id); void markContainerStopped(session.id) …`                        |
| `close`/`error` handlers                                      | `:1422/:1454`                 | `:1391-1411`                                                                                                                                                                                                                                                                                                                                                                                                                                             | ~`:1588-1608`                                              | `container.on('close', (code) => { finalizeContainer(); if (code === 137) …`                                                                                                       |
| `stopRunningContainer` channel lines                          | `:1419-1430`                  | `:1458-1476`; `once('close')` `:1462`; fallback `:1473`                                                                                                                                                                                                                                                                                                                                                                                                  | `:1652-1670`                                               | `entry.process.once('close', () => { void Promise.resolve().then(callback)…` / `} catch { entry.process.kill('SIGKILL'); }`                                                        |
| `killContainer`                                               | `:1444-1454`                  | `:1489-1499`                                                                                                                                                                                                                                                                                                                                                                                                                                             | `:1683`                                                    | `if (!activeContainers.has(sessionId)) { if (!isContainerSpawning(sessionId)) return; … pendingKills`                                                                              |
| `settlePendingKill`                                           | `:1479-1512`                  | `:1524-1562`                                                                                                                                                                                                                                                                                                                                                                                                                                             | ~`:1718`                                                   | unchanged by E                                                                                                                                                                     |
| `stopAllContainers` + early-out                               | `:1527-1571`, `:1533`         | `:1576-1620`; early-out `:1584`; SIGKILL sweep `:1609-1618`                                                                                                                                                                                                                                                                                                                                                                                              | `:1770`, `:1778`                                           | `if (entry.process.exitCode !== null) { resolve(); return; }`                                                                                                                      |
| `containerShutdownInProgress` readers                         | `:1293`                       | decl `:375`; `:417`, `:433` (memory release/cancel), `:624`, `:837`, `:1314`                                                                                                                                                                                                                                                                                                                                                                             | —                                                          | `let containerShutdownInProgress = false;`                                                                                                                                         |
| concurrency count                                             | —                             | `:886-891`                                                                                                                                                                                                                                                                                                                                                                                                                                               | —                                                          | `const inFlightWakes = [...spawningSessions].filter((sessionId) => !activeContainers.has(sessionId)).length;` (adopted entries count against `MAX_CONCURRENT_CONTAINERS` for free) |
| `containerLabelArgs` (C)                                      | —                             | `:4904-4917`                                                                                                                                                                                                                                                                                                                                                                                                                                             | —                                                          | emits `nanoclaw-install`, `-group`, `-session`, `-workgroup`, `-role=agent`; keys in `src/config.ts:152-160` (`CONTAINER_NAME_PREFIX` `:152`)                                      |
| runtime helpers                                               | `container-runtime.ts:92-105` | `src/container-runtime.ts:29-34` `stopContainer` (name regex + `execSync(\`docker stop -t 1 ${name}\`)`); `:92-105` `listInstallContainersStrict`(**module-private**,`execSync`string form);`:114-134` `cleanupOrphansStrict`                                                                                                                                                                                                                            | —                                                          | `throw new Error('Cannot prove install-scoped container absence: runtime listing failed', { cause: err });`                                                                        |
| main.ts boot: migrations → lease → … → fence recovery         | `:283-317`, `:356`            | `runMigrations` `:253`; lease `:262`; `reconcileWorkgroupSharedDirs` `:313`; `warnMarkedRunningSessionsOfStartup` `:328`; `runWorkgroupMemoryStartupGate` `:332` (body `:162-174`, `cleanupOrphansStrict` at `:171`); `pruneAgentRunnerSnapshots` `:341` (stale comment `:334-340`); pending-upgrade reconcile `:350-372`; `releaseOrphanedRepoIngressFencesAtStartup` `:380`; `startDashboard` `:416`; `startHostSweep` `:617`; `startCliServer` `:634` | A′ only moves `HOST_LEASE_TTL_MS` into `config.ts` (+9/-9) | `pruneAgentRunnerSnapshots();`                                                                                                                                                     |
| `shutdown()`                                                  | `:656`                        | `:644-697`; `warnActiveContainersOfShutdown` `:672`; `await stopAllContainers()` `:680`; `stopHostInstanceLease` in `finally` `:689`                                                                                                                                                                                                                                                                                                                     | —                                                          | `// Synchronously stop agent containers before exit. Without this, child subprocesses linger…`                                                                                     |
| unit files                                                    | `:17`                         | `scripts/nanoclaw-v2.service:17-18` and `data/systemd/nanoclaw-v2.service:17-18` (`ExecStop=…docker stop -t 10`, `TimeoutStopSec=60`); no `KillMode` in either; live `/etc/systemd/system/nanoclaw-v2.service` matches `data/systemd/` plus drop-ins (CPUWeight, concurrency, node22 env, tz)                                                                                                                                                            | —                                                          | see §7 risk 3                                                                                                                                                                      |
| `decideStuckAction` (F3)                                      | `:440-500`                    | `src/modules/sweep-container-health/index.ts:440`, predicate `:477-479`, caller `:609`                                                                                                                                                                                                                                                                                                                                                                   | —                                                          | `const heartbeatFromPriorContainer = spawnedAtMs > 0 && heartbeatMtimeMs < spawnedAtMs;`                                                                                           |
| host-restart-warn (G)                                         | `:326-348`                    | `src/host-restart-warn.ts:329-330` (`warnActiveContainersOfShutdown` iterates `getActiveContainerSessionIds()`), `:344-345` (`warnMarkedRunningSessionsOfStartup` iterates `getRunningSessions()`), header `:1-35`                                                                                                                                                                                                                                       | —                                                          | —                                                                                                                                                                                  |
| `withExistingMailboxSession` (F1, fencedInbound)              | —                             | `src/session-manager.ts:546-552`; `mailbox.readRepoIngressFence()` `src/modules/mailbox/index.ts:516,1094`; fence shape `src/repo-fence-recovery.ts:148-149` (`fence?.state !== 'active'`)                                                                                                                                                                                                                                                               | —                                                          | `return runMailboxSession(agentGroupId, sessionId, action, false);`                                                                                                                |

Other registry consumers that must keep working under the union (all read via accessors, none touch `.process`): `container-restart.ts:143,283,382,428,593,630`
(`getContainerSpawnedAt` is used as a spawn-generation token at `:593/:630` — `Date.now()` at adoption satisfies it), `host-sweep.ts:145,996,1401`,
`sweep-continuation/index.ts:600,628`, `worktree-cleanup.ts:344`, `repository-workspaces/index.ts:817-821`, `sweep-orchestrator/task-watchdog.ts:61`.

## 2. Dependencies on D1, and what E can build first

**Cannot build without D1:** (a) `listInstallContainersWithScope(): InstallContainerScope[]` (`{ name, workgroupId, sessionId, groupId }`, one
`docker ps --filter label=<install> --format` call, fail-closed like `listInstallContainersStrict`) — `adoptRunningSessions` step 1 and the P4 re-list;
(b) the boot door `quiesceWorkgroupsForBootMountChange` replacing `runWorkgroupMemoryStartupGate`'s `cleanupOrphansStrict` at `main.ts:171/:332` — E's call site
sits immediately after it. Until D1 is in tree the fleet-wide stop runs first, so a boot-time `adoptRunningSessions()` finds nothing (harmless, pointless).

**Buildable now, on a branch cut from `origin/seam4/aprime-claim-first-spawn`** (E extends `claimSessionRun`, which only exists there; rebase onto main
when #438 merges, then onto D1): everything in checkpoints 1–4 below. `adoptRunningSessions` takes its listing through an injectable `deps.list`
whose type is D1's `InstallContainerScope[]` signature verbatim (declare the interface locally in E if D1 has not landed; delete the local copy at rebase).
Do **not** gate E behind an env flag — the boot-order position is the gate: with D1's stop still fleet-wide E is inert; the unit-file lines and D2 are
what make it live. The `main.ts` call site + `beginContainerShutdown` swap (checkpoint 5) and the unit files (checkpoint 6) wait for D1 to merge.

Also from D1: the `nanoclaw-role=agent` label is live on every container today (verified via `docker inspect` 2026-09-05) — D1's listing should filter
`--filter label=nanoclaw-role=agent` as upstream's `listSessions` does (`upstream/main:src/drivers/docker-driver.ts:177-195`), or E will try to adopt any
non-agent container carrying the install label.

## 3. Runtime helpers — exact docker calls

Fork convention: `src/container-runtime.ts` uses `execSync` string commands with a name regex (`:30`); `src/agent-runner-source.ts:111,120` uses
`execFileSync('docker', [...])` argv arrays. Use argv form for the new helpers (no shell, no injection surface) and reuse the `:30` regex as a shared
`assertContainerName(name)`. Upstream for reference: status via `docker inspect --format '{{.State.Status}}|{{.State.ExitCode}}'` (`docker-driver.ts:484-517`),
stop via `docker stop -t <grace>` then `rm --force` (`:524-540`), listing via `docker ps -a … --format '{{.Names}}|{{.State}}|{{.Label …}}'`.

```ts
// src/container-runtime.ts — new exports
export function waitForContainerExit(name: string): ChildProcess {
  // the adopted supervision channel
  assertContainerName(name);
  return spawn(CONTAINER_RUNTIME_BIN, ['wait', name], { stdio: ['ignore', 'pipe', 'pipe'] });
  // exit 0 + stdout "<code>\n" == container exited; exit 1 + stderr "No such container" == already gone (terminal, do not re-arm);
  // exit 1 + "Cannot connect to the Docker daemon" == daemon down (NOT terminal — truth re-read decides, with backoff)
}
export function runtimeShowsRunning(name: string): boolean {
  // throws on a listing failure — caller decides the closed side
  assertContainerName(name);
  const out = execFileSync(
    CONTAINER_RUNTIME_BIN,
    ['ps', '--filter', `label=${CONTAINER_INSTALL_LABEL}`, '--filter', `name=^/${name}$`, '--format', '{{.Names}}'],
    { encoding: 'utf-8' },
  );
  return out.trim().split('\n').filter(Boolean).includes(name);
}
```

Why `ps`, not `inspect`, for `runtimeShowsRunning`: `docker inspect` on a container that has exited and been auto-removed **throws** exactly like a
dead daemon does. After a crash every session whose container exited during the outage has `container_ref` still set (`releaseSessionClaim` nulls it only
on a clean exit, `src/db/coordination.ts:189`), so an inspect-based, throw-means-running P2 would wedge all of them. With `ps`, empty output = absent
(spawn allowed), throw = daemon unreachable (P2 refuses; waiter re-arms). Same helper serves both callers with opposite closed sides.

Live facts (re-verified today, Docker 29.3.1, read-only): a live `nanoclaw-v2-*` container has `HostConfig.AutoRemove=true` (daemon-side `--rm`, so no
`reapResidue` equivalent needed) and carries all five labels. `docker wait <gone-name>` exits promptly (plan §4.3.5, verified 03:35Z). Daemon-down
`docker wait` also exits immediately → the re-arm needs a backoff (`setTimeout(5_000).unref()`), else it spins.

## 4. Test-harness shape (what exists, what a fake waiter needs)

`src/session-claim-spawn.test.ts` (A′ branch, 798 L): real migrated SQLite under `uniqueTmpRoot` + `initDb(dbPath, { role: 'test' })`; real
`coordination.ts` wrapped by `vi.mock` to record call order and inject `staleRead`/`claimWriteFails` (`hooks`, `:66-121`); `container-runtime.js` mocked with
`importOriginal` spread and `CONTAINER_RUNTIME_BIN` pointed at an absent binary so `spawn()` returns a real `ChildProcess` that ENOENTs into the real
`close`/`error` finalization; `agent-runner-image-check`, `onecli-apply`, `onecli-secrets`, `storage-maintenance-worker`, `memory-admission` stubbed;
`fs.rmSync` wrapped to log the heartbeat clear; `allowSubprocess([ABSENT_BIN])` for the hermeticity guard (`src/test-hermeticity.ts:113,275`); helpers
`seedSession`, `seedForeignClaim`, `seedHostInstance(id, 'live'|'expired'|'stopped')`, `waitForFinalize`, `untilEvent`; one AST case via `typescript`.
`src/container-runner.test.ts` is the lighter sibling (same `container-runtime` mock, memory stub `:74-`), no DB. `src/container-runtime.test.ts:21-23`
mocks `child_process.execSync` as `mockExecSync` — extend that mock with `execFileSync`/`spawn` for the two new helpers' unit cases.

Fake waiter: extend the existing `vi.mock('./container-runtime.js', …)` factory with `waitForContainerExit: (name) => fakes.arm(name)`,
`runtimeShowsRunning: (name) => { if (fakes.listingFails) throw …; return fakes.running.has(name); }`, `stopContainer: vi.fn(...)`,
`listInstallContainersWithScope: () => fakes.listing` (D1's export; until it exists, inject via `adoptRunningSessions({ list })`). `fakes.arm` returns an
`EventEmitter` cast to `ChildProcess` with `exitCode: null`, `killed: false`, `pid`, `stdout: null`, `stderr: null`, and `kill: vi.fn(() => { exitCode = null; emit('close', null) })`;
`fakes.exit(name, code)` sets `exitCode` and emits `close`. Every case that asserts "waiter not killed first" reads `kill.mock.calls` against the
`stopContainer` mock's call order. No real `docker wait` is ever spawned, so no `allowSubprocess` entry is needed for it.

`adoption-order.test.ts`: `main.ts` imports ~150 modules; a runtime call-order log needs a mock wall that does not exist. Use the AST shape
`session-claim-spawn.test.ts` already has (parse `src/main.ts`, walk `main()`'s statements, assert index order
`quiesceWorkgroupsForBootMountChange` < `adoptRunningSessions` < `releaseOrphanedRepoIngressFencesAtStartup` < `startDashboard` < `startHostSweep` < `startDeliveryPolls`
and "no `wakeContainer` identifier before the adoption await"). D1's `boot-quiescence-order.test.ts` has the same problem — share one `main-boot-order`
helper with whichever lands first.

## 5. P2 in `claimSessionRun` — diff sketch against the A′ branch (`src/container-runner.ts:307-338`)

```diff
-async function claimSessionRun(sessionId: string, containerRef: string): Promise<number | null> {
+async function claimSessionRun(
+  sessionId: string,
+  containerRef: string,
+  opts: { adopting?: boolean } = {},
+): Promise<number | null> {
   const self = await resolveClaimantId();
   …(P0 no-id refusal, self-lease check, unchanged)…
   const current = await getSessionClaim(sessionId);
   if (current?.claimed_by && current.claimed_by !== self) {
     …(P1 live-peer refusal, unchanged)…
   }
+  // P2 — the divergence-3 fence: an UNTRACKED container is still running for
+  // this session (a survivor this host has not adopted). Fence on the
+  // container, not the incarnation. Steady state never pays: a clean exit
+  // nulls container_ref, and a tracked session short-circuits on the registry.
+  // The adopter holds the survivor by definition and skips it.
+  if (!opts.adopting && current?.container_ref && !activeContainers.has(sessionId)) {
+    let running: boolean;
+    try {
+      running = runtimeShowsRunning(current.container_ref);
+    } catch (err) {
+      log.warn('Refusing session claim — cannot prove the previous container is gone', { sessionId, containerRef: current.container_ref, err });
+      return null; // fails CLOSED: "cannot prove absence" never reads as "absent"
+    }
+    if (running) {
+      log.warn('Refusing session claim — a container is still running for this session', { sessionId, containerRef: current.container_ref });
+      return null;
+    }
+  }
   return tryClaimSession({ sessionId, instanceId: self, expectedIncarnation: current?.incarnation ?? 0, containerRef, now: … });
 }
```

`runtimeShowsRunning` is synchronous (`execFileSync`), so the claim stays the last `await` and the A′ AST case ("nothing is awaited between the guard
and spawn") is untouched. The `:1457-1476` spawn-tail call site does not change. `session-claim-callers.test.ts:52-54` (`TRY_CLAIM_SESSION_CALLERS`)
stays at one entry for P2; it grows to two (`adoptRunningSessions` is a `claimSessionRun` caller, not a `tryClaimSession` caller — check the matcher: it
scans for the `tryClaimSession` identifier, so the list may not need to grow at all; if it does not, add the E case the plan asks for as a
`claimSessionRun` caller list instead, so "adopt" is still a visible diff).

## 6. Task list with checkpoints (commit + push at every green gate — `feedback_workers_checkpoint_commit_and_push_per_gate`)

**CP0** Branch `seam4/e-adoption` from `origin/seam4/aprime-claim-first-spawn` in a scratch worktree (never the live checkout). Gate: `tsc --noEmit`, A′ suites green.

**CP1 — runtime helpers** (`src/container-runtime.ts`): `assertContainerName` (extracted from `stopContainer:30`), `waitForContainerExit`, `runtimeShowsRunning`;
`src/container-runtime.test.ts` cases: "runtimeShowsRunning is true only for an exact-name match", "a listing failure throws (not false)",
"waitForContainerExit spawns `docker wait <name>` with argv, no shell", "an invalid name is refused before any subprocess". Gate: that file + eslint.

**CP2 — supervision union, behavior-identical**: `SupervisionChannel` (§4.3.3); registry entry `{ channel, containerName, spawnedAt, adopted: boolean,
storageActivity: StorageActivityLease | null, claimIncarnation? }`; helpers `channelOnClose`, `channelHasExited`, `channelKillFallback(entry)` (spawned →
`process.kill('SIGKILL')`; adopted → `docker kill <containerName>` via a new `killContainerHard(name)` in container-runtime, then `waiter.kill()`);
lift `finalizeContainer` → module-level `finalizeSession(sessionId, channel, storageActivity | null)` with fence
`activeContainers.get(sessionId)?.channel === channel` and the A′ `releaseClaimQuietly` tail; null-guard `storageActivity.release()` (`releaseMemoryReservation`
on an id with no reservation is a harmless `delete` + drain, `src/memory-admission.ts:96-99`); `stopRunningContainer:1652-1670` and
`stopAllContainers:1770-1815` go through the helpers; `isAdoptedContainer(sessionId)` accessor beside `getContainerSpawnedAt`. Tests
(`src/container-supervision-channel.test.ts`): _"a spawned entry's fallback is unchanged"_, _"finalize is a no-op for a channel that is no longer registered"_.
Gate: `container-runner.test.ts`, `session-claim-spawn.test.ts`, `container-restart*.test.ts`, `host-sweep-registry.test.ts` all green, unchanged.

**CP3 — P2** (§5 above) + `session-claim-spawn.test.ts` extensions: _"a spawn is refused while an untracked container is still running for the session"_,
_"a claim with a null container_ref never queries the runtime"_, _"a runtime listing failure refuses the spawn"_, _"the adopter bypasses P2"_. Gate: that file + callers ratchet.

**CP4 — adoption**: `pendingAdoptions` + `_resetAdoptionRetryStateForTesting`; `retryPendingAdoption(session)` (re-list → gone: delete + return false so the
caller falls through to `spawnContainer`; claim null: delete + throw; store down: throw) routed through `trackWake` so `wakePromises` dedupes and
`settlePendingKill` still runs; `wakeContainer` consults `pendingAdoptions` after the shutdown check and before the `:783` fast path (and the
`startReservedWake` fast path — a queued wake for a pending adoption must not spawn either); `adoptRunningSessions({ list? })` per §7.E steps 1–6
(never `rmSync` the heartbeat — it is the survivor's; `spawnedAt: Date.now()`; `everSeenRunningSessions.add`; `markContainerRunning`; arm
`channelOnClose(channel, () => onWaiterClose(...))`); `onWaiterClose`: truth re-read via `runtimeShowsRunning` → running: WARN
`Adopted container waiter exited but the container is still running — re-arming`, re-arm after 5 s backoff with a fresh waiter swapped into the same entry;
absent: `finalizeSession`; throws: re-arm with backoff; `fencedInbound` via `withExistingMailboxSession(agentGroupId, id, m => m.readRepoIngressFence()?.state === 'active')`.
Leave a named hook where F2's `honorPendingStopIntents()` and F1's per-session `reconcileSurvivorWakeRows` go (upstream `:678`). Tests: all 11
`container-adoption.test.ts` cases; remaining `container-supervision-channel.test.ts` cases: _"an adopted entry's SIGKILL fallback targets the container, not the waiter"_,
_"a waiter close finalizes the session"_, _"a waiter close while the container is still running re-arms instead of finalizing"_, _"a truth read that fails treats the container as running"_,
_"an adopted entry releases no storage-activity lease"_; `session-claim-callers.test.ts` grows by exactly one if the matcher sees it. Gate: those three files + ratchet.

**CP5 — main.ts wiring (after D1 merges; rebase first)**: `const reconciled = await adoptRunningSessions();` between the boot door and `:380`'s fence recovery;
`beginContainerShutdown()` (sets `containerShutdownInProgress`, `memoryAdmission?.shutdown()`, `await Promise.allSettled([...wakePromises.values()])` raced
against the 10 s grace; running entries untouched) replaces `:680`; rewrite the comments at `main.ts:334-340` and `src/agent-runner-source.ts:137-141`;
`src/adoption-order.test.ts` (3 cases, AST shape per §4). Gate: `tsc`, eslint, boundary check from the worktree root, `pnpm run ratchet:report -- --write`.

**CP6 — the three doors**: `scripts/nanoclaw-v2.service` and `data/systemd/nanoclaw-v2.service`: delete `ExecStop=` + its 7-line comment, `TimeoutStopSec=30`,
add `KillMode=mixed`; PR body: install-data file called out, two-part rollback order from §5 (unit first, then revert), the §6 E counters, the two live
`docker` checks from §7.E. `stopAllContainers` stays exported (rollback path) with zero production callers — add it to the dead-code kill list, do not delete.

## 7. Risks and plan-vs-tree mismatches

1. **`runtimeShowsRunning` must be a listing, not `inspect`** (§3). The plan's "a listing that throws returns true" is right only if absence is a
   successful empty result; an inspect-based helper wedges every post-crash session whose container exited during the outage.
2. **Waiter re-arm needs backoff and stderr classification**; the plan's "ten lines" is ~30. `docker wait` on a dead daemon exits at once.
3. **`KillMode`**: plan says `mixed`; `setup/service.ts:329` (the v1-era generator, pinned by `setup/service.test.ts:114`) says `process`. Keep `mixed` for
   the v2 unit and leave `setup/service.ts` alone: `process` would leak every `docker run`/`docker wait` client forever; `mixed` SIGKILLs them once the main
   process exits, and SIGKILL on a CLI client cannot be proxied and does not touch the daemon-owned container (AutoRemove daemon-side, verified). Verify at
   restart 4: `docker ps` shows the survivors and no pre-restart `docker run` client remains.
4. **Adopted containers hold no memory-admission reservation** — after restart 4 the controller can over-admit by up to the adopted count's RAM. Not in
   the plan. Recommendation: leave unreserved in E, log the count, file a follow-up; do not read container configs at adoption.
5. **`listInstallContainersStrict` is not exported** (`container-runtime.ts:92`); D1 must export the scoped listing and filter `nanoclaw-role=agent` (§2).
6. **A′ is unmerged**: E's base is #438's head; every A′ review round moves E's rebase target. Cut from A′, expect one rebase onto main and one onto D1.
7. **Two fast paths, not one**: `wakeContainer:628` and `startReservedWake:746` both short-circuit on the registry; P4 must sit in front of both.
8. **`stopAllContainers` has no production caller after E** (the boot door stops by name via `stopContainer`, not via the registry). Plan §4.3.5 says its
   "only caller becomes the boot door's stop set" — that is not how D1 is specified. Keep it exported for rollback; kill-list it.
9. **Callers ratchet matcher scans for `tryClaimSession`** (`session-claim-callers.test.ts:20-25`), which `adoptRunningSessions` never names; the plan's
   "grows by exactly one" may be a no-op. Make the E addition visible some other way if so.
10. **Line drift**: the plan's container-runner numbers are ~+17 stale on main and ~+172 on A′; every anchor above was re-read.
