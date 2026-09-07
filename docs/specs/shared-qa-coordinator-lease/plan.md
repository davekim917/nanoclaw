# Shared QA coordinator authority

Status: implementation under the approved fleet workflow repair objective.
This repairs a demonstrated coordination defect; it does not expand release,
production, credential or takeover authority.

## Required result

Every coordinator of a shared campaign must consult the same lease authority.
A stale coordinator must not publish, renew, finish, release, delete a successor's
lease, or alter shared verdict/hold/ledger artifacts after losing ownership.
Private per-PR history remains in place; historical evidence is not migrated or
recertified. A failed evidence attempt has an agent-owned fresh recovery route.

Use the existing shell gate and flock primitives. Separate the workgroup-shared
lease directory from private per-PR state. Carry the actual acquired owner token
through lifecycle calls and coordinator lane briefs. The contract/marker/redispatch
writer must validate that same live authority under the shared lock through its
atomic write; private activeRunId is not sufficient. Hold the appropriate shared lock across ownership
validation and terminal effects so reclaim cannot race publication. Fail closed
on invalid/private/unwritable authority and lock or state write failures. Keep
explicit takeover restrictions and independent review requirements intact.

## Acceptance cases

- Two separately instantiated coordinators with private state and one shared
  lease root: first acquisition succeeds; second same-key claim is refused.
- Two separate private state roots claiming the same PR with different run IDs
  cannot both hold active campaign authority. A shared per-PR binding under
  the existing lifecycle lock identifies the current run and owner; the run
  lease remains the single source of lease expiry. Every lifecycle and scaffold
  writer validates both binding and live lease. A displaced binding cannot
  authorize writes merely because an old lease file remains.
- Owner renew and release succeed only for the current unexpired owner.
- A expires, B acquires, then A attempts progress/release/finish: A is refused,
  B remains owner, and no terminal verdict, hold, handoff or ledger is created
  or changed by A. Exercise the actual lifecycle, not only lease helper verbs.
- Concurrent terminal transition and reclaim cannot both succeed as owner.
- After A loses ownership to B, A cannot write a contract, marker or redispatch
  generation into the run tree, even when private activeRunId still matches.
  Properly briefed coordinator workers retain their parent token and can write
  fresh evidence while their parent owns the lease. The scheduled poll, bounded
  workers and later per-thread synthesis are distinct execution contexts; the
  acquired token must be carried explicitly through that authorized handoff.
- Missing, private-aliased or unwritable authority and lock/write failures
  cannot produce successful lease or terminal receipts.
- A poll failure after acquiring ownership rolls back only its exact acquisition;
  a successor is preserved, and rollback failure produces an attributable repair
  receipt instead of a silent orphan.
- All lease timestamps must be canonical, parseable UTC instants. Malformed
  timestamps never become expired leases eligible for automatic replacement.
- A shared run lease names its PR; identical caller tokens cannot bind the same
  live run to different PRs. Standalone renewal preserves that association.
- Existing gate lifecycle cases pass with explicit isolated shared lease roots;
  no test writes real workgroup lease state or invokes production effects.
- Actual installed wrapper routes to the reviewed helper and shared lease root.
  Independent execution contexts prove exclusion and cleanup before a new run.
- A fresh linked campaign uses new attributable evidence and independent
  challenger verification; old evidence and promotion holds remain preserved.

## Delivery

Build and review in an isolated worktree. Publish a narrow PR after the existing
repository approval boundary. Install only reviewed source and the verified
wrapper changes under the operator's deployment authority. Quiesce affected
writers before cutover; never replace live lease state. Retain prior source and
configuration for rollback, but never restore old ownership over a new lease.
Client-specific paths, findings and campaign receipts stay in private evidence.
