# Run: Slack live task list — PR 1

- **Authority**: the operator, 2026-09-24: "execute this plan autonomously end to end in full. By the end I should see
  the new experience in slack." Covers build, review, merge and deploy of this plan plus the SDK bump (#1126).
- **Owner/runtime**: built directly in the coordinating session (claude-opus-5-5); plan review Codex
  gpt-6-astra high (read-only sandbox), APPROVE WITH CHANGES, 9/9 findings folded in.
- **Evidence (worktree, throttled)**: host `tsc --noEmit` clean; container `tsc -p container/agent-runner` clean;
  eslint on touched files 0 errors; vitest 14 affected host files 523/523 + new `task-list-host.test.ts`;
  container `bun run test` 2457 pass / 1 fail — the fail is `test_claude_cli_agent_sdk_lockstep`, the shared
  `node_modules` confound (the worktree links the live checkout's container `node_modules`, installed SDK
  0.3.272 vs #1126's pinned 0.3.281), not this change.
- **Repair rounds**: 1 (test harness modelled delivery fate per row; typing module over-cut and restored).
