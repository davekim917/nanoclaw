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

## Review availability

A valid review is evidence; a silent or unavailable provider is not. When the
authenticated GitHub Codex connector reports its code-review usage limit for
the current head, or its bounded foreground wait expires, immediately use an
already accepted independent review route. Do not wait for a human quota reset
or seek new permission just to select that route.

The substitute reviewer starts in a fresh context and receives the final SHA,
complete diff, relevant files, this policy, and every existing finding. Prefer
another capable agent or provider. Implementation reasoning cannot approve its
own change. A substitute review still triages findings under this policy and
does not relax required CI, holds, or merge authorization.

The substitute, like every review (a delta check after a rebase or ratchet
regeneration, adversarial verification, a gap analysis), uses the native
`worker-frontier`: Claude's `model:` frontmatter or Codex's
`CODEX_WORKER_MODELS['worker-frontier']` (`src/claude-agent-md.ts`). High is the default worker effort; the default worker is `claude-opus-5` on Claude and `gpt-5.6-sol` on Codex.
An explicit task override must use a runtime field or the
scoped CLI helper described in `docs/frontier-worker-trial.md`, never prompt
wording. The allowed ids are generated from the frontier configuration plus explicit
receipt compatibility for prior `claude-fable-5-1` and `gpt-6-astra` reviewers.
Those IDs remain accepted so unchanged exact-head evidence survives this
roster migration; they are not new dispatch defaults. The existing gate
accepts these IDs for both receipt submission and receipt consumption:
`container/skills/pr-review-loop/reviewer-models.txt`
(`scripts/reviewer-models.ts --write`) — and `codex-review.sh receipt` /
`merge-check` enforce it mechanically against `--reviewer`'s **first
whitespace-delimited word** (a `[1m]` suffix on that word is tolerated): a
`--reviewer` not starting with an allowed id is refused before it posts, and
an approving receipt whose first word isn't allowed does not unlock a merge.
The reviewer reports its **exact model id from its own runtime** — a Claude
subagent from its system prompt, Codex from the `-m` it ran with or
`codex exec`'s session metadata — as that first word, and the receipt's `--reviewer`
copies it verbatim, e.g. `claude-opus-5 (worker-frontier)` or
`gpt-5.6-sol high (codex exec)`. Nobody has to be free for this: the author
may start that reviewer as a fresh process
(`codex exec -m gpt-5.6-sol -c model_reasoning_effort=high`, or
`CLAUDE_CODE_EFFORT_LEVEL=high claude -p --model 'claude-opus-5[1m]' --effort high`) and hand it the inputs above.

Record a durable review receipt tied to the exact final SHA: reviewer and
runtime, complete-diff and relevant-file scope, outcome, and every finding with
its disposition. A local completion claim is not substitute-review coverage.

## Changing the worker policy

The roster above — which model the frontier worker runs and at what effort — is
**not owned by this repo**. It lives in one hand-edited file in the bootstrap
plugin, `plugins/workflow/worker-policy.json` (`~/plugins/bootstrap`), and
everything mechanical on both sides is rendered from it. NanoClaw is a consumer:
`CODEX_WORKER_MODELS`, the vendor manifest's `codexModel`, and the container
config's `[agents].default_subagent_reasoning_effort` all read
`src/worker-policy.vendored.ts`, which only the vendor script writes.

Flipping it — for an experiment or for good — is four steps, in this order:

1. In `~/plugins/bootstrap`, edit `plugins/workflow/worker-policy.json`, run
   `node plugins/workflow-agents/scripts/sync-agent-skills.mjs`, then
   `node scripts/check-parity.mjs`. The gate names every prose surface that
   still states the old policy; fix those by hand. Commit, PR, merge.
2. Here, `pnpm exec tsx scripts/vendor-workflow-agent.ts`. It refuses if the
   plugin is mid-flip (its policy file and its generated Codex role
   disagreeing), so a half-landed plugin change cannot be vendored.
3. `pnpm test` — `src/workflow-agent-vendor.test.ts` proves the vendored module
   is the current render, and `scripts/dispatch-default-docs.test.ts` fails by
   name any dispatch-policy doc still carrying the old default sentence. Update
   those docs, including the paragraph above.
4. PR, merge, deploy. **Containers pin the role at spawn**, so nothing changes
   for a running agent until its container restarts on the new image.

Step 2 is not optional and cannot be shortcut by editing
`src/worker-policy.vendored.ts` directly: the file is fingerprinted in
`src/workflow-agent-vendor.manifest.json`, and only the vendor script — which
needs the plugin repo — refreshes that fingerprint. A hand edit fails on every
machine, CI included.

