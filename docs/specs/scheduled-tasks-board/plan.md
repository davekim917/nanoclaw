# Execution Plan: Scheduled Tasks Board

> `/team-plan` — 2026-06-13, from design rev 5 (review-cleared, drift-verified). Invoked by `/team-auto`.
> Design: `design.md` rev 5 · Review: `review.md` (3 cycles, 0 MUST-FIX) · Decisions: `decisions.yaml` (C1-C8, D1-D19)

## Overview

Add a **Scheduled** view to the NanoClaw dashboard: fleet-wide visibility + management of recurring scheduled tasks (rows in per-session `inbound.db`). Five builder groups. Host (`src/`) is Node ESM + better-sqlite3 + vitest; frontend (`dashboard/src/`) is React + SWR + vitest/jsdom — **separate build trees, no shared imports across the boundary**.

**Key cross-tree resolution ([NEEDS SPEC] matrix):** the §4.0 verb×state matrix is ONE host-side structure (`scheduled-board-matrix.ts`). API list/detail responses include a per-row `available_verbs: string[]` derived from it; the frontend drawer enables/disables buttons from `available_verbs` — never re-deriving the matrix. Single source of truth, client and server cannot disagree.

## Dependency Graph

```
Group A — Foundations & Shared Primitives (host)
  ├─ migrations, session-DB index, TaskDef.script, restoreTaskRow,
  │  matrix module, shared helpers (gate/audit/ratelimit/:key codec/cache singleton)
  ▼
Group B — Read Layer (host)            Group E — Frontend (dashboard/src/)
  ├─ assembly+cache+health, GET routes   ├─ parallel from approval (separate tree,
  ▼                                       │  builds against frozen API contract)
Group D — Move Flow (host)               │
  ├─ preview, execute, sweep recovery     │
  ▼                                       │
Group C — Simple Mutations + Route Registration (host)
  └─ edit/pause/resume/run-now/cancel + registers all 9 routes (imports B & D handlers)
```

Sequencing: **A → B → D → C**; **E parallel** with the host chain after plan approval. C is last on the host side because it owns route registration (`src/dashboard/index.ts`) and imports handler symbols from B and D.

## File Ownership Map

| File | Group | Task | Op |
|------|-------|------|----|
| `src/db/migrations/043-scheduled-audit.ts` | A | A1 | CREATE |
| `src/db/migrations/043-scheduled-audit.test.ts` | A | A1 | CREATE |
| `src/db/migrations/index.ts` | A | A1 | MODIFY |
| `src/db/schema.ts` | A | A2 | MODIFY |
| `src/db/session-db.ts` | A | A2 | MODIFY |
| `src/db/session-db.test.ts` | A | A2 | MODIFY |
| `src/db/scheduled-tasks.ts` | A | A3 | MODIFY |
| `src/db/scheduled-tasks.test.ts` | A | A3 | MODIFY |
| `src/modules/scheduling/db.ts` | A | A4 | MODIFY |
| `src/modules/scheduling/db.test.ts` | A | A4 | MODIFY |
| `src/dashboard/api/scheduled-board-matrix.ts` | A | A5 | CREATE |
| `src/dashboard/api/scheduled-board-matrix.test.ts` | A | A5 | CREATE |
| `src/dashboard/api/scheduled-shared.ts` | A | A6 | CREATE |
| `src/dashboard/api/scheduled-shared.test.ts` | A | A6 | CREATE |
| `src/dashboard/api/scheduled-assembly.ts` | B | B1,B2 | CREATE |
| `src/dashboard/api/scheduled-assembly.test.ts` | B | B1,B2 | CREATE |
| `src/dashboard/api/scheduled-read.ts` | B | B3,B4 | CREATE |
| `src/dashboard/api/scheduled-read.test.ts` | B | B3,B4 | CREATE |
| `src/dashboard/api/scheduled-move.ts` | D | D1,D2 | CREATE |
| `src/dashboard/api/scheduled-move.test.ts` | D | D1,D2 | CREATE |
| `src/host-sweep.ts` | D | D3 | MODIFY |
| `src/host-sweep.test.ts` | D | D3 | MODIFY |
| `src/dashboard/api/scheduled-mutations.ts` | C | C1-C5 | CREATE |
| `src/dashboard/api/scheduled-mutations.test.ts` | C | C1-C5 | CREATE |
| `src/dashboard/index.ts` | C | C6 | MODIFY |
| `dashboard/src/views/ScheduledBoard.tsx` | E | E1,E2,E3 | CREATE |
| `dashboard/src/views/ScheduledBoard.test.tsx` | E | E1,E2,E3 | CREATE |
| `dashboard/src/views/ScheduledDrawer.tsx` | E | E4 | CREATE |
| `dashboard/src/views/ScheduledDrawer.test.tsx` | E | E4 | CREATE |
| `dashboard/src/lib/api.ts` | E | E5 | MODIFY |
| `dashboard/src/lib/api.test.ts` | E | E5 | MODIFY |
| `dashboard/src/views/BoardShell.tsx` | E | E6 | MODIFY |
| `dashboard/src/main.tsx` | E | E6 | MODIFY |

**Conflict check:** every file maps to exactly one group. `src/dashboard/index.ts` → C only. `host-sweep.ts` → D only. `BoardShell.tsx`/`main.tsx` → E only. No conflicts.

## Group A: Foundations & Shared Primitives

Owns the schema changes and the shared host modules every other host group imports. Pre-condition: none (runs first).

### Task A1 — Central `scheduled_audit` migration
- **File:** `src/db/migrations/043-scheduled-audit.ts` (CREATE); `src/db/migrations/index.ts` (MODIFY — import + append `migration043` to the `Migration[]` array, following the exact pattern of `migration042` at index.ts:43,90)
- **Test file:** `src/db/migrations/043-scheduled-audit.test.ts`
- **Operation:** CREATE migration module exporting `migration043: Migration` (shape per `041-support-threads.ts`). Creates the `scheduled_audit` table exactly per design §4.4.
- **Interface:**
  ```sql
  CREATE TABLE scheduled_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    actor TEXT NOT NULL, action TEXT NOT NULL,
    agent_group_id TEXT NOT NULL, session_id TEXT NOT NULL, series_id TEXT NOT NULL,
    before_hash TEXT, after_hash TEXT, before_preview TEXT, after_preview TEXT,
    before_len INTEGER, after_len INTEGER,
    detail_json TEXT, correlation_id TEXT, resolved_at TEXT
  );
  CREATE INDEX idx_scheduled_audit_series ON scheduled_audit(series_id);
  CREATE INDEX idx_scheduled_audit_correlation ON scheduled_audit(correlation_id);
  CREATE INDEX idx_scheduled_audit_unresolved ON scheduled_audit(action, resolved_at);
  ```
  - ASSERT: action column accepts `edit|pause|resume|run_now|cancel|move|move_intent|move_restore_failed` (no CHECK constraint — values enforced in app layer).
  - ASSERT: migration is idempotent (`CREATE TABLE IF NOT EXISTS`) and re-runnable.
  - ASSERT: this is a CENTRAL-DB (`data/v2.db`) migration — does NOT touch any session inbound.db (C1/C3).
- **Named test cases:**
  ```
  test_migration043_creates_table:
    Setup: in-memory better-sqlite3 db with migrations 001..042 applied
    Action: run migration043.up(db)
    Assert: scheduled_audit table exists; the three indexes exist; columns match the spec
    Teardown: none
  test_migration043_idempotent:
    Setup: db with migration043 already applied
    Action: run migration043.up(db) again
    Assert: no throw; table still present, no duplicate index error
  ```
- **Acceptance criteria:**
  - [ ] `migration043` registered in `migrations/index.ts` array after `migration042`
  - [ ] Table + 3 indexes created; idempotent re-run is a no-op
  - [ ] No session-DB file is opened by this migration (central DB only)
- **Pre-conditions:** none.

### Task A2 — Session-DB read-path index `(series_id, seq DESC)`
- **File:** `src/db/schema.ts` (MODIFY — add the index to `INBOUND_SCHEMA` right after the existing `idx_messages_in_series` at schema.ts:192); `src/db/session-db.ts` (MODIFY — add the same `CREATE INDEX IF NOT EXISTS` to `migrateMessagesInTable` at session-db.ts:444)
- **Test file:** `src/db/session-db.test.ts` (MODIFY — add a case)
- **Operation:** MODIFY. Add `CREATE INDEX IF NOT EXISTS idx_messages_in_series_seq ON messages_in(series_id, seq DESC);` to both the baseline schema and the migrate function (design §4.8). Do not alter any other index or column.
- **Interface:** SQL index only; no API change.
  - ASSERT: index added in BOTH locations (fresh DBs via INBOUND_SCHEMA, existing DBs via migrateMessagesInTable).
  - ASSERT: no change to firing-path reads — index is additive, C1 untouched.
