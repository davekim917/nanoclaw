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
| **Workgroup scope** | `data/plugin-scopes.json`: mounts only in the listed workgroups | same, and the ruleset and subagent mirror skip it elsewhere | the ruleset skips it elsewhere; the skill and subagent mirrors never copy it |

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
   > One limit, and it is narrower than "unrecoverable": if a source plugin is ALREADY
   > gone, its mirror's linked children are dangling and `cp -aL` exits non-zero on
   > them — but it still copies every regular file it reaches, and a managed mirror
   > always stores `SKILL.md` and `.nanoclaw-managed` as real files. So the skill's
   > instructions survive; only the linked attachments (`scripts/`, `reference/`, …)
   > are lost. Measured on an orphan with one dangling child:
   >
   > ```
   > cp: cannot stat '.../demo/scripts': No such file or directory   # exit 1
   > BACKUP/demo/SKILL.md            <- intact
   > BACKUP/demo/.nanoclaw-managed   <- intact
   > ```
   >
   > **Run it regardless and keep the result even though `cp` reports failure** — the
   > next sync deletes the original, and this is the last copy of the instructions.
   > Scoped mirrors (`~/.local/share/opencode-<group>/`) exist only for groups with
   > their own `auth.json`; the rest share the global dir. Watch the case where a
   > group HAD scoped auth and `auth.json` was later removed: the sync stops targeting
   > the dir (`discoverOpenCodeXdgTargets` skips a sibling with no `auth.json`,
   > `src/opencode-sync.ts:194-195`) while the container still prefers it, because
   > `resolveOpenCodeSourcePaths` picks the scoped `skill/` dir purely on existence
   > (`src/providers/opencode.ts:148`). That group then serves a frozen mirror
   > forever — neither updated nor sharing the global one. Check for it before
   > trusting a sync result:
   >
   > ```bash
   > for d in ~/.local/share/opencode-*/; do
   >   [ -d "$d/skill" ] && [ ! -f "$d/auth.json" ] && echo "STALE: $d"
   > done
   > ```
   >
   > Prefer restoring the group's `auth.json` — the dir becomes a sync target again and
   > nothing is lost. Do **not** just delete the `skill/` dir: it can also hold skills
   > installed by hand or natively, which `syncSkillSymlinks` deliberately keeps
   > (`fs.rmSync` runs only behind an `isManagedMirror(entryPath)` gate,
   > `src/plugin-skill-discovery.ts:465`). That protection covers **directories only**:
   > an undesired top-level *symlink* is `unlinkSync`ed unconditionally, before the
   > managed check is ever reached (`:459-463`), so a skill you installed as a symlink
   > is removed by any full re-sync. Materialize such a skill as a real directory, or
   > keep it outside the mirror, before syncing. If you do want the global fallback, move the dir aside and migrate
   > the non-managed entries. Identify them by the marker, not by their contents:
   > `isManagedMirror` returns `entries.includes('.nanoclaw-managed')`
   > (`src/plugin-skill-discovery.ts:545`), and an empty dir also counts as managed.
   > A managed mirror holds real files — `SKILL.md` is copied, not linked, because
   > Codex auto-discovery skips symlinked `SKILL.md` — so "all children are symlinks"
   > is not the test and would misclassify in both directions:
   >
   > ```bash
   > for d in ~/.local/share/opencode-<group>/skill/*/; do
   >   [ -e "$d/.nanoclaw-managed" ] || echo "KEEP (not managed): $d"
   > done
   > ```

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
   - This file is what `composeGroupClaudeMd` folds into each non-Claude group that has
     not excluded the plugin (`src/claude-md-compose.ts:167,177`). Claude groups get the
     ruleset through the plugin mount instead, not through this path.

4. **Re-run the enabler** so it re-checks the now-present ruleset file (drop
   `--report-json` for the human summary; both forms write either way):

   ```bash
   pnpm exec tsx scripts/enable-agent-plugin.ts <name>
   ```

