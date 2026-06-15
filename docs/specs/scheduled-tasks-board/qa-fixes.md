# QA Fix Pass — scheduled-tasks-board (post-`/team-qa`, operator-approved "go")

> Fixes the 6 MUST-FIX + 6 high-value SHOULD-FIX from `qa-report.md`. TDD each (write/extend the failing test FIRST, then fix). Host is ESM (NEVER `require()`). Work in `/home/ubuntu/nanoclaw-v2`. After all fixes: `npx vitest run src/dashboard/api/ src/host-sweep.test.ts src/modules/scheduling/ src/db/` AND `pnpm run build` (host tsc) AND `cd dashboard && npx tsc -p tsconfig.json --noEmit` must all be green. Do NOT commit — the lead validates + commits.
>
> Spec the WHAT; you choose the HOW where unstated, matching surrounding code. Every fix needs a named test.

## Shared infra (build these first — several fixes use them)

### H1. Two-location / N-location live-row count with fail-safe on read error (fixes M2 + enables M1)
Today there are TWO count helpers with a `catch { /* contributes 0 */ }` swallow:
- `host-sweep.ts:310 countLiveRowsForSeriesFleetWide(sessionsRoot, seriesId)` — scans EVERY session in EVERY group (the M1 over-count).
- `scheduled-move.ts:~386 liveRowCountFleetWide(dataDir, source, target, seriesId)` — already 2-location-scoped.

Create ONE shared helper (put it where both host-sweep.ts and scheduled-move.ts can import it — e.g. `src/dashboard/api/scheduled-shared.ts`, or a small `src/modules/scheduling/live-count.ts`; pick the spot with no import cycle):
```
countLiveRowsInSessions(dataDir, locators: Array<{agentGroupId, sessionId}>, seriesId): { count: number; unreadable: boolean }
```
- Opens each session's inbound.db **readonly** (busy_timeout 1000 — NOT writable; M2 hygiene + ADV-S3).
- Counts `messages_in WHERE series_id=? AND kind='task' AND status IN ('pending','paused')`.
- **FAIL-SAFE:** if ANY per-session read throws, set `unreadable=true` (do not silently add 0). Caller must treat `unreadable` as "live state UNKNOWN" → never restore (F6 discipline: unreadable→unknown, never silently-healthy).
- Skips locators whose inbound.db doesn't exist (contributes 0, not unreadable — a missing target session legitimately means "no insert happened").

## MUST-FIX

