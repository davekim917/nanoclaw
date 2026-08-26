# Dependency Updates

NanoClaw uses one deterministic release adapter for the weekly `#example-dev` advisory and the `/update-container` workflow:

```bash
bun scripts/container-updates.ts audit --format json
bun scripts/container-updates.ts apply --repo <writable-clone> --items <id,id,...>
```

The policy is latest stable, including major releases. Prerelease, beta, RC, dev, nightly, draft, yanked, and incompatible releases are not candidates. Registry failures remain unknown. Exact Docker pins and committed pnpm and Bun locks remain mandatory.

The weekly task runs the audit as a pre-task script. A deterministic all-current result returns `wakeAgent:false`; otherwise the agent posts an advisory only. It never edits, opens a PR, merges, deploys, or restarts. `/update-container` presents exact item IDs, waits for human selection, applies only those IDs in writable clones, runs the relevant gates, and opens unmerged PRs.

Host and container changes use separate NanoClaw PRs. Host changes activate through the host build/deploy/restart path. Container changes activate through an image rebuild. Codex-synchronized files target the bootstrap repository and use a third PR.
