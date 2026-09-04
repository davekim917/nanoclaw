# Plan sections: five upstream themes (host-sweep, scheduling, permissions, agent-to-agent, cli-resources)

**Review history.**
r1 — Codex request-changes, 13 findings, all accepted and fixed in r2.
r2 — Codex request-changes, 5 findings (1 and 2 high, 3 and 4 medium, 5 low), all accepted and fixed in r3.
r3 — Codex request-changes, 4 findings (3 medium, 1 low), all accepted and fixed in r4: the deferral contract, the queue test set, T0b's dependency closure, and three stale counts.
r4 — narrow Codex re-check of the four r3 items: 1 medium (reconcile-queue.ts header comments contradicted the residue forecast) + 2 lows (one absolute phrase, the plugin-owner test source), all fixed in this revision. Final round. Anything that could not be grounded is listed under a theme's **Residue / unresolved** heading rather than asserted.

Base: `origin/main` `f3521bf76` — seam 3 PR 0 merged there. `origin/main` advanced to `f4d96f023` (docs-only) and then to `3e5adcaed` (the weekly upstream dry-run report, #375) during these revisions. The only manifest entry that moved across all three is `package.json` (67 → 68, accepted in `d0765808f`), which no theme here owns, so **every diff number below holds at all three commits**. Upstream `b76fcb3d`, merge-base `641963c1e`.
Every theme is ported **after seam 3 through PR 6** (`docs/specs/upstream-async-central-db-seam/plan.md`), onto its shape: async `DbDriver`, no sync twins, `centralTransaction` / `withCentralSync` / `withRawDb` / `evaluateGuardSync` per §4.4–§4.5.
Diff-line figures are `diff` from `src/upstream-ratchet.json`, pinned against `b76fcb3d`.

## §0 Cross-theme ordering

### 0.1 Corrections to the theme inventory, verified

1. **Its structural claims for permissions and agent-to-agent are wrong.** It says the fork lacks upstream's `access.ts`, `db/users.ts`, `db/user-dms.ts`, `db/agent-group-members.ts`, `agent-to-agent/index.ts`, `guard.ts`, `db/agent-destinations.ts`, `db/agent-message-policies.ts`. All eight exist on `origin/main` with live ratchet entries (42, 40, 25, 72, 21, 12, 105, 46).
2. **The MPDM feature race is already half-settled on upstream's seam.** The fork calls `channelAdapter.resolveConversation` at `channel-approval.ts:260`, upstream at `:274`. The genuine gap is `registerChannelCardInterceptor` (`upstream/main:channel-approval.ts:85-89`), with zero fork occurrences.
3. **Only two of the four listed duplicates land here as decisions**, and there is a **fifth** the triage missed. Decline_notify and approval-card scope disclosure are theme 5; the pre-task-script timeout copy is theme 4; the task-run escalation destination is an agent-runner file, owned elsewhere. The fifth is the empty-`--prompt` refusal on task update (upstream `afafd318b`, fork `c7c4edf2a`, `tasks.ts:538`).

### 0.2 Cross-plan edits required — these are not this plan's to make

| Edit | Owner who must accept it | Why |
|---|---|---|
| Add `src/modules/agent-to-agent/write-destinations.ts` to seam 3 §4.5's **exact terminal `withRawDb` allowlist** | seam 3 owner (runner-mailbox session) | §4.5 fixes that allowlist as "the three guard implementations, `withQuietInvalidationSync`, `migrations/index.ts`, `storage-maintenance-worker-thread.ts`". The destination projection's TOCTOU guard needs synchronous central reads inside the mailbox callback (theme 2). Justification to carry: it is a fourth "read the central set and write in the same synchronous turn" site, structurally identical to `withQuietInvalidationSync`'s contract, and no async form of it preserves the invariant. Without this edit, theme 2 fails seam 3's PR 6 ratchet. |
| Open a **templates / Agent Plugins theme** | **owner: update-nanoclaw, after seam-3 PR 4** (both of its behavior conflicts take the async shape) | See §0.3 T0b. |

### 0.3 Proposed order

| # | Item | Why here |
|---|---|---|
| **T0** | `requestWake` seam | 32 lines of pure delegation (`upstream/main:src/request-wake.ts`, absent in the fork) that eleven upstream files import. Behavior-identical by construction; porting it once removes the same hunk from three themes. |
| **T0b** | Two prerequisites (owner: cli-resources) | (i) `groupFolderExistsOnDisk` in `src/group-folder.ts` + `group-folder.test.ts`; (ii) the MCP intake parsers in `src/container-config.ts` **with their full dependency closure** — see below. All four named symbols return 0 from `git grep -c` on `origin/main`. |
| — | **T0b (ii) is a closure, not three exports** | Only `mcpServerPluginOwner` is a true leaf: it reads a `plugin` string field (`upstream/main:container-config.ts:101-105`). The other two are not. `validateMcpServerName` needs `MCP_SERVER_NAME_RE` (`:97`). `parseMcpServerConfig` (`:126-198`) needs **four private regex constants** — `SECRET_QUERY_KEY_RE` (`:83`), `CAMEL_SPLIT_RE` (`:87`), `ENV_KEY_RE` (`:98`), `CWD_FORM_RE` (`:118`) — plus the private helpers `parseStringRecord` (`:200`) and `parseCwd` (`:214`), and it can return a stdio entry carrying `cwd`, which the fork's `StdioMcpServerConfig` (`origin/main:container-config.ts:36-42`) has no property for. So T0b (ii) is: those four constants plus `MCP_SERVER_NAME_RE` (five in total), the two private helpers, the three exports, **the minimal compatible type change** adding optional `cwd?: string` to `StdioMcpServerConfig`, and selective tests: the parser and name-validation cases lifted from upstream's `container-config.test.ts`; the plugin-owner cases re-derived fork-side from upstream's `groups-plugin-guard.test.ts` (upstream's `container-config.test.ts` has none). **Rejected alternative:** a deliberately narrower fork parser that omits `cwd` entirely. Rejected because `cwd` is the Agent Plugins fixed-form field the templates theme will need, and re-adding it later means re-opening the same intake path and its approval-replay validation a second time. |
| — | **`src/templates/restamp.ts` is NOT in T0b** | It cannot compile against HEAD. It imports four absent modules (`templates/manifest.ts`, `mcp.ts`, `plugin-dir.ts`, `tasks.ts`), plus `modules/scheduling/task-content.ts`; it needs `groupSkillsOverlayDir` and `markPluginServers`, which the fork's `templates/create-agent.ts` does not export; `PERSONA_PREPEND_FILE`, which `group-persona.ts` does not export; and `Template.name` / `.dir` / `.report`, which the fork's `templates/parse.ts` `Template` (`:6-12`: `mcpServers`, `instructions`, `contextExtras`, `skills`, `tasks`) does not have. It also **conflicts with fork behavior twice**: it updates only `container_configs` (`restamp.ts:323`) against the fork's `container.json`-plus-DB invariant, and its task update goes through `withExistingMailboxSession` → `mailbox.updateTask` (`:381-382`) with no `withQuietInvalidationSync` bracket. This is an Agent Plugins format migration. **Every restamp-related `groups.ts` hunk (`f8563abe1`, `6b08907a7`, `5b6a81d5f`) defers to a templates theme, owner unassigned.** |
| 1 | **host-sweep** — *see the ordering note below* | |
| 2 | **agent-to-agent** | Smallest real theme, no feature race, fork is a strict superset on the same export surface. Proves T0 and the async shape on 2,312 diff lines before any judgment call. |
| 3 | **cli-resources** | Largest ratchet payoff and the lowest live blast radius; settles the timezone decision theme 4 consumes. |
| 4 | **scheduling** | Depends on the cli decisions above. |
| 5 | **permissions** | Biggest conflict surface and the only genuine feature race. Do it when three themes have proven the shape. |

