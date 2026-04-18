# Phase 5.0 — Container Surface-Area Audit (v1 → v2)

**Status:** findings, 2026-04-18. Mandatory pre-cutover per Dave.

## Why this phase exists

The original migration doc compared v1 and v2 **at the product-feature
level** (tone profiles, memory extraction, topic classifier, etc.). It
did not compare the container **surface area** — mounts, env vars,
entrypoint behavior — line by line. Infrastructure gaps are feature
gaps: a missing `/home/node/.config/gws/accounts` mount silently
disables every Google Workspace skill the agent uses; a missing
`~/plugins/` mount silently removes every plugin-delivered capability.
They don't error loudly, they just can't do the thing.

Going forward, **anything the v1 container could reach that the v2
container can't is a regression**. This audit enumerates those gaps
so they can be ported before cutover.

## Methodology

- Line-by-line grep of `mounts.push(...)` and `args.push('-e', ...)`
  sites in both container-runners.
- Full read of v1's `container/entrypoint.sh` (v2 has no entrypoint
  script — inline `-c` bash command).
- Inventory of `readSecrets()` / scoped env key resolution in v1.
- Only `src/container-runner.ts` and `src/container/entrypoint.sh`
  scoped. Host-side features (channel adapters, task scheduler,
  etc.) are out of scope for *this* phase.

## Findings

Each row below is a concrete capability the v1 container has that v2
doesn't. Priority is rough: **High** = daily-use regression, **Med** =
frequent-use regression, **Low** = rarely triggered or already
partially covered.

### Mounts

| Container path | v1 source | Purpose | Priority | Depends on |
|---|---|---|---|---|
| `/workspace/plugins/<name>` (RO, per subdir of `~/plugins`) | `~/plugins/bootstrap`, `codex`, `gitnexus`, `impeccable`, `remotion-skills`, `taste-skill` | Plugin-delivered skills, agents, hooks (SDK auto-loads from `CLAUDE_PLUGINS_ROOT`) | **High** | per-group `excludePlugins` deny list |
| `/workspace/plugins/nanoclaw-hooks` (RO) | `container/nanoclaw-plugin/` | Repo-readiness guard + post-commit blast-radius hook | **High** | v2 may need its own `container/nanoclaw-plugin/` |
| `/workspace/tone-profiles` (RO) | `tone-profiles/` | Agent tone/voice profiles (reads & applies a profile per group) | **High** | folded into 5.1 |
| `/workspace/project` (RO) | project root | Agent can read its own source tree (self-debugging, self-mod context) | **Med** | excluded: `.env`, `data/`, `node_modules/` |
| `/workspace/attachments` (RO) | `data/attachments/<group>/` | Inbound attachment access | **Med** | Phase 2.6 changed path to session dir — needs verification |
| `/home/node/.codex` (RW) | `~/.codex/` | Codex CLI OAuth session — RW so token refresh persists | **High** (gated on codex plugin) | codex plugin mount |
| `/home/node/.config/gws/accounts` (RO) | `~/.config/gws/accounts` | Consolidated Google Workspace OAuth creds for gws CLI | **High** | enables Gmail, Calendar, Drive, Docs |
| `/home/node/.gmail-mcp` + `.gmail-mcp-<account>` (RO, multi-account) | `~/.gmail-mcp*` | Legacy Gmail MCP creds (back-compat until full gws migration) | **Med** | legacy path |
| `/home/node/.config/google-calendar-mcp` (RO) | `~/.config/google-calendar-mcp/` | Google Calendar MCP creds | **Med** | |
| `/home/node/.google_workspace_mcp/credentials` (RO) | `~/.google_workspace_mcp/credentials/` | GWS MCP creds dir | **Med** | |
| `/home/node/.gmail-mcp/gcp-oauth.keys.json` (RO file-mount) | `~/.gmail-mcp/gcp-oauth.keys.json` | OAuth keys file for Gmail MCP | **Med** | |
| `/home/node/.snowflake` (RO) | `~/.snowflake/` | Snowflake `connections.toml` + key files | **High** | daily data work |
| `/home/node/.aws` (RO) | `~/.aws/` | AWS creds | **Med** | |
| `/home/node/.gcloud-keys` (RO) | `~/.gcloud-keys/` | gcloud service-account JSON keys | **Med** | |
| `/home/node/.dbt` (RO) | `~/.dbt/` | dbt `profiles.yml` + secrets | **High** | daily data work |

### Env vars

| Var | Purpose | Priority |
|---|---|---|
| `RESIDENTIAL_PROXY_URL` | Browser proxy for geo-fenced sites (maps to `AGENT_BROWSER_PROXY` inside the container) | **Med** |
| `CLAUDE_PLUGINS_ROOT=/workspace/plugins` | Tells Claude Code SDK where to discover plugins | **High** (ships with plugin mounts) |
| `OLLAMA_ADMIN_TOOLS=true` | Enables Ollama admin MCP tools | **Low** (rarely used) |
| `GITNEXUS_INJECT_AGENTS_MD=true` | Auto-injects gitnexus AGENTS.md into repos | **Med** |
| **Per-tool scoped env** (e.g. `GITHUB_TOKEN_<SCOPE>` → `GITHUB_TOKEN`, `RENDER_API_KEY_<SCOPE>` → `RENDER_API_KEY`, Snowflake/dbt variants) | Per-group/per-tool credential isolation | **High** |

