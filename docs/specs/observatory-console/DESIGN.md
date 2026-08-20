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

Parse the platform channel from `thread_id`. Deduped correctly the install had
**13 distinct channels in 7 days**, carrying 1–8 agents each. That is a sidebar,
not a search problem.

**Do not take the middle segment.** An earlier revision of this document said
the key was the second segment of `<channel_type>:<channel>:<ts>`. That is true
for Slack and **false for Discord**, whose ids are
`discord:<guild>:<channel>[:<thread>]` — the middle segment is the *guild*, so
the rule collapses every wired Discord channel into a single bucket.

Resolve the key by **longest-prefix match against `messaging_groups.platform_id`**,
which is data-driven and needs no per-platform special-casing, with a shape
fallback for channels that are not wired. The parser must survive every shape
present in real data: three-part Slack ids, Discord guild/channel/thread ids,
the `tasks` pseudo-channel, DM ids beginning `D`, `spawn-<hash>` ids, and legacy
bare timestamps with no prefix at all. A malformed id degrades to a single
shared `unknown` bucket — never a per-row bucket, which would fill the sidebar
with noise — and never throws.

**Known bug, not fixed here:** `threadPlatformId()` in
`src/dashboard/api/observatory.ts` carries the same two-segment assumption. It
currently survives only because `threadPermalink` falls through to the bare
`discord` adapter key. Fix it when that file is next touched.

### 3.3 Volume is far smaller than the session count implies

Half of all active sessions hold **exactly one message** (median 1, p75 8, p90
67, p95 162, max 11,428).

Counted as raw threads it is 230 in 24h and 1,177 in 7d. But an inbound message
that never woke an agent still mints a session row — in a `mention`-mode channel
that is *every non-mention message* — and §1 says every row ends in a verb, so
those rows do not belong in the queue. Applying the same engaged-only filter
`sessions.ts` already uses (`last_outbound_at IS NOT NULL OR container_status <>
'stopped' OR an in-flight task`), the real working set is **63 threads in 24h
and 213 in 7d**.

That is roughly four times smaller than an earlier revision of this document
claimed. Virtualization is emphatically not required. Do not design around a
scale that does not exist.

### 3.4 `sessions.container_status` lags — do not trust it

The list API recomputes liveness from `.heartbeat` mtime: `<60s` running,
`<300s` idle, else stale. New queries must do the same rather than reading the
column.

## 4. Row anatomy

Fixed order, top to bottom, left to right:

| Zone | Rule |
|---|---|
| Status bar | 3px, full row height, colour = urgency. **Transparent when the row wants nothing** — the state label carries the word instead. The artboards paint parked/done grey; this document wins, and the disagreement is recorded here rather than left for someone to rediscover. |
| Avatar stack | Thread **participants**, not an owner. Max 3 faces, 2px white ring, −8px overlap, then a `+N` pill. |
| Title | `sessions.title` (generated). Always present. Single line, ellipsis. |
| Hybrid line | The **actual last message** as `Speaker: excerpt`. Present on any row wanting attention, including stalled. Absent on healthy running, parked and done rows. |
| Live line | Monospace. Current tool + elapsed. Rows with a tool in flight — **running or stalled**. A stalled row must show it, holding still (§6); an earlier revision said "running rows only" and contradicted §6. |
| Meta line | `channel · N agents · age`. Always present. |
| State label | One of the six states in §5. |
| Verb | Exactly one primary verb per state (§5), visible on desktop. **`Idle` is the single exception and carries none** — §1's "every row ends in a verb" holds for every state that wants something, which is the claim that matters. On mobile (§8) the verb renders only on rows wanting attention. |

### 4.1 The hybrid line exists to control cost

Message bodies live in each session's own DB files; there is no central rollup.
Rendering a preview on *every* row means opening hundreds of files per refresh.
Rendering it only on attention rows — a handful at a time — is the cheapest
thing available on exactly the rows where it earns its place.

**Be honest about what that costs.** The list endpoint carries no last message,
so the only source is the detail endpoint, which returns a merged transcript per
call. The implementation caps it at 8 attention rows and keys its cache on
`(thread_id, last_activity_at)` so a burst on other threads costs a given row
nothing. That is a mitigation, not free — an earlier revision claimed it "costs
approximately what a title costs", which is not true.

The fix that would make it true is a `last_message` field on the list row, or
the rollup this section mentions. Until one exists, do not raise the cap and do
not fetch previews for all rows.

## 5. The six states

Each state names what computes it. A state that cannot be computed does not
exist.

| State | Computed from | Verb |
|---|---|---|
| **Unassigned** | Work item with no session at all | Assign |
| **Needs you** | Claim parked with a `waiting on <human>` note, **or** the existing `needs_me` signal (task `needs_input`, unanswered `ask_question`) | Answer |
| **Stalled** | `container_state.tool_started_at` older than 30m with no newer output, **or** `provider_status = 'failed'` | Kill |
| **Running** | A live container process for the session | Steer |
| **Parked** | Claim in `parked` state | Reassign |
| **Done** | `archived_at` is set | Close |
| **Idle** | None of the above | — |

