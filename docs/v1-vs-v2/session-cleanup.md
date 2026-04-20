# session-cleanup: v1 vs v2

## Scope
- v1: `src/v1/session-cleanup.ts` (26 LOC) + `scripts/cleanup-sessions.sh` (151 LOC) — cadence 24h
- v2: `src/host-sweep.ts` (174 LOC) primary, plus `src/container-runtime.ts:60-80` (orphan cleanup), `src/session-manager.ts` (heartbeat path)

## Capability map

| v1 behavior | v2 location | Status | Notes |
|---|---|---|---|
| Cleanup cadence 24h | `host-sweep.ts:31` 60s sweep | **changed** | Continuous monitoring |
| Stale session detection via JSONL mtime | `host-sweep.ts:116-151` heartbeat file mtime | simplified | Heartbeat replaces JSONL |
| Heartbeat threshold | `STALE_THRESHOLD_MS = 10 * 60 * 1000` (`host-sweep.ts:32`) | **new** | 10 min |
| Stuck-processing detection | `getStuckProcessingIds()` via outbound.db (`host-sweep.ts:134`) | **new** | |
| Retry with exponential backoff | `BACKOFF_BASE_MS * 2^tries` (`host-sweep.ts:145`) | **new** | |
| Max retries | `MAX_TRIES = 5` (`host-sweep.ts:33`) | **new** | Messages → failed after 5 |
| Explicit container kill on stale | — | **not done** | Stale detection resets messages, doesn't stop container |
| JSONL + tool-results cleanup | — | **removed** | No artifact cleanup (SQLite persists in DB) |
| Artifact cleanup (debug logs, todos, telemetry) | — | **removed** | Per-type retention windows gone |
| Orphan container cleanup | `container-runtime.ts:60-80` `cleanupOrphans()` | **new** | At startup only |
| Active session detection via `store/messages.db` | `getActiveSessions()` from `v2.db` (`host-sweep.ts:52`) | changed | DB schema different |
| Sync `processing_ack` (outbound.db → inbound.db) | `syncProcessingAcks()` (`host-sweep.ts:87`) | **new** | |
| Wake container for due messages | `countDueMessages()` + `wakeContainer()` (`host-sweep.ts:91-96`) | **new** | Replaces scheduler's role |
| Recurrence firing | `handleRecurrence()` (`host-sweep.ts:154-173`) | **new** | Cron-parsed next-run insertion |

## Missing from v2
1. **Artifact cleanup** — v1 pruned JSONLs (7d), debug logs (3d), todos (3d), telemetry (7d), group logs (7d). v2 has none; if v1 leftovers exist on disk, they'll accumulate
2. **Explicit container termination** on stale detection — v2 marks messages as retry-eligible but leaves the stale container running; orphan cleanup only runs at next startup
3. **Configurable retention windows** — v1 had per-artifact-type retention; v2 constants are hardcoded

## Behavioral discrepancies
| Aspect | v1 | v2 |
|---|---|---|
| Cadence | daily batch | 60s continuous |
| Stale trigger | 24h-old JSONL | 10-min heartbeat |
| Retry | none (session removed) | 5 tries, exp. backoff |
| Container wake | via message loop | via `countDueMessages()` in sweep |
| Transactions | implicit (offline script) | explicit per-session try/finally |

## Worth preserving?
1. **Stop running containers on stale detection** — currently only startup `cleanupOrphans()` removes them. If a container truly dies while the host runs, the host will retry messages but won't kill the shell. Low-cost fix: `stopContainer(name)` when heartbeat is stale AND processing_ack is stuck
2. **Artifact cleanup migration** — if v1 data exists on disk post-migration, one-time prune is worth scripting. Not a v2 runtime concern
3. **Configurable thresholds** — `STALE_THRESHOLD_MS` / `MAX_TRIES` could live in `config.ts` for operational tuning; minor improvement
4. **Continuous sweep + recurrence + orphan cleanup** are all **significant improvements**; keep as-is
