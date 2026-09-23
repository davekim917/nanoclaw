---
name: model-bump
description: "Adopt a newly released Anthropic or OpenAI model across the fleet: move the install default and family alias, bump the pinned CLI/SDK that must know the new id, ship the breaking-change contract (CHANGELOG, migration doc, versions.json) in the first push, then repin whatever should follow (groups, channel wirings, scheduled tasks, subagent defs, session stickies). Also answers 'what model/effort runs where'. Triggers: 'Opus X is out', 'new GPT model', 'bump the default model', 'make -m opus resolve to', 'move <agent/task> to <model>', 'model inventory'. Host session only."
---

# Model bump

A model release touches three layers. Only the first two need a PR.

| Layer | Where | How it changes |
|---|---|---|
| **Install default + aliases** | `src/flag-parser.ts` (`DEFAULT_OPUS_MODEL` / `_SONNET_` / `_HAIKU_`, `MODEL_ALIAS_MAP` incl. `fable`, `MODEL_EFFORT_SUPPORT`, `CODEX_MODEL_ALIAS_MAP`); Claude family default effort in `defaultEffortForModel` (`container/agent-runner/src/providers/claude.ts`); `DEFAULT_CODEX_MODEL` / `DEFAULT_CODEX_EFFORT` (`container/agent-runner/src/providers/codex.ts`) | PR → deploy → image rebuild |
| **Runtime that must know the id** | `container/Dockerfile` `CLAUDE_CODE_VERSION` + `@anthropic-ai/claude-agent-sdk` in `container/agent-runner/package.json` (same patch number); `CODEX_VERSION` | same PR |
| **Fleet pins** | `groups/<g>/container.json`, channel wirings, task pins, subagent frontmatter, session stickies | `ncl` / file edits, no deploy |

**Pins that say `opus` / `sonnet` / `haiku` follow their family default automatically; frozen ids (`claude-opus-5[1m]`) do not.** Those three are `FAMILY_DEFAULTS`, deliberately kept out of `MODEL_ALIAS_MAP`, and resolve at use, not at storage (`src/flag-parser.ts:101-110`). `ncl tasks list --json` shows a task pinned with `--model opus` as `opus`. When the user wants "the current Opus", write the family alias. Whether any other alias freezes depends on the **write path**:
- **Task pins and chat `-m` stickies** go through the flag vocabulary, which maps every `MODEL_ALIAS_MAP` / `CODEX_MODEL_ALIAS_MAP` entry to its concrete id at write. So `fable` (`src/flag-parser.ts:68`) and the Codex aliases `sol` / `luna` / `terra` / `astra` (`src/flag-parser.ts:274`) freeze there.
- **`ncl wirings update --default-model` and `ncl groups config update --model`** store their argument literally. A literal **Claude** alias there resolves at use and floats. **A Codex alias does not resolve at all**: the spawn path forwards the stored value unchanged as `NANOCLAW_CODEX_MODEL_OVERRIDE` (`src/container-runner.ts:6553-6555`), and the runner doesn't expand it (`container/agent-runner/src/config.ts:106`). So for a Codex group, always pass a full `gpt-*` id on both paths.
- **The agent's `set_channel_model` tool** writes the same wiring column, but it runs a Codex value through the flag parser first, so there a Codex alias freezes to its concrete id (`src/modules/channel-config/index.ts:105-111`, `:176`). A Claude value is stored literally.

A Fable or Codex bump therefore means repointing the alias entry *and* repinning every concrete id the step-1 inventory finds: task pins, stickies, channel wirings (`messaging_group_agents.default_model`), group `container.json` `model` / legacy `defaultModel` / `providerConfig.model` / `providerFallback.model`, and, for Codex, a host `CODEX_MODEL` if the step-1 check finds one (step 4).

## 1. Inventory: what runs where

Check a user's claim ("X is on Sonnet") against what actually ran before changing anything. It is often a stale session sticky, not a pin.

