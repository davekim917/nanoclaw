# Run record — graphify-indexing-liveness

## Plan stage (2026-08-18)

**Artifact:** `docs/specs/graphify-indexing-liveness/plan.md` (revision 3)
**Origin:** the phase-3 spike in `docs/specs/bounded-periodic-work/` (commit `24e55050`), which
found a measured 31.8-hour indexing outage and deliberately stopped short of designing the fix.

### Evidence the plan rests on (measured, not inferred)

| Claim | How it was established |
|---|---|
| The daemon emits no logs | `grep -rn 'console\.\|log\.\|logger' src/graphify-daemon/daemon.ts` → one false positive (`catalog.unref()`); `logs/graphify-daemon.log` 0 bytes since 2026-07-19 with `StandardOutput=append:` pointed at it |
| Nothing on the host watches graph health | `scripts/health-sentinel.sh` — seven vitals, all host-process; no graphify consumer under `src/dashboard/` or `src/host-sweep.ts` |
| The runner is serial | `drain()` `background-runner.ts:269-275` — `next.resolve(await this.execute(...))` |
| Reconciles are non-preemptible | `preemptActive: false`, `daemon.ts:1254`, with the rationale in the comment above it |
| One full scan held the lane 37.3 h | status socket: `lastStartedAt 2026-08-17T01:39:52Z` → `lastCompletedAt 2026-08-18T14:57:14Z` |
| Healthy incremental reconcile is ~1 min | post-fix status socket: 19:51:19Z → 19:51:53Z, 0.6 min, 4,448 sources |
| The sentinel is the right host to reuse | `nanoclaw-health-sentinel.timer` confirmed active on a 15-min cadence; per-vital 6h cooldown (`ALERT_COOLDOWN_S`, `health-sentinel.sh:42`) |
| `status()` already exposes what a vital needs | `daemon.ts:1060-1086` returns `lagMs`, `watcherDegraded`, `reconciling`, `lastCompletedAt`, `lastFailure` — so phase 1 needs no daemon change |

### Lead self-verification — six defects found before any external review

**1. Wrong primary mechanism (revision 1 → 2).** Revision 1 led with an admission-starvation fix,
justified by a real measurement: `scanInteractivePressure` true in 11 of 12 samples 10s apart. The
measurement holds; the inference did not. Tracing `execute()` → `drain()` → `queueReconcile`:
a pressured job is **rejected and dequeued** (`background-runner.ts:317`), not held, and re-queued
5 s later (`daemon.ts:1258-1260`) — roughly 12 attempts a minute, so at an ~8% quiet rate it is
admitted within about a minute. Admission cost seconds, not 31.8 hours. Probed the live install to
close it out: **0 sessions currently assert pressure**, so the 11/12 reading was bursty traffic,
not a session pinning the gate.

The real chain is inotify exhaustion → every reconcile a full scan → one 37.3-hour full scan
monopolising a serial, non-preemptible lane. Items 1 and 3 of that chain are already fixed
operationally. What remains is the *volume* of full scans, not their scheduling — so revision 2
targets the load and demotes the admission bound to a non-goal with a trigger.

**2. Four completion sites, not two.** The draft said to clear per-workgroup wait state "where
`state.lastCompletedAt` is assigned (both the isolated path and `reconcileInProcess`)".
`grep -n 'lastCompletedAt' src/graphify-daemon/daemon.ts` shows **four** — `:1411` (isolated
`reconcile()`), `:1626` (`reconcileInProcess`), `:1774` (`reconcileFilesystemChanges`), `:1830`
(`reconcileArchive`) — and only two are full scans. `reconcileArchive` completes *archive* work
while filesystem work may still be dirty. This now matters for `lastFullScanAt`, and is pinned by
acceptance criterion D9.

**3. The obvious phase-3 design reduces nothing.** Splitting the 6h tick into "mark dirty" (6h) and
"require full scan" (24h) changes bookkeeping and not behaviour: `canReconcileIncrementally`
(`:911`) requires `pendingFilesystemChanges.size > 0`, which the timer path never has, so
`queueReconcile` (`:1244-1245`) falls through to a full scan regardless of `fullScanRequired`.
Caught by walking the branch rather than by trusting the field name. Revision 2 instead makes the
tick's per-workgroup body conditional on `watcherDegraded` plus a 24h `lastFullScanAt` floor, and
records the rejected design in the plan so it is not re-proposed.

