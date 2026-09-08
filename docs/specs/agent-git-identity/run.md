# Per-agent Git identity shipping record

Status: verification complete for the rebased implementation.

## Scope

The implementation adds an optional, per-agent `gitIdentity` configuration
block. It supplies all author and committer variables only for agents that
declare it. Existing scoped Git attribution remains intact when the field is
absent, including for the built-in NanoClaw MCP. The change does not configure
global Git state, repository identity, signing, or a default agent identity.

Initial enablement is an operator decision: add the optional field only to the
agents in the selected workgroup. Source activation requires a refreshed host
runner snapshot and fresh affected containers; this record makes no runtime
change.

## Review

- Primary implementation review: Codex.
- Cross-family Claude Fable 5.1 review: completed (high reasoning, safe mode,
  no tools or MCP, 60-minute ceiling; 131.9 seconds actual).
- The raw review verdict was `degraded` with no MUST-FIX findings. Source
  adjudication accepted the dead-export and comment corrections below, and
  rejected two low-confidence premises: the config reader already validates
  resources and MCP settings on read, and the Codex plus companion TOML
  renderers escape quotes and backslashes with `tomlBasicString` (the existing
  companion serializer test and a four-name serializer round-trip check cover
  quoted, backslash, and Unicode names).
- A malformed hand-edited `gitIdentity` can therefore follow the same
  pre-existing unisolated config-reader failure path as malformed resource or
  MCP configuration in all-group readers. This change keeps the established
  validation behavior; isolating those readers is separate future work if the
  condition occurs.
- GitHub automatic-review round 1 found a valid P2: the original
  control-character predicate rejected C0 and DEL but admitted C1 (`U+0080`
  through `U+009F`) despite the contract. The accepted correction rejects that
  whole range and adds C1 name and email regression cases.
- Automatic Codex review round 2 found a valid sibling-cloning gap:
  `gitIdentity` was neither sibling-bound nor removed by the Codex/OpenCode
  clone copy and parity filters. The accepted correction makes attribution
  opt-in per sibling and documents the same rule for future provider clones.

## Post-review correction

- Removed the unused host-side `GIT_IDENTITY_ENV_KEYS` export.
- Reworded the `runGitAt` environment comment to accurately describe the
  explicit per-call environment, including identity variation between calls.
- Expanded Git identity control-character validation from C0 plus DEL to C0
  through C1 plus DEL (`U+0000`–`U+001F` and `U+007F`–`U+009F`). The new C1
  cases failed before the predicate change and pass after it.
- Assessed a direct Docker-argument test. `buildContainerArgs` remains private
  and makes live OneCLI shell calls; the existing hermetic test setup has no
  Docker-argument harness for it. No production export or broad test refactor
  was added. The focused `resolveScopedCredentialEnv` tests directly assert
  configured override and no-opt-in scoped-human fallback instead. A direct
  spawn/MCP-bootstrap integration assertion is deferred until that wiring is
  refactored.

## Verification

The implementation predates this shipping record, so historical test failures
are not reconstructed here. Fresh focused checks run after the rebase cover
the contract in `plan.md`:

- Host focused tests: `src/container-config.test.ts` and
  `src/container-runner.test.ts` — passed, 191 tests.
- Runner focused tests:
  `src/nanoclaw-mcp-env.test.ts` and `src/mcp-tools/git-worktrees.test.ts` —
  passed, 31 tests. The linked-worktree test creates real plain-Git and managed
  `git_commit` commits, then verifies distinct author and committer fields.
- Host and script TypeScript checks — passed.
- Agent-runner TypeScript check — passed.
- Upstream-ratchet report — passed with no unrecorded divergence change.
- Public-boundary and whitespace checks — passed.
- Post-GitHub-round host focused tests (`src/container-config.test.ts` and
  `src/container-runner.test.ts`) — passed, 193 tests; host TypeScript check
  passed.
- Post-review runner focused tests (`src/nanoclaw-mcp-env.test.ts` and
  `src/mcp-tools/git-worktrees.test.ts`) — passed, 31 tests; agent-runner
  TypeScript check passed.
- Post-review upstream-ratchet report — passed. The expected host source
  cleanup reduced `src/container-runner.ts` from 7,512 to 7,501 divergent
  lines; overall divergence changed by -11 lines.
- Post-GitHub-round upstream-ratchet report — passed with the explicitly
  accepted `src/container-config.test.ts` growth from 842 to 844 divergent
  lines, solely for the two C1 regression cases.
- Post-round-2 sibling parity and clone-filter tests — passed, 12 tests;
  the focused host suite passed 205 tests across four files.

## Incoming main integration

- Merge validation against incoming `origin/main` commit `c1edef384` had one
  generated-file conflict: `src/upstream-ratchet.json`. It was reset to the
  incoming baseline and regenerated; the Git identity's four known host paths
  were the only accepted growth. The incoming provider resolver in
  `src/container-config.ts` auto-merged in separate hunks.
- On the pending merge tree, host focus passed 193 tests (75 migrations) and
  runner focus passed 31 tests; host and runner typechecks, source formatting,
  and the public-boundary check passed.

Raw output for the fresh checks is retained outside the repository with the
shipping evidence.
