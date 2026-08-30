---
name: fleet-retro
description: On-demand host-session retro of a workgroup's multi-agent development workflow. Use when the operator asks to review how the fleet has been behaving, evaluate whether workflow controls are working, run a workflow retro/eval, or check a workgroup's process health. Triggers on "fleet retro", "workflow eval", "how has the fleet been behaving", "are the controls working". Host session only — never run from a container agent.
---

# Fleet retro — host-session workflow review

You are the only vantage point with cross-group access AND the ability to
change enforcement points. This skill is the codified *looking*: which
surfaces to pull, in what order, what healthy looks like, and the rule that
every finding ends as a shipped fix, a dispatched fix, or a named human
decision — never as prose alone.

Takes a workgroup folder name as its argument (`/fleet-retro <workgroup>`).
Paths below use `$WG = data/workgroups/<workgroup>` and the workgroup's agent
group folders under `groups/`. Where this install keeps a surface elsewhere,
follow the convention, not this file.

## Principles

- **Count against the authoritative source, never artifacts that describe
  it.** The gate ledger over filesystem sweeps; the DB over a board; the
  executing task's stored script over same-named files on disk.
- **Read what the fleet already wrote before re-deriving.** Agents record as
  they work; this retro is the only retro *event*. Their records are input.
- **Absence is only evidence when presence was possible.** "Ran and found
  nothing" ≠ "did not run". Date every event; prefer DB/ledger timestamps.
- **Fix-or-dispatch discipline**: small defect in a control you own → fix in
  this session, through the same gates the fleet uses. Larger → dispatch to
  the owning lane with a claim. Human-scoped → the decision list, with the
  exact action named. Silently dropping a finding fails the retro.
- **Peer-check anything consequential** you conclude — a cross-family
  reviewer on any control you patch.

## Phase 1 — harvest the fleet's own records (cheapest signal first)

- `$WG/releases/decisions.md` — rulings since the last retro (tail from the
  last dated retro entry). What changed, what got overruled.
- `$WG/releases/machinery.md` — new facts and bumped `seen:` counts; a
  rediscovered fact is a findability failure.
- Recent QA campaign run trees (under the workgroup's QA lane dir) — read the
  dissent lines and "untested / limits" sections of terminal syntheses, not
  the whole trees. A raised-and-overruled objection is the highest-value line.
- Fleet-authored edits to control files: `git -C data/workgroups log --stat`
  since the last retro. Verify any edit to an enforcement script before
  blessing it (parse, tests, live-run evidence) — fleet edits are hypotheses
  with good provenance, not pre-verified.

## Phase 2 — enforcement health (stored queries, never hand counts)

- Required-check publisher: its append log (publishes/hour, state
  transitions, `inputs unreadable` bursts) and the service journal for
  crashes. Any PR red on the same predicate for days = a stuck input or a
  check defect — decide which by reading the named predicate.
- Attribution ledger (`claims/ledger.ndjson` or equivalent): every merge in
  the window has a row; execution events never appear in human gate files.
- Gate ledger vs verdict artifacts: one terminal marker per run, digests
  consistent, `reconciliation_required` count is zero or explained.
- Re-verification queue: inflow (merges) vs drain (independent executions).
  A queue that only grows is the old 144-item disguise returning.
- Instruction-surface audit (`ops/instruction-budget.sh` or equivalent):
  over-budget files = conversion backlog, not trim orders.
- Scheduled-task inventory (`ncl tasks list`): no scheduled wake holds a
  production-mutation capability outside the pre-authorized at-head-ship
  rule; spot-read any task whose prompt changed since the last retro.

## Phase 3 — the rooms

Read the workgroup's process and QA channels since the last retro (Slack API
by channel id, or the archive DB). Healthy: terminal digests, interrupts,
dissent lines, handoffs-with-permalinks; volume low. Unhealthy: narration,
re-derived state, acknowledgment loops, alert noise. Note WHO is generating
any noise — the fix is usually one instruction or one alert filter, not a
lecture. Before assigning any work you conclude is needed: **read the thread
where that work would live, to its last message** — the fleet may already be
doing it, and a duplicate dispatch from the host is the same failure the
rules exist to prevent (this skill's author committed it once).

## Phase 4 — lifecycle spot-checks (one of each, end to end)

Pick ONE recent instance of each and walk it against the contract:
- a merged PR: labels → recipes → check state → ship record (if required) →
  merge → ledger row → issue lifecycle label → queue row;
- a terminal campaign: lease → deadline → verdict artifact → digest →
  dissent line → handoff;
- a human decision: raised → routed → answered or aging (and whether
  settled-by-silence items carry dated defaults).
A spot-check that fails promotes to a full sweep of that surface.

## Phase 5 — measurement rules, only when due

If a pre-committed measurement rule exists (frozen thresholds, observation
window), evaluate it ONLY when its window has elapsed — never peek early,
never re-litigate thresholds after evidence exists. Record "measured
unnecessary" as a success outcome where the numbers say so. The invoking
operator satisfies the evaluator-is-not-the-author rule.

## Phase 6 — close the loop

- Ship or dispatch every mechanical finding (see fix-or-dispatch above).
- Update the fleet's records the same way agents must: ruling to
  decisions.md first, then the instruction; machinery line for any new tool
  fact; commit control-record changes (or confirm the journal timer will).
- Deliver the report: a control table (live / drifting / defective, with the
  verification command per row), defects found with their fix state, the
  human-decision list with exact actions, and — as an artifact when the
  operator will share or revisit it — the same table published.

## What this skill is not

Not scheduled (on-demand only — a cron'd retro manufactures exhaust), not a
substitute for the fleet's continuous records, not a re-run of a prior
retro's conclusions (read them, verify only what's load-bearing), and never
run from inside a container.