Four corrections against an earlier revision, each found by implementing it:

- **`Idle` is the seventh state and it is the common case.** A thread that is not
  running, holds no claim, is not archived, and whose last tool finished normally
  matches none of the other six — **57 of 63** threads in a live 24h window. The
  earlier six did not partition the space. Render it as a real state; do not
  mislabel it `Done` and do not drop the rows.
- **`Running` is gated on liveness alone**, not on a tool being in flight. Taken
  literally the old rule left a healthy container *between* tool calls with no
  state at all. `current_tool` and `tool_started_at` are exposed as their own
  fields, which is what the activity rule in §6 animates from anyway.
- **`Done` has exactly one computable source: `archived_at`.** "Verified and
  closing" named no source, which violated this section's own rule that a state
  which cannot be computed does not exist. Note the consequence: archived rows
  are hidden by default, so `Done` is nearly absent from the default list. If it
  needs to mean more than "archived", it needs a real signal first.
- **`Unassigned` outranks everything.** A work item with no session cannot have a
  container, a claim, or a transcript, so it is resolved before the rest.

**This table is derivation precedence, not display order.** The list sorts by
urgency: `needs_you`, `stalled`, `unassigned`, `running`, `parked`, `idle`,
`done`. Keep the two concepts separate — a reader who conflates them will
"correct" one to match the other.

**`Unassigned` is unreachable today and that is expected.** The thread list is
derived from sessions, so a row always has at least one session and the state
never fires. It becomes reachable when the release-board/findings join in §10
lands. The row renders correctly when the data arrives; there is simply no data
yet. Do not delete the state as dead code.

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
| top bar | `#141414` |
| sidebar | `#171717` |
| attention wash | `#2c110f` |
| border / chip | `#292929` |
| wash chip | `#3a1a17` |
| ink | `#dedede` |
| secondary | `#989898` |
| muted | `#868686` |
| attention | `#f66e5c` |
| live | `#45b164` |

Top bar, sidebar and wash chip were absent from an earlier revision and had to be
derived during the build; all three are AA-clear against every ink above.

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
- **`muted` is for page and wash surfaces only — never on a chip.** The palette
  in §7.1 violates its own contrast rule there: `#636363` on `#dedede` is 4.47:1
  light, `#868686` on `#292929` is 4.00:1 dark. Chips take `secondary`. A test
  pins this so nobody simplifies it back.
- **Known edge:** attention `#b32322` on the light wash chip `#eacfca` is 4.49:1
  — one hundredth under. No text sits there today. If a filled wash chip ever
  takes attention-coloured text, retune before shipping it.
- Contrast is verified by computation over every ink×surface pair in both
  palettes, not by eye. Keep that test.

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
2. **Agent identity on the thread list.** No thread-list endpoint existed at all
   before this build; `/api/sessions` is session-keyed and carries no agent
   identity, and the endpoint that has identity carries no list. Only ~20 agents
   exist, so identity rides inline on each participant in a single round trip.

   Resolve display names per `(agent, messaging_group)`, not per agent. Bot
   display names differ by channel, so resolving with a null messaging group
   prints the canonical agent-group id — a row reads `<workgroup>-<role>` where
   the channel shows the friendly name. §11 requires the friendly name.
3. **Reconciling two steer paths.** `POST /dashboard/api/sessions/:id/message`
   writes into the session's inbound queue and echoes to the origin thread (this
   one works and stays). `observatory/steer|nudge|assign` instead spawn a
   one-shot task and accept only claims or release-board items. A unified
   thread action bar has to reconcile them.
4. **Surfacing `provider_status`.** Written today, read by nothing.

## 11. Carried over unchanged

- Real Slack avatars via `getKnownSlackBots()`, through the shared
  `AgentAvatar` component with its initials fallback.

  **There is no pixelation to remove.** An earlier revision of this document
  said the UI pixelated avatars client-side and that the console should stop.
  That was never true — it came from stale comments at
  `src/dashboard/api/observatory.ts:64` and `dashboard/src/views/office-data.ts:36`;
  a search for `image-rendering` / `pixelated` / `feMorphology` across both trees
  finds nothing. Real faces were already shipping. Both comments are corrected.

  The fallback rule lives in `AgentAvatar` and nowhere else. It takes an optional
  two-letter monogram, because at 25px a one-letter fallback collapses several
  same-initial agent names to an identical glyph, on a screen whose entire job is
  telling agents apart.
- Friendly per-channel display names, never internal IDs.
- Schematic floor plan, never pixel art. It is a **lens in the sidebar, not a
  destination**.
- Schedule is likewise a lens; a failed or overdue run becomes a work item in
  the main queue.
- Triage is a **mode entered from the list**, never the home screen: one thread,
  three verdict keys, auto-advance.
