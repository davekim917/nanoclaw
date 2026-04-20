# v1 → v2 Deep Dive: Aggregate Summary

Per-file deep-dives were produced for every file in `src/v1/` and `container/agent-runner/src/v1/`. This document aggregates findings across all 21 modules.

## Per-file docs

| Topic | File | v1 source(s) |
|---|---|---|
| Configuration | [config.md](config.md) | `src/v1/config.ts` |
| Environment helpers | [env.md](env.md) | `src/v1/env.ts` |
| Types | [types.md](types.md) | `src/v1/types.ts` |
| Logger | [logger.md](logger.md) | `src/v1/logger.ts` |
| Timezone | [timezone.md](timezone.md) | `src/v1/timezone.ts` |
| Database layer | [db.md](db.md) | `src/v1/db.ts` |
| Container runner | [container-runner.md](container-runner.md) | `src/v1/container-runner.ts` |
| Container runtime + mounts | [container-runtime.md](container-runtime.md) | `src/v1/container-runtime.ts`, `mount-security.ts` |
| Group folder | [group-folder.md](group-folder.md) | `src/v1/group-folder.ts` |
| Group queue | [group-queue.md](group-queue.md) | `src/v1/group-queue.ts` |
| Host index | [index-host.md](index-host.md) | `src/v1/index.ts` |
| IPC (host + container) | [ipc.md](ipc.md) | `src/v1/ipc.ts`, `container/.../v1/ipc-mcp-stdio.ts` |
| Remote control | [remote-control.md](remote-control.md) | `src/v1/remote-control.ts` |
| Router | [router.md](router.md) | `src/v1/router.ts` + `index.ts` routing |
| Sender allowlist | [sender-allowlist.md](sender-allowlist.md) | `src/v1/sender-allowlist.ts` |
| Session cleanup | [session-cleanup.md](session-cleanup.md) | `src/v1/session-cleanup.ts` |
| Task scheduler | [task-scheduler.md](task-scheduler.md) | `src/v1/task-scheduler.ts` |
| Channels | [channels.md](channels.md) | `src/v1/channels/*` |
| Agent-runner entry | [container-index.md](container-index.md) | `container/.../v1/index.ts` |
| Agent-runner MCP tools | [container-mcp-tools.md](container-mcp-tools.md) | `container/.../v1/mcp-tools.ts` |
| Formatting test (orphan) | [formatting-test.md](formatting-test.md) | `src/v1/formatting.test.ts` |

## The big shift

v2 rewrote the fundamental transport between host and container. The one-line version:

> **v1 = IPC files + stdin/stdout + in-memory GroupQueue + polling message loop.
> v2 = two SQLite DBs per session + event-driven routing + 60s host sweep.**

Everything else flows from that. Removing IPC forced a rewrite of the router, the container-runner, the agent-runner entry, and the MCP-tool bridge. The 60s sweep absorbed the task scheduler, session cleanup, and pending-message recovery. The entity model (users/roles/messaging_groups) replaced the flat sender allowlist and chat-level config. Provider abstraction + Chat SDK bridge replaced hardcoded Claude SDK + per-channel adapters.

Net LOC: v1 (~7.4k host + monolithic container-runner) → v2 (~5.5k host, split modules). Fewer lines, cleaner boundaries, more coverage.

## What's kept (identical or near-identical)
- `timezone.ts` — byte-identical
- `group-folder.ts` — byte-identical validation; v2 adds `group-init.ts` for filesystem scaffold
- `container-runtime.ts` — nearly identical (only logger import swapped)
- `mount-security.ts` — same structure, one field removed (see regressions)
- `config.ts` / `env.ts` — same structure, same `.env` surface; several constants now dead code
- `logger.ts` — same levels/colors/routing, but API shape changed (message-first instead of data-first)
- MCP `send_message` tool — kept + enhanced with named destinations

## What's new in v2
- **Two-DB session model** (`inbound.db` + `outbound.db`) with even/odd seq parity, journal_mode=DELETE for cross-mount visibility
- **Entity model** — `users`, `user_roles` (owner/admin/scoped), `agent_group_members`, `messaging_groups`, `messaging_group_agents`, `user_dms` (cold-DM cache)
- **Host sweep** (60s) — absorbs scheduler, cleanup, pending-message recovery, recurrence firing, stale detection, orphan cleanup
- **Chat SDK bridge** — unifies Discord/Slack/Teams/other adapters through `@anthropic-ai/chat`
- **Provider abstraction** — default Claude + opt-in OpenCode etc. via `providers` branch
- **OneCLI integration** — credential gateway + approval flow (`src/onecli-approvals.ts`)
- **16 new MCP tools** — scheduling (6), interactive (2), self-mod (3), agent mgmt (1), message manipulation (3), plus enhanced `send_message`
- **Heartbeat file mtime** — replaces IPC liveness
- **Session persistence** — session ID survives container restarts
- **Dual-rate polling** — 1000ms idle / 500ms active inside container
- **Idle stream termination** — 20s timeout prevents zombie queries
- **Processing ACK** — reverse channel (outbound → inbound) for idempotence
- **Migration system** — 9 numbered migrations vs v1's ad-hoc ALTERs
- **Webhook server** (new for HTTP-based channels)
- **Container typing indicator refresh** via delivery

