# Scope: per-support-issue Slack threads + sessions

**Branch:** `worktree-per-email-thread-sessions`
**Status:** SCOPING (not approved, not built)
**Author:** drafted with Claude Code, 2026-05-30
**Builds on:** `2a7e80e9` (delivery-side per-turn channel-root threading — already shipped to `main`)

> This is a scoping doc, not an approved design. It maps the current system,
> states the real goal, lays out options with trade-offs, names the open
> decisions only Operator can make, and sketches a phased plan. Nothing here is
> built. Run `/team-brief` → `/team-design` if we want the full workflow once
> the open decisions are settled.

---

## 1. The goal (corrected framing)

**Email is a read-only source, not a channel.** We are NOT building an email
chat adapter and NOT routing conversation through email. The flow is:

```
person24@fixture5.example.com inbox  →  triage + create Linear ticket  →  work the issue
                                                                  in Slack with
                                                                  Example Labs engineers
```

What we want: **each distinct support issue gets its own Slack thread and its
own agent session**, instead of every support email collapsing into the single
long-lived poller session (`sess-1700000000000-example05`) that all `*/15` fires
share today.

The natural unit is the **support issue**, identified by **Gmail `threadId`**
(which already 1:1-maps to a Linear ticket). NOT the poll tick (most ticks find
nothing) and NOT the individual email (a thread accretes replies over time).

```
one Gmail thread  ⇄  one Linear ticket  ⇄  one Slack thread  ⇄  one agent session
```

Follow-up emails on an existing Gmail thread must route into the **same** Slack
thread + session, so the engineer conversation stays in one place with full
context.

**Outbound email replies are Slack-driven, Gmail-sent.** An engineer can ask the
agent (in the Slack thread) to draft a reply to the customer; the draft + review
+ approval all happen in Slack, and only the final **send** goes back out via
Gmail on the *same* email thread (`gws gmail ... send` with the right threading
headers). Email is never a conversation surface — it's a read source and a
send target. This makes "the per-issue session holds the Gmail thread identity"
a hard requirement (we reply *into* the original thread, §3.3).

---

## 2. Current architecture (grounded)

### 2.1 How the inbox is read — pre-script, container-side

The poller is a **recurring scheduled task** (`task-1780158666153-whlle2`, cron
`*/15 * * * *`) living as a `messages_in` row in the poller session's
`inbound.db`. The task content carries an inline `script` (Python) that runs
**inside the container** before the agent wakes:

- `container/agent-runner/src/scheduling/task-script.ts:79-121`
  (`applyPreTaskScripts`) executes the script via `runScript` (`:19-65`).
- The script queries Gmail with the `gws` CLI
  (`GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=.../support-example-labs.json`), filters
  promotions/automated senders, and emits a single JSON line:
  `{"wakeAgent": true|false, "data": {"newMessages": [...]}}`.
- `wakeAgent:false` (no new mail) → task skipped, **agent never invoked** (this
  is why most ticks are free no-ops, not empty sessions).
- `wakeAgent:true` → `content.scriptOutput = data` (`task-script.ts:116`) and
  the formatter renders it into the prompt. The agent processes the whole
  `newMessages` batch **in one turn, in one session.**

Each `newMessages[i]` already carries:
`{ id, threadId (Gmail), from, subject, date, snippet, existingTicket }`,
where `existingTicket` is `null` for a fresh thread or `{team, issue}` when the
Gmail thread is already ticketed (looked up from
`/workspace/agent/support_ticketed_threads.json`).

**→ The per-issue identity we need (Gmail `threadId`) is already in the
payload. No new extraction work.**

### 2.2 How the result reaches Slack today

The agent loops over `newMessages`, writes Linear tickets/comments
(`mcp__linear__save_issue` / `save_comment`), labels the Gmail message
`bot-ticketed`, appends to `support_ticketed_threads.json`, and posts **one
summary** to the `slack_example-labs_agents-example` channel. As of `2a7e80e9` those
summary messages thread under the fire's first post (per-turn anchor) — but
they're still all in the **one shared poller session**, with no per-issue
working space.

