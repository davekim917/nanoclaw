# Execution

Implementation in an isolated worktree. The live non-root reproduction is accepted:
`jq -e` on empty input can exit successfully, and the previous code ignored the
append command status. No product campaign or promotion hold is cleared by this fix.

Implementation review cleared after the requested regression was added and verified against old and corrected source.

Reproduced environment difference: both host tool and agent container run as
UID 1001. Host jq 1.7 returns 4 for empty `jq -e` input; container jq 1.6
returns 0. The prior passing host suite therefore did not prove the deployed
container behavior. The correction must not depend on that version difference.

The full host jq 1.7 suite passes with the corrected source. The same new
regression against unchanged HEAD fails at the intended invariant: an empty
ledger falsely returns `ok:true`, `handoff.written:true`, `leaseReleased:true`.
The fixture narrowly models jq 1.6 empty-input behavior and separately retains
the non-root mode-0400 append refusal. It verifies retained slot/lease, then one
matching ledger record and release only after a successful same-run retry.

Other-family source review completed via configured Opus/high fallback:
`claude -p --model 'claude-opus-5[1m]' --effort high --safe-mode
--no-session-persistence --permission-mode plan --tools '' --strict-mcp-config
--output-format json --json-schema <review-schema>`; foreground timeout 3600s.
It found no additional source control-flow defect. Its MUST-FIX requested the
portable regression absent from the early source-only bundle; the red/green
proof above supplies it. Optional stderr suppression was declined: stdout
remains the single JSON outcome and stderr retains useful write diagnostics.

The exact ledger acceptance case also passes as container UID 1001 with jq 1.6;
unchanged source fails the same case with false success. Both the mode-0400
failure and the restored-permission retry are covered with inert fixtures.
The first full container run stopped at a later assertion after reaching the
ownership scenarios; the diagnosis and successful final rerun are recorded below. The container fixture needs executable temporary storage for
mock gh/curl commands; the initial noexec setup was corrected for the test only.

The later container-suite stop was identified precisely: the initial two-second
lease in the expired-owner fixture expired during claim verification. A bounded
12-claim reproduction failed 3 times with the same run/owner still recorded,
consistent with expiry crossing the integer-second clock during a 1.6–1.7s claim.
Fixtures now acquire with a normal margin, then atomically set the isolated lease
expiry to a known past instant. This removes timing dependence without changing
production lease semantics. Final full gate suites PASS on host jq 1.7 and
container UID 1001 / jq 1.6, both reporting `smoke pr gate tests passed`.
The formerly failing extracted ownership tail also passes.

Validation commands: `bash container/skills/smoke-test/scripts/smoke-pr-gate.test.sh`
on each runtime; `git diff --check`;
`pnpm run check:public-boundary -- --root <worktree> --index`.
All passed. Gate SHA256: `90aeb504d6db919517f5a8a657f3f5153092c7cd5d3df59146f2064f23c6a00e`;
test SHA256: `cf406360be6407bde340e47a8d8ee5f25f9c8494cfbd9e53872b19770cc11475`.

Publication, mounted installation, and the separately dispatched agent review
remain distinct from these completed source and container test results.