**Ordering note.** Host-sweep is numbered 1 for readability but **executes last**: it is the only theme with a hard seam-4 gate (claim-derived behavior needs A and A′ *deployed*; the runtime watch needs E). The execution order is agent-to-agent → cli-resources → scheduling → permissions → host-sweep. `taskNameSlug` and `task-content.ts` have **one owner: scheduling** (r2 had them in both places).

### 0.4 Files shared between two themes — one owner each

| File | Also wanted by | Owner |
|---|---|---|
| `src/group-folder.ts` (42) / `.test.ts` (53) | all three folder-reuse consumers | **T0b** — `groupFolderExistsOnDisk` uses `lstat`, not `existsSync`, so a dangling symlink counts as present (`upstream/main:group-folder.ts:62-69`). The fork's folder grammar is preserved. |
| `src/container-config.ts` (889) | cli-resources, scheduling | **T0b** — the three MCP intake exports with their closure and the `cwd?: string` type change (§0.3), nothing else in the file |
| `src/templates/restamp.ts` (546, absent), `src/templates/create-agent.ts`, `src/cli/resources/groups-plugin-guard.test.ts` (160, absent) | cli-resources | **templates theme (owner: update-nanoclaw, after seam-3 PR 4).** The guard test imports `templates/manifest.ts` and `templates/extension.ts` (both absent) and four of its seven cases are restamp cases, so the whole file defers; cli-resources re-derives the three plugin-owner-guard cases (`:76,87,94`) fork-side against `mcpServerPluginOwner` alone. |
| `src/session-manager.ts` | host-sweep (the mail-feed producer) | **host-sweep** — upstream `d6545e89d` adds the import and one `enqueueSessionReconcile(sessionId)` call. |
| `src/cli/resources/groups.ts` (645) | agent-to-agent (`af70f6683`), scheduling (`c6670bd58`) | **cli-resources** |
| `src/cli/resources/tasks.ts` (803) | scheduling (`c6670bd58`) | **cli-resources** |
| `src/cli/resources/messaging-groups.ts` (4) | permissions (`31be7e2b1`) | **cli-resources** (decision is permissions') |
| `src/modules/agent-to-agent/create-agent.ts` (306) / `.test.ts` (673) | cli-resources (`92a3518b7`) | **agent-to-agent** |
| `src/modules/permissions/channel-approval.ts` (293) / `.test.ts` (713) | cli-resources (`92a3518b7`) | **permissions** |
| `src/host-sweep.ts` (1507) | scheduling (the recurrence call site) | **host-sweep** |
| `src/channels/adapter.ts` (241) | permissions, cli-resources | **channels theme (owned elsewhere)** — must land before permissions and before the wirings half of cli-resources |

### 0.5 Migrations

Seam 3 PR 2 owns the entire ledger reconciliation; no theme here adds one. Permissions must not import upstream `021-approval-question` (fork 045 is its superset). cli-resources inherits `messaging_groups.detached_at` from fork 070 with no writer; adopting a behavior for it is out of scope.

---

## Theme 1: host-sweep

### Outcome

The fork's tick is unchanged in shape and cost, and gains one thing: a mail write now wakes its session within a queue turn instead of waiting for the next 60-second beat. Everything fork-specific stays — the duty registry, the seven phases, the exclusive `session:health` chain, the shared `SweepTickContext`, the persisted quiet cache, and the per-session yield.

### Files

| Path | Upstream since base | Fork commits | Diff | Disposition |
|---|---|---|---|---|
| `src/host-sweep.ts` | 12 — `d6545e89d`, `928ca0449`, `0eb51b76f` | 123 | 1507 | **UPSTREAM-SEAM+OUR-BODY** |
| `src/session-manager.ts` | — (`d6545e89d`, 5 lines) | many | in manifest | **UPSTREAM-SEAM+OUR-BODY** — one import, one call |
| `src/host-sweep.test.ts` | 5 | 70 | 1196 | KEEP-FORK |
| `src/host-sweep-grace.test.ts` | 5 — `692a0b603` | 0 | 212 (deleted) | RESTORE after seam 4 A′ |
| `src/host-lifecycle.test.ts` | 1 | 4 | 48 | KEEP-FORK (seam 2 `UNPORTABLE_UPSTREAM_FILES`) |
| `src/reconcile-feeds.ts` | — | — | 34 (absent) | ADOPT-UPSTREAM verbatim |
| `src/reconcile.ts` / `reconcile-queue.ts` | — | — | 51 / 172 (absent) | **ADOPT-UPSTREAM, code verbatim, contract comments corrected** |
| `src/reconcile-session.ts` | — | — | 340 (absent) | UPSTREAM-SEAM+OUR-BODY |
| `src/reconcile-queue.test.ts` | — | — | 196 (absent) | **ADOPT-UPSTREAM** — the unit suite that actually pins the queue |
| `src/reconcile-feeds.test.ts` | — | — | 31 (absent) | ADOPT-UPSTREAM |
| `src/session-manager.feeds.test.ts` | — | — | 82 (absent) | ADOPT-UPSTREAM (the producer's test) |
| `src/host-sweep.queue.test.ts` | — | — | 113 (absent) | **REPLACE with fork integration cases** — see (i) |
| `src/host-sweep.feeds.test.ts` | — | — | 148 (absent) | **SPLIT** — PR 3 vs seam 4 E |
| `src/modules/sweep-*/` (46), `src/modules/sweep-engine/` (new) | — | many | — | FORK-ONLY |

### Port strategy — the simplification

r2 proposed routing the periodic tick's cohort through upstream's queue behind a "cohort barrier". That is withdrawn. `ReconcileQueue` exposes only `add`, `addAfter` and `shutdown` (`upstream/main:reconcile-queue.ts:70,88,110`) plus a **global** `idle()` (`:105`); there is no keyed generation or completion token to build a cohort barrier from, and coalescing (`:74`, `:148`) means a cohort add can merge into an already-running event reconcile, so no external barrier can say which execution satisfied it. Building a ticketed wrapper would be a new concurrency primitive on the host's only periodic control path, to buy nothing the fork's serial loop does not already give.

**(a) The periodic tick stays exactly as it is today.** `sweepOnce` keeps its cohort — one `getActiveSessions()` at tick start (`host-sweep.ts:994`) — its serial `for (const session of sessions)` loop, the quiet skip at `:1021`, session-major W1–W5 inside `sweepSession`, the exclusive `session:health` chain, and `await sweepYield()` after **every** session (`:1060`, the `setImmediate` macrotask yield whose comment records that a 10-session batch between yields was one contiguous ~15 s event-loop freeze). The tick enqueues nothing.

**(b) The one adopted tick change: the re-arm.** Take upstream's idle-gated re-arm semantics on the fork's own loop — re-arm 60 s after the tick's own drain rather than on a fixed interval — keeping the re-arm **outside** the try, which is seam-2 constraint 6 and the 2026-08-06 silent-total-failure guard that `src/host-sweep-reschedule.test.ts` pins. That test carries over unchanged and is the acceptance for this half.

**(c) `reconcile-queue.ts` and `reconcile-feeds.ts` are adopted code-verbatim — with corrected header comments — and drive event reconciles only.** Upstream `reconcile-queue.ts:13-21` says the queue replaces the sweep loop and that `idle()` ends each tick; both statements are false in the fork and PR 2 rewrites that comment block (the code below it is unchanged), so the file's ratchet forecast is a small nonzero residue, not zero. An enqueue runs `reconcileSession(sessionId)`, which runs `session:plan` → `session:wake` → `session:health` → `session:tail` for that one session, on a context built from a fresh `getSession()`. It never runs a `tick:*` phase and never touches `ctx.sessions`. All ticketing stays outside `reconcile-queue.ts`, so the file lands byte-identical.

**(d) The two paths meet at one fork-owned per-session in-flight guard, with a non-spinning deferral contract.** The engine keeps `Map<sessionId, { owner: 'tick' | 'event'; eventPending: boolean }>`:

- **An event colliding with a tick-owned session sets `eventPending = true` and returns without calling `queue.add`.** This is the whole point of the marker. Re-enqueuing instead would busy-spin: `add` on a running key sets `dirty`, and the queue immediately re-runs it on completion (`reconcile-queue.ts:74`, `:148`), so while the tick still owns X the event would re-queue and return in a tight loop and starve the event loop. `addAfter` only slows that loop down; it does not end it.
- **The tick's `finally` releases ownership and enqueues exactly once when `eventPending` is set** — including when the tick's `sweepSession(X)` threw. Release and enqueue are in the `finally`, not the success path, so a duty failure cannot strand a pending event until the next beat.
- **The tick, before entering X, skips X if an event reconcile owns it** — the same `continue` shape the quiet skip already uses at `:1023` — and leaves X for the next tick.
- **An event reconcile that fails releases ownership and propagates**, so the queue applies its normal per-key backoff (`reconcile-queue.ts:149`) rather than the engine inventing a retry policy.
- Net effect: **an event reconcile never interleaves within a session**, a session is never swept twice concurrently, and no collision path re-enters the queue while the collision still holds.

**(e) Which seam-2 §4.3 constraints this preserves, and how.**

| Constraint | Held by |
|---|---|
| 1 and 15 — the `tick:post-session` duties run after the fan-out so container state is current (`host-sweep.ts:970`, `:987`) | Trivially: the tick is unchanged and does not enqueue its periodic cohort (its `finally` enqueues only deferred event work, §(d)), so its fan-out still completes before `tick:post-session`. |
| 4 — T19 and T22 reuse T3's `sessions` array; no duty calls `getActiveSessions()` (`:1054`, `:1090`) | The one scan stays in the tick. The event path resolves a single session by id and never reads `ctx.sessions`. |
| 3 and 7 — ordering within `tick:housekeeping` and within `session:plan` | Untouched; both live inside the phases the registry already orders. |
| 6 — the re-arm is outside the try | Preserved by (b); `host-sweep-reschedule.test.ts` unchanged. |
| §4.4's per-session yield | Stays exactly where it is, in the outer serial loop (`:1060`). |
| The exclusive `session:health` chain | Lives inside `sweepSession`, shared by both paths. |

**Correction to r2:** the `ctx.sessions` getter at `host-sweep.ts:982` rejects a read *before the tick's own scan* ("tick:pre-session runs before it"), not a read outside a tick, and `_sweepSessionForTesting` lazily calls `getActiveSessions()` itself. So the getter is not what keeps the event path off the cohort; the in-flight guard and the event path's own single-session resolution are.

**(f) The engine extraction still comes first (PR 1).** The registry runners are private in `host-sweep.ts` — `runTickPhase` (`:596`), `sweepSession`, the `SweepTickContext` builder (`:978`) — and **41 files import from `./host-sweep.js`**. PR 1 moves them plus the ~30 exported registry symbols into `src/modules/sweep-engine/` and re-exports every one from `host-sweep.ts`, so all 41 keep compiling unchanged.

**(i) The queue's test set, and the two contract comments that must change.** Upstream's `host-sweep.queue.test.ts` asserts the architecture this revision rejects: its header says "each tick enqueues the singleton duties and every active session", and its first case asserts `reconcileSession` was called once per active session per tick with the order `['egress', 'session:s-1', 'session:s-2', 'approvals']` (`:80-92`). Under the fork's unchanged serial tick that call never happens, so the file cannot pass verbatim and cannot reach ratchet zero. **It is replaced by a fork-owned integration suite** covering the two properties that are actually true here: enqueues are event-only, and the periodic loop is unchanged. Its ratchet entry stays **nonzero**.

The suite that does pin the adopted queue is upstream's `reconcile-queue.test.ts` (196 lines, absent in the fork); it lands with the queue and is the conformance gate for coalescing, `addAfter`, per-key backoff and `idle()`.

Two upstream contract comments become false under this design and are corrected in the same PR, so the files land with verbatim **code** and honest prose: `reconcile.ts:5-11` says the 60 s sweep "becomes per-key reconciliation" driven by the workqueue, and `host-sweep.ts`'s own header ties the re-arm to `tickQueue.idle()`. In the fork the queue does **not** replace the periodic loop, and `idle()` does **not** gate the tick. Forecast their **measured residue**, not zero.

**(g) The feeds split.** `src/host-sweep.feeds.test.ts` imports `./drivers/index.js` and `./drivers/types.js` (`:22-23`) and holds five runtime-watch cases (`:79`, `:91`, `:101`, `:106`, `:120`) plus one explicit-enqueue case (`:141`); the fork has no `src/drivers/`. **PR 3** lands `reconcile-feeds.ts`, upstream's `reconcile-feeds.test.ts` (no driver import), the producer edit in `src/session-manager.ts`, and the explicit-enqueue case re-homed fork-side. `armRuntimeWatch` and the five runtime cases land **with seam 4 E**. A missing driver returns **silently** (`host-sweep.ts:53-54`); only a thrown subscription warns (`:64`).

**(h) The producer, and the corrected quiet-mark composition.** Upstream `d6545e89d` adds to `session-manager.ts` one import and one `enqueueSessionReconcile(sessionId)` placed immediately after the successful `await updateSession(...)` (`upstream/main:session-manager.ts:317`). The fork's twin site is `origin/main:session-manager.ts:1166`. Enqueue there and nowhere else.

r2's quiet analysis was wrong on three counts, corrected here:

- **`withQuietInvalidationSync` is not the only invalidator.** `updateSession` clears `sweep_quiet_until` in the **same statement** whenever `last_active` moves (`db/sessions.ts:211`), and the comment at `:206-210` names exactly two writers and warns that "a future raw-SQL writer would silently reintroduce a mark that outlives a newly due row".
- **So the mark is already NULL when the event arrives.** The producer's `updateSession` runs before the enqueue, so there is nothing live to clear. **No new central-column writer is added** — that would be the third writer the source explicitly warns against.
- **The in-memory entry is a belt, not a requirement.** On event delivery the engine deletes that session's `quietSessions` entry, which is already redundant: the tick's skip predicate compares `mark.lastActive === session.last_active` (`:1021`) and fails once `last_active` has moved.
- **The call-site count was wrong.** `withQuietInvalidationSync` has **14 production call expressions across 8 files** (`cli/resources/tasks.ts` 5, `dashboard/api/scheduled-mutations.ts` 2, `modules/scheduling/recurrence.ts` 2, and one each in `dashboard/api/scheduled-move.ts`, `dashboard/thread-close.ts`, `db/scheduled-tasks.ts`, `modules/scheduling/create.ts`, `modules/sweep-scheduled-move/index.ts`), not 23 across 23. Seam 3 §4.5 says 12; that count is also stale and the seam-3 owner should re-measure.
- **The pending quiet-flush race is already handled and must stay handled.** The tick collects `newQuietMarks` during the fan-out and flushes after it, carrying each mark's `lastActive` basis precisely because "ingress during one of the yields below can move `last_active` (and clear the column) in between… the write compares this and no-ops on the rows that moved" (`:1030-1040`). An event mid-fan-out is exactly that ingress. Acceptance case 8.
- **The lost-event floor is 60 seconds.** An enqueue with no registered sink is a no-op (`reconcile-feeds.ts`, `if (!enqueue) return;`). The write that produced the event already cleared the mark, so the session is in the next tick's cohort and is not held behind the 30-minute quiet backoff. Acceptance case 9.

### Sequencing / dependencies

Seam 3 through PR 6 (its PR 5b converts the sweep). Seam 4 **A and A′ deployed** before any claim-derived behavior — `reconcile-session.ts:34` imports `getSessionClaim` and feeds it into the heartbeat gate and claim re-basing (`:237-249`), and upstream's own rule (`db/coordination.ts:5-7`) is that nothing may change behavior on a read from those tables. Runtime watch waits on seam 4 E. **Three PRs**: (1) engine extraction, inert; (2) the re-arm change; (3) queue + feeds + producer + in-flight guard.

### Drift + gates

`src/host-sweep-registry.test.ts` F-14.2 (the registry table) and F-14.1 (`toBeLessThanOrEqual(1450)` at `:1450`) are the pins; **F-14.1 is re-measured and lowered**, since PR 1 alone moves the engine out of a **1,424-line** file (`git show origin/main:src/host-sweep.ts | wc -l`; seam 2's plan quotes 1,419, which was its own base). `host-sweep-reschedule.test.ts` carries unchanged.

Forecast: `reconcile-feeds.ts` 34 → **0**, `reconcile-queue.test.ts` 196 → **0**, `reconcile-feeds.test.ts` 31 → **0**, `session-manager.feeds.test.ts` 82 → near 0. `reconcile.ts` 51 and `reconcile-queue.ts` 172 → **small measured residue, not zero** — the code lands verbatim but their contract comments are corrected per (i). `host-sweep.queue.test.ts` 113 → **nonzero**, since it is replaced by a fork integration suite rather than adopted. `host-sweep.ts` 1507 → large SHRINK; `reconcile-session.ts` 340 → nonzero (our body); `session-manager.ts` → near-unchanged (two added lines). Restoring a deleted file is SHRINK when the delta is smaller, so no `--accept` is written in advance; one is added only where a regenerated report prints GROWTH or NEW.

Post-deploy: restart **required**. Evidence: `Host sweep error` still 0; `Host sweep quiet cache warmed` present with a plausible count; at least one session reconciled between ticks from the mail feed. Subtract wake→spawn pairs before calling any per-session timing regression.

### Risks / open decisions

- **The in-flight guard is the whole safety argument.** If it is missing or leaks an entry, an event reconcile can run inside a session the tick is sweeping, and both paths write the same mailbox. Cases 3 and 4 assert it; the `finally` release is the code review's focus.
- **Needs the operator in product terms:** wakes get faster on a session that just received mail; the 60-second beat becomes a floor rather than a fixed drum. Recommend accepting.

### Executable acceptance criteria

1. **PR 1 is inert**: the F-14.2 registry table is byte-identical and a driven tick records the same duty-name sequence as before the extraction.
2. `src/reconcile-queue.test.ts`, `src/reconcile-feeds.test.ts` and `src/session-manager.feeds.test.ts` pass verbatim from upstream; the fork integration suite replacing `host-sweep.queue.test.ts` asserts enqueues are event-only and the periodic loop is unchanged.
3. **Session-major**: session A's W1–W5 plus its yield complete before session B's W1 starts.
4. **An event reconcile never interleaves within a session**: enqueue X while the tick is inside X; assert the event body starts only after the tick's `sweepSession(X)` returns, and that the tick skips X when the event is the one already running.
4b. **No spin under a tick-owned session, on both paths**: with the tick inside X, drive repeated enqueues of X and assert `queue.add` is not called from the collision path, that `eventPending` is set once, and that exactly one event reconcile runs after the tick releases — asserted twice, once where `sweepSession(X)` returns normally and once where it throws.
5. "the exclusive health chain stays exclusive" on both the tick path and the event path.
6. "a throw still re-arms": `host-sweep-reschedule.test.ts`, unchanged, against the idle-gated re-arm.
7. "the mail write enqueues once, after the update": the producer enqueues only on a successful insert-plus-`updateSession`, never on a duplicate-ignored write.
8. **Pending quiet-flush race**: mark session X quiet during the fan-out, deliver a mail event for X before the flush, assert the flush no-ops on X because its `lastActive` basis moved.
9. **Lost-event floor**: with no registered sink, `enqueueSessionReconcile` throws nothing and X is still swept by the next tick.
10. F-14.1 re-measured at a **lower** ceiling with the reason in the comment.

### Residue / unresolved

- Whether the fork's `sweepSession` can be called re-entrantly from the event path with no other change has not been proved by reading every one of its 41 duty bodies; PR 3 must audit the duties that cache per-tick state before relying on it.
- Upstream `a75d5c9d2` (container-start heartbeat fallback) and `d33d327f9` (idle-no-heartbeat exemption) are not dispositioned. The fork appears to cover the no-heartbeat case differently, through the spawn-grace path (`modules/sweep-container-health/index.ts:455-479`), but the two were not diffed case by case.

---

## Theme 2: agent-to-agent

### Outcome

Cross-agent routing runs on upstream's wake seam and async guard shape with every fork hardening intact — writer-side guard re-proof, grant-gated file copy, provenance checks, and the destination projection's TOCTOU guard. Agents gain `suppressCreatedNotify`.

### Files

| Path | Upstream since base | Fork commits | Diff | Disposition |
|---|---|---|---|---|
| `agent-route.ts` | 3 | 26 | 571 | UPSTREAM-SEAM+OUR-BODY |
| `agent-route.test.ts` | 2 | 18 | 505 | KEEP-FORK |
| `create-agent.ts` | 4 — `af70f6683`, `92a3518b7`, `c417d6af6` | 14 | 306 | UPSTREAM-SEAM+OUR-BODY |
| `create-agent.test.ts` | 3 | 13 | 673 | KEEP-FORK |
| `message-gate.test.ts` | 3 | 4 | 176 | KEEP-FORK |
| `write-destinations.ts` | 2 | 3 | 81 | **UPSTREAM-SEAM+OUR-BODY** |
| `create-agent.notify.test.ts` | — | — | 85 (absent) | ADOPT-UPSTREAM |
| `index.ts` / `guard.ts` / `db/agent-destinations.ts` / `db/agent-message-policies.ts` | — | — | 21 / 12 / 105 / 46 | Adjacent shrink |
| `agent-route-parity.test.ts`, `write-destinations.test.ts` | — | — | — | FORK-ONLY |

### Port strategy

The fork's `agent-route.ts` exposes upstream's surface with three fork-only guards layered in: `targetWiredToMessagingGroup` (defined `:363`, called `:340`, `:523`, `:669`) and the provenance reasoning at `:208` and `:281`. Upstream's delta reduces to `guard(...)` → `await guard(...)` (seam 3) and `wakeContainer` → `requestWake` (T0).

**`write-destinations.ts` — the exact nesting.** The fork resolves the destination set *inside* the mailbox callback because the projection is REPLACE-shaped, so a set resolved before a yield "can reinstate a destination an admin revoked in the window", and the guarantee rests on "all three lookups are synchronous, so there is no yield left between the resolution and the write". Upstream resolves first and uses the **provisioning** `withMailboxSession`; the fork uses `withExistingMailboxSession` so a refresh cannot recreate a reclaimed session directory (invariant I-10). Seam 3 breaks the synchronous premise, because `getDestinations`, `getMessagingGroup` and `getAgentGroup` all become async. The re-proof:

```
withExistingMailboxSession(agentGroupId, sessionId, (mailbox) =>
  withCentralSync(() =>
    withRawDb((db) => {
      // resolve every destination synchronously off the raw handle
      // then, with no await in between:
      mailbox.replaceDestinationRows(resolved);
    })))
```

`withCentralSync` and `withRawDb` are seam 3 PR 6 primitives and do not exist in this snapshot — that dependency is real and is why this theme waits for PR 6. Seam 3's owner has accepted the allowlist entry (§4.5 I-1) with one rule that binds this port: an allowlisted sync block executes the leaves' exported SQL constants through `withRawDb` directly — it never calls an async leaf export and never receives a `*Sync` twin of one — so when seam-3 PR 4 makes agent-groups/messaging-groups async, `resolve()` stays on the raw handle rather than awaiting `getAgentGroup`/`getMessagingGroup`. **`write-destinations.ts` must be added to seam 3 §4.5's exact terminal `withRawDb` allowlist**; it is absent there today, so without that edit this fails the PR 6 ratchet. The edit is listed in §0.2 and is the seam-3 owner's to accept. Extend seam 3's `central-lease.test.ts` AST gate to cover this site: no `await` between the last central lookup and `replaceDestinationRows`. Existing-only mailbox semantics stay.

Adopt `CreateAgentOptions.suppressCreatedNotify` (`upstream/main:create-agent.ts:87,201`) and its test verbatim, and the folder-reuse half of `92a3518b7` (needs T0b).

`src/db/migrations/module-agent-to-agent-destinations.ts` exists under the same name on both sides and is not in the conflict list — diff it before assuming it is untouched.

### Sequencing / dependencies

After T0, T0b and seam 3 **through PR 6**, and after the §0.2 allowlist edit is accepted. First theme executed. **One PR.**

### Drift + gates

`agent-route-parity.test.ts`, `message-gate.test.ts` and `write-destinations.test.ts` are the pins. Forecast: `create-agent.notify.test.ts` 85 → **0**; `index.ts` 21 and `guard.ts` 12 → near 0; `db/agent-destinations.ts` 105 and `db/agent-message-policies.ts` 46 → nonzero; `write-destinations.ts` 81 → **nonzero** (the `DestinationRow` snake-case shape, `replaceDestinationRows`, existing-only semantics, the lease nesting); `agent-route.ts` 571 and `create-agent.ts` 306 shrink by the seam hunks and stay well above zero.

Post-deploy: restart required. Evidence: one agent-to-agent message routed end to end; a refused cross-group send with its guard decision in the log.

### Executable acceptance criteria

1. "every wake goes through `requestWake`": zero direct `wakeContainer` imports under `src/modules/agent-to-agent/`.
2. "a revoked destination is not reinstated": revoke between the caller's discovery and the write; assert the written map omits it.
3. "no await between the last central lookup and the projection write": the extended AST gate.
4. "the projection never provisions": call it for a session with no mailbox; assert no directory is created.
5. "a send to a group not wired to the caller's messaging group is refused".
6. "provenance that cannot be established does not grant": the `?? false` regression stays red-on-revert.
7. "suppressCreatedNotify silences the success notify but not the collision error".
8. `agent-route-parity.test.ts` passes unchanged.

### Residue / unresolved

- If the seam-3 owner **declines** the allowlist edit, this theme has no grounded fallback. The alternative — revalidating each destination writer-side after the awaits — was not designed here and would need its own review.

---

## Theme 3: cli-resources

### Outcome

`ncl` runs on upstream's wake seam and its MCP primitives. Operators gain remote Streamable HTTP MCP servers (`--url` / `--headers`), MCP server-name validation, a plugin-owner guard that refuses direct edits to a plugin-stamped server, a refusal to create a group over an undisposed folder, and adapter-declared session-mode defaults on wiring creation. The fork-only resources and the `container.json`-plus-DB dual write are untouched.

### Files

| Path | Upstream since base | Fork commits | Diff | Disposition |
|---|---|---|---|---|
| `groups.ts` | 14 | 24 | 645 | **UPSTREAM-SEAM+OUR-BODY, selective** |
| `groups.test.ts` | 4 — `0f3aac028`, `99cc8662c` | 18 | 616 | KEEP-FORK + adopt upstream's non-restamp cases |
| `tasks.ts` | 6 | 24 | 803 | UPSTREAM-SEAM+OUR-BODY |
| `tasks.test.ts` | 4 | 24 | 1421 | KEEP-FORK |
| `wirings.ts` | 4 — `c9d47f5a7`, `1541f59d4` | 9 | 124 | UPSTREAM-SEAM+OUR-BODY |
| `messaging-groups.ts` | 2 | 1 | 4 | **KEEP-FORK help text** |
| `destinations.test.ts` | 2 | 5 | 34 | **KEEP-FORK** — its unique tmp root is deliberate |
| `programmatic-wiring.test.ts` | 2 | 2 | 118 | KEEP-FORK |
| `wirings.test.ts` / `messaging-groups.test.ts` | — | — | 215 / 35 | Adjacent shrink |
| `groups-create-folder-reuse.test.ts` / `groups-restart-rebuild.test.ts` | — | — | 123 / 111 (absent) | ADOPT-UPSTREAM |
| `groups-plugin-guard.test.ts` | — | — | 160 (absent) | **DEFER to the templates theme**; re-derive its three guard cases fork-side |
| `denied-models.ts`, `repositories.ts`, `usage.ts` | — | — | — | FORK-ONLY |

### Port strategy — a selective façade

Upstream's `groups.ts` imports six symbols absent from the fork. T0b supplies four of them (the folder probe and the three parsers). The other two defer:

- **`getSessionDriver` → seam 4 E.** The session-lifecycle driver seam (`a951e74b7`) is not taken here; its hunk stays on the fork's existing lifecycle calls, recorded in the PR body as a dated gap.
- **`templates/restamp.ts` → the templates theme (§0.3).** Every restamp-related hunk in `groups.ts` — the `create --template` folding, the in-place plugin update, `--new`/`--id` arbitration — defers with it.

What this theme does take: upstream's `config add-mcp-server` argument surface including `--url`/`--headers` (`upstream/main:groups.ts:429,450`), `validateMcpServerName`, and the `mcpServerPluginOwner` refusal (`:439-447`) — re-registered onto the fork's body, which writes **both** `container.json` and `container_configs` (`origin/main:groups.ts:551-562`). Upstream's single `updateContainerConfigJson` call is not a valid adoption: the spawn path reads the file, not the DB.

**The empty-`--prompt` refusal is a fifth duplicate, not an upstream gain.** The fork already rejects an empty or whitespace-only prompt on update at `tasks.ts:538` (commit `c7c4edf2a`), with the reasoning at `:531-537` and cases in `tasks.test.ts`. Keep the fork's implementation on the async seam with its fan-out, quiet-invalidation and audit brackets; delete upstream's `afafd318b` hunk.

In `wirings.ts`, adopt `c9d47f5a7`'s adapter-declared session-mode defaults and `1541f59d4`'s engagement consistency; both need declarations in `src/channels/adapter.ts`, owned by the channels theme.

`messaging-groups.ts` is four lines. **Keep the fork's help text**: it states the DM-only degradation ("degrades to 'strict' on a group", `:58`), which is accurate for the fork and which upstream's text omits.

### Sequencing / dependencies

After T0, T0b and seam 3 through PR 6. The wirings half waits on the channels theme. Unblocks scheduling. **Two PRs**: (1) `groups.ts` + `tasks.ts` + tests; (2) `wirings.ts`, `messaging-groups.ts` and the two adopted test files.

### Drift + gates

`tasks.test.ts` (1421) and `groups.test.ts` (616) stay fork-owned. Seam 3's `wirings.test.ts` companion-rollback case must stay green. Forecast: `groups-create-folder-reuse.test.ts` 123 and `groups-restart-rebuild.test.ts` 111 → **0**; `wirings.test.ts` 215 and `messaging-groups.test.ts` 35 → nonzero; `messaging-groups.ts` 4 → **nonzero** (the DM-only sentence); `destinations.test.ts` 34 → **nonzero** — zeroing it means replacing its unique temporary root with upstream's shared fixed `/tmp` path, reintroducing cross-suite collisions the fork already paid to remove; `groups.ts` 645 and `tasks.ts` 803 shrink and stay nonzero (dual write, quiet-mark and `last_active` brackets, the two deferred hunks).

Post-deploy: restart required. Evidence: `ncl groups config add-mcp-server --url …` creates a remote server a respawned container can reach; `ncl tasks update --prompt ""` is refused.

### Risks / open decisions

- **`groups.ts` is where the dual-write invariant can silently die.** A structural test asserting both writers ships with this PR.
- **Needs the operator in product terms:** remote MCP servers over `--url` let an agent's tool surface reach a declared network endpoint. Recommend taking it, gated behind the existing `access: 'approval'` on `config add-mcp-server`.

### Executable acceptance criteria

1. "`config add-mcp-server --url` round-trips" into both `container.json` and `container_configs.mcp_servers`.
2. "a plugin-owned MCP server refuses a direct edit", and "an unmarked server stays fully editable" (re-derived from upstream `:76,87,94`).
3. "an invalid MCP server name is rejected", including `__proto__`.
4. "group creation refuses an undisposed folder", including the dangling-symlink case `lstat` catches.
5. "`tasks update --prompt ''` is refused" — the fork's existing case, unchanged.
6. "wiring creation takes the adapter's declared session mode"; an explicit override wins.
7. "the config dual write holds": structural test over every `config update` path.
8. `wirings.test.ts` companion-rollback passes unchanged.

### Residue / unresolved

- `f8563abe1` is a `feat!` that folds restamp into `groups create --template`. Whether the fork wants that fold at all is a product question for the templates theme, not a port decision, and it is unanswered.

---

## Theme 4: scheduling

### Outcome

Recurrence, task creation and the run log sit on upstream's file shapes with the fork's superset behavior intact: per-group timezone anchoring, script-failure auto-pause with backoff, quiet-cache invalidation, and a configurable pre-task-script timeout. No scheduling behavior changes.

### Files

| Path | Upstream since base | Fork commits | Diff | Disposition |
|---|---|---|---|---|
| `src/modules/scheduling/recurrence.ts` | 4 | 9 | 151 | **KEEP-FORK** (strict superset) |
| `src/modules/scheduling/recurrence.test.ts` | 3 | 11 | 166 | KEEP-FORK |
| `src/modules/scheduling/create.ts` | 4 | 6 | 111 | **UPSTREAM-SEAM+OUR-BODY — the `taskNameSlug` hunk only** |
| `src/modules/scheduling/run-log.ts` | 3 | 1 | 15 | ADOPT-UPSTREAM |
| `src/modules/scheduling/task-content.ts` | — | — | 20 (absent) | ADOPT-UPSTREAM verbatim |
| `container/agent-runner/src/scheduling/task-script.ts` | 2 — `571d81d01` | 12 | 168 | **KEEP-FORK, DROP-UPSTREAM-DUPLICATE** |
| `container/agent-runner/src/scheduling/task-script.test.ts` | 2 | 8 | 294 | KEEP-FORK |

### Port strategy

**`create.ts` carries the task-slug hunk, nothing more.** Upstream's addition is `taskNameSlug` (`upstream/main:create.ts:36-39`), whose comment says it is exposed for template restamping. The plugin guard and the restamp implementation live in `groups.ts`, `container-config.ts` and `templates/*` — none of which scheduling owns. **Scheduling is the single owner of `taskNameSlug` and `task-content.ts`**, and both must land before the templates theme can compile `restamp.ts`.

**The atomic re-arm is already in the fork.** Upstream `0eb51b76f` made recurrence re-arm one durable step via `inDb.armNextTask`; the fork ships the same primitive through the mailbox seam (`src/mailbox/sqlite/index.ts`, `src/mailbox/types.ts`, `src/modules/mailbox/ops/tasks.ts`, pinned by `arm-next-task.test.ts`). The delta is the parameter type: upstream takes `InboundMailbox`, the fork takes `NanoclawMailboxSession` (`recurrence.ts:108`) deliberately, because a session parameter keeps the file off the raw-access allowlist (`:105-107`). Keep the fork's signature.

**The timezone override is a duplicate and the fork's is broader** (`resolveGroupTimezone`, `recurrence.ts:17,116`, with the already-armed-occurrence semantics documented in CLAUDE.md). Seam 3 PR 2 already adopts upstream's migration name.

**The pre-task-script timeout copy is a duplicate and the fork's is a superset**: upstream logs at a fixed `SCRIPT_TIMEOUT_MS` (`:22,49`); the fork logs the same plus the remediation, configurable through `scriptTimeoutMs()` / `NANOCLAW_TASK_SCRIPT_TIMEOUT_MS` (`:121,156`). Delete upstream's version.

### Sequencing / dependencies

After cli-resources and seam 3 through PR 6. Blocks the templates theme. **One PR.**

### Drift + gates

`recurrence.test.ts`, the fork's task-script suite and `arm-next-task.test.ts` are the pins. **The agent-runner half is a source-only change**: the runner source is a boot snapshot bind-mounted read-only, and the spawn refusal compares only `container/agent-runner/package.json` + `bun.lock` against the image label (`container-runner.ts:1053-1060`). So this theme needs `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`, `bun run test` from that directory, and a **host restart**. An image rebuild is required only if `package.json` or `bun.lock` changes, which this theme does not touch.

Forecast: `run-log.ts` 15 → **0**, `task-content.ts` 20 → **0**; `create.ts` 111 → lower but nonzero; `recurrence.ts` 151 and the two task-script files stay near current, because their divergence is the retained behavior.

Post-deploy evidence: one recurring task re-arms at its expected local time in the group's timezone; `ncl tasks` shows a `paused` series still resumable.

### Risks / open decisions

- The fork's `handleRecurrence` refuses to arm when the invalidation throws for a closed session (`recurrence.ts:165-175`) — deliberate fail-closed, no upstream equivalent. Keep it.
- Nothing needs the operator.

### Executable acceptance criteria

1. "a cron series re-arms in the group's timezone": `0 9 * * *` under an override arms at 09:00 local.
2. "the armed occurrence keeps its instant across a timezone change"; the *next* re-arm uses the new grid.
3. "a script timeout says so", not `Command failed`.
4. "re-arm is one durable step": kill between insert and clear; no predecessor left recurrence-armed beside a live successor.
5. `parseTaskContent` round-trips a legacy plain-string body to `{prompt: raw, script: null, originSessionId: null}`.
6. `taskNameSlug` is deterministic and matches the id `makeTaskId` produces.

---

## Theme 5: permissions

### Outcome

Approval-card construction gains upstream's `registerChannelCardInterceptor` seam and the module runs on upstream's async DB shape, while every fork authorization behavior survives: workspace-bound sibling identity equivalence in role checks, instance-aware DM resolution, the grant layer, the decline-stamp dedupe, and the dropped-message reason vocabulary. Operators gain a folder-reuse refusal and opt-in privacy-safe DM logging on the sensitive flows.

### Files

| Path | Upstream since base | Fork commits | Diff | Disposition |
|---|---|---|---|---|
| `channel-approval.ts` / `.test.ts` | 10 / 7 | 16 / 18 | 293 / 713 | UPSTREAM-SEAM+OUR-BODY |
| `sender-approval.ts` / `.test.ts` | 6 / 4 | 16 / 11 | 297 / 163 | KEEP-FORK |
| `sender-decline-notify.test.ts` | 5 | 13 | 651 | KEEP-FORK — add/add, one file wins outright |
| `index.ts` | 5 | 25 | 300 | UPSTREAM-SEAM+OUR-BODY |
| `db/pending-sender-approvals.ts` | 3 | 7 | 139 | KEEP-FORK (decline stamps, `:70-80`) |
| `db/pending-channel-approvals.ts` | 2 | 5 | 51 | ADOPT-UPSTREAM where the async conversion allows |
| `db/user-roles.ts` | 1 | 3 | 133 | **UPSTREAM-SEAM+OUR-BODY** |
| `db/agent-group-members.ts` | — | — | 72 | **UPSTREAM-SEAM+OUR-BODY** |
| `guard.ts` | 2 | 1 | 17 | ADOPT-UPSTREAM |
| `permissions.test.ts` | 1 | 8 | 250 | KEEP-FORK |
| `user-dm.ts` | 3 — `1ecb952f4` | 6 | 151 | **UPSTREAM-SEAM+OUR-BODY** |
| `access.ts` / `db/users.ts` / `db/user-dms.ts` | — | — | 42 / 40 / 25 | Adjacent shrink |
| `channel-card-interceptor.test.ts` / `user-dm.test.ts` | — | — | 203 / 157 (absent) | ADOPT-UPSTREAM |
| `grant.ts`, `slack-user-token-gate.ts`, `task-slack-subject.ts` (+tests) | — | — | — | FORK-ONLY |

### Port strategy

**Adopt the interceptor seam; register nothing.** `registerChannelCardInterceptor` takes `(MessagingGroup, InboundEvent) → Promise<ChannelCardDecision>` and decides whether an unknown-channel registration card was handled (`upstream/main:channel-approval.ts:85-89`). The fork's `slack-user-token-gate.ts` is a different boundary: it exports `canUseSlackUserToken` (`:76`) and `isOwnerSafeSlackSession` (`:121`) and synchronously authorizes owner Slack credentials for an existing session at spawn. It has zero `channel-approval` call sites. Land the seam plus `channel-card-interceptor.test.ts` with **no fork registrant**; the only future candidate is a module that owns auto-wire, decline or card suppression (`src/modules/channel-auto-wire/`), and adding one is out of scope. The Slack predicate stays at the spawn/capability boundary.

**`resolveConversation` is already fork-side** (`:260`); reconcile the call sites to upstream's ordering and keep the fork's fallback where its comment at `:298` claims precedence.

**`db/user-roles.ts` and `db/agent-group-members.ts` are not pure async-shape conflicts.** Both route predicates through `equivalentSlackUserIds` (`user-roles.ts:3,11`; `agent-group-members.ts:3,53,63`), enforcing workspace-bound sibling identity equivalence that upstream lacks. Driving either toward zero stops recognizing valid sibling bot identities as owner or admin. Port upstream's async shape, keep the equivalence, keep `src/slack-user-identity.test.ts` green.

**`user-dm.ts` cannot be adopted wholesale.** The fork uses `getChannelAdapter(instance ?? channelType)` deliberately (`:154-157`) where upstream uses `getChannelAdapterExact` (`upstream/main:user-dm.ts:144`), changing named-instance reachability; it exports `resolveUserChannelType` (`:205`) that upstream removed and `modules/approvals/primitive.ts:38,203` calls; and upstream's `privacySafeLogs` is **opt-in, defaulting false** (`:56`), so adopting the file changes no default. Plan: migrate to upstream's options-object signature — seven production call sites (`dashboard/auth/dashboard-token-issue.ts:77`, `modules/approvals/primitive.ts:204,212`, `modules/approvals/reason-capture.ts:86`, `modules/permissions/index.ts:585,628,749`, `storage-pressure-alert.ts:92`) plus the mock assertion at `dashboard/auth/dashboard-token-issue.test.ts:231` — keep `resolveUserChannelType` exported, keep the `getChannelAdapter` fallback with its comment, and pass `privacySafeLogs: true` explicitly at approval delivery and the dashboard token issue.

**decline_notify — one implementation, the fork's.** Both sides shipped it (upstream `31be7e2b1`, fork `c4b2693bd`); the fork's is broader (dropped-message reasons `cli/resources/dropped-messages.ts:8,24`, auto-wire validation `modules/channel-auto-wire/index.ts:73`, the decline-stamp dedupe with both policy-flip cases at `db/pending-sender-approvals.ts:70-80`). Keep upstream's `guard.ts` shape, where the two agree.

**Approval-card scope disclosure — one implementation, the fork's** (upstream `a670f6590`, fork `f25ec05ad`, identical five-file set).

**Folder-reuse refusal (`92a3518b7`) lands here for `channel-approval.ts`**, using T0b's `groupFolderExistsOnDisk`.

### Sequencing / dependencies

After seam 3 through PR 6 and after the channels theme lands `src/channels/adapter.ts`. **Two PRs**: (1) the async/shape reconciliation with every duplicate decided by the rules above; (2) the interceptor seam and its test.

### Drift + gates

`permissions.test.ts`, `sender-decline-notify.test.ts`, `grant.test.ts` and `slack-user-identity.test.ts` are the pins. Forecast: `channel-card-interceptor.test.ts` 203 → **0**, `user-dm.test.ts` 157 → near 0, `guard.ts` 17 → **0**; `db/user-roles.ts` 133, `db/agent-group-members.ts` 72 and `user-dm.ts` 151 → **nonzero and justified**; `sender-approval.ts` 297, `sender-decline-notify.test.ts` 651, `db/pending-sender-approvals.ts` 139 → near current. No `--accept` in advance.

Post-deploy: restart required. Evidence: an approval card on an MPDM-shaped conversation renders the right conversation name; one unknown sender under `decline_notify` gets exactly one decline and the owner one FYI; a sibling bot identity is still recognized as owner.

### Risks / open decisions

- **Highest live risk of the five.** A wrong resolution silently changes who can talk to an agent, or who counts as an owner.
- **Needs the operator in product terms:** privacy-safe logging at the approval and dashboard-token flows means a DM failure there no longer records the handle. Recommend it.

### Executable acceptance criteria

1. "an interceptor can suppress a registration card": register one returning suppress; assert no card is posted.
2. "no fork module registers an interceptor": zero `registerChannelCardInterceptor` call sites outside the seam and its test.
3. **"the Slack credential gate stays at the spawn boundary"**: `slack-user-token-gate.ts` has exactly two production consumer files — `canUseSlackUserToken` imported only by `src/container-runner.ts` (`:4754`), `isOwnerSafeSlackSession` imported by `src/capabilities.ts` (`:31`) and `src/container-runner.ts` (`:4288`).
4. "a sibling bot identity is recognized as owner" through `equivalentSlackUserIds`.
5. "a named instance still resolves its DM" through the `getChannelAdapter` fallback.
6. "`resolveUserChannelType` still gates approver reachability" in `primitive.ts`'s same-channel-type filter.
7. "privacy-safe logs omit the handle where requested, and only there".
8. "decline_notify declines once", and "a policy flip does not resurrect a decline".
9. "the approval card discloses shared scope" for a group serving more than one messaging group.
10. "group creation refuses an undisposed folder", including the dangling-symlink case.

### Residue / unresolved

- Upstream `d66ee1135` (preserve resolved card content) also touches `db/sessions.ts`, `chat-sdk-bridge.ts` and migration 021. Its permissions-side hunk is in scope here; the rest belongs to the channels theme and to seam 3 PR 2, and the three were not reconciled against each other.