### 2.3 The reuse target — orchestrator-dispatch (spawn) threaded path

`src/modules/orchestrator-dispatch/dispatch.ts` already implements *exactly* the
"open a native thread + dedicated session and route work into it" pattern:

- `:268` branch on `surface_mode === 'native_thread'`
- `:311-323` **postParent** → `adapter.postParent(platformId, text)` returns a
  parent message id
- `:325-345` **createThread** → `adapter.createThread(platformId, parentMsgId,
  title, firstMessage)` returns a native thread id
- `:354-376` **resolveSession** → `resolveSession(childAgentGroupId,
  messagingGroupId, encodedThreadId, 'per-thread')` creates a per-thread session,
  records `child_session_id` on the `tasks` row, writes the first inbound via
  `writeSessionMessage`, then `wakeContainer`.

Adapter methods are already in the interface
(`src/delivery.ts` `ChannelDeliveryAdapter.postParent/createThread`) and
implemented for Slack (`src/channels/slack.ts` `slackPostParent` /
`slackCreateThread`, using `thread_ts`).

### 2.4 Session model facts that constrain the design

- `resolveSession(agentGroupId, mgId, threadId, 'per-thread')` keys a session on
  `(agent_group_id, messaging_group_id, thread_id)` and stores `thread_id`
  (`src/session-manager.ts:281-334`). **No** unique constraint on per-thread
  rows — only the channel-root partial index
  (`migration 024-sessions-channel-root-unique`:
  `UNIQUE(agent_group_id, messaging_group_id) WHERE thread_id IS NULL AND
  status='active'`). So creating many per-thread sessions is safe.
- Scheduled tasks live in the **channel-root** session's `inbound.db`
  (`scheduling.ts` comment `:117-119`). They are deliberately thread-unbound —
  binding a recurring task to a thread would tie its lifetime to a session that
  can die. **This must not change.** The poller stays a channel-root task.
- `handleRecurrence` / `insertRecurrence`
  (`src/modules/scheduling/recurrence.ts`, `db.ts:138-159`) re-arm the poller by
  inserting a fresh `messages_in` row each fire with a **new id** (→ fresh
  `in_reply_to` per fire; the basis of the shipped delivery fix).

---

## 3. The design (recommended shape)

**Split the poller's two jobs.** Today one session both *detects* and *works*
every email. Separate them:

1. **Triage/dispatch (stays in the channel-root poller session).** Each fire,
   for every `newMessages[i]`:
   - Apply the existing human-judgment + noise filter and create/locate the
     Linear ticket (unchanged logic).
   - **New thread (`existingTicket == null`):** open a per-issue Slack thread
     and a per-issue session, seed it with the ticket + email body, and record
     the mapping `gmailThreadId → { linearIssue, slackThreadId, sessionId }`.
   - **Existing thread (`existingTicket != null`):** look up the stored
     `slackThreadId`/`sessionId` and **route the new email into that existing
     thread/session** (wake it with the new reply), instead of posting a
     standalone comment.

2. **Work the issue (per-issue session, bound to its Slack thread).** Engineers
   reply in the Slack thread; that wakes the per-issue session, which has the
   full ticket context and works *only* that issue. This is an ordinary
   per-thread session — no new session machinery.

### 3.1 Two ways to implement the fan-out

**Option A — agent-driven dispatch (reuse orchestrator-dispatch as-is).**
The poller (triager) agent calls a dispatch/spawn MCP tool per new ticket; the
existing `dispatch.ts` threaded path opens the Slack thread + per-thread session
and seeds it. Follow-ups: triager routes the reply into the existing child
session.
- **Pro:** reuses a battle-tested, already-shipped path (postParent →
  createThread → per-thread session → wake), watchdog/reconciler/completion
  included. Minimal new host code.
