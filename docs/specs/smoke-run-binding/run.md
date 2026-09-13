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