```bash
# Group config (authoritative). An indented line is inside providerConfig OR providerFallback: open the file to tell which.
grep -HE '"(provider|model|effort|reasoning_effort|defaultModel|defaultEffort)":' groups/*/container.json   # defaultModel/defaultEffort = legacy keys, still honoured
# Host-wide Codex default (below providerConfig.model, above DEFAULT_CODEX_MODEL). Check BOTH sources:
# the host loads .env into process.env after exec, so the service environ alone misses it (src/main.ts:230-253, called at :618).
# Either one set = the effective default. The environ wins over .env, because .env never overrides an existing key (src/main.ts:249).
tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value nanoclaw-v2)/environ | grep -E '^CODEX_MODEL='
grep -E '^\s*CODEX_MODEL=' .env
# Channel wiring overrides
pnpm exec tsx scripts/q.ts data/v2.db "select mga.id, mg.name, mga.agent_group_id, mga.default_model, mga.default_effort from messaging_group_agents mga join messaging_groups mg on mg.id = mga.messaging_group_id where coalesce(mga.default_model,'') <> '' or coalesce(mga.default_effort,'') <> ''"
# Scheduled-task pins
ncl tasks list --json   # rows with model_pin / effort_pin
# Subagent defs: group-local, then plugin agents
grep -rHE '^(model|effort):' groups/*/.claude/agents
find ~/plugins -type d -name agents -not -path '*/node_modules/*' -exec grep -rHE '^(model|effort):' {} +   # plugin agents (delegation roles live here, not in trunk)
# What actually ran
pnpm exec tsx scripts/q.ts data/v2.db "select agent_group_id, trigger, model, effort, count(*) from turn_usage where ts > '<ISO since>' group by 1,2,3,4 order by 1"
```

Session stickies: use the `outbound.db` sweep in the **Detect** block of `docs/codex-default-model.md` (change the `like` pattern to the id you are looking for).

## 2. Does the image's CLI serve the id?

Test against the **container's** pinned CLI, never the host's.

Use **this install's** image. Each install has its own image name (`container/build.sh:39-44`), and a group with `imageTag` in its `container.json` spawns from that image instead (`src/container-runner.ts:1688`). If you're probing for one group, use its running container's image.

- **Claude**: an id the CLI binary doesn't contain silently loses its family behaviour (1M window, effort ladder). Grep the image, with the current default as a control:
  ```bash
  # From the install root, not a worktree: the name is derived from the checkout path.
  IMG=$(pnpm exec tsx -e "import('./src/config.ts').then(m => console.log(m.CONTAINER_IMAGE))" | tail -1)
  docker run --rm --entrypoint sh "$IMG" -c 'p=$(find / -path /proc -prune -o -type d -path "*@anthropic-ai/claude-code" -print 2>/dev/null | head -1); grep -rlao "<new-id>" "$p" | wc -l'
  ```
  If the count is 0, the id needs a newer CLI. Take the audited latest (step 3), which must contain the id; if it doesn't, the model can't be adopted yet.
- **Codex**: the server gates new models **by client version**, and the binary's catalog doesn't list them either way. Grepping proves nothing. Probe each candidate version with a real call under the fleet's auth (ChatGPT account): `codex exec -m <new-id> -c model_reasoning_effort=<effort> "reply ok"`. On 2026-09-22 `gpt-6-sol` returned HTTP 400 on 0.154.0 and worked on 0.155.1. Move the container's CLI with the audited `docker:codex` item (step 3), and keep it equal to the host's `codex --version`.

## 3. The PR: everything in the first push

Work in a scratch worktree off `origin/main`, never the live checkout. **One PR = the runtime change only.** Tooling, inventory scripts, and review-policy changes go in their own PRs.