- **Con:** the triager spends a Claude turn deciding/dispatching; couples
  support to the orchestrator-dispatch task model (tasks table, surface_mode,
  watchdog reaping) which may not fit a long-lived support thread that idles for
  days awaiting an engineer reply.

**Option B — mechanical host-side dispatch (new, thin).**
Extend the pre-script protocol: the script emits a `dispatch` array
(one entry per new/updated Gmail thread, each with its single-email payload and
ticket info). A new host-side handler (mirroring `dispatch.ts` steps 1-3 but
without the `tasks`/watchdog layer) resolves a per-thread session keyed by a
stable id derived from the Gmail thread, opens the Slack thread on first sight,
and writes the per-email payload as that session's inbound.
- **Pro:** no Claude turn spent on dispatch; clean lifecycle decoupled from the
  orchestrator-dispatch watchdog (support threads can idle indefinitely); the
  triager LLM judgment can still run *inside* each per-issue session on first
  message rather than in a central batch.
- **Con:** new host code; must re-implement the postParent/createThread/session
  seeding (can factor the shared helper out of `dispatch.ts`).

**Leaning:** Option B for lifecycle cleanliness (support issues are long-lived
and human-paced; the orchestrator-dispatch watchdog is built to *reap* stalled
autonomous workers, the opposite of what a support thread wants), but factor the
`postParent→createThread→resolveSession(per-thread)→seed→wake` sequence into a
shared helper so both spawn and support use one code path. **This is an open
decision (§5).**

### 3.2 The mapping store

`support_ticketed_threads.json` already maps `gmailThreadId → {team, issue}`.
Extend the value to
`{team, issue, slackThreadId, sessionId, status, lastGmailMessageId}` — OR
promote it to a small central-DB table (`support_threads`) if we want the host
to read it for routing (host can't see the container's workspace file). Routing
follow-up emails into the existing session is host-side work, so **a DB table is
likely required** (open decision §5).

`lastGmailMessageId` is the RFC-822 `Message-ID` header of the most recent
message in the thread — required to set `In-Reply-To` / `References` on an
outbound reply so it threads correctly in the customer's inbox (§3.3).

### 3.3 Outbound email reply (drafted in Slack, sent via Gmail)

Inside a per-issue session, an engineer can ask the agent to reply to the
customer. The flow:

1. Agent drafts the reply **in the Slack thread** (subject to the container
   prose pipeline — humanizer — like any deliverable).
2. Engineer reviews/edits in Slack and approves.
3. On approval, the agent sends via Gmail on the **same thread**:
   `gws gmail users messages send` with `threadId = <gmailThreadId>` and headers
   `In-Reply-To: <lastGmailMessageId>` + `References: <...>`, `From:
   person24@fixture5.example.com`. Then it appends its own sent message back into the Slack
   thread for the record and refreshes `lastGmailMessageId`.

This needs: (a) the Gmail thread identity + last Message-ID retained in the
mapping store (§3.2); (b) `gws` send capability in the per-issue session's
container (same `support-example-labs.json` creds the poller already uses); (c) an
**approval gate** so the agent never sends customer-facing email without a human
OK (open decision §5). Reuse the existing approval primitive
(`src/modules/approvals/`) or a lightweight "reply with 👍 to send" convention in
the thread.

---

## 4. What's reusable vs. new

| Need | Reuse (exists) | New |
|------|----------------|-----|
| Read inbox + thread identity | pre-script + Gmail `threadId` in payload | — |
| Open Slack thread for an issue | `slackPostParent` / `slackCreateThread`, `dispatch.ts:311-345` | wire it for support |
| Per-issue session | `resolveSession(..., 'per-thread')` | choose thread-id scheme |
| Seed + wake session | `writeSessionMessage` + `wakeContainer` (`dispatch.ts:354-376`) | — |
| Per-fire summary threading | shipped in `2a7e80e9` | — |
| Gmail-thread → Slack-thread/session map | `support_ticketed_threads.json` (Linear only) | extend value / DB table |
| Route follow-up into existing session | — | host-side lookup + wake |
| Draft email reply in Slack | container prose pipeline / humanizer | — |
| Send reply on the Gmail thread | `gws gmail messages send` + `support-example-labs.json` creds | threading headers + send in per-issue session |
| Approval before sending email | `src/modules/approvals/` primitive | wire for outbound email |
| Lifecycle (close/reopen on resolve/reply) | — | new policy |

