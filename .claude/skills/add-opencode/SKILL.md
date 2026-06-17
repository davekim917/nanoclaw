---
name: add-opencode
description: Use OpenCode as an agent provider (AGENT_PROVIDER=opencode). OpenRouter, OpenAI, Google, DeepSeek, etc. via OpenCode config — not the Anthropic Agent SDK. Per-session and per-group via agent_provider; host passes OPENCODE_* and XDG mount when spawning containers.
---

# OpenCode agent provider

NanoClaw runs agents in a long-lived **poll loop** inside the container. The backend is selected with **`AGENT_PROVIDER`** (`claude` | `opencode` | `mock`).

Trunk ships with only the `claude` provider baked in. This skill copies the OpenCode provider files in from the `providers` branch, wires them into the host and container barrels, installs dependencies, and rebuilds the image.

## Install

### Pre-flight

If all of the following are already present, skip to **Configuration**:

- `src/providers/opencode.ts`
- `container/agent-runner/src/providers/opencode.ts`
- `import './opencode.js';` line in `src/providers/index.ts`
- `import './opencode.js';` line in `container/agent-runner/src/providers/index.ts`
- `@opencode-ai/sdk` in `container/agent-runner/package.json`
- `opencode-ai@${OPENCODE_VERSION}` in the pnpm global-install block in `container/Dockerfile`

Missing pieces — continue below. All steps are idempotent; re-running is safe.

### 1. Fetch the providers branch

```bash
git fetch origin providers
```

### 2. Copy the OpenCode source files

Wholesale copies (owned entirely by this skill — user edits to these files won't survive a re-run, as designed):

```bash
git show origin/providers:src/providers/opencode.ts                                    > src/providers/opencode.ts
git show origin/providers:container/agent-runner/src/providers/opencode.ts             > container/agent-runner/src/providers/opencode.ts
git show origin/providers:container/agent-runner/src/providers/mcp-to-opencode.ts      > container/agent-runner/src/providers/mcp-to-opencode.ts
git show origin/providers:container/agent-runner/src/providers/mcp-to-opencode.test.ts > container/agent-runner/src/providers/mcp-to-opencode.test.ts
git show origin/providers:container/agent-runner/src/providers/opencode.factory.test.ts > container/agent-runner/src/providers/opencode.factory.test.ts
```

### 3. Append the self-registration imports

Each barrel gets one line appended at the end — skip if the line is already present.

`src/providers/index.ts`:

```typescript
import './opencode.js';
```

`container/agent-runner/src/providers/index.ts`:

```typescript
import './opencode.js';
```

### 4. Add the agent-runner dependency

Pinned. Bump deliberately, not with `bun update`. Use `1.15.7` — must match the `opencode-ai` CLI version pinned in step 5. The SDK type surface is OpenAPI-generated and has been API-stable from 1.4.x through 1.15.x; older add-opencode skill copies warned that 1.14.x was incompatible, but a byte-level diff of `sdk.gen.d.ts` shows zero breaking changes.

```bash
cd container/agent-runner && bun add @opencode-ai/sdk@1.15.7 && cd -
```

### 5. Add `opencode-ai` to the container Dockerfile

Two edits to `container/Dockerfile`, both idempotent (skip if already present):

**(a)** In the "Pin CLI versions" ARG block (around line 45–57), add after `ARG CODEX_VERSION=...`:

```dockerfile
ARG OPENCODE_VERSION=1.15.7
```

> **Pin to an exact version** — keep host CLI, container CLI, and SDK locked to the same release. `latest` works but caves to upstream cadence; bump deliberately when there's a reason.

**(b)** In the "Illysium additions" `pnpm install -g` block (around line 339–344, the one that already lists `gitnexus`, `mermaid-cli`, `@googleworkspace/cli`, and `@openai/codex`), append `"opencode-ai@${OPENCODE_VERSION}"`:

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g \
        "gitnexus@${GITNEXUS_VERSION}" \
        "@mermaid-js/mermaid-cli@${MMDC_VERSION}" \
        "@googleworkspace/cli@${GWS_VERSION}" \
        "@openai/codex@${CODEX_VERSION}" \
        "opencode-ai@${OPENCODE_VERSION}"
```

> If your Dockerfile still has a single combined `pnpm install -g` block for claude-code + agent-browser + vercel (older upstream layout), append `opencode-ai` there instead. Look for the existing layer that installs `@openai/codex` and add OpenCode next to it.

**(c)** Add `opencode-ai` to the `only-built-dependencies` allowlist in `/root/.npmrc`. The container's pnpm is configured to skip postinstall scripts by default; opencode-ai's postinstall downloads its native binary and the CLI errors out at runtime without it ("opencode-ai's postinstall script was not run"). The allowlist is configured in the same `RUN` block that installs vercel (around line 323–328):

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    echo "only-built-dependencies[]=agent-browser" > /root/.npmrc && \
    echo "only-built-dependencies[]=@anthropic-ai/claude-code" >> /root/.npmrc && \
    echo "only-built-dependencies[]=@googleworkspace/cli" >> /root/.npmrc && \
    echo "only-built-dependencies[]=opencode-ai" >> /root/.npmrc && \
    pnpm install -g "vercel@${VERCEL_VERSION}"
```

> The container `.npmrc` allowlist is **separate** from the host's `pnpm-workspace.yaml` `onlyBuiltDependencies`. The host allowlist is human-gated per CLAUDE.md; this container-side allowlist follows the same posture (only add packages the operator explicitly wants — opencode-ai's postinstall pattern matches the existing entries).

