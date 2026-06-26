---
name: enable-agent-plugins
description: Enable a ~/plugins/<name> plugin across all three container agent providers (Claude, Codex, OpenCode) with parity. Use after cloning a plugin repo into ~/plugins/ when you want its skills/commands — and, for "mode" plugins like ponytail, its always-on ruleset — available to every agent group. Default is all groups, with per-group opt-out.
---

# Enable Agent Plugins

Bring a plugin in `~/plugins/<name>` to **all three** container agent providers with
parity. The container mount + `CLAUDE_PLUGINS_ROOT` already gives Claude groups any
plugin that carries a Claude manifest — this skill closes the gaps that aren't
automatic: a missing Claude manifest, and always-on activation on Codex/OpenCode
(which fire **no** plugin hooks in NanoClaw containers).

## The model (why this skill exists)

NanoClaw does **not** run Codex's `.codex-plugin` or OpenCode's `opencode.json`
plugin systems. It re-implements the useful parts on its own surfaces, so you do
**not** generate three platform manifests. Parity decomposes like this:

| Plugin provides | Claude group | Codex group | OpenCode group |
|---|---|---|---|
| **Skills / commands** (`skills/<n>/SKILL.md`) | Claude manifest + mount | mirror → `~/.agents/skills/` | mirror → `~/.config/opencode/skill/` |
| **Always-on ruleset** (e.g. ponytail) | plugin SessionStart hook (auto) | `~/plugins/<n>/.nanoclaw-always-on.md` → `AGENTS.md`/`CLAUDE.md` | same |
| **Opt-out** | `excludePlugins` (drops mount) | skip the ruleset | skip the ruleset |

So the only artifacts ever worth generating are: **(1)** a Claude `plugin.json` if the
repo ships none, and **(2)** a condensed always-on ruleset for "mode" plugins.
Skills-only plugins need neither — they already reach all three on the next spawn.

## Steps

1. **Locate the plugin.** It MUST live directly under `~/plugins/` — that's the only
   directory the container mount reads. If the user cloned it elsewhere, have them
   move/clone it there first: `git clone <url> ~/plugins/<name>`.

2. **Run the deterministic enabler** (generates a Claude manifest if missing, mirrors
   skills to Codex + OpenCode, and classifies the plugin):

   ```bash
   pnpm exec tsx scripts/enable-agent-plugin.ts <name> --report-json
   ```

   Read the JSON. `sessionStartHook: true` means it's an always-on "mode" plugin →
   do step 3. `false` means skills-only → skip to step 5.

3. **Author the always-on ruleset** (only when `sessionStartHook` is true and
   `hasAlwaysOnFile` is false/stub). This is the one judgment step — do NOT dump the
   raw hook output. Read the plugin's hook/instructions/primary `SKILL.md`, then write
   `~/plugins/<name>/.nanoclaw-always-on.md` containing the **clean, condensed** ruleset:
   - **Strip runtime noise**: activation banners ("X MODE ACTIVE"), statusline/setup
     nudges, and anything host-Claude-specific. Codex/OpenCode agents should see only
     the behavioral rules.
   - **Keep it tight.** Codex caps `AGENTS.md` at ~32KB and drops sections to fit; a
     bloated ruleset evicts NanoClaw's own instructions. Aim for the essential rules,
     not the full README. (For ponytail specifically, this matches its own ethos.)
   - This file is what `composeGroupClaudeMd` folds into every non-Claude group.

4. **Re-run the enabler** so it re-checks the now-present ruleset file (no `--report-json`
   this time, to see the human summary):

   ```bash
   pnpm exec tsx scripts/enable-agent-plugin.ts <name>
   ```

5. **Opt-out (default is all groups).** If the user wants specific groups excluded,
   re-run with `--exclude` — this writes `excludePlugins` into each group's
   `container.json`, which drops the Claude mount AND skips the Codex/OpenCode ruleset:

   ```bash
   pnpm exec tsx scripts/enable-agent-plugin.ts <name> --exclude <folder1>,<folder2>
   ```

   Note opt-out is per **group folder** (e.g. `main`, `main-codex`, `main-opencode` are
   three separate groups). To opt a workgroup out entirely, exclude all its siblings.

6. **Build + restart.** The composer is host `src/`, so it needs a build, and running
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
- **Codex / OpenCode** groups: the skills appear as commands (already mirrored in step 2);
  for mode plugins, the condensed ruleset is in `groups/<folder>/AGENTS.md`.

Spot-check one Codex group: `grep -c "<a distinctive ruleset phrase>" groups/<name>-codex/AGENTS.md`.

## Notes

- **Skills-only plugins** (no SessionStart hook): steps 3–4 don't apply. They're live on
  all three on the next spawn; a build+restart is only needed if a Claude manifest was generated.
- The generated `.claude-plugin/plugin.json` is written into the plugin's own repo (it's
  your clone). Commit it there if you want it to survive a re-clone.
- `~/plugins/<name>/.nanoclaw-always-on.md` is the opt-in marker for always-on injection.
  Delete it (then rebuild) to make a plugin skills-only again.
