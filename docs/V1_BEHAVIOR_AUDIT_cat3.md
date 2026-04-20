# Category 3 — Cross-cutting invariants

End-to-end trace (host ↔ container) for each invariant. Each section confirms both halves exist and that they connect into a working round-trip, not just that endpoints are present.

---

## Invariant 1: Auto-commit on turn end

**What it guarantees:** after every agent turn (success OR failure) the filesystem state of any dirty git worktree is pinned to git, so the work survives (a) a later auto-compaction that drops the edit from the agent's context, (b) a mid-turn watchdog/SIGTERM kill, (c) a resume where the agent re-reads the repo and would otherwise see a clean tree and redo/undo work.

### v1 trigger points

- `src/index.ts:2087-2093` — after every `runContainerAgent` return inside `runAgent()`. Fires for success-path and error-path alike (the `output.status === 'error'` branching happens *after* cleanup is scheduled).
- `src/container-runner.ts:1143-1210` — `cleanupThreadWorkspace`: the actual `git add -A && git commit -m "auto-save: session exit"` body. Acquires `withGroupMutex` internally so concurrent create_worktree/prepareThreadWorkspace can't race.
- `src/worktree-cleanup.ts` — 6-hour orphan scan. This is *cleanup* (removes merged/abandoned worktrees), not auto-commit — dirty worktrees are explicitly **skipped** (line 120-126). So orphan cleanup is not a commit trigger; it just reclaims space.

v1 fires auto-commit only on the per-turn exit path. It does NOT fire from shutdown (SIGTERM/SIGINT): the shutdown handler at `src/index.ts:2997-3059` rolls cursors back and calls `queue.shutdown(10000)` but does not walk worktrees to commit them. Any turn in-flight at shutdown gets cleanup fired when its `runAgent` returns (since cleanup is scheduled inside `runAgent` after `runContainerAgent` returns). A hard SIGKILL mid-turn leaves the scratch dir uncommitted — that's the pre-fix state the commit message "auto-save: session exit" was guarding against, but v1 itself still has that gap.

v1 does NOT fire auto-commit from the container's PreCompact hook. v1's PreCompact (`container/agent-runner/src/index.ts:384`) only archives the transcript and writes `summary.txt` — no git commit. So in v1 a compaction mid-turn could still lose edits that were made after the last turn-end commit and before the compaction.

### v2 trigger points

- `container/agent-runner/src/poll-loop.ts:230` — `autoCommitDirtyWorktrees('turn end')` fires at the end of every poll-loop iteration after the query completes. Runs for both success (result was written) and failure (error was written to outbound) paths — it sits *after* the `try/catch` around `processQuery`, before `markCompleted`. Mirrors v1's turn-end trigger.
- `container/agent-runner/src/providers/claude.ts:189` — `autoCommitDirtyWorktrees('pre-compact')` fires inside the Claude provider's PreCompact hook, before the transcript-archive body. **This is a v1 improvement, not parity** — v1 did not commit on PreCompact.
- `container/agent-runner/src/worktree-autosave.ts` — the body. Same `git add -A && git -c user.email=… commit --no-verify -m "auto-save: <reason>"` primitive as v1. Scope is `/workspace/worktrees/*` (per-session worktrees), explicitly skipping `/workspace/agent/*` (canonical group workspace), which is an intentional narrowing from v1's behavior of also auto-committing standalone repos found under the scratch tree.

### Gap

v2 runs the auto-commit **inside the container** on every turn end and on PreCompact. v1 ran it **on the host** after `runContainerAgent` returned. For the turn-end trigger this is functionally equivalent — both fire after the query completes, before the next one starts. Three concrete delta points:

1. **Container-kill path (watchdog / SIGKILL):** v1 still ran cleanup because the host fires it after `runContainerAgent` returns, including error returns. v2's autosave runs inside the container poll loop — if the container is killed mid-query, v2 does **not** fire the turn-end autosave. Severity: **MEDIUM**. Mitigated by v2's PreCompact-time autosave (which v1 didn't have) and by per-session resumable worktrees (v1 scratch dirs got deleted on cleanup; v2 worktrees stay, so a kill doesn't race with a delete).
2. **Canonical `/workspace/agent/*` repo:** v1's scratch-dir walk picked up standalone repos in `data/worktrees/<group>/<thread>/`; v2 intentionally skips the canonical group workspace. Documented behavior change with reason (per-session isolation vs v1's per-thread scratch), not a regression.
3. **PreCompact autosave:** v2 has it, v1 did not. Strict improvement.

