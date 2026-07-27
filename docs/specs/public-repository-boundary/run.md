# Public repository boundary run

Stage: implementation-reviewed; staged for ship
Approval: current-tree cleanup and prevention approved; published history excluded
Primary runtime: Codex

## Grounding

- Read repository instructions and contribution policy.
- Confirmed the public NanoClaw origin is `PUBLIC`.
- Confirmed the sibling groups origin is `PRIVATE`.
- Confirmed the public repository tracks zero files below `groups/`.
- Confirmed the private groups repository already uses an allowlist-style
  ignore policy and contains per-group config, standing instructions, and
  templates.
- Confirmed the live central registry contains:
  - 7 workgroups;
  - 21 agent groups;
  - 55 messaging groups.

## Redacted audit

The exact registry-driven inventory was generated in ignored scratch space.
No private literal or raw inventory is recorded here.

Initial exact-registry pass:

- 1,539 tracked files inspected.
- 149 non-generic exact registry values derived in memory.
- 138 tracked files overlapped at least one exact registry value.

The 138 files are candidates, not 138 confirmed violations. They include:

- active source paths containing private defaults;
- one-install scripts and live probes;
- tests and fixtures copied from production;
- skills and examples using live values;
- historical plans and captured QA output;
- legitimate public material requiring explicit review.

Concrete active surfaces inspected:

- `src/capabilities.ts`
- `src/container-runner.ts`
- `src/modules/support-threads/dispatch.ts`
- `src/modules/channel-auto-wire/index.ts`
- `dashboard/src/views/TaskDetail.tsx`
- `container/spawn-template.md`
- provider-sibling clone skills
- operator scripts under `scripts/`

## Commands and results

```text
gh repo view <public-origin> --json isPrivate,visibility
result: PUBLIC

gh repo view <groups-origin> --json isPrivate,visibility
result: PRIVATE

pnpm exec tsx scripts/q.ts data/v2.db <count query>
result: 7 workgroups, 21 agent groups, 55 messaging groups

pnpm exec tsx .claude/tmp/audit-private-workgroups.ts
result: 1,539 tracked files, 149 redacted registry values, 138 candidate files

git ls-files groups
result: empty
```

## Edge cases checked

- Generic live labels are not treated as private names by substring alone.
- Concrete platform and generated database identifiers remain covered even
  when their human label is generic.
- Runtime `groups/` content is not a public-tree cleanup target.
- Public project identity is distinct from private workgroup identity.
- Active private behavior is distinct from obsolete repair artifacts.
- The existing private groups working tree has unrelated changes; the plan
  requires an isolated worktree for private migration.
- Current-tree cleanup does not remove already-published history.

## Plan review

Status: completed with one bounded correction batch

Required reviewer:

- Runtime: Claude CLI
- Model: `claude-opus-5`
- Effort: `high`
- Permissions: plan, tool-disabled, safe mode, no session persistence
- Timeout: 10 minutes

### Attempts

1. Primary credential:
   - Command: `claude -p --model claude-opus-5 --effort high --safe-mode
     --no-session-persistence --permission-mode plan --tools ""
     --strict-mcp-config --output-format json`
   - Result: `nonzero-exit`
   - Evidence: HTTP 429 weekly limit before input consumption.
   - Retry: none.
2. Operator-requested alternate OAuth identity:
   - Command: same explicit command and timeout.
   - Result: `completed`
   - Effective model: `claude-opus-5`
   - Effective effort: explicit `high`
   - Permission denials: none; no tools configured.
   - Raw verdict: `must_fix`

### Finding disposition

Accepted:

1. Exact matching missed separator-free, case-folded, and regex-literal
   spellings. The plan now requires normalized matching and tests.
2. Pull-request-only CI did not cover the repository's direct-publish path.
   The plan now requires an install-aware pre-push gate and main-push CI
   alarm.