5. **Withholding a plugin — read this before promising anyone an opt-out.**

   Three mechanisms exist and none of them is a general per-provider, per-group
   switch. Every statement below was measured against this tree, not inferred:

   | Mechanism | Claude | Codex | OpenCode |
   |---|---|---|---|
   | `excludePlugins` (per group, via `--exclude`) | drops the mount | drops **both** | drops the ruleset, **keeps the skills** |
   | `--deny <provider>` (per plugin, all groups) | only before a manifest exists | drops the skills, **keeps the ruleset** | drops the skills, **keeps the ruleset** |
   | remove from `~/plugins` | effective | effective | **does not remove already-synced skills** |

   `excludePlugins` is the only per-group opt-out, and it is not uniform. (A plugin that
   carries one workgroup's content belongs in `data/plugin-scopes.json` instead: opt-in,
   and uniform across all three providers. See docs/workgroups.md.) The plugin
   mount in `src/container-runner.ts:4888-4916` has no provider conditional, so an
   excluded plugin is absent from `/workspace/plugins` for every provider — which is
   why Codex loses its skills too: `planCodexPluginRegistration` reads that mount, and
   the entry simply never appears (`container/agent-runner/src/codex-companion-setup.ts`
   says so in its own comment). OpenCode is the exception because its skills come from
   the XDG mirror, not the mount. **So for a Codex group, prefer `--exclude` over the
   provider-wide `--deny codex`** — it already withholds both halves, for that group only.

   The three traps, each with the code that causes it:

   - **`--deny` never withholds an always-on ruleset.** `composeGroupClaudeMd` reads
     the group's `excludePlugins` and nothing else (`src/claude-md-compose.ts:168`);
     it does not consult `denySiblings`. A denied mode plugin keeps injecting its
     rules after restart.
   - **`--deny claude` works only on a plugin that has no Claude manifest yet.**
     `deny.has('claude')` skips `generateClaudeManifest`
     (`scripts/enable-agent-plugin.ts:480`), so it prevents one being created. Once a
     manifest exists — shipped with the plugin, or generated by an earlier step 2 —
     the mount assembly reads only `containerConfig.excludePlugins`
     (`src/container-runner.ts:4888-4916`) and the plugin auto-loads regardless. Use
     `excludePlugins` for Claude on an already-enabled plugin.
   - **Order matters when removing from OpenCode: deny first, delete second.**
     `--deny opencode` DOES prune an already-synced mirror, because
     `resolveDenySiblings()` writes the marker before `syncOpenCodePluginSkills()`
     runs (`scripts/enable-agent-plugin.ts:478,524`); discovery then omits the
     skills and the cleanup pass `rmSync`s every managed entry no longer desired.
     But that path exists only while the plugin is still in `~/plugins`. Delete the
     source first and it is unreachable — the enabler refuses an absent plugin
     (`error: not a directory`), and the mirrored `SKILL.md` is a real copied file
     (verified: 30 KB regular file, not a link), so it survives and keeps being
     copied into new sessions by `src/providers/opencode.ts`. Deleting the mirror by
     hand is undone by the next sync while the source still exists.

   So to withhold from OpenCode, deny **while the plugin is still present**, then
   remove it from `~/plugins` if you want it gone entirely:

   ```bash
   pnpm exec tsx scripts/enable-agent-plugin.ts <name> --deny opencode
   ```

   Already deleted the source first? The mirror is stale but not stranded.
   `syncOpenCodePluginSkills()` takes no arguments (`src/opencode-sync.ts:242`): it
   rebuilds the desired set from the whole `~/plugins` root and prunes every managed
   entry not in it. So enabling **any** remaining plugin runs the same reconciliation
   and drops the orphan. Only a plugins root with nothing left to enable has no route.

   One target it cannot reach: a scoped mirror whose `auth.json` is gone.
   `discoverOpenCodeXdgTargets` skips those siblings (`src/opencode-sync.ts:194-195`),
   so reconciliation visits the global dir and the still-authenticated scoped ones only.
   An orphan sitting in a stale scoped dir survives every reconcile — repair it with the
   stale-mirror steps in step 1's preflight, not by enabling another plugin.

   To reverse a denial — a separate operation, not the next step above:

   ```bash
   pnpm exec tsx scripts/enable-agent-plugin.ts <name> --allow opencode
   ```

   Note `--deny` is provider-wide: every OpenCode group loses the skills, not just one.
   Per-group would need a filter in `syncOpenCodePluginSkills()`; for a single group,
   there is no OpenCode equivalent of the Codex `--exclude` result.

6. **Group opt-out (default is all groups).** `--exclude` writes `excludePlugins` into
   each named group's `container.json`. Opt-out is per **group folder** — `main`,
   `main-codex` and `main-opencode` are three separate groups — so excluding a
   workgroup means naming every sibling. See the table in step 5 for what it does and
   does not reach on each provider.

   ```bash
   pnpm exec tsx scripts/enable-agent-plugin.ts <name> --exclude <folder1>,<folder2>
   ```

