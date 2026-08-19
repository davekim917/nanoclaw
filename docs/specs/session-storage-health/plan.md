# session-storage-health — plan

Status: PROPOSED, revision 1 — pending cross-model review; the owner has delegated
approval authority for this infra lane (2026-08-19) but the review gate still
applies.

## Outcome

Session storage self-manages again: schema maintenance can no longer freeze
the idle clock fleet-wide, the existing hourly archival drains eligible
sessions gradually (never as a stampede), the active-session population is
bounded by age (14d) and count (2,000), no session with real open work is
ever archived, and the one code path that resurrects archived sessions
invisibly (support-threads) is fixed. A one-off recovery unfreezes the
current 5,792 stuck sessions.

## Root cause being fixed (evidence: scratchpad archival-stopped-rootcause.md, reaper-evidence.md)

- `reconcilePendingUpgradeContexts` (src/session-manager.ts:959-990) runs
  `migrateMessagesInTable` against EVERY session's inbound.db at host start;
  on the first start after a schema-adding deploy the DDL executes for real
  and bumps every file mtime (5,027 files in 90s on 2026-08-15 20:21).
- Eligibility (storage-manager.ts:863) takes `Math.max(diskMtime,
  dbLastActive)` — one bumped mtime vetoes months-old inactivity. Result:
  `session-reclaim` has queued ZERO actions since the 2026-08-13 deploy
  (385 healthy hourly `maintenance complete` lines prove the scan runs).
- Same loop happened before: 1,041 tarballs on 2026-08-05 = the previous
  mass-touch expiring all at once. Without a cap, the current cohort
  (~5,792) becomes eligible simultaneously on 2026-09-14.
- `getStorageReport` applies every collected action in one pass with no
  per-tick limit (storage-manager.ts:1669-1680) and no oldest-first ordering
  for sessions.
- `sessionHasOpenWork` (storage-manager.ts:531-552) misses two blockers:
  future-scheduled `process_after` rows (only already-due rows block) and
  `work_continuation` in outbound session_state.
- support-threads (src/modules/support-threads/dispatch.ts:263-291) resolves
  sessions by raw id with no status filter: a follow-up to an archived
  thread silently re-provisions the dir and spawns a container on a
  status='closed' row — permanently invisible to host-sweep's active-session
  machinery.
- Population/consumption today: 6,857 active rows (1,017 >30d idle by DB
  time), ~90G in data/v2-sessions (~76G grown in 45d), ~1 inotify watch per
  dir, 60s sweep iterates every active row.

## Scope

- src/session-manager.ts (mtime preservation), src/storage-manager.ts
  (cap, ordering, knobs, blocker gaps), src/modules/support-threads/
  dispatch.ts (status-aware resolution), tests beside each.
- One new host-side recovery script `scripts/restore-session-mtimes.ts`
  (dry-run first).
- `.env`: `NANOCLAW_SESSION_RECLAIM_DAYS=14` (new knob; see D3).

Non-goals: no change to what archival stores (tar/zstd rescue path stays);
no deletion of session rows; no change to the 90% admission gate or the 80%
cleanup threshold; no Docker/graphify/groups pruning (separate lanes); no
change to the codex-plugins per-session duplication (owned by the
container-owned-codex-plugins plan).

## Requirements

SR1. A schema-migration pass that changes nothing for a session leaves its
     inbound.db mtime unchanged; a pass that DOES run DDL restores the
     pre-pass mtime afterward — maintenance is bookkeeping, not activity.
     Crash-consistent: before the loop, an intent manifest
     (session→pre-mtime) is written+fsynced beside the sessions root; it is
     deleted on completion; on startup an existing manifest is replayed
     (restore only sessions whose current mtime still falls in the boot
     window and which show no newer real activity). If the pass ADMITS real
     work for a session (upgrade context admitted), its new mtime is KEPT —
     genuine activity is never erased. (Chosen over trusting central-DB
     last_active alone: keeps the mtime fail-safe term, per the debug
     recommendation.)
SR2. Session archival is bounded AND serialized: at most
     `NANOCLAW_SESSION_RECLAIM_PER_TICK` (default 50) sessions per
     maintenance pass, oldest-idle first, and ALL reclaim entry points
     (hourly cadence, pressure bypass, force/`pruneIdleSessionArtifacts`)
     run through ONE module-level serializer (the host is a single Node
     process) sharing that per-pass budget — overlapping or rapid repeated
     invocations cannot multiply it. The pressure path keeps the same cap
     (disk relief also comes from Docker pruning, which stays uncapped).
