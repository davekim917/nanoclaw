---
name: enable-agent-plugins
description: Enable a ~/plugins/<name> plugin across all three container agent providers (Claude, Codex, OpenCode) with parity. Use after cloning a plugin repo into ~/plugins/ when you want its skills/commands — and, for "mode" plugins that inject a standing ruleset, its always-on file — available to every agent group. Default is all groups, with per-group opt-out.
---

# Enable Agent Plugins

Bring a plugin in `~/plugins/<name>` to **all three** container agent providers with
parity. The container mount + `CLAUDE_PLUGINS_ROOT` already gives Claude groups any
plugin that carries a Claude manifest — this skill closes the gaps that aren't
automatic: missing manifests, the OpenCode skill mirror, and always-on activation on
Codex/OpenCode (which fire **no** plugin hooks in NanoClaw containers).

## Scope: container agent groups only — never a host CLI

This skill delivers plugins to the **fleet**, not to the operator's own CLIs. Do NOT
run `codex plugin marketplace add` / `codex plugin add`, do NOT register a Claude
marketplace on the host, and do NOT touch `~/.codex/config.toml` or `~/.claude/`.

That isn't just tidiness — host registration buys the fleet nothing. Containers
strip every inherited `[plugins.*]` / `[marketplaces.*]` table out of the host Codex
config and register fresh from `/workspace/plugins` at spawn
(`container/agent-runner/src/codex-companion-setup.ts`). Installing into a host CLI
only changes the operator's own terminal sessions, and that is their call to make by
hand, not a side effect of this skill.

## The model (why this skill exists)

Each provider reaches the plugin by its own path, all rooted at the `~/plugins` →
`/workspace/plugins` container mount:

| Plugin provides | Claude group | Codex group | OpenCode group |
|---|---|---|---|
| **Skills / commands** (`skills/<n>/SKILL.md`) | `.claude-plugin/plugin.json` + mount (`CLAUDE_PLUGINS_ROOT`) | native registration at spawn from the mount, needs `.codex-plugin/plugin.json` + `.agents/plugins/marketplace.json` | mirror → `~/.config/opencode/skill/` (no plugin loader) |
| **Always-on ruleset** (e.g. impeccable) | plugin SessionStart hook (auto) | `~/plugins/<n>/.nanoclaw-always-on.md` → `AGENTS.md`/`CLAUDE.md` | same |
| **Opt-out** | `excludePlugins` (drops mount) | `excludePlugins` (drops mount) + skip the ruleset | `excludePlugins` skips the **ruleset only** — skills stay. The mirror is synced globally, not per group |

So the only artifacts ever worth generating are: **(1)** the manifests a repo ships
none of, and **(2)** a condensed always-on ruleset for "mode" plugins. A skills-only
plugin that already ships its manifests needs neither — it reaches all three on the
next spawn, and the enabler run is just a verification pass.

## Steps

1. **Locate the plugin.** It MUST live directly under `~/plugins/` — that's the only
   directory the container mount reads. If the user cloned it elsewhere, have them
   move/clone it there first: `git clone <url> ~/plugins/<name>`.

