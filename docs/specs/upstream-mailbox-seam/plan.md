# Plan: Upstream agent-mailbox seam (convergence seam 1 of 9)

Status: approved (revision 2, after one Codex correction batch; see run.md)
Approval state: approved by the operator 2026-09-02, relayed by the orchestrating session `update-nanoclaw`. Q1 = 11 single quiet-hour restarts, one PR per restart, never paired. Q2 = both public upstream asks approved under the operator's identity; each is mentioned in the report when posted.
Primary runtime: Claude (orchestrator: Fable 5.1; builders: worker tiers per PR)
Program: upstream convergence, seam 1 (`groups/_ops/upstream-rebaseline-2026-09/`, memory `project_upstream_convergence_program`)
Upstream target: `nanocoai/nanoclaw` `5c3082a1` (2.3.0, 2026-09-01). Merge-base with the fork: `641963c1`.
Executable acceptance criteria: **required** — this is behavior-preserving refactoring of a live IO path; every PR carries the named cases in §8.

## 1. Outcome

After this series, every read or write of a session's `inbound.db`/`outbound.db` on the host and in the agent-runner goes through upstream's `AgentMailbox` seam, and the fork's session-DB customizations (fence, recall pairing, work continuation, done proposals, sticky settings, usage tables, provider health, tiered container state, pending-delivery rows) live in **one fork module per tree** registered through upstream's singular composition slot. Upstream's seam files are byte-identical to `5c3082a1` and a test fails if anyone patches them or re-introduces raw session-DB access elsewhere.

What the operator sees: nothing changes in agent behavior. What changes for the program: ~6k lines of core patches (host `src/db/session-db.ts` 1,123 L, runner `db/{connection,messages-in,session-state,session-routing}.ts` 1,745 L, plus the raw helpers in `session-manager.ts`) stop being merge conflicts, and the next `/update-nanoclaw` sees upstream's mailbox files unchanged.

## 2. Scope and non-goals

In scope (the four steps the program defines for every seam):