---

## 5. Open decisions (need Operator)

1. **Does every new ticket get a Slack working thread, or only "needs-human"
   ones?** A thread per ticket could be noisy if most are auto-resolved. Option:
   only open a working thread when triage decides an engineer is needed;
   auto-handled tickets just get the existing summary line.
2. **Whose session works the issue?** The same `example-labs` agent group (helper
   working each issue in its own thread), or a dedicated `example-labs-support`
   sibling/worker group? (Prior note: "one general-purpose worker group, each
   item its own session/thread.")
3. **Dispatch mechanism:** Option A (agent-driven, reuse orchestrator-dispatch)
   vs Option B (mechanical host-side, new thin path). Drives lifecycle behavior.
4. **Mapping store:** extend `support_ticketed_threads.json` (container-only) vs
   a central-DB `support_threads` table (host-readable, needed if host routes
   follow-ups). Leaning DB.
5. **Lifecycle:** when does a per-issue session/thread close — on Linear ticket
   resolved? N-days idle? And reopen on a follow-up email to a closed thread?
6. **Summary vs. threads:** keep posting the channel-level digest *and* open
   per-issue threads, or replace the digest with the threads themselves (parent
   message = the ticket announcement, its thread = the working space)?
7. **Outbound-email approval gate:** how heavy? Options: full approval primitive
   (DM an approver, block until OK) vs a lightweight in-thread "reply 👍 to send"
   convention. And who can approve — any engineer in the thread, or admins only?

---

## 5a. Decisions locked + v1 BUILT (2026-06-05)

Operator's calls on §5:
1. **Every real support ticket** gets a channel announcement + working thread
   (the pre-script already filters noise, so each remaining ticket is genuine).
2. **helper (same Example Labs group)** works each issue as a per-thread session —
   reuses helper's Linear/gws creds, CLAUDE.md, identity. No new bot/secrets.
3. **Agent-driven dispatch via a new MCP tool** (`dispatch_support_issue`) with a
   **thin host handler** — reuses the `postParent→createThread→resolveSession→seed
   →wake` primitives but NOT the orchestrator-dispatch tasks/watchdog (support
   threads idle for days; the watchdog would reap them). One idempotent tool
   handles new tickets AND follow-ups, keyed on Gmail `threadId`.
4. **Mapping store = central-DB `support_threads` table** (host-readable for
   follow-up routing) — host-owned, agent-agnostic. **State must not live in any
   agent's private bedroom** (Operator's principle, 2026-06-09).

   **PUREST VERSION BUILT (2026-06-09, same day, per Operator):** zero agent-side
   state of any kind — no bedroom file, no workgroup file. The poller is a thin
   triager (noise pre-flight → `dispatch_support_issue` → Gmail label); it does
   NO Linear work and tracks nothing. The host decides new-vs-existing from
   `support_threads`; the PER-ISSUE session creates the Linear ticket (or
   comments on follow-ups, per its seed prompt) and reports it back via the new
   `update_support_ticket` tool (resolved by calling-session id — no
   agent-supplied keys), which also auto-edits the channel announcement to show
   the ticket id (migration 042 added subject/sender columns to recompose it).
   Also fixed in this pass: the reopen path now UPSERTs (the original
   INSERT OR IGNORE silently dropped the new session on reopen, stranding all
   future follow-ups), and legacy ticket-map entries are seeded host-side into
   `support_threads` so in-flight email threads get comments, not duplicate
   tickets. Host suite 1645 pass / 0 fail; container support tests 4/4.
