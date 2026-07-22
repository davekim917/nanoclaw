# Codex ↔ Claude parity test plan

The audit on 2026-05-13 found Codex was materially under-equipped to act as a
peer to Claude Code (host) and to container agents. This document captures the
deliverable changes and the verification steps so future drift can be caught.

## Changes shipped

1. **`~/.codex/AGENTS.md`** — substantive global rules mirroring
   `~/.claude/CLAUDE.md` (Communication Style, Truth-Grounded, Completion
   Protocol, Owner-mode, Reviewing Peer-AI Feedback). Keeps `@RTK.md` include.
2. **`~/.codex/config.toml`** — added `playwright`, `context7`, `deepwiki` MCP
   servers alongside the existing `exa` and `gitnexus`.
3. **`~/.codex/hooks.json`** — wired Stop (mnemon capture), UserPromptSubmit
   (mnemon recall), PreToolUse + PostToolUse (gitnexus enrichment + post-commit
   verify + strip-gitnexus-stats).
4. **`~/.codex/hooks/cc-mnemon/capture-turn.cjs`** — Codex-specific turn
   capture that parses Codex rollout JSONL (`response_item.payload.role`)
   and writes to the SAME `cc-<slug>/sources/inbox/` directory Claude uses.
   Codex turns now feed mnemon, exactly like Claude turns do.
5. **`~/.codex/hooks/gitnexus/gitnexus-hook.cjs`** — Codex-adapted gitnexus
   enrichment that recognizes `exec_command`, `search`, `glob` tool names
   and reads `tool_response` (Codex's envelope name).
6. **`~/.codex/hooks/codex-claude-shim.cjs`** — payload normalizer that
   rewrites Codex's `exec_command`/`tool_response` to Claude's
   `Bash`/`tool_output` so the existing Claude hooks (strip-gitnexus-stats,
   post-commit-verify) work unchanged via the shim.
7. **`~/.claude/settings.json`** — expanded `mcp__gitnexus__*` allowlist from
   4 to 16 tools (api_impact, cypher, rename, route_map, shape_check,
   tool_map, list_repos, group_contracts, group_list, group_query,
   group_status, group_sync added).
8. **`container/agent-runner/src/codex-companion-setup.ts` + wiring in
   `index.ts`** — at container startup (when Claude is the provider), build
   a container-local `/home/node/.codex-runtime/` directory with:
   - a symlink to the mounted host `auth.json` (OAuth refresh persists
     back to host)
   - a merged `config.toml`: host config retains its MCP server blocks
     AND the agent-runner's resolved `mcpServers` is added (always
     including `nanoclaw`); on name collision runtime entries win.
   - a symlink to the mounted host `AGENTS.md` (behavioral rules)
   - a `skills/` subdir with symlinks to every container-bundled Claude
     skill at `/home/node/.claude/skills/<name>` (Codex auto-discovers)
   Sets `process.env.CODEX_HOME` to this dir so Codex invoked by Claude's
   children (codex-companion, /codex:rescue) finds the nanoclaw MCP server
   plus all the skills.

9. **`src/agents-md-flatten.ts`** — utility that recursively resolves
   `@path` includes in a CLAUDE.md and returns the flat content. Codex
   doesn't expand `@` directives (verified empirically), so this is the
   bridge that keeps CLAUDE.md as canon while still feeding Codex the
   resolved rules.

10. **`scripts/sync-codex-agents-md.ts`** — one-shot script that flattens
    `~/.claude/CLAUDE.md` and writes `~/.codex/AGENTS.md` with a small
    Codex-specific peer-framing header. Run after editing CLAUDE.md.

11. **`composeGroupClaudeMd` (in `src/claude-md-compose.ts`)** — extended
    to also emit `groups/<name>/AGENTS.md` at every spawn, flattening
    the @-includes inline. Translates the composer's container-path
    symlinks (`/app/CLAUDE.md`, `/app/skills/...`, `/app/src/mcp-tools/...`)
    to their host paths so the flattener can read through them.

