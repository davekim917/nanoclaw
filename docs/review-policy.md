# Review policy

The fleet's review severity contract: what a review finding is for, what
blocks a merge, and what reviewers should not report. One definition —
skills and prompts point here instead of restating it.

## What this file binds — and what it cannot

Binds:

- Triage of incoming review findings (`pr-review-loop`, host and container
  copies).
- Any review prompt this fleet composes itself: the bootstrap cross-model
  review step, `/code-review` invocations, ad-hoc reviewer briefs.
- Workgroup triage: workgroup runbooks cite this file and may extend it with
  binding rulings of their own.

Does NOT bind: `chatgpt-codex-connector[bot]`. Its PR auto-review prompt is
OpenAI's, not ours. The bot reporting a nit outside this policy is expected,
not a violation — this policy governs how such findings are triaged, not
what the bot says.

## The test is blocking, not correctness

Most findings should not stop a merge, including real ones. Review exists to
catch what is glaringly destructive; quality comes from the whole gauntlet —
automated review, QA, humans using the thing.

- **Blocks — destructive.** Data loss or corruption; money computed, moved,
  or reported wrong; tenant or scope isolation breached; auth or permission
  bypassed; credentials exposed; a migration whose undo does not exist.
  Blocks at any round; no deadline lowers the bar.
- **Does not block — record it and merge.** Everything else, including real
  defects that are narrow, cosmetic, adjacent, pre-existing, or hardening
  niceties. Record the finding wherever the deployment collects them, link
  it from the thread, resolve the thread, merge.
- **Exception — a finding that contradicts a claim in the PR body never
  merely gets recorded, at any severity.** Fix the code or fix the body.
  Pasted test output is a claim. Correcting the body is usually the right
  branch — it costs no push, so review coverage at head stands, and the
  finding stays recorded.

State the classification in one line in the thread. An unnamed call cannot
be overruled, and a human overruling you is the point.

Every finding deferred (recorded instead of fixed) carries its reason and a
re-raise trigger — a deferral with no trigger is a finding that quietly
disappears.

## Escalation is severity direction, not round count

There is no round number that forbids a push. A high round count with
severity falling is convergence; severity flat or rising across rounds means
stop and diagnose out loud before touching code.

## Fix discipline

Accepting a finding authorizes the finding, not any fix. Two rules bind
whoever writes the fix — a review loop, an auto-fix pass, a worker:

- **Scope expansion escalates to a human.** If the honest fix adds machinery
  (a new helper layer, flag, wrapper, config), a new dependency, or edits
  outside the diff's existing footprint, it leaves the batch: post the
  finding with the fix you would make and let a human route it onto this PR
  or its own. Measured on this fleet (2026-08-31, last 20 merged PRs): 94%
  of later-round findings landed on code fix commits had touched — the
  fixes, not the original diffs, were generating the rounds.
- **Simplification over machinery.** Prefer the fix that subtracts: tighten
  an existing guard, hoist the check to the seam every caller shares, delete
  the path the finding lives on. If no simplifying fix exists, that is a
  design signal — escalate it, don't build around it.

## Do not report

For reviewers (where we control the prompt) and triagers alike:

- Generated files, lockfiles, and vendored mirrors — they have their own
  drift gates.
- Anything a deterministic gate already enforces: formatter, linter,
  boundary check, parity/conformance/drift tests, required CI checks.
- Pre-existing defects outside the diff — record them in the deployment's
  log, never as PR findings.
- Rate-limit warnings and transient provider errors — the fleet has key
  rotation and fallback; these are never findings and never escalate.
- Style preferences no formatter enforces.

## Workgroup extensions

A workgroup runbook may refine this policy with binding rulings of its own
(for example, a reachability gate on which destructive findings block in
that deployment). The PR-body-contradiction exception outranks any such
refinement.