**Severity: LOW**. Turn-end parity is achieved; the host-vs-container placement difference only matters for container-kill-mid-turn (which v2 handles better via PreCompact) and is documented in the code comments at `worktree-autosave.ts:1-29`.

---

## Invariant 2: Credential injection

**What it guarantees:** the container has the API keys / tokens / credentials it needs to call external services, scoped per-agent-group where the service doesn't fit the OneCLI proxy model.

### v1 surfaces

v1 uses a multi-layered model in `src/container-runner.ts`:

- **`readSecrets()` (2500-2780):** walks `.env` for each per-group scoped key (`GITHUB_TOKEN_<FOLDER>`, `DBT_CLOUD_API_KEY_<SCOPE>`, `RENDER_API_KEY_<SCOPE>`, `EXA_API_KEY`, `BRAINTRUST_API_KEY`, `RAILWAY_API_TOKEN`, `OMNI_API_KEY`, `BROWSER_AUTH_*_<SCOPE>`, Google Workspace `GOOGLE_OAUTH_CLIENT_*`, Snowflake, dbt, etc.), reads it, normalizes scoped → generic name via `normalizeScopedSecret`.
- **Tool-gated injection:** each secret is only pulled if `isToolEnabled(tools, 'github')` / `'render'` / etc. — the container.json `tools` array gates which env vars are injected.
- **Anthropic credential (2620-2635):** special-cased — API keys are NOT passed unless `ANTHROPIC_BASE_URL` is set (opt-in for non-Anthropic routing). Default path: OneCLI proxy injects at request time.
- **Credential directory mounts (elsewhere in `buildVolumeMounts`):** `~/.gmail-mcp`, `~/.config/gws`, `~/.aws`, `~/.snowflake`, `~/.dbt`, `~/.gcloud-keys`, `~/.google_workspace_mcp/credentials`, `~/.config/google-calendar-mcp`, and per-account `~/.gmail-mcp-<account>/`.

### v2 surfaces

`src/container-runner.ts`:

- **`SCOPED_CREDENTIAL_VARS` (221-238):** `RENDER_API_KEY`, `RENDER_WORKSPACE_ID`, `SNOWFLAKE_*` (6 vars), `DBT_CLOUD_ACCOUNT_ID`, `DBT_CLOUD_API_TOKEN`, `OPENAI_API_KEY`, `BRAINTRUST_API_KEY`, `EXA_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `RESIDENTIAL_PROXY_URL`. Resolved via `<NAME>_<FOLDER_UPPER>` → `<NAME>` at 519-523.
- **GitHub token (500-512):** per-agent-group, resolves from `container.json.githubTokenEnv` → `GITHUB_TOKEN_<FOLDER_UPPER>` → `GITHUB_TOKEN`. Passed as both `GH_TOKEN` and `GITHUB_TOKEN`. Documented reason: OneCLI proxy model doesn't fit git auth.
- **OneCLI (573-585):** `ensureAgent({ name, identifier })` then `applyContainerConfig(args, { agent: agentIdentifier })` — injects HTTPS_PROXY + CA certs. This is the selective-secret-assignment path Anthropic, OpenAI-HTTP, Braintrust-HTTP, etc. flow through.
- **Credential dir mounts (414-457):** `~/.config/gws/accounts`, `~/.gmail-mcp`, `~/.config/google-calendar-mcp`, `~/.google_workspace_mcp/credentials`, `~/.snowflake`, `~/.aws`, `~/.gcloud-keys`, `~/.dbt`, per-account `~/.gmail-mcp-*/`. All RO.

### Gap

v1 → v2 line-by-line check of v1's `envKeys` array:

| v1 env surface | v2 equivalent | Status |
|---|---|---|
| `GITHUB_TOKEN` (scoped) | Present at container-runner.ts:500-512 | ✅ |
| `DBT_CLOUD_EMAIL` / `_PASSWORD` / `_API_URL` / `_API_KEY` (scoped) | `DBT_CLOUD_ACCOUNT_ID`, `DBT_CLOUD_API_TOKEN` in SCOPED_CREDENTIAL_VARS | ⚠️ v2 has the Account-ID/API-Token pair; v1's Email/Password/API-URL login path is missing. dbt-cloud CLI login via email+password won't work in v2 |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` (gated on google-workspace tool) | Not in SCOPED_CREDENTIAL_VARS; relies on `~/.config/gws/accounts` mount | ⚠️ If an agent needs to re-run OAuth flow inside the container, the client secret isn't available. Mount-only works for post-auth token refresh |
| `EXA_API_KEY` | Present | ✅ |
| `OMNI_BASE_URL` / `OMNI_API_KEY` | Missing | ❌ Omni MCP server won't authenticate |
| `BRAINTRUST_API_KEY` | Present | ✅ |
| `RAILWAY_API_TOKEN` | Missing | ❌ Railway CLI won't authenticate |
| `RENDER_API_KEY` / `RENDER_WORKSPACE_ID` | Present | ✅ |
| `BROWSER_AUTH_URL` / `_EMAIL` / `_PASSWORD` (scoped) | Missing | ❌ Playwright browser-auth skill won't have credentials |
| `ANTHROPIC_BASE_URL` + rotating `ANTHROPIC_API_KEY_N` (opt-in fallback) | Not present | ❌ Non-Anthropic routing proxy (openlimits-style) not supported. Default OneCLI path works |
| Credential dir mounts (gws/.gmail-mcp/.aws/.snowflake/.dbt/.gcloud-keys/.google_workspace_mcp/.google-calendar-mcp + `.gmail-mcp-*`) | All present at 414-457 | ✅ |

