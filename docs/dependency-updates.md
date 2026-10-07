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

Every PR runs `pnpm exec tsx scripts/dependency-gate.ts check` in CI. It compares the locked versions at the PR's merge base with the head: `pnpm-lock.yaml` (patch hashes included), `container/agent-runner/bun.lock`, `container/remotion/pnpm-lock.yaml`, the Dockerfile pins named in `container/update-sources.json` at either the base or the head, and the Dockerfile's base image. A tracked npm or PyPI tool must install exactly as `pkg@${ARG}` or `pkg==${ARG}` (PyPI names compared normalized, extras allowed): the gate refuses a literal, a tag, a range, another ARG or no version, fewer references to the ARG than the base, comments aside, an `ENV`, a second valued `ARG` or a shell assignment in a `RUN` that would shadow the pin, an unpinned update, upgrade, `dlx`, `npx` or `bunx` of the tool, and an ARG used with no value it can read. Instruction keywords are matched in any case and spacing, as Docker reads them. An edited file under `patches/`, `container/agent-runner/patches/` or `container/remotion/patches/`, or a changed patch entry in a lockfile, counts as a change at the same version in that tree. `container/dependency-paths.json` classifies every direct dependency as `dev`, `runtime` or `live`.

- **A changed `runtime` or `live` package needs a ledger, and so does a package they load that leaves its semver range.** A direct dependency or Docker pin needs a section for any change. A package a `runtime` or `live` package loads, transitively within its lockfile, needs one only when it moves to a release line it was not on (a new major, or a new minor before 1.0); a move inside its range rides on its parent's section, and on the live-path tests where it sits under a live package. The PR adds or edits a file under `docs/dependency-changes/` with one section per package the gate names:

  ```markdown
  ## @chat-adapter/discord 4.29.0 → 4.41.1

  Source: https://github.com/vercel/chat/releases (4.30.0 through 4.41.1)

  - 4.39: postMessage on an unseen thread resolves its parent channel first · test: src/channels/discord.test.ts
  - 4.38: forwarded snapshots fold into the message text · not covered: no forwarded-message fixture yet
  ```

  The heading's versions must match the lockfiles; a set of versions is comma-joined, and a package added or removed reads `none`. `Source:` names the changelog or release notes read for every version in between. Each bullet is one behaviour change and ends in `· test: <path>` (an existing `.test.ts` file) or `· not covered: <reason>`. When the changelog lists none, say so in one bullet with its coverage. Packages that moved between the same versions may share one heading, comma-separated (`## a, b 1.0.0 → 1.1.0`), as an SDK and its platform binaries do. A `dev` change needs nothing, and each package is explained in one ledger only.

- **A move beneath a `live` package needs a real-library test of each live path it is on.** The gate follows each `live` package's dependencies at exact versions through the lockfile (pnpm's resolved snapshots, bun.lock's nested keys), so any version that package loads at the head and did not at the base blocks its untested paths, however deep, including a consumer repointed onto a version already locked for something else, the project itself moved onto a version of a live package that something else already loads, and a changed peer resolution. Each consumer's move is judged on its own, and its versions count toward the change an Override is judged on. A copy of the same name that only something else loads does not, and neither does a type-only `@types/*` package. A package live at the base still counts as live in a change that reclassifies it. A live path is an I/O path the fleet depends on: chat inbound and outbound, attachment download, the OneCLI gateway, each agent provider, MCP. Its test drives the real library over its real transport against a local fake of the remote end, never a mocked module: `src/channels/slack-live-path.test.ts` runs the host's Slack wiring, `@chat-adapter/slack`, `@slack/socket-mode` and `@slack/web-api` against a local Web API and Socket Mode server. The file name contains `live-path`, so CI's `Live-path adapter tests` step runs it on every PR. A live path with no test yet blocks every upgrade of its packages until someone writes one and lists it in the registry, and a test counts only once the registry at the PR's base lists it: a new test merges in its own PR before the bump that relies on it. A listed test must load a package on its path at runtime, itself or through the repo modules it imports, and no module it reaches, nor vitest's setup files, may mock that package; a type-only import does not count, and a mocked repo module does not count as loading what it imports. Removing a package is not blocked.

- **Not seen.** Runtime code no lockfile or pin records: the transitive dependencies of tools installed globally in the image, the Node runtime itself (and the `undici` bundled under its `fetch`), a floating base-image tag, and tools fetched from GitHub releases, which the gate pins only by their ARG references. pnpm records peer variants of one `name@version` as one node, so a consumer switched to a peer variant already locked is not seen. A new package that replaces a live one can be classified `runtime`; the reviewer checks that.

- **Incidents.** A hotfix patch on the shipped version, or a rollback to an older version, may pass an untested live path with an `Override: <incident and reason>` line in its ledger section. The gate prints it as a warning. An upgrade can never be overridden, and dropping one of several locked versions counts as an upgrade: its consumers move up.

- **The registry cannot quietly get weaker.** Dropping a package's live path, or a test from a live path, fails unless a ledger in the same PR says why: `Reclassified: <package or live path> · <reason>`. A PR that weakens a package's class, or a live path it is on, may not also change that package's version, however it is explained: the reclassification merges on its own first. To unblock a live path, write its test.

## Host peer-version lockstep: `vitest` / `@vitest/coverage-v8`

Outside the container-update flow above: `@vitest/coverage-v8` (`package.json` devDependencies) is a `vitest` peer, not an independently-versioned package, and must stay exact-pinned to the SAME version as `vitest` itself. Bumping one without the other risks a version mismatch the install silently tolerates but the coverage machinery (`vitest.config.ts`, `scripts/check-risk-coverage.ts`) does not. When bumping `vitest`, bump `@vitest/coverage-v8` to the identical version in the same change.
