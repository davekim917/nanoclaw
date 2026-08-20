# Observatory Console — design contract

Status: **approved direction, not yet built.** Supersedes the tom-modern
Observatory shipped 2026-08-17 and every surface in it.

This document is binding on the build. Where it states a rule, the rule is
written as a checkable shape rather than an adjective — "row height ≥ 44px on
mobile", not "comfortable spacing". If a rule here proves wrong, change this
document first and say so; do not diverge silently.

---

## 1. Why the previous version failed

The old Observatory had **no primary object**. It rendered exceptions, rooms,
sessions, commitments and findings — five nouns, none dominant — so every page
invented its own layout, and tiles existed whose only affordance was a link off
to GitHub. Re-skinning cannot fix that. Choosing one primary object can.

Two rules fall out of it, and both are load-bearing:

- **Every row ends in a verb.** If the only thing you can do with a row is leave
  the application, it is not a row — it is a field on some other row.
- **No board, no columns.** Status is a property you sort and filter on, never a
  spatial column you drag between. Threads are routinely in-progress *and*
  waiting *and* fine simultaneously; no honest column exists for that.

## 2. Primary object

The primary object is a **work item**, realised as a **thread**.

An unowned work item (a smoke finding nobody has picked up) is the same object
at an earlier stage. It has no thread yet, and **Assign is the verb that creates
the thread**. Unowned items therefore appear in the *same* queue as live
threads, never in a separate inbox.

## 3. Data rules

These four are non-negotiable and each one silently produces a wrong UI if
missed. Measured against the live central DB on 2026-08-20.

### 3.1 A row is a thread, never a session

`sessions` is keyed on `(agent_group_id, messaging_group_id, thread_id)`. A
thread carrying six agents is therefore **six session rows**. At time of
measurement: 6,812 active sessions against 3,984 distinct active `thread_id`s,
with 35% of threads carrying more than one agent (distribution 1→2585, 2→462,
3→632, 4→196, 5→94, 6→15).

**A session-keyed list renders ~40% duplicate rows.** Group by `thread_id` and
render participants as an avatar stack.

`thread_id` is the durable identity. `session.id` is not — a thread's session
can close and reopen under a new id while `thread_id` is unchanged.

### 3.2 The channel key is parsed from `thread_id`, never `messaging_group_id`

`messaging_groups` holds **one row per sibling bot per channel**. Grouping on
`messaging_group_id` lists the same channel once per wired bot.

Parse the platform channel from `thread_id`, whose shape is
`<channel_type>:<channel>:<ts>` — the middle segment is the key. Deduped that
way the install had **13 distinct channels in 7 days**, carrying 1–8 agents
each. That is a sidebar, not a search problem.

### 3.3 Volume is far smaller than the session count implies

Half of all active sessions hold **exactly one message** (median 1, p75 8, p90
67, p95 162, max 11,428). The real working set is **360 threads in 24h, 1,896 in
7d**. Virtualization is a nice-to-have, not a requirement. Do not design around
a scale that does not exist.

### 3.4 `sessions.container_status` lags — do not trust it

The list API recomputes liveness from `.heartbeat` mtime: `<60s` running,
`<300s` idle, else stale. New queries must do the same rather than reading the
column.

## 4. Row anatomy

Fixed order, top to bottom, left to right:

| Zone | Rule |
|---|---|
| Status bar | 3px, full row height, colour = urgency. Transparent when the row wants nothing. |
| Avatar stack | Thread **participants**, not an owner. Max 3 faces, 2px white ring, −8px overlap, then a `+N` pill. |
| Title | `sessions.title` (generated). Always present. Single line, ellipsis. |
| Hybrid line | The **actual last message** as `Speaker: excerpt`. Present on any row wanting attention, including stalled. Absent on healthy running, parked and done rows. |
| Live line | Monospace. Current tool + elapsed. Running rows only. |
| Meta line | `channel · N agents · age`. Always present. |
| State label | One of the six states in §5. |
| Verb | Exactly one primary verb per state (§5). Always visible on desktop. |

### 4.1 The hybrid line exists to control cost

Message bodies live in each session's own DB files; there is no central rollup.
Rendering a preview on *every* row means opening hundreds of files per refresh.
Rendering it only on attention rows — a handful at a time — costs approximately
what a title costs, on exactly the rows where it earns its place.

Do not "improve" this by fetching previews for all rows without first building a
rollup table.

## 5. The six states

Each state names what computes it. A state that cannot be computed does not
exist.

| State | Computed from | Verb |
|---|---|---|
| **Needs you** | Claim parked with a `waiting on <human>` note | Answer |
| **Stalled** | `container_state.tool_started_at` older than 30m with no newer output | Kill |
| **Unassigned** | Work item with no owner and no thread | Assign |
| **Running** | Heartbeat fresh and a tool in flight | Steer |
| **Parked** | Claim in `parked` state | Reassign |
| **Done** | Verified and closing | Close |

`container_state.provider_status` (`idle` / `active` / `failed`) is populated,
cross-provider, and currently read by **zero** dashboard code. `failed` must
surface. This is the cheapest high-value signal available.

### 5.1 `current_tool` fidelity varies by provider — design for it

Claude sessions report readable tool names. Codex sessions report the generic
wire name `CodexItem`, and roughly half the fleet is non-Claude. The live line
will be informative on some rows and near-useless on others.

