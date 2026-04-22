# V1 Behavior Audit — Category 4: Re-validate Prior Audit Conclusions

Scope: sub-areas previously marked "ported" in prior v2 work. Each behavior is re-checked against v1 code, not against prior audit conclusions.

Status values: **PRESENT** / **PARTIAL** / **MISSING** / **REGRESSED** / **N/A (+ reason)** / **DIFFERENT-BY-DESIGN (+ reason)**.
Severity: **CRITICAL** / **HIGH** / **MEDIUM** / **LOW**.

Anchors:
- v1 = `/home/ubuntu/nanoclaw/`
- v2 = `/home/ubuntu/nanoclaw-v2/`

---

## 4.1 Phase 5.0 container surface (mounts / env / network / plugins)

v1 mount sites collected from `src/container-runner.ts` line-by-line (buildVolumeMounts ~L1444–2507) plus env args at L2789–2861. v2 equivalents in `src/container-runner.ts` `buildMounts()` (L256–465) and `buildContainerArgs()` (L467–624). v1 entrypoint at `container/entrypoint.sh` (142 lines); v2 at `container/entrypoint.sh` (120 lines).

### Mounts

| v1 source (container-runner.ts line) | Mount / capability | v2 status | Severity | Notes |
|---|---|---|---|---|
| L1462 `hostPath: projectRoot → /workspace/project` (main, RW) | Main group writable project root | **DIFFERENT-BY-DESIGN** | LOW | v2 has no "main" group concept; replaced by user-level roles. Project mounted RO via allowlist at v2 L372–394. |
| L1471 `/dev/null → /workspace/project/.env` (shadow) | Secret leak block for main project mount | **N/A (by arch)** | — | v2 mounts selective allowlist (no `.env` in set), so a shadow is unnecessary. Verify the allowlist stays tight. |
| L1482 `{projectRoot}/store → /workspace/project/store` (RW) | Main gets DB write access | **MISSING** | LOW | v2 has no v1-style "main" group. Central DB access in v2 is through MCP tools, not a direct mount. Intentional. |
| L1488 `effectiveGroupDir → /workspace/group` (RW) | Group folder mount | **PRESENT** (different path) | — | v2 mounts at `/workspace/agent` (L276). Path changed; behavior equivalent. Agent-runner paths were adjusted. |
| L1497 `groups/global → /workspace/global` (RW for main, RO otherwise) | Global shared dir | **PRESENT (RO only)** | LOW | v2 L280–283 always RO. v1's main-writable path is a v2 architectural removal. |
| L1519 project src allowlist (`src`, `container`, `docs`, `package.json`, …) → RO | Self-read project source | **PRESENT** | — | v2 L372–394 same allowlist + `scripts`. Missing v1 vs present v2: `scripts` ADDED in v2; all others match. |
| L1560 `/dev/null` shadow of sensitive files in group folder for non-threaded | Secret-leak block for non-threaded group mount | **MISSING** | MEDIUM | v2 mounts the group dir RW with no sensitive-file shadowing. If any `groups/<folder>/.env` or similar files land there, they're readable by the container. Review `isSensitiveTopLevelFilename` in v1 and decide whether to port. |
| L1577 `tone-profiles → /workspace/tone-profiles` RO | Tone profiles | **PRESENT** | — | v2 L399–406. |
| L1590 `{groupDir}/threads/{threadId} → /workspace/thread` RW | Per-thread scratch dir | **N/A (by arch)** | — | v2 uses per-session dir (one session = one thread) at `/workspace` directly; per-thread scratch is subsumed by the session dir mount (L273). |
| L1606 `WORKTREES_DIR/{group}/{threadId} → /workspace/worktrees` RW | Per-thread worktree root | **DIFFERENT-BY-DESIGN** | — | v2 creates worktrees inside the session dir (`/workspace/worktrees/<repo>`) via the `create_worktree` MCP tool. Same effective mount, different source path. |
| L1628 canonical repo `.git` mounted at host-absolute path RO (+ L1645 via findGitWorktrees) | `.git` pointer resolution for worktrees | **N/A (by arch)** | — | v2 runs worktree ops in-container where both canonical repo and worktree live in container-visible paths — pointer paths resolve naturally. Documented in PHASE_2_11. |
| L1888 `container/nanoclaw-plugin → /workspace/plugins/nanoclaw-hooks` RO | Built-in hooks plugin | **PRESENT** | — | v2 L316–323. |
| L1899 `~/plugins/<entry> → /workspace/plugins/<entry>` RO (+ excludePlugins) | External plugin repos | **PRESENT** | — | v2 L334–357. Parity with excludePlugins. |
| L1921 `~/.codex → /home/node/.codex` RW (when codex plugin present) | Codex CLI OAuth session | **PRESENT** | — | v2 L358–363. |
| L1930 `groupSessionsDir → /home/node/.claude` RW | Per-group Claude state (settings, skills, sessions) | **PRESENT** (path differs) | — | v2 L287–288 mounts `data/v2-sessions/<ag>/.claude-shared`. Behaviorally equivalent. |
| L1940 `groupMemoryDir → /home/node/.claude/projects/{PROJECTS_DIR}/memory` overlay | Shared auto-memory across threads in a group | **REGRESSED / UNVERIFIED** | HIGH | v2 has `.claude-shared` per-agent-group but does not do the nested memory overlay. If the Claude Code SDK's auto-memory write path depends on a cwd-derived projects subdir, v2 may create isolated memory per session that never aggregates to the group level. **Action:** verify whether `CLAUDE_CODE_PROJECTS_DIR`-style memory aggregation works with v2's mount layout, or port the overlay. Confirmed CRITICAL risk in v1 migration feedback (worktree-autosave miss was same class). |
| L1958 `~/.config/gws/accounts → /home/node/.config/gws/accounts` RO (gated by tools) | gws CLI consolidated creds | **PRESENT (ungated)** | LOW | v2 L417 mounts unconditionally (RO) when dir exists, no tool gating. Documented intentional change (L408–413 comment). |
| L1982 `~/.gmail-mcp-<account> → /home/node/.gmail-mcp` (primary) / multi-acct | Legacy Gmail MCP scoped mounts | **PARTIAL** | MEDIUM | v2 L419 mounts `~/.gmail-mcp` unconditionally + L443–456 scans and mounts every `~/.gmail-mcp-*` dir. v1's primary-aliasing ("mount first scoped account at /home/node/.gmail-mcp") is NOT replicated. Tools expecting the primary path for a scoped account will see v1's primary dir instead. |
| L2088 `~/.config/google-calendar-mcp → /home/node/.config/google-calendar-mcp` (RW + filtered tokens) | Google Calendar creds with scoped filtering | **PARTIAL** | MEDIUM | v2 L421 mounts RO unconditionally. v1 staged a filtered `tokens.json` when `calendar:scope` was used; v2 has no scoped filtering — containers see all accounts' tokens. |
| L2100 `~/.gmail-mcp/gcp-oauth.keys.json` file-mount when calendar active without gmail tool | OAuth keys back-channel for calendar | **UNKNOWN** | LOW | v2 mounts `.gmail-mcp` as a dir, so the keys file is present when `.gmail-mcp` exists. If it doesn't exist on the host, there's no fallback. Edge case. |
| L2152/L2166 `~/.google_workspace_mcp/credentials` (RW or RO + filtered) | GWS MCP creds with scoped filtering | **PARTIAL** | MEDIUM | v2 L425 mounts RO unconditionally. Same scoped-filtering regression as calendar. |
| L2280 `snowflake` staging dir → `/home/node/.snowflake` RW with rewritten paths + filtered keys | Snowflake scoped creds | **REGRESSED** | HIGH | v2 L428 mounts `~/.snowflake` RO directly — NO path rewriting, NO scoped filtering, NO key-file permission normalization. v1 rewrote `connections.toml` paths from host home to `/home/node/.snowflake/`. If the host's `connections.toml` contains absolute paths referencing `~/.snowflake/keys/…`, the container will see a path that doesn't resolve (the host home path). **This likely breaks `snow sql` and MCP snowflake tools.** Verify on a live spawn before cutover. |
| L2331 AWS staging dir with scoped-profile filtering → `/home/node/.aws` RO | AWS scoped creds | **REGRESSED** | MEDIUM | v2 L430 mounts `~/.aws` RO directly. No `[default] + [profile <scope>]` filtering. Containers see all profiles. |
| L2396 gcloud keys staging dir → `/home/node/.gcloud-keys` RO | Scoped gcloud key mounting | **REGRESSED** | MEDIUM | v2 L432 mounts `~/.gcloud-keys` RO directly. No scoping, no `GCLOUD_KEY_<SCOPE>` → selective-copy logic. |
| L2427 dbt profiles staging dir with scoped YAML filtering → `/home/node/.dbt` RO | Scoped dbt profiles | **REGRESSED** | MEDIUM | v2 L434 mounts `~/.dbt` RO directly. No scoped filtering. Credentials leak across groups. |
| L2440 `ATTACHMENTS_DIR/{group} → /workspace/attachments` RO | Attachment access | **MISSING** | HIGH | No v2 mount for attachments. Messages with inbound attachments (WhatsApp media, Slack uploaded files, etc.) — if v2 delivers attachment paths in message bodies, the container has no mount to read them. Need to confirm v2's attachment delivery model (may be inlined into messages_in content instead). |
| L2452 `groupIpcDir → /workspace/ipc` RW | IPC namespace for host-mediated tools | **N/A (by arch)** | — | v2 has no IPC surface — everything runs via MCP or the two-DB split. Intentional removal. |
| L2488 `agentRunnerBase → /app/src` RW | Per-group writable agent-runner source | **PRESENT** | — | v2 L301–302. |
| L2504 `additionalMounts` validated | Custom per-group mounts | **PRESENT** | — | v2 L304–308. |