- **Named test cases:**
  ```
  test_migrate_adds_series_seq_index:
    Setup: in-memory inbound.db with old schema (idx_messages_in_series only)
    Action: call migrateMessagesInTable(db)
    Assert: idx_messages_in_series_seq present in sqlite_master; existing index still present
  test_fresh_schema_has_series_seq_index:
    Setup: apply INBOUND_SCHEMA to a fresh in-memory db
    Action: query sqlite_master for indexes on messages_in
    Assert: idx_messages_in_series_seq present
  ```
- **Acceptance criteria:**
  - [ ] Index present in fresh DBs (INBOUND_SCHEMA) and after migrate on existing DBs
  - [ ] `migrateMessagesInTable` remains idempotent
- **Pre-conditions:** none.

### Task A3 — Extend `TaskDef` with optional `script`
- **File:** `src/db/scheduled-tasks.ts` (MODIFY — add `script?: string` to the `TaskDef` interface ~scheduled-tasks.ts:32-80, and include it in the content-assembly object at ~:179-183)
- **Test file:** `src/db/scheduled-tasks.test.ts` (MODIFY)
- **Operation:** MODIFY. Add optional `script` field; when present, include it in the assembled `content` JSON. Existing callers (no `script`) must be byte-unaffected (field optional, omitted when undefined). Design §4.2 "Script preservation".
- **Interface:** `interface TaskDef { …existing…; script?: string }`
  - ASSERT: when `script` is undefined, the assembled content JSON has NO `script` key (existing callers unaffected — verify against `bootstrap.ts` callers that omit it).
  - ASSERT: when `script` is a string, content JSON includes `script` with that value.
  - ASSERT: no change to firing semantics — only the content payload widens (C1).
- **Named test cases:**
  ```
  test_scheduletask_omits_script_when_absent:
    Setup: TaskDef with no script, valid wired destination (mock)
    Action: scheduleTask(def)
    Assert: written messages_in.content JSON has no "script" key
  test_scheduletask_includes_script_when_present:
    Setup: TaskDef with script: "echo hi"
    Action: scheduleTask(def)
    Assert: content JSON has script === "echo hi"
  ```
- **Acceptance criteria:**
  - [ ] `script` optional; absent → no key in content; present → carried through
  - [ ] Existing scheduleTask callers/tests still pass unchanged
- **Pre-conditions:** none.

### Task A4 — `restoreTaskRow` + `cancelSeriesWithStrandClear` primitives
- **File:** `src/modules/scheduling/db.ts` (MODIFY — add two exported functions; do not alter `cancelTask`/`pauseTask`/`resumeTask`/`updateTask`/`insertRecurrence` signatures)
- **Test file:** `src/modules/scheduling/db.test.ts` (MODIFY)
- **Operation:** MODIFY. Add `restoreTaskRow(db, snapshot)` — an `insertRecurrence`-shape raw insert (modeled on db.ts:149-170) that preserves `series_id`, `recurrence`, `content`, destination columns, AND the snapshot's `status` (overriding insertRecurrence's hardcoded `'pending'`) — used by move compensation (§4.2 step 5) and by paused-snapshot staged restore (§4.2 4a). Add `cancelSeriesWithStrandClear(db, taskId)` — calls existing `cancelTask` semantics PLUS clears `recurrence` on terminal (`completed/failed/expired`) rows of the same series (§4.3 resurrection guard); returns touched-count = live-rows-cancelled + terminal-recurrence-clears.
- **Interface:**
  ```ts
  interface TaskRowSnapshot { id: string; series_id: string; status: 'pending'|'paused';
    process_after: string | null; recurrence: string | null; content: string;
    platform_id: string|null; channel_type: string|null; thread_id: string|null; kind: string }
  function restoreTaskRow(db: Database, snapshot: TaskRowSnapshot): void
  function cancelSeriesWithStrandClear(db: Database, taskId: string): number
  ```
  - ASSERT: `restoreTaskRow` preserves `series_id` exactly (NOT id — that would sever identity, db.ts:30-31 insertTask is the wrong primitive).
  - ASSERT: `restoreTaskRow` writes the snapshot's `status` (paused stays paused).
  - ASSERT: `cancelSeriesWithStrandClear` clears recurrence on terminal rows so `getCompletedRecurring` (db.ts:143-146) no longer mints a successor — but writes no NEW status value the firing path doesn't already read (C1: only sets recurrence=NULL, an existing operation).
  - ASSERT: touched-count includes both cancelled live rows and terminal clears (so the cancel verb is reachable on a pure strand — §4.0 footnote).
- **Named test cases:**
  ```
  test_restore_preserves_series_id_and_status:
    Setup: snapshot {series_id:'S', status:'paused', recurrence:'0 9 * * *', ...}
    Action: restoreTaskRow(db, snapshot)
    Assert: inserted row has series_id='S' AND status='paused' AND recurrence='0 9 * * *'
  test_cancel_strand_clear_clears_terminal_recurrence:
    Setup: series S with ONE terminal row status='completed' recurrence='0 9 * * *', no live row
    Action: cancelSeriesWithStrandClear(db, 'S')
    Assert: terminal row recurrence is NULL; returned count >= 1; getCompletedRecurring(db) returns no row for S
  test_cancel_strand_clear_live_and_terminal:
    Setup: series with one pending live row + one terminal recurrence-set row
    Action: cancelSeriesWithStrandClear(db, taskId)
    Assert: live row → completed+recurrence NULL; terminal row recurrence NULL; count === 2
  ```
- **Acceptance criteria:**
  - [ ] `restoreTaskRow` preserves series_id + status + recurrence + content + destination
  - [ ] `cancelSeriesWithStrandClear` makes a pure strand non-resurrectable and is reachable (count>0)
  - [ ] Existing scheduling/db.ts primitives unchanged (no signature edits)
- **Pre-conditions:** none.

### Task A5 — Verb×state matrix module (the single table-driven structure)
- **File:** `src/dashboard/api/scheduled-board-matrix.ts` (CREATE)
- **Test file:** `src/dashboard/api/scheduled-board-matrix.test.ts`
- **Operation:** CREATE. The authoritative §4.0 matrix as ONE exported data structure + the derivation function that maps (health-state, series-kind, claim/due facts) → available verbs and per-verb guard verdict. This is the `[NEEDS SPEC]` single-source-of-truth: every host handler AND (via API `available_verbs`) the frontend consume it.
- **Interface:**
  ```ts
  type HealthState = 'healthy'|'late'|'stalled'|'paused'|'processing'|'unknown'|'strand';
  type SeriesKind = 'recurring'|'one_off'|'thread_loop';
  type Verb = 'edit'|'pause'|'resume'|'run_now'|'cancel'|'move';
  const GUARD_GRACE_MS: number; // = max(2 * SWEEP_INTERVAL_MS, 120_000)
  interface VerbVerdict { allowed: boolean; status?: 409|503; reason?: string; needsForce?: boolean }
  function verbVerdict(verb: Verb, ctx: { state: HealthState; kind: SeriesKind;
    claimed: boolean; processAfterMs: number|null; nowMs: number }): VerbVerdict
  function availableVerbs(ctx): Verb[]  // verbs whose verdict.allowed === true
  ```
  - ASSERT: `GUARD_GRACE_MS === max(2*SWEEP_INTERVAL_MS, 120000)` — distinct from §4.1 stall grace (F4).
  - ASSERT: run_now × unknown → `{allowed:false, status:503, reason:'claim_state_unreadable'}` (F6, fail closed).
  - ASSERT: run_now × (late|stalled) with `claimed=false` → allowed (the remedy); with `claimed=true` → 409 source_busy.
  - ASSERT: run_now within GUARD_GRACE of next slot, not forced → `{allowed:false, needsForce:true}`; forced → allowed.
  - ASSERT: move × paused → allowed; move × (anything due/claimed: processAfterMs ≤ now, or claimed) → 409; move requires paused OR processAfterMs > now+GUARD_GRACE (F1 admission).
  - ASSERT: move/edit/pause × one_off → not allowed for move; edit/pause/cancel allowed (one_off mask); move × thread_loop → not allowed (v1).
  - ASSERT: kind columns are masks AND'd with state cells (axes-precedence: a verb is available only if BOTH the kind mask and the state cell allow it).