**The stall detection underneath it works for every provider**, because it
depends only on `tool_started_at` age, never on the tool's name. Build the live
line, but do not make any state depend on the step text being readable.

## 6. The liveness rule

The 2px rule beneath a running row is an **activity indicator, not progress**.

- **Its length encodes nothing.** There is no percent-complete signal in the
  system: a tool call has a start time and no expected duration. Any percentage
  would be fabricated. An earlier draft shipped invented widths and they were
  correctly read as meaningful; that is precisely the failure to avoid.
- **Motion means a tool is running right now.**
- **A stalled thread's rule holds still.** Motion = working, stillness = stuck.
  This is the single most valuable glanceable signal on the screen.
- Gated on `prefers-reduced-motion`, where it degrades to a static dimmed rule.

This is the general principle applied: **animation is reserved for live state
and is never decorative.** One vignette per surface at most; idle surfaces are
perfectly still.

## 7. Visual direction — "Terminal neutral"

Light-first. Dark is a designed palette, not an inversion.

**Type.** `Public Sans` for human prose; `JetBrains Mono` for every
machine-produced value — timestamps, elapsed, tool names, counts, ids. Both need
real fallback stacks with close metrics. Monospace for data is functional, not
stylistic: it makes numbers comparable down a column.

**Never use** Inter, Roboto, Arial or Fraunces, including in fallback stacks.

**Ground: true zero-hue grey.** No warm cast (reads as print, and print was
rejected), no blue cast.

### 7.1 Tokens

Light:

| Role | Value |
|---|---|
| page | `#f7f7f7` |
| top bar | `#f3f3f3` |
| sidebar | `#f0f0f0` |
| attention wash | `#ffe0da` |
| border | `#cecece` |
| chip | `#dedede` |
| wash chip | `#eacfca` |
| row divider | `#dfdfdf` |
| ink | `#141414` |
| secondary | `#525252` |
| muted | `#636363` |
| attention | `#b32322` |
| live | `#006c24` |

Dark:

| Role | Value |
|---|---|
| page | `#0d0d0d` |
| attention wash | `#2c110f` |
| border / chip | `#292929` |
| ink | `#dedede` |
| secondary | `#989898` |
| muted | `#868686` |
| attention | `#f66e5c` |
| live | `#45b164` |

Decorative only (icon strokes, no text-contrast requirement): `#808080`.

**Two functional signals only** — one "wants you" (red, hue ~27°), one "live"
(green, hue ~148°). They must never read as the same alarm. Everything else is
grey. Do not introduce a third status hue without amending this document.

### 7.2 Accessibility rules

- **Every text pairing ≥ 4.5:1** against the surface it actually sits on — page,
  sidebar, attention wash, and the dark equivalents. The binding constraint is
  the darkest light surface or the lightest dark surface a colour touches, not
  the page background.
- **Filled chips flip their text colour in dark mode.** The dark accents are
  bright enough that white text on a filled chip fails contrast; such chips use
  near-black text. This is a rule, not a one-off — it ships broken silently
  otherwise.
- **Mobile tap targets ≥ 44px**, enforced with an explicit `min-height`.
- Never reuse `#a1a1aa`-class greys for text. They fail AA on white.

## 8. Mobile — 390px is the primary viewport

- Avatar stack shrinks to 24px, max 3 faces.
- Title clamps to 2 lines.
- Meta collapses to `channel · age`.
- The always-visible verb **does not survive**. It appears as a 44px button only
  on rows that want something; other rows are tappable with a chevron.
- Bottom bar, 56px, four destinations, each with a distinct icon.

## 9. Deliberately absent

Both omissions are deliberate. Adding either without building its data source
first is a regression.

- **Per-thread cost.** `turn_usage` is per-session and rolls up only to
  `(date, agent_group, provider, model)`. A per-thread figure would need a new
  rollup. Absent rather than faked.
- **Percent complete.** See §6.

## 10. Known new work

Everything else runs on data that already exists.

1. **Thread-merged transcript.** A thread's messages are split across one DB
   pair per agent; the existing detail endpoint is per-session. The detail pane
   must merge N sessions in timestamp order.
2. **Agent identity on the thread list.** The thread-list endpoint carries no
   agent identity; the endpoint that has identity carries no thread list. Only
   ~20 agents exist, so the client can hold the map — but the join must exist.
3. **Reconciling two steer paths.** `POST /dashboard/api/sessions/:id/message`
   writes into the session's inbound queue and echoes to the origin thread (this
   one works and stays). `observatory/steer|nudge|assign` instead spawn a
   one-shot task and accept only claims or release-board items. A unified
   thread action bar has to reconcile them.
4. **Surfacing `provider_status`.** Written today, read by nothing.

## 11. Carried over unchanged

- Real Slack avatars via `getKnownSlackBots()`, through the shared
  `AgentAvatar` component with its initials fallback. **Remove the client-side
  pixelation** — real faces.
- Friendly per-channel display names, never internal IDs.
- Schematic floor plan, never pixel art. It is a **lens in the sidebar, not a
  destination**.
- Schedule is likewise a lens; a failed or overdue run becomes a work item in
  the main queue.
- Triage is a **mode entered from the list**, never the home screen: one thread,
  three verdict keys, auto-advance.