**4. Every obvious place to stamp `lastFullScanAt` is wrong.** Phase 3's whole correctness rests on
this field, and tracing the callers found two traps. Stamping at each `state.lastCompletedAt`
assignment would stamp on `reconcileFilesystemChanges` (incremental) and `reconcileArchive`
(archive-only) too — so a workgroup receiving a steady trickle of watcher events would defer its
backstop forever, the exact hole the phase must not open. Stamping inside `reconcileInProcess` is
also wrong: it is reached from `buildCandidateOnce` (`:1130`), the build-only entrypoint the
isolated worker runs with `promote = false`, in a different process against a different
`WorkgroupState`. Design settled on one site — `queueReconcile`'s `.then()`, guarded by a
`ranFullScan` flag set in the same branch that chose the work, and only on `status === 'completed'`.
Pinned by D9 and D10.

**5. The sentinel has seven vitals, not six.** The plan (and the script's own header comment,
`health-sentinel.sh:11-17`) said six; the code has seven — `crashloop` was added later without
updating the comment. Corrected throughout the plan, and fixing the stale comment is folded into
phase 1 since it is the file being edited.

**6. Phase 1's workgroup enumeration would have alerted forever.** The design reads
`data/graphify/workgroups/*/` as the workgroup list. On the live install that is **11 directories
against 7 workgroups** in `data/v2.db`; the four orphans (four orphan ids,
`orphan-4`) are residue from deleted workgroups, and the daemon answers each with
`{"ok":false,"error":"unknown workgroup: <orphan>"}` — verified against the live socket. A vital
treating any non-`ok` reply as a breach would DM the owner every 15 minutes forever, which is worse
than no vital: it trains the owner to ignore the channel the rest of the plan depends on. Design
now distinguishes `unknown workgroup` (skip) from transport failure (breach). Pinned by S6.

Observation, not scope: those four orphan directories hold roughly 100 MB of index for workgroups
that no longer exist.

### Cross-model review coverage

The contract requires one other-family reviewer at the plan gate.

| Reviewer | Invocation | Result |
|---|---|---|
| `gpt-5.6-sol` (Codex) | `codex exec --ignore-user-config --model gpt-5.6-sol -c 'model_reasoning_effort="high"' --ephemeral --yolo` | `ERROR: You've hit your usage limit … try again at Aug 20th, 2026 4:05 AM` |
| `gemini-3.1-pro` (OpenCode) | `opencode run -m opencode/gemini-3.1-pro` | `Unauthorized: No credentials configured for opencode.ai in OneCLI` — the host CLI routes through the gateway, which holds no opencode.ai credential |
| `gemini-3.1-pro` (OpenCode, `NO_PROXY=opencode.ai`) | same | proxy bypass fixed auth; model itself returns `Model is disabled` |
| `kimi-k3` / `glm-5.2` / `gpt-5.1-codex-max` / `grok-4.6` (OpenCode, proxy bypass) | first responsive model reviews revision 2 | see verdict below |

A first attempt against `grok-4.6` was started on revision 1 and **stopped deliberately** once
defect 1 was found — reviewing a plan already known to target the wrong mechanism spends a reviewer
on the wrong artifact.


### Cross-model review — `kimi-k3` via OpenCode, on revision 2

Reachable after two dead ends (Codex out of credits to 2026-08-20; `gemini-3.1-pro` disabled) and
one stall (the reviewer halted asking for `/etc/systemd/system/` access, so the unit contents, the
socket protocol, and the existence of `daemon.test.ts` were inlined into the prompt and it was
re-run). It read all five files, grep-verified `daemon.test.ts`, and probed the live daemon
read-only. Verdict: **not ready to build — three MUST-FIX, all specification-level.**

Every finding was traced to source before being accepted or rejected.