- **Named test cases:**
  ```
  test_guard_grace_constant: Assert GUARD_GRACE_MS === Math.max(2*SWEEP_INTERVAL_MS,120000)
  test_runnow_unknown_fails_closed: verbVerdict('run_now',{state:'unknown',...}) → {allowed:false,status:503}
  test_runnow_stalled_unclaimed_allowed: state stalled, claimed false → allowed true
  test_runnow_stalled_claimed_409: state stalled, claimed true → {allowed:false,status:409}
  test_move_paused_allowed: state paused → move allowed
  test_move_due_pending_409: state late, processAfter ≤ now → move {allowed:false,status:409}
  test_move_thread_loop_blocked: kind thread_loop → move not in availableVerbs
  test_cancel_strand_allowed: state strand → cancel in availableVerbs (the strand remedy)
  ```
- **Acceptance criteria:**
  - [ ] Single exported `verbVerdict`/`availableVerbs` used as the only guard source (no handler re-implements guards)
  - [ ] All eight named cases pass; GUARD_GRACE distinct from stall grace
  - [ ] Render-check: N/A (no visual decision in this task)
- **Pre-conditions:** none.

### Task A6 — Shared mutation helpers (gate, audit writer, rate-limit, `:key` codec, cache singleton)
- **File:** `src/dashboard/api/scheduled-shared.ts` (CREATE)
- **Test file:** `src/dashboard/api/scheduled-shared.test.ts`
- **Operation:** CREATE. Host-side helpers shared by B/C/D. (1) `canManageScheduled(userId)` = owner ∥ global-admin using `isOwner`/`isGlobalAdmin` (steer.ts precedent) — D7. (2) `writeAudit(db, entry)` — hashes bodies via createHash (steer.ts:17), 512-char previews, scripts hash-only, never verbatim; for `move_intent` writes full snapshot to detail_json, and `purgeIntentBody(db, correlationId)` clears detail_json on resolve (F5). (3) `rateLimit(userId, verb)` reusing the steer rateLimitMap precedent for run_now + move. (4) `encodeKey/decodeKey` base64url of `agentGroupId/sessionId/seriesId` — a LOCATOR, never an authz input. (5) `scheduledCache` singleton: TTL store + generation counter + `invalidateScheduledCache()` (bumps generation) — design §3a.
- **Interface:**
  ```ts
  function canManageScheduled(userId: string): boolean
  interface AuditEntry { actor, action, agentGroupId, sessionId, seriesId,
    before?: string, after?: string, detail?: object, correlationId?: string }
  function writeAudit(db: Database, e: AuditEntry): void   // hashes/truncates per §4.4
  function purgeIntentBody(db: Database, correlationId: string): void  // sets detail_json=NULL, resolved_at=now
  function rateLimit(userId: string, verb: 'run_now'|'move'): { ok: boolean; retryAfter?: number }
  function encodeKey(agentGroupId, sessionId, seriesId): string
  function decodeKey(key: string): { agentGroupId, sessionId, seriesId } | null
  function getScheduledCache(): { gen: number; data: ScheduledSnapshot | null; expiresMs: number }
  function invalidateScheduledCache(): void   // bumps gen, clears data
  ```
  - ASSERT: `writeAudit` NEVER stores a verbatim script — scripts are hash-only EXCEPT the `move_intent` detail_json snapshot (the one F5 exception).
  - ASSERT: `purgeIntentBody` nulls detail_json AND stamps resolved_at in one statement (F5 — body lives only until resolve).
  - ASSERT: `decodeKey` of a malformed/non-base64url string returns null (no throw — handler maps to 400).
  - ASSERT: `canManageScheduled` returns false for member/scoped-admin/unknown; true only for owner|global-admin (D7).
  - ASSERT: `invalidateScheduledCache` strictly increases `gen` (generation-counter for read-your-own-write, §3a / S2).
- **Named test cases:**
  ```
  test_audit_script_hash_only: writeAudit with after containing a script → stored after_preview is NOT the script; after_hash present
  test_purge_intent_clears_body: writeAudit move_intent (detail set) → purgeIntentBody → detail_json NULL, resolved_at set
  test_gate_rejects_member: canManageScheduled(memberId) === false
  test_gate_allows_owner: canManageScheduled(ownerId) === true
  test_decodekey_malformed_null: decodeKey('@@not-b64@@') === null
  test_invalidate_bumps_gen: gen0 = getScheduledCache().gen; invalidateScheduledCache(); assert getScheduledCache().gen > gen0
  ```
- **Acceptance criteria:**
  - [ ] Gate owner/global-admin only; audit hashes bodies (scripts hash-only); intent body purged on resolve
  - [ ] `:key` is decode-validated and never used for authz; cache generation strictly increases on invalidate
- **Pre-conditions:** none. (A5 and A6 are independent; both are leaf modules.)

## Group B: Read Layer

Owns the snapshot assembly + health derivation + the two GET endpoints. Pre-condition: Group A complete (imports matrix, shared cache, `:key` codec, scope helpers).

### Task B1 — Chunked assembly + TTL cache + generation guard
- **File:** `src/dashboard/api/scheduled-assembly.ts` (CREATE)
- **Test file:** `src/dashboard/api/scheduled-assembly.test.ts`
- **Operation:** CREATE. Assemble the fleet snapshot by opening each authorized group's session DBs read-only, ONE session per event-loop tick via `setImmediate` (design §4.9 — never one contiguous block). All opens `{readonly:true}` + `busy_timeout=1000` (sessions.ts:123 precedent). Single-flight: concurrent callers await the same in-flight promise. Populate `getScheduledCache()` only if the assembly's start-generation still matches (§3a / S2 — a mutation that bumped gen mid-assembly forces a re-run, guaranteeing read-your-own-write). Per-session read failure → that session contributes `unreadable` entries, never fails the whole snapshot (S12). Instrument wall-time: >1s warn-log; >3s serve last cache with `degraded:true` (S8).
- **Interface:**
  ```ts
  interface ScheduledRow { key: string; series_id: string; agent_group_id: string;
    agent_group_name: string; provider: string|null; channel_name: string|null;
    channel_type: string|null; thread_id: string|null; kind: SeriesKind;
    cron: string|null; next_fire_utc: string|null; next_fire_local: string|null;
    health: HealthState; module_owner: string|null; quiet_status: boolean;
    flag_intent: object|null; last_fires: FireOutcome[]; available_verbs: Verb[] }
  interface ScheduledSnapshot { rows: ScheduledRow[]; degraded: boolean;
    counts: Record<HealthState|'unreadable'|'one_off', number>; assembled_at: string }
  function assembleSnapshot(scopes: AuthScopes): Promise<ScheduledSnapshot>
  ```
  - ASSERT: assembly yields to the event loop between sessions (`setImmediate`) — never blocks for the full sweep (§4.9).
  - ASSERT: a mutation invalidation during assembly causes the stale snapshot NOT to populate the cache (gen mismatch) — S2.
  - ASSERT: an unreadable session DB produces `unreadable` rows + increments the `unreadable` count; the snapshot still returns for all other sessions (S12).
  - ASSERT: read uses the latest-row-per-series shape (list-scheduled-tasks.ts:119-128) + the capped last-5 history widening; NO materialized table is created for reads (D10 rejected — reads are on-demand from source).
  - ASSERT: every board open is `{readonly:true}` busy_timeout 1000 — never the 5000ms write-path timeout.
- **Named test cases:**
  ```
  test_assembly_yields_between_sessions:
    Setup: 3 mock session dirs; spy on setImmediate
    Action: assembleSnapshot
    Assert: setImmediate invoked >= once per session (non-blocking)
  test_gen_mismatch_skips_cache_populate:
    Setup: start assembly; call invalidateScheduledCache() before it resolves
    Action: await assembleSnapshot
    Assert: getScheduledCache().data is null/not the stale snapshot (was not populated under stale gen)
  test_unreadable_session_is_partial:
    Setup: 2 sessions, one inbound.db chmod-unreadable / corrupt
    Action: assembleSnapshot
    Assert: rows from the good session present; counts.unreadable >= 1; no throw
  ```
