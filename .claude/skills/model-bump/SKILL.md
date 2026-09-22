---
name: model-bump
description: "Adopt a newly released Anthropic or OpenAI model across the fleet: move the install default and family alias, bump the pinned CLI/SDK that must know the new id, then repin whatever should follow it (groups, channel wirings, scheduled tasks, subagent defs, session stickies). Also produces the full model/effort inventory by provider, group, channel and task. Triggers: 'Opus X is out', 'new GPT model', 'bump the default model', 'make -m opus resolve to', 'move <agent/task> to <model>', 'model inventory', 'what model is X running'. Host session only."
---

# Model bump

A model release touches three layers. Only the first needs code.

| Layer | Where | How it changes |
|---|---|---|
| **Install default + aliases** | `src/flag-parser.ts` (`DEFAULT_OPUS_MODEL`, `MODEL_ALIAS_MAP`, `MODEL_EFFORT_SUPPORT`, `CODEX_MODEL_ALIAS_MAP`); family default effort in `defaultEffortForModel` (`container/agent-runner/src/providers/claude.ts`); `DEFAULT_CODEX_MODEL`/`DEFAULT_CODEX_EFFORT` (`container/agent-runner/src/providers/codex.ts`) | PR → review → deploy → image rebuild |
| **Runtime that must know the id** | `container/Dockerfile` `CLAUDE_CODE_VERSION` + `@anthropic-ai/claude-agent-sdk` in `container/agent-runner/package.json` (same trailing number); `CODEX_VERSION` for OpenAI — keep it equal to the host's `codex --version` so a wire shape verified on the host holds in the container | same PR |
| **Fleet pins** | `groups/<g>/container.json`, channel wirings, scheduled-task pins, subagent frontmatter, session stickies | `ncl` / file edits, no deploy |

**Pins that say `opus` / `sonnet` / `fable` follow the default automatically.** Frozen ids (`claude-opus-5[1m]`) do not. Whenever you set a pin because the user wants "the current Opus", write the family alias, not the id. That turns the next bump into a code-only change.

## 1. Inventory: always first, and the answer to "what runs where"

```bash
pnpm exec tsx scripts/model-inventory.ts            # --days N for the observed window, --json for machine output
```

It prints, in order: install defaults (code, CLI/SDK pins); every group's effective model/effort (from `container.json` or the install default), including any drift from the `container_configs` DB projection; channel wiring overrides; scheduled-task pins; subagent defs that name a model or effort; `-m`/`-e` stickies on active sessions; and what actually ran (`turn_usage`). A mismatch between the configured value and what actually ran is a finding. Check a user's claim against the observed section before you change anything: "X is on Sonnet" is often a stale sticky, not a pin.

## 2. Does the pinned runtime know the id?

A model id the CLI binary doesn't contain silently loses its family behavior (1M window, effort ladder). Check the image, not the host. The host CLI is usually newer.

```bash
IMG=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -m1 'nanoclaw-agent-v2-.*:latest')
docker run --rm --entrypoint sh "$IMG" -c 'p=$(find / -path /proc -prune -o -type d -path "*@anthropic-ai/claude-code" -print 2>/dev/null | head -1); grep -rlao "<new-id>" "$p" | wc -l'
```

Use a known id such as the current default as a control. If the count is 0, find the first release that has it (`npm view @anthropic-ai/claude-code dist-tags`, then target `latest`, never a newer `next`), and bump the CLI and the SDK together to the same trailing number. After editing `package.json`, run `bun install` in `container/agent-runner` and commit `bun.lock`. **Spawns are blocked until the image is rebuilt**: `src/agent-runner-image-check.ts` compares the deps hash and fails closed. The package edit and the image rebuild ship as one unit.

## 3. Code PR (scratch worktree, never the live checkout)

`git worktree add /home/ubuntu/nanoclaw-wt-<slug> -b feat/<slug> origin/main`. Then:

- **New Claude id**: add pinned aliases to `MODEL_ALIAS_MAP` (`opus55`, `opus5-5`, `opus-5-5` → `claude-opus-5-5[1m]`). Opus and Fable always carry `[1m]`, and `ensureOpus1mSuffix` already accepts both version schemes. Add a `MODEL_EFFORT_SUPPORT` row for the new id.
- **Make it the default**: change `DEFAULT_OPUS_MODEL` (or `DEFAULT_SONNET_MODEL` / `DEFAULT_CODEX_MODEL`). This single change moves every unpinned group, every `opus` alias pin, and every `model: opus` subagent.
- **Default effort change**: `defaultEffortForModel` in the container `claude.ts` is the only place a Claude family default lives (`src/claude-spawn-defaults.ts` says so and derives none). For Codex, change `DEFAULT_CODEX_EFFORT`.
- **Tests**: resolution tests reference `DEFAULT_OPUS_MODEL`. The one deliberate literal is `claude_spawn_env_matches_the_live_fleet_baseline` in `src/claude-spawn-defaults.test.ts`, and a bump must change it on purpose. Container tests that assert the family default effort (`claude.configSchema`, `claude.resolvedModelEffort`, `claude.spawnEndToEnd`, `claude.fallbackConfig`, `claude.turn-usage-effort`) change with it.
- Run, throttled: host `src/flag-parser.test.ts src/claude-spawn-defaults.test.ts src/container-runner.test.ts src/provider-surfaces.test.ts`, and in the container `bun test src/providers/` plus `bun run typecheck`.
- **Not in scope unless asked**: the PR-review reviewer roster (`scripts/reviewer-models.ts` → `reviewer-models.txt`) is review policy, not a default. Name it as a follow-up.

Open the PR and follow the repo's merge gate and deploy discipline. The deploy is merge → pull → build → `./container/build.sh` → restart, and the restart needs operator approval.

## 4. Fleet pins (no deploy)

Set these to what the user asked for. Prefer family aliases.

```bash
ncl tasks update --id <series> --group <ag-id> --model opus --effort low      # per-fire task pin ("" clears)
ncl tasks repin --all --from-model <old> --to-model <new> --dry-run            # bulk-move frozen pins
ncl wirings update <mga-id> --default-model opus --default-effort low         # per-channel default
ncl groups config update --id <ag-id> --model opus --effort medium            # group default (writes DB + container.json)
```

- **Subagent defs** live in `groups/<g>/.claude/agents/*.md` (frontmatter `model:`/`effort:`) and `.codex/agents/*.toml` (`model`/`model_reasoning_effort`). Edit only the frontmatter lines. Another session may have uncommitted edits in the same file, so check `git -C groups status` first. Keep model names out of descriptions and prose, because config is the only place a model is named.
- **Stickies** (`sticky_model` in a session's `outbound.db`) override the group and channel for that session only. They come from someone typing `-m` and are not moved by a bump. Report them. Clear one only when asked. There is no `ncl` verb. The container owns `outbound.db`, so write to it only while that session's container is stopped: check `sessions.container_status` and the `nanoclaw-session` label in `docker ps`. Then delete the `sticky_model`/`sticky_effort` rows from `session_state`, or upsert new values. `src/session-close-expiry.ts` already writes `session_state` from the host under the same condition.
- A group model governs chat and scheduled work alike. There is no "Opus for chat, cheaper for tasks" knob. Use task pins for that.
- **A task pin covers the task's own fires only.** A human reply in the thread of a task's post routes to that channel's thread session, never back to the task session (the router has no task-thread routing). That session resolves in this order: sticky → channel wiring → group `container.json` → install default. For follow-ups to keep the task's model, set it on the destination channel's wiring, which also covers every other thread in that channel.

Wiring and group changes apply at the next container spawn. Task pins apply at the next fire.

## 5. Verify and report

Re-run the inventory. Confirm each requested change appears in its layer. After the deploy, confirm that `turn_usage` shows the new id, for example `NANOCLAW_CLAUDE_MODEL` / `ANTHROPIC_DEFAULT_OPUS_MODEL` on a fresh spawn. A config write proves only that the config was written. What actually ran is in `turn_usage`.
