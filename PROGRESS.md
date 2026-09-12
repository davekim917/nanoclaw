# fix/formatter-escape

## Milestones
- [x] Worktree created at /home/ubuntu/wt/formatter-escape, branch fix/formatter-escape off origin/main (73de3cd74)
- [x] Read verify-710 ADJUDICATION.md F3, formatter.ts, request-choice.ts:49
- [x] Applied escaping fix (task prompt, script output, webhook payload, spawn-cancel reason, system_response result)
- [x] Added formatter.test.ts coverage for all 5 paths + 1 readability check (6 new tests)
- [x] bun install (container/agent-runner) — 107 packages, clean
- [x] pnpm install --frozen-lockfile (root) — clean
- [x] bun run test (full suite, detached) — 1765 pass / 0 fail / 4 skip
- [x] tsc -p container/agent-runner/tsconfig.json --noEmit — exit 0
- [x] Fixed pre-existing type drift in formatter.test.ts fixtures (chatRow x2,
      attachmentRow) missing series_id/source_session_id/on_wake — not caught
      by the official gate since tsconfig.json excludes src/**/*.test.ts, but
      confirmed and fixed per team-lead correction.
- [x] Verified new tests fail on pre-fix code (git stash of formatter.ts) —
      all 6 failed with the expected raw-injection output; passed again after
      unstash.
- [ ] Commit, push, open draft PR