SR2b. Archival of one session is a crash-safe lifecycle, in this order:
     re-validate INSIDE apply immediately before acting (container not
     running, no open work per SR5, mtime unchanged since collection) →
     CAS `status` 'active'→'archiving' → tar to a temp path → validate the
     tarball (listable, non-empty) → atomic rename to the rescue path →
     CAS 'archiving'→'closed' with the rescue path + prior status recorded
     in an append-only reclaim journal (JSONL) → rm -rf the dir. Startup
     recovery resolves interrupted states idempotently: 'archiving' with
     dir intact → reset to 'active' (temp tar cleaned); 'closed' with dir
     still present and a valid published tar → finish the rm; duplicate
     invocations are no-ops. Spawn/wake/write paths refuse 'archiving'
     rows exactly as they would a closed row.
SR3. Sessions idle beyond `NANOCLAW_SESSION_RECLAIM_DAYS` (new knob;
     default = current shared knob's value for zero behavior change on
     upgrade; SET to 14 in this install's .env) are eligible. The shared
     `NANOCLAW_THREAD_WORKTREE_RECLAIM_DAYS` knob keeps governing thread
     worktrees only.
SR4. Count cap: when active sessions exceed `NANOCLAW_SESSION_ACTIVE_CAP`
     (default 0 = disabled; SET to 2000 here), overflow sessions become
     eligible regardless of age. Selection is ONE union pass: build
     candidates = age-eligible ∪ count-overflow, filter blockers (SR5),
     sort oldest-idle first, take up to min(per-tick budget, count deficit
     + age-eligible count). A blocked old session does NOT consume an
     overflow slot — the next-oldest unblocked one does; the cap is a
     target, blockers legitimately hold it above target.
SR4b. Knob hygiene: all three knobs (`NANOCLAW_SESSION_RECLAIM_DAYS`,
     `NANOCLAW_SESSION_RECLAIM_PER_TICK`, `NANOCLAW_SESSION_ACTIVE_CAP`)
     validate as positive integers (invalid → default + one warning log);
     the resolved values are logged once at startup; the .env deployment
     lists ALL THREE lines explicitly (14 / 50 / 2000). The session-days
     knob's absence falls back to the shared worktree knob's value as a
     one-time compatibility default, documented as such.
SR5. `sessionHasOpenWork` additionally blocks on: ANY pending messages_in
     row (due or future — recurrence/process_after), and a live
     `work_continuation` in the session's outbound session_state. A session
     with either is never archived regardless of age/cap.
SR6. support-threads never operates on a closed/archiving session:
     resolution filters status. On a stale binding, ONLY the `session_id`
     field is replaced — the external thread identity and all other
     support_threads state are preserved. Fresh-session creation +
     rebinding is serialized per thread id (in-process map — single host
     process), so two concurrent follow-ups to the same thread yield
     exactly one new session, one spawn, and both messages delivered to it.
     C2 additionally ENUMERATES every raw-session-id consumer (grep
     getSession callers that wake/write) and proves each filters status or
     gets the same treatment — observatory_item_threads explicitly
     included (flagged untraced in grounding).
SR7. Recovery one-off, gated and manifest-bound: `--dry-run` selects
     sessions where inbound.db mtime falls in a lead-approved migration
     burst window (2026-08-15 20:21±10min primary; script accepts extra
     windows) AND central `COALESCE(last_active, created_at)` predates the
     burst, skipping running containers and open-work sessions; it writes a
     manifest (session, current inode+mtime, chosen restore target +
     provenance among outbound.db/archive.db/.heartbeat/central
     last_active). `--execute --manifest <path>` acts ONLY on manifest
     entries whose inode+mtime are unchanged (changed → skip + report),
     is idempotent on rerun, and records a preimage manifest of prior
     mtimes. Runs only AFTER the capped code is deployed and verified
     (see path) and while the reclaim serializer is held.
SR8. Every behavior above has a test beside the code it covers (vitest,
     host tree), fixed timestamps, temp dirs.

## Executable acceptance criteria

- T1 `migration_preserves_mtime`: schema-current inbound.db → pass leaves
  mtime unchanged; DDL-needed → post-pass mtime restored, DDL applied;
  crash injected between DDL and restore → startup replay restores from
  the intent manifest; session with admitted upgrade work → new mtime
  KEPT. (SR1)
- T2 `reclaim_capped_ordered_serialized`: 120 eligible fixtures, cap 50 →
  exactly 50 archived, the oldest-idle; next pass takes the next 50; two
  overlapping maintenance invocations → still exactly 50 total (shared
  budget); force entry point shares the same budget. (SR2)
- T2b `archival_lifecycle_crash_safe`: tar failure → session stays/returns
  'active', dir intact, temp cleaned; crash after publish before rm →
  startup finisher completes the rm exactly once; spawn/wake/write against
  an 'archiving' row is refused; re-validation catches a container started
  or a message written between collect and apply (session skipped);
  reclaim journal line written per archival with rescue path + prior
  status. (SR2b)
- T3 `session_knob_independent`: session knob 14d + worktree knob 30d →
  a 20d-idle session eligible, a 20d thread worktree not reclaimed; knob
  unset → falls back to the shared knob's value. (SR3)
- T4 `count_cap_union`: cap 2000 with 2010 active, all younger than the
  age knob → the 10 oldest-idle UNBLOCKED eligible (a blocked oldest row
  is skipped and the next-oldest takes its slot); cap 0 → none; mixed
  age+overflow candidates dedupe into one oldest-first selection; invalid
  knob values → defaults + warning, resolved config logged at startup.
  (SR4/SR4b)
- T5 `open_work_blocks`: future process_after row → blocked; live
  work_continuation → blocked; both absent + idle → eligible. (SR5)
- T6 `support_thread_closed_session`: thread bound to a closed session +
  inbound follow-up → no spawn on the closed row, ONLY session_id
  replaced (thread identity + state preserved), fresh-session path taken;
  TWO concurrent follow-ups → exactly one new session, one spawn, both
  messages delivered; active-session binding → unchanged behavior; C2's
  raw-id consumer enumeration recorded in run.md with per-path
  proof-or-fix. (SR6)
- T7 `restore_mtimes_manifest`: dry-run selects only burst-window sessions
  with pre-burst central activity, skips running/open-work ones, writes
  the manifest with provenance; execute skips entries whose inode/mtime
  changed since the manifest; rerun is a no-op; null last_active falls
  back to created_at; preimage manifest written before any utimes. (SR7)

## Implementation path

1. C1 (trunk): SR1 + SR2 + SR2b + SR3 + SR4 + SR4b + SR5 with T1-T5
   (incl. T2b), beside existing storage-manager tests; full host suite +
   typecheck.
2. C2 (trunk): SR6 + T6 + the raw-id consumer enumeration.
3. Implementation review, then SHIP + RESTART FIRST: merge to fork main,
   append the three .env knob lines, restart the host (can ride tonight's
   already-planned restart if timing aligns), and VERIFY the running
   version executes a bounded tick (log line with resolved knobs; ≤50
   session-reclaim actions).
4. C3 recovery, ONLY after step 3 is verified live (ordering is
   load-bearing: restored mtimes must never be visible to the old uncapped
   archiver): `--dry-run` → lead reviews the manifest counts → `--execute
   --manifest` under the reclaim serializer. Subsequent hourly ticks drain
   at ≤50/tick under 14d/2000.

Ownership: one builder (worker-high), trunk only, worktree NOT required
(host `src/` changes don't touch the live dist until build+restart — but
builder must NOT run `pnpm run build` in the live checkout; tests+typecheck
only, per the dist-is-live rule).

## Rollback

- Each C is a separate commit; revert independently. Knobs are env-gated —
  removing the .env lines restores prior thresholds without code changes.
- Recovery script is mtime-only; the preimage (current mtimes) is recorded
  to a JSON manifest before execution for exact restoration.
- Archived-session restoration: every archival's journal line (session id,
  prior status, rescue path) makes restore mechanical — untar the rescue
  archive over a re-created dir, set status back to prior. One test proves
  a restored session resumes cleanly (T2c in the builder's suite); if a
  newer session exists for the same routing triple, restore preserves both
  and reports for manual resolution rather than guessing.

## Risks / notes

- The Sept-14 stampede exists WITHOUT this work; SR2 alone defuses it even
  if recovery is delayed.
- Archived sessions' revival semantics are unchanged for chat/channels
  (router already opens fresh sessions); support-threads is the one path
  fixed here. observatory_item_threads' read path was flagged unverified in
  grounding — builder must trace it in C2 and extend SR6's fix if it shares
  the raw-id pattern.
- 19.1G of per-session codex/plugins copies drain naturally as those
  sessions archive; the structural fix stays with the codex-plugins plan.

## Verification commands

- `pnpm exec vitest run src/` (T1-T7 + existing suites) · root typecheck
- Post-C3: `node_modules/.bin/tsx scripts/restore-session-mtimes.ts --dry-run`
  output review; after execute + next hourly tick: `session-reclaim` lines
  appear in logs/nanoclaw.log, ≤50/tick.
