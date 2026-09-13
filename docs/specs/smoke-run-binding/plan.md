# Shared task run binding

Issues #755/#757 require a task-scoped smoke run id to name one deploy SHA for
its whole lifetime, including after release and finish, across containers whose
gate state directories are private.

The existing shared coordinator ownership directory gains one retained
`task-binding-<runId>.json` record, serialized by the existing
`task-lease-<runId>.lock`. Its immutable fields are `runId`, `deploySha`, and
`boundAt`; `terminal` may move once from `null` to the exact verdict,
completion timestamp, and verdict digest. Task, PR, and develop claim producers
must consult it while holding that shared lock through their identity commit.
Task claim also refuses an existing shared PR run lease, closing the reverse
cross-private-root active PR-to-task race.

Claim lock order remains private gate/state locks, then the shared task lock,
then the existing PR run lock (and, for PR campaign claims, its existing PR
lifecycle lock before that run lock). Task acquisition proves PR-lease absence
under the run lock through its binding/private-slot commit, so PR
release/finish rollback cannot expose a temporary absence. No task path takes
the PR run lock before the shared task lock.

Release removes only the live task lease. Same-SHA unfinished task recovery is
allowed; another SHA and every PR/develop claim are refused. Finish commits the
shared terminal facts first, before the private write-once verdict, lease
removal, and private terminal state. Exact retries reconstruct only that exact
private verdict and reconcile every crash cut, including a missing lease after
removal, without changing the verdict, timestamp, digest, or identity.

Valid legacy shared task leases and this caller's provable schema-v1 task state
are backfilled under the lock. Conflicts and malformed shared storage fail
closed. An old release whose prior implementation erased every SHA-bearing
artifact cannot be reconstructed, so no identity is invented and no automatic
migration of unknown run ids is attempted.

Acceptance covers same and different private roots sharing one ownership
directory, manual and automatic PR/develop claim producers, reverse active
PR-to-task exclusion, lease/slot write rollback, terminal write/removal/state
crash cuts, terminal exclusion in another root with no private verdict,
malformed/unwritable shared storage, and the honest legacy proof limit.

Out of scope: a develop campaign still has no shared identity record, so a
task claim in another private root cannot discover a pre-existing develop
claim. This correction does not claim bidirectional cross-root uniqueness for
develop-to-task and does not add a develop ownership subsystem.