- **Acceptance criteria:**
  - [ ] Non-blocking chunked assembly; gen-guarded cache populate; partial snapshot on per-session failure
  - [ ] No materialized read table (reads from session DBs on demand) — C5/D10
  - [ ] A3 validation: log warm assembly wall-time; record the measured number in the build commit message (assumption A3 check)
- **Pre-conditions:** A5, A6 complete.

### Task B2 — Health derivation (all detectors)
- **File:** `src/dashboard/api/scheduled-assembly.ts` (same file, the health functions B1 calls)
- **Test file:** `src/dashboard/api/scheduled-assembly.test.ts` (add cases)
- **Operation:** MODIFY (same-file continuation). Implement `deriveHealth(row, ackPresent, outboundReadable, nowMs)` exactly per design §4.1: `paused`; `processing` (positive claim); `unknown` (outbound unreadable AND overdue — never collapsed to not-claimed); `late` (overdueBy>0, visible immediately); `stalled` (overdueBy > min(max(interval×0.5, 2×SWEEP_INTERVAL), 24h)); `healthy`. Plus residual-strand detection (terminal-with-recurrence + no live row, persisting > 2×SWEEP_INTERVAL via `now − max(timestamp, process_after)`) and duplicate-successor detection (GROUP BY series_id HAVING count(pending/paused)>1 → flag both rows). Cron interval via `CronExpressionParser.parse(cron,{tz:TIMEZONE})` — identical to recurrence.ts:31.
- **Interface:** `function deriveHealth(row, ctx): HealthState` (+ the strand/dup scanners feeding B1).
  - ASSERT: a row overdue with outbound.db unreadable → `unknown` (NOT stalled, NOT healthy) — claim-state honesty (F6/S9).
  - ASSERT: stall grace is capped at 24h absolute — a weekly series late by 2 days is `stalled`, not `healthy` (S11).
  - ASSERT: a terminal-with-recurrence row, no live successor, aged > 2×SWEEP_INTERVAL → `strand` (the swallowed-parse-error signature, §4.1).
  - ASSERT: two live rows for one series → both flagged (duplicate-successor; the latest-row read shape alone would hide one).
  - ASSERT: health is DERIVED, never read from `status` alone (D6 — the May/June die-off left no failed row).
- **Named test cases:**
  ```
  test_unknown_when_outbound_unreadable_and_overdue: overdue row + outboundReadable=false → 'unknown'
  test_stall_grace_capped_24h: weekly cron, overdue 48h → 'stalled' (not healthy)
  test_late_visible_immediately: overdue 1min, within grace → 'late'
  test_strand_detected: terminal row recurrence set, no live row, aged 3 sweeps → 'strand'
  test_duplicate_successor_flagged: two pending rows same series → health flags both
  test_healthy_within_grace: pending, process_after 1h future → 'healthy'
  ```
- **Acceptance criteria:**
  - [ ] All six derivation cases pass; strand + duplicate detectors present
  - [ ] Stall never derived from `status` alone; 24h cap enforced
- **Pre-conditions:** B1 scaffolding (same file).

### Task B3 — `GET /dashboard/api/scheduled` (list)
- **File:** `src/dashboard/api/scheduled-read.ts` (CREATE — exports `scheduledListHandler`)
- **Test file:** `src/dashboard/api/scheduled-read.test.ts`
- **Operation:** CREATE. AuthHandler that returns the cached snapshot (or triggers single-flight assembly), filtered by the caller's scope (sessions.ts:207-224 pattern, disclose-as-not-found — C7). Serves cache when warm (<5s); cold → awaits assembly.
- **Interface:** `GET /dashboard/api/scheduled → 200 { rows: ScheduledRow[], counts, degraded, assembled_at }` (rows scope-filtered).
  - ASSERT: a scoped admin sees only rows for their `allowed_group_ids`; owner/no_filter sees all (C7 — fleet-wide = authorized groups, not bypass).
  - ASSERT: `available_verbs` present on every row (frontend renders buttons from this — the single-source matrix output).
  - ASSERT: response includes `degraded` flag when assembly exceeded the budget (S8).
- **Named test cases:**
  ```
  test_list_scope_filters_rows: scoped-admin of group X → rows all have agent_group_id in allowed set
  test_list_owner_sees_all: owner (no_filter) → rows span multiple groups
  test_list_includes_available_verbs: each row has a non-undefined available_verbs array
  ```
- **Acceptance criteria:**
  - [ ] Scope-filtered list; `available_verbs` + `counts` + `degraded` present
  - [ ] Warm cache served without re-assembly within TTL
- **Pre-conditions:** B1, B2 complete.

### Task B4 — `GET /dashboard/api/scheduled/:key` (detail)
- **File:** `src/dashboard/api/scheduled-read.ts` (same file — exports `scheduledDetailHandler`)
- **Test file:** `src/dashboard/api/scheduled-read.test.ts` (add cases)
- **Operation:** MODIFY (same file). Detail handler: decode `:key`, re-resolve the series, return full prompt/script, last-5 fire history, per-fire outcome labels (ran / completed-no-output / failed / missed / cancelled per §4.1), and the audit tail. **Scope-filtered (C7): out-of-scope key → 404.** Audit tail served ONLY at mutation tier (`canManageScheduled`); read-tier detail omits it (M5).
- **Interface:** `GET /dashboard/api/scheduled/:key → 200 { row, prompt, script, history: FireOutcome[], audit_tail?: AuditRow[] } | 404`
  - ASSERT: out-of-scope `:key` → 404 disclose-as-not-found (C7), not 403.
  - ASSERT: `audit_tail` present ONLY when caller passes `canManageScheduled`; absent for read-only callers (M5 — delta names never leak at read tier).
  - ASSERT: history outcome labels derived per §4.1 (completed+reply=ran; completed+no reply="completed (no chat output)" — the F-amendment merge, D16).
- **Named test cases:**
  ```
  test_detail_out_of_scope_404: scoped-admin requests a key for a group not in allowed set → 404
  test_detail_audit_tail_mutation_tier_only: read-only caller → response has no audit_tail; owner → audit_tail present
  test_detail_history_labels: a completed fire with a messages_out reply → outcome 'ran'; completed w/o reply → 'completed (no chat output)'
  ```
- **Acceptance criteria:**
  - [ ] Out-of-scope key 404s; audit tail gated to mutation tier; history labels correct
- **Pre-conditions:** B1, B2 complete.

## Group D: Move Flow

Owns the move preview/execute endpoints and the sweep recovery hook — the F1-F6 complexity concentrated. Pre-condition: A + B complete (imports matrix, restoreTaskRow, shared helpers, cache invalidation).