### 6. Build

```bash
pnpm run build                                         # host
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit   # container typecheck
./container/build.sh                                   # agent image
```

> **Build cache gotcha:** The container buildkit caches COPY steps aggressively. If provider files were already present in the build context before, the new files may not be picked up. If you see "Unknown provider: opencode" after the build, prune the builder and rebuild:
> ```bash
> docker builder prune -f && ./container/build.sh
> ```

### 7. Propagate to existing per-group overlays

Each agent group has a live source overlay at `data/v2-sessions/<group-id>/agent-runner-src/providers/` that **overrides the image at runtime**. This overlay is created when the group is first wired and never auto-updated by image rebuilds. Any group that already existed before this skill ran needs the new files copied in manually.

```bash
for overlay in data/v2-sessions/*/agent-runner-src/providers/; do
  [ -d "$overlay" ] || continue
  cp container/agent-runner/src/providers/opencode.ts "$overlay"
  cp container/agent-runner/src/providers/mcp-to-opencode.ts "$overlay"
  cp container/agent-runner/src/providers/index.ts "$overlay"
  echo "Updated: $overlay"
done
```

## Configuration

### Model / provider config (DB, not `.env`)

Model, provider, and effort live in the **`container_configs`** DB row, set via `ncl` — the same one-pattern template claude and codex use (a code-level default, overridden per-group in the DB). The host **no longer reads** `OPENCODE_PROVIDER` / `OPENCODE_MODEL` / `OPENCODE_SMALL_MODEL` / `OPENCODE_EFFORT` from `.env` for model selection (those scoped vars are dead — see `src/providers/opencode.ts`). The provider is **derived from the model slug's prefix** (`deepseek/…` → deepseek, `opencode-go/…` → Go, `opencode/…` → Zen, `nvidia/…` → NVIDIA); there is no base-URL var to set — opencode's provider registry routes by prefix + the auth.json/OneCLI cred.

Set the model on the group (after `agent_provider=opencode` is set, below — the group row must exist):

```bash
ncl groups config update --id <agentGroupFolder> --model deepseek/deepseek-chat --effort high
```

