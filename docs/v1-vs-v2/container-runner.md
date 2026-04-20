# container-runner: v1 vs v2

## Scope
- v1: `src/v1/container-runner.ts` (677 LOC) + `container-runner.test.ts` (204 LOC) — spawn + IPC plumbing + stdin/stdout JSON + process supervision + output-marker parsing
- v2: `src/container-runner.ts` (405 LOC) + `src/container-config.ts` (114 LOC) + `src/session-manager.ts` (DB paths). Net ~272 LOC removed by eliminating IPC and output parsing

## Capability map

| v1 behavior | v2 location | Status | Notes |
|---|---|---|---|
| Image selection | `container-runner.ts:348-349` | kept | Reads `imageTag` from container.json or env |
| Env injection | `container-runner.ts:266-284` | **changed** | Replaced IPC vars with `SESSION_INBOUND/OUTBOUND_DB_PATH`, `SESSION_HEARTBEAT_PATH`, `AGENT_PROVIDER`, `NANOCLAW_*` admin IDs |
| Volume mounts | `container-runner.ts:200-252` | **changed** | Removed per-group IPC dir; added session folder `/workspace` + agent group `/workspace/agent` |
| Mount validation | `container-runner.ts:240-244` | kept | Validates `additionalMounts` from container.json |
| Provider integration | `container-runner.ts:184-198` | **new** | `resolveProviderContribution()` wires provider host-side configs |
| stdin/stdout IPC | — | **removed** | v1 lines 318-387; v2 uses DB polling only; stdio=`['ignore','pipe','pipe']` |
| Process spawn | `container-runner.ts:119` | kept | |
| OneCLI `ensureAgent` + `applyContainerConfig` | `container-runner.ts:301-313` | enhanced | v2 calls `ensureAgent` first |
| Admin ID injection | `container-runner.ts:289-295` | **new** | Queries `getOwners/getGlobalAdmins/getAdminsOfAgentGroup` at wake |
| Idle timeout | `container-runner.ts:135-140` | changed | v2 uses `resetIdle()` callback on activeContainers entry, settable by `delivery.ts` |
| Timeout logic | — | **removed** | v1 had configurable per-group timeout reset on output markers |
| Output parsing | — | **removed** | v1 parsed `---NANOCLAW_OUTPUT_START/END---` from stdout; v2 ignores stdout |
| Streaming output callback | — | **removed** | v1 had `onOutput()` for real-time delivery |
| Per-exit log file | — | **removed** | v1 wrote `groups/<folder>/logs/container-*.log` with full I/O; v2 only logs stderr to logger.debug |
| Graceful SIGTERM→SIGKILL | — | simplified | v2 just calls `stopContainer()` |
| Concurrent wake dedup | `container-runner.ts:44-82` | **new** | `wakePromises` Map prevents race on spawn |
| Per-group image builds | `container-runner.ts:357-405` | **new** | `buildAgentGroupImage()` writes `imageTag` |
| Session folder init | `container-runner.ts:210` | **new** | `initGroupFilesystem()` at spawn |
| Heartbeat file `/workspace/.heartbeat` | session-manager.ts | **new** | File-touch replaces IPC liveness |
| Task/group JSON snapshots (`current_tasks.json`, `available_groups.json`) | — | **removed** | v2 pushes data via inbound.db writeDestinations/writeSessionRouting |
| Container name | `container-runner.ts:103` | changed | `nanoclaw-v2-${folder}-${Date.now()}` |

## Missing from v2
1. **Streaming output markers** — `---NANOCLAW_OUTPUT_START/END---` enabled pre-completion delivery; v2 must wait for outbound.db poll to deliver results
2. **Configurable per-group timeout** — `group.containerConfig.timeout` override is gone; all groups share `IDLE_TIMEOUT`
3. **Per-exit detailed logs** — v1 wrote timestamped logs with full I/O + mounts + stderr + stdout; invaluable for post-mortem
4. **Graceful-stop sentinel** — v1 sent SIGTERM and waited for `_close` marker before SIGKILL
5. **JSON snapshots for tasks/groups** — `current_tasks.json` / `available_groups.json` in the group IPC dir

## Behavioral discrepancies
1. **Async result model**: v1 `runContainerAgent()` returned `Promise<ContainerOutput>` with inline result; v2 `wakeContainer()` is fire-and-forget — results asynchronous via delivery poll
2. **No stdin**: v1 wrote full `ContainerInput` JSON to stdin; v2 container reads everything from inbound.db
3. **Admin injection at wake**: v2 queries admins fresh on every spawn (`NANOCLAW_ADMIN_USER_IDS`)
4. **Destination routing timing**: v2 calls `writeDestinations()` + `writeSessionRouting()` on every wake so changes apply without restart
5. **Session lifecycle**: v1 created a session per spawn; v2 resolves session via router before wake

## Worth preserving?
- **Streaming output**: Meaningful latency improvement. Hybrid model (DB polling + optional marker pre-delivery) could reduce perceived latency for long outputs
- **Per-group timeout**: Restore — different agent groups have different expected latencies
- **Per-exit logs**: At minimum, restore on non-zero exit. Cheap forensics, huge debug value
- **Graceful-stop sentinel**: Not critical — bun container is disposable