### Env vars

| v1 env (container-runner.ts line) | Purpose | v2 status | Severity |
|---|---|---|---|
| L2799 `TZ=${TIMEZONE}` | Host timezone | **PRESENT** (v2 L482) | — |
| L2802 `IPC_INPUT_SUBDIR` | IPC namespace | **N/A** | — |
| L2806 `RESIDENTIAL_PROXY_URL` | Browser proxy | **PRESENT** via SCOPED_CREDENTIAL_VARS (v2 L237+520–523) | — |
| L2811 `CLAUDE_PLUGINS_ROOT=/workspace/plugins` | Plugin discovery | **PRESENT** (v2 L516) | — |
| L2816 `OLLAMA_ADMIN_TOOLS=true` | Ollama admin MCP | **PRESENT** via `containerConfig.ollamaAdminTools` (v2 L529–531) | — |
| L2821 `GITNEXUS_INJECT_AGENTS_MD=true` | GitNexus AGENTS.md injection | **PRESENT** via `containerConfig.gitnexusInjectAgentsMd` (v2 L526–528) | — |
| L2849 `HOME=/home/node` (when `--user`) | Home override | **PRESENT** (v2 L594–595) | — |
| Settings-file env block L1703: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` | Subagent orchestration | **MISSING** | MEDIUM |
| Settings-file env block L1707: `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` | Load CLAUDE.md from mounted dirs | **MISSING** | MEDIUM |
| Settings-file env block L1709: `ENABLE_TOOL_SEARCH=true` | Deferred tool discovery | **MISSING** | MEDIUM |
| Settings-file env block L1713: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80` | Auto-compact threshold | **PRESENT** (v2 L498) | — |
| Settings-file env block L1716: `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` | Lock auto-memory on | **PRESENT** (v2 L497) | — |
| Settings-file env block L1725: `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-7` | Opus alias lock | **MISSING** | HIGH |
| Settings L1733 `effortLevel: 'xhigh'` | Default reasoning effort | **UNVERIFIED** | MEDIUM — check v2 settings.json template |
| Settings L1736 `includeCoAuthoredBy: false` + `attribution: { commit: '', pr: '' }` | Strip Claude attribution in commits/PRs | **UNVERIFIED** | LOW |
| Settings L1741 `autoDreamEnabled: true` | Background memory consolidation | **UNVERIFIED** | MEDIUM |
| Scoped credential vars (v1 readSecrets at L2521+: `GITHUB_TOKEN_<SCOPE>`, `RENDER_API_KEY_<SCOPE>`, `RENDER_WORKSPACE_ID_<SCOPE>`, `DBT_CLOUD_*`, `BROWSER_AUTH_*`, etc.) | Per-group scoped credential resolution | **PARTIAL** | HIGH | v2 has `SCOPED_CREDENTIAL_VARS` (L221–238) with 14 bases. Missing from v2 list: `DBT_CLOUD_EMAIL`, `DBT_CLOUD_PASSWORD`, `DBT_CLOUD_API_URL`, `DBT_CLOUD_API_KEY` (v1 L2564–2567 reads these explicitly), all `BROWSER_AUTH_*` (L2571–2575), and various entrypoint-read secrets (`GITHUB_ALLOWED_ORGS`). |
| v1 `GITHUB_ALLOWED_ORGS` (entrypoint L29) | URL-scoped git credential allowlist | **MISSING** | HIGH (security) | Entrypoint in v2 has no org-scoping. A container with `GITHUB_TOKEN` can clone/push to any org the token grants. v1's URL-scoped credential helper would block all but allowed orgs. |

