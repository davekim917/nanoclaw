# Review Report: Scheduled Tasks Board (design rev 2)

> `/team-review` cycle 1/3 — 2026-06-12, invoked by `/team-auto`
> Reviewers run: A (architecture, Claude subagent) · B (best-practice-check forwarder, Claude) · C (Codex adversarial, GPT — direct `codex exec --yolo`, reasoning=high; note: two prior background-spawned Codex attempts died silently, the foreground run succeeded)
> Subject: `docs/specs/scheduled-tasks-board/design.md` rev 2 · brief rev 2 (+2 approved amendments) · decisions.yaml D1-D18
> Prior context: two informal pre-approval reviewer passes (27 findings, see `design_iteration_cycles` + D6-D18) — this is the first formal cycle.

## Verdicts

- **Reviewer A:** 15 findings (13 verified, 1 verified-with-nuance, 1 citation hygiene).
- **Reviewer B:** Design CONFORMS to established patterns across all 5 mechanism areas (T1/T2-sourced: Healthchecks, BullMQ, Node.js official, better-sqlite3, AIP-136, MS api-guidelines, Azure saga/compensation, microservices.io, redis.antirez.com). One MEDIUM drift (durable move-intent), two acknowledged deliberate deviations (alerting deferred; global grace formula).
- **Reviewer C:** 5 findings (4 verified; 1 contradicted by codebase).

Strongest signal: **independent convergence of A#1/A#8, B-drift-1, and C#1 on §4.2 move durability** — three evidence bases, three models, same conclusion.

## MUST-FIX (6) — all resolved in design rev 3 (same-cycle revision, allowed category: "add detail the design omitted")

| # | Finding | Raised by | Verified | Effort | Impact | Resolution (rev 3) |
|---|---------|-----------|----------|--------|--------|--------------------|
| M1 | Move execute has no in-flight-claim guard: moving a due/claimed row → container completes source fire while target row (preserved due-now `process_after`) fires too = double-fire, the exact protected incident class | A#1 | ✔ (processing_ack claim semantics; cancelTask doesn't stop an in-flight turn) | Low | High | §4.2 execute step 2a: 409 `source_busy` when source row is claimed (best-effort ack read) or `process_after ≤ now`; residual ms-race documented |
| M2 | No durable move-intent record before the destructive cancel: crash between cancel and insert (or audit-write failure on double-failure) loses the series invisibly — recurrence cleared ⇒ strand detector blind. The ONE silent death the board can't see | B-drift-1 + C#1 (conv.) | ✔ (Azure compensating-transaction T1; cancelTask clears recurrence db.ts:46) | Med | High | §4.2 step 2b: write `move_intent` audit row BEFORE cancel; assembly flags unresolved intents (no live row fleet-wide for series) as stalled; intent auto-resolves when a live row exists |
| M3 | Compensation "re-insert snapshot" primitive unnamed; obvious candidates wrong (`insertTask` sets series_id=id, severing identity; `scheduleTask` needs cron + re-validates mid-failure) | A#8 | ✔ (db.ts:30-31, 149-170) | Low | High | §4.2 step 5: restore via `insertRecurrence`-shape raw insert (preserves series_id/recurrence/content/destination) — named `restoreTaskRow` |
| M4 | One-off tasks can't move through `scheduleTask` (`TaskDef.cron` required string, written unconditionally to `recurrence`) — would fail or manufacture the swallowed-parse strand signature in the target | A#3 | ✔ (scheduled-tasks.ts:32-37, 196-212) | Low | High | §4.2 + §5: move is recurring-series-only in v1; one-offs UI-disable move (visibility + cancel only, like thread loops). Consistent with brief intent (D4 scoped one-offs to view+cancel) |
| M5 | Audit `detail_json` persists secret delta NAMES, served by the read-tier detail endpoint — re-opens the exact scoped-admin enumeration hole §4.5 closes at preview | A#4 + C#5-adjacent | ✔ (design §3b/§4.4 text) | Low | High | §4.4: `detail_json` stores delta COUNTS + hashes only, names never persisted; move audit rows keyed to BOTH groups; audit tail in detail response served only at mutation tier |
| M6 | Cron edit leaves the live row's `process_after` at the old slot — board displays new cron while the next fire follows the old one; a truth mismatch on the truth board | A#6 | ✔ (updateTask db.ts:104-110 — process_after only when passed) | Low | High | §4.5/§3b: cron edits recompute `process_after` via the §4.5 canonical parse (same mechanism as resume §4.7) |

## SHOULD-FIX (10) — all also applied in rev 3 (one-line spec additions; cheaper to fix than carry)

