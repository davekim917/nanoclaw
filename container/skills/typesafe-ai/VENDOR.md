# Vendored skill — do not hand-edit SKILL.md

`SKILL.md` is a byte-for-byte copy of TypeSafe's published agent skill. It is
authored and versioned upstream; local edits are lost on the next refresh and
make "is ours stale?" unanswerable.

- Source: https://github.com/typesafe-ai/skills — `skills/typesafe-ai/SKILL.md`
- Vendored at upstream commit `65a39f393687675ce170e6094757de20370365b9` (2026-09-12)
- Install docs: https://docs.typesafe.ai/agent-skill.md
- `LICENSE` is upstream's MIT license, retained as the license requires

## Refresh

```bash
curl -fsSL https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md \
  -o container/skills/typesafe-ai/SKILL.md
```

Then update the commit sha above (`gh api 'repos/typesafe-ai/skills/commits?path=skills/typesafe-ai/SKILL.md&per_page=1' --jq '.[0].sha'`).
A stale copy is the documented cause of the agent inventing request/response
fields (https://docs.typesafe.ai/agent-skill.md, "Common issues").

There is deliberately **no** drift test: upstream owning the content means a
drift test would go red on their release, not on our mistake. The refresh is a
one-file curl.

## Why `container/skills/`, not `~/plugins/`

Upstream ships this as a Claude Code plugin, but the payload is one `SKILL.md`
with no scripts, hooks or MCP server. `container/skills/` is bind-mounted at
`/home/node/.claude/skills` for every provider's container
(`src/session-claude-mounts.ts:62`, `src/container-runner.ts:5056`), and the
in-container mirror symlinks that directory into `/home/node/.agents/skills`
for Codex and OpenCode groups
(`syncAgentSkillsMirror`, `container/agent-runner/src/codex-companion-setup.ts:1085`, reading loop at `:1096-1118`).
Every group runs `skills: "all"`, which `selectedSkillNames`
(`src/container-runner.ts:6222`) recomputes from this directory, so the skill
reaches all three providers on the next container spawn with no per-group
config change and no image rebuild.

The plugin route would additionally need generated `.codex-plugin` manifests
and a full OpenCode mirror re-sync (`.claude/skills/enable-agent-plugins/SKILL.md`)
to reach the same groups.

## API credentials

The skill's own guidance is "keep API credentials server-side". In this install
that means a `TYPESAFE_API_KEY` belongs in the OneCLI vault and reaches a group
through `container.json` `onecliSecrets` — never an env var baked into an image
or a key pasted into chat (`docs/workgroups.md`, `src/onecli-secrets.ts`).
