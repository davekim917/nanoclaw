# Dependency Updates

NanoClaw uses one deterministic release adapter for the weekly `#axie-dev` advisory and the `/update-container` workflow:

```bash
bun scripts/container-updates.ts audit --format json
bun scripts/container-updates.ts apply --repo <writable-clone> --items <id,id,...>
```

The policy is latest stable, including major releases. Prerelease, beta, RC, dev, nightly, draft, yanked, source-only Graphify, and incompatible releases are not candidates. Registry failures remain unknown. Exact Docker pins and committed pnpm, Bun, and Graphify locks remain mandatory.

The weekly task runs the audit as a pre-task script. A deterministic all-current result returns `wakeAgent:false`; otherwise the agent posts an advisory only. It never edits, opens a PR, merges, deploys, or restarts. `/update-container` presents exact item IDs, waits for human selection, applies only those IDs in writable clones, runs the relevant gates, and opens unmerged PRs.

Host and container changes use separate NanoClaw PRs. Host changes activate through the host build/deploy/restart path. Container changes activate through an image rebuild. Codex-synchronized files target the bootstrap repository and use a third PR. Graphify bumps with patch or upstream-skill drift are routed to a dedicated review change.

Graphify's canonical release contract is `container/graphify-integration.json`: PyPI version, Git tag and exact commit, upstream source/skill hashes, stable patch identity, public commands, and a capability ledger classified as `adopted`, `implemented-differently`, `deferred`, or `rejected`. `scripts/update-graphify.ts` resolves the latest stable PyPI/GitHub release, validates the patch and skill drift, and regenerates the Python 3.11 ARM64 wheel-only hash lock with uv. It performs every check before mutating tracked files.
