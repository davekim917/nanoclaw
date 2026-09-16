# Migration: the `opus` alias means Opus, and the fleet defaults move

Two things changed together, and only one of them is a default anyone chose.

1. **The defect.** `ANTHROPIC_DEFAULT_OPUS_MODEL` — the SDK short-circuit that decides what the bare word `opus` resolves to — carried **each group's own resolved model**, not an Opus id. So "opus" meant "whatever this group runs". When the unpinned Claude default moved to Sonnet 5 (2026-09-14, `7d0e7df3a`), the `"model": "opus"` pin that `src/group-init.ts` writes into **every** group's `.claude-shared/settings.json` started resolving to `claude-sonnet-5`. Measured in a running container: `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-sonnet-5`. The alias is now the install's Opus constant in every group, and the group's model travels in its own variable, `NANOCLAW_CLAUDE_MODEL`.

2. **The defaults.** An unpinned **Claude** group now resolves to `claude-opus-5[1m]`, at Opus's unchanged `high` family effort. An unpinned **Codex** group now resolves to `gpt-5.6-sol` at `high` reasoning (was `gpt-5.6-terra` at `xhigh`) — the same tier on both providers, so a group's provider decides what runs it, not what tier it runs at.

**This changes production behaviour on deploy.** Every Claude group with no model configured moves from Sonnet 5/`xhigh` to Opus 5 [1m]/`high` on its next spawn; every Codex group with no model configured moves from Terra/`xhigh` to Sol/`high`; and every `model: opus` subagent or settings pin — in every group, including Sonnet-pinned ones — starts genuinely running Opus. **No pin is ever rewritten**, on either provider.

Pins are data (no deploy); the defaults are code (needs one). **A group you want held where it is must be pinned BEFORE you deploy**, or it runs the new default from the first spawn after the restart.

## 1. Detect

Which groups move — and it is **not** just the Claude ones. A declared `providerFallback` resolves through these same defaults, so a Codex group that falls back to Claude moves on the Claude default, and a Claude group that falls back to Codex moves on the Codex one. Measured on this install: 14 fallback paths resolve through a default that moves, and a primary-provider-only check lists none of them.

Three things make a hand-written check wrong, and all three were found in review of this PR:

- `groups/<folder>/container.json` is authoritative, not the `container_configs` row `ncl groups config get` prints (`presentConfig`, `src/cli/resources/groups.ts:68-74`) — the spawn path reads the file (`readContainerConfig`), and a DB-only update or hand edit can leave the two disagreeing.
- **A present `model` is not necessarily a pin.** `resolveClaudeSpawnDefaults` DROPS a value that is not Claude vocabulary and falls through to the default — so a `gpt-*` id left behind by `--provider claude` (which does not clear the previous provider's model), or any typo, reads as pinned and runs as unpinned.
- **The primary provider is not the only thing that runs.** See above.

So run the resolver itself, over every group and its fallback. From the install root:

```bash
cat > ./claude-default-audit.ts <<'TS'
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from './src/config.js';
import { readContainerConfig } from './src/container-config.js';
import { resolveClaudeSpawnDefaults } from './src/claude-spawn-defaults.js';

// Codex's fleet defaults live in the container package (a separate Bun tree
// this host script cannot import), so read them out of their single source
// rather than restating them. Loud on a rename; never silently stale.
const codexSrc = fs.readFileSync('container/agent-runner/src/providers/codex.ts', 'utf8');
const pick = (name: string) => {
  const m = new RegExp(`export const ${name} = '([^']+)'`).exec(codexSrc);
  if (!m) throw new Error(`${name} not found — read container/agent-runner/src/providers/codex.ts`);
  return m[1];
};
const CODEX_MODEL = pick('DEFAULT_CODEX_MODEL');
const CODEX_EFFORT = pick('DEFAULT_CODEX_EFFORT');

// What a spawn on `provider` resolves to, given the model/effort that reaches
// it. The claude half calls the host's own resolver; the codex half applies
// its constants the way the provider does (a pin always wins). OpenCode has
// its own default (DEFAULT_OPENCODE_MODEL, src/providers/opencode.ts) that
// this change does not touch — say so rather than running it through the
// wrong resolver.
const resolve = (provider: string, model?: string | null, effort?: string | null) => {
  if (provider === 'codex') return { model: model ?? CODEX_MODEL, effort: effort ?? CODEX_EFFORT, drops: [] as string[] };
  if (provider !== 'claude') return { model: model ?? "(this provider's own default)", effort: effort ?? undefined, drops: [] as string[] };
  return resolveClaudeSpawnDefaults({ model, effort } as never);
};

const print = (folder: string, kind: string, provider: string, configured: string | null, effort: string | null) => {
  const r = resolve(provider, configured, effort);
  console.log(
    [folder, kind, provider, configured ?? '(none)', r.model, r.effort ?? '(family default)', r.drops.join('; ') || '-'].join('\t'),
  );
};

