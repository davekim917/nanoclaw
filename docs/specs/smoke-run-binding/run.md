# Shared task run binding run

- Approved design: one retained shared task binding under the existing task
  lease lock; immutable identity/SHA and one-way exact terminal facts.
- Implemented across manual and automatic task/PR/develop claim producers,
  including the standalone PR lease-claim seam and reverse active PR-to-task
  exclusion. Shared terminal facts commit before the private verdict and are
  the source for exact interrupted-finish reconstruction.
- Verified with `bash -n` on both gate scripts and tests, `git diff --check`,
  the full hermetic `smoke-pr-gate.test.sh`, `smoke-develop-gate.test.sh`, and
  `smoke-run-scaffold.test.sh` suites, plus `gate-campaign-test.sh`. Focused
  cases cover cross-private-root exclusion, malformed/conflicting evidence,
  lease/slot rollback, and crash cuts before/after binding, verdict, lease
  removal, and private state commit.
- Correction after readiness review: task acquisition now holds the existing
  PR run lock after the task identity lock through its binding/private-slot
  transaction, preventing PR release/finish rollback restoration races. The
  shared resolver now validates and backfills a surviving base-version task
  lease for all five reciprocal producers (manual PR, standalone lease,
  automatic PR, manual develop, automatic develop). Deterministic selective
  `mv` release/finish rollback fixtures and real base-gate legacy fixtures pass.
- Fresh correction verification passed both full hermetic gate suites,
  `smoke-run-scaffold.test.sh`, `gate-campaign-test.sh`, shell syntax checks,
  `git diff --check`, and the upstream ratchet (`959` entries unchanged,
  divergence delta `0`). The supplied diagnostic probes now stop at their old
  expected-success assertions: legacy reciprocal claim returns `ok:false`, and
  rollback-window task claim returns retryable PR-run-lock contention.
- Known scope limit: develop still publishes no shared identity, so the
  pre-existing cross-private-root develop-to-task direction is not covered or
  represented as fixed.
- Review lesson pending the eventual per-PR notes fragment: an identity
  invariant is shared only when every producer and rollback writer participates
  in one compatible lock transaction. The initial retained-binding fix still
  read through PR release/finish's temporary lease absence and ignored
  base-version task leases on reciprocal claims; the correction pins both
  failure classes with selective rollback and real legacy-producer fixtures.