3. Tenant URLs, vendor organization IDs, support inboxes, and ticket-team
   labels are not present in the central database. The ignored local
   inventory is now mandatory for an install, and portable structural rules
   cover recognizable shapes.
4. Hook mode could have silently downgraded when local runtime inputs were
   missing. Install markers now make both local inputs fail-closed.
5. Personal-name instructions in runtime strings were ambiguously excluded
   as public author identity. They are now explicitly in scope outside exact
   metadata paths.
6. The private repository's allowlist could ignore a moved asset. Public
   deletion is now gated on private `git ls-files` and `git check-ignore`
   verification, with only exact allowlist expansion.

Rejected:

1. The reviewer claimed a pre-existing `scripts/check-pr-hygiene.ts` already
   implemented staged path checks. Direct source inspection proved that file
   is absent and the existing pre-commit hook only formats staged TypeScript.
   There is no duplicate scanner to extend or remove.

### Resulting coverage

Cross-model coverage: complete.
Correction loops: one.
Further plan review: not run, per the bounded-correction contract.

## Build start

- Approved plan: `docs/specs/public-repository-boundary/plan.md`
- Build started: 2026-07-26
- Published-history rewrite: explicitly excluded
- Existing public worktree state at start: only this feature's untracked plan
  directory
- Existing private groups worktree: contains unrelated memory-migration and
  runtime changes; implementation will not stage or modify that working tree

## Implementation

### Current-tree cleanup

- Replaced active tenant defaults with scoped install configuration for:
  - Atlassian base URL;
  - SELECT organization identifier;
  - support-ticket routing policy.
- Replaced the dashboard's tenant-qualified Linear link with Linear's
  issue-identifier route.
- Reduced the public spawn template to a generic product contract; private
  organization workflow remains outside the public repository.
- Deleted completed one-install repair, migration, scheduling, and live-probe
  scripts.
- Deleted tracked `.context/` workflow debris and captured QA evidence.
- Generalized the two operator scripts that still have repeatable product use.
- Replaced private values in active source, docs, skills, tests, fixtures, and
  historical artifacts with clearly synthetic values.
- Preserved useful operator-only runtime configuration and reauthentication
  automation in an isolated private-groups worktree:
  - `ops/nanoclaw/runtime-config.md`
  - `ops/nanoclaw/reauth-google.mjs`
- Verified the live public `groups/` directory remains untracked.

Private migration evidence:

```text
private worktree branch: chore/public-repository-boundary
private assets: 2 files, 275 inserted lines
git ls-files --error-unmatch <both assets>
result: both assets tracked in the isolated private worktree
node --check <private reauthentication script>
result: pass
```

### Prevention gate

- Added one TypeScript checker used by local hooks, manual checks, and CI.
- Install-aware mode derives redacted identifiers from the central registry
  plus a mandatory ignored local inventory.
- Portable mode rejects structural private-value shapes without install data.
- Both modes scan only text, report category plus file and line, and never
  print the matched value.
- Short private identifiers are checked only in installation-specific
  contexts such as scoped adapter, workgroup, tenant, or credential labels;
  unrelated acronyms remain valid.
- Added a five-entry exact allowlist containing only reviewed public project
  metadata.
- Added staged pre-commit and pre-push enforcement plus pull-request and
  main-push CI coverage.

### Mechanical-risk audit

- A bulk text replacement had touched four compressed image assets. ImageMagick
  exposed invalid PNG CRCs and a changed JPEG pixel stream. All four were
  restored byte-for-byte from `HEAD`; they are absent from the final diff.
- The same rewrite temporarily materialized the tracked `AGENTS.md` symlink.
  It was restored to the original `AGENTS.md -> CLAUDE.md` link; no mode change
  remains.
- The public diff currently contains no changed binary asset or file-mode
  change.

## Verification before implementation review

