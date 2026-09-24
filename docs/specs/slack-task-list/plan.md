# Plan: Slack live task list (Claude Tag–style progress)

Status: approved 2026-09-24 by the operator, built in PR 1

## Target UX (from Boris's Claude Tag video, 2026-09-24)

1. **Receipt**: 👀 on the user's message + Slack's native status line ("<bot> is thinking…").
2. **Complexity-gated**: simple asks get a direct answer, no list. Multi-step work gets ONE task-list message:
   headline (gerund: "Verifying the SDK…"), items `✓` done / `✱` in progress / `○` pending,
   footer `todos as of 3:00 PM (25 minutes ago)` — relative time rendered by Slack, not by edits.
3. **Edited in place** as work moves. Completed items are rewritten as outcomes
   ("Writing six Lean models" → "✓ Six Lean models written, no sorry").
4. **Follow-ups mid-run join the live list** (ack reaction on the follow-up, new `○` item).
5. **Results post as separate messages** below; the list references them ("Findings posted below").
6. **One live list per thread**: a new list, or a repost in a busy thread (≥15 min since last post),
   edits the old list down to "Latest task list →" (permalink).
7. **Edits are silent** in Slack (no notification) → anything the user must see (blocker, approval needed,
   done) posts as a new message; `@user` only when they must act.
8. **No 💭 thinking messages.** The list + status line replace them.

## Decision: our own provider-neutral MCP tool, not the SDK's native todo tools

`update_task_list` MCP tool in the agent-runner, rendered by the host.

