# v1 → v2 Action Items

Working doc for each finding from [SUMMARY.md](SUMMARY.md). Decisions were made one-by-one; this rollup summarizes the outcome.

**Status legend**: `pending` · `discussing` · `decided` · `deferred` · `dropped` · `done`

---

## Rollup

### To implement (~800 LOC total, roughly)

| # | Topic | LOC | Notes |
|---|---|---|---|
| 1 | Engage modes + sender scope + accumulate/drop + fan-out + tool blocklist | ~315 | DB migration drops `trigger_rules`/`response_scope`, adds `engage_mode`/`engage_pattern`/`sender_scope`/`ignored_message_policy` + `trigger` column on `messages_in`; router `pickAgents` fan-out; adapter-level gating via new hooks |
| 5 | `request_approval` flow for unknown senders (default policy flips from `strict` to `request_approval`) | ~175 | New `pending_sender_approvals` table; reuses existing `pickApprover` + card infra |
| 9 | Stuck detection (60s claim-age rule), heartbeat-based lifecycle, `max(30m, bash_timeout)` absolute ceiling, SDK tool blocklist (`AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `EnterWorktree`, `ExitWorktree`), remove `IDLE_TIMEOUT` setTimeout + `IDLE_END_MS` machinery | ~115 | Container state row for Bash timeout tracking |
| 15 | Delete three dead config constants from `src/config.ts` | 3 | `POLL_INTERVAL`, `SCHEDULER_POLL_INTERVAL`, `IPC_POLL_INTERVAL` |
| 18 | Timezone + formatting recreation — port v1 bit-for-bit (`formatLocalTime`, `<context timezone="..."/>` header, `reply_to` + `<quoted_message>` XML, `stripInternalTags`) + scheduling tool TZ normalization + cron TZ parsing | ~195 (75 prod + 120 tests) | Full spec in [timezone-formatting-v1-recreation.md](timezone-formatting-v1-recreation.md) |

### Deferred (wait for trigger)

| # | Topic | Trigger |
|---|---|---|
| 2 | `nonMainReadOnly` mount isolation | If multi-tenant / untrusted-group use ever surfaces. In the meantime, mount-declaration skill must explicitly prompt RO/RW when added |
| 3a | End-to-end recovery test | When next touching `host-sweep.ts` / `index.ts` startup |
| 14 | Remote control subsystem | When someone needs it. Opt-in skill, provider-specific (Claude SDK only) |
| 17 | Dynamic group-add (bridge conversations cache refresh) | When implementing dynamic group registration feature. Code comment added at `chat-sdk-bridge.ts:73` |

### Dropped (won't implement / not-a-regression)

| # | Topic | Why |
|---|---|---|
| 3 | Explicit pending-message recovery | Working as designed via sweep's immediate first tick + `cleanupOrphans` |
| 4 | `response_scope` enforcement | Folded into item 1 migration (column deleted, values backfilled) |
| 6 | Per-group container timeout | Not a regression — v1's hard-kill was worse than v2's keep-alive-after-idle |
| 7 | Container streaming output markers | Replaced by `send_message` MCP tool; latency ~1s is fine for chat UX |
| 8 | Per-exit container log files | Underlying info still recoverable (session DBs, heartbeat mtime, exit code) |
| 10 | Host-level retry on agent error | Folded into item 9's kill + sweep-reset loop |
| 11 | Process ID in logger output | Single host process; container stderr already tagged with `agentGroup.folder` |
| 12 | Task dedup via unique series_id index | Recurrence logic is structurally dedup-safe; not a real issue |
| 13 | Silent-drop sender mode | Admin can use `unknown_sender_policy='strict'` or remove from members instead |
| 16 | Configurable retention thresholds | Personal-assistant scale; source constants are fine |

### Extras recorded during discussion
- **1a**: Implementation-ordering plan for item 1
- **6a**: Remove `IDLE_END_MS` from `poll-loop.ts` (folded into item 9)
- **3a**: E2E recovery test (deferred)

### Follow-up PRs (scoped, not in this branch)
| # | Topic | Why later |
|---|---|---|
| 22 | Unknown-channel wiring approval flow (card to owner when bot receives inbound in an unwired messaging group) | Gap surfaced after item 5 landed — item 5's `request_approval` covers unknown senders but presupposes a wired channel. See item 22 for the full design. |

---

## HIGH

### 1. Trigger-rule matching in `pickAgent`
**Finding**: `src/router.ts:246` TODO. Confirmed trigger filtering is non-functional end-to-end: `trigger_rules` JSON is parsed into `ConversationConfig` and passed to adapters, but the Chat SDK bridge never reads it, and router's `pickAgent` picks by priority only. `response_scope` on `messaging_group_agents` is stored but never enforced. Chat SDK bridge hard-subscribes on every mention (bridge:173) and every DM (bridge:189).

**Status**: decided — design locked; implementation pending

**Decision**: replace `trigger_rules` JSON + `response_scope` with four explicit orthogonal columns on `messaging_group_agents`. Fan out inbound messages to all matching agents (N containers for N agents). Adapter-level gating in the bridge. `sender_scope` enforcement moves to the permissions module.

**Schema** (`messaging_group_agents`):
```
engage_mode            TEXT NOT NULL DEFAULT 'mention'
                       -- 'pattern' | 'mention' | 'mention-sticky'
engage_pattern         TEXT            -- required when mode='pattern'; '.' = always
sender_scope           TEXT NOT NULL DEFAULT 'all'     -- 'all' | 'known'
ignored_message_policy TEXT NOT NULL DEFAULT 'drop'    -- 'drop' | 'accumulate'
```
Drop `trigger_rules` + `response_scope`. **No per-wiring accumulate cap** — storage is unbounded.

**Global wake cap** (not a column): reuse `MAX_MESSAGES_PER_PROMPT` in `src/config.ts` (already defined, default 10, currently dead code from v1). Pass to container via `NANOCLAW_MAX_MESSAGES_PER_PROMPT`. Container applies `ORDER BY seq DESC LIMIT $N` when pulling pending messages on wake.

**Session DB** (`messages_in`):
```
trigger INTEGER NOT NULL DEFAULT 1   -- 0 = context-only, 1 = wake agent
```
Host's `countDueMessages` / wake logic gates on `trigger=1`. Container reads all messages for context regardless.

**Decisions locked**:
- `always` collapses into `pattern` with `engage_pattern='.'` (three modes total)
- `mention` and `mention-sticky` are separate modes (stickiness is user-visible)
- `pattern` is a JS regex string — applied as `new RegExp(pattern).test(text)`
- Accumulate cap = last N messages, default 10
- Fan-out: each matching agent gets its own session + container
- Per-channel defaults live in the setup/register flow, not in the schema:
  - DM → `pattern` with `.`
  - Threaded group → `mention-sticky`
  - Non-threaded group → `mention`

**Routing flow** (future):
1. Inbound → resolve messaging_group → group-level `unknown_sender_policy` gate
2. `pickAgents()` returns all wired agents (not just priority 0)
3. For each agent:
   a. `sender_scope` check (permissions module)
   b. `engage_mode` check (regex / mention / mention-sticky)
   c. Matched → write with `trigger=1`, wake container
   d. Not matched + `accumulate` → write with `trigger=0`, don't wake (no cap — stored forever)
   e. Not matched + `drop` → skip

On wake, container pulls pending messages with `ORDER BY seq DESC LIMIT MAX_MESSAGES_PER_PROMPT` so only the most recent N reach the prompt regardless of accumulation depth.

**Adapter bridge**:
- Read `conversations.get(channelId)` before `setupConfig.onInbound(...)`
- For `pattern` mode: test regex
- For `mention` / `mention-sticky`: require bot to be mentioned
- Only `thread.subscribe()` when mode is `mention-sticky` (today it subscribes unconditionally)

**LOC estimate**: ~315 (~255 prod + ~60 test)
- schema migration + backfill: 40
- session DB `trigger` column: 25
- types + adapter contract: 20
- DB helpers (CRUD): 20
- host→adapter plumbing (including `NANOCLAW_MAX_MESSAGES_PER_PROMPT` env): 10
- router fan-out + gating: 70
- sender-scope in permissions module: 15
- Chat SDK bridge gating + subscribe control: 40
- container-side `LIMIT N` on pending-message pull: 5
- smart defaults in setup/register flow: 15
- tests: 60

(Note: earlier plan's "accumulate prune-to-N in router" is dropped — host doesn't prune. Cap is container-side only.)

**Core vs module split**:
- Core (`src/`): schema, engage_mode enforcement, pickAgents fan-out, bridge gating, `trigger` column, accumulate/drop
- Permissions module: `sender_scope` enforcement (extends existing access gate). Default `sender_scope='all'` → no-op when permissions module absent

**Next step**: new action item for implementation — see item 1a.

---

### 1a. Implementation plan for engage/sender/ignored columns
**Status**: pending — ready to implement
**Order**: (a) migration + backfill, (b) types + DB helpers, (c) router fan-out + gating, (d) bridge gating, (e) permissions sender_scope, (f) setup-flow defaults, (g) tests
**Next step**: draft the migration + write up the PR plan when ready

### 2. `nonMainReadOnly` mount isolation
**Finding**: `mount-security.ts` moved to `src/modules/mount-security/index.ts` during the refactor. `validateMount(mount)` no longer takes an `isMain` param; `MountAllowlist` has no `nonMainReadOnly` field. Regression is real. But v1's "main vs non-main" concept doesn't map cleanly to v2 — `agent_groups` has no `is_main` flag.

**Status**: deferred

**Decision**: do not restore the v1 flag. Trust admin-declared `readonly` values in `container.json`. The allowlist's per-root `allowReadWrite` + path gating is sufficient for the current threat model (personal-assistant use, single admin). If multi-tenant / untrusted auxiliary groups become a real use case, prefer framing B (add `agent_groups.mount_access: 'rw' | 'ro'` column) over resurrecting `isMain`.

**Rationale**: v2 deliberately dropped the "main" concept. Reintroducing `isMain` to restore a defense-in-depth check that was designed for a different entity model is the wrong trade. Admin already has to opt-in twice (allowlist `allowReadWrite: true` + container.json `readonly: false`) to get RW — that's two deliberate keys. The v1 flag was a triple-check for a rare class of admin mistakes in a shared-infra setup.

**Follow-up (required)**: when building the skill / guide / setup flow that lets admins declare additional mounts (e.g. self-customize, manage-mounts, or a new `/add-mount` skill), the flow **must clearly surface the RO vs RW distinction** to the admin — explicit choice, explicit warning when RW is selected, and default to RO. This replaces v1's automatic enforcement with informed consent.

**Next step**: when the mount-declaration skill/flow is next touched, add explicit RO/RW prompting. Track as a sub-item if a skill exists yet.

### 3. Explicit pending-message recovery on startup
**Finding**: v1 had a named `recoverPendingMessages()` function at startup. v2 relies on the host sweep. Verified: the recovery path exists and is correct — just renamed/relocated.

**Status**: decided — working as designed, no code change

**Current mechanism** (verified against tree):
1. `cleanupOrphans()` at startup kills any leftover container from the previous run (`src/index.ts:69`)
2. `startHostSweep()` runs its first sweep **immediately** — no 60s delay (`src/host-sweep.ts:38`)
3. Sweep per session: `syncProcessingAcks` → `countDueMessages` → `wakeContainer` if work pending and no container → `detectStaleContainers` resets stuck `processing` rows with backoff

**Scenarios covered**:
- Host crashed while container idle with pending messages → orphan cleanup + first sweep re-wakes
- Host crashed mid-processing → stale detection resets `processing → pending`, next sweep wakes
- Container crashed with host alive → heartbeat mtime catches it inside 10 min `STALE_THRESHOLD_MS`

**Rationale**: the function got renamed (recovery → sweep) but the behavior is equivalent or better. Sweep is continuous; recovery used to be one-shot.

**Next step**: see item 3a.

---

### 22. Unknown-channel wiring approval flow
**Finding** (post-item-5 discussion): item 5's `request_approval` only fires when a messaging group already has agents wired. Three scenarios slip through to the earlier `no_agent_wired` structural-drop branch in `src/router.ts` and get silent-dropped with no signal to the owner:

1. A new user DMs the agent directly (the DM's messaging group auto-creates but has no wiring)
2. The agent is @mentioned in a group the admin hasn't registered
3. The agent is added to a new group and someone there addresses it

In all three, the user sees no response and the owner has no signal anything happened.

**Status**: decided — companion PR to item 5, scoped separately

**Decision**: when the router hits `no_agent_wired` for a non-public event, **instead of silent-dropping, pick the owner and DM them a wiring card**. Two flavors depending on who triggered it:

- **Sender IS an owner/admin** (the common "I just added the bot" case) → auto-wire IF exactly one agent group exists. Silent seamless flow. If multiple agent groups exist, fall through to the card so the owner picks.
- **Sender is anyone else** (stranger, or owner in a multi-agent install) → deliver a card:
  - Title: `🔌 New channel — wire it?`
  - Body: `<senderName> is trying to reach you in <channelName> on <platform>. Wire to which agent?`
  - Options: one button per existing `agent_groups` row, plus `➕ Create new` and `Ignore`

**On approve (existing agent group)**:
1. `createMessagingGroupAgent(...)` with channel-kind defaults — DM→`pattern` + `'.'`, threaded group→`mention-sticky`, non-threaded group→`mention` (same defaults as `scripts/init-first-agent.ts`)
2. Replay the stored event via `routeInbound` (sender-approval pattern)
3. Delete pending row

**On approve "Create new"**: [OPEN SCOPE] — needs name/folder input. Options:
- Follow-up ask_question card asking for a name → auto-derive folder from slug → create group + wire
- Or: skill-backed flow — the button dispatches to `/init-agent` or similar and the card just links out
- Punt until implementation; mention in the PR brief that we'll decide when building

**On ignore**: delete pending row; future attempts re-prompt fresh (consistent with sender-approval deny; no denial persistence).

**Failure cases** (drop silently with log, don't leave a pending row):
- No owner configured (fresh install) — same behaviour as sender-approval
- No reachable DM for any owner/admin
- Delivery adapter missing

**New table**:
```
pending_channel_approvals (
  id                 TEXT PRIMARY KEY,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  sender_identity    TEXT,                 -- NULL when triggered by a non-identifiable event
  sender_name        TEXT,
  original_message   TEXT NOT NULL,        -- JSON InboundEvent for replay
  approver_user_id   TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  UNIQUE(messaging_group_id)               -- one pending wiring per channel
)
```

Dedup is narrower than sender-approval's `(mg_id, sender_id)` — one pending wiring per channel, period. A second stranger writing into the same unwired channel piggybacks on the existing card instead of spawning a new one. Latest event replaces the stored `original_message` (we only replay one anyway, and latest is most useful).

**Card action id prefix**: `nca-<approvalId>:<value>` where value is `agent-group-<id>` / `create` / `ignore`. Response handler lives in `src/modules/permissions/` alongside `handleSenderApprovalResponse`.

**Owner-sender auto-wire logic**:
```
if sender is owner/admin AND getAllAgentGroups().length === 1:
    auto-wire to that group, replay event, done — no card
else:
    deliver card
```

Don't auto-create a new agent group silently — always require a prompt for that.

**LOC estimate**: ~145
- Migration + CRUD: 45
- Router hook before `no_agent_wired` drop → try channel approval: 15
- Owner-sender auto-wire fast path: 20
- Card delivery (scope `pickApprover(null)`; build buttons from `getAllAgentGroups()`): 25
- Response handler: 25
- Tests: 15

**Open scopes (flag at PR time)**:
- "Create new" sub-flow — pick between follow-up card vs skill link
- Do we also react to bot-added-to-group platform events? Simpler to stay lazy (first-message-triggered only). Platform lifecycle events are inconsistent across Discord/Slack/Telegram anyway.
- Worth scanning the `channels` branch for any existing channel-lifecycle handlers that might conflict.

**Next step**: open a follow-up PR off this branch once #1869 lands.

---

### 3a. End-to-end recovery test
**Finding**: no test confirms the host-crash-restart scenario produces timely re-delivery.

**Status**: pending — nice-to-have

**Decision**: add an integration test: (1) write a pending message to inbound.db, (2) kill the host simulating crash, (3) start host, (4) assert container is woken and message processed within a bounded time (≤5s? ≤ one sweep interval).

**Rationale**: the sweep logic is correct as written, but a regression here would be silent (messages just sit). Worth a safety net.

**Next step**: draft test when touching `host-sweep.ts` or `index.ts` startup flow next.

---

## MEDIUM

### 4. `response_scope` enforcement
**Finding**: `messaging_group_agents.response_scope` stores `'all' | 'triggered' | 'allowlisted'` but nothing reads it.

**Status**: decided — folded into item 1

**Decision**: delete the `response_scope` column as part of the item-1 migration. Values backfill into the new explicit columns:

| Old `response_scope` | New columns |
|---|---|
| `all` | `engage_mode='pattern'`, `engage_pattern='.'`, `sender_scope='all'` |
| `triggered` | `engage_mode='mention'` (or `'pattern'` if legacy row has a pattern), `sender_scope='all'` |
| `allowlisted` | `engage_mode` derived from `trigger_rules`, `sender_scope='known'` |

**Rationale**: `response_scope` conflated two orthogonal axes (engage + sender). Splitting them is the whole point of item 1.

**Next step**: ensure the item-1 migration includes the `response_scope` backfill in its UP step.

### 5. `request_approval` flow for unknown senders
**Finding**: `unknown_sender_policy='request_approval'` is scaffolded in `src/modules/permissions/index.ts:100-108` but falls through to log-and-drop (explicit TODO comment). Current default is `'strict'`, which silently drops — user has no signal that their agent isn't responding.

**Status**: decided — implement, keep simple

**Decision**: implement full approval flow **and** flip the schema default from `'strict'` to `'request_approval'`. UX rationale: users wire their DM during setup; silent drops create a mystery when the agent doesn't respond. Public is unsafe. Approval default → admin sees a card and explicitly decides.

**Flow**:
1. Unknown sender writes to wired messaging group with policy `'request_approval'`
2. If pending approval for `(messaging_group, sender)` already exists → drop this message silently (in-flight dedup; not persistence)
3. Otherwise: insert into `pending_sender_approvals` with original message + timestamp
4. `pickApprover(agent_group_id)` + `pickApprovalDelivery(approverUserId)` — existing machinery in `src/access.ts`
5. Deliver a card via adapter's `deliver()` with `Card`/`Actions`/`Button` primitives (already in chat-sdk-bridge)
6. Card action id prefix `nsa:<approval_id>:<allow|deny>` (parallels existing `ncq:` prefix for `ask_user_question`)
7. On `allow`: upsert `users` row, insert into `agent_group_members`, deliver stored message through normal routing (original timestamp preserved), cleanup pending row
8. On `deny`: cleanup pending row, drop the message. No denial persistence — next attempt from same sender triggers a fresh card.

**No denial persistence** explicit rationale: personal-assistant scale, admin can switch policy to `'strict'` per messaging group if a hostile sender starts spamming. Avoids a new table column and a TTL config.

**New table**:
```
pending_sender_approvals (
  id                TEXT PRIMARY KEY,
  messaging_group_id TEXT NOT NULL,
  agent_group_id    TEXT NOT NULL,
  sender_identity   TEXT NOT NULL,  -- channel_type:handle
  sender_name       TEXT,
  original_message  TEXT NOT NULL,  -- JSON of the InboundEvent
  approver_user_id  TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  UNIQUE(messaging_group_id, sender_identity)  -- enforces in-flight dedup
)
```
Dedicated (not reusing `pending_approvals` which is OneCLI-specific).

**Reuse**:
- `pickApprover` / `pickApprovalDelivery` in `src/access.ts`
- Card rendering primitives already in `src/channels/chat-sdk-bridge.ts`
- `onAction` dispatch — add the `nsa:` prefix handler alongside existing `ncq:`

**LOC estimate**: ~175
- Migration + CRUD for `pending_sender_approvals`: 55
- `handleUnknownSender` request_approval branch + in-flight dedup: 25
- Host-side card dispatcher (pick approver + deliver card): 25
- `onAction` handler for `nsa:` prefix (allow/deny): 30
- Schema default flip + router auto-create update: 5
- Tests: 35

**Module location**: all in `src/modules/permissions/`. Module stays optional; default-allow fallback behavior when not loaded is preserved.

**Open gotchas noted**:
- The router's auto-create at `router.ts:123` currently hardcodes `'strict'` — change to omit the field so schema default applies
- `pickApprover` may return null if no admin/owner exists (e.g. fresh install before first user registered). In that case: log + drop silently, treat as effectively `'strict'` for safety. Don't block message forever.

**Scope boundary** (important): this item covers **unknown sender in a wired channel**. The parallel case — **unknown channel** (new DM / unwired group / bot-added-to-group) — short-circuits at the `no_agent_wired` structural drop before this flow ever runs. Tracked as item 22.

**Next step**: implement alongside item 1 or as a follow-up. Same migration window is fine (one migration for engage columns + request_approval default change + new table).

### 6. Per-group container timeout
**Finding**: v1's `containerConfig.timeout` override is gone. All groups share `IDLE_TIMEOUT`. Original framing (slow-but-healthy agents getting killed) was wrong — v1's `timeout` was a hard wall-clock kill on the whole spawn, totally different from v2's `IDLE_TIMEOUT` (keep-alive after last activity). V2's behavior is strictly better for long-running agents.

**Status**: dropped — not a regression

**Decision**: don't restore per-group timeout override. `IDLE_TIMEOUT=30min` global is the right model. If per-group idle tuning ever becomes useful it's ~15 LOC (new column, env injection at spawn) — small feature add, not a regression to repair.

**Rationale**: v2 lets long-running agents finish; v1 would have hard-killed them at 30min. Current behavior is an improvement.

**Next step**: see 6a.

---

### 6a. Remove IDLE_END_MS (container-side query idle termination)
**Finding**: `container/agent-runner/src/poll-loop.ts:11` defines `IDLE_END_MS = 20_000`. Inside `processQuery`, a concurrent interval ends the active Agent SDK `query()` stream after 20s of SDK silence. Any SDK event (tool use, tool result, streamed text, new pushed message) resets the timer.

This is a general "SDK silence detector," not specifically post-result. It fires any time:
- Mid-work: slow tool call with no intermediate SDK events (`npm install`, `pytest`, long `WebFetch`, etc.)
- Post-result: agent finished, stream waiting for potential follow-up
- Any other pause in the SDK stream

**Status**: decided — remove, pending SDK verification

**Decision**: delete `IDLE_END_MS` and its setInterval check. Let the `query()` stream stay open as long as the container is active. Container's 30-min `IDLE_TIMEOUT` (host-side in `container-runner.ts`) is the single source of truth for "when to let go."

**Rationale**:
- When new messages arrive mid-stream, they push in via `query.push()` with no reconnect — stream-open is cheaper per-message than close-and-reopen
- Closing early forces a reconnect + cold prompt cache for the next message
- Container stays alive anyway; ending the stream doesn't save resources at the container level
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW=165000` already handles context window growth within a long-lived query
- Anthropic API's own stream timeout will fire if needed; SDK should handle it transparently
- Avoids the false-positive kill during legitimate slow tool calls (common case: agent running `npm install` gets cut off at 20s)

**Caveat (must verify before removal)**: confirm Claude Agent SDK doesn't require explicit `query.end()` for prompt-cache commit or session-state persistence. Expected to be fine (SDK checkpoints per turn) but double-check docs / run a quick test where container idles with stream open, then processes a follow-up.

**LOC estimate**: ~−15 (net deletion — remove constant, setInterval idle check, the `done` flag plumbing may also simplify)

**Next step**: when implementing item 1's changes (or standalone), verify SDK behavior with stream-open-indefinite, then delete IDLE_END_MS block. Watch for any test assertions on it.

### 7. Container streaming output (marker-based pre-delivery)
**Finding**: v1's `---NANOCLAW_OUTPUT_START/END---` markers enabled pre-completion delivery. v2's two paths (final-result `dispatchResultText` + mid-turn `send_message` MCP tool) both write to outbound.db; host polls every `ACTIVE_POLL_MS = 1000ms`.

**Status**: dropped — not a regression

**Decision**: v2's `send_message` MCP tool is the correct replacement for v1's marker-based streaming. Latency is ≤1s (poll interval), which is fine for chat UX.

**Rationale**: v1's marker model required the agent and host to share a fragile state machine over stdout. v2 uses explicit tool calls and a DB surface — cleaner architecture, comparable latency, and control stays with the agent. If perceived latency ever becomes a real complaint, tune `ACTIVE_POLL_MS` down (500ms / 250ms) — low-cost knob.

**Next step**: none.

### 8. Per-exit container log files
**Finding**: v1 wrote timestamped per-exit logs with full I/O + mounts + stderr. v2: stderr → `log.debug` (invisible at default `LOG_LEVEL=info`), container close → `log.info` with exit code, session DBs preserved on disk. Real gap: stderr on abnormal exit isn't auto-surfaced.

**Status**: dropped

**Decision**: skip — no per-exit file restoration, no stderr-on-crash buffer.

**Rationale**: underlying forensic info is still recoverable (session DBs on disk, heartbeat mtime, exit code in log). `LOG_LEVEL=debug` surfaces stderr when needed. The cost of adding buffered crash-log promotion (~15 LOC) isn't justified by the frequency of post-mortem cases.

**Next step**: none.

### 9. Stuck detection + heartbeat-based container lifecycle
**Finding**: v2's sweep detects stale heartbeats (10 min) and resets messages with backoff, but doesn't kill the container. Idle timeout is delivery-count-based (30 min since last messages_out). Together these produce a gap where a stuck container holds resources + blocks new wakes for up to 30 min.

**Empirical findings from SDK probe** (`container/agent-runner/scripts/sdk-signal-probe.ts`, runs logged in `/tmp/probe-*.jsonl`):
- Silent Bash tools (e.g. `sleep 30`) produce 30+ seconds of zero SDK events — heartbeat goes stale during legitimate work
- Natural intra-stream silences up to ~12s observed mid-tool-use JSON streaming
- `PreToolUse` / `PostToolUse` hook pair is reliable; `PostToolUseFailure` fires on blocked requests
- `SubagentStart`/`SubagentStop` and `system/task_started`/`system/task_notification` pairs also reliable
- **Pushing a new message mid-active-turn does NOT fire `UserPromptSubmit`** (fires only at start of a new turn, after `result`)
- SDK's built-in `AskUserQuestion` doesn't actually block; returns placeholder
- Bash tool's declared `timeout` param is visible in `tool_use` input — we can read it container-side
- Stuck tools (hook that never resolves) produce indefinite silence — no SDK-side timeout

**Status**: decided

**Decision**: replace existing IDLE_TIMEOUT setTimeout + STALE_THRESHOLD=10min combo with message-scoped stuck detection + absolute 30-min ceiling. Reset messages inline when we kill. Blocklist SDK tools that don't fit our async model.

**Sweep logic** (per active session):

If container isn't running → reset any `'processing'` rows in processing_ack to `'pending'` + tries++ + backoff. Done.

If container IS running, apply in order:

1. **Absolute ceiling**: if `heartbeat_mtime` older than `max(30 min, current_bash_timeout)` → kill + reset any processing to pending + retry++.
   Rationale: 30 min idle ceiling, extended only if agent is currently inside a Bash tool with longer declared timeout. Agents needing >30 min should use `run_in_background`.

2. **Message-scoped stuck**: for each `processing_ack` row with status=`'processing'`:
   - `claim_age = now - status_changed`
   - `tolerance = max(60s, current_bash_timeout)` if Bash in flight, else `60s`
   - If `claim_age > tolerance` AND `heartbeat_mtime <= status_changed` → kill + reset this message + retry++
   
   Semantics: "container claimed a message and went silent for >tolerance since claim."

No separate idle rule — rule 1 covers it. An idle container hits 30-min stale with no processing rows; kill has nothing to reset.

**Container state surface** (for Bash timeout tracking):
New table in outbound.db (or session_state row):
```
container_state (
  session_id          TEXT PRIMARY KEY,
  current_tool        TEXT,      -- null when no tool in flight
  tool_declared_timeout_ms INTEGER,
  tool_started_at     TEXT
)
```
Container writes on `PreToolUse` (reads Bash `timeout` from tool input), clears on `PostToolUse` / `PostToolUseFailure`. Host reads in sweep decision.

**Tool blocklist** (initial):
- `AskUserQuestion` — SDK built-in; we have our own DB-backed MCP version
- `EnterPlanMode` / `ExitPlanMode` — Claude Code UI only
- `EnterWorktree` / `ExitWorktree` — Claude Code UI only

Enforcement:
- Pass `disallowedTools: [...]` to `query()` options — agent never sees them in its tool list
- `PreToolUse` hook guard (defense-in-depth): if a blocklisted tool name somehow fires, immediately reset the current message + kill (treat as stuck)

**Kill old machinery**:
- Remove `setTimeout` + `resetIdle` plumbing in `container-runner.ts:128-140`
- Remove `resetContainerIdleTimer` export + its caller in `delivery.ts:26`
- Remove `IDLE_END_MS = 20_000` in `poll-loop.ts:11` (item 6a decision) — stream stays open as long as container alive
- Existing `detectStaleContainers` logic merges into the new sweep rules; the heartbeat-stale-10-min path disappears

**LOC estimate**: ~115
- New sweep decision logic replacing existing detectStaleContainers + IDLE_TIMEOUT path: 50
- Container state table + PreToolUse/PostToolUse write, host read: 25
- Tool blocklist (disallowedTools + hook guard): 15
- Deletions (IDLE_TIMEOUT setTimeout, IDLE_END_MS): −25
- Tests (kill paths, Bash-timeout grace, blocklist hit): 50

**Why this converged here** (rationale summary):
- Empirical data showed we can't reliably tell stuck from legitimate-silent-work without state. Bash-declared-timeout is the cleanest per-tool signal available.
- 60s-since-claim is tight enough for normal work (WebSearch/WebFetch finish in ~8s) but generous enough for reasonable delays. Exception for Bash covers agents running scripts with user-declared timeouts.
- 30-min absolute ceiling prevents infinitely-stuck containers; agents needing longer have `run_in_background`.
- Pushing messages can't serve as a liveness probe (they're silent mid-turn), so detection is state-driven, not push-driven.
- Blocklist prevents a whole class of "SDK tool designed for interactive UI" footguns that would appear stuck in our async model.