1. **Port** upstream's seam verbatim: host `src/mailbox/**`, runner `container/agent-runner/src/mailbox/**`, runner `modules/index.ts` barrel, `heartbeat.ts`, `db/container-state.ts`, the `withMailboxSession` family in `session-manager.ts`, the spawn-path mailbox calls in `container-runner.ts`, upstream's two-argument `DeliveryActionHandler(content, session)` contract, `docs/agent-mailbox-seam-migration.md`.
2. **Re-home** the fork's session-DB code behind it as `NanoclawAgentMailbox extends SqliteAgentMailbox` (host and runner), with a narrowed `session()`/`operations` type carrying the fork ops.
3. **Delete** the raw layer: `src/db/session-db.ts`, the fork's raw openers in `session-manager.ts`, the runner's four raw `db/*` files (replaced by upstream's thin compat shims), the `inDb` handle that delivery passes to action handlers, and every direct `inbound.db`/`outbound.db` open outside the module.
4. **Drift test**: a manifest test that fails when a ported upstream file differs from `5c3082a1`, and a ratchet test that fails when a file outside the module touches the raw layer or receives a session handle.

Plus two enablers:

- **Runner source activation at host restart (PR 0).** Today the runner source is bind-mounted straight from the live checkout, so `git pull` changes what the *next spawn* loads before the host restarts, non-atomically, for every group. This series rewires ~30 runner files at once, so that window must close first: the host snapshots `container/agent-runner/src` at boot and mounts the snapshot (§4.7). Runner code then activates exactly at host restart, rollback is one restart, and "QA seat first" becomes literally true.
- The one runner lifecycle seam the storage seam cannot express: `registerAdmissionGate` (provider-idle boundary), fixed for the refuter's nits, planned as an upstream contribution.

Non-goals (owed to later seams, listed so nobody "helpfully" pulls them in):

- The poll-loop re-derivation: the 7 mid-turn barrier observers in `poll-loop.ts`, work-continuation launch hooks, retry classification, per-turn model/effort, the end-and-reopen wrap-nudge defect (spike-verification.md, poll-loop correction #2). This series only re-routes `poll-loop.ts`'s **storage** calls; its lifecycle logic is untouched.
- Host-sweep singleton duties → `onHostStart` timers (seam 2). `host-sweep.ts` keeps its structure; only its session-DB calls move.
- Central-DB migrations, the migration-name ledger, `resolveSession`, the `sessions` partial UNIQUE indexes — **not touched**. This series adds zero central migrations and does not change session resolution, so no index rebuild step is needed (critic B2 stays dormant).
- Container adoption on restart, sidecar `nanoclaw.json`, driver seam, credential lane (#3701).
- Any change to the fork's policy decisions (engage rules, per-thread sessions, top-level orphan delivery). They are not in this path.

## 3. Current architecture (source evidence)

Fork, `HEAD` (2026-09-02):

- `src/db/session-db.ts` (1,123 L): 38 exports. 11 are byte-equivalent to upstream ops (`replaceDestinations`, `nextEvenSeq`, `markMessageFailed`, `retryWithBackoff`, `getMessageForRetry`, `getProcessingClaims`, `deleteOrphanProcessingClaims`, `getDueOutboundMessages`, `getDeliveredIds`, `getInboundSourceSessionId`, `getMostRecentPeerSourceSessionId`). 12 decorate an upstream op (`openInboundDb` adds `SessionDbMissingError`, the storage-activity marker and `fileMustExist`; `openOutboundDb` adds hot-journal recovery; `countDueMessages` adds `repo_fence_epoch IS NULL`; `markDelivered`/`markDeliveryFailed` are UPSERTs with an `error` column where upstream is `INSERT OR IGNORE`; `getContainerState` is a 4-tier column read with ~15 provider-health/memory fields; `migrateMessagesInTable` also creates `repo_ingress_fence`, 4 guard triggers and `idx_messages_in_series_seq`). 15 are fork-only (the 8-export fence subsystem, `insertMessageIfNew`, the three `*WithContext*` inserts, `getNextFutureProcessAfter`, `expireStalePending`, `getDueWakePriority`, `markPending`, `readSessionRouting`, `sessionInboundHasMessage`, `recoverHotJournal`, `migrateSessionRoutingTable`). Fork-only on-disk shape: table `repo_ingress_fence`; columns `messages_in.repo_fence_epoch/.repo_fence_original_trigger`, `session_routing.spawn_task_id/.session_id`, `delivered.error`, `container_state.provider_executing` (+ provider/memory fields); the 4 triggers; index `idx_messages_in_series_seq`.
- 23 non-test host files import it (`src/host-sweep.ts` 13 symbols, `src/session-manager.ts` 10, `src/container-restart.ts` 9, `src/delivery.ts` 5, 19 others 1–3 each). No other host file opens a session DB directly.
- `src/session-manager.ts` (1,821 L) exposes raw `openInboundDb`/`withInboundDb`/`openOutboundDb`/`openOutboundDbRw`/`writeOutboundDirect` as per-call open/close helpers. There is **no** nesting guard and no provision-vs-exists distinction.
- `src/delivery.ts:1405-1409`: the fork's `DeliveryActionHandler(content, session, inDb)` hands the open inbound handle to every registered action handler (upstream's is two-argument, `delivery.ts:570` @5c3082a1, and upstream dropped `inDb` precisely because of the nesting rule). 15 non-test files receive `inDb`; 4 execute SQL on it (`modules/repository-workspaces/index.ts`, `modules/scheduling/host-script.ts`, `modules/scheduling/recurrence.ts`, `dashboard/api/scheduled-assembly.ts`), the rest pass it to `markDelivered`/`markDeliveryFailed`/`markPending`. At least one handler writes to the **same** session it is delivering for (`modules/orchestrator-dispatch/cancellation.ts:84-99` notifies the parent via `writeSessionMessage` inside a try/catch that swallows failures).
- Runner source mount: `src/container-runner.ts:2155-2156` mounts `<checkout>/container/agent-runner/src` read-only at `/app/src`. Nothing snapshots it; the image carries only `package.json`/`bun.lock` deps.
- `src/container-restart.ts` (540 L): upstream's file exports only `restartAgentGroupContainers`; the fork adds the repository-mount barrier engine (7 exports + 8 internals, ~420 L). Its callers are fork-owned files only (`cli/resources/repositories.ts`, `modules/repository-workspaces/index.ts`, `repo-fence-recovery.ts`) — it is module orchestration over session-DB primitives, not a core patch.
- Runner `db/connection.ts` (581 L), `db/messages-in.ts` (570 L), `db/session-state.ts` (511 L), `db/session-routing.ts` (83 L): raw `bun:sqlite` at `/workspace/inbound.db` (RO, fresh open per poll, `busy_timeout` → `mmap_size=0`) and `/workspace/outbound.db` (RW singleton, `busy_timeout` → `journal_mode=DELETE` → `foreign_keys=ON`). 25 non-test callers; `poll-loop.ts` has ~35 call sites, of which 8 are inside the active provider stream.
- Test surface: 24 host test files (≈21k L) and 22 runner test files (≈10k L) import or `vi.mock` these modules. Many mock by import path — every caller batch must update the mocks it invalidates.

Upstream `5c3082a1`:

- Host `src/mailbox/{index,types,model,compose}.ts` + `sqlite/{index,paths,schema,session-db,tasks}.ts` (≈2.7k L incl. tests). `AgentMailbox` = `exists/prepare/destroy/runnerContext/runnerEnvironment/session`. `session()` opens per call, runs `migrateMessagesInTable` + (if a `delivered` table exists) `migrateDeliveredTable` once per process per path, and hands the action `{...wrapSqliteInbound(inbound), ...wrapSqliteOutbound(...)}`. `migrated` is `private`. PRAGMA order in the openers: `journal_mode=DELETE` → `busy_timeout=5000` (same as the fork).
- `session-manager.ts`: `withMailboxSession` (provisions via `prepare`), `withExistingMailboxSession` (returns `undefined` when `exists()` is false), an `AsyncLocalStorage` guard that **throws on same-key nesting**, `writeOutboundDirect`, `writeSessionContext` (writes `data/v2-sessions/<ag>/<s>/.nanoclaw-session.json`), `initSessionFolder` → `prepare`, `destroySessionMailbox`.
- `container-runner.ts:299-317`: `writeSessionContext(…, await mailbox.runnerContext(key))`, `runnerEnvironment(key)` merged into env, the context file bind-mounted at `/app/.nanoclaw-session.json`.
- Runner `mailbox/{index,types,model.generated,compose}.ts` + `sqlite/{index,operations,connection}.ts`; `db/{messages-in,messages-out,session-state,session-routing,container-state}.ts` are thin shims over `getAgentMailbox().operations`; `heartbeat.ts` owns `touchHeartbeat`; `index.ts` boots with `import './modules/index.js'` then `await mailbox.start(await readMailboxContext())` — a missing context file means "pre-seam host" and is tolerated. `model.generated.ts` must equal `src/mailbox/model.ts` (`pnpm run mailbox-model:check`, also asserted by `model.test.ts`).
- Canonical records are strict: `parseInboundRecord` rejects unknown fields, nested values, and any `kind` outside `chat|chat-sdk|task|webhook|system`. The runner's `SqliteAgentMailbox.getPendingMessages` **skips** rows that fail to parse.

Spike results absorbed (`spike-mailbox.md`, `spike-verification.md`): the subclass + narrowed `session()` typechecks with no change to `types.ts` (method bivariance); fork tables, columns and triggers survive because upstream's INSERT enumerates its own columns; schema/ops port 83–90% verbatim; the one thing the storage seam cannot carry is turn position (→ `registerAdmissionGate`). Refuter findings the design below fixes: (1) the spike's `prepare()` poisoned the memo so `migrateDeliveredTable` never ran on legacy DBs; (2) only the two `compose.ts` files are sanctioned slots — a barrel import of a fork gate is a patch; (3) `admissionHeld()` was documented pure but wrote state, `some()` short-circuited a second gate, and the predicate opened `inbound.db` every second.

## 4. Design

### 4.1 Where things live

| Tree | Upstream seam (byte-identical, manifest-checked) | Fork module (owns all fork SQL) | Sanctioned edit |
|---|---|---|---|
| host | `src/mailbox/**` except `compose.ts`; `docs/agent-mailbox-seam-migration.md` | `src/modules/mailbox/` | `src/mailbox/compose.ts` registers `NanoclawAgentMailbox`; `src/modules/index.ts` gains `import '../mailbox/compose.js'` (upstream's own line) |
| runner | `container/agent-runner/src/mailbox/**` except `compose.ts`; `db/{messages-in,messages-out,session-state,session-routing,container-state}.ts`; `heartbeat.ts`; `modules/index.ts` | `container/agent-runner/src/modules/mailbox/` | `mailbox/compose.ts` registers the fork class; `index.ts` boot lines are upstream's |

Naming: `src/mailbox/` is upstream's seam and is never edited; `src/modules/mailbox/` is the fork's implementation, following the fork's existing `src/modules/<name>/` convention (there is no `src/nc/`; the spike's `src/nc/` path is not adopted). A one-paragraph `README.md` in each module states this.

Fork callers import fork-only ops from the module (`src/modules/mailbox/index.js`, runner `modules/mailbox/index.js`), never from upstream's compat files. That is what keeps upstream's `db/*.ts` shims byte-identical and in the manifest.

### 4.2 Host `NanoclawAgentMailbox`

```ts
// src/modules/mailbox/index.ts
export interface NanoclawMailboxSession extends MailboxSession { /* fork ops, §4.4 */ }
export class NanoclawAgentMailbox extends SqliteAgentMailbox {
  private readonly migrated = new Set<string>();   // fork-owned memo; prepare() NEVER touches it
  override prepare(key) { super.prepare(key); ensureNanoclawInboundSchema(inboundPath); }
  override async session<T>(key, action: (m: NanoclawMailboxSession) => T | Promise<T>): Promise<T> {
    // exists() check, fork openers (missing-DB guard, activity marker, hot-journal recovery),
    // then ONCE per path: upstream migrateMessagesInTable + delivered check + fork migrations,
    // then action({ ...wrapSqliteInbound(inbound), ...wrapSqliteOutbound(...), ...forkOps(inbound, outbound) })
  }
  override async destroy(key) { this.migrated.delete(...); await super.destroy(key); }
}
```

Decisions:

- **`session()` is re-implemented** (≈35 L) because fork ops need the open handles and `SqliteAgentMailbox.migrated` is private. The drift manifest (§4.6) turns the resulting silent-drift risk into a loud one: any upstream change to `sqlite/index.ts` fails the manifest test at the next sync, and the fork copy is reviewed then. In parallel, ask upstream for `protected` on the memo plus a `protected withHandles()` hook (issue, not PR — same lane discipline as #3701).
- **Legacy migrations always run** (refuter finding 1): `prepare()` never adds to `migrated`; the first `session()` per process per path runs `migrateMessagesInTable`, the `delivered` check, and the fork's own additive migrations. Acceptance test H-2.
- **Fork openers wrap upstream openers**: `openInboundDb` keeps `SessionDbMissingError`, `fileMustExist`, the storage-activity marker and the patched `close()`; `openOutboundDb` keeps `recoverHotJournal`; PRAGMA order `journal_mode=DELETE` → `busy_timeout=5000` is asserted by test H-3. `SessionDbMissingError` is re-thrown from `session()` so sweep/delivery callers keep their vanished-session branches.
- **Fused ops stay fused.** `syncProcessingAcks` reads outbound and writes inbound in one action; upstream splits it into two `MailboxSession` methods. The fork op keeps the fused shape (both handles are in scope inside `session()`), so `host-sweep.ts` changes one call, not its control flow.
- **Delivery semantics preserved**: fork `markDelivered`/`markDeliveryFailed`/`markPending` (UPSERT, `error` column, `pending` status) override upstream's `INSERT OR IGNORE` versions on the narrowed session type. Test H-5 pins the UPSERT-over-pending behavior.
- **No data migration.** Every fork column/table/trigger already exists on the live fleet (the fork's `migrateMessagesInTable` runs on every open today). Fresh session DBs get upstream's baseline from `super.prepare()` plus the fork additions from `ensureNanoclawInboundSchema` — idempotent `CREATE … IF NOT EXISTS` / `ADD COLUMN` guarded by `PRAGMA table_info`. Rollback of any PR is `git revert` + build + restart; the files on disk are readable by both the old and new code.
- **Runner context**: `runnerContext()` returns `null` (SQLite); `runnerEnvironment()` returns `{}`. The context file is still written and mounted (upstream-faithful, 3 lines in the spawn path), so the spawn path stops diverging from upstream's.

### 4.3 Runner `NanoclawAgentMailbox`

```ts
// container/agent-runner/src/modules/mailbox/index.ts
export interface NanoclawMailboxOperations extends MailboxOperations { /* fork ops, §4.4 */ }
export class NanoclawAgentMailbox extends SqliteAgentMailbox {
  override readonly operations: NanoclawMailboxOperations = this;
  override getPendingMessages(limit, isFirstPoll) { /* fork selection: barrier gate, two-window select, recall-unit atomicity, ack/response idempotency, unit cap */ }
  override getMessageIn / findQuestionResponse / findCliResponse  // via the fork record parser
  // + every fork op (session-state families, provider health, usage tables, routing extensions)
}
```

Decisions:

- **Inbound kinds: measured, not assumed.** M-1 (PR 1, 2026-09-03) scanned all 1,400 live `inbound.db` files and every host inbound-write site: the fork writes exactly upstream's five kinds (`chat`, `chat-sdk`, `system`, `task`; `webhook` declared, unused). Recall rows are `kind='system'` with a `recall-` id prefix, not a distinct kind. So upstream's `parseInboundRecord` is sufficient and R1 needs **no fork record parser**; `inbound-kinds.ts` (`INBOUND_KINDS`) is the checked-in guard and R-3 stays as the test that a new kind cannot be introduced silently.
- **The runner's compat surface is upstream's.** `db/messages-in.ts`, `db/session-state.ts`, `db/session-routing.ts`, `db/container-state.ts`, `db/messages-out.ts` become upstream's verbatim shims. `getPendingMessages(isFirstPoll)` keeps its compat signature; the fork's `PendingSelectionDiagnostics` becomes a module export (`getPendingMessagesWithDiagnostics`) for the one poll-loop site that reads it, if any (builder verifies).
- **Fork-only ops** (sticky settings, work continuation, done proposals, infra-warning dedupe, memory epoch, provider health, `getSessionSpawnTaskId`/`getSessionId`, `classifyTrigger`, `retainCompleteRecallUnits`, `releaseProcessingClaims`, `getCentralDb`, `initTestSessionDb`) are exported from `modules/mailbox/index.ts` under their current names. The 25 callers change import paths only — a mechanical rewrite with unchanged call sites.
- **Test harness**: the fork's `initTestSessionDb` (in-memory test mode, used by 22 runner suites) moves into the module and installs its schema through the same `ensureNanoclawOutboundSchema` the production path uses, so tests and production share one schema source (today `connection.ts:test-schema-*` uids duplicate it).
- **PRAGMAs**: inbound `busy_timeout=5000` → `mmap_size=0` on a fresh RO open per poll; outbound must see `busy_timeout` before `journal_mode=DELETE` (switching journal mode takes an exclusive lock; the fork has a live-regression test with a sibling MCP writer). Upstream's manifest-locked opener runs them in the opposite order, so the fork module pre-pins `journal_mode=DELETE` behind a busy handler in `start()` before upstream's opener runs, making upstream's PRAGMA a lock-free no-op (test R-2). Upstream ask after R1 soaks: swap the two lines. The comment block on cross-mount visibility is carried into the module verbatim.
- `start(key|null)`: the fork accepts `null` (pre-seam host) exactly like upstream; `stop()` closes the singletons.

### 4.4 Fork op families (what moves, where from)

| Family | Host ops (from `session-db.ts` / `session-manager.ts` / `host-sweep.ts`) | Runner ops (from `db/*`) |
|---|---|---|
| Repository fence | `readRepoIngressFence`, `activateRepoIngressFence`, `releaseRepoIngressFence`, `admitRepoIngressFenceMessage`, `repoIngressFenceAckToken`, `readRepositoryMountBarrierAck`, `countDueMessages` (fence-aware), schema + 4 triggers | `getActiveRepositoryMountBarrier`, `acknowledgeRepositoryMountBarrier`, fence gate in `getPendingMessages` |
| Ingress | `insertMessage` (seq computed internally), `insertMessageIfNew`, `insertMessageWithContext`, `insertMessageWithContextIfNew`, `insertDeferredMessageWithContextIfNew`, `nextEvenSeq`, `ensureSchema`, `upsertSessionRouting` (+`spawn_task_id`/`session_id`), `readSessionRouting`, `sessionInboundHasMessage` | `getSessionSpawnTaskId`, `getSessionId`, `getSessionRouting` (table-absent fallback) |
| Selection | — | two-window bounded select, `retainCompleteRecallUnits`, `releaseProcessingClaims`, `classifyTrigger`, `PendingSelectionDiagnostics` |
| Delivery | `markPending`, `markDelivered` (UPSERT), `markDeliveryFailed` (UPSERT + error), `migrateDeliveredTable` (+`error`) | — |
| Sweep / container state | `getContainerState` (tiered), `syncProcessingAcks` (fused), `getNextFutureProcessAfter`, `expireStalePending`, `getDueWakePriority`, `INTERACTIVE_WAKE_MAX_AGE_MS`, `readWorkContinuation` (from `host-sweep.ts`) | `setContainerToolInFlight`/`clear…` (provider fields), `clearStaleProcessingAcks`, `setProviderHealthState`/`clear…`, memory telemetry |
| Session state | — | sticky model/effort/ultracode/fast, `WorkContinuation` queue/claim/requeue/clear/cancel/reset, `DoneProposal`, `shouldPostInfraWarning`, memory-context epoch, legacy continuation migration |
| Usage | — | `turn_usage`, `rate_limit_samples` tables and writers (schema only moves; the poll-loop metering call stays where it is) |
| Openers | `openInboundDb`/`openOutboundDb`/`openOutboundDbRw` with guards, `recoverHotJournal`, `SessionDbMissingError` — **internal to the module**, not exported | `openInboundDb`/`getInboundDb`/`getOutboundDb`, `initTestSessionDb`, `closeSessionDb`, `getCentralDb` — internal except the test helpers |

`container-restart.ts`'s barrier engine is re-expressed over `withMailboxSession` + the fence ops in the host module (PR 5); it stays in `container-restart.ts` because its callers are fork files and the ledger books it RE-HOME, not KEEP-PATCH. Moving it into `src/modules/repository-workspaces/` is a follow-up for the repo-store module, not this seam.

### 4.5 `registerAdmissionGate` (runner lifecycle seam)

New core file `container/agent-runner/src/admission-gate.ts` + one 7-line block at the top of the outer loop in `poll-loop.ts` (the spike's placement, `poll-loop.ts:112` upstream). Contract, fixed for the nits:

```ts
/** A boundary observer runs at the provider-idle boundary of the poll loop, never mid-query.
 *  It returns true to hold admission. Observers MAY record that they observed the boundary
 *  (that is the point of the seam); they must be cheap and must not throw. */
export type AdmissionGate = () => boolean;
export function registerAdmissionGate(gate: AdmissionGate): void;
/** Runs EVERY registered gate (no short-circuit) and returns whether any holds. */
export function evaluateAdmission(): boolean;
```

- Every gate runs on every evaluation (`gates.map(g => g()).some(Boolean)`), so a second gate is never starved (test R-6).
- The doc says observers may record; the fence gate's ack write is that record. The "pure" claim is dropped rather than the side effect hidden.
- The fence gate reads the barrier once per evaluation and memoizes the token for the `getPendingMessages` call that follows in the same tick, so the fenced path costs one `inbound.db` open per poll, not two. Unfenced installs pay one cheap RO open per second per container — the same open the poll already does; measured, not asserted (PR R2 records the number).
- Registration happens **inside the fork mailbox module** (`modules/mailbox/index.ts` calls `registerAdmissionGate` at import), reached through `mailbox/compose.ts` — the sanctioned slot. No barrel edit (refuter finding 2).
- The fork's `poll-loop.ts:313-315` ack write and the `getActiveRepositoryMountBarrier` idle-loop check move behind the gate. The 6 mid-turn barrier reads inside `processQuery` are **not** touched (non-goal).
- Contribution: after the fork has run it for one week, open an upstream PR under the operator's identity with the seam, the doc block above, and the two tests. The fork carries it as a 36-line core patch until merged; the manifest excludes `poll-loop.ts` and `admission-gate.ts` (both are already both-touched files).

### 4.5b Delivery handlers run outside any mailbox session

PR 3 adopts upstream's contract: `DeliveryActionHandler(content, session)`; the handle is gone. The delivery loop reads due rows in one `withExistingMailboxSession`, **closes it**, invokes the handler with no session open, then opens a short session to `markDelivered`/`markDeliveryFailed` (or leaves the row to the handler when it returns `{ deferAck: true }` — the fork's `deferAck` contract is kept; G08 books it CONTRIBUTE). Handlers that need session state open their own `withMailboxSession` (upstream's guidance). The 15 `inDb` receivers change in PR 3: the 4 that execute SQL move to named fork ops; the 11 pass-throughs drop the parameter. Test H-12 delivers an action whose handler writes to its own session through the real drain path and asserts the write landed and the row was acked — the case that would have lost the `spawn_cancel` notification.

### 4.6 Drift tests (step 4 of the seam recipe)

1. **Upstream manifest** — `src/mailbox/UPSTREAM-MANIFEST.json`: `{ upstream: "5c3082a1", files: { "<path>": "<sha256>" } }`. The covered set is an explicit constant `UPSTREAM_FILES` in `scripts/mailbox-seam-manifest.ts`: every file under `src/mailbox/**` and `container/agent-runner/src/mailbox/**` except the two `compose.ts`, plus `docs/agent-mailbox-seam-migration.md`, runner `db/{messages-out,session-state,session-routing,container-state}.ts` (`db/messages-in.ts` left this set in #293 — see **Fork-diverged ports** below), `heartbeat.ts`, `modules/index.ts`. `src/mailbox-seam-upstream.test.ts` asserts the manifest's key set **equals** `UPSTREAM_FILES` (no omission possible), then recomputes and compares every hash. `--update <upstream-sha>` regenerates from `git show <sha>:<path>` for the next upstream sync — the only sanctioned way to change a file that is still in `UPSTREAM_FILES`; a file that has left it for `FORK_DIVERGED_UPSTREAM_FILES` is never touched by `--update` again. Same pattern as `src/design-artifact-loop-vendor.test.ts`. A manifest is used instead of `git show` in the test because the fork's CI clone does not carry upstream commits. **Fork-diverged ports:** a file leaves `UPSTREAM_FILES` for `FORK_DIVERGED_UPSTREAM_FILES` (`scripts/mailbox-seam-manifest.ts`) the moment a fork-only feature needs to hand-edit it, in the same PR that makes the edit — never as a follow-up, and never by re-adding it to `UPSTREAM_FILES` with a regenerated hash (that would either fail forever or, on the next `--update`, silently overwrite the fork's own logic). `src/mailbox-seam-upstream.test.ts` asserts each `FORK_DIVERGED_UPSTREAM_FILES` entry still exists in the working tree — by name only, hash never checked again. `container/agent-runner/src/db/messages-in.ts` is the first entry: 1dfd2857 (#293) added the fork-only `scheduled_for` column so a retry backoff can't rewrite a task occurrence's original slot; re-porting the file from a newer upstream sha is a deliberate act that must re-apply that column, not a plain `--update`. **Deferred ports:** upstream's two `mailbox/registry.test.ts` files assert the end state (no `session-db.ts`, entrypoints import the barrel). The runner one is ported unmodified in R3. The host one is **unportable** (found in PR 7): it reads two files the fork lacks, forbids `better-sqlite3`/`.prepare(` in `session-manager.ts` and `host-sweep.ts` (which legitimately hold central-DB access), and expects the barrel import in `src/index.ts` (fork: crash-guard shim; import in `main.ts`). PR 7 ships a fork-owned `src/modules/mailbox/registry.test.ts` asserting the same invariants against the fork's topology, recorded in `UNPORTABLE_UPSTREAM_FILES` with its reason; the ratchet's tripwire is per-half (runner deferred entry must be ported once the runner entries are gone; unportable entries must have their replacement on disk and never enter `UPSTREAM_FILES`) — the original `allowlist.length === 0` key could never fire with the permanent `storage-manager.ts` exemption.
2. **Raw-access ratchet** — `src/mailbox-seam-ratchet.test.ts`: greps both trees outside the two modules and `src/mailbox/sqlite/` for (a) `session-db.js` imports, (b) `openInboundDb|openOutboundDb|openOutboundDbRw|withInboundDb|inboundDbPath|outboundDbPath|getInboundDb|getOutboundDb` imports, (c) `new Database(` on a path containing `inbound.db`/`outbound.db`, (d) **any parameter or variable named `inDb|outDb|inboundDb|outboundDb`** (the fork's consistent name for a passed session handle — this is what catches SQL executed on a handle received from elsewhere), and (e) a type-level assertion that `DeliveryActionHandler` has arity 2 (compile-time, `expectTypeOf`). Ships in PR 1 with an **allowlist of the files that still match** (the 23 host + 25 runner callers + the 15 handle receivers); each caller PR removes its files; PR 7 / R3 empty it. A file can leave the allowlist, never re-enter it — the test asserts the current offender set is a subset of the committed `RATCHET.json`, so re-adding a file fails CI without touching the test.

### 4.7 Runner source activation (PR 0)

At host boot, `container-runner.ts` copies `container/agent-runner/src` to `data/agent-runner-src/<boot-stamp>/` (a few MB, well under a second; copy to a temp name, then rename so a snapshot appears whole or not at all) and mounts **that** directory at `/app/src` for every spawn of this host process. `git pull` therefore changes nothing for spawns until the host restarts; the restart is the activation point; rollback is a restart. Activation never prunes: a bind mount pins the directory, not its entries, so deleting an old snapshot would empty `/app/src` under any container still alive from the previous process (Codex plan-review finding on PR #246). Pruning is a separate best-effort step, run once after `cleanupOrphansStrict()` in `main.ts`, that removes only snapshots no running container mounts (checked via `docker inspect` mounts; if that check fails, nothing is pruned). Container adoption (seam 2) keeps that reference check. Leftover snapshots cost ~2.4 MB each. `NANOCLAW_AGENT_RUNNER_SRC_LIVE=1` mounts the checkout directly for local development (`pnpm run dev`). Operator-visible change: a runner-source edit on the live host now takes effect at the next host restart, not the next spawn — deliberate, and the same rule `dist/` already imposes on host code. Tests H-0a/H-0b/H-0c. SHA-named `dist/` snapshots with a symlink swap were considered and rejected (pruning races with a host that has not restarted).

### 4.8 Invariants (hold at every PR boundary)

- I-1 **Host and runner activate together, at restart, atomically** (PR 0). Until PR 0 is deployed, no runner PR merges. After it, every runner PR must still run against the pre-PR host for the case of a container started by the old host and still alive (no context file → `null`), and every host PR must tolerate old containers still running (they never see the context file). No PR changes what either side writes to disk.
- I-2 **One implementation of any SQL statement at any time.** During the transition, `src/db/session-db.ts` is a pure re-export façade over the module (PR 2 → PR 7); the runner's `db/*` are upstream's shims + the fork module. No SQL body exists in two files.
- I-3 **Same-key `session()` never nests.** Upstream's guard throws. Each caller batch must be reviewed for nested opens (top suspects: `host-sweep.ts` helpers, `delivery.ts` retry path, `session-manager.ts` callers of `writeSessionMessage`). Test H-6 exercises the guard on the fork class.
- I-4 **Reads never provision.** Sweep, dashboard, storage and recovery paths use `withExistingMailboxSession` and treat `undefined` as "no mailbox" (replacing today's `SessionDbMissingError` branches where the caller only reads).
- I-5 **The three cross-mount pragmas and their order are preserved** on both trees (H-3, R-2).
- I-6 **No central-DB migration, no session-DB shape change, no `sessions` index rebuild.**
- I-7 **Upstream seam files byte-identical to `5c3082a1`** (manifest); fork-only code only under the two module directories, `compose.ts`, and the listed both-touched files.
- I-8 **Orphan agent messages are still delivered top-level** (delivery.ts fallback is untouched; H-8 regression case).
- I-10 **Acks and reads never provision.** Delivery acks and every read path use `withExistingMailboxSession`; `withMailboxSession` (which calls `prepare()`) is reserved for writes that legitimately create a session. Provisioning from an ack would recreate a reclaimed session directory and author an `outbound.db` the host must never create (the 2026-09-01 stub crash loop). Found by the PR 3 builder.
- I-9 **No handler or hook ever receives a session handle.** Delivery action handlers run with no mailbox session open (§4.5b); a handler that needs state opens its own. Enforced by ratchet pattern (d)+(e) and H-12.

## 5. PR series (ordered; each deploys alone)

**Stacked-PR CI rule:** `.github/workflows/ci.yml` runs only for PRs targeting `main`, so a stacked PR gets no CI until GitHub retargets it after the PR below merges; builders' local targeted checks are the gate until then, and a stacked PR merges only after that retargeted CI run is green. No workflow change (Actions minutes are quota-bound).

Every PR: branch from `main` in a scratch worktree the operator has approved for this program (never in `/home/ubuntu/nanoclaw-v2` — its `dist/` is live and its `HEAD` is shared), own `node_modules` via `pnpm install --frozen-lockfile` and `bun install` in `container/agent-runner`, format + typecheck both trees, host tests **serially**, runner tests, `pnpm run check:public-boundary -- --portable`, Codex review loop (`/pr-review-loop`, effort `high`), merge with a merge commit, deploy in a quiet-hour window (§6). Owner = one builder per PR (worker tier noted); the orchestrator reviews the diff against the acceptance cases before merge.

| # | PR | Tree | Runtime effect | Owner tier | Depends on |
|---|---|---|---|---|---|
| 0 | Runner source boot snapshot (§4.7) | host | spawns mount `data/agent-runner-src/<boot>/` instead of the checkout | worker | — |
| 1 | Port upstream seam (inert; the two `registry.test.ts` deferred) + three optional fields on the fork's runner `MessageInRow` so upstream's driver typechecks + manifest + ratchet (allowlist mode) + **M-1 inbound-kind inventory** (read-only `SELECT DISTINCT kind` over every live `inbound.db`, plus the static set of `kind:` literals at every host inbound-write site; checked in as `container/agent-runner/src/modules/mailbox/inbound-kinds.ts` with the measurement recorded in run.md) | both | none — `SqliteAgentMailbox` registered, nothing calls it | worker | 0 deployed |
| 2 | Host fork module + `session-db.ts` façade + `session-manager` seam port + spawn-path context file | host | spawn writes/mounts `.nanoclaw-session.json`; all session-DB SQL now executes inside the module (via façade) | worker-high | 1 |
| R1 | Runner fork module + upstream compat shims + boot wiring + import rewrite (25 callers); fork record parser built from M-1 | runner | runner boots through `mailbox.start()`; selection/state SQL executes inside the module | worker-high | 1 incl. M-1 (parallel with 2) |
| 3 | Host callers, delivery family: `delivery.ts` (two-argument handler contract, handlers invoked outside the session, §4.5b), the 10 delivery-handler `inDb` receivers (the other 5 `inDb` names are local handles owned by PR 4 — `scheduling/recurrence.ts`, `scheduling/host-script.ts`, `dashboard/thread-close.ts` — and PR 6 — `dashboard/api/scheduled-assembly.ts`, `dashboard/api/scheduled-read.ts`), `cli/delivery-action.ts`, `modules/bash-gate`, `modules/repository-workspaces/job-runner.ts` | host | delivery loop uses `withMailboxSession`; no handler receives a handle | worker-high | 2 |
| 4 | Host callers, ingress family: `session-manager.ts` internals, `db/scheduled-tasks.ts`, `modules/scheduling/{db,recurrence}.ts`, `modules/agent-to-agent/*`, `modules/scheduled-wake`, `dashboard/thread-close.ts`, `host-restart-warn.ts` | host | inbound writes use `withMailboxSession`; nesting guard live on the write path | worker-high | 2 |
| 5 | Host callers, sweep + container-state family: `host-sweep.ts`, `repo-fence-recovery.ts`, `container-restart.ts` (barrier engine over fence ops), `worktree-cleanup.ts`, `container-runner.ts` fence read, `storage-manager.ts` paths | host | sweep reads via `withExistingMailboxSession` | worker-high | 2 |
| 6 | Host callers, operator surfaces: `dashboard/api/{threads,scheduled-move,scheduled-mutations}.ts`, `dashboard/steer.ts`, `modules/repository-workspaces/index.ts`, `orchestrator-dispatch`, `migrate-tasks-to-system-sessions.ts`, `threads.ts` | host | dashboard reads via the seam | worker | 2 |
| R2 | `registerAdmissionGate` seam + fence gate in the module; poll-loop idle ack moves behind it | runner | idle-boundary ack path | worker-high | R1 |
| 7 | Delete `src/db/session-db.ts` façade, `session-manager.ts` raw wrappers, and the module's transitional `legacyInboundHandle()`/`legacyOutboundHandle()` bridge (PR 5); fork-owned host registry test (upstream's is unportable, §4.6); host allowlist → empty except `storage-manager.ts` (module-internal worker-thread reclaim probe over an injected sessions root — documented in PR 5). **As built (2026-09-03):** 14 caller files no earlier row owned — `cli/resources/tasks.ts`, `dashboard/api/{events,sessions,scheduled-move,scheduled-mutations}.ts`, `dashboard/session-title-sweep.ts`, `modules/claims/self-heal.ts`, `modules/permissions/task-slack-subject.ts`, `modules/scheduling/{create,live-count}.ts`, `host-sweep.ts` bridge sites, `session-manager.ts` admission functions, `router.ts`, `worktree-cleanup.ts`; `createScheduledTask`/`createAgentFromTemplate` become async (no synchronous write funnel exists). **Cascade (2026-09-03):** `withExistingNanoclawOutbound` lives in `modules/mailbox/index.ts`, not `read-only.ts` beside the two read funnels — PR 4's round 8 made it a typed outbound session built from `composeOutboundOps`, which lives in the barrel, and `read-only.ts` cannot import that without a static import cycle. `session.ts` is deleted and there is one spelling for the mailbox session (`withMailboxSession`/`withExistingMailboxSession`). **Allowlist, as built (2026-09-04):** the host half ends at exactly TWO entries, not one — `src/storage-manager.ts` (the worker-thread reclaim probe named above) and `src/modules/sweep-scheduled-move/index.ts`. The second arrived from seam 2 after this PR was written: S2-PR7 moved `recoverMoveIntents` out of `host-sweep.ts` and kept its raw open as finding F-7.3's permanent KEEP-PATCH, because that recovery walks an INJECTED sessions root while the mailbox is keyed on `DATA_DIR`, so no mailbox key addresses those files at all. PR 7 had converted that site — it could, because the tests it lived beside swapped `DATA_DIR` to the injected root for exactly that block; the moved tests do not, so main's version stands. Both entries are therefore the same exemption twice, and `src/mailbox-seam-ratchet.test.ts` asserts the exact pair with both rationales. The second retires when seam 2 drops `MoveRecoveryOptions.dataDir` and the recovery can be addressed by a mailbox key. **Op-side derivation:** `modules/mailbox/op-sides.ts` reads the composition with the TypeScript compiler API rather than splitting the object literal on top-level commas. Identifiers come from the AST, so a handle named inside a string or a comment is text and not a use; a computed, shorthand, method or spread form it cannot resolve THROWS rather than dropping that op out of BOTH ratchet rules (a dropped entry is not the documented fail-closed case — both rules filter unknown ops out before deciding, which is less strict, not more). Its completeness assertion — parsed keys plus upstream's two runtime sets must equal `composeNanoclawSession`'s real key set — caught `forkOps` re-declaring `writeOutboundDirect` after already spreading `composeOutboundOps`; byte-identical body, no behavior change, removed | host | `createScheduledTask` async; EACCES on a session dir surfaces instead of reading absent | worker-high | 3–6 |
| R3 | the five runner files still on the allowlist after R1 — `poll-loop.ts`, `cli/ncl.ts`, `db/turn-usage.ts`, `db/rate-limit-samples.ts` (usage writers take the opener from upstream's connection module; move their SQL into the module as named ops), `scheduling/wiki-lint-gate.ts` (opens both session DBs by injected path) — off raw handles; port upstream's runner `mailbox/registry.test.ts`; runner allowlist → empty | runner | none | worker | R1, R2 |

Sequencing notes:

- 0 deploys first and alone; its rollback (restart) is rehearsed and timed. 2 and R1 run in parallel (two builders); 3–6 can run in parallel as builds but **deploy one per window** in order 3 → 5 → 4 → 6 (delivery and sweep are the hot paths; get them soaked first; ingress carries the nesting-guard risk and goes after both delivery — which by then invokes handlers outside the session — and sweep have proven their sides). **PR 4 does not deploy before PR 3 is soaked 24 h** (the `spawn_cancel` class of same-key write lives on the delivery path). Rollback is rehearsed a second time on R1, the first runtime-changing runner PR.
- Test suites named in §3 are updated in the PR that changes their subject's import path — never in a separate "fix tests" PR. A `vi.mock('../db/session-db.js')` that a batch invalidates is rewritten to mock the module, not deleted.
- Sizing (agent-weeks, refuter-adjusted — the spike's 15-minute slice had a written target and an implementation to copy; every batch here has the implementation but not the target): 0: 0.5 · 1: 0.75 · 2: 1.5 · R1: 1.5 · 3: 1.25 · 4/5/6: 0.75 each · R2: 0.5 · 7: 0.25 · R3: 0.5 → ≈9, ×1.3 for review rounds and deploy windows ≈ **12 agent-weeks**. With 3 builders the calendar bound is the deploy cadence: 11 deploys ≈ **4–6 weeks** at one quiet-hour window per night. The ledger's 2-week contingency is kept, not spent.

## 6. Deploy, canary, rollback, observability

Per PR (the `/sync-upstream` §4 sequence; restarts are surfaced for the operator's approval):

```bash
gh pr merge <n> --merge && git pull --ff-only origin main
pnpm run build && node -p "require('./dist/BUILD_INFO.json').sha" && git rev-parse HEAD   # must match
grep -c NanoclawAgentMailbox dist/modules/mailbox/index.js                                # symbol grep, PR ≥2
sudo systemctl restart nanoclaw-v2
```

**Quiet rule (operator, 2026-09-02):** a restart runs only when the fleet is quiet — no deliveries for 10 minutes and no container younger than 5 minutes — and every restart is surfaced for approval first. Post-restart gate (all four, plus the `OneCLI preflight ok` line from #245, or it is not deployed): runtime + `NRestarts` stable; `NODE_USE_ENV_PROXY` count 0 in the daemon environ; `grep -c 'OneCLI gateway applied' logs/nanoclaw.log` > 0 within 2 min (the spawn-success signal; one refusal is not a regression, zero successes is); `docker ps --filter name=nanoclaw-v2-` non-empty.

Canary (decided: QA seat first): immediately after the gate, `ncl groups restart --id <qa-seat> --message <smoke prompt>` so the QA seat is the **first container on the new runner code** — true only because of PR 0: before it, any group spawning between `git pull` and the restart would have loaded a partially updated tree. Other running containers keep the old code in memory until their next natural spawn (that is the runner-side canary). Then a live Slack round trip on the QA seat and one on each production workgroup with actual tools, not curl. The host side has no partial rollout (one process); canary there means verification-first.

Seam-specific checks after each PR: `docker inspect` of a fresh container shows `/app/src` bound to `data/agent-runner-src/<current boot>/` (PR 0+); `ls data/v2-sessions/*/*/.nanoclaw-session.json | wc -l` grows with spawns (PR 2+); `grep -c 'Nested mailbox session' logs/nanoclaw.error.log` must be 0 after 24 h (I-3); `grep -c 'Skipping invalid inbound mailbox row' logs/nanoclaw.log` must be 0 (R-3); `grep -c 'failed to notify parent' logs/nanoclaw.log` unchanged (PR 3+); delivery/sweep error counts unchanged versus the previous 24 h.

Rollback: `git revert <merge>` → build → restart (no data to restore; both code versions read the same files). Rehearsed once on PR 1's deploy, timed; must be under 10 minutes. `deploy-crash-guard`'s `node_modules.pre-deploy` restore is not used (not a runtime change).

Interruption cost: each deploy restarts the host, and the fork's restart model stops running containers (adoption comes with seam 2). Eleven deploys ≈ eleven interruptions of in-flight agent turns, in quiet hours, announced in Slack. See §9 Q1.

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | Nesting guard throws on a production path no test covered (I-3) | Handlers run outside the session (§4.5b, H-12) so the known same-key writers (`spawn_cancel`) cannot hit it; ingress batch (PR 4) deploys after PR 3 has soaked; nested-open review per batch; the `Nested mailbox session` log grep is a gate. A throw inside a handler's own try/catch is **not** a retry — that is why the handle is removed, not why it is tolerated |
| 2 | Fork-kind rows skipped by upstream's parser (R-3) | Kind set measured in PR 1 (M-1) from every live `inbound.db` plus every host writer's literal, checked in; R1 cannot start without it; R-3 is parameterized over that set and runs through the `db/messages-in.ts` compat surface; log grep is a gate |
| 1b | Mixed old/new runner tree loaded by a spawn during `git pull`; runner rollback non-atomic | PR 0 boot snapshot; no runner PR before PR 0 is deployed; rollback rehearsed on R1 |
| 5b | Session SQL survives outside the module on a handle passed in by a caller (ratchet blind spot) | Handle removed from the delivery contract in PR 3; ratchet patterns (d)+(e); the 4 SQL-executing receivers are named in PR 3's scope |
| 3 | `vi.mock` by path breaks ~46 suites in cascade | Mocks move with their subject in the same PR; host tests run serially in a frozen worktree (known unsafe concurrently) |
| 4 | Fork `getPendingMessages` diagnostics/signature drift under the compat shim | Builder traces the 7 poll-loop call sites; diagnostics path gets its own module export |
| 5 | `migrateDeliveredTable` skipped again by a copy of the spike pattern | H-2 is a named acceptance case; the memo is written only in `session()` |
| 6 | Manifest test blocks a future upstream sync | `--update` script is the sanctioned path; the test message says so |
| 7 | Context-file mount rejected by the fork's mount policy | The session dir is already mounted for `inbound.db`; H-9 asserts the mount is in the spawn args; canary catches a refusal before the fleet |
| 8 | Upstream moves `sqlite/index.ts` and the fork's `session()` copy silently diverges | Manifest fails at sync time; the copy is reviewed then; `protected` ask filed upstream |
| 9 | Refuter's warning that the spike slice was the easiest of its family | Budgeted: 2 and R1 are worker-high with 1.5 weeks each and keep the contingency |

## 8. Acceptance criteria (executable; `/team-build` materializes these, names verbatim)

Host (`vitest`, files noted):

- **H-0a** `src/container-runner.test.ts` › "spawn mounts the boot snapshot of the runner source, not the checkout" — with a temp `DATA_DIR`, boot the snapshot once; assert the `/app/src` mount tuple's host path is `data/agent-runner-src/<boot>/` and that path's file set equals `container/agent-runner/src`; with `NANOCLAW_AGENT_RUNNER_SRC_LIVE=1` the host path is the checkout.
- **H-0b** same file › "a second boot replaces the snapshot and pruning removes only unreferenced previous snapshots" — activate twice with a changed source file; both snapshot dirs exist (activation never prunes); prune with the first snapshot reported as referenced → it survives and a planted stale `*.tmp` is removed; prune with nothing referenced → only the newest remains and carries the change; a `null` reference check prunes nothing.
- **H-0c** same file › "falls back to the checkout path and keeps booting when the snapshot cannot be written" — unwritable data dir → no throw, the checkout path is returned, `log.error` called.
- **H-1** `src/mailbox-seam-upstream.test.ts` › "every ported upstream file matches UPSTREAM-MANIFEST.json" — assert the manifest key set equals `UPSTREAM_FILES` (§4.6.1) exactly; recompute sha256 for each entry in both trees; assert equality.
- **H-1b** `src/mailbox-seam-ratchet.test.ts` › "no raw session-DB access or passed session handle outside the mailbox modules except the committed allowlist" — grep patterns (a)–(d) of §4.6.2 plus the arity-2 type assertion (e); assert the set of offending files ⊆ `RATCHET.json`; assert `RATCHET.json` is empty by PR 7 / R3 (the case flips from "subset" to "empty" when the allowlist is emptied).
- **H-2** `src/modules/mailbox/mailbox.test.ts` › "legacy delivered table gains platform_message_id and status after prepare() then session()" — create an inbound DB with a `delivered(message_out_id, delivered_at)` table; `prepare(key)`; `session(key, m => m.markDelivered(...))`; assert both columns exist and `getDeliveredIds()` returns the id.
- **H-3** same file › "inbound and writable outbound handles run journal_mode=DELETE then busy_timeout=5000" — spy on `Database.prototype.pragma`; assert call order per handle.
- **H-4** same file › "fresh session DB has upstream baseline plus fork schema" — `prepare` on an empty dir; assert tables `messages_in`, `delivered`, `destinations`, `session_routing`, `repo_ingress_fence`; columns `repo_fence_epoch`, `repo_fence_original_trigger`, `session_routing.spawn_task_id`, `delivered.error`; the 4 triggers by name; index `idx_messages_in_series_seq`.
- **H-5** same file › "markDelivered upserts over a pending row and clears error" — `markPending(id)`, `markDeliveryFailed(id, 'boom')`, `markDelivered(id, 'p1')`; assert status `delivered`, `platform_message_id='p1'`, `error IS NULL`.
- **H-6** same file › "withMailboxSession throws on same-key nesting and allows other keys" — nested same key rejects with `/Nested mailbox session/`; nested different key resolves.
- **H-7** same file › "fence holds ingress out of countDueMessages until released with the exact generation" — the spike's host fence test, ported: activate, insert, count stays, wrong generation admits nothing, correct release admits and restores the trigger.
- **H-8** `src/delivery.test.ts` › "an outbound row with no thread origin is delivered top-level" — existing behavior pinned as a regression case through the seam (I-8).
- **H-9** `src/container-runner.test.ts` (or the spawn-args suite) › "spawn writes the session context file and mounts it read-only at /app/.nanoclaw-session.json" — assert file content `null` and the mount tuple in the driver args.
- **H-10** `src/host-sweep.test.ts` › "sweep treats a missing mailbox as no-op via withExistingMailboxSession" — session dir absent → no throw, no wake, no provisioning (I-4: assert the dir still does not exist).
- **H-11** `src/modules/mailbox/mailbox.test.ts` › "syncProcessingAcks applies terminal acks from outbound to inbound in one session" — outbound `processing_ack` rows completed/failed → inbound statuses updated; one `session()` call observed.
- **H-12** `src/delivery.test.ts` › "a delivery action handler that writes to its own session succeeds and the action is acked" — register a handler that calls `writeSessionMessage` for the delivering session; drain one due action row through the real delivery loop; assert the inbound write exists, the `delivered` row is `delivered`, and no `Nested mailbox session` error was logged. A `deferAck` variant asserts the outer loop did not touch `delivered`.

Runner (`bun:test`):

- **R-1** `container/agent-runner/src/modules/mailbox/mailbox.test.ts` › "boot registers NanoclawAgentMailbox and start(null) succeeds" — `getAgentMailbox()` is the fork class; `start(null)` resolves.
- **R-2** same file › "outbound singleton runs busy_timeout, journal_mode=DELETE, foreign_keys=ON in that order; inbound opens set mmap_size=0" — assert via `PRAGMA journal_mode` readback and an exec spy.
- **R-3** same file › "every inventoried inbound kind round-trips through the compat getPendingMessages and getMessageIn" — `it.each(INBOUND_KINDS)` from `inbound-kinds.ts` (the M-1 measurement = upstream's five; the assertion that it equals upstream's `InboundKind` set is part of the case); for each kind insert a row (a `system` row with the `recall-` id prefix included), call `db/messages-in.ts`'s `getPendingMessages(true)` and `getMessageIn(id)`; assert the row is returned and no `Skipping invalid inbound mailbox row` log line. A negative control inserts a kind **not** in the set and asserts it is skipped with that log line, proving the parser is closed.
- **R-4** same file › "getPendingMessages keeps recall units atomic and honours the wake window" — port of the existing `messages-in` selection tests through `operations`.
- **R-5** same file › "fenced session returns [] from getPendingMessages and never writes the barrier ack from selection" — the spike's runner fence test: `session_state.repository_mount_barrier_ack` stays null until the gate runs.
- **R-6** `container/agent-runner/src/admission-gate.test.ts` › "evaluateAdmission runs every registered gate and holds when any holds" — two gates, first holds; assert the second was called; assert `true`; no gates → `false`.
- **R-7** same file › "the fence gate publishes the exact [epoch, generation] token only from the idle boundary" — with a fenced inbound DB, `evaluateAdmission()` writes the token; `getPendingMessages()` alone does not.
- **R-8** `container/agent-runner/src/poll-loop.test.ts` › "poll loop skips dispatch while admission is held and resumes when released" — drive the loop with a held gate for two ticks; no `markProcessing`; release; message processed.
- **R-9** `container/agent-runner/src/modules/mailbox/mailbox.test.ts` › "sticky settings, work continuation and done proposal ops persist through session_state" — the existing `session-state` tests ported to the module API (queue → running → clear-if-matches; propose/retract; sticky survives a flagless batch).
- **R-10** same file › "provider health and tool-in-flight writes land in container_state with the fork columns" — `setProviderHealthState`, `setContainerToolInFlight`; readback includes `provider_executing`.

Each PR lists which of these it makes pass; PR 0 must pass H-0a/H-0b; PR 1 must pass H-1 and H-1b (subset mode) and check in M-1.

## 9. Open decisions for the operator (plain terms)

- **Q1 — Deploy cadence and interruption budget.** This series is 11 deploys. Each one restarts the host in a quiet hour and stops whatever containers are mid-turn (upstream's "adopt running containers on restart" arrives with the next seam). Recommendation: one deploy per night, smallest blast radius, ~4–6 weeks end to end. Alternative: pair a host PR with a runner PR in one window (~7 windows, ~3 weeks) at the cost of two variables per restart. Which do you want?
- **For awareness, not a question — PR 0 changes one habit.** After it, editing runner source on the live host takes effect at the next host restart instead of the next spawn (the same rule host code already follows). Local dev keeps the live mount via an env flag.
- **Q2 — Public upstream asks.** Two go out under your identity (you see each): an issue asking for `protected` on the SQLite mailbox's migration memo (removes the one silent-drift surface), and, after R2 has run for a week, a PR contributing `registerAdmissionGate`. Standing decision says public issues/PRs are fine; confirm these two specifically or say "hold".

Everything else in this plan is an engineering decision already made and stated.

## 10. Verification commands (per PR, in the scratch worktree)

```bash
./node_modules/.bin/prettier --check .
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc -p container/agent-runner/tsconfig.json --noEmit
./node_modules/.bin/vitest run --no-file-parallelism            # host, serial
(cd container/agent-runner && bun test)
pnpm run check:public-boundary -- --portable
pnpm run mailbox-model:check                                     # PR 1+
./node_modules/.bin/vitest run src/mailbox-seam-upstream.test.ts src/mailbox-seam-ratchet.test.ts
```

Post-deploy: §6 gate + seam checks, recorded in `run.md` with counts.

## 11. References

- Record: `groups/_ops/upstream-rebaseline-2026-09/{ledger.md §3 row 1, §4 G08/G09, §8.2, §10; spike-mailbox.md; spike-verification.md; seam-catalog.md §17}`
- Upstream: `docs/agent-mailbox-seam-migration.md` @5c3082a1; `src/mailbox/types.ts`, `src/mailbox/sqlite/index.ts:422-491`, `src/session-manager.ts:429-470`, `src/container-runner.ts:299-317`; runner `mailbox/index.ts`, `mailbox/sqlite/index.ts`, `index.ts:31-52`
- Fork: `src/db/session-db.ts`, `src/session-manager.ts:1609-1660`, `src/container-restart.ts`, `container/agent-runner/src/db/*.ts`, `src/design-artifact-loop-vendor.test.ts` (drift-test pattern)
- Process: `.claude/skills/sync-upstream/SKILL.md §4`, `docs/review-policy.md`, memories `project_node22_upgrade_2026_09_02`, `feedback_deploy_is_pull_build_restart`, `feedback_host_tests_unsafe_concurrent`