12. **Plugin-skill discovery** (`src/plugin-skill-discovery.ts`) — walks
    `~/plugins/*/` and materializes mirror dirs at `~/.agents/skills/<name>/`
    for every portable skill using the preference order below.

    > **Superseded for Codex (2026-07-22).** Codex now loads `~/plugins`
    > NATIVELY via its own marketplace + `~/.codex/plugins/cache` — skills arrive
    > namespaced `<plugin>:<skill>` WITH each plugin's MCP server. The mirror
    > duplicated those skills unprefixed and stripped their MCP, so it was retired
    > for Codex: `syncCodexPluginSkills()` and `scripts/sync-codex-plugin-skills.ts`
    > are deleted, and `codex-companion-setup` mirrors only container-bundled
    > skills when `runtime === 'codex'`. The mirror below now serves **OpenCode
    > only** (it has no plugin loader). Registration is done by
    > `scripts/enable-agent-plugin.ts`, which generates a `.codex-plugin` manifest
    > when a plugin ships none. Tests 20b/20c below are obsolete.

    Preference order:

    1. `<plugin>/.agents/skills/<name>/` — the runtime-agnostic canonical
       (impeccable ships here; no Claude-specific frontmatter)
    2. `<plugin>/skills/<name>/` — top-level skills dir
    3. `<plugin>/SKILL.md` — single-skill plugin
    4. `<plugin>/plugin/skills/<name>/` — impeccable fallback
    5. `<plugin>/<plugin>-cursor-integration/skills/<name>/` — runtime-
       agnostic fallback
    6. `<plugin>/<plugin>-claude-plugin/skills/<name>/` — last resort

    Skipped: `codex` plugin (Codex-internal), `bootstrap/plugins/workflow`
    (Claude's `/team-*` Skill/Agent-tool-dependent), any `.claude/`,
    `.cursor/`, `.opencode/`, etc. runtime-specific subdirs (prefer
    `.agents/` canonical), `deprecated/` subtrees, frontmatter
    `user-invocable: false`.

    Result: 31 portable skills wired (8 bootstrap-domain, 12 taste-skill,
    7 gitnexus via `gitnexus setup`, plus humanizer, impeccable,
    remotion-best-practices, cortex-code). Auto-update inherits from
    Claude's marketplace — `~/plugins/<plugin>/` updates propagate to
    Codex via symlinked subdirs; `SKILL.md` is re-copied on next sync
    if source mtime advances.

13. **Container plugin-skill sync** — `setupCodexRuntime` runs the same
    discovery against `/workspace/plugins/` and writes mirror dirs to
    `/home/node/.agents/skills/`, layered on top of the 10 container-
    bundled NanoClaw skills (agent-browser, vercel-cli, slack-formatting,
    etc.). Total per container: 41 skills.

14. **Host filesystem watcher daemon** (`src/codex-sync-watcher.ts` +
    `scripts/nanoclaw-codex-sync.service`) — closes the host-side drift
    gap with event-driven sync. Watches `~/.claude/*.md` and `~/plugins/`
    (recursive, `node_modules`/`.git` ignored). On 5s-debounced change,
    runs `syncCodexAgentsMd()`, the subagent mirrors, and the local marketplace
    plugin cache in-process (`src/codex-sync.ts` extracts the shared functions).
    Plugin SKILLS are no longer synced to host CLI paths — Codex loads them
    natively and OpenCode's mirror is built at container spawn. File lock at
    `~/.codex/.sync.lock` with stale-PID detection. Heartbeat file at
    `~/.codex/.sync-heartbeat` for future healthcheck timer. Installed
    as `nanoclaw-codex-sync.service` (system unit, User=ubuntu, 512MB
    cap). Typical resource use: ~120MB resident, ~12-30ms per sync. No
    spawned tsx per fire — Codex's review flagged that spawn overhead
    was the original bottleneck.

### Critical empirical finding (2026-05-14)

Codex's skill auto-discovery has TWO constraints I verified live before
landing the final design:

- **Top-level skill dir must be a real directory.** Symlinked
  `~/.agents/skills/<name>` → source path is silently ignored. Probe:
  rename humanizer from symlink → real dir; Codex's `r1` discovery
  picked it up immediately.
- **`SKILL.md` inside that dir must be a real file** (not a symlink).
  Probe: same dir, made SKILL.md a symlink → not in `r1`. Made it a real
  file → found at `r1`.

Subdirs and other top-level files (scripts/, reference/, assets/) CAN
be symlinks — Codex follows them at agent runtime (standard fs reads).
That's the asymmetry the mirror logic exploits: real dir + real SKILL.md
copy + symlinked everything else. A `.nanoclaw-managed` marker
distinguishes our writes from native installs (`gitnexus setup`,
operator-placed) so we never overwrite them.

### Editing flow: where skills come from

| Source | Lives at | Auto-update path |
|--------|----------|-----------------|
| Tools with native Codex install (e.g. gitnexus) | `~/.agents/skills/<tool>/` (real install) | run the tool's setup command again |
| `~/plugins/<plugin>/` (Claude marketplace) | `~/.agents/skills/<name>/` (mirror dir) | symlinked subdirs auto-update; SKILL.md re-copied when sync re-runs |
| Manually installed | `~/.agents/skills/<name>/` (real install) | edit in place |
| Container-bundled NanoClaw (in-container only) | `/home/node/.agents/skills/<name>/` (mirror dir) | regenerated on every container spawn |

## Verification matrix

### Host parity (run from any CC session)

| # | What | Command | Expected |
|---|------|---------|----------|
| 1 | AGENTS.md content | `grep -c 'Communication Style\|Owner-mode\|Truth-Grounded\|Completion Protocol\|Reviewing Peer-AI' ~/.codex/AGENTS.md` | `5` |
| 2 | All 5 MCP servers | `codex mcp list` | rows for exa, gitnexus, deepwiki, context7, playwright, all "enabled" |
| 3 | Codex sees mnemon recall | `echo '{"hook_event_name":"UserPromptSubmit","prompt":"...","cwd":"/home/ubuntu/nanoclaw-v2"}' \| node ~/.claude/hooks/cc-mnemon/inject-recall.cjs` | JSON with `hookSpecificOutput.additionalContext` populated |
| 4 | Codex captures turn into shared inbox | `echo '{"hook_event_name":"Stop","session_id":"X","transcript_path":"<latest rollout>","cwd":"/home/ubuntu/nanoclaw-v2"}' \| node ~/.codex/hooks/cc-mnemon/capture-turn.cjs` | new `codex-<hash>.txt` in `~/.claude/projects/-home-ubuntu-nanoclaw-v2/sources/inbox/` |
| 5 | gitnexus enrichment on Codex exec_command | `echo '{"hook_event_name":"PreToolUse","tool_name":"exec_command","tool_input":{"command":"rg send_message src/"},"cwd":"/home/ubuntu/nanoclaw-v2"}' \| node ~/.codex/hooks/gitnexus/gitnexus-hook.cjs` | JSON with related-symbol context |
| 6 | Shim normalizes Codex → Claude payload | `echo '{"hook_event_name":"PostToolUse","tool_name":"exec_command","tool_input":{"command":"git commit"},"tool_response":{"exit_code":0},"cwd":"/tmp"}' \| node ~/.codex/hooks/codex-claude-shim.cjs ~/.claude/hooks/strip-gitnexus-stats.cjs` | exit 0, no errors |
| 7 | Claude allowlist has 16 gitnexus tools | `grep -c "mcp__gitnexus__" ~/.claude/settings.json` | `16` |

### Container parity (run after host restart + container respawn)

Use `rtk proxy docker ps` to bypass the rtk docker-wrapper rewrite — plain
`docker ps` may be rewritten and lose `--format` flag.

| # | What | How | Expected |
|---|------|-----|----------|
| 8 | Container build picks up new code | `pnpm run build && sudo systemctl restart nanoclaw-v2`, wait ~5s | New containers under `nanoclaw-v2-*` Up |
| 9 | CODEX_HOME runtime dir exists | `docker exec <c> ls -la /home/node/.codex-runtime/` | `auth.json` + `AGENTS.md` symlinks, `config.toml` regular file |
| 10 | Merged config is union of host + container MCPs | `docker exec <c> grep '^\[mcp_servers\.' /home/node/.codex-runtime/config.toml` | All host MCPs (exa, gitnexus, deepwiki, context7, playwright) + runtime additions (nanoclaw, granola, pocket) |
| 11 | Codex CLI inside container sees nanoclaw | `docker exec <c> sh -c 'CODEX_HOME=/home/node/.codex-runtime codex mcp list'` | shows `nanoclaw` (stdio: `bun run /app/src/mcp-tools/index.ts`) alongside all 7 other MCPs, all `enabled` |
| 12 | AGENTS.md present + symlinked to mounted host file | `docker exec <c> readlink /home/node/.codex-runtime/AGENTS.md && docker exec <c> head /home/node/.codex-runtime/AGENTS.md` | Symlink target `/home/node/.codex/AGENTS.md`; content starts with "# Global Rules" |

### Skills + AGENTS.md parity (verify after host changes + container respawn)

| # | What | Command | Expected |
|---|------|---------|----------|
| 13 | Host: Codex sees all 20 Claude skills | `ls ~/.codex/skills/ \| wc -l` | `20` (plus `.system/` hidden) |
| 14 | Host: AGENTS.md has @-includes resolved | `grep -c '^@' ~/.codex/AGENTS.md` | `0` (RTK.md content inline) |
| 15 | Host: regenerate AGENTS.md after editing CLAUDE.md | `pnpm exec tsx scripts/sync-codex-agents-md.ts` | reports byte count, AGENTS.md updated |
| 16 | Container: group AGENTS.md generated | `ls -la groups/main/AGENTS.md` | exists, regenerated on each spawn |
| 17 | Container: group AGENTS.md has no @-includes | `grep -c '^@\./' groups/main/AGENTS.md` | `0` |
| 18 | Container: /workspace/agent/AGENTS.md present (Codex hierarchical discovery) | `docker exec <c> wc -l /workspace/agent/AGENTS.md` | matches host `groups/<group>/AGENTS.md` line count |
| 19 | Container: Codex skill symlinks present | `docker exec <c> ls /home/node/.codex-runtime/skills/ \| wc -l` | ~41 (10 container-bundled NanoClaw + ~31 plugin-discovered) |
| 20 | Container: skill content reads through symlink | `docker exec <c> head -3 /home/node/.codex-runtime/skills/agent-browser/SKILL.md` | shows frontmatter `name: agent-browser` |
| 20a | Container: plugin canonical source preferred | `docker exec <c> readlink /home/node/.codex-runtime/skills/impeccable` | `/workspace/plugins/impeccable/.agents/skills/impeccable` (NOT `.claude/skills/`) |
| ~~20b~~ | ~~Host: plugin-skill sync is idempotent~~ | OBSOLETE — the host codex mirror and `scripts/sync-codex-plugin-skills.ts` were deleted when Codex moved to native plugin loading | — |
| ~~20c~~ | ~~Host: re-discover after a plugin update~~ | OBSOLETE for Codex. Native replacement: after `git pull` in `~/plugins/<x>/`, rerun `pnpm exec tsx scripts/enable-agent-plugin.ts <x>` and the emitted `codex plugin` commands. Required if the plugin's `SKILL.md` is a symlink (Codex skips those; the enabler materializes a real copy under `<plugin>/.nanoclaw/codex-skills/`, which is a COPY and will drift until rerun) | — |
| 20d | Codex: plugin skills load natively, no mirror dupes | In a codex container: `codex debug prompt-input` | skills appear namespaced `<plugin>:<skill>` (e.g. `taste-skill:brandkit`); NO unprefixed duplicates of the same skills |

### End-to-end test (manual, recommended)

21. Trigger a `/codex:rescue` or `/codex:task` from within a container agent
    asking Codex to use a nanoclaw MCP tool (e.g. "list current backlog via
    `mcp__nanoclaw__list_backlog`"). Codex should succeed — proving the MCP
    server is discoverable and callable from inside Codex's runtime.

22. After several Codex turns under the host CC project:
    `mnemon recall "<topic from codex turn>" --store cc-<your-slug>` —
    results should include entries with `src=user` and `src=assistant`
    from Codex-captured turn pairs (look for files named `codex-*.txt` in
    `~/.claude/projects/<slug>/sources/inbox/`).

23. Ask Codex to use a Claude skill, e.g. `/humanizer`. Verify Codex
    auto-discovers and applies it. (Don't expect `/team-build` to work —
    Claude-runtime-specific.)

## Editing flow: CLAUDE.md is canon

When editing behavioral rules:

1. Edit `~/.claude/CLAUDE.md` (or any `@`-included file like `~/.claude/RTK.md`).
2. Run `pnpm exec tsx scripts/sync-codex-agents-md.ts` (host) to regenerate
   `~/.codex/AGENTS.md` with the resolved content.
3. For group-level rules: the next container spawn auto-regenerates
   `groups/<name>/AGENTS.md` via `composeGroupClaudeMd`. No manual step.

## Out-of-scope (deferred)

- **Codex on host doesn't route through OneCLI.** Same status as host Claude
  — credentials read from env, not gateway. Not a parity gap.
- **Codex plugin commands (gmail, github, canva) vs Claude skills.**
  Different ecosystems; not direct equivalents. Documented intentionally.

## When to re-run this matrix

- After upgrading `@openai/codex` (hook payload schema can change).
- After adding/removing MCP servers in either `~/.codex/config.toml` or
  `~/.claude/settings.json`.
- After modifying any of the hook scripts under `~/.codex/hooks/` or
  `~/.claude/hooks/`.
- After modifying `container/agent-runner/src/codex-companion-setup.ts`
  or `container/agent-runner/src/index.ts`.
