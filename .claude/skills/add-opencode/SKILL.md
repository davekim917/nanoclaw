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

Pinned. Bump deliberately, not with `bun update`.

```bash
cd container/agent-runner && bun add @opencode-ai/sdk@1.4.3 && cd -
```

### 5. Add `opencode-ai` to the container Dockerfile

Two edits to `container/Dockerfile`, both idempotent (skip if already present):

**(a)** In the "Pin CLI versions" ARG block (around line 18), add after `ARG VERCEL_VERSION=latest`:

```dockerfile
ARG OPENCODE_VERSION=latest
```

**(b)** In the `pnpm install -g` block (around line 80), append `"opencode-ai@${OPENCODE_VERSION}"` to the list:

```dockerfile
    pnpm install -g \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
        "agent-browser@${AGENT_BROWSER_VERSION}" \
        "vercel@${VERCEL_VERSION}" \
        "opencode-ai@${OPENCODE_VERSION}"
```

### 6. Build

```bash
pnpm run build                                         # host
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit   # container typecheck
./container/build.sh                                   # agent image
```

## Configuration

### Host `.env` (typical)

Set model/provider strings in the form OpenCode expects (often `provider/model-id`). **Put comments on their own lines** — a `#` inside a value is kept verbatim and breaks model IDs.

These variables are read **on the host** and passed into the container only when the effective provider is `opencode`. They do not switch the provider by themselves; the DB still needs `agent_provider` set (below).

- `OPENCODE_PROVIDER` — OpenCode provider id, e.g. `openrouter`, `anthropic` (if unset, the runner defaults to `anthropic`).
- `OPENCODE_MODEL` — full model id, e.g. `openrouter/anthropic/claude-sonnet-4`.
- `OPENCODE_SMALL_MODEL` — optional second model for "small" tasks.

Credentials: OneCLI / credential proxy patterns are unchanged. For non-`anthropic` OpenCode providers, the runner registers a placeholder API key and **`ANTHROPIC_BASE_URL`** (the credential proxy) as `baseURL` so the real key never lives in the container.

#### Example: OpenRouter

```env
# OpenCode — host passes these into the container when agent_provider is opencode
OPENCODE_PROVIDER=openrouter
OPENCODE_MODEL=openrouter/anthropic/claude-sonnet-4
OPENCODE_SMALL_MODEL=openrouter/anthropic/claude-haiku-4.5
```

#### Example: Anthropic via existing proxy env

When `OPENCODE_PROVIDER` is `anthropic`, OpenCode uses normal Anthropic env inside the container (proxy + placeholder key pattern unchanged).

```env
OPENCODE_PROVIDER=anthropic
OPENCODE_MODEL=anthropic/claude-sonnet-4-20250514
```

#### Example: only a main model

```env
OPENCODE_PROVIDER=openrouter
OPENCODE_MODEL=openrouter/google/gemini-2.5-pro-preview
```

#### OpenCode Zen (`x-api-key`, not Bearer)

Zen's HTTP API (e.g. `POST …/zen/v1/messages`) expects the key in the **`x-api-key`** header. If OneCLI injects **`Authorization: Bearer …`** only, Zen often returns **401 / "Missing API key"** even though the gateway is working.

**Naming:** NanoClaw **`AGENT_PROVIDER=opencode`** (DB `agent_provider`) means "run the **OpenCode agent provider**." Separately, **`OPENCODE_PROVIDER=opencode`** in `.env` is OpenCode's **Zen provider id** inside the OpenCode config (see [Zen docs](https://opencode.ai/docs/zen/)).

**Host `.env` (typical Zen shape):**

```env
# NanoClaw still resolves AGENT_PROVIDER from agent_groups / sessions; set agent_provider to opencode there.
# OpenCode SDK: Zen as the upstream provider + models under opencode/…
OPENCODE_PROVIDER=opencode
OPENCODE_MODEL=opencode/big-pickle
OPENCODE_SMALL_MODEL=opencode/big-pickle

# Point the credential proxy at Zen's Anthropic-compatible base URL (host + OneCLI must forward this host).
ANTHROPIC_BASE_URL=https://opencode.ai/zen/v1
```

Use a real Zen model id from the docs; `big-pickle` is one example.

**OneCLI:** register the Zen key with **`x-api-key`**, not Bearer:

```bash
onecli secrets create --name "OpenCode Zen" --type generic \
  --value YOUR_ZEN_KEY --host-pattern opencode.ai \
  --header-name "x-api-key" --value-format "{value}"
```

For comparison, OpenRouter uses `Authorization` + `Bearer {value}`. Zen is different by design.

### Per group / per session

Schema: **`agent_groups.agent_provider`** and **`sessions.agent_provider`**. Set to `opencode` for groups or sessions that should use OpenCode. The container receives `AGENT_PROVIDER` from the resolved value (session overrides group).

Extra MCP servers still come from **`NANOCLAW_MCP_SERVERS`** / `container_config.mcpServers` on the host; the runner merges them into the same `mcpServers` object passed to **both** Claude and OpenCode providers.

## Operational notes

- OpenCode keeps a local **`opencode serve`** process and SSE subscription; the provider tears down with **`stream.return`** and **SIGKILL** on the server process on **`abort()`** / shared runtime reset to avoid MCP/zombie hangs.
- Session continuation is opaque (`ses_*` ids); stale sessions are cleared using **`isSessionInvalid`** on OpenCode-specific errors (timeouts, connection resets, not-found patterns) in addition to the poll-loop's existing recovery.
- **`NO_PROXY`** for localhost matters when the OpenCode client talks to `127.0.0.1` inside the container while HTTP(S)_PROXY is set (e.g. OneCLI).

## Verify

```bash
grep -q "./opencode.js" container/agent-runner/src/providers/index.ts && echo "container barrel: OK"
grep -q "./opencode.js" src/providers/index.ts && echo "host barrel: OK"
grep -q "@opencode-ai/sdk" container/agent-runner/package.json && echo "agent-runner dep: OK"
grep -q "opencode-ai@" container/Dockerfile && echo "Dockerfile install: OK"
cd container/agent-runner && bun test src/providers/ && cd -
```
