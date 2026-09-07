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
   > Before running, list what would go:
   > `ls ~/.local/share/opencode-*/skill ~/.config/opencode/skill` and check every
   > entry still has a live `~/plugins/<name>`. Copy anything orphaned aside first.
   > Scoped mirrors (`~/.local/share/opencode-<group>/`) exist only for groups with
   > their own `auth.json`; the rest share the global dir.

   ```bash
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

4. **Re-run the enabler** so it re-checks the now-present ruleset file (no `--report-json`
   this time, to see the human summary):

   ```bash
   pnpm exec tsx scripts/enable-agent-plugin.ts <name>
   ```

5. **Per-provider opt-out (`--deny` / `--allow`).** Separate from group exclusion:
   these mutate `~/plugins/<name>/.nanoclaw-plugin.json` (`{ "denySiblings": [...] }`),
   read by `readPluginDenySiblings` and applied inside `discoverPortableSkills`, so a
   plugin can be withheld from one provider while staying on the others. Use when a
   plugin is right for Claude but wrong for Codex/OpenCode, rather than excluding
   whole groups:

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
   three separate groups). To opt a workgroup out entirely, exclude all its siblings.

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
- Generated manifests (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
  `.agents/plugins/marketplace.json`) are written into the plugin's own repo (it's your
  clone). Commit them there if you want them to survive a re-clone.
- If the user explicitly asks for the plugin in their **own** `codex`/`claude` CLI, that's
  a separate request outside this skill — do it deliberately and say what host state it
  changes, don't fold it into the fleet enablement.
- `~/plugins/<name>/.nanoclaw-always-on.md` is the opt-in marker for always-on injection.
  Delete it (then rebuild) to make a plugin skills-only again.