```text
pnpm exec tsx scripts/check-public-boundary.ts --db data/v2.db
result: pass, install-aware worktree scan

pnpm exec tsx scripts/check-public-boundary.ts --portable
result: pass, portable worktree scan

pnpm exec tsc --noEmit
result: pass

pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
result: pass

pnpm run build
result: pass

git diff --check
result: pass

focused repair suites
result: 214 passed

focused final affected host suites
result: 255 passed

pnpm exec vitest run
result: 230 files passed; 3,089 tests passed; 1 skipped; 1 todo

container/agent-runner: bun test
result: 933 passed; 4 skipped; one mid-turn fast-mode case timed out at 10s

container/agent-runner: bun test src/poll-loop.test.ts --timeout 20000
result: 97 passed; timed-out case passed in 507ms
```

The isolated container timeout is classified as aggregate-suite contention,
not a product regression: the same case passed in isolation with all 97 tests
in its file, and the public-boundary implementation does not change that path.

### Edge and failure cases checked

- Missing install registry or missing local inventory fails closed.
- A source-only clone may use portable mode without install data.
- Staged-index scanning sees a staged private value even when the worktree copy
  is clean.
- Normalized case, separator, collapsed, and regex spellings are detected.
- Short private identifiers are detected in scoped installation contexts
  without flagging unrelated historical acronyms.
- Reserved domains, synthetic Slack/Discord IDs, GitHub no-reply addresses,
  and numeric WhatsApp JIDs remain valid fixtures.
- Scoped Atlassian configuration rejects missing, malformed, and non-HTTPS
  values by omitting the MCP instead of falling back to a private tenant.
- Scoped configuration is inherited through sibling credential folders.
- Support-ticket routing keeps a generic product fallback when no private
  policy is configured.
- The current public repository tracks zero files under `groups/`.
- Published history remains unchanged.

### Diff size before review

```text
tracked diff: 292 files, 2,010 insertions, 32,568 deletions
untracked in-scope files: 6
tracked deletions: 57
```

The high deletion count is captured QA output, obsolete `.context` workflow
artifacts, and completed one-install scripts. Active product changes are
bounded to configuration seams, generic examples, and the single prevention
gate.

## Implementation review

Status: one bounded correction batch applied

Required reviewer:

- Runtime: Claude CLI
- Model: `claude-opus-5`
- Effort: `high`
- Permissions: plan, tool-disabled, safe mode, no session persistence
- Timeout: 10 minutes
- Result: completed
- Raw verdict: `must_fix`
- Effective model metadata: `claude-opus-5`
- Permission denials: none

### Finding disposition

Accepted and corrected:

1. The checked-in allowlist would have flagged its own reviewed public email
   and Discord values once staged. The checker now permits a value only while
   serializing a documented allowlist entry; install-aware private-identifier
   matching still rejects a private value placed in that file.
2. Test and spec filenames had a broad structural-identifier exemption. It
   was removed. Realistic identifiers are constructed at test runtime, and the
   portable scanner test proves a realistic value is rejected inside a
   `*.test.ts` file.
3. Public repository and marketplace coordinates had been rewritten to a
   fictional owner. All such coordinates were restored to the verified public
   origin owner.
4. NanoClaw's generic `agent@nanoclaw.local` commit identity had been rewritten
   as a fixture. It was restored and explicitly classified as a safe local
   product identity.
5. The simplified spawn template had lost the worker lifecycle protocol. It
   remains small and organization-neutral, but once again requires
   `spawn_progress`, terminal `spawn_complete` or `spawn_failed`, hard-block
   `spawn_request_steer`, soft-preference `ask_question`, and applicable ship
   log or backlog updates.
6. Scoped Atlassian and SELECT behavior lacked direct tests and live evidence.
   Tests now cover configured, missing, cross-folder, malformed, non-HTTPS,
   wrong-host, and non-root Atlassian inputs. A redacted live snapshot confirmed
   all three declared sibling agents resolve both services and the runtime MCP
   config through their shared credential folder.
7. Generic Git SSH, Google no-reply, WhatsApp JID, OneCLI proxy, and NanoClaw
   local-email forms had been over-sanitized. Their functional forms were
   restored and pinned as safe public examples.