- **Why not SDK TaskCreate/TodoWrite** (`CLAUDE_CODE_ENABLE_TODO_TOOLS=1`): Claude-only (Codex and
  OpenCode have different native plan tools, and ours don't observe either), deliberately switched off by Anthropic for 5.x
  models (CLI changelog 2.1.233: "no longer available on Opus 4.8, Sonnet 5, Fable 5, Mythos 5, and newer"),
  and its schema has no list headline. Three native tools → three mappers; one MCP tool → one path.
- **Why not a parsed TASKS.md** (Anthropic's Opus 5.5 blog): a free-form file is a weaker contract than a typed
  tool call — the host would parse markdown the model may format any way, and learn about changes only by
  reading the file on some cadence. We keep the blog's actual point — the list must survive compaction — by
  holding it in session state and re-injecting it (below).
- **The deciding argument is one explicit cross-provider contract** (Codex review). The SDK's removal of its todo
  tools shows availability, not that a custom tool performs better — adoption is checked per provider below.
- **Pattern fit**: sits beside `send_message` / `edit_message` / `add_reaction` in
  `container/agent-runner/src/mcp-tools/core.ts`; delivery already does post-then-edit for status lines.
- **Revisit if**: the pilot shows Opus 5.5 under-uses our tool vs. native (lists missing on clearly multi-step
  turns) → for Claude groups only, enable the native tools and map their events onto the same row.
  Never run both at once.

## Build

### Runner (container/agent-runner, Bun)
- `update_task_list({ title, items: [{ text, status: 'pending'|'in_progress'|'done' }], new_list?: boolean })` —
  full-list replace (same semantics as native TodoWrite). Cap item count/length so the render fits 2,000 chars.
- **List identity is a generation, not the title** (headlines change as work moves). A new generation starts only
  when `new_list: true` or the previous list is terminal (all done / stopped); otherwise updates edit the same list.
- Writes one outbound row with the full list, generation, revision and ISO `updatedAt`
  (new `content.operation: 'task_list'`, like `edit`/`reaction` today — no schema migration).
- Persist the current list in `session_state` (outbound.db), written in the same transaction as the outbound row.
  Cleared on `/clear` and on fresh scheduled-task fires (`poll-loop.ts:811` fresh-context path).
- **Compaction**: reuse the existing shared `compacted` reminder path (`poll-loop.ts:3039`) to re-inject the current
  list (bounded size). Claude emits the event; **OpenCode does not forward `session.compacted`** today
  (`opencode.ts:1591`) and Codex must be checked — wire both. Also re-inject on respawn/provider change.
- **One list mechanism per provider**: disable OpenCode's native `todowrite` (allowed at `opencode.ts:246`); keep
  Claude's native todo tools off (default on 5.x); check Codex's native plan tool and suppress it if exposed.
- **Retire 💭 labels**: remove thinking-label emission in `providers/claude.ts`, `codex.ts`,
  `codex-app-server.ts`, `formatter.ts`, and the `kind:'status'` write at `poll-loop.ts:3226`.

### Host (src/, Node)
- **Renderer** (pure function, golden-tested): headline, `✓/✱/○` lines, footer as Slack date token
  `<!date^{unix}^{time} ({ago})|{fallback local time}>`; cap 2,000 chars, truncating done items first.
  Non-Slack adapters: plain text + local time, and only where the adapter can edit (else post-only, no edits).
- **Durable upsert** — NOT the in-memory `statusTracking` map (`delivery.ts:293`), which a restart loses. Persist
  per list: platform message id, destination + adapter instance, **bot identity**, generation, last-applied revision.
  Key by resolved conversation (thread) + agent group, so a task session and a chat session targeting the same
  thread, or two bots in one thread, never edit each other's list. Serialize updates per list; coalesce to the
  latest revision; skip edits whose render is unchanged; a restart mid-debounce re-applies the latest persisted
  revision. A list row never counts as "answer delivered" and its failure never retries an answer.
- **Rate limits**: shared per-workspace throttle for list edits, honor `Retry-After` on edits (today only posting
  has the retry loop, `chat-sdk-bridge.ts:1604` vs the bare edit at `:1401`), answers always ahead of list refreshes,
  bounded trailing flush so the final state always lands.
- **Supersede / repost**: new generation, or busy thread with last post ≥15 min old → post fresh, edit the previous
  one to a message-specific permalink (`chat.getPermalink`; the existing helper links the thread parent,
  `slack-mentions.ts:112`) reading "Latest task list →".
- **Routing parity**: lists follow the same rules as today's progress: `quietStatus`, spawn-child suppression,
  scheduled/sibling/redirected traffic stays internal where it does today (`delivery.ts:1544`), destination
  permissions and secret scrubbing apply. In a2a rooms a list post/edit must never wake a sibling bot.
- **Terminal states carry the exit reason** (today's cleanup drops it, `container-runner.ts:2244`): normal idle exit
  after completed work → list unchanged; kill / crash / ceiling-kill with unfinished items → footer "stopped at
  <time>", `✱` → `◌ interrupted`; ceiling recovery pending → say so. A queued edit from an old generation never
  revives a stopped list. The list is not deleted when the reply lands. Ceiling-recovery and approval messages
  are unchanged.
- **Status line**: our adapter interface has no status text (`adapter.ts:326` `setTyping(platformId, threadId)`;
  bridge `:1668` calls `startTyping(tid)`), though `@chat-adapter/slack`'s `startTyping(threadId, status)` takes one.
  Extend the interface; pass the current `in_progress` item, fallback "Thinking…". Slack clears status on reply and
  expires it after 2 min — the 4s typing refresh already covers expiry; verify in channels, DMs and MPIMs.
- **Receipt 👀**: one owner — the host, on the router's successful admission of the message (not on container wake).

### Instructions (always-on, provider-neutral, keep short — classify per docs/always-on-directive-classification.md)
- Use a task list when the work has several steps or will take more than a couple of minutes; skip it for
  a direct answer.
- Items start as actions; on completion rewrite each as its outcome.
- A follow-up that arrives mid-run: react to ack it, add it as an item.
- Post results as their own messages; the list is progress, not the deliverable.
- Edits are silent: blockers, approvals and completion get a new message; `@` the user only when they must act.

## Rollout

Owner decision (2026-09-24): **no pilot group — on across the board, turn it off if it doesn't work.**

1. **PR 1** — everything above, **on for every group**, with two switches:
   - **Host delivery gate** (host config, read at host start): off = host drops `task_list` rows and edits
     existing lists' footers to "task list paused". Takes effect at host restart even for adopted containers.
   - **Spawn-time switch** passed to the container: off = tool not registered, instructions not composed,
     💭 labels emitted as today. Takes effect at each container's next spawn.
2. **Fleet-on verification** (before merge, on a real Slack test thread per provider — Claude, Codex, OpenCode):
   simple ask → no list; multi-step → list edits in place; mid-run follow-up → ack + new item; compaction →
   list survives; host restart mid-run → edits resume on the same message; kill → "stopped"; normal idle exit →
   untouched; two bots in one thread → separate lists; host gate off → paused. Evidence: screenshots + delivery rows.
3. **Watch ≈1 week**: no rate-limit errors in `logs/nanoclaw.error.log`, no stuck `✱`, lists on multi-step
   turns only.
4. **PR 2** — delete the 💭 path and the spawn-time switch; **keep the host delivery gate** as the permanent
   off switch (off then = status line only).

## Verification (per PR)
- Unit: renderer goldens (Slack + plain), truncation, generation rules, supersede/permalink, terminal states by
  exit reason, durable upsert across simulated restart, throttle/Retry-After, routing parity (quiet, sibling,
  a2a); runner tool validation, session_state atomicity, compaction re-inject per provider.
- Throttled test runs for touched files only (CLAUDE.md "CI is not your test run"); container typecheck; lint.

## Review
- Codex (gpt-6-astra, high), 2026-09-24: APPROVE WITH CHANGES — all nine findings accepted and folded in above
  (durable upsert, exit-reason terminal states, host-side gate, routing parity, compaction contract, rate limits,
  generation-not-title identity, status-text interface, competing native tools). Full review:
  kept with the PR description.

## Independent of this plan
- Claude Agent SDK 0.3.281 + CLI 2.1.281 bump: separate PR (in progress). Not required for this feature.

## Open risks
- Model adoption of a non-native tool (measured in pilot; fallback above).
- Always-on context cost: tool schema + ~5 lines of instructions on every turn.
- Model adoption per provider: Codex/OpenCode models may use the tool differently from Opus 5.5 — covered by the per-provider verification above.
- Multi-bot rooms: each bot keeps its own list in the thread — acceptable, confirm it reads cleanly.

## As built (PR 1) — where the code differs from the text above

Grounded implementation choices inside the approved scope; each is simpler than the plan text or forced by
something the plan did not know.

- **The runner renders, the host never does.** `container/agent-runner/src/task-list.ts` owns post vs edit vs
  repost, generations, rendering, and the durable record (`session_state.task_list`, written in the same process
  as the outbound row). It also pre-renders the "interrupted" form on every update, so the host's kill path
  edits the post without a renderer of its own. The durable upsert Codex asked for is that record plus the
  host's own `delivered` table (the runner waits for the post's platform id) — no new host table.
- **Rows are `kind: 'task_list'`** through the ordinary channel path (routing, permission, anchors, scrub). They
  never count as the reply, never pause typing, never reach the archive, never post more than one chunk, and
  carry the footer as `subtext` (Slack context block, so the `<!date^…^{ago}>` token renders).
- **Host pieces live in `src/task-list-host.ts`**; delivery, typing, router and container-runner carry one-line
  hooks (upstream-ratchet growth +105 lines).
- **Switch**: one env var, `NANOCLAW_TASK_LIST` (default on, `0` off). Host start: delivery gate — `task_list` rows
  recorded delivered without posting, 💭 status rows posted again. Spawn: `NANOCLAW_TASK_LIST=1` registers the tool.
  No "task list paused" edit on existing lists: they stop updating. An adopted container reads a row recorded
  without a platform id as a failed post, so after the switch comes back on its next update posts afresh.
- **Compaction: next prompt only, never mid-turn.** Upstream reverted a mid-turn post-compaction reminder
  (`a760da7fe`: it made the agent send an unintended message), and no provider emits `compacted` today. The list
  comes back as a prompt prefix after a context reset that keeps the work going (rotation); `/clear`
  marks it stale instead. A compaction inside one long turn relies on the model's own summary. Known limit.
- **One list mechanism per provider**: OpenCode's `todowrite` is denied while the switch is on. Codex's native
  `update_plan` has no config switch in 0.156 (checked the binary's feature keys), so a Codex agent has both;
  its adoption of `update_task_list` is part of the live check.
- **Scheduled-task sessions** refuse the tool (they report through `send_message`); the list lives in
  conversations only.
- **Repost rule**: the list's post is ≥15 min old and ≥2 conversation messages sit below it.
- **Kill reasons**: the idle reapers (`chat-idle-reap`, `scheduled-task-idle`) end containers after their work
  and leave the list as is; every other kill with an unfinished list marks it interrupted.
- **Kill-time edit (implementation review, Codex gpt-6-astra high, three rounds)**: runs only while holding the
  session's delivery slot (after any drain in flight; if a drain will not finish in 30 s it does nothing rather than
  race it). It records the dead container's queued list rows delivered-unsent in inbound.db — durable across a host
  restart; a first post that never went out is dropped the same way — and edits where the HOST delivered the list
  (the post's own row and `delivered` receipt), only in the session's own conversation. The container's record
  supplies only the wording, scrubbed like any payload. A list touched after the kill began belongs to a newer
  container and is left alone — the fence reads `touchedAt`, stamped on every save, because an unchanged or
  still-pending update keeps `updatedAt` (the time on screen). A rate-limited interrupted edit is not lost: it waits
  out the platform cooldown outside the slot and re-decides from scratch, up to 4 attempts and 5 minutes per wait.
  Residual: a row the dying container writes during its SIGTERM grace can still land.
- **Delivery**: queued edits of one list coalesce to the newest (the rest recorded delivered-unsent). A rate-limited
  list row never waits inline and never blocks: its platform cools down for Slack's Retry-After — every task-list
  write on that platform waits, including a newer revision of the same list and other sessions' lists — uncharged,
  while answers go out, then sends. The cooldown is in host memory; a host restart forgets it. Any other list-row failure also steps aside instead of holding the queue.
  Spawn-child sessions' lists stay internal, as their 💭 did. The status line takes its item from the
  secret-scrubbed row.
- **Runner concurrency**: `update_task_list` calls are serialized in the MCP process. Not done: one mailbox
  transaction around state + outbound write. The window is a process kill between two consecutive SQLite writes in
  one tool call; its worst case is one list left showing an older state (or marked interrupted from it) until the
  next update.
- **Switch flip with an identical retry**: an edit written while the host gate was off is recorded delivered-unsent;
  after it comes back on, only a CHANGED update repaints (an identical retry reads as unchanged). Accepted: the flip
  is operator-driven and rare, and the next real update repaints.
- **Receipt and status line**: 👀 on a live human Slack message when it wakes an agent; the status line reads
  "is thinking…", or "is working: <current item>" once the list has one.
- **Agent-shared sessions** have no conversation of their own, so the tool refuses there and they keep their 💭
  progress.
- **Replacing a list**: a repost's old copy (or the previous generation) is collapsed into a pointer only once the
  new post has a platform id. Until then it stays the visible list, and a kill marks IT interrupted.
- **Crashes**: a container exit the host did not ask for (OOM, runner crash) settles its list like a kill; the
  host tracks its own stops by container name, so idle reaps keep their exclusion. An adopted container's crash is
  not covered (no close handler on this host).
- **Rate-limited first post**: if an answer overtakes it, the post is retired rather than shown below the answer;
  the next update posts afresh.
- **Channel-level sessions** (Discord channels, shared-mode Slack): the list is never the turn's thread anchor (the
  answer stays the root) and goes in the thread of the message being answered.
- **Known limits (closing review P3s)**: an idle reap leaves an unfinished list as is; the recovery path does not
  re-inject the list; containers adopted at deploy run the old runner (no list, 💭 hidden) until they respawn;
  Discord's 1 h edit cap is not handled for lists; `new_list` over an undelivered post can leave two lists.
- **Sibling rooms**: Slack inbound drops a bot post carrying the list footer, so a list never wakes another bot.