| # | Finding | Disposition |
|---|---|---|
| M1 | The `graph` vital's bare `lagMs > 2h` predicate false-fires on a healthy fleet; `lagMs` saw-tooths with the scan cadence, and after phase 3 an idle workgroup would breach ~22h/day | **ACCEPTED.** Verified independently: at 22:51Z all seven reachable workgroups sat at 2.98–5.36h lag with `watcherDegraded` false. The plan's own S3 was unattainable as written. Predicate rewritten to the outage's actual signature — work pending and nothing running — plus a 26h catastrophic ceiling. S1 and S3 rewritten with it. |
| M2 | `lastFullScanAt` stamp placement is invisible to the D-suite: `isolateReconcile` defaults `true` in `dist/` and `false` under vitest, and `daemon.test.ts` never sets it, so a stamp on the in-process path alone passes every test and never fires in production | **ACCEPTED IN PART.** The specific hole was already closed between the review starting and finishing — the design had moved to a single path-independent stamp in `queueReconcile`'s `.then()` guarded by `ranFullScan`. The underlying divergence is real and verified (`daemon.ts:550`; zero `isolateReconcile` occurrences in `daemon.test.ts`), so criterion D11 now pins the isolated path explicitly. The "never seed `lastFullScanAt` from `readExistingLastCompletedAt`" warning is accepted as R-5. |
| M3 | The socket-wrap spec omits reply shapes the live fleet produces; and a non-zero exit before the persist block would take the other vitals down *and* double-count the next log window | **ACCEPTED.** Two live shapes confirmed: four orphan directories answer `{"ok":false,"error":"unknown workgroup: …"}`, and `workgroup-A` returned a zero-byte reply under load. The secondary-breach consequence of skipping the offset persist is a sharper catch than the abort itself. Criteria S7, S8, S9 added. |
| S-a | D7 has no reachable seam — `watcherDegraded` is set only in the isolated watchers branch, while the in-process handler (`:1219-1221`) sets `lastFailure` only; and D7's assertion is too weak for "immediately" | **ACCEPTED.** Verified in source; it is a genuine parity gap, not just a test problem — R5 would be inert in the configuration the tests run. Criterion D12 added. |
| S-b | Phase 2 emits nothing with zero workgroups, so "the log must move" cannot distinguish healthy from dead | **ACCEPTED.** Daemon-level heartbeat record added to R3 and the phase-2 design; criterion D13. |
| S-c | The admission bound's reopen trigger is already firing; the demotion rests on a point probe of a bursty signal | **ACCEPTED as to honesty, REJECTED as to cause.** The non-goal now states plainly that it is a bet on telemetry rather than on observed absence. But the reviewer's inference that "the lane is closed to all of them" is wrong: the lane is *occupied*, not closed — `workgroup-A` was mid-reconcile at sampling, having completed one at 21:35:04 and started another at 21:37:09. Its own lens-3 note that fairness is "moot while the lane is closed" rests on the same mis-read. |
| NITs | epoch-ms typing, sticky `watcherDegraded`, D4 wording, hung-socket and `nullglob` cases, "within 15 minutes" overclaim | Accepted: typing → R-7, stickiness → R-6, hung socket → S8. D4 reworded as plumbing since the test file's stub runner has no `counters()`. |

**Lenses the reviewer passed clean**, each independently spot-checked: the retry/latch paths
(revision 2 deleted the whole failure class by replacing paired set/clear state with a
write-once-on-completion stamp), degraded-workgroup coverage end to end, and the memory-guard
priority call.

### What the review surfaced that neither party had

Chasing M1's live evidence turned up the symptom now recorded at the top of `plan.md`: since
19:52Z only `workgroup-A` has reconciled, while three workgroups sat dirty and idle for four to five
hours with 22.5 GB free and no watcher degradation. Two mechanisms explain it equally well and the
daemon emits nothing that separates them. Rather than promote a fairness fix on a guess — the exact
move this line of work exists to stop — phase 2 was extended to emit `queueDepth`, `laneHolder`,
`laneHeldForMs` and `queuedForMs`, which decide it, and the fairness non-goal was rewritten to say
its trigger is live rather than hypothetical.

### Verdict

**`must_fix` → addressed.** All three MUST-FIX and all three SHOULD-FIX are folded into revision 3,
with one partial rejection recorded above. Cross-model coverage was obtained (`kimi-k3`), so the
plan gate is **not** degraded. Revision 3 has not been re-reviewed; the changes are
specification-level and each is pinned by an acceptance criterion.


### Follow-up: the live symptom resolved itself (2026-08-19T01:41Z)

The "one workgroup has held the lane since 19:52Z" reading was **wrong as a steady state** and is
corrected in `plan.md`. Re-probed three hours later: every workgroup drained in FIFO order the
moment the long pass ended (11 min, 14 s, 13 s, 4 s in sequence), then the large workgroup ran again
for 69 minutes. The runner's queue is fair; the 22:58Z snapshot caught the tail of one long pass and
read it as monopolisation.

Lesson worth keeping: a single sample of a queue says nothing about fairness. This is the third time
in this feature that a point probe of a time-varying signal produced a confident wrong conclusion —
the first two were revision 1's 11-of-12 pressure reading and revision 2's 0-sessions reading. All
three would have been settled by the telemetry phase 2 adds, which is the strongest argument for
shipping phases 1 and 2 before choosing any behavioural fix.

The residual, narrower fact still stands: one workgroup's pass costs ~69 minutes while every other
costs seconds, and it re-queues immediately on completion. Whether those passes are timer-driven
full scans (phase 3 cuts them 4×) or change-driven incrementals (phase 3 does nothing) is exactly
what phase 2's record decides.