**Severity split:**
- **HIGH:** Omni, Railway, Browser-auth missing — tools are installable via skill but the credentials they need aren't forwarded, so those skills will fail silently inside the container with "API key not found" / 401 at first call.
- **MEDIUM:** dbt Cloud email/password login path missing (Account-ID/API-Token still works if the user has one); Google Workspace OAuth client credentials missing (most users never re-run OAuth in-container).
- **LOW:** ANTHROPIC_BASE_URL opt-in fallback — only operators who set up a non-Anthropic routing proxy would notice.

This is consistent with the "infra gaps are feature gaps" correction in memory: the credential surface is the runtime's capability set, and v2's `SCOPED_CREDENTIAL_VARS` is narrower than v1's `envKeys` array by at least 5 tools.

---

## Invariant 3: Session resume semantics

**What it guarantees:** the agent's prior conversation context (Claude Code SDK transcript `.jsonl`) is resumed on the next container spawn for the same session, so continuing a conversation doesn't start from scratch.

### v1 flow

1. **Host stores session ID:** `src/index.ts:2036-2040` — `persistSession(newSessionId)` writes to both in-memory `sessions` Map and SQLite via `setSessionV2()`.
2. **Host reads on next turn:** `src/index.ts:2006` — `sessions.get(sessionKey)` with `sessionKey = buildSessionKey(group.folder, threadId)`.
3. **Host passes to container:** `runContainerAgent(group, { sessionId, ... })` at 2054-2058.
4. **Container receives:** `container/agent-runner/src/index.ts:2191` — `let sessionId = containerInput.sessionId`.
5. **Container honors via SDK:** `container/agent-runner/src/index.ts:181, 1516` — `resume: sessionId` in the SDK query options. Also `resumeSessionAt: resumeAt` for fork-at-UUID.
6. **Stale session recovery:** `src/index.ts:2209-2240` — detects SDK resume errors and retries fresh (clears sessionId) with a notice.
7. **Prompt-too-long recovery:** `src/index.ts:2133, 2147` — if the resumed context is too long, clear session and retry.

### v2 flow

1. **Container stores session ID:** `container/agent-runner/src/poll-loop.ts:199` — `setStoredSessionId(continuation)` writes to outbound.db `session_state` table via `db/session-state.ts`.
2. **Container reads on next spawn:** `container/agent-runner/src/poll-loop.ts:51` — `let continuation: string | undefined = getStoredSessionId()`.
3. **Container passes to provider:** `poll-loop.ts:187` — `{ prompt, continuation, cwd, systemContext }`.
4. **Provider honors:** `container/agent-runner/src/providers/claude.ts:286` — `resume: input.continuation` in sdkQuery options.
5. **Stale session recovery:** `poll-loop.ts:208-212` — `config.provider.isSessionInvalid(err)` (claude.ts:270-273 matches `/no conversation found|ENOENT.*\.jsonl|session.*not found/i`), clears continuation and storedSessionId on detection.

