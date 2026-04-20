# remote-control: v1 vs v2

## Scope

**v1:**
- `/Users/gavriel/nanoclaw4/src/v1/remote-control.ts` (218 lines)
- `/Users/gavriel/nanoclaw4/src/v1/remote-control.test.ts` (379 lines)
- Integrated into v1 host via `restoreRemoteControl()` call at startup (v1/index.ts:42)

**v2 Counterparts:**
- `/Users/gavriel/nanoclaw4/src/access.ts` (115 lines) — privilege/approval routing
- `/Users/gavriel/nanoclaw4/src/onecli-approvals.ts` (269 lines) — OneCLI credential-gated action approval
- `/Users/gavriel/nanoclaw4/src/webhook-server.ts` (134 lines) — HTTP webhook ingress for Chat SDK adapters
- `/Users/gavriel/nanoclaw4/src/router.ts` (start of file) — inbound message routing with access gates

## Capability Map

| v1 Behavior | v2 Location | Status | Notes |
|---|---|---|---|
| Start `claude remote-control` child process, extract URL | **Removed** | ❌ Removed | v2 has no equivalent. The `claude remote-control` CLI was a v1-only mechanism tied to individual Telegram chats. |
| Session state persistence (PID, URL, metadata) | **Removed** | ❌ Removed | v2 is stateless at the host level — all per-session state lives in `inbound.db` / `outbound.db`. |
| Auto-accept "Enable Remote Control?" prompt via stdin | **Removed** | ❌ Removed | v1 quirk tied to Claude CLI's interactive mode; no equivalent in v2. |
| Restore session from disk on startup | **Removed** | ❌ Removed | v2 has no startup recovery loop for stale processes. Sessions are created on-demand. |
| Detect dead process by signal check | **Removed** | ❌ Removed | v2 uses per-session heartbeat file (`/workspace/.heartbeat`) and inactivity detection via 60s sweep. |
| HTTP URL polling + timeout handling | **Webhook server** | ✅ Moved | v2's `webhook-server.ts` (line 16–124) runs a persistent HTTP server (default port 3000) for Chat SDK adapter webhooks. Routes via `/webhook/{adapterName}` (not URL-in-stdout polling). |
| Single active session per host | **Per-agent-group sessions** | ✅ Evolved | v2 supports unlimited concurrent sessions. Each `(agent_group, messaging_group, thread)` tuple is a separate session with its own container. |
| `getActiveSession()` getter | **Removed** | ❌ Removed | No global session concept. v2 queries sessions via `getSession(sessionId)` in `db/sessions.ts`. |
| Credential access approval | **OneCLI approval handler** | ✅ Moved | v2's `onecli-approvals.ts` (line 92–215) handles credential-gated action approval. OneCLI gateway intercepts HTTP, delivers ask_question card to approver, persists `pending_approvals` row (line 173–196). |
| Approver selection (admin → owner chain) | **access.ts** | ✅ Moved | `pickApprover()` (access.ts:55–72) returns ordered list: agent-group admins → global admins → owners. Same preference order as v1 logic. |
| Approval delivery to DM (same channel kind preferred) | **access.ts + user-dm.ts** | ✅ Moved | `pickApprovalDelivery()` (access.ts:83–101) walks approver list, prefers same channel kind via `channelTypeOf()` (line 112–115), falls back to any reachable DM. Uses `ensureUserDm()` for cold-DM resolution (user-dm.ts). |
| Ask_question card delivery | **onecli-approvals.ts** | ✅ Moved | v2 builds ask_question card (onecli-approvals.ts:148–167) with Approve/Reject buttons, routes via `deliveryAdapter.deliver()` with action_id for button callbacks. |
| Button click → approval resolution | **onecli-approvals.ts** | ✅ Moved | `resolveOneCLIApproval()` (line 68–83) matches approval_id, resolves Promise, updates status to approved/rejected, deletes `pending_approvals` row. |
| Approval expiry + cleanup | **onecli-approvals.ts** | ✅ Moved | Expiry timer fires just before gateway's TTL (line 200–211); `expireApproval()` (line 217–226) edits card to "Expired (reason)" and deletes row. Startup sweep cleans stale rows (line 247–255). |
| Rate limiting | **Not implemented** | ❌ Missing | Neither v1 nor v2 has rate limiting on remote-control or approval requests. |
| Audit logging | **Partial** | ⚠️ Partial | v1: `logger.info()` on session start/stop. v2: `log.info()` on approval resolved (onecli-approvals.ts:81), stale sweeps (line 250), expiry (line 225). Payload stored in `pending_approvals.payload` for audit (line 178–186). |
| Error recovery (process death) | **Minimal** | ⚠️ Minimal | v1: restores from disk, kills stale PID. v2: no equivalent — dead container is detected by stale heartbeat, then respawned via `wakeContainer()`. |
| Transport | HTTP via stdout polling | HTTP via standard webhook server | v1 is ephemeral per session; v2 is persistent, multi-tenant. |
| Auth | None (CLI subprocess) | OneCLI gateway (credential-gated via HTTP) | v1 has no auth; v2 gates on agent identity + OneCLI decision. |

