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
| Verb | The message action, labelled per state (§5), visible on desktop. **Every row carries one, `idle` included** — the one mechanism is available everywhere, so §1's "every row ends in a verb" now holds without exception rather than with one. On mobile (§8) the verb renders only on rows wanting attention; elsewhere the row is tappable. |

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

**There is ONE action: send a message to a chosen agent.** Two parameters — which
agent, and what you say. The per-state entries below are *labels over that one
mechanism*, not seven mechanisms. An earlier revision specified them as distinct
verbs, three of which had no backing mechanism at all; the operator replaced that
model and this section follows him.

| State | Computed from | Label |
|---|---|---|
| **Unassigned** | Work item with no session at all | Assign |
| **Needs you** | Claim parked with a `waiting on <human>` note, **or** the existing `needs_me` signal (task `needs_input`, unanswered `ask_question`) | Answer |
| **Stalled** | `container_state.tool_started_at` older than 30m with no newer output, **or** `provider_status = 'failed'` | Push |
| **Running** | A live container process for the session | Steer |
| **Parked** | Claim in `parked` state | Hand to… |
| **Done** | `archived_at` is set | Steer |
| **Idle** | None of the above | Steer |

**There is no Kill.** An earlier revision gave `stalled` a Kill verb. A stalled
thread does not need killing, it needs a message — and exposing `killContainer`
over HTTP would have meant minting a new guarded privileged surface to do
something the operator does not want. Removed, not disabled.

**Assign and reassign are the same action as steer**, differing only in whether
the chosen agent already has a session on the thread. The selector therefore
spans every wired agent, not just current participants; choosing one without a
session creates it and delivers.

**Reassign does not need to write an owner.** An earlier revision recorded that
"nothing writes an owner back to a claim file" as a blocking gap. It is not one —
the dashboard was never the right place to move a claim. You hand the work to
another agent and the agents settle the claim between themselves through the
work-claims convention.

That convention is what makes the handoff a two-message action rather than one:
`take` REFUSES a live claim held by someone else (exit 3), a *parked* claim may
be taken by anyone, and `--takeover` exists but "records an override; it does
not make one correct." So when the chosen agent is not the current live-claim
holder, the console also sends the holder a **server-composed** note asking it to
park or release. Without that, the receiving agent meets a locked door or reaches
for the override. The note is never free text.

Close and Snooze remain the two non-message actions — "get it out of my queue"
is not something you say to an agent.

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

## 12. Doctrine inherited from the retired Observatory

The legacy Observatory was deleted in favour of this console. Most of what it
knew was ported as code; what follows is the part that was only ever written
down. Each line below is a bug someone already paid for, quoted from the file
that carried it, and kept here because the file no longer exists.

**An affordance must be able to succeed.** A nudge composes into a claim's own
thread and refuses when there is none, so the surfaces that draw the button read
the same predicate off the claim rather than each deciding for themselves —
*"a button whose only outcome is that 409 is worse than no button"*, and *"a
member, or a row with nowhere to land, would otherwise get a prefilled box whose
send can only ever be refused."* Before that predicate was shared, one surface
hardcoded "no" and silently offered less than its neighbours. This is why the
console renders a disabled verb with a reachable explanation instead of a live
button that cannot work.

**Surface the defect; never smooth it.** Work with no owner is *"breached at
birth — nobody has promised anything, so there is nothing to be on track for. It
sorts with the breaches, not into a tidy 'unowned' bucket that reads as a
backlog."* An owner with no due date is *"undated — a promise with no clock is
indistinguishable from no promise"*, and is reported as a coverage gap rather
than assumed fine.

**Count the gap; never guess into it.** A release-blocking rule existed but was
never wired, so every finding published `false` — *"including an auth bypass that
sat unowned for eight days."* The response was not to infer the class from prose:
*"guessing would be the same fiction as inventing a dependency edge. What we can
do honestly is count the gap, so it is visible that nothing has been classified
at all."* Coverage gaps therefore ship beside any derived number, uncollapsed,
because *"a collapsed disclosure would soften exactly the thing that must not
soften."*

**An unmeasured value is not a zero.** An age nobody measured *"has no place on a
time axis, and defaulting it to zero would park every undated row at one end and
call that an ordering."* It renders as an em dash and sorts last within its
class — in both directions, explicitly, never as a side effect of the comparator
happening to point one way.

**An invented number is worse than none.** Counts stay absent until the data can
support them rather than being filled with a plausible figure.

**Undeclared must never read as independent.** An omitted field means nobody
checked; an explicit empty one means checked and clear. Rendering them alike
turns missing work into good news.

**A guess is not a decision.** Where an ask should land, when the work has no
home of its own, is *"a human's decision about where the work belongs rather than
a guess the server made"* — and where there is no answer, the server refuses
instead of picking.

**One control, drawn everywhere.** The action row exists once because the
affordances *"used to be three near-identical controls bolted onto whichever
surface last needed them"*, so one surface could push work forward and another
could only link at it. *"A row is a row wherever it is drawn."*

**Not everything should be routed to an agent.** For work that genuinely needs a
person, the row says where to go rather than offering to hand it off — *"the
whole point of this row is that a PERSON has to answer it"* — and links only when
a real destination exists, because *"dead text pointing nowhere is worse than a
plain sentence."*

**The answer to "what is stuck" is a ranking, not a picture.** It has to work on
a phone.

**A view must not disagree with its own headline.** A default filter once
admitted rows the headline had already counted differently, so the board's own
summary could contradict the rows beneath it. Filter on the same predicate the
headline counts.

**A side effect that precedes its record needs a lock, not just a constraint.**
A primary key guarantees one row, but by the time the losing insert is detected
the loser has already posted to the platform — *"the board stays right while the
channel collects an orphan thread nobody will ever answer in."* Belt, then
braces: an in-process lock for the window, the constraint behind it for the
restart case.

**The thing that notices silence cannot be the thing that went silent.**
Detection belongs to *"dumb code on a clock — an agent asked to notice its own
silence is the one actor structurally incapable of it."*