### Task D1 — `POST /dashboard/api/scheduled/:key/move/preview`
- **File:** `src/dashboard/api/scheduled-move.ts` (CREATE — exports `movePreviewHandler`)
- **Test file:** `src/dashboard/api/scheduled-move.test.ts`
- **Operation:** CREATE. Gated at MUTATION tier (`canManageScheduled` — it reads vault secret names; M5/SEC-1). Resolve target MG (translate `channel_type` to the target group's sibling variant — same platform_id; design §2 A1). Run scheduleTask's wiring validation WITHOUT writing. Compute the secret-scope delta as NAMES (per-group onecliSecrets ∪ workgroup baseline) — names only, never values, enumeration bounded to source∪target (D8). Return `deltaHash` for the execute TOCTOU re-check.
- **Interface:** `POST /scheduled/:key/move/preview {targetAgentGroupId, targetMessagingGroupId} → 200 { wiringOk, gains:string[], losses:string[], crossWorkgroup:boolean, scriptPresent:boolean, environmentDeltaChecked:false, deltaHash } | 403 | 409`
  - ASSERT: preview requires `canManageScheduled` (owner/global-admin) — a scoped admin CANNOT enumerate a target's secret names (M5/SEC-1).
  - ASSERT: gains/losses are secret NAMES/UUIDs only; no secret VALUES appear in the response (D8).
  - ASSERT: `environmentDeltaChecked:false` is returned (v1 checks secrets only; W2 — config delta is v2).
  - ASSERT: unwired (target group, target channel) pair → preview reports `wiringOk:false` (fail-closed, C2).
- **Named test cases:**
  ```
  test_preview_requires_mutation_tier: scoped-admin caller → 403 (cannot enumerate target secret names)
  test_preview_returns_names_not_values: gains/losses contain secret identifiers; no value-shaped strings
  test_preview_unwired_target: target group not wired to target channel → wiringOk:false
  test_preview_emits_delta_hash: response has a stable deltaHash for the same inputs
  ```
- **Acceptance criteria:**
  - [ ] Mutation-tier gated; names-only delta; wiringOk false on unwired; deltaHash present
- **Pre-conditions:** A5, A6, B1 complete.

### Task D2 — `POST /dashboard/api/scheduled/:key/move` (execute)
- **File:** `src/dashboard/api/scheduled-move.ts` (same file — exports `moveExecuteHandler`)
- **Test file:** `src/dashboard/api/scheduled-move.test.ts` (add cases)
- **Operation:** MODIFY (same file). The §4.2 execute sequence with ALL F1/F2/F5 fixes: (0) re-check authz+scope+wiring from decoded `:key`/body independent of preview; (1) re-compute delta, 409 `delta_changed` if hash ≠ client-echoed; (2) **§4.0 in-flight guard** via `verbVerdict('move',…)` — 409 `source_busy` unless paused OR pending+`process_after > now+GUARD_GRACE`; (2b) write durable `move_intent` audit row (full snapshot in detail_json, correlation_id) BEFORE cancel; (3) `cancelTask(source)`; (4) `scheduleTask(target, snapshot incl. script)` preserving process_after; (4a) **staged paused-insert** if snapshot was paused: insert at `now+GUARD_GRACE` → `pauseTask(target)` → `updateTask(target,{processAfter: snapshot})` (F1 — never simultaneously pending+due); (5) on insert failure `restoreTaskRow(source)` — never delete a succeeded target; double-failure → `move_restore_failed` record; (6) verify exactly-one-live-row fleet-wide; (7) stamp resolved_at + `purgeIntentBody` (F5); invalidate cache. Rate-limited (run_now+move; A14/S10).
- **Interface:** `POST /scheduled/:key/move {targetAgentGroupId, targetMessagingGroupId, confirmedDeltaHash} → 200 {moved:true} | 403 | 409 (source_busy|delta_changed|stale_key) | 429`
  - ASSERT: move is cancel-source-then-insert-target (C2); insert-first is NOT used (D14 rejected).
  - ASSERT: a paused source move never leaves a pending+due target before pause lands (F1 staged insert) — verify the row is paused before any due `process_after` is written.
  - ASSERT: `move_intent` row written BEFORE cancelTask (F2/M2 durability) and detail_json purged on resolve (F5).
  - ASSERT: post-move invariant — exactly ONE live (pending/paused, recurrence-set) row fleet-wide for the series (C2).
  - ASSERT: a stale `:key` (touched 0 rows) → 409 stale_key, never a silent no-op (§3b).
  - ASSERT: changed delta between preview and execute → 409 delta_changed (TOCTOU, SEC-2).
- **Named test cases:**
  ```
  test_move_paused_stages_insert_never_due_pending:
    Setup: paused source row, process_after in the past
    Action: moveExecute
    Assert: at no observable point is the target row (status='pending' AND process_after<=now); final target status='paused' with original process_after
  test_move_writes_intent_before_cancel:
    Setup: spy on writeAudit + cancelTask ordering
    Action: moveExecute
    Assert: move_intent audit write precedes cancelTask
  test_move_one_live_row_invariant:
    Setup: healthy future-dated source
    Action: moveExecute
    Assert: exactly one pending recurrence-set row fleet-wide for the series after; source row terminal
  test_move_delta_changed_409:
    Setup: confirmedDeltaHash ≠ recomputed
    Action: moveExecute → 409 delta_changed
  test_move_due_source_409_source_busy:
    Setup: pending source, process_after <= now
    Action: moveExecute → 409 source_busy (no cancel performed)
  test_move_compensation_restores_source:
    Setup: scheduleTask(target) throws (mock)
    Action: moveExecute
    Assert: restoreTaskRow called; source live again; returns error; no orphaned target
  ```
- **Acceptance criteria:**
  - [ ] Cancel-first; staged paused insert (F1); intent-before-cancel + purge-on-resolve (F2/F5); one-live-row invariant; delta/stale 409s; rate-limited
- **Pre-conditions:** A4, A5, A6, B1, D1 complete.

### Task D3 — Sweep recovery hook for unresolved move intents
- **File:** `src/host-sweep.ts` (MODIFY — add a new MODULE-HOOK block, same additive pattern as `scheduling-recurrence` at host-sweep.ts:344-347; no firing-path change)
- **Test file:** `src/host-sweep.test.ts` (MODIFY)
- **Operation:** MODIFY. Add a sweep step that consumes `move_intent` rows with `resolved_at IS NULL` older than one sweep interval. Predicate is FLEET-WIDE (F2/M10): if ANY live row exists for the series_id → stamp resolved_at (+purge body); else `restoreTaskRow` from the intent snapshot, re-checking zero-live-rows immediately before insert (idempotent — a crash between restore and stamp must make the next pass a no-op), then stamp + purge. This makes move recovery autonomous, not just observable.
- **Interface:** internal sweep hook `recoverMoveIntents(centralDb): void` invoked once per sweep tick.
  - ASSERT: recovery predicate checks live rows FLEET-WIDE, not target-only (F2 — a crash before cancel leaves the SOURCE live; a target-only check would double-restore).
  - ASSERT: `restoreTaskRow` re-checks zero-live-rows immediately before insert (idempotent compensation; crash between restore and stamp → next pass no-op, M10/B3-MEDIUM).
  - ASSERT: hook is additive — does not alter the recurrence advance, watchdog, or reconciler steps (C1; same MODULE-HOOK pattern).
  - ASSERT: resolving an intent purges its detail_json snapshot (F5).
- **Named test cases:**
  ```
  test_recover_stamps_when_live_row_exists:
    Setup: unresolved move_intent older than a sweep; a live row exists for the series
    Action: recoverMoveIntents
    Assert: intent.resolved_at set; detail_json NULL; no restore performed
  test_recover_restores_when_zero_live_rows:
    Setup: unresolved intent, no live row fleet-wide (simulated crash post-cancel)
    Action: recoverMoveIntents
    Assert: restoreTaskRow inserted a live row from the snapshot; resolved_at set; body purged
  test_recover_idempotent_no_double_restore:
    Setup: intent already resolved by a prior pass (resolved_at set)
    Action: recoverMoveIntents again
    Assert: no second restore; no new row
  ```
- **Acceptance criteria:**
  - [ ] Fleet-wide predicate; idempotent restore; additive hook (firing path untouched); body purged on resolve
- **Pre-conditions:** A4, A6, D2 complete (shares the move-intent contract).

## Group C: Simple Mutations & Route Registration

Owns the five non-move mutation handlers and the single route-registration edit. Pre-condition: A + B + D complete (registration imports B's GET handlers and D's move handlers). All handlers: `canManageScheduled` gate, decode `:key`, apply `verbVerdict`, `writeAudit`, `invalidateScheduledCache` after write.

### Task C1 — `PUT /dashboard/api/scheduled/:key` (edit prompt/script/cron)
- **File:** `src/dashboard/api/scheduled-mutations.ts` (CREATE — exports `editHandler`)
- **Test file:** `src/dashboard/api/scheduled-mutations.test.ts`
- **Operation:** CREATE. Edit via `updateTask` (db.ts:78 — merges prompt/script into content, sets recurrence/process_after columns). `verbVerdict('edit')` → 409 source_busy if claimed. Cron edits recompute `process_after` via `CronExpressionParser.parse(cron,{tz:TIMEZONE})` (M6 — else the board shows new cron while old slot fires). Validate cron with the firing-path parser; reject invalid with 400. Bounds: prompt ≤ 8000, script ≤ 4000 (C8). Audit before/after (hashed).
- **Interface:** `PUT /scheduled/:key {prompt?, script?, cron?} → 200 {updated:true} | 400 (bad_cron|too_long) | 403 | 409 (source_busy|stale_key)`
  - ASSERT: a cron edit recomputes `process_after` to the next occurrence (M6) — not left at the old slot.
  - ASSERT: invalid cron string → 400 bad_cron (parser-validated, identical call to recurrence.ts:31); never silently accepted (would create a strand).
  - ASSERT: prompt >8000 or script >4000 → 400 too_long (C8).
  - ASSERT: edit on a claimed row → 409 source_busy (matrix).
- **Named test cases:**
  ```
  test_edit_cron_recomputes_process_after: PUT cron '0 6 * * *' on a row at 09:00 slot → process_after now reflects next 06:00, not 09:00
  test_edit_invalid_cron_400: PUT cron 'not a cron' → 400 bad_cron
  test_edit_script_too_long_400: PUT script of 4001 chars → 400 too_long
  test_edit_claimed_409: claimed row → 409 source_busy
  ```
- **Acceptance criteria:**
  - [ ] Cron edit recomputes slot; invalid cron 400; bounds enforced; claimed 409; audited
- **Pre-conditions:** A5, A6 complete.

### Task C2 — pause / resume
- **File:** `src/dashboard/api/scheduled-mutations.ts` (same file — `pauseHandler`, `resumeHandler`)
- **Test file:** `src/dashboard/api/scheduled-mutations.test.ts` (add cases)
- **Operation:** MODIFY. Pause → `pauseTask` (verbVerdict gates: 409 on claimed). Resume → recompute `process_after` to next cron slot via the canonical parse, THEN `resumeTask` (§4.7 — skip-don't-replay, D3-decision). Both audit + invalidate.
- **Interface:** `POST /scheduled/:key/pause → 200 | 409`; `POST /scheduled/:key/resume → 200 | 409`
  - ASSERT: resume recomputes `process_after` to the next future slot before flipping to pending — a paused-past-its-slot series does NOT fire immediately on resume (§4.7, D3 rejected catch-up).
  - ASSERT: pause on a claimed row → 409 source_busy.
- **Named test cases:**
  ```
  test_resume_recomputes_slot_no_immediate_fire: pause a daily task, advance clock past 2 slots, resume → process_after is a FUTURE slot, not now/past
  test_pause_claimed_409: claimed row → 409 source_busy
  test_pause_then_resume_roundtrip: pause → status paused; resume → status pending, future process_after
  ```
- **Acceptance criteria:**
  - [ ] Resume skips missed slots (recompute); pause 409 on claimed; both audited
- **Pre-conditions:** A5, A6 complete.

### Task C3 — run-now
- **File:** `src/dashboard/api/scheduled-mutations.ts` (same file — `runNowHandler`)
- **Test file:** `src/dashboard/api/scheduled-mutations.test.ts` (add cases)
- **Operation:** MODIFY. `verbVerdict('run_now')`: 503 `claim_state_unreadable` on `unknown` (F6); 409 source_busy on positive claim; within GUARD_GRACE of next slot without `force` → 409 needs_force. Otherwise `updateTask(process_after=now)` + `wakeContainer(session)`. `force=true` fires with the documented residual (F3 — confirm copy lives frontend-side). Rate-limited.
- **Interface:** `POST /scheduled/:key/run-now {force?:boolean} → 200 {fired:true} | 409 (source_busy|needs_force) | 503 (claim_state_unreadable) | 429`
  - ASSERT: run-now on `unknown` health → 503 claim_state_unreadable (F6 fail-closed — never fire when claim state is unknowable).
  - ASSERT: unclaimed overdue (late/stalled) row → fires (the remedy); claimed → 409.
  - ASSERT: within GUARD_GRACE of next slot and not forced → 409 needs_force; `force:true` → fires (F3).
  - ASSERT: rate-limited per-user (S10).
- **Named test cases:**
  ```
  test_runnow_unknown_503: health unknown → 503 claim_state_unreadable, no wake
  test_runnow_stalled_unclaimed_fires: late+unclaimed → updateTask(now)+wakeContainer called
  test_runnow_near_slot_needs_force: process_after within GUARD_GRACE, force absent → 409 needs_force
  test_runnow_force_fires: same, force:true → 200 fired
  test_runnow_rate_limited: rapid repeat → 429
  ```
- **Acceptance criteria:**
  - [ ] 503 on unknown; fires unclaimed-overdue; needs_force near slot; force overrides; rate-limited
- **Pre-conditions:** A5, A6 complete.

### Task C4 — cancel
- **File:** `src/dashboard/api/scheduled-mutations.ts` (same file — `cancelHandler`)
- **Test file:** `src/dashboard/api/scheduled-mutations.test.ts` (add cases)
- **Operation:** MODIFY. Cancel via `cancelSeriesWithStrandClear` (A4) — ends live rows AND clears terminal-row recurrence so a strand is reachable and non-resurrectable (§4.3/§4.0 footnote). Audit `action='cancel'` (the join key history uses to label board-cancellations vs natural completion, §4.3). touched 0 → 409 stale_key.
- **Interface:** `POST /scheduled/:key/cancel → 200 {cancelled:true} | 409 stale_key`
  - ASSERT: cancel on a pure strand (no live row, terminal recurrence set) succeeds (touched>0 via terminal clear) — NOT a 409 stale_key (§4.0 footnote / A2#1 from cycle 2).
  - ASSERT: a board-cancel writes `action='cancel'` audit so history can distinguish it from natural completion (§4.3).
  - ASSERT: after cancel, `getCompletedRecurring` mints no successor for the series (resurrection guard).
- **Named test cases:**
  ```
  test_cancel_strand_succeeds: pure strand → 200 cancelled (not 409)
  test_cancel_writes_audit: cancel → scheduled_audit row action='cancel' for the series
  test_cancel_no_resurrection: cancel a series with terminal recurrence residue → getCompletedRecurring returns nothing for it
  ```
- **Acceptance criteria:**
  - [ ] Strand cancellable; audit action='cancel' written; no resurrection
- **Pre-conditions:** A4, A5, A6 complete.

### Task C5 — Module-owned detection + confirm metadata
- **File:** `src/dashboard/api/scheduled-mutations.ts` (same file — `moduleOwner(seriesId)` helper used by all handlers + the read assembly via import)
- **Test file:** `src/dashboard/api/scheduled-mutations.test.ts` (add cases)
- **Operation:** MODIFY. Implement the module-owned registry: series-id prefix matching (`memory-synth-*`, `memory-lint-*`) + a static map for mnemon/support series → `{moduleOwned:true, owner}` (D2). Surfaced in list/detail payloads (B imports this) and echoed so the frontend shows the badge + reseed-warning confirm. **A2 validation:** the build must cross-check this registry against the live fleet's 22 module series.
- **Interface:** `function moduleOwner(seriesId: string): { moduleOwned: boolean; owner?: string }`
  - ASSERT: `memory-synth-<group>` and `memory-lint-<group>` → moduleOwned true, owner 'memory'.
  - ASSERT: an operator series id (e.g. `task-morning-briefing`) → moduleOwned false.
  - ASSERT (A2 — Known Risk validation): registry recognizes all module series present in the live fleet (cross-checked at build; if any unmatched, extend the static map and note in commit).
- **Named test cases:**
  ```
  test_module_synth_detected: moduleOwner('memory-synth-ag-xyz') → {moduleOwned:true, owner:'memory'}
  test_operator_task_not_module: moduleOwner('task-morning-briefing') → {moduleOwned:false}
  test_mnemon_static_map: moduleOwner(<a known mnemon series id>) → moduleOwned true
  ```
- **Acceptance criteria:**
  - [ ] Prefix + static-map detection; A2 cross-checked against live fleet (recorded in commit)
- **Pre-conditions:** A6 complete.

### Task C6 — Register all 9 routes
- **File:** `src/dashboard/index.ts` (MODIFY — add 9 `register(...)` lines in the auth-gated block, ~index.ts:50-65, following the exact `requireAuth(handler)` pattern; import the handlers from scheduled-read.ts, scheduled-mutations.ts, scheduled-move.ts)
- **Test file:** none — reason: pure wiring (route table registration), validated end-to-end by the handler tests + integration; no branching logic.
- **Operation:** MODIFY. Register the nine routes from design §3b with `requireAuth`. Splat static route must remain LAST (existing constraint at index.ts).
- **Interface:**
  ```
  GET  /dashboard/api/scheduled                  → scheduledListHandler
  GET  /dashboard/api/scheduled/:key             → scheduledDetailHandler
  PUT  /dashboard/api/scheduled/:key             → editHandler
  POST /dashboard/api/scheduled/:key/pause       → pauseHandler
  POST /dashboard/api/scheduled/:key/resume      → resumeHandler
  POST /dashboard/api/scheduled/:key/run-now     → runNowHandler
  POST /dashboard/api/scheduled/:key/cancel      → cancelHandler
  POST /dashboard/api/scheduled/:key/move/preview→ movePreviewHandler
  POST /dashboard/api/scheduled/:key/move        → moveExecuteHandler
  ```
  - ASSERT: all 9 wrapped in `requireAuth` (C4 — auth before handler).
  - ASSERT: the static `*tail` splat route still registers LAST (route-table first-match ordering).
  - ASSERT: route names use `scheduled`, never the `tasks` namespace (naming-collision note — spawn board owns `tasks`).
- **Named test cases:** none (wiring). Verified by `getRoutes()` snapshot in an existing dashboard router test if present, else by integration.
- **Acceptance criteria:**
  - [ ] 9 routes registered under `/dashboard/api/scheduled`, all `requireAuth`-wrapped, splat last
- **Pre-conditions:** B3, B4, C1-C5, D1, D2 complete (imports their handler symbols).

## Group E: Frontend (dashboard/src/)

Owns the Scheduled view — separate build tree (Vite/React/vitest-jsdom), zero file overlap with host groups. Builds against the frozen API contract (Groups B/C/D interfaces). Parallel with the host chain from plan approval. Reuses `BoardShell` primitives (BoardFrame/BoardBrand/RouteNav/GroupTitle/ShowArchivedToggle) and the SWR+SSE pattern from `InboxBoard.tsx`.

### Task E1 — ScheduledBoard shell + health strip
- **File:** `dashboard/src/views/ScheduledBoard.tsx` (CREATE)
- **Test file:** `dashboard/src/views/ScheduledBoard.test.tsx`
- **Operation:** CREATE. Top-level view (mirror `InboxBoard.tsx` structure): SWR `useSWR(['/dashboard/api/scheduled', groupFilter], listScheduled)` with `refreshInterval: 45_000` (S3 backstop) + SSE `subscribe('session_event', invalidate)` with the 300ms debounce (InboxBoard.tsx:88-104 pattern). Render the health summary strip: counts for stalled / late / unknown / unreadable / paused / healthy / one-off, **stalled items enumerated inline, always first** (design §3c, §4.1).
- **Interface:** `export const ScheduledBoard: React.FC<{ authMe: AuthMe; route: BoardRoute; onRouteChange: (r:BoardRoute)=>void }>`
  - ASSERT: default sort surfaces unhealthy (stalled/late/unknown) rows first — a die-off is the first thing visible, never row 28 (design §3c, the feature's reason for being).
  - ASSERT: strip shows distinct `unknown` and `unreadable` (grey) counts — observability failures are visible at the summary layer (S14).
  - ASSERT: `degraded:true` from the API renders a visible degraded indicator on the strip (S8).
  - **[RENDER-CHECK NEEDED]** health-pill palette (stalled = attention-red on dark card bg) — design §3c flag.
- **Named test cases:**
  ```
  test_strip_renders_counts: given a snapshot with {stalled:1,late:2,healthy:5,...} → strip shows each count
  test_unhealthy_sorted_first: rows include a stalled + healthy → stalled appears before healthy in the list
  test_degraded_indicator: snapshot degraded:true → degraded indicator present
  ```
- **Acceptance criteria:**
  - [ ] Strip with all health counts incl. unknown/unreadable; unhealthy-first sort; degraded indicator
  - [ ] Render-check: lead must visually verify the health-pill palette (stalled-red on dark card) matches design intent after build — via `pnpm --filter dashboard dev` + screenshot (playwright MCP) or explicit human approval. Builder implements the tokens; lead verifies contrast. (§3c [RENDER-CHECK NEEDED])
- **Pre-conditions:** E5 (api client) for the typed fetchers — same group, sequence E5 before E1's data wiring or stub the types inline.

### Task E2 — Grouped list (agent-group sections)
- **File:** `dashboard/src/views/ScheduledBoard.tsx` (same file)
- **Test file:** `dashboard/src/views/ScheduledBoard.test.tsx` (add cases)
- **Operation:** MODIFY (same file). Body: collapsible sections grouped by agent group; each row shows name, channel + thread/root, cron + next fire (UTC + service-local — both, C6), ownership badge (module-owned → badge with owner), health pill, last-fired. Row click → opens the drawer (E4).
- **Interface:** internal `<GroupSection>` / `<ScheduledRow>` components.
  - ASSERT: each row shows BOTH UTC and service-local next-fire (C6).
  - ASSERT: module-owned rows render the owner badge (D2).
  - ASSERT: next-fire/health/cron come from the API row (no client-side health re-derivation — single source).
- **Named test cases:**
  ```
  test_row_shows_utc_and_local: a row with next_fire_utc + next_fire_local → both rendered
  test_module_badge_rendered: module_owner set → badge visible with owner name
  test_row_click_opens_drawer: click a row → drawer open state true with that row's key
  ```
- **Acceptance criteria:**
  - [ ] Grouped collapsible sections; dual-time display; module badge; row→drawer
- **Pre-conditions:** E1 scaffolding.

### Task E3 — Filters + search
- **File:** `dashboard/src/views/ScheduledBoard.tsx` (same file)
- **Test file:** `dashboard/src/views/ScheduledBoard.test.tsx` (add cases)
- **Operation:** MODIFY (same file). Toolbar: group filter (reuse `useGroupFilter`), ownership filter (operator vs module-owned), health filter, free-text search over prompt. Client-side filtering of the already-fetched snapshot rows.
- **Interface:** internal filter state + `filterRows(rows, filters)` pure function.
  - ASSERT: ownership filter = module-owned shows only `module_owner != null` rows.
  - ASSERT: health filter = stalled shows only stalled rows.
  - ASSERT: search matches against the prompt text (case-insensitive substring).
- **Named test cases:**
  ```
  test_ownership_filter_module: filter module-owned → only module rows
  test_health_filter_stalled: filter stalled → only stalled rows
  test_search_matches_prompt: search 'briefing' → only rows whose prompt contains it
  ```
- **Acceptance criteria:**
  - [ ] Group/ownership/health filters + prompt search, composable
- **Pre-conditions:** E2.

### Task E4 — Detail drawer + verb buttons (matrix-driven)
- **File:** `dashboard/src/views/ScheduledDrawer.tsx` (CREATE)
- **Test file:** `dashboard/src/views/ScheduledDrawer.test.tsx`
- **Operation:** CREATE. Right-side drawer: full prompt + script, per-fire overrides (quietStatus, flagIntent model/effort — brief-required metadata), edit form (prompt/script/cron), fire history (last 5 with outcome labels), audit tail (when present), and the verb buttons. **Buttons are enabled/disabled SOLELY from the row's `available_verbs`** (the matrix output — never re-derived client-side; the `[NEEDS SPEC] one-table-driven` resolution). Confirms: module-owned edit → reseed-overwrite warning (D2); move → credential-delta confirm showing gains/losses + script-runs-unattended caveat (D8) + `environmentDeltaChecked:false` static caveat (W2); run-now near-slot → the F3 "next occurrence may still fire" copy; cancel → end-series confirm. On mobile: drawer renders read-only (verbs present, edit form omitted — v1, §5 OUT).
- **Interface:** `export const ScheduledDrawer: React.FC<{ rowKey: string; onClose: ()=>void; onMutated: ()=>void }>`
  - ASSERT: a verb button is rendered enabled ONLY if its verb is in `available_verbs` (matrix-driven; client never computes guards — single source of truth).
  - ASSERT: move confirm displays the secret-delta gains/losses NAMES + the unattended-script caveat (D8) before calling execute, and echoes `deltaHash` (SEC-2).
  - ASSERT: module-owned edit shows the reseed-overwrite warning naming the owning module (D2).
  - ASSERT: run-now within grace surfaces the "next occurrence may still fire — deliberate extra run" confirm and sends `force:true` only on explicit confirm (F3).
  - ASSERT: `available_verbs` is consumed from the API, NOT recomputed (single-source enforcement, [NEEDS SPEC]).
- **Named test cases:**
  ```
  test_buttons_from_available_verbs: row with available_verbs:['edit','cancel'] → only edit+cancel enabled; run-now/move/pause disabled
  test_move_confirm_shows_delta: open move confirm → gains/losses names + unattended-script caveat shown; execute sends confirmedDeltaHash
  test_module_edit_warns: module-owned row edit → reseed-overwrite warning naming owner
  test_runnow_near_slot_confirm: row needing force → confirm names the residual; confirming sends force:true
  test_mobile_drawer_readonly: isMobile → edit form absent, verb buttons present
  ```
- **Acceptance criteria:**
  - [ ] Buttons driven solely by `available_verbs`; move delta confirm; module reseed warning; run-now residual confirm; mobile read-only
- **Pre-conditions:** E5 (api client).

### Task E5 — API client functions
- **File:** `dashboard/src/lib/api.ts` (MODIFY — add typed fetchers + response types, following the existing `listSessions`/`listTasks` shape ~api.ts:170-260)
- **Test file:** `dashboard/src/lib/api.test.ts` (MODIFY)
- **Operation:** MODIFY. Add: `listScheduled(params)`, `getScheduledDetail(key)`, `editScheduled(key,body)`, `pauseScheduled/resumeScheduled/runNowScheduled/cancelScheduled(key[,opts])`, `moveScheduledPreview(key,body)`, `moveScheduled(key,body)` + the `ScheduledRow`/`ScheduledSnapshot`/`ScheduledDetail` types mirroring the host interfaces. CSRF/credentials handling identical to existing mutators.
- **Interface:** typed `fetch` wrappers returning the documented response shapes; mutators send `credentials:'include'` + the existing CSRF pattern.
  - ASSERT: mutators target `/dashboard/api/scheduled/...` paths exactly (never `/tasks`).
  - ASSERT: a 409/503/429 response surfaces a typed error the drawer can branch on (reason string preserved).
- **Named test cases:**
  ```
  test_list_scheduled_calls_endpoint: listScheduled() → GET /dashboard/api/scheduled (mock fetch asserts URL)
  test_move_sends_delta_hash: moveScheduled(key,{...,confirmedDeltaHash}) → body includes confirmedDeltaHash
  test_409_surfaces_reason: a 409 {reason:'source_busy'} → thrown/returned error carries reason
  ```
- **Acceptance criteria:**
  - [ ] All 9 client fns typed; correct paths; error reasons preserved
- **Pre-conditions:** none (types mirror the plan contract; can build first within E).

### Task E6 — RouteNav third entry + route wiring
- **File:** `dashboard/src/views/BoardShell.tsx` (MODIFY — add `'scheduled'` to the `BoardRoute` union at BoardShell.tsx:19 and a third `<button>` in `RouteNav` at :77-93); `dashboard/src/main.tsx` (MODIFY — `parseHash` recognizes `#/scheduled`, `navigate` maps it, and render `{hashState.route === 'scheduled' && me && <ScheduledBoard .../>}` at ~main.tsx:90-93)
- **Test file:** none — reason: pure routing/markup wiring; behavior covered by E1-E4 component tests + the existing BoardShell render tests. (If `BoardShell.test`/router test exists, add a one-line nav-presence assertion.)
- **Operation:** MODIFY. Extend the route union + nav + hash router so the Scheduled view is reachable as a peer of Board/Inbox.
- **Interface:** `type BoardRoute = 'board'|'inbox'|'scheduled'`; RouteNav renders a third "Scheduled" button; main.tsx routes `#/scheduled`.
  - ASSERT: `RouteNav` renders three buttons; active highlight follows `route==='scheduled'`.
  - ASSERT: `#/scheduled` hash mounts `<ScheduledBoard>`; other routes unaffected.
  - ASSERT: any `switch`/conditional on `BoardRoute` remains exhaustive after adding the member (no unhandled-route fallthrough).
- **Named test cases:** none (wiring) — covered by E1-E4 + existing shell tests.
- **Acceptance criteria:**
  - [ ] Third nav entry; `#/scheduled` mounts the view; Board/Inbox unaffected
- **Pre-conditions:** E1 (the view component must exist to import).

## Constraint Traceability

| Constraint / Rejected option | Type | Traced to (ASSERT / criterion) |
|---|---|---|
| C1 no firing-path change; status values it reads untouched | HARD | A1 (central DB only), A2 (additive index), A3 (content widens only), A4 (recurrence=NULL is existing op; no new status), D3 (additive sweep hook) |
| C2 move = cancel-source + scheduleTask-target; one-live-row | HARD | D2 (cancel-first ASSERT; one-live-row invariant ASSERT); D1 (wiringOk false on unwired) |
| C3 host is sole writer of session inbound DBs | HARD | A1 (central only); B1 (board opens `{readonly:true}`); all mutation handlers write via host primitives |
| C4 reuse BoardShell/auth/router; per-handler gate | HARD | A6 (`canManageScheduled`); B3/B4/C1-C4/D1/D2 (gate ASSERTs); C6 (requireAuth wrap); E6 (BoardShell reuse) |
| C7 scope filter, disclose-as-not-found | HARD | B3 (list scope-filter ASSERT); B4 (out-of-scope 404 ASSERT) |
| C5 read follows list-scheduled-tasks shape; capped history | SOFT | B1 (latest-row-per-series + last-5 ASSERT) |
| C6 display UTC + service-local | SOFT | E2 (dual-time ASSERT) |
| C8 cron validated by firing parser; length bounds | SOFT | C1 (bad_cron 400; prompt≤8000/script≤4000 ASSERTs) |
| D7 owner/global-admin mutation tier | DECISION | A6 gate; D1 preview mutation-tier ASSERT |
| D8 move secret-delta names only | DECISION | D1 (names-not-values ASSERT); E4 (delta confirm) |
| D10 rejected: materialized index table for reads | REJECTION | B1 negative ASSERT (no materialized read table) |
| D14 rejected: insert-first move | REJECTION | D2 negative ASSERT (cancel-first; insert-first not used) |
| D16 skipped-vs-quiet merged | DECISION | B4 (history label "completed (no chat output)") |
| F1 paused-move staged insert | DECISION | D2 (never pending+due ASSERT) |
| F2 fleet-wide idempotent recovery | DECISION | D3 (fleet-wide predicate + idempotent restore ASSERTs) |
| F3 force = documented residual | DECISION | C3 (needs_force / force ASSERTs); E4 (residual confirm copy) |
| F4 guard_grace distinct constant | DECISION | A5 (GUARD_GRACE_MS ASSERT) |
| F5 intent snapshot purged on resolve | DECISION | A6 (purgeIntentBody ASSERT); D2/D3 (purge on resolve) |
| F6 run-now unknown fail-closed | DECISION | A5 + C3 (503 claim_state_unreadable ASSERTs) |
| [NEEDS SPEC] matrix one-table-driven | review | A5 (single exported matrix); E4 (buttons from `available_verbs`, no client re-derivation) |

**All HARD constraints and both REJECTION options are traced to at least one ASSERT/criterion.** No untraced HARD constraints.

## Known Risks

- **A2 (assumption — module registry covers all 22 series):** Task C5 cross-checks the prefix+static registry against the live fleet during build; if any module series is unmatched, extend the static map and record in the commit. Mitigation owner: Group C builder.
- **A3 (assumption — warm assembly <1s):** Task B1 instruments and logs warm assembly wall-time; the build commit must record the measured figure. If >1s, the chunk size / TTL is revisited (design §4.9 escalation path — worker-thread offload is the documented v2 fallback). Mitigation owner: Group B builder.
- **W2 (waived — move config-delta beyond secrets):** v1 preview checks secrets only; target container env differences (packages/MCP/mounts/provider) can silently break a moved script. Mitigated by `environmentDeltaChecked:false` + a static confirm caveat (D1/E4) and the fact that a broken moved script surfaces on the board as failed/no-output fires. Deferred to v2 (§5 OUT).
- **Cross-model reviewer note:** the two informal pre-approval Codex passes plus 3 formal cycles all ran with Codex available — no reduced-diversity risk to carry.
- **Render-check pending (§3c health-pill palette):** lead-verified during build (E1 acceptance) — not builder-closeable; the build lead performs the visual contrast check.

## Integration Checklist

1. **Migration:** `043-scheduled-audit` runs on host start (central DB); session-DB index appears on next write-open per session (A2 — board reads tolerate absence).
2. **Build order:** A → B → D → C on the host; E in parallel. C6 (route registration) is the host integration point — it imports B+D+C handler symbols and must build last on the host side.
3. **Host typecheck:** `pnpm run build` (tsc) clean after each host group. **Container typecheck:** not applicable — no `container/agent-runner/` changes in this feature.
4. **Frontend:** `pnpm --filter dashboard build` (or the repo's dashboard build) clean after Group E.
5. **Tests:** host `pnpm test` (vitest); frontend dashboard vitest/jsdom suite. C6 and E6 are the two legitimately test-less tasks (pure wiring — reasons recorded in their specs).
6. **A3 measurement** recorded in B1's commit; **A2 cross-check** recorded in C5's commit.
7. **Render-check (§3c)** performed by the lead after Group E functional criteria pass — dev server + screenshot or human approval.
8. **No DB backup needed for schema work** (additive migration + additive index; quality-gate "no destructive operations on production session DBs" respected — nothing drops or rewrites existing rows).