5. **Channel surface = per-ticket announcement + thread** (replaces the bundled
   digest; only failures/`filtered N` lines remain at channel root).
6. **Outbound email send deferred to v2** — v1 is read → ticket → work-in-Slack;
   helper may draft in-thread but not send. `last_gmail_message_id` retained for v2.
7. **Lifecycle:** sessions are normal per-thread sessions woken by engineer
   replies / follow-up emails; `status='open'`, reopened on any follow-up; a
   `closeSupportThread` helper exists for when an issue resolves (not yet wired to
   Linear-resolved — a v1.1 follow-up). Archived sessions auto-reopen on the next
   follow-up email.

**BUILT this branch (code is LIVE-but-dormant until helper's poller prompt adopts
the tool — see `poller-prompt-v1.md`):**
- `src/db/migrations/041-support-threads.ts` + `src/db/support-threads.ts` — table
  + CRUD (get/insert(OR IGNORE)/touch/close).
- `src/modules/support-threads/dispatch.ts` + `index.ts` — `dispatch_support_issue`
  delivery-action handler (idempotent new/follow-up), registered via the modules
  barrel.
- `container/agent-runner/src/mcp-tools/support.ts` (+ barrel import) — the tool.
- Tests: `dispatch.test.ts` (new opens one thread+session+mapping+seed; follow-up
  routes in, no duplicate), `db`-level via those, `support.test.ts` (tool
  contract). Full host suite 1641 pass / 0 fail; container support test 2/2; host
  + container typechecks clean.
- `poller-prompt-v1.md` — the operational prompt that activates it.