The cross-model **review** lane is deliberately not governed by this policy: a
reviewer is chosen for independence from the artifact's author, not for the
worker tier. The reviewer id allowlist
(`container/skills/pr-review-loop/reviewer-models.txt`) is regenerated by
`scripts/reviewer-models.ts --write`, which reads the frontier configuration
separately.

## Review notes and fix links

Before writing or reviewing code, the author and the reviewer read
`docs/review-notes.md` and every `docs/review-notes/<PR>.md` fragment.

Every review verdict this fleet produces is posted as a receipt
(`codex-review.sh receipt`), `changes` included: a verdict that stays in chat
leaves nothing for the gate or the notes to read. A PR that received any
`changes` receipt, on any head, adds its own
`docs/review-notes/<that PR number>.md` fragment in the same PR, or carries a
body line `Review-notes: none (<reason>)` with a non-empty reason. The
fragment holds one or more lesson lines in the format and classes that
`docs/review-notes.md` registers; it never appends the shared historical file.
A finding fixed during review is a lesson as much as a deferred one, and it is
the kind that used to go unrecorded.
`codex-review.sh merge-check` refuses without one (exit 24,
`review_notes_missing`), and `audit` re-checks it as of the merge. A line
inside a code fence or an HTML comment doesn't count, and the reason is one
parenthesised phrase, nothing after it on the line, with at least one visible
character. Zero-width space, soft hyphen, zero-width joiner, and other Unicode
format characters are allowed inside an otherwise-visible reason; a reason
left with nothing but those, whitespace, control characters, bare combining
marks, or a handful of blank-looking codepoints (U+2800, U+3164, U+115F,
U+1160, U+FFA0) once they're stripped is refused. Deferring a finding to an
issue, or reverting a PR, adds a line too.

When this rule, or any merge-check rule, changes on main, re-extract the gate
before the next merge. A PR merged through a skill copy extracted before the
change landed, but merged after it, is audited under the rule its merge
commit carries — each merge is audited with its own commit's copy of the
skill (`.github/scripts/gate-audit.sh:175-180`) — and can be flagged
`gate-bypass`. No go-live cutoff is needed.

A class on a second aggregate line must name a structural fix on its newest
line: the lint rule, test or primitive that now catches it.
`scripts/review-notes.test.ts` fails the PR that records the second occurrence
without one, which is where that fix belongs.

When the PR carries `risk:*` dimension labels, they scope the reviewer's
brief. Labels are for reading: `codex-review.sh scope` decides whether a head
is reviewed at all from the PR's changed files, and a label can only add
review, never remove it.

Every `fix` PR carries `Fixes-PR: #<n>`, naming the PR it fixes, or
`Fixes-PR: none` in its body; `codex-review.sh merge-check` enforces it. A
line inside a code fence or an HTML comment doesn't count.

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

A class that survives three rounds is a design defect at a seam, and the fix
is the primitive, not the next call site: the loop refuses site patches until
it lands. A finding class is the invariant a finding cites plus the seam its
flagged sites share, so one missing guard reported at four call sites is one
class with four rounds, not four files with one round each — the shape a
file-level detector cannot see, and the shape that ran PR #291 to fourteen
rounds. `pr-review-loop`'s gate (`codex-review.sh gate`, run by
`codex-review.sh push`) makes this deterministic: three rounds on one class, or
on one seam with severity not falling, exits non-zero naming the class, the
sites and the candidate primitive, and lifts only on a commit that touches that
primitive or carries `Reframe: <invariant> enforced in <primitive>`. A class
whose seam the classifier cannot substantiate — no shared import, or a single
flagged file whose findings name nothing that module exports — is reported and
not gated, because the refusal would name a primitive the fix has no reason to
touch and the override would be the only way out. The reframe trailer may name
any primitive the commit itself introduces, not only the classifier's
candidates. `REVIEW_LOOP_ALLOW_SITE_PATCH=1` overrides the gate loudly and
records the override in the PR body. Agent containers get the same gate at
their own push primitive — the `git_push` tool runs it before pushing — so the
rule does not depend on which surface is working the loop.

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

## Reporting shape

For reviewers whose prompt we compose (the bot's is OpenAI's — see above):
for any race, TOCTOU, or ownership finding, report the CLASS once — enumerate
every site in the PR that has it in one pass, and name the primitive where the
invariant belongs. Do not report the same class at one site per round. One
site per round is what turns a single missing guard into a fourteen-round PR,
and it is the reviewer half of the escalation rule above.

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