**Next step**: implement as a focused PR. Order: (a) tool blocklist — safe to ship alone, (b) container state table + PreToolUse writes, (c) sweep rewrite + message reset, (d) delete old IDLE_TIMEOUT + IDLE_END_MS machinery, (e) tests.

### 10. Host-level retry with backoff on agent error
**Finding**: v1 had MAX_RETRIES=5 + exp. backoff on `processGroupMessages` failure. v2's equivalent is now covered by item 9's sweep logic — any time the container isn't running with `'processing'` rows present, they get reset to pending with backoff + retry++.

**Status**: folded into item 9

**Decision**: no separate action. Agent-error retry happens via container-exit → sweep reset. Container errors also surface via provider-side session invalidation check (`poll-loop.ts:200-211` — `provider.isSessionInvalid(err)` → clears stored session id → fresh retry). Both paths preserved.

**Next step**: none.

---

### 11. Process ID in logger output
**Finding**: v1 emitted `(${process.pid})` after the level tag. v2 dropped it.

**Status**: dropped

**Decision**: don't restore. Host is single-process (PID is constant). Container stderr already gets tagged with `{ container: agentGroup.folder }` at `container-runner.ts:121`, which is more informative than a PID.

**Next step**: none.

---

## LOW

### 11. Process ID in logger output
**Finding**: v1 emitted `(${process.pid})` after the level tag. v2 dropped it.
**Status**: pending
**Decision**:
**Rationale**:
**Next step**:

### 12. Task dedup via unique `(kind, series_id)` index
**Finding**: verified — `messages_in.series_id` column exists with a non-unique index. Concern was theoretical: two pending rows with same series could coexist.

**Status**: dropped

**Decision**: not a real issue. Recurrence logic at `src/modules/scheduling/recurrence.ts` is structurally dedup-safe: only `completed` rows with `recurrence` get cloned, and after cloning `recurrence` is cleared on the original so it can't re-clone. Plus container's atomic `markProcessing` prevents double-execution at claim time.

**Next step**: none.

### 13. Silent-drop mode for noisy senders
**Finding**: v1's `mode:'drop'` let you ignore specific users without logging. v2 only has binary allow/deny via access gate.

**Status**: dropped — won't implement

**Decision**: not worth the table + gate complexity for a personal-assistant scale. If a specific sender becomes a problem, admin can switch the messaging_group's `unknown_sender_policy` to `'strict'` or remove the sender from `agent_group_members`.

**Next step**: none.

### 14. Remote control subsystem
**Finding**: v1's `/remote-control` command spawned `claude remote-control` CLI detached, polled stdout for session URL, persisted PID/URL state. Entirely gone in v2.

**Status**: deferred — opt-in skill when needed

**Decision**: reintroduce as an opt-in install skill (e.g. `/add-remote-control`), not on trunk. Provider-specific: only works with `claude` provider (Claude Agent SDK); not supported by OpenCode or other providers. Skill should check `agent_group.provider` at install time and bail gracefully with an error message if not `'claude'`.