8. The Profound runbook referenced a deleted one-install script. It now uses
   the supported generic workgroup-secret CLI and explicitly warns that the
   complete baseline is replaced.
9. The config-generator regression test had become an absence assertion for
   deleted scripts. It now checks the two remaining config generators for the
   retired GitNexus fields.
10. The OneCLI drift query parser was verified against the documented
    pipe-separated `q.ts` output: one sampled row produced two fields without
    exposing either value.

Rejected with evidence:

1. Restoring private organization labels in Docker comments or entrypoint text
   would violate this feature's product boundary. Public repository ownership
   was restored; private workgroup identity was not.
2. The generic Linear issue route was challenged as potentially invalid.
   Linear's published changelog documents `linear.app/issue/ENG-123` as the
   historical universal issue-link format, so the tenant-neutral route was
   retained: https://linear.app/changelog/page/21
3. The ignored identifier inventory was claimed to lack ignore evidence.
   `git check-ignore -v` resolves it to the repository's `.nanoclaw/` ignore
   rule.

No second cross-model review was run: the approved workflow permits one
correction batch, followed by deterministic verification.

### Correction-batch verification

```text
focused implementation-review suites
result: 4 files passed; 105 tests passed

public boundary checker unit suite
result: 13 tests passed

portable worktree scan after removing test exemptions
result: pass

install-aware worktree scan after restoring public product forms
result: pass

host TypeScript check
result: pass

container TypeScript check
result: pass

host build
result: pass

redacted live capability snapshot
result: 3 Atlassian declarations configured; 3 runtime MCP configs valid;
        3 SELECT declarations configured

git check-ignore -v .nanoclaw/public-boundary-identifiers
result: ignored by .nanoclaw/

q.ts output-shape probe
result: 1 row; 2 fields

git diff --check
result: pass
```

## Final staged verification

```text
install-aware staged-index scan
result: pass

portable staged-index scan
result: pass

actual .husky/pre-push hook
result: pass

staged diff whitespace check
result: pass

staged workgroup paths
result: 0

staged image assets
result: 0

AGENTS.md
result: original CLAUDE.md symlink preserved

full container suite with 20-second per-test contention allowance
result: 938 tests; 0 failures; 4 skipped
```

The post-correction full host aggregate executed 3,100 tests: 3,095 passed,
1 skipped, 1 todo, and three untouched process/timing cases reported only
Vitest's aggregate `STACK_TRACE_ERROR`. The exact three files were rerun
together immediately afterward:

```text
src/message-archive.test.ts
src/dashboard/api/scheduled-mutations.test.ts
src/modules/memory/curator-write.test.ts
result: 3 files passed; 54 tests passed
```

Those failures are classified as aggregate-run contention, not regressions:
none of the three files is modified by this feature, all exact cases pass in
focused execution, the pre-review full host suite passed, and the
post-correction 105-test affected suite also passes.

## Review outcome

Implementation review outcome: ready for the separate human-controlled ship
boundary. The public and private repository candidates are staged but not
committed, pushed, merged, or activated.

## Ship preflight

Fresh readiness checks were run on 2026-07-27 against the exact staged
current-tree cleanup:

```text
install-aware staged-index scan
result: pass

portable staged-index scan
result: pass

host TypeScript check
result: pass

container TypeScript check
result: pass

host build
result: pass

full host suite
result: 230 files passed; 3,098 tests passed; 1 skipped; 1 todo

full container suite
result: 933 passed; 4 skipped; the known mid-turn fast-mode case timed out
        at its hard-coded 10-second aggregate limit

isolated container poll-loop suite
result: 97 passed; the aggregate timeout case passed in 505ms

private reauthentication script syntax
result: pass

public and private staged diff whitespace checks
result: pass
```

The isolated container result confirms the same previously reviewed
aggregate-suite contention behavior; the feature does not modify that path.