### Gap

v2's resume is **container-driven, not host-driven**. v1 had the host read/write the session ID and pass it down through the runContainerAgent args; v2 has the container read/write its own `session_state` table in outbound.db.

End-to-end parity is intact. Two deltas worth noting:

1. **Prompt-too-long retry:** v1 at `src/index.ts:2133` explicitly handles `output.errorType === 'prompt_too_long' && sessionId` by clearing and retrying. v2's retry path goes through `isSessionInvalid()`, whose regex (`STALE_SESSION_RE`) does NOT match prompt-too-long errors (which typically surface as `400 prompt is too long`). So a session that has grown past Claude's context window won't auto-clear in v2 — the agent will just fail on every turn until manually `/clear`'d. **Severity: MEDIUM**.
2. **`resumeSessionAt` (fork-at-UUID):** v1 tracked `lastAssistantUuid` and passed `resumeSessionAt` to fork the resume at a specific message (SDK feature for "edit last user message, retry from here"). v2's `QueryInput` has no `resumeAt` field — the provider only accepts `continuation`. **Severity: LOW** — this is primarily used by `/edit` style flows which v2 hasn't wired.

---

## Invariant 4: PreCompact flow

**What it guarantees:** when Claude Code is about to drop older transcript from context, both (a) the transcript is archived for later search/resume, and (b) any uncommitted worktree edits are pinned to git before the agent loses memory of having made them.

### v1 flow

- **Container hook:** `container/agent-runner/src/index.ts:191, 384-440` — `createPreCompactHook` archives transcript to `/workspace/group/conversations/<date>-<name>.md` and for thread sessions also to `/workspace/thread/conversations/…` plus writes `summary.txt`.
- **Host indexing (post-turn):** `src/index.ts:2095-2107` — after each runAgent, the host calls `indexSingleThread(group.folder, threadId)` if a `summary.txt` exists, or `indexThreadFromMessages(...)` as fallback. Uses FTS5 (see `src/thread-search.ts:249,299,304`).
- **Host startup indexing:** `src/index.ts:2982` — `indexThreadSummaries()` called at host start to backfill new summaries.
- **No git commit from PreCompact in v1.**

### v2 flow

- **Container hook:** `container/agent-runner/src/providers/claude.ts:177-235` — `createPreCompactHook`:
  1. Calls `autoCommitDirtyWorktrees('pre-compact')` first (line 189). **v1 didn't do this.**
  2. Archives transcript to `/workspace/agent/conversations/<date>-<name>.md`.
  3. Reads `sessions-index.json` for summary metadata.
- **Host indexing:** v2 has **no equivalent of `indexThreadSummaries`/`indexSingleThread`/`indexThreadFromMessages`**. Search happens through `message-archive.ts` (`upsertArchiveMessage` is called by `router.ts` inbound and `delivery.ts` outbound — so the searchable content is the message stream, not the compacted transcript summaries).

### Gap

Two differences:

1. **Git commit on PreCompact:** v2 has it; v1 didn't. **Strict improvement.**
2. **Transcript-summary FTS5 search:** v1 builds a separate FTS5 index over PreCompact-written transcript summaries; v2 indexes raw inbound/outbound messages via `message-archive.ts`. The search mechanics are different — v1 "which conversation was about topic X" finds it via the summary; v2 finds it via grep over messages_in/out archive. Functionally similar for the "find me a prior thread" use case, but:
   - v1's summaries were LLM-generated abstractions of the transcript (the agent's tool-use reasoning included), so searches match on synthesized topic words.
   - v2 only has the raw message text, so tool-use / internal reasoning that never made it into an outbound message is not searchable.

