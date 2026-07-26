# Remove the Codex agent provider

Reverses every change `/add-codex` makes and returns every group to the default provider. Safe to run when partially installed — skip any step whose target is already absent.

## 1. Switch codex groups back to the default

List groups still on codex and switch each one. Once the workgroup canon is
active, Claude reads the same memory files and switching back requires no
memory migration. If the installation's shared-memory cutover is incomplete,
run `/migrate-memory`; it consolidates discovered group memory and recognized
provider-native memory roots, never standing instructions or other
customizations. See
[docs/provider-migration.md](../../docs/provider-migration.md).

```bash
ncl groups list
# for each group whose config shows provider=codex:
ncl groups config update --id <group-id> --provider claude
ncl groups restart --id <group-id>
```

## 2. Delete the barrel imports

Delete (do not comment out) the `import './codex.js';` line from each of:

- `src/providers/index.ts`
- `container/agent-runner/src/providers/index.ts`
- `setup/providers/index.ts`

## 3. Delete every copied file

```bash
rm -f src/providers/codex.ts \
      src/providers/codex-agents-md.ts \
      src/providers/codex-registration.test.ts \
      src/providers/codex-agents-md.test.ts \
      container/agent-runner/src/providers/codex.ts \
      container/agent-runner/src/providers/codex-app-server.ts \
      container/agent-runner/src/providers/exchange-archive.ts \
      container/agent-runner/src/providers/exchange-archive.test.ts \
      container/agent-runner/src/providers/codex-registration.test.ts \
      container/agent-runner/src/providers/codex.factory.test.ts \
      container/agent-runner/src/providers/codex-app-server.test.ts \
      setup/providers/codex.ts \
      setup/providers/codex.test.ts \
      setup/providers/codex-registration.test.ts
```

This skill itself (`.claude/skills/add-codex/`) stays — it ships with trunk so the provider can be re-added later.

`container/AGENTS.md` stays only if another installed provider uses agent surfaces; otherwise remove it too.

## 4. Retain the install-wide Codex CLI

Do not edit `container/cli-tools.json`, `CODEX_VERSION`, or the Dockerfile's
`@openai/codex` install. This fork uses the Codex CLI independently for
cross-model QA/review even when no agent group selects the Codex provider.

## 5. Vault secret (optional)

The ChatGPT/OpenAI secret in the OneCLI vault grants nothing once the provider is gone. To remove it: `onecli secrets list`, then `onecli secrets delete --id <id>` for the `chatgpt.com` / `api.openai.com` entry.

## 6. Rebuild and verify

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
pnpm test
cd container/agent-runner && bun test
```

All suites green and `ncl groups list` showing no codex groups means the removal is complete. Restart the service (`launchctl kickstart -k gui/$(id -u)/<label>` on macOS, `systemctl --user restart <unit>` on Linux).