7. **Build + restart.** The composer is host `src/`, so it needs a build, and running
   containers only pick up new mounts/instructions on respawn:

   ```bash
   pnpm run build
   sudo systemctl restart nanoclaw-v2
   ```

   (Surface the restart command and let the user run/approve it if they prefer.)

## Verify

After respawn. **Every expectation below depends on which withholding you applied in
step 5** — with an opt-out in force, absence is the success case, and an agent that
treats it as a fault will undo the opt-out trying to repair it.

- **Claude** groups: with no opt-out, the plugin loads via the mount (confirm the
  manifest exists) and its SessionStart hook fires if it has one. If the group is named
  in `--exclude`, the mount is dropped and absence is correct. `--deny claude` is not a
  verification path here: it only prevents a manifest being generated, so on a plugin
  that already has one the plugin still loads (see the trap in step 5).
- **Codex** groups: the container registered the plugin itself at spawn — skills appear
  namespaced `<plugin>:<skill>`. Predict it without a container:
  ```bash
   # from container/agent-runner/ — matches single plugins AND marketplace monorepos,
   # whose sub-plugins are named "<repo>/<entry>" with the directory in repoName
   bun -e "import {planCodexPluginRegistration as plan} from './src/codex-companion-setup.ts'; \
     const n='<name>'; \
     console.log(plan('/home/ubuntu/plugins').filter(x=>x.name===n||x.repoName===n) \
       .map(x=>x.name+' -> '+x.action+(x.reason?' ('+x.reason+')':'')).join('\n'))"
   ```

   Filter on `repoName` as well as `name`: a marketplace monorepo's sub-plugins are
   labelled `<repo>/<entry>`, so matching `name` alone returns `[]` even when
   registration is planned correctly. **Always print `reason`** — it is what separates a
   deliberate opt-out from a real failure, and the expectation depends on which
   withholding you applied in step 5:

   | You did | Expect | Meaning |
   |---|---|---|
   | nothing | `-> register` | delivered to every Codex group |
   | `--deny codex` | `-> skip (denied-for-codex)` | **success** — `planCodexPluginRegistration` reads the marker at `codex-companion-setup.ts:634-636` |
   | `--exclude <group>` | `-> register` | expected, and this command cannot confirm the exclusion — see below |

   For any other `skip`, the reason says whether it is a fault:

   | Reason | Verdict |
   |---|---|
   | `in-tree-shadowed` | **expected.** The capability ships in-tree; mounting the plugin would duplicate it. Do not "fix" this by adding a plugin or MCP server. |
   | `no-marketplace-manifest`, `no-codex-plugin-manifest` | failure — step 2 did not produce manifests |
   | `not-a-directory` | failure — the plugin is missing from `~/plugins` |

   The plan reads the **host** `~/plugins` root, so a per-group `--exclude` never appears
   in it — that exclusion is applied when the container mount is built, per group. Verify
   that one against the group's own config instead:

   ```bash
   node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); \
     console.log(c.excludePlugins ?? [])" groups/<folder>/container.json
   ```

   (Read the JSON rather than grepping it — `container.json` is pretty-printed, so the
   array spans lines and a line-based `grep` for the key returns nothing useful.)
- **OpenCode** groups: branch on step 5 the same way, and note the two opt-outs land on
  opposite halves. With no opt-out, the skills appear as commands (mirrored in step 2).
  After `--deny opencode` the mirror is pruned, so the commands being **absent is the
  success case** — do not undo the denial to "fix" it — while any always-on ruleset
  stays, since `--deny` never withholds one. After `--exclude` it is the mirror image:
  the commands remain (they come from the XDG mirror, which the mount never touched) and
  the **ruleset** is gone, because `composeGroupClaudeMd` skips an excluded plugin
  (`if (excluded.has(name)) continue;`, `src/claude-md-compose.ts:177`). The two are not
  alternatives: `--deny` and `--exclude` parse independently in the same invocation and
  the sync and composition paths honour them separately, so applying both to one group
  withholds both halves and the correct expectation is that nothing appears.
- For mode plugins, the condensed ruleset is in `groups/<folder>/AGENTS.md` — spot-check
  a group **not** named in `--exclude`: `grep -c "<a distinctive ruleset phrase>"
  groups/<name>-codex/AGENTS.md`. On an excluded group the count is correctly `0` on
  every non-Claude provider, so picking one to spot-check would report the exclusion as
  a failure.

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