**v2 / follow-ups (not built):** outbound email send (draft-in-Slack → approve →
`gws gmail send` with In-Reply-To/References from `last_gmail_message_id`);
close-on-Linear-resolved wiring; optional dashboard surfacing of support threads
(the board reads channel-root tasks, so per-issue sessions won't show there yet).

---

## 6. Rough phased plan (post-decisions)

1. **Mapping store** — `support_threads` table (or extended JSON): `gmail_thread_id
   PK, linear_issue, slack_parent_msg_id, slack_thread_id, session_id, status,
   created_at, last_activity_at`. Migration + small DB module.
2. **Shared dispatch helper** — factor `postParent → createThread →
   resolveSession('per-thread') → writeSessionMessage → wakeContainer` out of
   `dispatch.ts` into a reusable function both spawn and support call.
3. **Triage → dispatch** — on a new ticketed thread, call the helper, persist the
   mapping. Seed the session with ticket + stripped email body.
4. **Follow-up routing** — host (or triager) looks up the mapping for an existing
   Gmail thread and wakes the stored session with the new reply.
5. **Lifecycle** — close/reopen policy + reconcile orphaned mappings.
6. **Tests** — new-thread opens exactly one Slack thread + session; follow-up
   routes into the existing one (no duplicate thread/session); closed-thread
   reopen; idempotency on re-poll (Gmail label `bot-ticketed` already guards
   re-poll, but the dispatch must be idempotent on `gmail_thread_id`).

---

## 6a. Related (folded in): thread-scoped "loops" vs channel-root scheduled tasks

Surfaced 2026-06-02 from a real incident: Operator told helper (in a Slack thread)
"run a loop to check the PR for new codex reviews"; the loop's `*/10` iterations
posted to the parent #agents-example channel, not the thread.

**Root cause (verified, not theorized):**
- Container agents have **no Claude Code `/loop`**. helper's recurrence surface is
  only `schedule_task` / `list|read|cancel|pause|resume|update_task`
  (`container/agent-runner/src/mcp-tools/scheduling.ts`). The host-side `/loop`
  skill (thread-local, "session = thread") exists only in a *host* Claude Code
  session, not inside the container.
- So "run a loop" was implemented as a recurring `schedule_task`. The actual row:
  `task-1780413607328-7wfpjh`, `*/10 * * * *`, `thread_id=null`, in the
  **channel-root** session `sess-1700000000000-example05` (same session as the email
  poller). Channel-root + `thread_id=null` is enforced for *every* scheduled task
  by `src/modules/scheduling/actions.ts:10-29` for lifetime (a task in a thread
  session dies when the thread is archived) AND security (post-2026-05-02
  cross-tenant leak: host never trusts agent-supplied routing). Working as
  designed → it posts at channel root.

**Decision (Operator, 2026-06-02):** do NOT make scheduled tasks report into threads —
they stay channel-root; follow-ups on a scheduled-task output happen in a fresh
thread like any other session. The loop/scheduled-task conflation is the bug, not
the channel-root routing.

**Implication / what would actually close the gap:** a **thread-scoped recurring
primitive** distinct from the durable channel-root `schedule_task` — one that runs
*in the per-thread session* and reports in-thread.

**Feasibility (verified 2026-06-02): HIGH, and close.** The firing machinery
already supports it — `src/host-sweep.ts:220-346` iterates **all** active sessions
(`getActiveSessions`) and runs the due-message wake + `handleRecurrence(inDb,
session)` for *each*, per-thread sessions included. A recurring row placed in a
per-thread session's inbound.db would therefore fire there, and that session's
outbound already carries `session.thread_id` (per-thread reply routing,
`mcp-tools/core.ts` resolveRouting), so iterations post in-thread **with no
delivery changes**. The *only* blocker is the deliberate redirect in
`scheduling/actions.ts:10-29` that forces every task to the channel-root session
with `thread_id=null`.

**Cleanest design — opt-in `scope` on `schedule_task`:**
- `scope: 'channel'` (default, today's behavior) — durable, channel-root,
  `thread_id=null`. Unchanged. For the email poller and any durable task.
- `scope: 'thread'` (new) — when the calling session is a per-thread session,
  `handleScheduleTask` writes the task into **that** session's inbound.db using
  the calling session's **host-authoritative** `thread_id` (from the sessions
  table — NOT the agent-supplied `threadId`, so the post-2026-05-02 cross-tenant
  invariant still holds). Fires in that session; reports in-thread; **dies with
  the thread session** (correct for an ephemeral, self-cancelling loop).

**Scope of work (moderate, self-contained):**
1. `scope` param on the `schedule_task` MCP tool + threaded through the system
   action (`mcp-tools/scheduling.ts`).
2. Branch in `handleScheduleTask` (`scheduling/actions.ts`): for `scope:'thread'`
   + a per-thread calling session, target that session's inbound with its real
   `thread_id`; else current channel-root path.
3. Task-management tools (`list/read/cancel/pause/resume/update_task`) currently
   assume the channel-root inbound (`openChannelInboundDb`) — extend to also see
   thread-scoped tasks in the current thread session.
4. **Lifecycle guard:** ensure a per-thread session holding a pending recurring
   row is NOT reaped between fires (the due-wake should keep it warm — verify
   against the stale-session sweep and the 2026-05-27 recurring-expiry fix).
5. Tests: thread-scoped loop fires in-thread; survives across fires; self-cancels;
   channel-scoped path unchanged; cross-tenant routing still rejected.

No new session machinery, no delivery rework — distinct from §3's per-issue
dispatch but reuses the same "per-thread session woken on a schedule, reports
in-thread" foundation. Could ship independently and *before* §3 (smaller).

**Status: BUILT (2026-06-03), on this branch, pending deploy.** Shipped the
opt-in `scope` exactly as designed above:
- `container/agent-runner/src/mcp-tools/scheduling.ts` — `scope` param on
  `schedule_task`; `list_tasks`/`read_task` now merge own-inbound (thread loops)
  + channel mount and mark thread-scoped rows `[thread]`.
- `src/modules/scheduling/actions.ts` — `handleScheduleTask` routes
  `scope:'thread'` into the calling per-thread session's inbound using the
  host-authoritative `session.thread_id` (reuses delivery's open handle; falls
  back to channel-root from a non-thread caller). Management ops resolve the
  calling thread session first, then channel root.
- `src/modules/scheduling/db.ts` — cancel/pause/resume return affected-row
  counts (drive the resolution order).
- `scheduling.instructions.md` — agent guidance for thread-loops.
- Tests: `src/modules/scheduling/{db,actions}.test.ts` (+10 cases). Full host
  suite 1639 pass / 0 fail; container mcp-tools pass in isolation (the 6
  parallel-race flakies are pre-existing, unrelated). Host + container
  typechecks clean.

Deploy: host `pnpm run build` + `sudo systemctl restart nanoclaw-v2` (restart
respawns containers, which pick up the bind-mounted agent-runner source — no
image rebuild needed).

## 6b. Related (BUILT): proactive output should stay in the originating conversation

Surfaced 2026-06-03: a `/team-auto` run launched in a Slack thread sent all 7 of
its stage-progress + completion reports to the owner's **DM**, while normal
working chatter correctly stayed in the thread.

**Root cause (verified against `sess-1700000000000-example06` outbound):** NOT a
routing bug. The agent's turn-final replies and `send_message` with no `to`
already default to the session's own conversation (`resolveRouting`,
`mcp-tools/core.ts:78-88` → `getSessionRouting()` returns the thread). The agent
**explicitly** addressed the owner-DM destination by name for each progress
report. The in-prompt guidance (`destinations.ts`) only told it to "address the
destination it came `from`" *when replying to an incoming message* — it said
nothing about mid-run proactive output — and the `send_message` description
("if you have only one destination, you can omit `to`") implied that with
multiple destinations you must name one, nudging it toward the salient "Operator" DM.