2. **Run the deterministic enabler** (generates the Claude/Codex manifests if missing,
   re-syncs OpenCode skills, and classifies the plugin):

   > **The OpenCode step is a FULL re-sync of every plugin, not a mirror of the one
   > you named, and it has a delete pass.** Any skill directory carrying
   > `.nanoclaw-managed` whose source plugin no longer exists under `~/plugins` is
   > removed and does not come back — there is nothing left to re-sync it from.
   > **You cannot tell from the mirror which entries would go.** A mirrored skill
   > directory carries only a copied `SKILL.md` and a constant `.nanoclaw-managed`
   > marker — no source path — so listing it identifies neither the supplying plugin
   > nor the orphans. Preserve every managed entry instead:
   >
   > ```bash
   > for d in ~/.local/share/opencode-*/skill ~/.config/opencode/skill; do
   >   [ -d "$d" ] && cp -aL "$d" "$d.pre-sync-$(date +%Y%m%dT%H%M%S)"
   > done
   > ```
   >
   > **`-L` is load-bearing.** `syncSkillSymlinks` fills each mirrored skill with
   > per-child symlinks into `~/plugins/<name>/…`, and `cp -a` implies `-d`
   > (`--no-dereference`), so it archives the links rather than their contents. On a
   > live mirror that is 11 symlinks and 2 real files versus 310 real files with `-L`.
   >
   > Then diff after the run to see what the sync removed, and restore anything you
   > still want by re-cloning its plugin into `~/plugins` — a copy-back alone is
   > pruned again on the next sync.
   >
   > One honest limit: if a source plugin is ALREADY gone, its mirror entries are
   > dangling links and there is nothing left to copy — `cp -aL` fails on them and the
   > content is unrecoverable from the mirror. This backup protects you while the
   > source still exists; it cannot resurrect an orphan. (Entries that happen to hold
   > real files rather than links do survive, so run it regardless.)
   > Scoped mirrors (`~/.local/share/opencode-<group>/`) exist only for groups with
   > their own `auth.json`; the rest share the global dir.

   **`--report-json` is not a probe — it writes.** It only changes the OUTPUT
   FORMAT. Every mutation in `main()` is gated on `dryRun` alone: manifest
   generation, `resolveDenySiblings`, `applyOptOut`, and — the dangerous one —
   `syncOpenCodePluginSkills()` at `if (!dryRun)`. Running it "just to see the
   classification" performs the full OpenCode sync, delete pass included. Pair it
   with `--dry-run` to inspect safely, then re-run without:

   ```bash
   # safe: classify only, writes nothing
   pnpm exec tsx scripts/enable-agent-plugin.ts <name> --dry-run --report-json

   # commits the change (manifests + OpenCode sync)
   pnpm exec tsx scripts/enable-agent-plugin.ts <name> --report-json
   ```

   Read the JSON. `sessionStartHook: true` means it's an always-on "mode" plugin →
   do step 3. `false` means skills-only → skip to step 5. `codexRegisterable: true`
   means Codex **containers** will register it themselves at spawn — there is no
   command for you to run.

