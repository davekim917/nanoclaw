# QA and release recovery

Implement the approved recovery changes following an audit of a smoke campaign
and a release-status thread in a Slack channel.

## Outcome

Bounded findings receive an agent-owned fix, claim correction, or documented
deferral. Missing QA evidence triggers fresh, explicitly identified verification.
Repeatedly unreachable mandatory tests have an owner, remediation, affected
release scope, and clear condition. Existing production and explicit human holds
remain binding.

## Scope

- Shared smoke-test instructions, evidence barrier, and run scaffold only.
- A passing lane requires durable, nonempty evidence within its run directory.
- A recovery generation preserves the original marker before replacing it.
- Do not change old receipts, count an untested requirement as passed, or perform
  publish-test mutations.
- Installation-specific handoff and standing-rule changes remain outside this PR.

## Verification

Run both focused shell test suites, host and script typechecks, ESLint,
the public-boundary check, and the upstream divergence ratchet.