for (const folder of fs.readdirSync(GROUPS_DIR).sort()) {
  if (!fs.existsSync(path.join(GROUPS_DIR, folder, 'container.json'))) continue;
  const cfg = readContainerConfig(folder) as Record<string, any> | undefined;
  if (!cfg) continue;
  // providerConfig is the provider's OWN sticky config, and the two providers
  // rank it oppositely: claude's `stickyConfig` beats the env the host sends
  // (claude.ts `input.model ?? this.stickyConfig.model ?? env`), while codex's
  // top-level model reaches providerConfig through config.ts and wins. Its
  // effort key differs too — `effort` on claude, `reasoning_effort` on codex.
  const provider = cfg.provider ?? 'claude';
  const pc = cfg.providerConfig ?? {};
  const [model, effort] =
    provider === 'claude'
      ? [pc.model ?? cfg.model ?? cfg.defaultModel ?? null, pc.effort ?? cfg.effort ?? cfg.defaultEffort ?? null]
      : [cfg.model ?? cfg.defaultModel ?? pc.model ?? null, cfg.effort ?? cfg.defaultEffort ?? pc.reasoning_effort ?? null];
  print(folder, 'primary', provider, model, effort);
  // A declared fallback carries its OWN model/effort and nothing else: the
  // primary's are discarded when it applies (src/provider-fallback.ts), so it
  // must be resolved from the fallback's own fields, never the group's.
  const fb = cfg.providerFallback;
  if (fb?.provider) print(folder, 'fallback', fb.provider, fb.model ?? null, fb.effort ?? null);
}
TS
pnpm exec tsx ./claude-default-audit.ts   # delete the file when you're done
```

Columns: folder, primary-or-fallback, provider, that path's own configured value, **what will actually run**, the effort, and anything the resolver refused. A path with `(none)` in the fourth column is unpinned and moves; a path whose fifth column merely *differs* from its fourth may just be an alias expanding (`opus` → `claude-opus-5[1m]`), and the OpenCode rows differ by construction because their default is out of scope here. `(family default)` in the effort column means no effort is exported and the provider picks its own (Opus → `high`, Sonnet → `xhigh`, Haiku → none).

Run it on the code you have now to see today's answers, and again after deploy to see the new ones. It calls the same resolver the spawn path calls and reads the Codex constants out of their own source, so the vocabulary and the install defaults cannot drift from it. The one thing it restates is the per-provider ranking of `providerConfig` against the top-level fields (see the comment in the loop) — if a group ever grows a `providerConfig` block, re-read that comment against `claude.ts` / `config.ts` before trusting the row.

A per-channel wiring can also pin a model, and it outranks the group config; check any channel you care about:

```bash
ncl wirings list --json | jq -r '.data[] | select(.default_model != null) | [.id, .agent_group_id, .messaging_group_id, .default_model] | @tsv'
```

To see the defect itself in a live container before you deploy:

```bash
docker inspect <container> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep ANTHROPIC_DEFAULT
```

Before this change that prints the group's model in `ANTHROPIC_DEFAULT_OPUS_MODEL`; after it, `claude-opus-5[1m]` in every group, plus a separate `NANOCLAW_CLAUDE_MODEL` holding the group's model.

## 2. Why

A family alias is a promise about a word, not a per-group setting. Sharing one variable between "what `opus` means" and "what this group runs" made the two indistinguishable, so a change to either silently moved the other — which is exactly what happened: nobody decided that `model: opus` should mean Sonnet 5.

Separating them is what makes the default a decision anyone can read: `DEFAULT_OPUS_MODEL` in `src/flag-parser.ts` is what the word means, and `src/claude-spawn-defaults.ts` is what an unpinned group runs.

## 3. Fix — pin first, then deploy

For every group from §1 you want to hold where it is:

```bash
ncl groups config update --id <group-id> --model claude-sonnet-5 --effort xhigh
```

That writes the `container_configs` row **and** mirrors into `groups/<folder>/container.json`, so the pin survives the deploy and takes effect at that group's next spawn. Pin a single channel instead if only one conversation should hold:

```bash
ncl wirings update --id <wiring-id> --default-model claude-sonnet-5 --default-effort xhigh
```

Groups you want on the new default need no action.

Then deploy as usual (the runner source is a boot snapshot, so the host restart ships both halves of this change together):

```bash
sudo systemctl restart nanoclaw-v2
```

## 4. Verify

After the restart, for a container that has respawned:

```bash
docker inspect <container> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E 'ANTHROPIC_DEFAULT_OPUS_MODEL|NANOCLAW_CLAUDE_MODEL'
```

Expect `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5[1m]` in **every** Claude group, and `NANOCLAW_CLAUDE_MODEL` equal to that group's pin (or `claude-opus-5[1m]` when unpinned).

What actually ran per turn is recorded, not inferred — the runner logs `query: model=… effort=…` per query (`docker logs <container>`), and `turn_usage` carries the resolved model and effort per turn.

## 5. Rollback

Nothing here is destructive and no data migrates, so rollback is per-group configuration or a revert:

- **One group**: `ncl groups config update --id <group-id> --model <the model it had> --effort <the effort it had>`, then restart that group (`ncl groups restart --id <group-id>`). Works the same for a Codex group (`--model gpt-5.6-terra --effort xhigh`).
- **The fleet defaults**: revert `let model = DEFAULT_OPUS_MODEL` to `DEFAULT_SONNET_MODEL` in `src/claude-spawn-defaults.ts` for Claude, and `DEFAULT_CODEX_MODEL`/`DEFAULT_CODEX_EFFORT` in `container/agent-runner/src/providers/codex.ts` for Codex, then rebuild and restart. Each provider's default is one constant; neither touches the other.
- **The alias separation is not the part to roll back.** Reverting it restores the defect: the word `opus` goes back to meaning whatever each group runs. If the fleet default is the problem, change the default.
