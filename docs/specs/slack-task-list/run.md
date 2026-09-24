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
- **Implementation review round 1** (Codex gpt-6-astra high, read-only sandbox, vendored adversarial prompt +
  schema): needs-attention, 8 findings. Accepted and fixed: kill-edit authority from host evidence (1), identical
  retry after pending post dropped (3), memory-only / unordered interruption fence (4), unscrubbed status text (5),
  list edits holding answers (6, bounded wait + coalescing), switch-off stranding (8, null platform id = failed).
  Partly accepted: concurrency (2) — MCP-process serialization, no cross-DB transaction (duplicate post at worst);
  progress parity (7) — spawn-child lists internal; sibling-triggered turns keep lists (explicit agent action, and
  sibling bots drop list posts at inbound). Each fix has a regression test in task-list(-delivery).test.ts.
- **Implementation review round 2** (same transport, head f1bfbfac): needs-attention, 5. Accepted and fixed:
  kill-fence gaps (1: undelivered first post now dropped, newer-container record left alone, no unowned run on slot
  timeout), rate limits (2: per-row cooldown, uncharged, never blocks answers; bridge never waits inline for list
  rows), interrupted footer unscrubbed (4). Rejected with reasons in As built: cross-DB transaction (3),
  identical-retry after a switch flip (5).
- **Implementation review round 3** (same transport, head 7d23a7bd): needs-attention, 3 — all accepted and fixed:
  kill fence defeated by an identical update after respawn (`touchedAt` stamped on every save), cooldown bypassed by
  a newer revision or another session (cooldown keyed per platform), rate-limited interrupted edit lost (retried
  after the cooldown, re-fenced each attempt). Regression tests for each. Corrective budget: 3 of 3 used.
- **Implementation review round 4** (verification, same transport, head f4a8b2ee): approve, no findings.
