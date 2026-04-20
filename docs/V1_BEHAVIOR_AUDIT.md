# V1 Behavior Audit

Gap table against v1 parity. See [V1_BEHAVIOR_AUDIT_PLAN.md](V1_BEHAVIOR_AUDIT_PLAN.md) for methodology.

Per-category detail (full behavior tables, every row with v1 file:line anchor):

- [Cat 1 — Host-side lifecycle + recovery + signals](V1_BEHAVIOR_AUDIT_cat1.md)
- [Cat 2 — Container-side behaviors](V1_BEHAVIOR_AUDIT_cat2.md)
- [Cat 3 — Cross-cutting invariants](V1_BEHAVIOR_AUDIT_cat3.md)
- [Cat 4 — Re-validate prior audits](V1_BEHAVIOR_AUDIT_cat4.md)
- [Cat 5 — Git log cluster scan](V1_BEHAVIOR_AUDIT_cat5.md)
- [Cat 6 — Transcript self-check](V1_BEHAVIOR_AUDIT_cat6.md)

## Executive summary

- v1 host code: ~15k lines read end-to-end across 14 files. v1 container: 2478-line index.ts + 1867-line ipc-mcp-stdio.ts read in full.
- 435 v1 safety/fix commits harvested; ~60 spot-checked across 9 load-bearing clusters.
- ~150 project transcripts scanned, 24 capability claims verified against v2 code.
- Full behavior coverage: **6 cross-cutting invariants + ~30 host-side behaviors + ~40 container-side behaviors + ~50 prior-audit sub-items + 60 spot-checked safety commits + 24 transcript claims.**

### Findings counts

| Severity | Count | Character |
|---|---|---|
| CRITICAL | 2 (1 fixed, 1 live) | User-visible data/work loss OR secrets exposure |
| HIGH | ~30 | Silent reliability/correctness/security regressions |
| MEDIUM | ~35 | Edge-case or rare-path regressions, feature-scope omissions |
| LOW | ~20 | Cosmetic / deliberate deviations |
| N/A | ~30 | Architectural replacement makes v1 behavior unreachable in v2 |

### Two meta-findings that collapse multiple gaps

