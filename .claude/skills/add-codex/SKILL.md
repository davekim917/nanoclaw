---
name: add-codex
description: Use Codex (OpenAI's codex app-server) as a full agent provider — planning, tool orchestration, MCP tools, server-side history, session resume — alongside or instead of Claude. ChatGPT subscription or OpenAI API key, vault-only via OneCLI. Per-group via `ncl groups config update --provider codex`. Distinct from using OpenAI as an MCP tool (where Claude remains the planner).
---

# Codex agent provider

> Authentication shortcut: `pnpm exec tsx setup/index.ts --step provider-auth codex`
> runs the vault auth walk-through after the provider payload is installed.

NanoClaw selects each group's agent backend from `container_configs.provider`
(default `claude`). This skill installs the Codex provider: create-only compose
the compatible payload from the `providers` branch, append one import
to each of the three provider barrels, verify this fork's explicit Dockerfile
CLI pin, rebuild, then run the vault auth walk-through.

The provider runs `codex app-server` as a child process speaking JSON-RPC over stdio: native streaming, MCP tools, server-side conversation history (the continuation is a thread id, no on-disk transcript). Credentials are **vault-only**: OneCLI serves a sentinel `auth.json` stub into the container and swaps the real ChatGPT token or API key on the wire — no key in `.env`, nothing readable in the container.

The mechanical steps under **Install** carry `nc:` directive fences: an agent reads the prose and applies them, and a parser can apply them deterministically from the same document. Every directive is idempotent, so the whole skill is safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Install

### Pre-flight

Check whether the payload is already wired (a prior apply, or a trunk that still carries it). All of these present means installed, but a reapply still runs the branch and composed-tree conformance gates below before authentication:

- `src/providers/codex.ts` and `src/providers/codex-agents-md.ts`
- `container/agent-runner/src/providers/codex.ts` and `codex-app-server.ts`
- `setup/providers/codex.ts`
- `import './codex.js';` in `src/providers/index.ts`, `container/agent-runner/src/providers/index.ts`, and `setup/providers/index.ts`
- `ARG CODEX_VERSION=0.145.0` plus
  `"@openai/codex@${CODEX_VERSION}"` in `container/Dockerfile`

### 1. Fetch and validate the payload

Resolve the registry remote, fetch `providers`, then validate the complete
candidate before copying any file. A failed check is a hard stop: do not copy,
append, install, build, or authenticate. It means the registry branch is stale
relative to the shared workgroup-memory contract and must be synced first.

```nc:run effect:fetch
bash -lc 'source setup/lib/channels-remote.sh; remote=$(resolve_channels_remote); git fetch "$remote" providers'
```
```nc:run effect:check
bash -lc 'source setup/lib/channels-remote.sh; remote=$(resolve_channels_remote); pnpm exec tsx scripts/provider-memory-contract.ts --provider codex --ref "$remote/providers"'
```

### 2. Create-only install and revalidate the payload

Install the validated `providers` payload into all three trees. The installer
creates missing files and accepts byte-identical existing files, but fails
closed before the first write if any existing provider-owned file differs from
the fetched payload. A differing file may be a local customization: reconcile
it through `/update-nanoclaw`'s full-merge customization audit rather than
letting a provider reapply overwrite it. For an eligible install, the
installer fully reads and validates the candidate before writing, publishes
missing files create-only, leaves identical files untouched, post-validates the
complete roster. Because a portable atomic compare-and-unlink does not exist, a
later failure retains any create-only paths already published and reports them
for inspection; it never risks deleting a concurrent customization.

```nc:run effect:external
bash -lc 'set -euo pipefail; source setup/lib/channels-remote.sh; remote=$(resolve_channels_remote); git fetch "$remote" providers; pnpm exec tsx scripts/provider-memory-contract.ts --provider codex --ref "$remote/providers" --install'
```

The host files are the provider contribution + AGENTS.md compose + their
guards; the container files are the customized provider runtime, JSON-RPC
wrapper, shared trusted-static lifecycle guidance, Codex opaque-memory disable,
per-exchange archiver, and compatible guards; the setup file is the picker
entry + vault auth walk-through; `container/AGENTS.md` is the runtime-contract
base the composed AGENTS.md embeds. Upstream-only tests that require its
superseded dependency-injected turn runtime or `cli-tools.json` convention are
deliberately not installed; this fork's matching provider tests and Dockerfile
pin are the authority.

```nc:run effect:check
bash -lc 'source setup/lib/channels-remote.sh; remote=$(resolve_channels_remote); pnpm exec tsx scripts/provider-memory-contract.ts --provider codex --match-ref "$remote/providers"'
```

### 3. Wire the barrels

Append the self-registration import to each of the three provider barrels (skipped if the line is already present). Each barrel-registration test imports its real barrel and asserts `codex` is registered — they go red the moment a barrel line is missing or drifts.

```nc:append to:src/providers/index.ts
import './codex.js';
```
```nc:append to:container/agent-runner/src/providers/index.ts
import './codex.js';
```
```nc:append to:setup/providers/index.ts
import './codex.js';
```

### 4. Verify the retained CLI pin

This fork intentionally retains explicit Dockerfile `ARG` pins so dependency
updates surface as reviewed merge conflicts. Do not add Codex to
`container/cli-tools.json` and do not replace or silently bump an existing pin.
The current audited pin is `0.145.0`.

```nc:run effect:check
bash -lc 'grep -Fqx "ARG CODEX_VERSION=0.145.0" container/Dockerfile && grep -Fq "\"@openai/codex@\${CODEX_VERSION}\"" container/Dockerfile'
```

If either check fails, stop. Reconcile the Dockerfile through the repository's
container-update audit; a provider reapply is not permission to overwrite a
custom dependency pin.

### 5. Build

```nc:run effect:build
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

### 6. Validate

```nc:run effect:test
pnpm vitest run src/providers/codex-registration.test.ts src/providers/codex-agents-md.test.ts src/providers/codex.container-config.test.ts setup/providers/
```
```nc:run effect:test
cd container/agent-runner && bun test src/providers/
```
```nc:run effect:test
pnpm exec tsx scripts/provider-memory-contract.ts --provider codex --require-payload
```

The registration tests import only the real barrels — they go red if a barrel line is missing, a barrel fails to evaluate, or the payload is broken.

## Authenticate

```nc:run effect:external
pnpm exec tsx setup/index.ts --step provider-auth codex
```

The same walk-through fresh installs get from the setup picker: ChatGPT subscription (browser login or device pairing) or an OpenAI API key, landed in the OneCLI vault. Idempotent — it short-circuits when a matching secret already exists. It finishes with the install check.

## Use it

Per group:

```bash
ncl groups config update --id <group-id> --provider codex
ncl groups restart --id <group-id>
```

Switching is an operator action — run it from the host. Once the workgroup
canon is active, every provider uses the same files and switching providers
requires no memory migration. If the installation's shared-memory cutover is
incomplete, run `/migrate-memory`; it consolidates discovered group memory and
recognized provider-native memory roots, not standing instructions or other
customizations. See
[docs/provider-migration.md](../../docs/provider-migration.md).

### Default new groups to codex (optional)

New groups are created on the **instance default** (`DEFAULT_AGENT_PROVIDER` in `.env`, or `claude` when unset). Installing this skill wires codex in but does NOT change that default — "installed" is not "authenticated", so the default stays claude until you opt in explicitly.

After install, ask the operator before flipping it:

> "Codex is installed. Default new agent groups to codex? Existing groups keep their current provider."

On yes — set it, then restart the host so it takes effect:

```bash
pnpm exec tsx setup/index.ts --step set-env -- --key DEFAULT_AGENT_PROVIDER --value codex
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS; Linux: systemctl --user restart nanoclaw
```

This affects only groups created afterward. Per-group `ncl groups config update --provider` still overrides the default in either direction. Creation itself stays provider-agnostic (no `--provider` flag — provider is a DB property stamped from the instance default at creation).

## Troubleshooting

- **Container dies at boot, channel silent:** `grep 'Container exited non-zero' logs/nanoclaw.error.log` — the `stderrTail` carries the reason (e.g. `Unknown provider: codex. Registered: claude` means the barrels aren't wired in the running build).
- **In-channel `Error: spawn codex ENOENT` on every message:** the image
  predates the audited Dockerfile pin/install — verify step 4 and re-run
  `./container/build.sh`.
- **Auth errors mid-conversation:** the vault secret is missing or stale — re-run `pnpm exec tsx setup/index.ts --step provider-auth codex` (subscription re-login updates the vault copy).