Code:
- New Claude id: add pinned aliases to `MODEL_ALIAS_MAP` (e.g. `opus55`, `opus5-5`, `opus-5-5` → `claude-opus-5-5[1m]`; Opus and Fable always carry `[1m]`), and add a `MODEL_EFFORT_SUPPORT` row.
- Default: change the constant for the family that shipped: `DEFAULT_OPUS_MODEL`, `DEFAULT_SONNET_MODEL`, or `DEFAULT_HAIKU_MODEL` (`src/flag-parser.ts:97-99`; bare `opus`/`sonnet`/`haiku` resolve through these), the `fable` entry in `MODEL_ALIAS_MAP`, or `DEFAULT_CODEX_MODEL`. For Codex, also repoint the family alias in `CODEX_MODEL_ALIAS_MAP`. Update that family's resolution tests in `src/flag-parser.test.ts`.
- Default effort: `defaultEffortForModel` is the only place a Claude family default lives (`src/claude-spawn-defaults.ts` derives none). For Codex it is `DEFAULT_CODEX_EFFORT`.
- CLI/SDK pins: never hand-edit the manifests. Go through the audited flow (`docs/dependency-updates.md`), which rejects prerelease and yanked releases and regenerates the lock deterministically:
  ```bash
  bun scripts/container-updates.ts audit --format json        # item ids: docker:claude-code, bun:@anthropic-ai/claude-agent-sdk, docker:codex
  bun scripts/container-updates.ts apply --repo <worktree> --items docker:claude-code,bun:@anthropic-ai/claude-agent-sdk   # Claude bump
  bun scripts/container-updates.ts apply --repo <worktree> --items docker:codex                                             # Codex bump
  ```
  Then record the new pins in **`versions.json`**. `setup/lib/image-version-pins.test.ts` fails if `versions.json` drifts from the Dockerfile or `package.json`, or if claude-code and the SDK differ in patch number. If the audited latest versions of the two differ in patch number, stop and ask; don't hand-pick a pair. The SDK bump changes the deps hash, and spawns refuse until the image is rebuilt (`src/agent-runner-image-check.ts`), so the package edit and the rebuild ship together.
- New Codex id: add its `MIN_CODEX_CLI` row in `setup/lib/codex-model-min-cli.test.ts` with the minimum version the step-2 probe proved. The test fails when `DEFAULT_CODEX_MODEL` or the `sol` / `luna` / `terra` / `astra` alias targets have no row. Those are hard-coded, so a new alias family needs its own case added to the test.

Contract (CONTRIBUTING.md "Breaking Changes"). A moved default is breaking:
- A `[BREAKING]` CHANGELOG entry saying what moves, what's required (CLI minimum, image rebuild), and a link to the migration doc.
- A migration section in `docs/claude-default-model.md` or `docs/codex-default-model.md` with **detect / why / fix / verify / rollback**. Mark the old section as history. Facts the first draft got wrong last time:
  - a pure task fire ignores session stickies (`effectiveTurnSettings`, `container/agent-runner/src/poll-loop.ts:4029`);
  - a group's `providerConfig.model` outranks the wiring (`container/agent-runner/src/providers/claude.ts:2770`: `input.model ?? stickyConfig.model ?? NANOCLAW_CLAUDE_MODEL ?? ANTHROPIC_DEFAULT_OPUS_MODEL`);
  - a host restart **adopts** running containers, which keep their spawn-time runner and CLI. Tell operators to recycle with `ncl groups restart`.

Tests:
- Resolution tests reference `DEFAULT_OPUS_MODEL`. The one deliberate literal is `claude_spawn_env_matches_the_live_fleet_baseline` (`src/claude-spawn-defaults.test.ts`); change it on purpose.
- A family-effort change also moves the container tests in `container/agent-runner/src/providers/`: `claude.configSchema`, `claude.resolvedModelEffort`, `claude.spawnEndToEnd`, `claude.fallbackConfig`, `claude.turn-usage-effort`.
- Run them throttled, per CLAUDE.md "Development": the host files you touched plus `setup/lib/image-version-pins.test.ts` and `setup/lib/codex-model-min-cli.test.ts`; in the container, `bun test src/providers/` and `bun run typecheck`.
- Regenerate the ratchet: `pnpm run ratchet:report -- --write`.

Then follow the repo's merge gate. Deploy is the deployer's job, and the restart needs operator approval.

### Before the host restart: per-group images