3. **Author the always-on ruleset** (only when `sessionStartHook` is true and
   `hasAlwaysOnFile` is false/stub). This is the one judgment step — do NOT dump the
   raw hook output. Read the plugin's hook/instructions/primary `SKILL.md`, then write
   `~/plugins/<name>/.nanoclaw-always-on.md` containing the **clean, condensed** ruleset:
   - **Strip runtime noise**: activation banners ("X MODE ACTIVE"), statusline/setup
     nudges, and anything host-Claude-specific. Codex/OpenCode agents should see only
     the behavioral rules.
   - **Keep it tight, but NEVER condense away the plugin's own carve-outs.** If a rule
     has an exception or scope limit in the source ("only unrequested prose", "unless
     the user asks", "except at trust boundaries"), the condensed version MUST carry
     it. A ruleset once lost its requested-explanation carve-out in transcription,
     which turned an output cap into an absolute that contradicted the Completion
     Protocol in the same AGENTS.md — an exception IS the rule's scope, not optional
     detail.
   - Size is not a constraint worth distorting rules for: container Codex spawns set
     `project_doc_max_bytes=262144` (codex-app-server.ts), and nothing evicts sections
     anymore. Condense for signal, not for bytes.
   - This file is what `composeGroupClaudeMd` folds into every non-Claude group.

4. **Re-run the enabler** so it re-checks the now-present ruleset file (drop
   `--report-json` for the human summary; both forms write either way):

   ```bash
   pnpm exec tsx scripts/enable-agent-plugin.ts <name>
   ```

5. **Per-provider SKILLS denial (`--deny` / `--allow`).** These mutate
   `~/plugins/<name>/.nanoclaw-plugin.json` (`{ "denySiblings": [...] }`), read by
   `readPluginDenySiblings` inside `discoverPortableSkills`. Two limits make this
   narrower than "per-provider opt-out", and both bite silently:

   - **It withholds SKILLS ONLY, never an always-on ruleset.** `composeGroupClaudeMd`
     consults the group's `excludePlugins` and nothing else (`src/claude-md-compose.ts:167`)
     — it does not read `denySiblings`. A denied mode plugin keeps injecting its
     behavioural rules into that provider after restart. To withhold the ruleset too,
     use `excludePlugins`.
   - **`--deny claude` does nothing.** The Claude mount assembly checks only
     `containerConfig.excludePlugins` (`src/container-runner.ts:4753-4767`) and never
     reads the marker, so the plugin stays mounted and auto-loads via
     `CLAUDE_PLUGINS_ROOT` — the more so after step 2 generated its Claude manifest.
     Use `excludePlugins` for Claude.

   So reach for it only to keep a plugin's skills off Codex/OpenCode while leaving
   Claude alone:

   ```bash
   pnpm exec tsx scripts/enable-agent-plugin.ts <name> --deny opencode
   pnpm exec tsx scripts/enable-agent-plugin.ts <name> --allow opencode
   ```

6. **Group opt-out (default is all groups).** If the user wants specific groups excluded,
   re-run with `--exclude` — this writes `excludePlugins` into each group's
   `container.json`, which drops the Claude mount and skips the Codex/OpenCode
   ruleset. It does **not** remove the plugin's skills from an OpenCode group:
   `syncOpenCodePluginSkills()` takes no group argument and never reads
   `excludePlugins`, so the XDG skill mirror is unaffected:

   ```bash
   pnpm exec tsx scripts/enable-agent-plugin.ts <name> --exclude <folder1>,<folder2>
   ```

   Note opt-out is per **group folder** (e.g. `main`, `main-codex`, `main-opencode` are
   three separate groups), so excluding a workgroup means naming every sibling.

   **Per-group opt-out is not achievable for an OpenCode sibling.** Excluding it drops
   the ruleset, but the skill mirror is synced globally with no per-group filter, so
   that agent keeps the plugin's commands, and nothing later in this skill removes
   them. Deleting the mirrored directory by hand is undone by the next sync.

   Two durable options, neither per-group:

   - **Withhold from OpenCode everywhere, keep Claude and Codex.** Combine
     `--deny opencode` (drops the skills from OpenCode discovery) with
     `excludePlugins` on the affected groups (drops the ruleset). The tradeoff is that
     `--deny` is provider-wide: EVERY OpenCode group loses the skills, not just the
     ones you excluded.
   - **Withhold everywhere.** Keep the plugin out of `~/plugins`.

   If you need it gone from one OpenCode group but present on another, that is not
   supported today — it needs a per-group filter in `syncOpenCodePluginSkills()`.

7. **Build + restart.** The composer is host `src/`, so it needs a build, and running
   containers only pick up new mounts/instructions on respawn:

   ```bash
   pnpm run build
   sudo systemctl restart nanoclaw-v2
   ```

   (Surface the restart command and let the user run/approve it if they prefer.)

## Verify

After respawn:
- **Claude** groups: the plugin loads via the mount (confirm the manifest exists). Its
  SessionStart hook fires if it has one.
- **Codex** groups: the container registered the plugin itself at spawn — skills appear
  namespaced `<plugin>:<skill>`. Predict it without a container:
  `bun -e "import {planCodexPluginRegistration} from './container/agent-runner/src/codex-companion-setup.ts'; console.log(planCodexPluginRegistration('/home/ubuntu/plugins').filter(p=>p.name==='<name>'))"`
  → expect `action: "register"`.
- **OpenCode** groups: the skills appear as commands (mirrored in step 2).
- For mode plugins, the condensed ruleset is in `groups/<folder>/AGENTS.md` — spot-check
  one Codex group: `grep -c "<a distinctive ruleset phrase>" groups/<name>-codex/AGENTS.md`.

## Notes

- **Skills-only plugins** (no SessionStart hook): steps 3–4 don't apply. They're live on
  all three on the next spawn; a build+restart is only needed if a manifest was generated.
  Note the reverse is not symmetric: reaching all three is automatic, but WITHHOLDING from
  OpenCode is not — see the opt-out limits in step 6.
- Generated manifests (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
  `.agents/plugins/marketplace.json`) are written into the plugin's own repo (it's your
  clone). Commit them there if you want them to survive a re-clone.
- If the user explicitly asks for the plugin in their **own** `codex`/`claude` CLI, that's
  a separate request outside this skill — do it deliberately and say what host state it
  changes, don't fold it into the fleet enablement.
- `~/plugins/<name>/.nanoclaw-always-on.md` is the opt-in marker for always-on injection.
  Delete it (then rebuild) to make a plugin skills-only again.
