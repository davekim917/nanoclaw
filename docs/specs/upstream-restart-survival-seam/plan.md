# Plan: Restart survival (convergence seam 4 — upstream #3653 + session adoption)

Status: **skeleton** (revision 0 — not yet reviewed; fills in after seam 3's PR 6 is planned)
Approval state: not requested. The theme itself is a committed operator must-have (relayed 2026-09-04 by `update-nanoclaw`): both halves — the durable-host rollup and `adoptRunningSessions()` — including the redesign of boot-time workgroup shared-FS reconciliation so it stops requiring every container down.
Primary runtime: Claude (orchestrator: Fable 5.1; builders: worker tiers; cross-model review: Codex gpt-5.6-sol high)
Program: upstream convergence, sync phase (memory `project_upstream_sync_phase_2026_09_04`); follows seam 3 (`docs/specs/upstream-async-central-db-seam/plan.md`).
Upstream target: `nanocoai/nanoclaw` rollup `07f2dda5d` "the durable host" (#3653, ten commits) and the session-driver seam (`src/drivers/**`, 15 files) as they stand on `upstream/main` `b76fcb3d`.
Grounding: read-only scout `seam4-restart-survival-scout.md` (orchestrator scratchpad, 2026-09-04) over the deployer's triage reports; every claim below carries its evidence there.
Executable acceptance criteria: **required** (live wake/spawn/delivery paths); to be written per PR in §8 when the skeleton is filled.

## 1. Outcome

Two user-visible milestones, in order:

1. **A host restart during an idle session no longer kills and respawns it.** Today every host start runs `cleanupOrphansStrict()` inside the workgroup-memory startup gate (`src/main.ts:162`) and graceful shutdown runs `stopAllContainers()` (`src/main.ts:655`); both stop every install-labeled container. After milestone 1 the host stops only sessions whose mounts must change, and a surviving container keeps running across the restart.
2. **A turn in flight when the host goes away finishes and its output is delivered when the host returns.** The runner already keeps running (no host-liveness check anywhere in `poll-loop.ts`; heartbeat, `provider_executing`, `processing_ack` live in the container-owned `outbound.db`), and delivery already drains a surviving container's outbound rows on the next sweep without adoption (`src/delivery.ts:714-733`). What milestone 2 adds is **lifecycle** ownership of the surviving container — kill, ceiling accounting, restart, stale detection — via adoption fenced by `session_claims`.

Plus one small independent fix the operator will feel: **poison messages** — the fork's delivery attempt counter is an in-memory `Map` that resets on restart (`src/delivery.ts:70-71`, give-up at `:633`), so a crash-looping host retries a poison message forever; upstream moved the count into `delivery_attempts` rows.

## 2. Scope and non-goals

In scope (ordered — see §4.1 for why the order is the safety argument):

- **A — coordination accessors + host lease.** `src/db/coordination.ts` (upstream 269 L) and `src/host-instance.ts` (85 L: lease start/renew 30 s/TTL 90 s/stop, wired into `main()` and `shutdown()`), re-derived over the fork's driver with SQL byte-for-byte and **`Promise`-returning signatures over sync bodies** so seam 3 later changes bodies, not call sites. Tables already exist after seam 3 PR 2 (`071-host-coordination`, shadow schema). Write-only at first.
- **B — poison-message fix.** `delivery_attempts` rows become the authority for retry counts (upstream `bad032365`); correct the fork's quiet-delivery-cache comment at `src/delivery.ts:86`, which justifies itself by the counter being in-memory.
- **C — labels and names.** Stamp `nanoclaw-group`, `nanoclaw-session`, `nanoclaw-role=agent` beside the existing install label (`src/container-runner.ts:3693`). **Keep the `nanoclaw-v2-` name prefix**: `src/agent-runner-source.ts:107` filters live containers by that prefix to protect mounted runner snapshots; adopting upstream's `ncl-…` grammar would silently delete a running container's snapshot.
- **A′ — claim-first spawn.** `tryClaimSession` CAS on `incarnation` at spawn and release on finish (upstream `6b0411c47`), so no unfenced window exists before D.
- **D — scoped startup quiescence (the reconcile redesign).** Replace the fleet-wide `cleanupOrphansStrict()` with inspect-then-scope: run the existing non-mutating inventory (`src/modules/workgroup/shared-dirs.ts:287-291`, per-workgroup `changed` flag `:395-400`, selector `:376`), then quiesce only the sessions in workgroups whose report says `changed`, through the fork's own scoped barrier `quiesceAgentGroupsForRepositoryMounts` (`src/container-restart.ts:363-376` — stops exactly the sessions owning a live mount, fences ingress, releases with a wake, already reasons about a "fresh/adopted activation token" `:50`). Skip the stop entirely when nothing changed. Graceful shutdown stops sending SIGTERM to agent containers (the `TimeoutStopSec` concern in `src/container-runner.ts:1514-1525` is re-evaluated against the driver's detached supervision in E).
- **E — adoption (second milestone).** `adoptRunningSessions()` (upstream `src/container-runner.ts:619`): enumerate by label, claim before adopting, lost CAS → leave the container alone, failed claim write → `pendingAdoptions` retried on the wake path; terminal detection for a handle with **no supervision child** via the docker-events hub + resync (`src/drivers/session-events.ts`). Design choice still open (§9): port the driver seam wholesale (~180 KB, 15 files, `docker run` → `create`+`start --attach`, `SessionSpec` admission, `reapResidue`) vs re-derive adoption minimally over the fork's `activeContainers` entry, which is built around `entry.process` / `process.once('close')` (`src/container-runner.ts:1527-1540`).
- **F — `on_wake` for adopted containers.** `on_wake` rows fire only on a fresh container's first poll (`poll-loop.ts:379-380`); an adopted container has spent its first poll, so restart notes, `ceiling-respawn-*` and `groups restart --message` become inert unless the host converts them to a trigger. Runner-side change; runner source is a boot snapshot, so it activates at the same restart.
- **G — narrow `host-restart-warn`.** After adoption it fires only for sessions genuinely stopped, not every marked-running session (`src/host-restart-warn.ts:344`); its header describes the world seam 4 removes.

Non-goals: `src/channels/chat-sdk-bridge.ts` (9 hunks, unrelated theme); the `poll-loop.ts` mid-turn "one content door" vs the fork's busy-flag discipline (mailbox theme, seam 1 backlog); the three sweep commits of #3653 (seam-2 territory, already fork-owned); `wake_signals` authority flip (unwired even upstream at `b76fcb3d`).

## 3. Current architecture (source evidence) — to fill from the scout §1–§4

Key facts already established: startup order in `src/main.ts` (`:268` runner-source activation → `:276` FS state → `:288` shared dirs → `:303` startup warn → `:307` memory gate, which kills everything → `:315` snapshot prune); the invariant forcing "all containers down" is **the mount set fixed at spawn** (container-absolute symlinks written by `prepareWorkgroupMemoryMember`, `shared-dirs.ts:205,243-245`, whose targets exist only for containers spawned afterward) — not inode pinning, not lock files; scope is per-workgroup; `pruneAgentRunnerSnapshots` is already adoption-safe except for the name-prefix filter; all eight new upstream files are pure adds with zero merge conflict.

## 4. Design — to fill

### 4.1 Ordering is the safety argument
The biggest risk is **two writers on one session** (a host and an orphan, or two hosts). Today `cleanupOrphansStrict`'s fail-closed proof is the only thing preventing it; D removes that proof. So A′ (claim-first spawn) lands and is deployed **before** D relaxes the stop — the unfenced window never exists. Invariant in a primitive: `tryClaimSession` (CAS on `incarnation`, `changes > 0`) is the only path that may start or adopt a container; a ratchet test pins its callers.

### 4.2 Mount changes go only through the scoped barrier
Invariant in a primitive: the workgroup reconcile may change a live container's mount targets only inside `quiesceAgentGroupsForRepositoryMounts`; a structural test asserts `reconcileWorkgroupMemory`/`reconcileWorkgroupSharedDirs` are reachable only through it (or through the no-container path when the inventory reports no change).

### 4.3 Adoption without a supervision child — decision pending (§9)

## 5. Safety, rollout, rollback — to fill
Rollback anchors as in seam 3. D is the one PR where a wrong scope leaves a container with dangling `/workspace/agent/memory`; its acceptance test spawns against a changed workgroup and an unchanged one and asserts only the first is quiesced.

## 6. Observability — to fill (claim outcomes, adoption counts, lease renew failures, quiescence scope per boot)

## 7. Implementation path (draft)

| PR | Scope | Depends on | Restart | Owner |
|---|---|---|---|---|
| A | coordination accessors + host lease (write-only) | seam 3 PR 2 (tables) | rides any | runner-mailbox owner |
| B | poison-message fix onto `delivery_attempts` | A | low | runner-mailbox owner |
| C | labels; keep `nanoclaw-v2-` prefix | — | rides any | runner-mailbox owner |
| A′ | claim-first spawn + release on finish | A | medium | runner-mailbox owner |
| D | scoped startup quiescence | A′ deployed, C | **high** (first restart that leaves containers up) | runner-mailbox owner; seam-2 owner reviews the sweep interaction |
| E | adoption | D, driver-seam decision | high | runner-mailbox owner |
| F | `on_wake` for adopted containers (runner) | E | same restart as E | runner-mailbox owner |
| G | narrow host-restart-warn | E | rides any | runner-mailbox owner |

A–D are independent of seam 3's async conversion (Promise signatures over sync bodies) and can interleave with seam 3's restart windows; E waits for the driver-seam decision.

## 8. Executable acceptance criteria — to write per PR

## 9. Open decisions

- **E shape:** wholesale driver-seam port vs minimal adoption over the fork's `activeContainers`. Investigation item for the orchestrator, not the operator: measure how much of `docker-driver.ts`/`session-events.ts` the fork's spawn path can absorb without re-deriving the 28-hunk `container-runner.ts` conflict twice. Recommendation to be stated after seam 3 PR 6 is planned.
- **Graceful shutdown semantics:** with adoption, `stopAllContainers()` on SIGTERM becomes wrong (it is what adoption exists to avoid); the systemd `TimeoutStopSec` concern must be re-verified against detached `docker start --attach` supervision.

## 10. Verification commands — per PR, same rules as seam 3 §10.