**Severity: MEDIUM** for the search-fidelity delta (previous phase audit classified `archive + thread search` as "ported" — it's not ported *identically*). **LOW** for the git-commit side.

---

## Invariant 5: Approval flow

**What it guarantees:** when the container needs admin approval for a credentialed or sensitive action, the host delivers a DM to an admin, waits for the response, and unblocks the container with the decision.

### v1 flow

1. **Container requests:** IPC `gate` handler at `src/ipc.ts:1780-1902`. Request includes `requestId`, `chatJid`, optional `threadId`, `label`, `summary`, optional `command`.
2. **Host resolves chat:** uses `gateChatJid` (the main group) or `data.chatJid`. No user-role-based approver picking — v1's gate model is "ask the main group channel".
3. **Host delivers:** `deps.sendInteractiveGate(...)` if the channel supports button UI, else falls back to `deps.sendMessage(...)` with plain-text "reply `approve` or `cancel`" instructions.
4. **Host persists gate in memory:** `pendingGates.set(gateId, ...)` at line 1802.
5. **Host persists synthetic message:** `storeMessage({ id: gateId, ... sender: 'bot', ... })` so thread history reflects the gate.
6. **User responds:** plain-text `approve`/`cancel` or interactive button. The message router (`src/router.ts` or similar) or interactive handler resolves the pending gate and writes IPC response via `writeQueryResponse(ipcBaseDir, sourceGroup, requestId, { ... })`.
7. **Container unblocks:** the plugin hook polls the response file until the decision is written.
8. **Auto-cancel fallback:** any non-approve/cancel reply auto-cancels the gate.

### v2 flow

1. **Module-initiated:** `src/modules/approvals/primitive.ts:164` `requestApproval({ session, agentName, action, payload, title, question })`. Called by self-mod, install_packages, etc. — a registered module action.
2. **Approver picking:** `pickApprover(session.agent_group_id)` at line 76-93 — walks `user_roles` for scoped-admin → global-admin → owner. This is **more granular than v1** (v1 just posted to the main group chat).
3. **Delivery target resolution:** `pickApprovalDelivery(approvers, originChannelType)` at 103-119 — prefers same-channel-type match, then first reachable DM. Uses `ensureUserDm` from the permissions module.
4. **Persist pending row:** `createPendingApproval({ approval_id, session_id, request_id, action, payload, ... })` at line 185 — written to central `pending_approvals` table.
5. **Deliver card:** `adapter.deliver(..., 'chat-sdk', JSON.stringify({ type: 'ask_question', questionId, title, question, options }))` at line 199 — uses the chat-sdk ask_question message kind.
6. **Admin responds:** admin's reply-button/plain-text gets routed through `src/router.ts` → response registry. `src/modules/approvals/response-handler.ts:handleApprovalsResponse` claims it via `registerResponseHandler`.
7. **Dispatch:** OneCLI approvals resolve via in-memory Promise (resolveOneCLIApproval); module approvals look up `getApprovalHandler(action)` at line 81, call it with context `{ session, payload, userId, notify }`. Rejection notifies via `notify(...)` and wakes container.
8. **Unblock container:** `wakeContainer(session)` at line 89, 105 — container's next poll picks up the system message via `notifyAgent` which writes to session inbound.db and wakes.
9. **OneCLI credential approvals:** separate `ONECLI_ACTION` path, same plumbing, resolved via in-memory Promise from `startOneCLIApprovalHandler`.

### Gap

| v1 guarantee | v2 equivalent |
|---|---|
| Container → host request | `requestApproval` call in module (self-mod, install_packages, etc.) |
| Approver picking (main-group channel) | `pickApprover` — admin@group → global admin → owner (**more granular**) |
| Same-channel-type preference | `pickApprovalDelivery` with channel-type tie-break (**new in v2**) |
| Interactive UI fallback to text | `adapter.deliver('chat-sdk', ask_question ...)` — channel adapter handles interactive rendering (Slack Block Kit, Discord buttons, etc.) |
| Persist gate (in-memory + synthetic message) | `pending_approvals` row (DB-backed, **more durable**) + `notifyAgent` on resolve (no synthetic-message persistence to archive) |
| Auto-cancel on non-approve/cancel reply | v2 rejects on any non-'approve' option (strict match in `response-handler.ts:72`) |
| Unblock container via IPC response file | `wakeContainer(session)` + system chat in inbound.db |

v2's approval round-trip is **architecturally different but functionally equivalent or stronger**. Key concerns:

1. **Synthetic-message persistence to thread history:** v1 called `storeMessage` at `src/ipc.ts:1834-1843` so the gate prompt appeared in thread history. v2 does not persist the approval card to `message-archive`, so thread search / post-hoc review won't show that an approval was requested. **Severity: LOW-MEDIUM** depending on how much value Dave placed on gate audit trails in chat history.
2. **Request-API coupling:** v1's gate was a generic "ask any question", used for any destructive-command confirmation. v2's `requestApproval` is module-registered — callers must `registerApprovalHandler(action, handler)` at module import. Agents can't trigger an ad-hoc gate; it needs a module that wraps it. **Severity: LOW** (v2's self-mod module covers the real use cases) but it's an architectural narrowing vs. v1's more open primitive.
3. **Pending-approval durability:** v1 `pendingGates` was a process-local Map — host restart meant gate was lost, container hung until IPC response timeout. v2 `pending_approvals` is DB-backed — survives host restart. **Strict improvement.**