### Entrypoint behavior (v1 entrypoint.sh → v2 entrypoint.sh)

| v1 step (line) | Behavior | v2 status | Severity |
|---|---|---|---|
| L3 `npx tsc --outDir /tmp/dist` + L5 `chmod -R a-w /tmp/dist` | Compile + freeze dist | **N/A** | — | v2 runs TS directly with bun (no tsc build) |
| L6 `cat > /tmp/input.json` | Capture stdin secret blob | **PARTIAL** | LOW — v2 L28–32 captures stdin only if piped; upstream stdin-on-spawn path preserved but unused in forked flow |
| L20–21 `XDG_CONFIG_HOME=/tmp/.chromium` / `XDG_CACHE_HOME=/tmp/.chromium` | Chromium crashpad workaround | **PRESENT** (v2 L38–39) | — |
| L23–25 `AGENT_BROWSER_PROXY=$RESIDENTIAL_PROXY_URL` | Browser proxy | **PRESENT** (v2 L42–44) | — |
| L30–48 GitHub credential helper + gh login + `GITHUB_ALLOWED_ORGS` URL-scoping | URL-scoped GitHub credential helper | **REGRESSED** | HIGH (security) | v2 L50–52 uses `gh auth setup-git` unconditionally — no org-scoping. Any container with `GH_TOKEN` can clone/push to any org. |
| L55–61 `render workspace set` pre-configuration | Render CLI active workspace | **PRESENT** (v2 L55–59) | — |
| L65–66 `GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/.gws` + mkdir | gws writable config dir | **PRESENT** (v2 L64–65) | — |
| L68–92 Legacy gmail → gws cred conversion (read `gcp-oauth.keys.json` + `credentials.json`, write authorized_user files) | Legacy MCP → gws migration shim | **MISSING** | MEDIUM | v2 entrypoint has no legacy-conversion fallback. Groups that only have `.gmail-mcp*` creds (no consolidated `.config/gws/accounts/*.json`) will have gws fail silently. |
| L99–109 `gws` wrapper script that unsets `GOOGLE_APPLICATION_CREDENTIALS` before exec | Prevent ADC fallback | **PRESENT** (v2 L70–80) | — |
| L111–140 GitNexus repo registration (scan `/workspace/**/.git`, register in `~/.gitnexus/registry.json`) | GitNexus index auto-registration | **PRESENT** (v2 L82–115) | — | v2 scans with `maxdepth 4` (vs v1's 3) and falls back to bun if node missing. |
| L142 `node /tmp/dist/index.js < /tmp/input.json` | Run agent | **PRESENT** (v2 L120 via bun) | — |

### Plugin model

| Behavior | v1 | v2 | Status |
|---|---|---|---|
| `~/plugins/<name>` RO mount | Yes (L1899) | Yes (L334) | PRESENT |
| `container/nanoclaw-plugin` built-in mount | Yes (L1888) | Yes (L316) | PRESENT |
| `CLAUDE_PLUGINS_ROOT=/workspace/plugins` env | Yes (L2811) | Yes (L516) | PRESENT |
| `excludePlugins` deny list | Yes (L1900) | Yes (L336) | PRESENT |
| Codex host-OAuth RW mount (gated on codex plugin) | Yes (L1921) | Yes (L358–363) | PRESENT |

### Network

| Behavior | v1 | v2 | Status |
|---|---|---|---|
| OneCLI `applyContainerConfig` (HTTPS proxy + CA cert) | L2826 | L577 | PRESENT |
| OneCLI `ensureAgent` before apply | No (pre-existing agent assumed) | Yes (L575) | IMPROVED in v2 |
| `hostGatewayArgs()` for host gateway resolution | L2840 | L588 | PRESENT |

### 4.1 Findings summary

| Ref | Behavior | v1 rationale | v2 status | Severity |
|---|---|---|---|---|
| 4.1-M1 | `isSensitiveTopLevelFilename` shadowing of non-threaded group mount | Prevent `.env`/`credentials.json` leaking into container via group folder mount | **MISSING** | MEDIUM |
| 4.1-M2 | Auto-memory cross-thread overlay (`groupMemoryDir` bind over `.claude/projects/.../memory`) | Share auto-memory across threads in a group; without it every session has isolated memory that evaporates on session end | **REGRESSED / UNVERIFIED** | HIGH |
| 4.1-M3 | Gmail MCP primary-aliasing for scoped accounts | `gmail:illysium` mounts that account's dir at `/home/node/.gmail-mcp` so the default-path MCP server uses it | **MISSING** | MEDIUM |
| 4.1-M4 | Google Calendar scoped-token filtering (staged `tokens.json`) | Scoped access to calendar tokens so illysium group can't see kim-personal calendar | **REGRESSED** | MEDIUM |
| 4.1-M5 | Google Workspace MCP scoped-credential filtering | Same as above for GWS | **REGRESSED** | MEDIUM |
| 4.1-M6 | Snowflake `connections.toml` host→container path rewriting + scoped-conn filtering + key-perm staging | `snow sql` / Snowflake MCP break because host-absolute key paths don't resolve inside container; cross-group cred visibility | **REGRESSED** | HIGH |
| 4.1-M7 | AWS scoped-profile filtering | `aws:apollo` limits container to `[default]+[apollo]` only | **REGRESSED** | MEDIUM |
| 4.1-M8 | gcloud scoped key mounting (`GCLOUD_KEY_<SCOPE>` → selective copy) | Scoped service-account keys | **REGRESSED** | MEDIUM |
| 4.1-M9 | dbt profiles scoped-YAML filtering | Scoped dbt profiles | **REGRESSED** | MEDIUM |
| 4.1-M10 | `/workspace/attachments` inbound-attachment mount | Agents read WhatsApp/Slack/etc. attachment files | **MISSING (need arch verify)** | HIGH |
| 4.1-E1 | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` | Enables subagent orchestration (v1 v2 may get it elsewhere — verify) | **MISSING from env** | MEDIUM |
| 4.1-E2 | `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` | Load CLAUDE.md from additional mounted directories (e.g. `/workspace/agent/**`) | **MISSING** | MEDIUM |
| 4.1-E3 | `ENABLE_TOOL_SEARCH=true` | ToolSearch deferred tool discovery | **MISSING** | MEDIUM |
| 4.1-E4 | `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-7` | Lock `opus` alias to 4.7 so SDK-lag doesn't silently drop to 4.6 | **MISSING** | HIGH |
| 4.1-E5 | DBT Cloud env vars (`DBT_CLOUD_EMAIL/PASSWORD/API_URL/API_KEY`) | dbt CLI credentials | **MISSING from SCOPED_CREDENTIAL_VARS** | MEDIUM |
| 4.1-E6 | `BROWSER_AUTH_URL/EMAIL/PASSWORD` (scoped) | Browser automation auth for geo-fenced login | **MISSING** | LOW–MEDIUM (usage-dependent) |
| 4.1-EP1 | `GITHUB_ALLOWED_ORGS` URL-scoped git credential helper | Block cloning/pushing outside allowlisted GitHub orgs — security boundary against a compromised or runaway agent | **REGRESSED** | HIGH (security) |
| 4.1-EP2 | Legacy gmail-mcp → gws cred conversion in entrypoint | Back-compat for installs predating the consolidated gws scheme | **MISSING** | MEDIUM |
| 4.1-S1 | Per-group settings.json with hooks (GitNexus PreToolUse / PostToolUse) | PreToolUse enrichment + PostToolUse auto-reindex after commits | **UNVERIFIED** | MEDIUM |
| 4.1-S2 | Per-group settings `effortLevel`, `attribution`, `autoDreamEnabled`, `includeCoAuthoredBy` | Default UX + commit-attribution settings | **UNVERIFIED** | LOW–MEDIUM |

---

## 4.2 Phase 2.11 git worktrees

v1 IPC handlers in `src/ipc.ts` at L1940 (`create_worktree`), L2182 (`clone_repo`), L2288 (`git_commit`), L2349 (`git_push`), L2392 (`open_pr`). v2 MCP tools in `container/agent-runner/src/mcp-tools/git-worktrees.ts`.

Line-by-line edge-case comparison:

| Edge case | v1 behavior (ipc.ts anchor) | v2 behavior | Match? |
|---|---|---|---|
| `clone_repo` validates URL is GitHub | L2204 | L101 | ✅ |
| `clone_repo` rejects path traversal in repo name | L2227 | L56–62 | ✅ |
| `clone_repo` idempotent if repo exists | L2245 — unconditional | L116–123 — idempotent ONLY if `.git` dir exists; otherwise removes and re-clones | v2 **STRICTER** (fixes a v1 miss where an empty / partially-cloned dir would falsely report success) |
| `clone_repo` 120s timeout | L2262 | L126 | ✅ |
| `create_worktree` path-traversal guard on `repoDir` | L1958 | L161–163 (exists check implicit; explicit `validateRepoName` rejects `/\\..`) | ✅ — equivalent via name validator |
| `create_worktree` verifies repo exists + has `.git` | L1967 | L161 | ✅ |
| `create_worktree` fetches `origin` (best-effort) | L1980 | L168 (`tryGit`, 60s timeout) | ✅ |
| `create_worktree` `git remote set-head origin --auto` | L1991 | L169 | ✅ |
| `create_worktree` verifies `origin/HEAD` resolves (MF-9 guard) | L1999–2009 | L171 | ✅ |
| `create_worktree` handles corrupt existing worktree (missing `.git`) | L2020–2032 | L175–177 | ✅ |
| `create_worktree` returns current branch of existing worktree | L2034–2047 | L178–181 | ✅ |
| `create_worktree` default branch `thread-<threadId>-<repo>` | L2034, L2058 | L68–71 — uses sanitized `NANOCLAW_SESSION_ID` instead of threadId | **DIFFERENT** — v2 session id replaces threadId (documented in PHASE_2_11). Caveat: branch name now changes if session is recreated for same thread. |
| `create_worktree` validates branch via `git check-ref-format` | L2062 | L187 | ✅ |
| `create_worktree` checks local then remote branch existence | L2075–2097 | L191–193 | ✅ |
| `create_worktree` prunes stale worktree metadata pre-create | L2107 | L198 | ✅ |
| `create_worktree` error-path cleanup (`fs.rmdirSync(parent)`) | L2138, L2162 | **MISSING** | LOW — v2 leaves an empty `WORKTREES_DIR` parent on failure. Rarely observable; cosmetic. |
| `create_worktree` under `withGroupMutex` | L1953 | No mutex | **DIFFERENT-BY-DESIGN** — v2 has one container per session (exactly one writer). But two `create_worktree` calls for different repos in the SAME session will race on `fetch origin` of different repos — actually fine. Two calls for the SAME repo in the same session are serialized by the MCP tool's sequential call handling. No observable regression. |
| `git_commit` removes stale `.git/index.lock` | L2307 | L248 | ✅ |
| `git_commit` uses `--no-verify` | L2325 | L255 | ✅ |
| `git_commit` author `agent@nanoclaw.local` / `agent` | L2321–2323 | L253–254 | ✅ |
| `git_commit` returns short SHA | L2331 | L257 | ✅ |
| `git_push` reads current branch, `-u origin <branch>`, 60s timeout | L2367–2379 | L294–295 | ✅ |
| `open_pr` `gh pr create --title T --body B`, 60s timeout | L2411 | L337 | ✅ |
| `gh pr create` runs with `cwd=worktreeDir` | L2414 | L338 | ✅ |

### 4.2 Findings summary

| Ref | Behavior | v1 | v2 | Severity |
|---|---|---|---|---|
| 4.2-D1 | Branch name default uses session ID (v2) vs threadId (v1) | `thread-<threadId>-<repo>` | `thread-<sanitize(sessionId)>-<sanitize(repo)>` | LOW (documented) |
| 4.2-D2 | `withGroupMutex` for clone/fetch serialization | Present | Absent — relies on one-container-per-session + git's internal lock | LOW (acceptable) |
| 4.2-L1 | Parent-dir cleanup on worktree-add failure | Present | Absent | LOW |
| 4.2-+1 | `clone_repo` rejects empty-but-exists dest (not just path exists) | Unconditionally idempotent | Checks `.git` subdir | v2 **STRICTER / FIXED** |

**Overall**: Phase 2.11 port is tight. No load-bearing edge cases missed.

---

## 4.3 Phase 2.9 / 2.10 thread search + permalink resolver

v1: `src/thread-search.ts` (346 lines) + `src/db.ts` FTS tables + IPC `search_threads` / `read_thread_by_key`.  v2: `src/message-archive.ts` (host writer) + `container/agent-runner/src/mcp-tools/thread-search.ts` (container reader).

### Write path (every chat message indexed)

v2 writes archive messages in two places:
- **Inbound** — `src/router.ts:272` — only when `event.message.kind === 'chat' || 'chat-sdk'` AND `text` is non-empty. Outcome per inbound: 1 archive row per chat-kind message with extractable text.
- **Outbound** — `src/delivery.ts:461` — only when `msg.kind === 'chat'` (NOT `'chat-sdk'`), AND text extractable, AND `msg.channel_type && msg.platform_id` are set.

Gaps vs "write path fires on every message":

| Ref | Gap | Severity |
|---|---|---|
| 4.3-W1 | Outbound archive excludes `'chat-sdk'` kind. v2's chat-sdk bridge (used by Slack + Discord adapters) emits inbound as `'chat-sdk'` and presumably outbound through chat-sdk too. If delivery writes back `kind: 'chat'` (host translation), then this is fine. **Verify**: what kind does the host use when delivering for chat-sdk channels? If the outbound kind is `'chat-sdk'`, agent replies in Slack/Discord are NOT archived. Check `src/delivery.ts` delivery-kind flow for chat-sdk adapters. | **HIGH if kind mismatch, LOW if translated** |
| 4.3-W2 | Inbound archive requires the message to route successfully (it's inside the `handleInbound` success path after `writeSessionMessage`). Dropped messages (no agent wired, failed user resolve, etc.) are NOT archived. v1's write path ran earlier on every received message regardless of routing outcome. | MEDIUM — dropped messages can no longer be searched / permalinked |
| 4.3-W3 | Archive scoped to `agent_group_id`. v1 scoped to `group_folder`. Equivalent. | — |

### Read path (`search_threads`)

| Aspect | v1 | v2 | Status |
|---|---|---|---|
| FTS5 MATCH | Yes | Yes | ✅ |
| Query sanitizer (strip non-word, quote tokens ≥ 2 chars) | Yes (`sanitizeFtsQuery`) | Yes (same fn duplicated) | ✅ |
| Haiku semantic reranking of top 20 candidates | Yes (L79–84) | **MISSING** | MEDIUM — v2 returns FTS-rank order only |
| Raw-message fallback when FTS returns 0 | Yes (`searchRawMessageFallback`) | **MISSING** | LOW — v2 returns "No threads matched" |
| Grouping by `thread_id/channel/platform` | Yes | Yes | ✅ |
| Snippet extraction | Yes | Yes (same `snippet(…, 0, '[', ']', '…', 12)`) | ✅ |
| `limit` param default | 5 | 10 (cap 30) | DIFFERENT (docs updated) |

### Read path (`resolve_thread_link` — permalink)

v1 has **no** permalink resolver. v2 introduces one. So this is a net-new v2 feature — no v1 parity to regress against.

URL-shape handling in v2 `parseSlackUrl` / `parseDiscordUrl`:

| URL shape | Handled | Notes |
|---|---|---|
| `<ws>.slack.com/archives/<channel>/p<ts_without_dot>` | Yes | regex `slack\.com/archives/([A-Z0-9]+)/p(\d{10})(\d+)` |
| `<ws>.slack.com/archives/<channel>/p<ts>?thread_ts=<ts>` | Yes | separate `thread_ts` regex |
| `<ws>.enterprise.slack.com/…` | **Uncertain** | URL host not anchored — should match via `slack.com` substring. Acceptable. |
| `slack.com/archives/.../pXXXXXXXXXX` with only 10-digit `ts` and no frac | **NOT handled** | regex requires `\d{10}\d+` — trailing digits required. Edge case. |
| Discord `discord.com/channels/<guild>/<channel>/<message>` | Yes | L149 |
| Discord DM (guild = `@me`) | **NOT handled** | regex `\d+` requires numeric guild |
| Discord `discord.gg/...` invite | N/A — not a message link | — |

### 4.3 Findings summary

| Ref | Behavior | v1 | v2 | Severity |
|---|---|---|---|---|
| 4.3-W1 | Outbound archive excludes `chat-sdk` kind | N/A | Filter present | **HIGH if host emits chat-sdk outbound (need trace)** |
| 4.3-W2 | Dropped inbound messages are not archived | Archived pre-route | Archived post-route-success | MEDIUM |
| 4.3-R1 | Haiku semantic reranking | Present | Missing | MEDIUM — FTS-rank only |
| 4.3-R2 | Raw-message fallback when FTS hits 0 | Present | Missing | LOW |
| 4.3-P1 | Slack enterprise URL shape handling | N/A | Works via substring | LOW |
| 4.3-P2 | Slack URL without `thread_ts` + short `ts` | N/A | Regex miss | LOW |
| 4.3-P3 | Discord `@me` DM permalink | N/A | Regex miss (`\d+` for guild) | LOW |

---

## 4.4 Channel adapters — Slack, Discord

v1 channels: `src/channels/slack.ts` (1440 lines, native adapter) + `src/channels/discord.ts` (1813 lines, native). v2: thin wrappers (`slack.ts` 104 lines, `discord.ts` 38 lines) around `@chat-adapter/slack` / `@chat-adapter/discord` via `chat-sdk-bridge.ts` (522 lines).

This is a **fundamental architectural change**, not a port. v2 delegates almost all adapter logic to the upstream `@chat-adapter/*` npm packages. v1 owned everything in-tree. Re-validating "same behavior" line-by-line is not meaningful — the question becomes: does the Chat SDK bridge preserve the inbound-shape / outbound-capability contract?

### Contract alignment points (v2 adapter.ts)

| Contract surface | v1 native | v2 bridge | Status |
|---|---|---|---|
| Inbound shape: flat `sender`, `senderId`, `senderName`, `isMention` on `content` | Yes (native adapters build this directly) | Yes (bridge projects `author` → flat fields at L129–138) | PRESENT |
| Reply context extraction | Per-adapter in v1 | `extractReplyContext` hook on bridge (v2 Discord uses it at L11–19) | PRESENT — Slack adapter in v2 does NOT pass `extractReplyContext` (v2 `slack.ts` L81–95). v1 Slack supported reply quoting. **PARTIAL** for Slack. |
| Markdown → Slack mrkdwn transform on outbound | Yes (in v1 native) | Yes (v2 `transformOutboundText: parseTextStyles` at L94) | PRESENT |
| `supportsThreads` | Hardcoded per adapter | Explicit field (L75 adapter.ts) | PRESENT |
| Attachment delivery (file upload) | Yes (v1 has file upload flows inline) | `OutboundFile` in adapter contract (L41–44); chat-sdk bridge forwards | UNVERIFIED — confirm bridge calls `deliver` with files array |
| `openDM` for cold DMs (approvals, pairing) | Yes per adapter | Optional on adapter (L105); chat-sdk bridge should delegate to `chat.openDM` | UNVERIFIED — spot-check implementation |
| Multi-workspace Slack (fork-only) | Not present in v1 | Fork overlay via `parseSlackWorkspaces` (v2 L44–74). Produces multiple `channelType` like `slack-illysium`. | NEW FORK CAPABILITY |
| Typing indicator (`setTyping`) | Yes in v1 Slack/Discord | Optional on contract (L86); bridge forwards if adapter supports | UNVERIFIED |
| Reactions | v1 had `add_reaction` MCP + per-adapter handler (Slack at least) | Optional `/add-reactions` skill installs it in v2 | INSTALLED AS SKILL — not in trunk |
| `syncConversations` | Native adapters | Optional contract field | UNVERIFIED for chat-sdk adapters |

### Multi-workspace Slack interaction with adapter contract

v2 `parseSlackWorkspaces` assigns distinct `channelType` (`slack`, `slack-<suffix>`) per workspace so the registry-by-channelType model still works. Because `channelType` flows through to `messaging_groups.channel_type` and `sessions.messaging_group_id`, messages from each workspace route to the correct agent group without cross-contamination. Verified by reading the factory registration block (L78–98).

Risk: if an upstream change to `createChatSdkBridge` assumes `channelType === adapter.name`, the `channelType: ws.channelType` override would be silently dropped. v2 reads `config.channelType ?? adapter.name` at L155 — the override IS applied. OK.

### 4.4 Findings summary

| Ref | Behavior | v1 | v2 | Severity |
|---|---|---|---|---|
| 4.4-S1 | Slack reply-context extraction on inbound | Native adapter supported | v2 `slack.ts` does NOT pass `extractReplyContext` | MEDIUM — agent won't see "replying to…" context in Slack (but Discord does) |
| 4.4-A1 | Attachment outbound delivery path | Inline in v1 adapter | Delegated to chat-sdk bridge + adapter package | UNVERIFIED — must test live |
| 4.4-A2 | `openDM` for cold DMs | Native per-adapter | Optional on contract, delegated to chat-sdk | UNVERIFIED |
| 4.4-A3 | Typing indicator | Native | Delegated | UNVERIFIED |
| 4.4-A4 | `syncConversations` (bot-to-channel enumeration) | Native | Optional | UNVERIFIED |
| 4.4-F1 | Multi-workspace Slack (fork-only) | N/A | Working overlay | NEW / OK |
| 4.4-F2 | Reactions shipped in trunk | Yes in v1 main | Installed via `/add-reactions` skill | DIFFERENT-BY-DESIGN (skill-based model) |

**Key recommendation**: because Slack+Discord adapters delegate to npm packages, audit the *contract surface area* covered, not the implementations. Spin up an illie-v2 Slack container and exercise: reply-in-thread, file upload, reaction add, typing indicator, DM open, conversation sync. Anything UNVERIFIED above must be confirmed by live test before cutover.

---

## 4.5 Setup / wiring — first-run flow

v1 first-run: `isMain`-anchored model. First group registered gets `isMain=true`, which grants:
- Writable `/workspace/project` + `/workspace/project/store` mounts
- Writable `/workspace/global`
- Trigger-bypass on inbound (L909 `index.ts`)
- No sensitive-filename shadow in group folder (main is trusted to see its own .env? — actually main has `.env` shadowed but NOT the broader `isSensitiveTopLevelFilename` check)
- Access to fire-and-forget send_message to any chat (vs. source-group-only gate for non-main)

v2 first-run: `scripts/init-first-agent.ts` + `/init-first-agent` skill. Replaces `isMain` with user-level `user_roles.owner` grant.

### Behavioral diff

| v1 first-run invariant | v2 equivalent | Status |
|---|---|---|
| First group → `isMain=true` in `registeredGroups` table | First pairing → owner grant via `grantRole` iff `!hasAnyOwner()` (scripts/init-first-agent.ts L136–137) | EQUIVALENT (different granularity: per-user vs per-group) |
| Main group gets writable project/store mounts | N/A — v2 has no main concept | INTENTIONAL REMOVAL |
| Main group has trigger-bypass | v2: per-messaging-group `requiresTrigger` field on wiring; owner DMs typically don't require trigger | EQUIVALENT via different knob |
| Main can fire-and-forget send to any chat | v2: `send_message` MCP tool gates by admin ids passed via `NANOCLAW_ADMIN_USER_IDS` (container-runner L549–566) | EQUIVALENT via user roles |
| Ownership grant side-effect on first pair | v2: explicit owner grant only via script/skill | EQUIVALENT |
| Default isolation on first group | v1: single group, no isolation concept | v2: `/manage-channels` prompts for isolation level (`agent-shared | shared | separate`) | NEW in v2 |
| Default memory init (groups/<folder>/CLAUDE.md, skills, agent-runner-src) | v1: `initGroupFolder` scaffolded CLAUDE.md per group | v2: `initGroupFilesystem` in `src/group-init.ts` called from container-runner spawn path | EQUIVALENT |
| Default `.claude/` layout seeding | v1: via `container-runner` on spawn | v2: via `group-init.ts` on first spawn | EQUIVALENT |

### Setup-time env / first-run skipped steps

| Step | v1 | v2 | Severity |
|---|---|---|---|
| First-run creates initial `groups/<folder>/CLAUDE.md` template | Yes | Yes (`initGroupFilesystem`) | — |
| First-run grants admin DM pairing | Implicit by main group | Explicit owner grant in `init-first-agent.ts` | — |
| First-run seeds tone profile selector | No | No | — |
| Welcome DM on first pair | Yes (configurable) | Yes (DEFAULT_WELCOME at scripts/init-first-agent.ts L52) | — |

### 4.5 Findings summary

| Ref | Behavior | v1 | v2 | Severity |
|---|---|---|---|---|
| 4.5-I1 | Ownership grant on first pairing | Implicit via `isMain` flag | Explicit via `grantRole` when `!hasAnyOwner()` | EQUIVALENT |
| 4.5-I2 | Isolation level default | Single group, no concept | Prompted by `/manage-channels` | NEW v2 capability |
| 4.5-I3 | Per-group memory/skills seeding | `initGroupFolder` | `initGroupFilesystem` | PRESENT |
| 4.5-I4 | Welcome DM stage on first-agent | Conditional in v1 (set_group_notify_jid) | Unconditional stage of "System instruction: run /welcome" | PRESENT (different shape) |

**No v1 setup behavior skipped in v2 that I could detect.** All v1 first-run invariants have a v2 equivalent at a different granularity (user vs group).

---

## 4.6 MCP tools parity

### v1 tool surface (from `container/agent-runner/src/ipc-mcp-stdio.ts` + `ollama-mcp-stdio.ts`)

`send_message`, `send_file`, `render_diagram`, `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `update_task`, `register_group`, `set_group_model`, `set_group_effort`, `set_group_notify_jid`, `set_group_tools`, `read_thread`, `search_threads`, `read_thread_by_key`, `list_groups`, `add_ship_log`, `add_backlog_item`, `update_backlog_item`, `delete_backlog_item`, `list_backlog`, `get_activity_summary`, `scan_commits`, `update_plugin`, `save_memory`, `delete_memory`, `update_memory`, `list_memories`, `search_memories`, `get_tone_profile`, `list_tone_profiles`, `create_worktree`, `clone_repo`, `git_commit`, `git_push`, `open_pr`, `ollama_delete_model`, `ollama_generate`, `ollama_list_models`, `ollama_list_running`, `ollama_pull_model`, `ollama_show_model`.

### v2 tool surface (`container/agent-runner/src/mcp-tools/*.ts`)

`add_mcp_server`, `add_reaction`, `ask_user_question`, `cancel_task`, `clone_repo`, `create_agent`, `create_worktree`, `edit_message`, `get_capabilities`, `get_remote_control_status`, `get_tone_profile`, `git_commit`, `git_push`, `grant_access`, `install_packages`, `list_access`, `list_tasks`, `list_tone_profiles`, `nanoclaw`, `open_pr`, `pause_task`, `request_rebuild`, `resolve_thread_link`, `resume_task`, `revoke_access`, `schedule_task`, `search_threads`, `send_card`, `send_file`, `send_message`, `start_remote_control`, `stop_remote_control`, `update_task`.

### Diff: v1 → v2

**Common (23):** `send_message`, `send_file`, `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `update_task`, `search_threads`, `create_worktree`, `clone_repo`, `git_commit`, `git_push`, `open_pr`, `get_tone_profile`, `list_tone_profiles`.

**v1-only (MISSING in v2):**

| Tool | Purpose | v2 plan |
|---|---|---|
| `render_diagram` | Render mermaid/graphviz diagrams in-host, return image | **MISSING** — MEDIUM |
| `register_group` | Create a new agent group from inside the agent | Replaced by `create_agent` in v2 (similar role but different semantics) |
| `set_group_model`, `set_group_effort`, `set_group_notify_jid`, `set_group_tools` | Group config mutations | **MISSING** in v2 trunk — LOW/MEDIUM depending on usage (set via `/manage-channels` skill instead) |
| `read_thread`, `read_thread_by_key` | Thread retrieval by key/id | **MISSING** — partially covered by `resolve_thread_link` for permalinks. MEDIUM — agent can't list past threads + pull content by its own ID without a permalink |
| `list_groups` | Enumerate registered groups | **MISSING** — MEDIUM |
| `add_ship_log`, `add_backlog_item`, `update_backlog_item`, `delete_backlog_item`, `list_backlog`, `get_activity_summary`, `scan_commits` | Ship-log / backlog / activity-tracking skill | **MISSING** in trunk — install via feature skill if needed. OK if not used. |
| `update_plugin` | Refresh a plugin repo from upstream | **MISSING** — LOW (host does this via `/update-plugins`) |
| `save_memory`, `delete_memory`, `update_memory`, `list_memories`, `search_memories` | Memory CRUD tools | **MISSING** — auto-memory replaces these in v2 (CLAUDE_CODE_DISABLE_AUTO_MEMORY=0 lock). Verify auto-memory covers all use cases. MEDIUM if auto-memory lacks search. |
| `ollama_*` (6 tools) | Ollama model management | **MISSING** — installed via `/add-ollama-tool` skill (`OLLAMA_ADMIN_TOOLS=true`) |

**v2-only (NEW):** `add_mcp_server`, `add_reaction`, `ask_user_question`, `create_agent`, `edit_message`, `get_capabilities`, `get_remote_control_status`, `grant_access`, `install_packages`, `list_access`, `nanoclaw`, `request_rebuild`, `resolve_thread_link`, `revoke_access`, `send_card`, `start_remote_control`, `stop_remote_control`.

### Edge-case spot-check of common tools

| Tool | v1 error paths | v2 error paths | Match? |
|---|---|---|---|
| `clone_repo` | See 4.2 — validates github-only, path-traversal, idempotent on existing | v2 is stricter on partial-clone detection | ✅ + |
| `create_worktree` | See 4.2 | Matches | ✅ |
| `git_commit` | See 4.2 — strips index.lock, --no-verify, fixed author | Matches | ✅ |
| `git_push` | See 4.2 | Matches | ✅ |
| `open_pr` | See 4.2 | Matches | ✅ |
| `search_threads` | FTS + Haiku rerank + raw fallback | FTS-only | **PARTIAL** (see 4.3) |
| `schedule_task` | Host IPC task-scheduler | System action via messages_out → delivery.ts handler | DIFFERENT architecture, equivalent semantics — spot-check needed for task cancellation and recurrence |
| `list_tasks` | IPC read | MCP reads session state | PRESENT |
| `send_file` | IPC with auth check (L2442) — source-group gating for non-main | v2 delegates to delivery/destinations | **UNVERIFIED** — verify source-group / access gating preserved |
| `send_message` | IPC + access check per chat | v2 delegates to destinations + admin-gating via `NANOCLAW_ADMIN_USER_IDS` | **DIFFERENT** but equivalent privilege model |
| `get_tone_profile` / `list_tone_profiles` | v1 IPC | v2 MCP | PRESENT |

### 4.6 Findings summary

| Ref | Behavior | v1 | v2 | Severity |
|---|---|---|---|---|
| 4.6-M1 | `render_diagram` (mermaid/graphviz → PNG) | Present | Absent | MEDIUM — usage dependent |
| 4.6-M2 | `read_thread` / `read_thread_by_key` (read an arbitrary thread by id) | Present | Absent (only `resolve_thread_link` for permalinks) | MEDIUM |
| 4.6-M3 | `list_groups` (agent enumerates groups) | Present | Absent | MEDIUM |
| 4.6-M4 | `save_memory`/`search_memories` explicit memory CRUD | Present | Replaced by auto-memory | MEDIUM pending auto-memory parity check |
| 4.6-M5 | `set_group_*` config mutations from agent | Present | Absent in trunk | LOW–MEDIUM |
| 4.6-M6 | Ship-log / backlog / activity tools | Present | Absent in trunk (feature-skill candidate) | LOW unless actively used |
| 4.6-T1 | `send_file` source-group access gate | Per-chat gate at L2442 | UNVERIFIED in v2 | **HIGH if ungated** — can cross-post files between groups. Spot-check before cutover. |
| 4.6-T2 | Task scheduler recurrence / cancellation semantics | IPC-driven | messages_out action-driven | UNVERIFIED edge cases |
| 4.6-R1 | `resolve_thread_link` URL-shape completeness | N/A | See 4.3 | LOW |

---

## Consolidated category-4 severity counts

- **CRITICAL**: 0
- **HIGH**: 6 — 4.1-M2 (cross-thread memory overlay), 4.1-M10 (attachments mount), 4.1-M6 (Snowflake path rewriting), 4.1-E4 (Opus alias lock), 4.1-EP1 (`GITHUB_ALLOWED_ORGS`), 4.3-W1 (outbound `chat-sdk` archive filter), 4.6-T1 (`send_file` source-group gate — UNVERIFIED)
- **MEDIUM**: 17 (surface-area omissions, scoped-cred regressions, subagent/tool-search/CLAUDE.md envs, permalink corners, missing tools)
- **LOW**: 9 (cosmetic, edge-case URL shapes, etc.)

### Items flagged UNVERIFIED requiring live test before cutover

1. 4.1-M2 — auto-memory cross-thread aggregation works with v2 session dir layout
2. 4.1-M10 — attachment access in v2 (is it inlined into messages_in, or does it need the mount?)
3. 4.1-S1, 4.1-S2 — per-group `settings.json` contents (effort, attribution, hooks, autoDreamEnabled)
4. 4.3-W1 — outbound `kind` for chat-sdk channels — are agent replies archived?
5. 4.4-A1/A2/A3/A4 — chat-sdk bridge delegation: attachments, `openDM`, typing, `syncConversations`
6. 4.6-T1 — `send_file` source-group access gate
7. 4.6-T2 — task scheduler recurrence/cancellation parity

These must be validated live (illie-v2 or axie-2 container) before cutover — surface existence is confirmed; behavior is not.
