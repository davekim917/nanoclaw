# Remove OpenCode provider

Idempotent — safe to run even if some steps were never applied. Reverses both the host (`src/providers/`) and container (`container/agent-runner/src/providers/`) trees, the agent-runner dependency, and the Dockerfile CLI install.

## 1. Move active groups off OpenCode

Before unregistering or deleting anything, list the groups and switch every
group that still uses OpenCode through the container-config source of truth:

```bash
ncl groups list
ncl groups config update --id <group-id> --provider claude
ncl groups restart --id <group-id>
```

Do not hand-edit materialized `container.json` files or legacy
`agent_groups.agent_provider` fields.

## 2. Delete the barrel import lines (both trees)

Delete (do not comment out) the `import './opencode.js';` line from each barrel:

- `src/providers/index.ts`
- `container/agent-runner/src/providers/index.ts`

This unregisters the provider from both `listProviderContainerConfigNames()` (host) and `listProviderNames()` (container).

## 3. Delete the copied files (both trees)

```bash
rm -f src/providers/opencode.ts \
      src/providers/opencode-registration.test.ts \
      src/opencode-dockerfile.test.ts \
      container/agent-runner/src/providers/opencode.ts \
      container/agent-runner/src/providers/mcp-to-opencode.ts \
      container/agent-runner/src/providers/mcp-to-opencode.test.ts \
      container/agent-runner/src/providers/opencode.factory.test.ts \
      container/agent-runner/src/providers/opencode-registration.test.ts
```

## 4. Remove the agent-runner dependency

`@opencode-ai/sdk` is an importable package in the container tree (agent-runner is a Bun package, not a pnpm workspace — use `bun remove`):

```bash
cd container/agent-runner && bun remove @opencode-ai/sdk && cd -
```

## 5. Revert the Dockerfile CLI install

In `container/Dockerfile`, remove both OpenCode edits (skip whichever is already gone):

**(a)** Delete the version ARG from the "Pin CLI versions" block:

```dockerfile
ARG OPENCODE_VERSION=<exact-version>
```

**(b)** Remove the OpenCode entry from the shared global CLI install block:

```dockerfile
"opencode-ai@${OPENCODE_VERSION}"
```

**(c)** Remove only the `opencode-ai` entries from the container
`only-built-dependencies` and `allowBuilds` configuration. Leave every other
CLI and build permission untouched.

## 6. Unset OpenCode env vars

Remove any OpenCode-specific lines you added to `.env` (`OPENCODE_PROVIDER`, `OPENCODE_MODEL`, `OPENCODE_SMALL_MODEL`, and `ANTHROPIC_BASE_URL` if no other integration uses it) if no other integration needs them, then re-sync to the container:

```bash
mkdir -p data/env && cp .env data/env/env
```

Agent-runner source is one shared read-only mount; there are no per-group
source overlays to clean.

## 7. Rebuild and restart

Run from your NanoClaw project root:

```bash
pnpm run build && ./container/build.sh
source setup/lib/install-slug.sh

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)

# Linux
systemctl --user restart $(systemd_unit)
```

> If the rebuild still reports OpenCode after these steps, the buildkit COPY cache may be stale. Prune the builder and rebuild: `docker builder prune -f && ./container/build.sh`.

## Verification

After removal, the registration guards no longer apply (their files are gone). Confirm the provider is fully unwired:

```bash
grep -R "opencode.js" src/providers/index.ts container/agent-runner/src/providers/index.ts   # no output
grep "@opencode-ai/sdk" container/agent-runner/package.json                                   # no output
grep "opencode-ai" container/Dockerfile                                                        # no output
```

No group should still request `provider = 'opencode'`; step 1 moves every active
group back to Claude before the provider is unregistered.