**Severity: LOW** overall. The primary gap is discoverability / audit-trail (synthetic message to archive), not the core flow.

---

## Summary

| # | Invariant | v1 trigger(s) | v2 trigger(s) | End-to-end parity | Severity |
|---|---|---|---|---|---|
| 1 | Auto-commit on turn end | `src/index.ts:2087` (host, post-runAgent); no PreCompact commit | `container/agent-runner/src/poll-loop.ts:230` (turn end); `providers/claude.ts:189` (PreCompact) | Yes + PreCompact commit improvement. Container-kill-mid-turn edge case slightly different (now mitigated by PreCompact) | LOW |
| 2 | Credential injection | `src/container-runner.ts:2500-2780` (readSecrets, tool-gated) + mount dirs | `src/container-runner.ts:221` (SCOPED_CREDENTIAL_VARS) + mount dirs + OneCLI | Partial. Omni, Railway, Browser-auth, dbt Cloud email/password login, ANTHROPIC_BASE_URL fallback missing | HIGH (Omni/Railway/Browser-auth), MEDIUM (dbt Cloud login), LOW (ANTHROPIC_BASE_URL) |
| 3 | Session resume | `src/index.ts:2006,2036,2058`; `container/agent-runner/src/index.ts:181,1516` | `container/agent-runner/src/poll-loop.ts:51,199`; `providers/claude.ts:286` | Yes for baseline resume. `prompt_too_long` auto-recovery and `resumeSessionAt` fork-at-UUID missing | MEDIUM (prompt_too_long), LOW (resumeSessionAt) |
| 4 | PreCompact flow | Container: `container/agent-runner/src/index.ts:384` (archive + summary.txt). Host: `src/index.ts:2095-2107`, `src/thread-search.ts:249,299,304` (FTS5 index over summaries) | Container: `container/agent-runner/src/providers/claude.ts:177-235` (commit + archive). Host: `src/message-archive.ts` (indexes raw messages via router/delivery) | Partial. Git-commit-on-PreCompact is a v2 improvement. Transcript-summary FTS5 search semantics replaced by message-archive — different fidelity | MEDIUM (search fidelity), LOW (commit-side) |
| 5 | Approval flow | `src/ipc.ts:1780-1902` (gate IPC → `pendingGates` Map → send interactive/text → IPC response file); no role-based picking | `src/modules/approvals/{primitive,response-handler,onecli-approvals,index}.ts`; DB-backed `pending_approvals`; `pickApprover`/`pickApprovalDelivery`; `adapter.deliver('chat-sdk', ...)` | Yes + improvements (role-based, DB durability, same-channel-type preference). Synthetic-message-to-archive persistence lost; ad-hoc gate API removed (must register action handler) | LOW-MEDIUM |

**Highest-priority findings for follow-up port work:**

1. **Credential env gaps (Invariant 2, HIGH):** Omni, Railway, Browser-auth. These are capabilities the container is expected to have (skills install the CLIs) but whose secrets aren't forwarded. First-call failure mode.
2. **Prompt-too-long auto-recovery (Invariant 3, MEDIUM):** v2's `isSessionInvalid` regex misses the prompt-too-long case that v1 handled explicitly. Silent break of resume for long-lived sessions.
3. **Transcript-summary FTS5 index (Invariant 4, MEDIUM):** previously classified as "ported" — the write path went to a different archive surface. Impacts thread-search fidelity over long time windows.
