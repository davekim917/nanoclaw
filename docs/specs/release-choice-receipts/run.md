# Release choice receipts — build run

## Start

- Detached host and private-workgroups worktrees started from their respective
  current `origin/main` heads. The private base included the previously merged
  release-policy integration.
- Scope: host producer/migration first, then the private read-only consumer
  and recorder protocol, plus a separately versioned release-agent instruction
  update. No canonical checkout, live database, card, task, service, status,
  generated-instruction, or saved-task mutation.
- Qodo configuration is absent, so no Qodo rules were available to apply.
- Test-first is materialized alongside the tightly coupled producer and schema
  changes rather than as a separately runnable partial tree; the first focused
  run will be recorded before broad verification.
- Response contract: generic `choice_response` bytes are unchanged. Valid
  scoped cards append URI-encoded, host-canonical `release_scope`; the
  cross-language fixture drives the registered action and authorized callback,
  then decodes that real response into the private gate reader.
- Third repository footprint: a fresh instructions worktree adds only the
  scoped release-card/recorder protocol. It requires the saved watcher prompt
  to reference that protocol before use, keeps ordinary decision cards generic,
  and does not recreate develop-ship grants. Installation IDs remain in private
  consumer/instruction repositories; none appears in public source.

## Ratchet disposition

- The upstream-ratchet report found exactly two expected upstream-owned growth
  paths: the migration registry import/entry and its convergence/version
  expectation. The implementation lead accepted only those paths because the
  additive release-choice receipt migration 080 requires one registry
  import/entry and convergence/version expectation; no upstream feature
  duplication. No blanket acceptance is authorized.

## Verification

- Focused host Vitest: 4 files / 49 tests passed, covering runner scope
  validation, canonical host rendering, legacy response byte compatibility,
  scoped URI response transport, CAS-time receipt writing, migration
  compatibility and immutability, and registry convergence.
- Host and runner TypeScript checks passed. The focused runner Bun request-choice
  suite passed 32 tests.
- Private policy suite passed: 84 tests. Its cross-language case initializes a
  fresh temporary host DB, posts through the registered delivery action, drives
  an authorized response callback, decodes the host-origin response, and then
  reads the callback-written receipt through the private consumer. The fixture
  also refuses an existing DB path. The loader/main regression covers 16
  nested card-binding shapes and a separately scoped malformed hold; an
  unrelated valid target remains evaluable. Existing policy-test resource
  warnings remain outside this change.
- The isolated instruction-repository diff is one standing-instructions file;
  no canonical group file, task record, or generated instruction was touched.
- Changed public files pass Prettier. `git diff --check` passed in both
  isolated worktrees. The final ratchet report has zero unaccepted growth.
- No live database/card/task/service/status mutation, fabricated receipt, or
  human-click replay occurred. A genuine positive proof remains a post-deploy
  human click on a real scoped card.

## PR #787 CI correction

- The first remote correctness run stopped at ESLint's control-regex rule.
  The base validator intentionally rejects ASCII controls, so its unchanged
  expression now has a narrowly scoped, explained exception. No validation or
  repository-wide lint rule was weakened.
- Corrected the documentation boundary: private group instructions name the
  installation's approvers; the public source does not contain those IDs.