| # | Finding | Raised by | Resolution (rev 3) |
|---|---------|-----------|--------------------|
| S1 | `move_restore_failed`/intent repair rows have no resolution mechanism → permanent red item | A#2 | Auto-resolve: repair/intent rows surface only while NO live row exists fleet-wide for the series (assembly already computes this); zero new schema |
| S2 | Cache-invalidation race: in-flight assembly can repopulate a pre-mutation snapshot → "read your own write" claim false for ≤5s | A#5 | Generation counter: invalidation bumps gen; assembly refuses to populate cache if its start-gen is stale |
| S3 | SSE coverage hole: recurrence advance + scheduleTask emit nothing; InboxBoard precedent has `refreshInterval: 0` — board can sit stale across the exact transitions it exists to show | A#7 (verified: no emits in recurrence.ts/scheduled-tasks.ts; InboxBoard.tsx:76) | Board mutations emit `session_event` (owning group id); scheduled view uses `refreshInterval: 45_000` as real backstop |
| S4 | Residual-strand "persisting across >1 sweep" has no clock source (zero-state design; `messages_in.status_changed` is legacy/unwritten — verified live) | A#9 | Stateless heuristic specified: flag when `now − max(row.timestamp, process_after) > 2 × SWEEP_INTERVAL` |
| S5 | Board cancel silently resurrected by terminal-with-recurrence crash residue (`getCompletedRecurring` heals it into a successor) | A#10 | Cancel additionally clears `recurrence` on the series' terminal rows (data op via existing pattern, explicit C1 note — serves operator intent) |
| S6 | Run-now near-slot double fire (run at 08:55, cron fires 09:00) presented as non-issue | A#11 | Semantics kept; UI confirm warns when now is within one grace window of next slot; design documents the edge |
| S7 | Move preview checks secrets only; target container env (packages, MCP, mounts) can silently break a script | A#12 + C-adjacent | Preview response carries `environmentDeltaChecked: false` + static confirm caveat; config-delta preview listed v2 OUT |
| S8 | No hard scale budget / degraded mode for the sweep | C#2 | Assembly instrumented; >1s warm logs warning, >3s returns last cache + `degraded: true` flag the strip renders; A3 assumption retained |
| S9 | Claim-state read failure collapses to "not claimed" → false stalled + misdirected verbs | C#3 | New `unknown` health substate when outbound unreadable; pill renders grey; verbs allowed (operator judgment) with the substate visible in confirm |
| S10 | No rate limit on run-now/move despite in-file steer precedent | A#14 | Steer's per-user limiter applied to run-now + move |

Also applied: A#13 (index added to baseline INBOUND_SCHEMA + migrate fn; board reads tolerate absence), A#15 + C#5 prune nuance (citation fixes; audit prune exempts action-metadata rows — only body previews/detail_json pruned at 90d, so cancel-distinguishability survives), C#4-residual (one sentence defining owner/global-admin as the global `user_roles` tier).

## WON'T-FIX (1)

| # | Finding | Raised by | Reason |
|---|---------|-----------|--------|
| W1 | Per-verb, per-group authorization split (manage-on-source for edits; manage-on-both for moves) | C#4 | Contradicted-in-part by codebase: `owner`/`global-admin` are GLOBAL roles (`user_roles`; `steer.ts` isOwner/isGlobalAdmin) — at the v1 gate tier the source/target authority distinction is vacuous. Per-group loosening was explicitly rejected in D7 ("until a need to loosen appears"); single-operator deployment. Revisit alongside any future scoped-admin mutation tier. |

## Acknowledged deliberate deviations (Reviewer B, no action)

- Detection without notification (alerting = brief non-goal, v2) — deferring the alert half of the dead-man pattern is a conscious scope call, recorded.
- Fleet-wide grace formula vs per-series calibration — design already flags the heuristic Medium-confidence/tunable.

## Carry-forward to /team-plan

- [NEEDS SPEC: per-series grace overrides if the fleet-wide formula false-positives on weekly tasks — v2 candidate, not blocking]
- `[RENDER-CHECK NEEDED]` (design §3c): health-pill palette contrast — map to a build task acceptance criterion.
- Assumption A2 (module-owned series registry covers all 22) and A3 (warm assembly < 1s) — validate during build.

## Gate

MUST-FIX outstanding after rev 3: **0** (all six resolved in-document; resolutions verified against the cited primitives). Rev 3 goes back through `/team-review` as formal cycle 2 for confirmation per the rollback rule ("a changed design requires fresh assessment").
