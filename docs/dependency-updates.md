# Dependency Updates

NanoClaw uses one deterministic release adapter for the weekly `#example-dev` advisory and the `/update-container` workflow:

```bash
bun scripts/container-updates.ts audit --format json
bun scripts/container-updates.ts apply --repo <writable-clone> --items <id,id,...>
```

The policy is latest stable, including major releases. Prerelease, beta, RC, dev, nightly, draft, yanked, and incompatible releases are not candidates. One opt-in exception: a Docker pin whose npm source sets `allowPrerelease: true` in `container/update-sources.json` follows npm's `latest` tag even when it is a prerelease, for a tool that has never published a stable release (`cf` today). Drop the flag once that tool's `latest` is stable. Registry failures remain unknown. Exact Docker pins and committed pnpm and Bun locks remain mandatory.

The weekly task runs the audit as a pre-task script. A deterministic all-current result does not wake the agent and declares an `empty` observation ([Observations](scheduled-tasks.md#observations)); otherwise the agent posts an advisory only. It never edits, opens a PR, merges, deploys, or restarts. `/update-container` presents exact item IDs, waits for human selection, applies only those IDs in writable clones, writes the behaviour-change ledger, runs the relevant gates, and opens unmerged PRs.

Host and container changes use separate NanoClaw PRs. Host changes activate through the host build/deploy/restart path. Container changes activate through an image rebuild. Codex-synchronized files target the bootstrap repository and use a third PR.

## Behaviour-change ledger and live-path gate

Every PR runs `pnpm exec tsx scripts/dependency-gate.ts check` in CI. It compares the locked versions at the PR's merge base with the head: `pnpm-lock.yaml` (patch hashes included), `container/agent-runner/bun.lock`, `container/remotion/pnpm-lock.yaml`, the Dockerfile pins named in `container/update-sources.json`, and the Dockerfile's base image. An edited file under `patches/` counts as a change at the same version. `container/dependency-paths.json` classifies every direct dependency as `dev`, `runtime` or `live`; a package that a `live` package depends on, transitively, inherits its live paths, because pnpm dedupes one copy for every consumer.

- **A changed `runtime` or `live` package needs a ledger.** The PR adds or edits a file under `docs/dependency-changes/` with one section per package the gate names:

  ```markdown
  ## @chat-adapter/discord 4.29.0 → 4.41.1

  Source: https://github.com/vercel/chat/releases (4.30.0 through 4.41.1)

  - 4.39: postMessage on an unseen thread resolves its parent channel first · test: src/channels/discord.test.ts
  - 4.38: forwarded snapshots fold into the message text · not covered: no forwarded-message fixture yet
  ```

  The heading's versions must match the lockfiles; a set of versions is comma-joined, and a package added or removed reads `none`. `Source:` names the changelog or release notes read for every version in between. Each bullet is one behaviour change and ends in `· test: <path>` (an existing `.test.ts` file) or `· not covered: <reason>`. When the changelog lists none, say so in one bullet with its coverage. A `dev` change needs nothing, and each package is explained in one ledger only.

- **A changed `live` package needs a real-library test of each live path it is on.** A live path is an I/O path the fleet depends on: chat inbound and outbound, attachment download, the OneCLI gateway, each agent provider, MCP. Its test drives the real library over its real transport against a local fake of the remote end, never a mocked module: `src/channels/slack-live-path.test.ts` runs the host's Slack wiring, `@chat-adapter/slack`, `@slack/socket-mode` and `@slack/web-api` against a local Web API and Socket Mode server. The file name contains `live-path`, so CI's `Live-path adapter tests` step runs it on every PR. A live path with no test yet blocks every upgrade of its packages until someone writes one and lists it in the registry. Removing a package is not blocked.

- **Incidents.** A hotfix patch on the shipped version, or a rollback to an older version, may pass an untested live path with an `Override: <incident and reason>` line in its ledger section. The gate prints it as a warning. An upgrade can never be overridden.

- **The registry cannot quietly get weaker.** Dropping a package's live path, or a test from a live path, fails unless a ledger in the same PR says why: `Reclassified: <package or live path> · <reason>`. To unblock a live path, write its test.

## Host peer-version lockstep: `vitest` / `@vitest/coverage-v8`

Outside the container-update flow above: `@vitest/coverage-v8` (`package.json` devDependencies) is a `vitest` peer, not an independently-versioned package, and must stay exact-pinned to the SAME version as `vitest` itself. Bumping one without the other risks a version mismatch the install silently tolerates but the coverage machinery (`vitest.config.ts`, `scripts/check-risk-coverage.ts`) does not. When bumping `vitest`, bump `@vitest/coverage-v8` to the identical version in the same change.