## What's removed (deliberately)
- **IPC transport** (files, stdin/stdout JSON, MCP-over-stdio bridge) — replaced by DB polling
- **`GroupQueue`** in-memory state machine — serialization via `messages_in.status`
- **Output markers** (`---NANOCLAW_OUTPUT_START/END---`) — results land in `messages_out`
- **State persistence** (`router_state`, `lastAgentTimestamp` map) — each message is independent
- **Per-exit container log files** — only logger.debug to host log
- **Flat sender allowlist** (JSON config) — replaced by role-based access + `unknown_sender_policy`
- **Remote control subsystem** (`/remote-control` command → spawned CLI)
- **IPC watcher** (dynamic group-add while running)
- **`task_runs` audit table** — no task execution log
- **Cron/interval task types** as first-class entities — tasks are `messages_in` rows with `kind='task'` + `recurrence`
- **Stdin protocol** for agent input — container reads from inbound.db

## Regressions worth fixing (ranked)

### HIGH priority
1. **Trigger-rule matching in `pickAgent`** (`src/router.ts:198` TODO).
   Without this, a messaging group wired to multiple agents fires ALL of them on every message. Schema (`messaging_group_agents.trigger_rules`) is ready; the check is ~10 lines. **Likely broken-by-default for multi-agent setups.**

2. **`nonMainReadOnly` mount isolation removed** (`src/mount-security.ts`).
   Non-main/shared agent groups can now mount read-write on any path the allowlist permits. v1 enforced read-only-for-non-main regardless of allowlist. **Security regression** for multi-tenant setups. Restore: add field + restore `isMain` param flow.

3. **Pending-message recovery on startup** (`src/v1/index.ts:465-473`).
   v1 explicitly scanned for unprocessed messages on restart. v2 relies on the sweep to notice. Likely works in practice, but worth a test: kill container mid-message, restart host, verify redelivery within ≤5s.

### MEDIUM priority
4. **`response_scope` enforcement** (`messaging_group_agents.response_scope` stored but unused).
   Values `'all' | 'triggered' | 'allowlisted'` are saved but nothing reads them.

5. **`request_approval` flow for unknown senders** (`src/router.ts:295` TODO).
   `unknown_sender_policy='request_approval'` is scaffolded but doesn't actually produce an approval card.

6. **Per-group container timeout**.
   v1's `containerConfig.timeout` override is gone; all groups share `IDLE_TIMEOUT`. Slow-but-healthy agents get killed with fast agents' timeout.

7. **Container streaming output**.
   v1's marker-based pre-completion delivery is gone. v2 must wait for outbound.db poll. Latency-sensitive UX regresses.

8. **Per-exit container logs**.
   v1 wrote timestamped per-exit log files with full I/O + mounts + stderr. v2 only has logger.debug. Zero-cost on success, high-value on crash. Restore at least for non-zero exit.

9. **Explicit container kill on stale detection**.
   v2's sweep marks messages for retry but doesn't stop the stale container. Only `cleanupOrphans()` at startup removes them. Add `stopContainer()` when heartbeat stale AND processing stuck.

10. **Host-level retry with backoff on agent error**.
    v1 had MAX_RETRIES=5 + exp. backoff on `processGroupMessages` failure. v2 only retries on stale-heartbeat. Explicit agent-error retry could close the gap.

### LOW priority
11. **Process ID in logger output** — lost multi-process debugging info
12. **Task dedup via unique `(kind, series_id)` index** — v2 can have two pending rows with same series; best-effort via atomic status update
13. **Silent-drop mode for noisy senders** — v1's `mode:'drop'` had a use case; orthogonal to privilege
14. **Remote control** — decide: restore as opt-in skill or document as removed
15. **Dead config constants** (`POLL_INTERVAL`, `SCHEDULER_POLL_INTERVAL`, `IPC_POLL_INTERVAL`) — delete from `src/config.ts`
16. **Configurable retention thresholds** (`STALE_THRESHOLD_MS`, `MAX_TRIES`) — move from constants to `config.ts`
17. **Dynamic group-add** (IPC watcher equivalent) — probably not worth; document that restart is required

## Things kept as test-only regression risk
The orphan `src/v1/formatting.test.ts` asserted behaviors that aren't fully exercised in v2:
- **Timezone-aware formatted timestamps** — v1 emitted locale strings ("Jan 1, 2024, 1:30 PM"); v2 emits UTC HH:MM
- **`<context timezone="..."/>` header** — gone
- **`reply_to="<id>"` attribute** — v2 only stores sender name + truncated preview
- **Trigger-pattern unit tests** — no direct equivalent (logic moved to DB but isn't tested at the router level)
- **Internal tag stripping** tests — no isolated tests in agent-runner

These are specs worth porting to v2 tests once trigger matching is implemented.

## Files entirely gone in v2
- `src/v1/ipc.ts` + `src/v1/ipc-auth.test.ts` — IPC is dead
- `container/.../v1/ipc-mcp-stdio.ts` — MCP-over-stdio bridge dead
- `src/v1/group-queue.ts` — serialization via DB
- `src/v1/session-cleanup.ts` — merged into `host-sweep.ts`
- `src/v1/task-scheduler.ts` — merged into `host-sweep.ts` + system actions in `delivery.ts`
- `src/v1/remote-control.ts` — feature removed
- `src/v1/sender-allowlist.ts` — entity model supersedes

## Net architectural assessment
v2 is strictly simpler, more consistent, and more robust in its happy path. The remaining TODOs (trigger matching, response_scope, request_approval) reflect scaffolding that was checked in ahead of the feature — none are deep design issues. The one actual regression is `nonMainReadOnly` mount isolation; it was a defense-in-depth feature and deserves to come back. The removal of per-exit container logs and streaming output markers are judgment calls that traded observability for simplicity — both can be restored cheaply if needed.

No file in v1 contains a behavior that v2 is architecturally unable to express. The outstanding work is feature-completion, not architecture.