**Rationale**: niche feature valuable only for direct agent SDK attachment during dev/debugging. Keeping it off trunk matches v2's "infra-only trunk, features-via-skills" philosophy. Also avoids carrying code for a feature that simply doesn't exist in non-Claude providers.

**Next step**: none until someone needs it. When implementing, likely lives on the `providers` branch (since it's provider-specific) or its own branch, installed via skill that copies files + checks provider.

### 15. Dead config constants
**Finding**: verified — `POLL_INTERVAL` (line 13), `SCHEDULER_POLL_INTERVAL` (line 14), and `IPC_POLL_INTERVAL` (line 32) in `src/config.ts` have zero imports elsewhere in v2. Container's `POLL_INTERVAL_MS` in `poll-loop.ts` is a distinct local constant, unrelated.

**Status**: decided — delete

**Decision**: remove the three constants from `src/config.ts`. Trivial 3-line deletion.

**Next step**: do as part of any sweep-touching PR, or standalone.

### 16. Configurable retention thresholds
**Finding**: `STALE_THRESHOLD_MS` (10 min) and `MAX_TRIES` (5) in `host-sweep.ts` are hardcoded. Item 9's redesign replaces `STALE_THRESHOLD_MS` with new constants (60s claim-age, 30 min ceiling).

**Status**: dropped — keep as constants

**Decision**: leave the new item-9 thresholds + `MAX_TRIES` as source constants. Adding config surface for them isn't worth it at personal-assistant scale. If operational tuning ever becomes a real need, revisit — they're small centralized constants, one-line change each.

**Next step**: none.

### 17. Dynamic group-add (IPC watcher equivalent)
**Finding**: not actually a restart requirement — investigation showed:
- Router reads `messaging_groups` + `messaging_group_agents` fresh per inbound (dynamic by design)
- Chat SDK bridge has a `conversations: Map<platformId, ConversationConfig>` populated at setup + `updateConversations()` method
- **Nothing in the bridge currently reads the map**, and no code calls `updateConversations()` after startup
- Today: stale map has no observable effect (dead state)
- After item 1 ships (adapter-level gating): stale map would matter; new wirings wouldn't apply in the adapter gate until restart

**Status**: deferred — comment added now, implement alongside dynamic group registration feature

**Decision**: don't refactor the adapter interface now. Added a NOTE comment at `src/channels/chat-sdk-bridge.ts:73` flagging the staleness issue so the next person touching the bridge or adding dynamic-registration sees it. When dynamic group registration is implemented (admin adds a new messaging_group_agents row while host is running), handle cache refresh then — most likely by calling `adapter.updateConversations(freshConfigs)` after the mutation, keyed off the adapter's `channelType`.

**Rationale**: item 1's initial landing can keep the adapter gating responsibilities small or skip adapter-side gating entirely. Refactoring ConversationConfig now would add scope; better to ship item 1 first, see if over-subscription bites, address if it does.

**Next step**: when building the admin-skill path for adding messaging_group ↔ agent_group wirings, include a `refreshAdapterConversations(channelType)` call after the INSERT. ~10 LOC when needed.

---

## Test regressions (v1 `formatting.test.ts` assertions)

### 18+19+20+21. Timezone + formatting recreation (merged)
**Finding**: v1 had a full timezone-aware formatting pipeline. v2 lost most of it, producing real bugs where the agent misinterprets user intent (scheduling for wrong times, suggesting time-inappropriate things).

**Scope** — recreate v1 behavior faithfully wherever times touch the agent:
- Timestamp formatting on inbound messages: `formatLocalTime(utcIso, TIMEZONE)` producing "Jan 1, 2024, 1:30 PM" format via `Intl.DateTimeFormat('en-US', {...})` (v1 `timezone.ts`)
- `<context timezone="<IANA_NAME>" />` header prepended to message block (v1 `router.ts:20-22`)
- Reply-to with message ID: `<message ... reply_to="<id>">...<quoted_message from="...">...</quoted_message></message>` (v1 `router.ts:10-18`)
- `stripInternalTags()`: regex `/<internal>[\s\S]*?<\/internal>/g` applied to outbound text, then `.trim()` (v1 `router.ts:25-27`)
- Cron expressions parsed with explicit user TZ: `CronExpressionParser.parse(expr, { tz: TIMEZONE })` (v1 `task-scheduler.ts:20-49`)
- User-specified times normalized via the user's TZ: in v1 this was the host-side task scheduler; in v2 it's the new-in-v2 scheduling MCP tool (`mcp-tools/scheduling.ts`). Same principle — accept user-local times, normalize to UTC for storage, interpret cron in user's TZ.

**Status**: decided — recreate with tests

**Decision**: port v1's formatter + timezone behavior faithfully. Full recreation spec at [`timezone-formatting-v1-recreation.md`](timezone-formatting-v1-recreation.md) — includes exact v1 code, line numbers at commit `27c5220`, complete test inventory from `src/v1/formatting.test.ts` and `src/v1/task-scheduler.test.ts`.

**Core principle** (per Gavriel): the agent operates in the user's timezone. Every timestamp the agent sees is user-local. Every time the agent outputs is interpreted as user-local. This is load-bearing for correctness, not a nice-to-have.

**Porting plan** (from recreation spec):
1. `container/agent-runner/src/formatter.ts` — replace `formatTime` with `formatLocalTime(ts, TIMEZONE)` call; add reply_to attribute + `<quoted_message>` element exactly as v1
2. Prepend `<context timezone="<IANA>" />\n` to the messages block at formatter entry
3. Extract `stripInternalTags` as a named function; apply in outbound dispatch path (`poll-loop.ts:389` currently uses inline regex)
4. `container/agent-runner/src/mcp-tools/scheduling.ts` — clarify `processAfter` description, normalize to UTC ISO in handler
5. `src/modules/scheduling/recurrence.ts` — pass `{ tz: TIMEZONE }` to `CronExpressionParser.parse()` explicitly
6. Port all test cases from v1's `formatting.test.ts` and `task-scheduler.test.ts` to v2's test tree

**LOC estimate**: ~75 prod + ~120 tests (reproducing v1's 40+ test cases)

**Next step**: implement as a focused PR. Order: (a) formatter changes + tests, (b) context header + tests, (c) reply_to + tests, (d) stripInternalTags extraction + tests, (e) scheduling tool + cron TZ + tests.

### 19, 20, 21 — merged into 18 above
See item 18 for the full recreation plan and spec reference.

---

## Notes
- `src/v1/` was deleted upstream (commit 86becf8) after this analysis was written. v2 tree has since had a major module extraction (approvals, interactive, scheduling, permissions, agent-to-agent, self-mod) and a new CLI channel. **Verify each item against the current tree before deciding** — some may already be addressed.
