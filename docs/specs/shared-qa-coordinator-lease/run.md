# Shared QA coordinator authority execution

Status: implementation complete and independently reviewed. Publication,
installation and fresh campaign evidence remain separate completion gates.

## Result

Coordinator authority now resides in shared run leases and a shared per-PR
run/owner binding. The binding has no second expiry clock: the referenced run
lease is the single TTL authority. Claim, poll, lifecycle transitions and
scaffold writes validate that authority under shared locks. Separate private
state roots cannot start concurrent campaigns for the same PR under either
the same run ID or different run IDs.

The poll emits an opaque owner token for explicit worker and synthesis
handoff. Progress renews live ownership; an original owner can use checked
same-run claim after expiry. No idle model heartbeat or human coordinator
appointment is required. Existing explicit operator takeover behavior is
preserved, including takeover before the age ceiling.

Failed terminal writes remain unfinished and retryable. Failed repeat claims
preserve prior ownership. Corrupt bindings or referenced leases fail closed;
storage failures produce a valid throttled repair wake. Stale coordinators
cannot write reconciliation flags, terminal artifacts or lane metadata.

## Validation

- Gate, scaffold and evidence-barrier regression suites passed. Coverage
  includes stale owners across both shared and separate private state,
  same-PR/different-run exclusion, displaced bindings, expired-owner recovery,
  failed writes, claim rollback, poll tokens and failure-wake throttling.
- Build-identity and evidence-retention suites passed. A broader sweep was
  stopped in the unchanged develop-gate suite when review required source
  corrections; the interrupted sweep is not claimed as passing.
- Host typecheck, full host/scripts ESLint, shell syntax, diff whitespace and
  staged public-boundary checks passed.
- Final other-family implementation review returned clear with no findings.
  Configured Opus/high was used after Fable returned its model usage limit.
- The committed candidate passed the upstream divergence ratchet. These
  changes do not alter upstream-owned files or grow the measured divergence.

## Deployment evidence still required

The actual wrapper and task prompt were inventoried and prepared privately.
The current coordinator/release containers pass the shared mountpoint probe.
Those are preflight facts, not installation or exclusion proof. Cutover must
quiesce affected writers, install the reviewed helper and explicit wrapper
path, migrate the original-token handoff instructions, and prove exclusion
through separately instantiated mounted execution contexts.

A fresh campaign must then collect attributable evidence and independent
challenger verification. Historical evidence and existing promotion holds
remain preserved. No campaign is certified by these implementation tests.

## PR review corrections

All three inline review findings received code corrections: poll acquisition
rollback compares exact ownership snapshots under the shared locks; gate and
scaffold validate canonical, parseable UTC lease timestamps; and a run lease
keeps its PR binding even after expiry. New standalone claims require a
positive canonical PR number. Existing same-owner renewal preserves its PR.
All poll rollback failure paths retain the original owner token in a repair
receipt; test-only lock injection refuses the default workgroup mount.

A second other-family review used the configured Opus/high fallback through
`claude -p --model 'claude-opus-5[1m]' --effort high --safe-mode
--no-session-persistence --permission-mode plan --tools '' --strict-mcp-config
--output-format json --json-schema <review-schema>`, foreground timeout 3600s.
Both correction reviews completed with valid structured output. The first
raised one migration MUST-FIX: rejected against deployment evidence because
this PR has never been installed, the deployed helper stores private leases,
and the new shared directories do not exist. Other grounded corrections were
accepted in one batch.

The final raw verdict was `degraded` with only SHOULD-FIX findings. Lead
adjudication: the claimed missing rollback token contradicts the explicit
`coordinatorOwnerToken` error receipt; no successful filesystem operation that
silently lost its effect was reproduced. Additional fault-injection coverage
and more explicit run-ID refusal wording are non-blocking recommendations.
This records the reviewer output without turning its optional findings into
new human-approval gates. Focused test results and final lead disposition are
recorded at publication.

Final correction validation: gate, scaffold and evidence-barrier suites passed;
shell syntax and diff whitespace passed; fresh host typecheck and full
host/scripts ESLint passed. The one-second expiry fixture was widened to two
seconds with a three-second expiry wait after it correctly expired during
setup; no production behavior was changed for that fixture. Lead review is
clear: no unresolved material finding remains in the correction batch.