If you set nothing, the group inherits the code default `opencode-go/kimi-k2.7-code` (effort `high`) — correct for an OpenCode Go group, wrong for any other provider, so a non-Go group **must** set `--model` explicitly. Effort accepts `low|medium|high` (opencode's portable set). The `provider/model-id` shapes in the examples below are still the right FORMAT for `--model` — just pass them to `ncl`, not `.env`.

Credentials: register provider API keys in OneCLI with the matching `--host-pattern` (e.g. `api.deepseek.com`, `openrouter.ai`). OneCLI injects them via `HTTPS_PROXY` in the container — the key never lives in `.env` or the container environment.

After adding a secret, **grant the agent access** — agents in `selective` mode only receive secrets they've been explicitly assigned:

Use the safe merge pattern — `set-secrets` replaces the entire list, so always read first:

```bash
AGENT_ID=$(onecli agents list | jq -r '.data[] | select(.identifier=="<agentGroupId>") | .id')
CURRENT=$(onecli agents secrets --id "$AGENT_ID" | jq -r '[.data[]] | join(",")')
MERGED=$(printf '%s' "$CURRENT,<new-secret-id>" | tr ',' '\n' | sort -u | paste -sd ',' -)
onecli agents set-secrets --id "$AGENT_ID" --secret-ids "$MERGED"
onecli agents secrets --id "$AGENT_ID"
```

Each example below gives the `provider/model-id` to pass to `ncl … --model` plus
its OneCLI credential registration. **Nothing about the model goes in `.env`.**

#### Example: DeepSeek

Model id for `--model`: `deepseek/deepseek-chat`. Register the key:

```bash
onecli secrets create --name "DeepSeek" --type generic \
  --value YOUR_KEY --host-pattern "api.deepseek.com" \
  --header-name "Authorization" --value-format "Bearer {value}"
```

#### Example: OpenRouter

Model id for `--model`: `openrouter/anthropic/claude-sonnet-4`. Register the key:
```bash
onecli secrets create --name "OpenRouter" --type generic \
  --value YOUR_KEY --host-pattern "openrouter.ai" \
  --header-name "Authorization" --value-format "Bearer {value}"
```

#### Example: Anthropic

Model id for `--model`: `anthropic/claude-sonnet-4-20250514`. When the model is an `anthropic/*` slug, OpenCode uses the normal Anthropic env inside the container — the proxy + placeholder-key pattern is unchanged.

#### OpenCode Zen (`x-api-key`, not Bearer)

Zen's HTTP API (e.g. `POST …/zen/v1/messages`) expects the key in the **`x-api-key`** header. If OneCLI injects **`Authorization: Bearer …`** only, Zen often returns **401 / "Missing API key"** even though the gateway is working.

**Naming:** NanoClaw **`AGENT_PROVIDER=opencode`** (DB `agent_provider`) means "run the **OpenCode agent provider**." Separately, the **`opencode`** prefix in a model slug is OpenCode's **Zen provider id** — the host derives the routing provider from the slug prefix (see [Zen docs](https://opencode.ai/docs/zen/)).

Model id for `--model`: an `opencode/<id>` slug, e.g. `opencode/big-pickle` (use a real Zen model id from the docs).

**OneCLI:** register the Zen key with **`x-api-key`**, not Bearer:

```bash
onecli secrets create --name "OpenCode Zen" --type generic \
  --value YOUR_ZEN_KEY --host-pattern opencode.ai \
  --header-name "x-api-key" --value-format "{value}"
```

### Per group / per session

Set `"provider": "opencode"` in the group's **`container.json`** (`groups/<folder>/container.json`) — the in-container runner reads `provider` from there, not from the DB. The DB columns **`agent_groups.agent_provider`** and **`sessions.agent_provider`** (session overrides group) only drive host-side provider contribution — per-session XDG mount, `OPENCODE_*` env passthrough — and do not propagate into `container.json` at spawn time. Set both, or just edit `container.json`; if they disagree, the runner uses `container.json` and the host-side resolver falls back through session → group → `container.json` → `'claude'`.

Extra MCP servers still come from **`NANOCLAW_MCP_SERVERS`** / `container_config.mcpServers` on the host; the runner merges them into the same `mcpServers` object passed to **both** Claude and OpenCode providers.

## Operational notes

- OpenCode keeps a local **`opencode serve`** process and SSE subscription; the provider tears down with **`stream.return`** and **SIGKILL** on the server process on **`abort()`** / shared runtime reset to avoid MCP/zombie hangs.
- Session continuation passes through whatever opaque id OpenCode hands back; stale sessions are cleared by `isSessionInvalid` on OpenCode-specific error patterns. If you see session-not-found errors after an accidental CLI version mismatch, clear `session_state` in `outbound.db` and wipe the `opencode-xdg` directory under the session folder.
- **`NO_PROXY`** for localhost matters when the OpenCode client talks to `127.0.0.1` inside the container while HTTP(S)_PROXY is set (e.g. OneCLI).

## Verify

```bash
grep -q "./opencode.js" container/agent-runner/src/providers/index.ts && echo "container barrel: OK"
grep -q "./opencode.js" src/providers/index.ts && echo "host barrel: OK"
grep -q "@opencode-ai/sdk" container/agent-runner/package.json && echo "agent-runner dep: OK"
grep -q "opencode-ai@" container/Dockerfile && echo "Dockerfile install: OK"
cd container/agent-runner && bun test src/providers/ && cd -
```