**Fix (BUILT 2026-06-04, this branch) — guidance + tool descriptions, no routing
logic change:**
- `destinations.ts` — added an explicit rule: keep the whole conversation
  (progress, interim status, final result, across long `/team-auto`/loop runs) in
  the destination it came `from`; never redirect status/completion to a DM unless
  explicitly asked. Clarified that omitting `send_message`'s `to` posts in the
  current conversation regardless of destination count.
- `core.ts` — rewrote `send_message`/`send_file` descriptions to make "omit `to`
  = reply here" the clear default and warn against redirecting routine output.
- `core.test.ts` — +2 regression cases: omit-`to` posts in the session thread
  (not the owner DM); explicit `to` still redirects.

## 7. Risks / watch-items

- **Idempotency:** the poll can re-see a thread before labeling completes; key
  dispatch on `gmail_thread_id` so a retried fire never opens a second Slack
  thread/session. (Mirrors the existing `bot-ticketed` label guard.)
- **Don't thread-bind the poller task.** The recurring detector stays a
  channel-root task (§2.4). Only the *worked issues* are per-thread sessions.
- **Container can't create sessions directly** — sessions are host-managed
  (container → `messages_out` → host acts). Option B needs a host handler
  (`registerDeliveryAction`-style) or the pre-script protocol extension; the
  pre-script runs container-side, so the *creation* must be brokered by the host.
- **Watchdog mismatch (if Option A):** orchestrator-dispatch's watchdog reaps
  idle/stalled tasks; a support thread waiting days for an engineer reply looks
  stalled. Would need an exemption or Option B.
- **OneCLI/creds stay container-side** — Gmail access is via `gws` in the
  container; don't move inbox reads host-side.
- **Never auto-send customer email.** Outbound replies (§3.3) must clear a human
  approval gate every time — a wrong customer-facing email is far costlier than a
  wrong internal Slack post.
- **Email threading correctness:** a reply must set `threadId` +
  `In-Reply-To`/`References` from the retained `lastGmailMessageId`, or it lands
  as a new thread in the customer's inbox and breaks the 1:1 mapping. Refresh
  `lastGmailMessageId` after every inbound *and* outbound message on the thread.
```