Partially done: `GITHUB_TOKEN_<FOLDER>` + `githubTokenEnv` override
(commit `2527cbe`). Needs generalization to Render, Snowflake, AWS,
dbt, gcloud with a common helper.

### Entrypoint behavior

v2 uses an inline `bash -c 'tsc && ln -s && gh auth setup-git; node
index.js'`. v1 has a 142-line `entrypoint.sh` that does:

| Step | Purpose | Priority |
|---|---|---|
| `XDG_CONFIG_HOME=/tmp/.chromium`, `XDG_CACHE_HOME=/tmp/.chromium` | Chromium crashpad workaround (breaks without this on long sessions) | **High** (gated on browser use) |
| `AGENT_BROWSER_PROXY=$RESIDENTIAL_PROXY_URL` | Routes browser through residential proxy | **Med** |
| `git config credential.helper` with org-scoped auth (`GITHUB_ALLOWED_ORGS`) | URL-scoped GitHub auth — blocks cloning outside allowlisted orgs | **High** (security) |
| `gh auth login --with-token` (only when not org-scoped) | Log `gh` CLI in globally | **High** (done by `gh auth setup-git` in v2, good enough) |
| `render workspace set <id>` | Pre-configure Render CLI active workspace | **Med** |
| `GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/.gws` + mkdir | gws CLI needs writable config dir (not host-mounted) | **High** (gws won't start without this) |
| Legacy Gmail/Calendar MCP → gws cred conversion | Back-compat for agents using legacy MCP creds | **Low** (legacy) |
| `gws` wrapper stripping `GOOGLE_APPLICATION_CREDENTIALS` | Prevents gws from falling back to service-account creds via ADC (breaks user-OAuth path) | **High** (gws fails without) |
| GitNexus repo auto-registration | Scans `/workspace/**/.git` + `.gitnexus/meta.json` and registers in `~/.gitnexus/registry.json` | **High** (gitnexus MCP tools need this) |
| Secret input via `/tmp/input.json` (stdin pipe) | v1's stdin-based secret injection | **N/A** (obsolete in v2 — OneCLI handles API creds; in-env handling is right for git/etc.) |

### Config model gaps

| Feature | v1 | v2 |
|---|---|---|
| Per-group `tools` array → activates scoped env for matching CLIs (e.g. `"tools":["github:illysium","render:sunday","snowflake:apollo"]`) | `ContainerConfig.tools` + `readSecrets()` resolves scoped env keys | Missing. `githubTokenEnv` covers GitHub only. |
| Per-group `excludePlugins` deny list | Yes | Missing |
| `gitnexusInjectAgentsMd` flag on group config | Yes (drives entrypoint env) | Missing |

## Remediation plan

Ordered by dependency and priority:

1. **5.0-A: plugin mounts** — port `~/plugins/*` + `container/nanoclaw-plugin/` mounts, `CLAUDE_PLUGINS_ROOT` env, `excludePlugins` deny list, codex `.codey` RW special-case. Also port the built-in `container/nanoclaw-plugin/` from v1 (if we want those hooks) or skip.
2. **5.0-B: credential mounts** — `.config/gws/accounts`, `.gmail-mcp*`, `.google-calendar-mcp`, `.google_workspace_mcp`, `.snowflake`, `.aws`, `.gcloud-keys`, `.dbt`, `.codex`. All RO except `.codex`. Mount only when host dir exists (don't force creation on machines without those tools).
3. **5.0-C: tone-profiles mount** — single line (folded from 5.1).
4. **5.0-D: project root RO mount** — single line. Exclude `.env`, `data/`, `node_modules/`.
5. **5.0-E: entrypoint.sh** — v2 currently has none. Port a minimal version with: XDG dirs, residential proxy mapping, GWS config dir + wrapper, GitNexus repo registration. Keep as a real `container/entrypoint.sh` (override docker entrypoint to it) so future additions don't require container-runner.ts changes.
6. **5.0-F: per-tool scoped env helper** — generalize `resolveGitHubToken()` into `resolveScopedEnv(var, folder, toolsArray)` handling GitHub + Render + Snowflake + dbt + AWS + gcloud. Honor `tools` field on container.json.
7. **5.0-G: env forwarding** — `RESIDENTIAL_PROXY_URL`, `CLAUDE_PLUGINS_ROOT`, `OLLAMA_ADMIN_TOOLS`, `GITNEXUS_INJECT_AGENTS_MD` based on flags in container.json (or the existing env).

Each can ship as its own commit. Validate by spawning an illie-v2
container and confirming the agent can:
- Call `gws accounts list` (proves gws creds + wrapper)
- Call `snow sql -q "select 1"` (proves Snowflake mount)
- Call `dbt debug` (proves dbt mount)
- Load gitnexus-provided skills (proves plugins)
- Clone, fetch, push (proves GitHub scoping)
- See its own source at `/workspace/project` (proves project mount)

## What this audit does NOT cover

- Channel adapter features (typing, formatting, reactions) — those are
  the Phase 5.x feature items.
- Host-side services (task scheduler, host-sweep, cleanup cron) —
  already migrated in earlier phases.
- DB schema features.
- Network policy beyond proxy/cert (e.g. DNS, firewall rules).

Any of these may also have surface-area gaps but are tracked
separately.

## Acceptance criteria

Phase 5.0 is done when an illie-v2 container, at spawn, has
**everything the equivalent v1 illysium container has in terms of:**
mounted paths, env vars, entrypoint-side initialization. Verified by a
side-by-side diff of `docker inspect <ct>` (env + mounts) for a v1 and
v2 container wired identically.
