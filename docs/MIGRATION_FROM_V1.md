# Migrating from v1 Fork

Execution guide for standing up this v2 instance alongside the existing v1 fork (`~/nanoclaw`), porting customizations, validating parity, and cutting over.

**Source analysis:** `~/nanoclaw/docs/V2_MIGRATION_PLAN.md` — full architecture comparison, 4-pass GitNexus audit, 93+ items mapped across 4 tiers plus new v2 capabilities.

**Audit history:**
- Pass 1: Initial 60 customization inventory via Agent subagents
- Pass 2: Corrections via GitNexus queries (demoted #2, #3, #4)
- Pass 3: Structured exploring + refactoring skill workflow (dependency maps, insertion points)
- Pass 4 (2026-04-16): Fresh-context audit with 3 parallel agents + upstream drift check → 33 unmapped v1 customizations surfaced, 14 missed v2 features, 1 new upstream feature (dropped-messages), 3 technical corrections. Tier 1 expanded from 5 → 8, Tier 2 from 10 → 16 (dynamic Haiku downgrade deprecated per user decision).

---

## Why v2 — New Capabilities

These are reasons to migrate, not porting targets. Understanding them informs decisions throughout this guide.

### Multi-Agent Coordination
v2's headline feature. v1 has a flat group model — one agent per group, no inter-agent communication. v2 introduces:
- **`agent_groups` vs `messaging_groups`** — Agents are decoupled from channels. Multiple agents can wire to the same messaging group with priority and trigger rules.
- **Inter-agent messaging** — Agents address each other by name: `send_message(to="research-agent")`. The host routes through the same delivery pipeline as user messages.
- **Subagent spawning** — `create_agent` MCP tool (admin-gated). Creates a new agent group with bidirectional destination wiring.
- **Three session modes:** `per-thread` (thread = session), `shared` (channel = session), `agent-shared` (multiple agents share one session context).

### Chat SDK Message Editing and Reactions
- **Edit in place** — `operation: 'edit'` in `messages_out` → `adapter.editMessage()`. Works on Slack, Discord, Teams.
- **Reactions** — `operation: 'reaction'` → `adapter.addReaction()`.
- **`edit_message` MCP tool** — Agents can call `edit_message(seq, text)` to update a previously sent message. Enables agent-driven progress updates.
- **Interactive cards** — Approval and credential flows render as platform-native cards with buttons and modals.

### User-Level Privilege Model
- **User entity** — `users` table with namespaced IDs (`discord:123`, `slack:U456`).
- **Role hierarchy** — owner > global admin > group admin > member.
- **Unknown sender policy** — Per messaging group: `strict` | `request_approval` | `public`.
- **Cold-DM approval routing** — Approval requests delivered to admin DMs, even if admin hasn't messaged the bot before.

### Per-Group Container Images
- **`container.json`** per agent group — apt/npm packages, MCP servers, additional mounts.
- **`request_rebuild()`** — Agent triggers image rebuild with custom packages (admin-approved).
- **Agent-runner source overlay** — Each group can have `agent-runner-src/` that overlays the base runner at `/app/src`. Per-agent customization of poll loop, MCP tools, or providers without rebuilding the base image.
- **Rebuild fan-out tradeoff** — Per-group images are `FROM` the base. Base image changes require rebuilding all custom images. v1's approach (universal install, scoped access) avoids this. See Phase 1.5 for the tooling strategy decision.

### OneCLI Zero-Knowledge Credentials
- **Proxy injection** — API keys injected at the HTTP proxy level. Agent sees `HTTPS_PROXY`, never the key.
- **Secure collection** — Agent requests a credential → user enters in platform-native modal → goes straight to OneCLI vault. Never logged or stored in session.
- **Per-agent policies** — OneCLI can enforce rate limits and access patterns per agent.

### Session Continuation
- **Continuation token** — Opaque session ID persisted in `session_state` table. Claude Code resumes without replaying the full transcript.
- **Stale session detection** — `ClaudeProvider.isSessionInvalid()` uses regex matching; clears continuation and starts fresh automatically.
- **Transcript archiving** — `createPreCompactHook` saves conversation as markdown before Claude Code truncates.

### Destination-Based ACL
- `agent_destinations` table controls what each agent can message. Only explicitly wired destinations are reachable. v1 agents can send to any JID via IPC — v2 is more restrictive.

### Modular MCP Architecture
v2 splits container MCP tools into 6 modules: `core.ts` (send_message, send_file, edit_message, add_reaction), `credentials.ts` (trigger_credential_collection), `agents.ts` (create_agent), `interactive.ts` (**ask_user_question** — blocking poll with platform-native cards; **send_card** — structured interactive card with arbitrary `card` object + `fallbackText`), `scheduling.ts` (schedule_task, list_tasks, cancel_task, pause_task, resume_task), `self-mod.ts` (install_packages, add_mcp_server, request_rebuild).

### Host Sweep
`host-sweep.ts` runs every 60s and replaces v1's watchdog, task scheduler, and session cleanup in a single unified loop: syncs `processing_ack` status, wakes containers for due messages, detects stale containers via heartbeat file mtime (10-min threshold), retries stuck messages with exponential backoff (5s base, max 5 retries), and handles cron recurrence for scheduled tasks.

### Entity Model
```
users (id "<channel>:<handle>", kind, display_name)
user_roles (user_id, role, agent_group_id)       — owner | admin (global or scoped)
agent_group_members (user_id, agent_group_id)    — unprivileged access gate
user_dms (user_id, channel_type, messaging_group_id)

agent_groups ←→ messaging_groups  (many-to-many via messaging_group_agents)
sessions (agent_group_id + messaging_group_id + thread_id → per-session container)
```

### Database Architecture
- **Central `v2.db`** — users, roles, agent_groups, messaging_groups, wiring, pending_approvals, pending_credentials, **unregistered_senders** (new), `chat_sdk_kv` / `chat_sdk_subscriptions` / `chat_sdk_locks` / `chat_sdk_lists` (Chat SDK persistence)
- **Per-session `inbound.db`** (host writes, container reads) — messages_in, processing_ack, session_routing, destinations
- **Per-session `outbound.db`** (container writes, host reads) — messages_out, session_state
- Single-writer-per-file invariant eliminates lock contention.

### Unregistered Senders Tracking (upstream 82422d2)
`unregistered_senders` table records messages from senders who aren't members of any agent group. Tracks `channel_type, platform_id, user_id, sender_name, reason, message_count, first_seen, last_seen`. Operators can review via the table or forthcoming admin UI.

### Browser Automation (Native)
v2's base Dockerfile installs Chromium + `agent-browser` CLI globally. Agents have snapshot/click/fill/screenshot capabilities via the `agent-browser` skill at `container/skills/agent-browser/SKILL.md`. This is a **major v2 capability** not just for mermaid rendering — it's first-class web interaction.

### In-Container Admin Commands
Poll-loop handles `/clear`, `/compact`, `/context`, `/cost`, `/files`, `/remote-control` in the container directly, gated by `NANOCLAW_ADMIN_USER_IDS` env. Silently-filtered: `/help`, `/login`, `/logout`, `/doctor`, `/config`. **You do not need to port `/compact` — it already works.**

### Expanded Channel Adapters
Beyond Slack/Discord/Telegram/WhatsApp, v2 ships adapters for: **Google Chat, Matrix, Teams, Webex, Linear, GitHub, iMessage, Resend** (email), **whatsapp-cloud**. Each has a corresponding `/add-*-v2` skill.

### XML Dispatch Protocol
Agent output is parsed by `dispatchResultText` (poll-loop.ts L329-394) for:
- `<message to="name">...</message>` blocks — multi-destination dispatch
- `<internal>...</internal>` blocks — scratchpad (logged but not sent)
- If no XML and exactly one destination → entire cleaned text sent to that destination

Agents must be prompted to emit correct XML when addressing multiple destinations.

### OneCLI Approval Flow (Beyond Credential Injection)
`src/onecli-approvals.ts` intercepts credentialed outgoing requests that need human approval. Delivers an approval card to admins, persists `pending_approvals` row (action='onecli_credential'), resolves on click. This is **governance**, not just credential injection.

### Mount Allowlist Security
`src/mount-security.ts` validates additional mounts against `~/.config/nanoclaw/mount-allowlist.json` (outside project root). Default blocked patterns: `.ssh`, `.aws`, `.env`, `id_rsa`, `.kube`, `private_key`, etc. Managed via the `/manage-mounts` skill (upstream addition).

### `NANOCLAW_MCP_SERVERS` Env Override
Host can inject additional MCP servers as JSON in container env — merged into runtime config without rebuilding. Complements `container.json` + `add_mcp_server` MCP tool.

### Telegram Pairing Handshake
`src/channels/telegram-pairing.ts` (358 lines) implements a code-challenge protocol for securely wiring new Telegram chats: operator runs setup, receives a one-time code, sends it from the Telegram chat to prove ownership. Attempts are rate-limited, codes expire (post-upstream update: TTL removed), state stored in `data/telegram-pairings.json`. Managed via `/add-telegram-v2` skill. No v1 equivalent in the fork — this is net-new operator workflow.

---

## Risk Analysis

### HIGH

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Memory extraction gap** | Agents lose long-term context. Response quality degrades for returning users/topics. | Port early (Phase 2.5). Highest-effort, highest-value item. |
| **Channel behavior differences** | Chat SDK adapters format differently than v1's custom implementations. Users notice. | Side-by-side comparison on same inputs. Test tables, code blocks, emoji. |
| **OneCLI dependency** | If OneCLI fails, agents can't make authenticated API calls. Single point of failure. | Verify stability before cutover. Have env-var-injection fallback plan for emergencies. |
| **Session history loss** | v1 sessions (JSONL transcripts, memory DBs) don't transfer to v2's schema. Conversation history is lost on cutover. | Accept this. Export key memories to CLAUDE.md files in Phase 0. |

### MEDIUM

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Gate protocol gap** | v2's approval covers self-mod but not arbitrary destructive commands. Agents could run `git push --force` without approval. | Rely on Claude Code's built-in permission model initially. Extend approvals in Phase 5.8. |
| **Container tooling gaps** | First runs fail for tasks requiring dbt, gcloud, snowflake etc. until container.json configured. | Pre-configure in Phase 1.5. Test tool availability before Phase 3. |
| **Webhook/connection stability** | Chat SDK may handle reconnection differently than v1's custom implementations. | Monitor connection drops during side-by-side period. |

### LOW

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Tone profile absence** | Default tone until ported. | Low effort (Phase 5.1). |
| **No Web UI** | Lose monitoring dashboard. | Use channel messages + logs initially. |
| **Thread naming** | v2 may not generate AI thread titles (v1 used Haiku). | Test during Phase 3. |

---

## Estimated Effort

| Phase | Items | Rough Effort |
|-------|-------|-------------|
| Phase 0: Preparation | Memory export, config docs, OneCLI verification | 1-2 days |
| Phase 1: Stand up v2 | Fresh instance + channel setup + container config | 1-2 days |
| Phase 2: Tier 1 ports | 8 features (revised up after audit) | 2-3 weeks |
| Phase 3: Side-by-side | Validation + bug fixes | 1-2 weeks |
| Phase 4: Cutover | Switch + monitor | 1 day |
| Phase 5: Tier 2 ports | 16 features (dynamic Haiku downgrade deprecated) | 2-4 weeks (ongoing) |

---

## Data Migration

v1's data lives in `~/nanoclaw/store/messages.db` (SQLite) and `~/nanoclaw/groups/` (filesystem). v2 uses a completely different storage model (central v2.db + per-session inbound/outbound DBs). Most structured data does not transfer.

### What migrates

| Data | v1 Location | Volume | Action |
|------|-------------|--------|--------|
| **Memories** | `store/messages.db` → `memories` table | 287 entries | **Direct SQL export/import.** Schema is nearly identical. Export in Phase 0, import after Phase 2.5 creates the v2 memories table. |
| **Group CLAUDE.md files** | `groups/*/CLAUDE.md` | 11 group-root files (+ global) | **Direct file copy.** Compatible structure. Copy in Phase 1.6. (Nested CLAUDE.md files inside cloned project repos and worktrees are not part of nanoclaw config — they come back when agents re-clone.) |
| **Tone profiles** | `tone-profiles/` | 7 profiles | **Direct file copy.** Copy in Phase 1.6, wire in Phase 5.1. |
| **Scheduled task definitions** | `store/messages.db` → `scheduled_tasks` table | 14 active cron jobs | **Manual re-create.** Export prompts + cron expressions, then ask agents to `schedule_task` with the same values. |
| **Group wiring** (channel → group mapping) | `store/messages.db` → `registered_groups` table | 17 groups | **Manual re-wire.** JIDs and channel IDs are reusable. v2's entity model (messaging_groups + agent_groups + wiring) is different. Channel skills + `/init-first-agent` handle setup. |

### What does NOT migrate

| Data | v1 Location | Volume | Why |
|------|-------------|--------|-----|
| **Message history** | `store/messages.db` → `messages` table | ~8,500+ messages (grows daily) | v2 uses per-session inbound.db/outbound.db with different schema. No mapping possible. |
| **Session state** | `store/messages.db` → `sessions` table | 241 sessions | v2 creates new sessions per agent_group + messaging_group + thread. |
| **Thread metadata** | `store/messages.db` → `thread_metadata` table | 413 entries | v2 manages threads via session model. |
| **Session transcripts** | `data/sessions/*/.claude/` | Multiple dirs | Claude Code internal state. v2 uses different session storage with continuation tokens. |
| **Attachments** | `data/attachments/` | Files | Stale references tied to v1 message IDs. |
| **Ship log** | `store/messages.db` → `ship_log` table | 129 entries | Historical record only. Export to a text file for reference if desired. |

### Key takeaway

The two things that matter most migrate cleanly: **memories** (accumulated knowledge) and **CLAUDE.md files** (group instructions). Message history is lost but memories capture the important facts. Scheduled tasks need manual re-creation but the definitions are exportable.

---

## Phase 0: Preparation

Do these before touching v2. All work happens in the v1 repo (`~/nanoclaw`).

- [ ] **Export memories** — Dump all 287 memory entries from v1's SQLite. These import directly into v2's memories table once created in Phase 2.5.
  ```bash
  # In ~/nanoclaw — export memories as JSON for later import
  sqlite3 ~/nanoclaw/store/messages.db -json \
    "SELECT id, group_folder, type, name, description, content, created_at, updated_at FROM memories ORDER BY group_folder, created_at" \
    > ~/nanoclaw-v2/data/v1-memories-export.json
  ```
- [ ] **Export scheduled tasks** — Save the 14 active cron jobs for manual re-creation in v2.
  ```bash
  sqlite3 ~/nanoclaw/store/messages.db -json \
    "SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value, status FROM scheduled_tasks WHERE status='active'" \
    > ~/nanoclaw-v2/data/v1-scheduled-tasks-export.json
  ```
- [ ] **Document group configs** — For each group in `~/nanoclaw/groups/`, record:
  - Channels wired (Slack channel IDs, Discord guild/channel IDs, Telegram chat IDs)
  - Tools needed (dbt, gcloud, gh, snowflake-cli, etc.)
  - Credentials required (which env vars / OneCLI secrets)
  - Tone profile (if any)
  - Special container packages
- [ ] **Verify OneCLI** — `onecli --version && onecli agent list`. Confirm gateway is running.
- [ ] **Check channel credentials** — Ensure bot tokens for Slack, Discord, Telegram are accessible. v2's Chat SDK adapters need the same tokens but in different env var names — check each `/add-*-v2` skill for the expected var names.

---

## Phase 1: Stand Up v2

All work in `~/nanoclaw-v2`.

### 1.1 Install and build

- [ ] `npm install`
- [ ] `npm run build`
- [ ] `npm test` — confirm clean baseline

### 1.2 Run setup

- [ ] `claude` then `/setup` — Claude Code handles dependencies, container build, service config

### 1.3 Add channels

Run the v2 channel skills. Each one modifies `src/channels/index.ts` to enable the adapter.

- [ ] `/add-slack-v2` — needs `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`
- [ ] `/add-discord-v2` — needs `DISCORD_BOT_TOKEN`
- [ ] `/add-telegram-v2` — needs `TELEGRAM_BOT_TOKEN`

### 1.4 Bootstrap first agent

- [ ] `/init-first-agent` — creates the first agent group, wires it to a DM channel, sets you as owner

### 1.5 Configure container tooling

**Decision point:** Choose a tooling strategy.

| Option | Approach | When to use |
|--------|----------|-------------|
| **A: Template container.json** | Define standard packages in a template that `group-init.ts` copies to new groups | Multiple groups with same needs |
| **B: Custom base image** | Fork `container/Dockerfile`, bake in common tools | Single-user, consistent toolset |
| **C: Hybrid** | Custom base for heavy tools (Python, CLIs), per-group for niche | Best of both — recommended |

**Why hybrid is recommended:** v1 proved that universal install with scoped access works well for a single user. Per-group isolation is architecturally better but creates a rebuild fan-out problem (base image change → rebuild every custom image). Hybrid avoids this for common tools.

**Full tooling inventory from v1 fork:**

| Tool | Category | Action |
|------|----------|--------|
| dbt-core, dbt-snowflake, snowflake-cli | Data/Analytics | Base image (Python + pip) |
| matplotlib, seaborn, plotly, kaleido | Visualization | Base image (pip) |
| gcloud CLI, AWS CLI v2 | Cloud infra | Base image (apt) |
| Render CLI, Railway CLI, Supabase CLI | Platform CLIs | Base image (npm) |
| gh CLI | Dev tooling | Base image (apt) |
| gitnexus | Code intelligence | Base image (npm) + hooks (Phase 5.2) |
| gws (Google Workspace) | Productivity | Base image (npm) + OneCLI credential |
| mermaid-cli | Rendering | Per-group container.json (niche) |
| codex | Code generation | Per-group container.json (niche) |
| Exa search | Web search | Per-group container.json MCP server |
| Braintrust | LLM eval | OneCLI credential |
| Omni Analytics | Analytics | OneCLI credential |
| Granola | Meeting notes | OneCLI credential (if still needed) |
| youtube-transcript-api | Media | Per-group container.json (niche) |
| ffmpeg | Media | Per-group container.json (niche) |
| PostgreSQL client, Redis CLI | Database | Base image (apt) |

For option C, edit `container/Dockerfile`:
```dockerfile
# After existing installs, add common tools:
RUN apt-get update && apt-get install -y postgresql-client jq gnupg curl && rm -rf /var/lib/apt/lists/*
RUN npm install -g @gitnexus/cli mermaid-cli gws
# Python stack (if needed across most agents):
RUN apt-get update && apt-get install -y python3 python3-pip && pip3 install dbt-core dbt-snowflake snowflake-cli-labs
```
Then rebuild: `./container/build.sh`

For per-group additions, edit `groups/{folder}/container.json`:
```json
{
  "packages": {
    "apt": ["ffmpeg"],
    "npm": ["youtube-transcript-api"]
  },
  "mcpServers": {
    "exa": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/exa-mcp-server"]
    }
  }
}
```

### 1.6 Import context

- [ ] Copy group CLAUDE.md content from `~/nanoclaw/groups/*/CLAUDE.md` → `~/nanoclaw-v2/groups/*/CLAUDE.md`
- [ ] Paste exported memories into relevant CLAUDE.md files (until memory extraction is ported)
- [ ] Copy tone profiles: `cp -r ~/nanoclaw/tone-profiles ~/nanoclaw-v2/tone-profiles` (used later in Tier 2)

### 1.7 Verify basic flow and native v2 features

These features are native in v2 and should work without porting. Verify they do.

- [ ] Send a test message via each channel → confirm response arrives
- [ ] Check formatting (code blocks, bold, lists)
- [ ] Check typing indicator appears and clears (v2 uses heartbeat-gated refresh — better than v1's process-exit-gated)
- [ ] **Slack threads** — Reply in a thread → verify thread gets its own session (`supportsThreads: true`). Verify thread context (parent message) is included in agent prompt.
- [ ] **Discord threads** — Same as Slack. Verify AI thread naming works (v1 used Haiku for titles — check if v2 generates titles or uses a default).
- [ ] **File attachments** — Send a file → verify agent receives it. Have agent send a file back → verify delivery. Check file size limits per platform.
- [ ] **Session resumption** — Send a message, wait for response. Kill the container. Send another message → verify agent resumes context (continuation token).

---

## Phase 2: Port Tier 1 Customizations

5 features, ordered by dependency and effort. Each section has the exact v2 files to modify.

### 2.1 SDK Model Drift Detection

**Effort:** Low  
**v1 source:** `~/nanoclaw/container/agent-runner/src/index.ts` (search for `modelDrift` or `setModel`)  
**v2 target:** `container/agent-runner/src/providers/claude.ts` — `ClaudeProvider.query()`

**What to do:** After each `result` event from the SDK, check if the model in `modelsUsedThisTurn` differs from the configured model. If it drifted (e.g., `sonnet-4-5` instead of `sonnet-4-6[1m]`), call `setModel()` to restore and log a warning.

**Test:** Run a session, check logs for drift detection. Force a drift by temporarily configuring a model that the SDK might fall back from.

- [ ] Implemented
- [ ] Tested

### 2.2 Secret Leak Prevention

**Effort:** Low  
**v1 source:** `~/nanoclaw/src/secret-scrubber.ts`, `~/nanoclaw/src/logger.ts`  
**v2 target:** `src/log.ts`

**What to do:** Wrap `process.stdout.write` and `process.stderr.write` with a scrubber that redacts known secret patterns (bot tokens, API keys) from log output. The v1 scrubber is a single function — adapt it for v2's `log.ts` pino-based logger.

**Test:** Set a dummy secret in env, trigger a log that would include it, verify it's redacted.

- [ ] Implemented
- [ ] Tested

### 2.3 API Key Rotation on 429

**Effort:** Low (may be unnecessary)  
**v1 source:** `~/nanoclaw/container/agent-runner/src/index.ts` (search for `ANTHROPIC_API_KEY_2`)  
**v2 target:** `container/agent-runner/src/providers/claude.ts` or handled by OneCLI

**What to do first:** Test whether OneCLI handles 429s automatically. Send rapid requests to trigger rate limiting. If OneCLI retries with a different key, skip this. If not, port the multi-key fallback from v1.

- [ ] Tested OneCLI 429 behavior
- [ ] Port needed? [ ] Yes → Implemented  [ ] No → Skip

### 2.4 Progress Updates (Native Events, Post-Then-Edit)

**Effort:** Low-Medium (revised down — SDK emits progress natively)
**v1 source:** `~/nanoclaw/src/index.ts` L1738-1791 (reference only — we're building this natively)
**v2 targets:**
- Container: `container/agent-runner/src/poll-loop.ts` — `handleEvent()` **(lines 300-315)**, `case 'progress'` branch
- Host: `src/delivery.ts` — `deliverSessionMessages()`
- Bridge: `src/channels/chat-sdk-bridge.ts` — already handles `operation: 'edit'`

**Key finding:** The Claude provider (`container/agent-runner/src/providers/claude.ts` L249-252) already emits `{ type: 'progress', message }` events from the SDK's `task_notification` subtype messages. **No phase-derivation heuristic needed** — the SDK's semantic progress message IS the phase.

**Implementation:**

1. **Container side** (`poll-loop.ts` → `handleEvent`, `case 'progress'`):
   Currently: `log(\`Progress: ${event.message}\`);` — only logs to stderr.
   Change to also write a status row:
   ```typescript
   case 'progress':
     log(`Progress: ${event.message}`);
     writeMessageOut({
       id: generateId(),
       kind: 'status',
       content: JSON.stringify({ text: event.message }),
     });
     break;
   ```

2. **Host side** (`delivery.ts` → `deliverSessionMessages`):
   - When `kind === 'status'`:
     - If no prior status message for this session → `adapter.sendMessage()` → save `platform_message_id`
     - If prior status exists → `adapter.editMessage(savedId, newText)`
   - When a `kind === 'chat'` message is delivered, clear the status tracking (the real response replaces status)

3. **Phase mapping is NOT needed** — the SDK's `task_notification` messages provide semantic progress text directly. The phase-derivation heuristic in the original plan (Read/Grep → "Exploring codebase") was redundant. If task_notification messages turn out to be too sparse or unhelpful in practice, a tool-call heuristic can be added as a fallback, but start simple.

- [ ] Container: handleEvent 'progress' case writes status rows
- [ ] Host: delivery handles status kind with post-then-edit (new `statusTracking` map per session)
- [ ] Tested on Slack
- [ ] Tested on Discord
- [ ] Verified status messages get edited in place, not duplicated

### 2.5 Memory Extraction (Haiku-Based, Interval)

**Effort:** High — largest port item  
**v1 source files:**
- `~/nanoclaw/src/memory-extractor.ts` — extraction logic, prompt building, response parsing
- `~/nanoclaw/src/memory-store.ts` — save/update/delete with dedup
- `~/nanoclaw/src/llm.ts` — `callHaiku()` wrapper (**shells out to `claude` CLI** via execFile with `-p --model haiku --no-session-persistence`, not a direct API call — uses host's Claude Code auth)
- `~/nanoclaw/src/embedding.ts` — OpenAI embeddings + sqlite-vec (Phase C only)
- `~/nanoclaw/src/db.ts` — memories table schema, `listMemories`, `insertMemory`, etc.

**v2 targets:**
- New file: `src/memory-extractor.ts`
- New file: `src/memory-store.ts`
- New file: `src/llm.ts` (or inline into memory-extractor)
- DB migration: `src/db/migrations/NNN-memories.ts` — add `memories` table to central v2.db
- Hook: `src/delivery.ts` — trigger extraction after chat message delivery
- Timer: `src/host-sweep.ts` or dedicated interval — run extraction every 60s per active session

**Implementation order:**

1. **DB schema** — Add migration for memories table:
   ```sql
   CREATE TABLE memories (
     id TEXT PRIMARY KEY,
     agent_group_id TEXT NOT NULL,
     type TEXT NOT NULL,  -- user | project | reference | feedback
     name TEXT NOT NULL,
     description TEXT,
     content TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT
   );
   ```

2. **Memory store** — Port `saveMemory`, `updateMemory`, `deleteMemory`, `listMemories` using v2's `getDb()` pattern.

3. **Haiku caller** — **Recommendation: replace the CLI shell-out with direct Anthropic SDK call.** v1's `callHaiku` uses `claude` CLI which may not be available on v2's host. v2 already depends on `@anthropic-ai/claude-agent-sdk` in agent-runner — use `@anthropic-ai/sdk` directly on host with model `claude-haiku-4-5-20251001`. Needs `ANTHROPIC_API_KEY` in host env.

4. **Extractor** — Port `extractMemories`, `buildPrompt` (calls `formatMessages`, `formatExistingMemories`, `loadTemplate`), `parseResponse`. Adapt message format from v1's `NewMessage` type to v2's `MessageOutRow`/`MessageInRow`.

   Full v1 call tree for reference:
   ```
   extractMemoriesAsync → extractMemories
     ├─ callHaiku (llm.ts)
     ├─ listMemories (db.ts)
     ├─ buildPrompt
     │    ├─ formatMessages
     │    ├─ formatExistingMemories
     │    └─ loadTemplate (optional custom prompt)
     ├─ parseResponse
     ├─ saveMemory → embedAndStore (embedding.ts, Phase C only)
     ├─ updateMemory
     └─ deleteMemory
   ```

5. **Hook into delivery** — After `deliverSessionMessages` delivers a `kind: 'chat'` message, call `extractMemoriesAsync(agentGroupId, sessionId, recentMessages, deliveredText)`.

6. **Interval** — Add a 60s timer per active session (in host-sweep or a dedicated module). On each tick, gather recent messages from the session's inbound/outbound DBs and run extraction.

7. **Inject into agent context** — When formatting messages for the agent in `container/agent-runner/src/formatter.ts`, include relevant memories from the group's memory store. This requires the host to write memories into the session's inbound.db (or a new mounted file) so the container can read them.

- [ ] DB migration added
- [ ] Memory store ported
- [ ] Haiku caller working (via Anthropic SDK, not CLI)
- [ ] Extractor ported and adapted for v2 message types
- [ ] Delivery hook wired
- [ ] Interval timer running
- [ ] Memories injected into agent context
- [ ] Tested: facts extracted from conversation
- [ ] Tested: dedup works (no duplicate memories)
- [ ] Tested: contradictions update/delete old memories

### 2.6 Attachment Downloader (NEW — added in fourth-pass audit)

**Effort:** Medium
**v1 source:** `~/nanoclaw/src/attachment-downloader.ts`
**v2 target:** New `src/attachment-downloader.ts` + integration in `chat-sdk-bridge.ts`

**What to do:** v1 has a central utility that downloads inbound attachments from channels (Slack/Discord/Telegram), resizes images with sharp, enforces size limits, and cleans up. v2's Chat SDK bridge fetches attachments to base64 but doesn't have the resize/cleanup pipeline. Port the v1 module and hook into the Chat SDK bridge's attachment handling.

**Test:** Send large image attachments → verify resize works and size limits enforced.

- [ ] Ported
- [ ] Tested with image attachments
- [ ] Tested with documents

### 2.7 IPC Git Handlers (NEW — added in fourth-pass audit)

**Effort:** High
**v1 source:** `~/nanoclaw/src/ipc.ts` — `git_commit`, `git_push`, `open_pr` handlers + MCP tools
**v2 target:** Evaluate first — v2 may not need this if Claude Code can write to container-mounted repos directly

**Decision tree:**
1. Phase 3 parity test: try `git commit` inside a v2 container. Does it work?
2. If YES → skip this port. Claude Code's native git tools handle it.
3. If NO (read-only mount) → port as host-side MCP handlers: agent calls `git_commit(worktree)` tool, host executes git on its writable copy.

- [ ] Tested whether v2 containers can commit
- [ ] Decision: Port required? [ ] Yes → Implemented  [ ] No → Skip

### 2.8 Auto-Dream / Auto-Memory Container Settings (NEW — added in fourth-pass audit)

**Effort:** Low
**v1 source:** `~/nanoclaw/src/container-runner.ts` (search `autoDreamEnabled` / memory dir sharing)
**v2 target:** `container/agent-runner/src/providers/claude.ts` — `ClaudeProvider` constructor

**What to do:** v1 enables Claude Code's native auto-memory + shared memory directory across threads in a group. Distinct from the Haiku-based extraction in 2.5 — this is Claude Code's built-in feature. Set the relevant SDK options in the provider.

- [ ] Implemented
- [ ] Verified via container logs

---

## Phase 3: Side-by-Side Validation

Run both instances simultaneously. Route test channels to v2, production stays on v1.

### Parity Checklist

- [ ] Messages send and receive on all configured channels
- [ ] Thread isolation works (concurrent threads don't interfere)
- [ ] Long sessions (~50+ tool calls) show progress updates and don't time out
- [ ] Destructive commands trigger approval flow (Claude Code permission prompts + pending_approvals for self-mod)
- [ ] Memory extraction captures user preferences and project context
- [ ] Agent can use all required tools (dbt, git, gcloud, etc.)
- [ ] Typing indicators appear and clear correctly
- [ ] File attachments send successfully (including per-platform size limit validation)
- [ ] Error recovery works (agent crash → clean restart via host-sweep stale detection)
- [ ] Session resumption works across container restarts (continuation token)
- [ ] Tables render acceptably on Discord and Slack (spot-check)
- [ ] Can v2 agents make git commits natively? (Claude Code runs inside the container — test whether git write operations work with the mount setup)

### Spot-Checks

- [ ] Send a message with a markdown table → verify rendering on each channel
- [ ] Send a long code block → verify it's not truncated or garbled
- [ ] Trigger a 429 → verify recovery (OneCLI or fallback)
- [ ] Kill a container mid-session → verify host detects stale heartbeat and retries
- [ ] Send concurrent messages in different threads → verify isolation

---

## Phase 4: Cutover

1. [ ] Stop v1: `systemctl --user stop nanoclaw`
2. [ ] Switch channel webhooks/tokens to v2 (if using different bot instances)
3. [ ] Start v2: `systemctl --user start nanoclaw-v2`
4. [ ] Monitor for 48 hours
5. [ ] Keep v1 available for rollback for 2 weeks: `~/nanoclaw` stays intact

---

## Phase 5: Port Tier 2 Features

After cutover is stable. Priority order:

### 5.1 Tone Profiles
**v2 target:** Mount `tone-profiles/` read-only into containers, add `get_tone_profile` MCP tool to `container/agent-runner/src/mcp-tools/`.
- [ ] Ported

### 5.2 GitNexus Hooks
**v2 target:** Port `container/nanoclaw-plugin/hooks/` directory, mount into containers, verify Claude Code discovers hooks.
- [ ] Ported

### 5.3 Capability Self-Awareness
**v2 target:** Port `container/bin/capability-check`, mount into containers.
- [ ] Ported

### 5.4 Daily Digests
**v2 target:** Implement as a scheduled task via v2's `schedule_task` MCP tool. The agent creates its own recurring task that generates the digest.
- [ ] Ported

### 5.5 Effort Level Switching
**v2 target:** Add as MCP tool or session command in `container/agent-runner/src/mcp-tools/`.
- [ ] Ported

### 5.6 Plugin Discovery
**v2 target:** Evaluate if `container.json` + `add_mcp_server` covers the use case. If not, port `/add-plugin` skill.
- [ ] Evaluated
- [ ] Ported (if needed)

### 5.7 Remote Control
**v2 target:** Implement using `agent_destinations` — an agent can send to another agent by name. May not need a separate remote-control system.
- [ ] Evaluated
- [ ] Ported (if needed)

### 5.8 Interactive Gate Buttons
**v2 target:** Extend `pending_approvals` in `src/delivery.ts` to support arbitrary agent-initiated approval requests (not just self-mod).
- [ ] Ported

### 5.9 Channel Formatting
**v2 target:** If table rendering is poor on Discord/Slack during Phase 3, port `table-renderer.ts` as a `transformOutboundText` implementation. v1 process trace: `sendMessage → createThreadAndSend → transformTablesInText → extractMarkdownTables → splitCells`.
- [ ] Spot-checked
- [ ] Ported (if needed)

### 5.10 Web UI
**v2 target:** Evaluate if still needed. v2's richer channel support may eliminate the need.
- [ ] Evaluated
- [ ] Ported (if needed)

### 5.11 Topic Classifier (NEW — added in fourth-pass audit)
**v1 source:** `~/nanoclaw/src/topic-classifier.ts` — Haiku-based 3-tier session reset for threadless channels (Telegram, WhatsApp).
**v2 target:** New module used in router, triggered when messaging group's session_mode = 'shared' and conversation topic shifts.
- [ ] Evaluated
- [ ] Ported (if using threadless channels like Telegram)

### 5.12 Plugin Updater Cron (NEW — added in fourth-pass audit)
**v1 source:** `~/nanoclaw/src/plugin-updater.ts` + `PLUGIN_UPDATE_NOTIFY_JID` env
**v2 target:** Agent creates recurring task via `schedule_task` MCP tool that runs `git pull` across plugin repos and messages destination on updates. Distinct from 5.6 plugin discovery.
- [ ] Ported

### 5.13 Multi-Workspace Slack (NEW — added in fourth-pass audit)
**v1 source:** fork's Slack channel supports multiple workspaces with org-scoped GitHub credentials + sibling-inherit auto-register.
**v2 target:** Verify v2 Chat SDK Slack adapter behavior across multiple workspaces. The native Phase 1.7 "Slack threads" check was under-scoped — also check workspace isolation and credential scoping.
- [ ] Tested multi-workspace
- [ ] Ported scoping logic (if needed)

### 5.14 Discord Slash Commands (NEW — added in fourth-pass audit)
**v1 source:** `/deploy`, `/update-container`, `/update-plugins` + `DISCORD_SLASH_CHANNEL_IDS` env
**v2 target:** Register slash commands via the Discord adapter. Route to appropriate host handlers (deploy → systemctl restart, update → git pull, etc.).
- [ ] Ported

### 5.15 Web UI Auth Layer (NEW — called out separately)
Bundled under 5.10 Web UI, but if porting the Web UI, you must also port:
- `~/nanoclaw/src/auth.ts` — bcrypt password hashing + JWT cookie (30-day `nc_token`)
- `/api/auth/setup-status` endpoint
- Login form (no token in URL)
- [ ] Ported with Web UI

### 5.16 Scoped Env / Tool Scopes (NEW — added in fourth-pass audit)
**v1 source:** `~/nanoclaw/src/scoped-env.ts` — `tool:scope` credential isolation (gmail:illysium, render:scope, browser-auth).
**v2 target:** Evaluate whether OneCLI's per-agent policies cover this. If not, port the scoping model — needed for multi-tenant credential isolation.
- [ ] Evaluated
- [ ] Ported (if OneCLI doesn't cover it)

### Deprecated: Dynamic Haiku Downgrade
Cost-optimization routing for trivial messages (fork-only). Will not be ported; can be rebuilt in v2 if needed later. Removed from scope.

---

## Tier 3: Evaluate After Running v2

These features exist in the v1 fork but may not be needed. Evaluate after running v2 for a week.

| # | Feature | v1 Source | Question | Effort |
|---|---------|-----------|----------|--------|
| T3.1 | **Auto-compact** | `container/agent-runner/src/index.ts` | v2's `ClaudeProvider` sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW` explicitly + has `isSessionInvalid()` for stale session recovery. Is native compact sufficient? | Low |
| T3.2 | **Container watchdog** | `src/container-runner.ts` | v2's host sweep detects stale containers via heartbeat (10-min threshold), retries with exponential backoff (5s base, max 5 retries), marks failed after max. Is this enough? | Low |
| T3.3 | **Complexity classifier** | `src/complexity-classifier.ts` | Was this actually useful in v1? Did it change routing decisions? | Low |
| T3.4 | **Commit digest / attribution** | `src/commit-digest.ts` | Nice for tracking but not essential. Worth the maintenance? | Low |
| T3.5 | **Thread search (FTS5 + Haiku)** | `src/thread-search.ts` | v2's DB schema doesn't include FTS. Is conversation search needed? | Medium |
| T3.6 | **Worktree management** | `src/ipc.ts`, `src/worktree-cleanup.ts` | v2's per-session container isolation may replace the need. Do agents still need host-side worktrees? | High |
| T3.7 | **Blueprint workshop** | Multiple files | Was this completed in v1? Is it still relevant? | Medium |
| T3.8 | **Mermaid rendering** | `container/Dockerfile` | v2 has Chromium in base. Add mermaid-cli to container.json if needed. | Low |
| T3.9 | **YouTube transcript** | `container/Dockerfile` | Add youtube-transcript-api to container.json if needed. | Low |
| T3.10 | **Ollama MCP stdio server** | `container/agent-runner/src/ollama-mcp-stdio.ts` | Local model access via `host.docker.internal`. Worth keeping if Ollama is still used locally. | Low |
| T3.11 | **Blueprint template engine** | `src/blueprint-template.ts` | Mustache-based templating for blueprint workshop (T3.7). Port together if blueprints are still in use. | Medium |
| T3.12 | **GitHub review workflow** | `.github/workflows/review.yml` | anthropics/claude-code-action on PRs. Does the new workflow still work on v2? Verify. | Low |
| T3.13 | **Render workspace auto-config** | `container-runner.ts` commit `feat: auto-pre-configure render workspace per scope at container startup` | Per-scope render CLI setup. Useful if you use Render deploys frequently. | Low |

---

## Open Questions

Track these during the migration. Answers inform decisions marked with ⚠️ in the guide.

1. **Is OneCLI handling 429 rate limits?** → Determines Phase 2.3 (API key rotation). Test before porting.
2. **Is the 165k auto-compact window sufficient?** → Determines T3.1. v2's ClaudeProvider sets it explicitly + stale session recovery. Likely yes.
3. **Is the Web UI still needed?** → Determines Phase 5.10. v2's richer channel support may eliminate the need.
4. **Are worktrees still needed?** → Determines T3.6. v2's per-session isolation may replace IPC-based worktrees.
5. **Which Tier 3 features are actually used?** → Evaluate T3.3 (complexity classifier), T3.7 (blueprint workshop), T3.4 (commit digest).
6. **Can v2 agents make git commits natively?** → v1 had host-side IPC git handlers because containers had read-only mounts. v2 mounts the agent group folder at `/workspace/agent` — but this may be read-only depending on container-runner config. Test whether Claude Code can execute git write operations (commit, push) inside the container. If mounts are read-only, git operations need a writable worktree mount or host-side handlers.
7. **Does Chat SDK handle channel reconnection gracefully?** → v1's custom implementations had retry logic. Monitor during Phase 3.
8. **Should progress updates be host-driven or agent-driven?** → v2 gives agents `edit_message` MCP tool — agent could manage its own status messages. Host-driven (Phase 2.4) is more reliable but less flexible. Could evolve to agent-driven later.
9. **Do task_notification events fire often enough?** → Phase 2.4 relies on native SDK progress events. If they're too sparse in practice, add tool-call heuristics as fallback. Monitor during Phase 3.
10. **Does OneCLI's per-agent policy cover tool-scope credential isolation?** → Fork's `scoped-env.ts` uses `tool:scope` patterns (gmail:illysium, render:prod). If OneCLI natively supports this, skip 5.17. If not, port the scoping model.
11. **Is the `claude` CLI required on v2's host?** → v1's `callHaiku` shells out to `claude` CLI. Phase 2.5 recommends switching to direct Anthropic SDK call. Confirm before implementing.
12. **How does the upstream dropped-messages feature interact with unknown sender policies?** → v2 upstream added `unregistered_senders` table (migration 008). Understand the interplay with messaging_groups.unknown_sender_policy (strict/request_approval/public) before relying on it.

---

## Implementation Notes

### Memory extraction: `wakeContainer` has 7 callers

Any change to container startup (e.g., initializing memory DB access) must account for all 7 entry points: `routeInbound`, `handleQuestionResponse`, `handleApprovalResponse`, `sweepSession`, `notifyAgent`, `deliverMessage`, `notifyAgentSessionResult`.

### Memory extraction: supplementary pre-compact hook

v2's `createPreCompactHook` in the Providers cluster fires before Claude Code truncates. Can serve as supplementary extraction for rare long sessions that hit the 165k window. Not a replacement for interval-based extraction (most sessions finish before compaction). Phase B of the memory port strategy.

### v2's V1 cluster is dead code

`src/v1/` (147 symbols) is carried for reference but not imported by v2's runtime. Won't interfere with porting work.

---

## Post-Upstream-Launch Fork Maintenance

When upstream officially launches v2 (merges v2 → main, tags a release, or otherwise stabilizes), your fork needs to be reconciled. Two scenarios, depending on when launch happens relative to your migration work.

### Scenario A: You cut over BEFORE upstream launches v2

You've completed Phases 1-4 and `dave/migration` is running in production, but upstream's v2 is still a branch. When upstream finally launches v2 (merges to main):

1. **Sync upstream refs:**
   ```bash
   cd ~/nanoclaw-v2
   git fetch upstream
   ```

2. **Replace your fork's `main` with the launched v2 work:**
   ```bash
   # Rebase your migration branch onto upstream's new main (which is now v2-based)
   git checkout dave/migration
   git rebase upstream/main
   # Resolve any conflicts — likely minimal if you've been syncing regularly

   # Fast-forward your fork's main to match
   git checkout main
   git reset --hard dave/migration
   git push --force-with-lease origin main
   ```

3. **Your fork's `main` now = upstream/main + your customizations.** Future `/update-nanoclaw` workflows pull from upstream cleanly.

### Scenario B: Upstream launches v2 BEFORE you cut over

You're mid-migration on `dave/migration`. Upstream releases v2:

1. **Sync upstream refs:**
   ```bash
   git fetch upstream
   ```

2. **Rebase `dave/migration` onto upstream's new main:**
   ```bash
   git checkout dave/migration
   git rebase upstream/main
   # Resolve any conflicts in port work that intersects with upstream changes
   git push --force-with-lease origin dave/migration
   ```

3. **Continue port work** on `dave/migration` tracking the stable upstream/main instead of the volatile upstream/v2 branch.

4. **When you're ready to cut over (Phase 4):** promote `dave/migration` to `main` on your fork:
   ```bash
   git checkout main
   git reset --hard dave/migration
   git push --force-with-lease origin main
   ```

### Safer Alternative: Merge Instead of Rebase

If you prefer not to rewrite history (especially once `dave/migration` is pushed and others may have pulled), use merge instead:

```bash
git checkout main
git merge dave/migration
git push origin main
```

Rebase gives a cleaner history; merge preserves the full timeline. For a single-user fork, rebase is usually fine and cleaner.

### Keeping Your Fork's `main` for v1 Rollback

During Phase 4 cutover and for ~2 weeks after (per the rollback window), keep your existing `main` (v1 customizations) untouched. Only promote `dave/migration` → `main` once you're confident v2 is stable.

Option: rename your current `main` to `v1-main` as an archive before overwriting:
```bash
git push origin main:v1-main     # Archive v1 customizations as v1-main branch
# ... then later ...
git checkout main
git reset --hard dave/migration
git push --force-with-lease origin main
```

That gives you a clean `v1-main` branch on your fork for reference/rollback, and `main` becomes the v2-based production branch.

### Ongoing Upstream Sync

Once settled on v2, pull upstream updates into your fork the same way as v1:
- Use `/update-nanoclaw` skill when available for v2
- Or manually: `git fetch upstream && git rebase upstream/main` on your customization branch

---

## Reference

### Key v2 Files

| File | Purpose | You'll modify for... |
|------|---------|---------------------|
| `src/index.ts` | Entry point (316 lines) | Rarely — it's thin |
| `src/delivery.ts` | Outbound message delivery | Progress updates, memory extraction hook |
| `src/router.ts` | Inbound message routing | — |
| `src/host-sweep.ts` | 60s periodic maintenance | Memory extraction interval |
| `src/container-runner.ts` | Container spawn + lifecycle | Custom mounts, env vars |
| `src/session-manager.ts` | Session DB paths, inbound/outbound | Memory DB access |
| `src/channels/chat-sdk-bridge.ts` | Channel adapter bridge | Table formatting (if needed) |
| `container/agent-runner/src/poll-loop.ts` | Agent run loop | Progress status writes |
| `container/agent-runner/src/providers/claude.ts` | Claude SDK wrapper | Model drift detection |
| `container/agent-runner/src/mcp-tools/` | Agent MCP tools | New tools (tone, effort) |
| `container/agent-runner/src/formatter.ts` | Message formatting for agent | Memory injection |
| `src/db/migrations/` | DB schema changes | Memories table |
| `src/log.ts` | Host logging | Secret scrubbing |
| `groups/{folder}/container.json` | Per-group container config | Packages, MCP servers |
| `container/Dockerfile` | Base container image | Common tooling (option B/C) |

### Architecture Quick Reference

```
Inbound:  Channel → adapter → routeInbound() → inbound.db → wakeContainer()
Agent:    poll-loop polls inbound.db → provider.query() → writes messages_out to outbound.db
Outbound: pollActive() polls outbound.db → deliverSessionMessages() → adapter.deliver()
Sweep:    host-sweep (60s) → sync acks, wake for due messages, detect stale, handle recurrence
```

### v1 Feature → v2 Equivalent

| v1 Feature | v2 Equivalent | Notes |
|-----------|---------------|-------|
| IPC file watcher | DB polling (inbound.db/outbound.db) | — |
| Group queue | Per-session containers | No queue needed |
| Channel skill branches | Chat SDK bridge + v2 skills | — |
| stdin/stdout markers | DB-based IO | — |
| Entrypoint.sh creds | OneCLI gateway | — |
| Session commands (/kill) | Container restart = fresh poll-loop | — |
| Per-channel formatting | `transformOutboundText` hook | Verify quality |
| Task scheduler | Host sweep + scheduling MCP tools | — |
| Watchdog | Host sweep stale detection + heartbeat | More robust |
| Auto-compact | ClaudeProvider auto-compact window | Likely sufficient |
| Gate protocol | pending_approvals + Claude Code permissions | Narrower gap than v1 |