Do this after the base `./container/build.sh` and before the host restart. A group with `imageTag` in its `container.json` spawns from that image (`src/container-runner.ts:1688`), and a base rebuild doesn't rebuild it (`src/agent-runner-image-check.ts:275-281`). If it isn't rebuilt, the group breaks in one of two ways:
- **Codex-only bump:** the deps hash doesn't change, so the group spawns the new default on its old baked CLI and gets the HTTP 400.
- **Claude SDK bump:** the group fails the deps-drift check and refuses to spawn.

List them with `grep -lE '"imageTag"' groups/*/container.json`, then rebuild according to how each image was made:
- A package image built by `install_packages` (tag `<image base>:<group-id>`, packages set in `container_configs`): `ncl groups restart --id <group-id> --rebuild` (`buildAgentGroupImage`, `src/container-runner.ts:7606`). This also recycles the group's containers and kills in-flight work, so run it at a quiet moment.
- Any other tag is an operator-supplied custom image. `--rebuild` would fail ("No packages to install", `src/container-runner.ts:7614-7615`) or build a different tag. Rebuild it with its own build process, on top of the new base.

## 4. Fleet pins (no deploy)

**Never pin a live task or wiring to an id the running image can't serve.** Wait until the deploy that carries the CLI is live.

**Deployed is not enough for task pins and stickies.** They apply per turn inside whatever container is already running (`effectiveTurnSettings`, `container/agent-runner/src/poll-loop.ts:4071`; `resolveQueryModel`, `container/agent-runner/src/providers/codex.ts:1222`). A host restart *adopts* running containers, and they keep their old CLI. So a repin right after deploy can send the new id to an old-CLI container; for Codex that's the HTTP 400. Before repinning a task or setting a sticky:
1. Check that the session's container is gone or on the new image. Find it in `docker ps` by its `nanoclaw-session=<session-id>` label, or all of a group's containers by `nanoclaw-group=<folder>` (`src/container-runner.ts:7549-7557`). Then compare `docker inspect -f '{{.Image}}' <container>` (always a `sha256:` id) with `docker image inspect -f '{{.Id}}' "$IMG"` (`$IMG` from step 2; for an `imageTag` group, that group's own tag). As a quick visual check: after the base rebuild, `docker ps`'s IMAGE column shows a bare hex id for an old-image container instead of the tag.
2. If it's still on the old image, recycle the group first with `ncl groups restart --id <group-id>`, at a quiet moment.
3. For `ncl tasks repin --all`, which repins every group at once: run the step-5 rollover listing first, and recycle every group that still has an old-image container.

```bash
ncl tasks update --id <series> --group <ag-id> --model opus --effort low       # "" clears
ncl tasks repin --all --from-model <old> --to-model <new> --dry-run             # bulk; literal match, see `ncl tasks help repin`
ncl tasks repin --all --from-model <old> --to-model <new>                       # then apply, after reviewing the dry-run report
ncl wirings update <mga-id> --default-model opus --default-effort low          # "" clears; applies at the next spawn, a running session keeps its old value
ncl groups config update --id <ag-id> --model <full-id> --effort medium        # writes DB + container.json; applies at restart
```

- **`providerConfig.model`, `providerFallback.model`, and legacy `defaultModel` have no `ncl` verb.** `groups config update --model` writes only `model` (`src/cli/resources/groups.ts:693`). Repin those three by editing `groups/<g>/container.json` directly:
  - check `git -C groups status` first, since another session may have uncommitted edits;
  - the edit applies at the group's next restart;
  - the `container_configs` DB projection doesn't see it, so `ncl groups config get` won't show it. Read the file to confirm.

- **Host `CODEX_MODEL`** (found by the step-1 check) overrides `DEFAULT_CODEX_MODEL` for every Codex group with nothing more specific set, so a Codex bump does nothing for them while it's set. Change or remove it at its source: the service unit's environment wins (`systemctl show nanoclaw-v2 -p Environment`, set in a unit drop-in); otherwise `.env`, since `.env` never overrides an existing key (`src/main.ts:249`). The host reads it once at startup, and each container gets it at spawn (`src/providers/codex.ts:157-160`). So the change needs a host restart (operator approval) and then a recycle of each running Codex group.

- **Subagent defs**: edit the canonical source.
  - Group-local: `groups/<g>/.claude/agents/*.md`. Check `git -C groups status` first; another session may have uncommitted edits.
  - Plugin agents: the plugin's own repo.
  - `.codex/agents/*.toml` carrying `# managed by nanoclaw codex-sync` are generated mirrors (`src/codex-sync.ts`); never edit one.
  - Keep model names out of descriptions and prose. Frontmatter is the only place a model is named.
- **Session stickies** come from a chat `-m`/`-e`, which writes `sticky_model`/`sticky_effort` to that session's `outbound.db` `session_state` (`setStickyModel` in `applyFlagBatch`, `container/agent-runner/src/poll-loop.ts:3832`). They override the wiring and the group for that session only, and a bump doesn't move them. Report them; clear or set one only when asked. There is no `ncl` verb. The container owns `outbound.db`, so write only while that session's container is stopped: check `sessions.container_status` and the `nanoclaw-session` label in `docker ps`.
- **A task pin covers the task's own fires only.** The support poller also passes its pin to the issue threads it dispatches to, but as a one-turn flag on its own seed and customer-reply messages (`getSupportTaskContext`, `src/modules/support-threads/dispatch.ts`), so it never becomes a thread sticky. A human reply in a task post's thread routes to that channel's thread session. That session's order depends on the provider:
  - **Claude**: sticky → `providerConfig.model` → wiring → `container.json` `model` → legacy `defaultModel` → install default. The host folds the last four into `NANOCLAW_CLAUDE_MODEL` (`src/claude-spawn-defaults.ts:146-163`), and the runner puts `providerConfig.model` above that env (the `rawModel` chain, `container/agent-runner/src/providers/claude.ts:2839`). **Setting the wiring does nothing for a Claude group whose `providerConfig` sets a model**; change that group's config instead.
  - **Codex**: sticky (per turn, `container/agent-runner/src/providers/codex.ts:1222`) → wiring → `container.json` `model` → legacy `defaultModel` → `providerConfig.model` → host `CODEX_MODEL` env → install default. The host folds wiring, `model`, and `defaultModel` into `NANOCLAW_CODEX_MODEL_OVERRIDE` (`src/container-runner.ts:6553-6555`), and the runner takes that env ahead of `providerConfig.model` (`container/agent-runner/src/config.ts:131-137`). So a Codex group's `providerConfig.model` counts only when no wiring, `model`, or `defaultModel` is set, and a repin that touches only `providerConfig` leaves such a group on the old model. Below all of those, the host's own `CODEX_MODEL` env is forwarded to the container (`src/providers/codex.ts:157-160`) and sits just above `DEFAULT_CODEX_MODEL` (`container/agent-runner/src/providers/codex.ts:1102`): if it's set, it becomes the effective default, not the bump.

  To make follow-ups match the task, set the channel's wiring (subject to the Claude exception above), or send `-e <level>` in the thread.

## 5. Verify after deploy

- A fresh container's env shows the new default for the family that moved: `ANTHROPIC_DEFAULT_OPUS_MODEL`, `_SONNET_MODEL`, or `_HAIKU_MODEL` (`src/claude-spawn-defaults.ts:240-249`). Unpinned groups run Opus, so a Sonnet, Haiku, or Fable bump shows in `turn_usage` only on a turn pinned to that family. For Codex, `docker exec <c> codex --version` shows the new CLI.
- `turn_usage` shows the new id for unpinned work. A config write proves only that the config was written.
- Every `imageTag` group's running container is on its rebuilt image (see "Before the host restart").
- Rollover: use plain `docker ps --format '{{.Names}} {{.Image}} {{.Label "nanoclaw-session"}}'`. `--filter ancestor=<old id>` misses containers whose image is now untagged. An old-image container is not a reason to kill in-flight work. Report it, and let it roll over or be recycled at a quiet moment.