1. **Plugin hooks are dead code in v2** (confirmed 2026-04-20 by team-lead grep). v2 mounts `/workspace/plugins/*` and sets `CLAUDE_PLUGINS_ROOT`, but `container/agent-runner/src/providers/claude.ts` never passes a `plugins:` option to `sdkQuery`. v1 explicitly enumerated plugins and passed them in (`container/agent-runner/src/index.ts:189`). Result: every plugin-declared `hooks.json` in v2 (built-in `nanoclaw-plugin/hooks/{repo-readiness-guard,post-commit-verify}` AND every host-mounted plugin's hooks) is **registered but never fired**. This is a single root cause behind a significant fraction of the HIGH-severity plugin-related misses.

2. **Bash hook chain missing entirely.** Independent of (1): v1's `providers/claude.ts` equivalent registered an inline `PreToolUse: Bash` hook chain (sanitize secrets, block snowflake-connector, block git-clone, self-approval block, email gate). v2 only registers `PreCompact`. This is CRITICAL for the secret-sanitization piece alone (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `GMAIL_OAUTH_PATH` visible to every Bash subprocess) and HIGH for the four defense-in-depth blocks.

Both fixes are localized in `container/agent-runner/src/providers/claude.ts`.

## CRITICAL and HIGH findings (consolidated)

Sorted by severity, then by category. Each row anchors to the v1 source, the v2 surface (or gap), and the detail doc that carries the full analysis. "Port plan" is directional — actual scoping happens in a follow-up after Dave reviews.

| # | v1 source | Behavior | v2 status | Severity | Cat | Port plan |
|---|---|---|---|---|---|---|
| 1 | `src/container-runner.ts:1143` `cleanupThreadWorkspace` | Auto-commit dirty worktrees at turn end | **FIXED** in `eb90165` — `container/agent-runner/src/worktree-autosave.ts` wired into poll-loop post-query + claude PreCompact | CRITICAL | 1 | Done |
| 2 | `container/agent-runner/src/index.ts:480-497` `createSanitizeBashHook` | Strip `ANTHROPIC_API_KEY*`, `CLAUDE_CODE_OAUTH_TOKEN`, `GMAIL_*_PATH` before every Bash command | **MISSING** — v2 registers only PreCompact in `providers/claude.ts:295`. Every Bash can `printenv` live secrets | **CRITICAL** | 2 | Re-register inline `PreToolUse: Bash` hook in providers/claude.ts. Single file, ~20 lines. Does NOT depend on plugin-wiring fix. |
| 3 | `container/agent-runner/src/index.ts:2039` SDK_ENV_DENYLIST | Strip GRANOLA_ACCESS_TOKEN, EXA_API_KEY, BRAINTRUST_API_KEY from sdkEnv before passing to SDK | **REGRESSED** — v2 passes process.env as-is; HTTP-header-only secrets leak into Bash env | HIGH | 2 | 3-line denylist in providers/claude.ts when building sdkQuery env. |
| 4 | `container/agent-runner/src/index.ts:1286-1357` `discoverPlugins` + passing `plugins:` to sdkQuery | Auto-load host-mounted plugins and register their hooks | **DEAD CODE in v2** — plugins mounted + `CLAUDE_PLUGINS_ROOT` set but `plugins:` never passed. `nanoclaw-plugin/hooks/hooks.json` and every external plugin's hooks are unwired | HIGH (root cause of several dependents) | 2 | Port discoverPlugins + pass `plugins: [{type:'local', path:...}]` array into sdkQuery options. |
| 5 | `container/agent-runner/src/index.ts:506-545` Block snowflake.connector + block-git-clone PreToolUse Bash hooks | Deny `python -c 'import snowflake.connector'`; deny non-/tmp `git clone` | MISSING — no Bash hooks in v2 | HIGH | 2 | Re-port inline once hook chain (#2) is registered. |
| 6 | `container/agent-runner/src/index.ts:568-659` createEmailGateHook | PreToolUse Bash intercepts `gws gmail +send/reply/forward`, IPC request_gate with 30min timeout, scheduled-task bypass, --dry-run bypass | MISSING — v2 `ask_user_question` is agent-chosen, not auto-intercepted; 5-min not 30-min TTL | HIGH | 2 | Port as PreToolUse hook that routes through `requestApproval`; detect `msg.kind==='task'` for scheduled bypass. |
| 7 | `container/agent-runner/src/index.ts:139-147, 574-581, 1511-1582` model/effort switch machinery | Per-message `-m`, `-e`, subagent model inheritance via `CLAUDE_CODE_SUBAGENT_MODEL`, `pendingEffortAck` flow | **MISSING entirely** in v2 | HIGH (design decision) | 2 | Confirm with Dave whether `-m[1m]` / `-e` usage was intentional drop. If retained: port to provider.query options + subagent env injection. |
| 8 | `container/agent-runner/src/index.ts:2123-2174` system-prompt assembly | Global CLAUDE.md + channel formatting + identity + tone + capability manifest + workspace persistence + file-delivery + meta-response prohibition | **PARTIAL** — v2 has destinations-only. Identity, channel formatting, and meta-response prohibition are missing load-bearing pieces | HIGH | 2 | Port missing pieces into `systemContext.instructions` in providers/claude.ts. Meta-response prohibition in particular avoids the "No response requested." failure mode. |
| 9 | `src/index.ts:2997-3059` `shutdown(signal)` + `src/group-queue.ts:728-782` | Synchronously stop active containers so systemd cgroup empties before parent exits | **MISSING** — v2 `src/index.ts:226-242` teardown only. Will cause TimeoutStopSec stall on every restart | HIGH | 1 | Add `stopAllContainers()` and await before `process.exit`. `stopContainer` is already imported in container-runner.ts. |
| 10 | `src/index.ts:2132-2199` prompt_too_long auto-recovery | Detect `errorType==='prompt_too_long'`, delete session, prepend summary, retry once | **MISSING** | HIGH | 1, 3 | Detect prompt-too-long error class, clear stored session id, re-enqueue message with summary marker. Pairs with #11. |
| 11 | `container/agent-runner/src/providers/claude.ts:250` STALE_SESSION_RE | Auto-clear on "no conversation found | ENOENT .jsonl | session not found" | PARTIAL — regex does NOT match prompt-too-long; long-lived sessions past ctx window fail silently | HIGH | 3 | Extend regex or add separate prompt-too-long detector. |
| 12 | `src/container-runner.ts:readSecrets` + scoped env resolution | Omni, Railway, Browser-auth env var forwarding scoped per agent-group | **MISSING** from `SCOPED_CREDENTIAL_VARS` (container-runner.ts:221). Tools installable via skill will fail at first call | HIGH | 3, 4 | Add OMNI_BASE_URL/API_KEY, RAILWAY_API_TOKEN, BROWSER_AUTH_URL/EMAIL/PASSWORD, DBT_CLOUD_EMAIL/PASSWORD/API_URL to the scoped list. |
| 13 | v1 container-runner `groupMemoryDir` bind over `.claude/projects/.../memory` | Cross-thread auto-memory overlay within an agent group | **PRESENT (verified 2026-04-20)** — `container-runner.ts:360` mounts `data/v2-sessions/<agent_group_id>/.claude-shared` at `/home/node/.claude` as a **per-agent-group** (not per-session) mount. All sessions in an agent group share the host path. cwd is `/workspace/agent` on every spawn; SDK's cwd→projects-dir transform is deterministic → same `MEMORY.md` file. v1's separate nested overlay is unnecessary in v2 because the parent mount already provides the invariant. | — | 4 | Closed. |
| 14 | `src/container-runner.ts:2280` Snowflake staging dir | Rewrite `connections.toml` host-home paths to `/home/node/.snowflake/`; stage filtered keys | **REGRESSED** — v2 mounts `~/.snowflake` RO direct; absolute key paths in the toml don't resolve in-container. **`snow sql` and Snowflake MCP likely broken today** | HIGH | 4 | Stage connections.toml with rewritten paths + copy only referenced keys. |
| 15 | `src/container-runner.ts:2440` `ATTACHMENTS_DIR` mount | RO mount of inbound attachments dir | **MISSING** — no equivalent mount in v2. If attachments aren't inlined into messages_in content, agents can't read inbound files | HIGH | 4 | Confirm v2 attachment delivery model. If path-based, add the mount. If inlined, mark N/A. |
| 16 | `v1/container/entrypoint.sh:30-48` `GITHUB_ALLOWED_ORGS` URL-scoped credential helper | Only allowed orgs can clone/push with GITHUB_TOKEN | **REGRESSED (security)** — v2 `gh auth setup-git` unconditional. Any container with GH_TOKEN can push to any org the token grants | HIGH | 4 | Restore URL-scoped helper in entrypoint.sh. |
| 17 | v1 settings-env `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-7` | Lock opus alias to 4.7 so SDK-lag can't silently drop to 4.6 | **MISSING** from v2 container-runner env | HIGH | 4 | One-line env add in container-runner.ts. |
| 18 | `container/agent-runner/src/ipc-mcp-stdio.ts:110-219` `send_file` | Path allowlist (/tmp, /workspace/group, /workspace/project, /workspace/extra, /workspace/worktrees), SHA-256 dedup, 50MB cap, query-response with 30s host ack (upload error returns to agent) | **REGRESSED to fire-and-forget** — v2 `mcp-tools/core.ts:134-178` returns success immediately. Matches the pre-fix state v1 commit `8df09eb` explicitly corrected. Slack missing_scope / size errors invisible to agent | HIGH | 2, 5 | Add host-side ack path via inbound.db or equivalent; re-instate allowlist + dedup + size cap. |
| 19 | v1 `src/index.ts:743-758 + 2797-2873` `recoverPendingMessages` + "service restarted, resend" notice | User-visible DM on startup for in-flight threads | **PARTIAL** — v2 retries on wake; for `markMessageFailed` after MAX_TRIES no DM is sent | HIGH | 1 | Add startup pass: for sessions whose last inbound has no matching outbound AND last attempt exceeded MAX_TRIES, deliver a restart notice. |
| 20 | v1 `src/channels/slack.ts` native adapter — reply-context extraction on inbound | Agent sees "replying to <msg>" context in Slack | **NOT A GAP (verified 2026-04-20)** — grepped v1 `src/channels/slack.ts` for `replyTo`/`referenced_message`/`quoted`/`parent_message`: no reply-context extraction exists in v1 either. Slack has no native `referenced_message` field (Discord-specific); v1 only tracked `thread_ts` for thread-membership routing, same as v2. Audit claim "v1 Slack supported reply quoting" was incorrect. | — | 4 | Closed. |
| 21 | v1 Phase 2.9 chat-sdk outbound archive filter | Every outbound message archived | **NOT A GAP (verified 2026-04-20)** — agent-runner writes every outbound user-facing message with `kind: 'chat'` (mcp-tools/core.ts L145/223/290/331). The `chat-sdk` kind exists only on INBOUND (chat-sdk-bridge.ts:149 when serializing inbound events). delivery.ts:451's `if (msg.kind === 'chat')` filter therefore archives agent replies on every channel, Slack/Discord included. | — | 4 | Closed. |
| 22 | `src/container-runner.ts:1882-1899` + `container/agent-runner/src/index.ts:2108-2118` workflow-plugin safety notice + plugin discovery | Warn user when safety-critical plugin fails to load | **MISSING** — follows from #4 (plugins unwired) | HIGH (contingent on #4) | 2, 4 | Port alongside #4. |
| 23 | v1 source-mount allowlist `scripts/` / `prompts/` exclusion | Agent cannot read credential-path topology from project source tree | **UNCONFIRMED** in v2 — needs spot-check of `buildMounts` allowlist | HIGH (security, if ungated) | 5 | Inspect v2 `container-runner.ts` mount allowlist; confirm `scripts/`, `prompts/` excluded. |
| 24 | v1 `create_worktree` — fetch origin before add, prune-on-"already exists" retry | Avoid branching off stale state; recover from stale worktree metadata | **NEEDS VERIFY** in v2 `mcp-tools/git-worktrees.ts` | HIGH | 5 | Inspect v2 implementation; add fetch + prune-retry if absent. |
| 25 | v1 global CLAUDE.md reach via `.claude-global.md` in-tree symlink (commit `871bfa1`) | Claude Code @-import only follows paths inside project memory tree; absolute path to /workspace/global was silently dropped | **NEEDS VERIFY** that v2 global CLAUDE.md actually reaches the agent's context | HIGH | 5 | Verify in v2: explicit system prompt injection vs symlink vs @-import. |
| 26 | v1 `a9314b5` model drift detection | When `[1m]` suffix silently dropped mid-session, force `setModel('sonnet[1m]')` | **NOT A GAP (verified 2026-04-20)** — v1's concern was persistent drift across a long-running piped query. v2 runs one fresh `sdkQuery` per turn; `options.model` is re-passed every time. SDK drift within one turn self-corrects on the next. Architectural replacement. | — | 5 | Closed. |
| 27 | v1 `276bad3` `/compact` model re-assert | Re-invoke setModel after /compact session reset | **NOT A GAP (verified 2026-04-20)** — same reasoning as #26: each v2 turn is a fresh `sdkQuery` call with `options.model` re-passed. `/compact` is an in-turn SDK passthrough command; it doesn't span turns, so model state from before /compact doesn't need to be restored after — the next turn passes it from scratch. | — | 5 | Closed. |
| 28 | v1 `e0c4249` watchdog heartbeat during SDK progress events | Keep container watchdog alive during long-tool-use silence | **NEEDS VERIFY** v2 heartbeat touch semantics in poll-loop.ts during SDK progress | HIGH | 5 | Inspect poll-loop.ts event handler for `/workspace/.heartbeat` touch on progress events. |
| 29 | v1 `c05d886` session dir UID pre-create | Ensure `.claude/projects/` overlay is owned by container UID so SDK transcript writes don't ENOENT | **NEEDS VERIFY** v2 session-dir ownership matches container UID (should be 1001 after Dockerfile usermod bake) | HIGH | 5 | Spot-check a live session-dir ownership vs container UID after a session start. |
| 30 | v1 `d4aacfe` `agent-runner-src` pre-copy clear | Delete dest dir before cpSync so stale renamed/deleted files don't persist | **NEEDS VERIFY** v2 `group-init.ts:172-182` | HIGH | 5 | Inspect; add `rmSync` before `cpSync` if missing. |
| 31 | v1 `5008a00` typing stop on first output | setTyping(false) when first outbound emitted, not container exit | **NEEDS VERIFY** v2 `src/modules/typing/` | HIGH | 5 | Inspect typing module. |
| 32 | v1 `7a9dcab` `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80` | Prevent SDK default 97% threshold causing context rot | **PRESENT** at container-runner.ts:498 | HIGH → downgrade to PRESENT | 5 | Done. |
| 33 | v1 `b38a045` gate timeouts (container 30min, host 60min) | Avoid silent 20-min approval expiry | **NEEDS VERIFY** v2 approval TTLs | HIGH | 5 | Inspect modules/approvals/ + container-runner approval env. |
| 34 | v1 `ff24bd9`/`4e6c12b` global CLAUDE.md credential-in-chat guardrail | Hard rule: agents don't ask users to paste API keys in chat | **MISSING** from v2 bootstrap template | HIGH | 5 | Add to `scripts/init-first-agent.ts` DEFAULT_WELCOME / global CLAUDE.md template. |
| 35 | v1 `send_file` source-group access gate (ipc.ts L2442) | Non-main groups can't send files to arbitrary destinations | **UNVERIFIED** in v2 delivery/destinations | HIGH (if ungated) | 4 | Spot-check destinations.ts gating before cutover. |

## MEDIUM findings (abbreviated)

~35 rows. Full detail lives in per-category files. Highlights by cluster:

- **Credentials/scoping** (Cat 4): dbt Cloud email/password login missing, Google Workspace OAuth client secrets, Gmail MCP primary-aliasing for scoped accounts, Calendar scoped-token filter, GWS scoped-cred filter, AWS scoped profiles, gcloud scoped keys, dbt scoped profiles (all REGRESSED to direct RO mount without filtering).
- **System env** (Cat 4): `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`, `ENABLE_TOOL_SEARCH` all MISSING.
- **Search fidelity** (Cat 4, Cat 3): Haiku semantic reranking of search_threads, raw-message fallback on FTS=0, thread-summary FTS5 index over LLM-written summaries (v2 indexes raw messages only).
- **Container behaviors** (Cat 2): PreCompact thread-scoped archive + summary.txt, pre-flight session-size compact, API-key fallback rotation (pending OneCLI coverage), tool allowlist regression (enumerating SDK built-ins by name — breaks on SDK upgrade), `/workspace/thread` additional-directory, buildMcpServers built-in registrations (gitnexus/exa/granola/braintrust/omni/ollama), IPC env exposure for plugin hooks.
- **MCP tools** (Cat 2, 4): `read_thread`, `read_thread_by_key`, `list_groups`, `render_diagram`, memory CRUD tools, ollama MCP bridge, set_group_* config mutations, `/kill` + `/restart` admin commands, ship-log / backlog / activity (feature-skill candidates).
- **Lifecycle** (Cat 1): session-dir GC cron, SENDER_ALLOWLIST_PATH dead-letter constant, `/compact` pre-compact-message sequencing.
- **Cross-cutting** (Cat 3): approval synthetic-message persistence to message-archive, ad-hoc gate API (requires registered handler).
- **Permalinks** (Cat 4): Slack enterprise URL shapes, Slack short-ts without thread_ts, Discord `@me` DM permalinks.
- **Setup** (Cat 5): first-wiring-only welcome check, content-hash dedup for send_file, `<thread-title>` tag stripping.

## N/A — architecturally unreachable in v2

These v1 behaviors do not need porting because v2's architecture makes them impossible or unnecessary:

- Cursor rollback on shutdown (v2 uses per-message `status`, not an in-memory cursor).
- In-memory `lastAgentTimestamp` recovery (same).
- Stranded pipe roll-back + `pipe_ack` protocol (v2 has no piping).
- Group-mutex deadlocks (v2 has one container per session).
- IPC `_close` sentinel (v2 ends turns via IDLE_END_MS).
- Thread auto-recovery contamination (per-session DBs eliminate the class).
- `clearAllProcessingFlags` startup sweep (v2 uses heartbeat-based stale detection).
- Scratch-dir deletion + merge-back to group folder (v2 worktrees are per-session persistent).
- `/tmp/input.json` secrets cleanup (v2 uses DB mounts + env, no stdin JSON).

## Items flagged UNVERIFIED requiring live test before cutover

Surface/code existence is confirmed; behavior is not:

1. Auto-memory cross-thread aggregation works with v2 session dir layout (#13).
2. Attachment access model — inlined vs mount (#15).
3. Per-group `settings.json` contents (effort, attribution, hooks, autoDreamEnabled).
4. Outbound `kind` for chat-sdk channels — do Slack/Discord replies get archived? (#21).
5. chat-sdk bridge delegation for attachments, `openDM`, typing, `syncConversations`.
6. `send_file` source-group gating (#35).
7. Task scheduler recurrence / cancellation parity.
8. Session-dir UID matches container UID end-to-end after Dockerfile usermod bake (#29).

These must be validated on a live session before cutover.

## Recommended port order (highest leverage first)

1. **#2 + #4 together** — Bash sanitize hook + plugin discovery. Single-file change (`providers/claude.ts`). Closes CRITICAL + unblocks dependents (#5, #6, #22, all plugin-declared hooks).
2. **#9** — synchronous container stop at shutdown. `stopContainer` already imported; ~10 lines.
3. **#3** — SDK_ENV_DENYLIST. 3 lines.
4. **#14** — Snowflake connections.toml rewriting. Currently broken end-to-end; likely blocks daily data work.
5. **#16** — `GITHUB_ALLOWED_ORGS` URL-scoped credential helper. Security regression.
6. **#12** — Omni/Railway/Browser-auth scoped env vars. First-call failure for those skills.
7. **#17** — Opus alias lock env var. One line.
8. **#8 + #34** — System-prompt meta-response prohibition + credential-in-chat guardrail. Behavior correctness + safety.
9. **#18** — `send_file` ack pattern. User-visible silent failures today.
10. **#13, #15, #23, #24, #25, #27, #28, #29, #30, #31, #33** — verify-then-fix batch. All "needs live test or code inspection"; quick to resolve once looked at.

Followed by MEDIUM triage after Dave prioritizes.

## What this audit is NOT (repeated from plan)

Not a feature wishlist, not a re-architecture proposal, not a test-coverage audit, not a security review (though several of the HIGH findings are security-adjacent — GITHUB_ALLOWED_ORGS, Bash env secret visibility, source-mount allowlist, send_file gating). A proper security review is a distinct follow-up exercise once the HIGH findings are triaged.
