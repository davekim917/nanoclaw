# host index: v1 vs v2

## Scope
- v1: `src/v1/index.ts` (647 LOC) — monolithic entry: config, DB, state, channels, queues, scheduler, IPC watcher, message loop
- v2: `src/index.ts` (345 LOC) — lean entry: DB+migrations, channels, delivery/sweep polls, OneCLI handler

## Startup sequence diff

| # | v1 step | v2 step | Status |
|---|---------|---------|--------|
| 1 | `ensureContainerRuntimeRunning()` + `cleanupOrphans()` | same | kept |
| 2 | `initDatabase()` | `initDb()` + `runMigrations()` | enhanced (explicit migrations) |
| 3 | `loadState()` — cursor, groups, agent timestamps | — | removed (no global state) |
| 4 | OneCLI `ensureAgent` per group | — | removed (now per-wake in `container-runner.ts`) |
| 5 | `restoreRemoteControl()` | — | removed |
| 6 | SIGTERM/SIGINT handlers | same | kept |
| 7 | `handleRemoteControl` bind | — | removed |
| 8 | Channel options + callbacks | `initChannelAdapters()` | rewritten (adapter API) |
| 9 | Channel discovery + connection | absorbed into adapters | — |
| 10 | `startSchedulerLoop()` | — | removed (folded into `startHostSweep`) |
| 11 | `startIpcWatcher()` | — | removed (no IPC in v2) |
| 12 | `startSessionCleanup()` | — | removed (folded into `startHostSweep`) |
| 13 | `queue.setProcessMessagesFn()` | — | removed (GroupQueue gone) |
| 14 | `recoverPendingMessages()` | — | **removed** (implicit in sweep) |
| 15 | `startMessageLoop()` (polling) | `startActiveDeliveryPoll()` + `startSweepDeliveryPoll()` | **fundamentally changed** (event-driven) |
| 16 | — | `startHostSweep()` | **new** |
| 17 | — | `startOneCLIApprovalHandler()` | **new** |

## Capability map

| v1 behavior | v2 location | Status | Notes |
|---|---|---|---|
| Arg/env parsing | `src/config.ts` (shared) | kept | |
| Central DB init | `src/index.ts:47-50` | kept | + `runMigrations()` |
| Container runtime bring-up | `src/index.ts:52-54` | kept | identical |
| Global cursor + timestamps state | — | **removed** | v2 session-scoped state in outbound.db |
| Periodic message polling loop | — | **removed** | Replaced by event-driven delivery + 60s sweep |
| OneCLI group-wide sync at startup | — | **removed** | Per-wake in `container-runner.ts:303` |
| Remote control subsystem | — | **removed** | No equivalent — feature deferred |
| Group message queue (`GroupQueue`) | — | **removed** | DB-based serialization |
| Channel adapter array + callbacks | `src/channels/channel-registry.ts` | refactored | `ChannelAdapter` interface |
| Pending message recovery on startup | — | **removed** | Sweep detects stale containers + resets messages |
| IPC watcher (dynamic group add) | — | **removed** | Static topology at startup; restart to add groups |
| Signal handlers | `src/index.ts:339-340` | kept | Simplified teardown |
| Top-level error handling | `src/index.ts:342-345` | kept | Same fatal exit |

## Missing from v2
1. **Polling message loop** (v1:370-459) — replaced by event-driven + sweep (net improvement)
2. **GroupQueue state machine** — now DB-based
3. **Cross-restart cursor state** — no `lastAgentTimestamp` persisted; recovery implicit via DB scan
4. **Remote control** — gone
5. **Explicit `recoverPendingMessages()`** — implicit in sweep; worth verifying via post-crash test
6. **IPC watcher** (`startIpcWatcher`) — cannot add groups dynamically; restart required
7. **Scheduler loop** — merged into sweep's due-message wake

## Behavioral discrepancies
| Aspect | v1 | v2 |
|---|----|----|
| Startup time | ~500ms (long loop init) | ~200ms |
| Message fetch | polling every POLL_INTERVAL | event-driven callbacks + 1s delivery poll |
| Container spawn | on-demand via GroupQueue | per-message wake via router/sweep |
| Group topology | dynamic (IPC watcher) | static at startup |
| Error recovery | per-message cursor rollback | implicit via stale detection |
| Shutdown | GroupQueue 10s grace then disconnect | stop handlers/polls/sweep/adapters in order |

## Worth preserving?
1. **Polling loop**: No — event-driven is superior. Verify delivery poll latency regression vs old POLL_INTERVAL under load
2. **Pending-message recovery**: Worth explicit restoration — kill a container mid-message, restart host, verify re-delivery within ≤5s. If sweep doesn't cover this, add startup-phase scan
3. **Remote control**: Unknown — either restore as opt-in skill or document removal
4. **Dynamic group add (IPC watcher)**: Probably not worth — modern flow is "admin skill adds group to DB, restart". But document that restart is required