### M1 — recovery must scope the live-count to {source, target}, not bare series_id fleet-wide
**Files:** `scheduled-move.ts` (move_intent write) + `host-sweep.ts recoverMoveIntents`.
- In `moveExecuteHandler`'s `move_intent` `detail_json` (currently `{ snapshot, target: target.agentGroupId }`), ALSO store the full target locator: `targetAgentGroupId`, `targetMessagingGroupId`. (Both known at intent-write time, before the insert.)
- In `recoverMoveIntents`, replace `countLiveRowsForSeriesFleetWide(sessionsRoot, intent.series_id)` with the H1 helper scoped to TWO locators: the source `{intent.agent_group_id, intent.session_id}` and the target session resolved from `{targetAgentGroupId, targetMessagingGroupId}` (resolve the channel-root session id the same way the move does; if the target session doesn't exist yet, it contributes 0). Use H1's `unreadable` flag: if unreadable → skip this pass (leave intent unresolved for a clean later pass), never restore.
- **ASSERT/test (`host-sweep.test.ts`):** an UNRELATED group with a live row of the SAME `series_id` does NOT cause a false-resolve — recovery still restores the crashed source. (This is the regression the bare-series_id count caused.)
- Delete the now-unused bare-series_id `countLiveRowsForSeriesFleetWide` if nothing else uses it.

### M2 — count helpers fail-safe on read failure (no swallow-to-0)
Covered by H1 + its use in M1 (recovery) and in the move compensation/invariant (`scheduled-move.ts`). Replace BOTH old helpers' `catch→0` with H1's `unreadable` semantics. Move compensation: if `unreadable`, do NOT restore, leave `move_restore_failed`. **Test:** a session whose read throws but holds a live row → count `unreadable=true` → NO spurious restore (no double live row).

### M3 — editHandler rejects non-string prompt/script (live-content corruption)
**File:** `scheduled-mutations.ts:~236` (BEFORE the `.length` checks and `updateTask`).
```
if (body.prompt !== undefined && typeof body.prompt !== 'string') return json({ error: 'invalid_request' }, 400);
if (body.script !== undefined && typeof body.script !== 'string') return json({ error: 'invalid_request' }, 400);
```
**Tests (`scheduled-mutations.test.ts`):** PUT `{prompt: 99999}` → 400, the live row's content is UNCHANGED, and NO `scheduled_audit` row was written. PUT `{script: {x:1}}` → 400.

### M4 — decodeKey rejects path-traversal segments + containment-checked open helper
**File:** `scheduled-shared.ts decodeKey:~214` + the four open sites.
- In `decodeKey`, after splitting into the 3 segments, return `null` if any segment is `''`, `'.'`, `'..'`, or contains `/`, `\\`, or a NUL char.
- Add exported `sessionInboundPathFor(dataDir, agentGroupId, sessionId): string | null`: `const base = path.resolve(dataDir, 'v2-sessions'); const p = path.resolve(base, agentGroupId, sessionId, 'inbound.db'); return (p === path.join(base, agentGroupId, sessionId, 'inbound.db') && p.startsWith(base + path.sep)) ? p : null;` (canonicalize + containment).
- Route the four hand-rolled `path.join(...,'inbound.db')` open sites (scheduled-read.ts detail, scheduled-mutations.ts resolveTarget + cancel, scheduled-move.ts) through it. A `null` → 404 for the read/detail path, 400 `bad_key`/404 for mutations (match each handler's existing not-found contract — disclose-as-not-found, never 403).
- **Tests:** `decodeKey(base64url('../../x/series'))` → null; detail handler with a traversal key (owner scope) → 404; an edit/cancel with a traversal key → 400/404 and NO file outside `data/v2-sessions/` is opened.

### M5 + M6 — group filter works server-side + its test
**File:** `scheduled-read.ts scheduledListHandler:~151` + `scheduled-read.test.ts`.
- Read `group_id` from the request URL query string (mirror `src/dashboard/api/sessions.ts:200,225`). If present, AND the scope filter with `row.agent_group_id === group_id`. An out-of-scope/nonexistent `group_id` yields an empty list (NOT an error) — out-of-scope-as-nonexistent, consistent with sessions.ts.
- **Tests:** a `no_filter` owner with `?group_id=ag-1` → only ag-1 rows (not the whole fleet); `?group_id=<nonexistent>` → empty `rows`.

## HIGH-VALUE SHOULD-FIX

### E-2 — enforce the one-live-row invariant (don't log+200 on violation)
**File:** `scheduled-move.ts:~586-596`. On the step-6 invariant check: if `liveCount !== 1` (and the count is NOT `unreadable`), do NOT `purgeIntentBody` and do NOT return 200 — return `500 {error:'move_failed', reason:'invariant_violated'}` and LEAVE the `move_intent` unresolved so the recovery sweep repairs it. (If `unreadable`, also leave the intent + return a 503/500 — never claim success on an unknown post-state.) Also capture `cancelTask`'s touched count at step 3; if it returns 0 (source wasn't live), abort BEFORE inserting the target (defensive — the sync span makes 0 unexpected, but don't insert on a no-op cancel). **Test:** force a post-move `liveCount=2` (or a 0-touch cancel) → error returned, intent NOT purged (recoverable).

### E-3 — scoped list must not leak fleet-wide unreadable/degraded
**File:** `scheduled-assembly.ts` (assembly) + `scheduled-read.ts:~173`. Track `unreadable` per `agent_group_id` during assembly (the snapshot already iterates per session — bucket the unreadable count by group). In the list handler, compute the caller's `unreadable` count by summing only over the caller's in-scope groups, and compute `degraded` from the in-scope set (or document that `degraded` is a fleet assembly-health signal — but the unreadable COUNT must be scoped). **Test:** a scoped caller's response `counts.unreadable` reflects only their groups, not fleet-wide.

### E-4 — delta hash binds the move target
**File:** `scheduled-move.ts:~129 computeSecretDelta` + preview + execute. Include the target identity in the hash: `deltaHash = sha256(canonical({ sourceKey, targetAgentGroupId, targetMessagingGroupId, wiringOk, crossWorkgroup, scriptPresent, gains, losses }))`. Preview returns it; execute recomputes from the BODY's target and 409 `delta_changed` on mismatch. **Test:** a `confirmedDeltaHash` computed for targetA, replayed on an execute with targetB (identical secret gains/losses) → 409 `delta_changed`.

### S7 — channel-name map key uses NUL ` `, not space (LEAD-introduced regression)
**File:** `scheduled-assembly.ts` THREE sites: channelNameOf (~272), buildDetailRow (~522), doAssemble (~638). Change `` `${channel_type} ${platform_id}` `` (literal space) to `` `${channel_type} ${platform_id}` `` at ALL THREE (build + lookup must stay byte-identical). ` ` is a plain-text escape (file stays non-binary) AND restores the collision-safe NUL the comment already documents. **Test (`scheduled-assembly.test.ts`):** two messaging groups whose `channel_type + ' ' + platform_id` would collide under space resolve to DISTINCT `channel_name`s under the NUL key.

### ADV-S1 — readSourceLiveRow distinguishes read-throw (503) from empty (409)
**File:** `scheduled-move.ts:~169-200` (`readSourceLiveRow`) + consume at ~436. Mirror `resolveTarget` (scheduled-mutations.ts:129-132): a read THROW → `503 session_unreadable`; an empty result → `409 stale_key`. **Test:** a corrupt-but-existent source inbound.db → 503 (not 409).

### ADV-S2 — resolve dangling unrecoverable move_intent (no permanent zombie repair row)
**File:** `host-sweep.ts:~402-410` (no-snapshot) and `~412-418` (source dir missing). On BOTH branches, call `purgeIntentBody` (stamp `resolved_at`) so the intent resolves instead of surfacing forever as an unclearable 'stalled' repair row. **Test:** an unresolvable intent (no snapshot OR source dir gone) → after a recovery pass, `resolved_at` is stamped (no permanent zombie).

## Out of scope this pass (deferred ADVISORY — do NOT do)
A-2/A-3 import tidiness, B-2 support_threads doc, S1/S2 (degraded test / cancelled-label), S3 move-form dropdowns, S4/S5/S6, CONC-S1/S3/S4, ADV-S4, A-1 (the empty-interface lint — ACTUALLY do A-1 too: `host-sweep.ts:298` change `interface MoveIntentSnapshot extends TaskRowSnapshot {}` to `type MoveIntentSnapshot = TaskRowSnapshot` — trivial, clears the lone lint error; fold it in).