## Missing from v2

1. **CLI subprocess spawning** — v2 has no `claude remote-control` equivalent. Agents run in Docker containers, not standalone CLI processes. The OneCLI agent sandbox is managed by the agent-runner container, not the host.

2. **Process-level lifecycle management** — v1 tracks individual process PIDs and signal-kills them. v2 uses container IDs + heartbeat file, handled by host-sweep (host-sweep.ts) and container-runner.ts.

3. **Per-message URL polling with regex extraction** — v2's webhook server is push-based (HTTP handler), not pull-based polling of stdout files.

4. **Direct user-to-bot communication model** — v1's remote-control was tied to a single Telegram JID + chat. v2 decouples messaging groups from agent groups, allowing one agent to serve multiple channels with different isolation levels.

5. **State file on disk** (`remote-control.json`) — v2 stores all session state in SQLite central DB and per-session `inbound.db` / `outbound.db`.

## Behavioral Discrepancies

1. **Approval delivery model**: 
   - v1: Remote control was tied to a single message sender; approvals implicitly went to the initiator's contact or a hardcoded owner.
   - v2: Approvals route to admins of the originating agent group, with tie-break by channel kind (pickApprovalDelivery line 87–94). Multiple approvers can be reached, decoupling approval from message sender.

2. **Session multiplicity**:
   - v1: One active `RemoteControlSession` per host at a time.
   - v2: Unlimited concurrent sessions, each with independent state (`inbound.db`, `outbound.db`, heartbeat).

3. **Timeout & cleanup**:
   - v1: Explicit timeout on URL polling (30s), then kill process. No ongoing monitoring.
   - v2: Heartbeat-based inactivity detection (60s sweep), graceful cleanup on stale. Approval expiry tied to OneCLI gateway TTL, not a fixed timeout.

4. **Error transparency**:
   - v1: Polling errors logged to stdout/stderr files; user doesn't see unless they debug.
   - v2: All approval errors logged centrally; card is edited to "Expired" on failure, so approver sees state change.

## Worth Preserving?

**No — v2 supersedes v1's remote-control model.** 

v1's remote-control was a bridge between Telegram chats and a single Claude CLI session. v2 achieves equivalent (and superior) remote operation via:
- **OneCLI credential approvals** (onecli-approvals.ts): Admins approve API/credential requests from agents, just as v1 surfaced sensitive actions.
- **Approval routing** (access.ts): Automatically picks the right admin on the right channel, with fallback to any reachable DM.
- **Multi-tenant agent groups**: Agents can serve multiple channels with different approval chains, not just one chat JID.

Users still get on-demand approval for sensitive actions; they just don't manage a CLI subprocess anymore. The host handles container lifecycle, and the container agent is managed by OneCLI.

---

### Citation Summary

- v1 remote-control: `/Users/gavriel/nanoclaw4/src/v1/remote-control.ts:1–218`
- v1 tests: `/Users/gavriel/nanoclaw4/src/v1/remote-control.test.ts:1–379`
- v2 access control: `/Users/gavriel/nanoclaw4/src/access.ts:29–115` (pickApprover, pickApprovalDelivery, canAccessAgentGroup)
- v2 approval handler: `/Users/gavriel/nanoclaw4/src/onecli-approvals.ts:50–270` (handleRequest, resolveOneCLIApproval, sweepStaleApprovals)
- v2 webhook server: `/Users/gavriel/nanoclaw4/src/webhook-server.ts:73–124` (registerWebhookAdapter, ensureServer)
- v2 router: `/Users/gavriel/nanoclaw4/src/router.ts:19–50` (inbound access gate, unknown_sender_policy)
