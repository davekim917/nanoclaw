# Plan: Risk-Based Review

> Started 2026-09-10. Replaces blanket Codex auto-review on every PR with a path-selected
> review scope sitting on top of deterministic gates that are actually trusted.
> Prompted by Duckbill's "we ditched code review" thread (Mike Julian, @mikejulian on X, 2026-09-06),
> but deliberately NOT a copy of it — see [Non-goals](#non-goals).

## The problem, stated precisely

It is not "we review too much." Throughput is fine: 24 PRs merged in a 48h window,
median 2 Codex review rounds, median 0.8h to merge. Three things are actually wrong.

**1. The tail of the review loop manufactures defects.** Recent worst cases:

| PR | Rounds | Commits | Inline comments | Note |
|---|---|---|---|---|
| #566 | 12 | 15 | 48 | docs-only change |
| #588 | 10 | 10 | 34 | |
| #560 | 9 | 10 | 51 | |
| #584 | 7 | 10 | 17 | |

Historically #291 reached 14 rounds and #299 reached 18. Each round mutates code that
nothing re-validates end to end; the same reviewer re-reads its own suggestion's output.
`.claude/skills/pr-review-loop/SKILL.md` already documents this failure mode and ships a
mechanical circuit breaker (`codex-review.sh gate`, exit 3, at
`.claude/skills/pr-review-loop/scripts/codex-review.sh:9`) — #566 still reached 12 rounds,
so the breaker is either not on that path or does not fire for docs PRs. **Finding out
which is Tier 1 work already paid for.**

**2. A clean review does not predict a clean outcome.** PR #510 merged on a single clean
round (2026-09-06T14:18Z). #529 fixed defects in that same subsystem 13h later. #534 fixed
defects in *that* 11h after, with zero review rounds. Same seam, three PRs, 24 hours,
scrutiny falling at each step.

**3. Red on `main` has stopped meaning stop.** Eight of the last sixteen push-to-`main` CI
runs failed. At the time of writing, `main` had been red across three consecutive pushes on
two failures that were both stale committed manifests:

- `src/mailbox-seam-upstream.test.ts:42` — `container/agent-runner/src/mailbox/sqlite/connection.ts`
  stopped being a byte-identical copy of upstream `5c3082a1` when #588 (e4cefa3c8) added
  `refuseProductionSessionDbUnderTest()`. A real, permanent, intentional fork divergence
  that nobody recorded.
- `src/upstream-ratchet.test.ts:111` — `container/Dockerfile` grew 485 → 512 (+27) in
  322b5b766 without a regenerated `src/upstream-ratchet.json`.

Neither is a defect. Both look identical in CI to `session-close-expiry.test.ts` failing on
2026-09-08, which **was** a real regression from a just-merged PR. That is the root cause of
merging through red, and it is the thing that must be fixed before any review is removed.

## The invariant this program protects

> A merge is safe when a deterministic gate says so, and every red gate is worth stopping for.

Every tier below either strengthens the deterministic gate or restores trust in its signal.
Nothing here is about reviewing less for its own sake; reviewing less is the *consequence*
of the gate being worth trusting.

## Tier 0 — make the signal true

Blocks everything else. Nothing below is worth doing while red is ambiguous.

| # | Work | Done when |
|---|---|---|
| 0.1 | Retire `mailbox/sqlite/connection.ts` from `UPSTREAM_FILES` into `FORK_DIVERGED_UPSTREAM_FILES`; regenerate `UPSTREAM-MANIFEST.json` at the same pinned sha (no re-pin) | drift lane green; manifest still `"upstream": "5c3082a1"`, 29 files |
| 0.2 | `ratchet:report --write --accept container/Dockerfile`, reason recorded in the PR body | plain report is Δ 0 |
| 0.3 | Split the vitest suite into a **correctness** lane and a **drift** lane via `VITEST_LANE`, one `DRIFT_TESTS` constant, `defaultExclude` preserved | lanes partition the suite exactly: union = full set, intersection = ∅ |
| 0.4 | Split `.github/workflows/ci.yml` into parallel `correctness` and `bookkeeping` jobs, both blocking | a stale manifest reds `bookkeeping` only |
| 0.5 | Re-scope the 09-09 alert silencing (below) and wire `OnFailure` on the spawn-gate sentinel | a simulated unit failure reaches the operator |

Drift lane membership rule: **a test belongs in the drift lane iff its failure is fixed by
regenerating a committed manifest, not by changing behavior.** By that rule
`src/mailbox-seam-ratchet.test.ts` stays in correctness — its failure means someone added
raw session-DB access, which is an architectural violation, not stale bookkeeping.

### 0.5 detail — the alerting gaps

`/etc/systemd/system/nanoclaw-unit-alert@.service.d/zz-no-dispatch.conf` (2026-09-09)
blanks the template's `ExecStart`. Because it is a drop-in on the **template**, it silences
all eight units that declare `OnFailure=nanoclaw-unit-alert@%n`: `nanoclaw-v2`,
`nanoclaw-health-sentinel`, `nanoclaw-fleet-drift`, `nanoclaw-codex-sync`,
`nanoclaw-workgroups-drive`, `onecli-drift-check`, `upstream-dryrun-report`, `worktree-audit`.
The stated rationale (health-sentinel already DMs the operator) covers two of the eight.
Fix: move the override to a per-instance drop-in for the units health-sentinel actually
watches, leaving the rest escalating.

`groups/_ops/systemd/spawn-gate-check.sh` asserts in its own header that its unit carries
`OnFailure=nanoclaw-unit-alert@%n.service`. The live unit does not, and its `.service.d/`
is empty. So the detector built after the 2026-09-02 Node 22 / OneCLI-proxy incident —
the one that catches "service healthy, every spawn silently refused" — computes a breach
every 5 minutes and tells nobody. **Highest-severity item in this plan and unrelated to
code review.**

## Tier 1 — risk-based review scope

Duckbill's actual mechanism, adapted: a deterministic script labels a PR by changed path,
and Codex review runs only on labeled PRs. No LLM in the selection step.

The risk register already exists — it is the "easy to get wrong" list in `CLAUDE.md` plus
the privileged seams:

| Path | Why it is high-risk |
|---|---|
| `src/guard/` | the privileged-action decision seam |
| `src/router.ts`, `src/delivery.ts` | the two ends of the message path |
| `src/host-sweep.ts` | everything on a timer, incl. ceiling-kill accountability |
| `src/modules/self-mod/` | agents editing their own container config |
| `src/onecli-secrets.ts`, `container.json` secret scoping | fail-closed credential scoping |
| `cli_scope` handling | the in-container privilege boundary |
| `src/db/migrations/` (non-additive only) | irreversible against a live DB |
| `container/agent-runner/src/mailbox/sqlite/` | `journal_mode=DELETE` cross-mount visibility |
| upstream-owned files / `src/upstream-ratchet.json` | fork divergence budget |
| `scripts/deploy.sh`, `src/deploy-crash-guard.ts` | the rollback path itself |

Everything else merges on green. On the recent sample this exempts most PRs — #566, a
docs-only change that consumed 12 rounds and 15 commits, would never have been reviewed.

Also in Tier 1: diagnose why the existing `codex-review.sh gate` breaker did not stop #566.

## Tier 2 — raise the floor where it is genuinely thin

Ranked by risk, not by checklist completeness. Audited state as of 2026-09-10:

- **`container/` has no ESLint at all.** No config file anywhere in that tree; `eslint.config.js:7`
  ignores `container/`, and `package.json:28` only lints `src/ scripts/ setup/`. The 11
  `eslint-disable` comments inside `container/` are inert. Add a container ESLint config.
- **Container tests are never typechecked** — `container/agent-runner/tsconfig.json` excludes
  `src/**/*.test.ts`, so CI's container `tsc` step skips them.
- **No coverage measurement exists.** Not a low floor — no `coverage` key in `vitest.config.ts`,
  no `@vitest/coverage-*` dependency, CI never passes `--coverage`. Install measurement first;
  then ratchet (coverage may not fall) **scoped to the Tier 1 paths**, not globally.
- **Prettier covers only `src/**/*.ts`** — `scripts/`, `setup/` and `container/` are unenforced.
- `tsconfig.scripts.json` hard-excludes three files as pre-v2 drift under #335, still unresolved.

Host TypeScript is `strict: true` but without `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes` or `noImplicitOverride`. Those are a later, separate decision —
each is a large mechanical migration and none of them is implicated in any defect above.

## Tier 3 — point the smoke harness at ourselves

`container/skills/smoke-test/` is a mature agentic QA system: 150+ campaigns since August,
real browser plus backend assertions, seat rotation for permission crossings, deterministic
bash scheduling gates. It runs **against exactly one client workgroup**. No equivalent QA state
exists under any other workgroup, and nothing points it at this repo.

So for NanoClaw itself, Codex review is the last line with no net beneath it. A NanoClaw-self
campaign, post-deploy, asserting the paths a unit test cannot reach:

- spawn a real container and confirm it reaches first poll
- send a real message through a real channel adapter and assert the reply lands
- assert delivery through `outbound.db` → adapter
- assert `on_wake` restart semantics and the ceiling-respawn follow-up contract

**This is what actually replaces review.** Tier 0 stops the bleeding; this is the
replacement organ.

## Tier 4 — evals for skills

Both source threads name skill evals as load-bearing and neither says what one is. For a
fleet where agents are the workforce, a bad skill is not a bug — it is a defect factory.

Working definition for this repo: **an eval is a fixed input scenario plus a deterministic
assertion about the agent's action trace** — which tool it called, whether it stopped,
whether it refused. Not a judgment about prose quality.

Two adjacent findings from the Duckbill thread that apply directly here:
- They deleted a large number of skills that current models already knew, and improved what
  remained. This repo has a large skill surface across `.claude/skills/` and `container/skills/`.
- Doc-happy agents had accumulated markdown that poisoned context; they centralized docs and
  required human authorship. This repo has a deep `docs/` tree and 295 memory files.

Both deserve an audit; neither blocks Tiers 0–3.

## Measurement — the part Duckbill skipped

Mike Julian states plainly that Duckbill does not track defect escape rate: "bugs are rarely
filed — they're just fixed." So the thread's +94% proves throughput, not that quality held.
This install serves production workgroups daily; that blind spot is not affordable here.

Record, per merged PR, whether it was review-labeled and whether a later fix touched the same
files within 14 days. A follow-up links itself: every `fix` PR carries `Fixes-PR: #<n>` or
`Fixes-PR: none` in its body, which merge-check enforces once the gate-integrity change lands.
Where a link is missing, file overlap is the fallback.

**Compare like with like.** Reviewed and unreviewed PRs differ by path by design, and risky
paths draw more follow-up fixes whether or not they were reviewed. Comparing the two groups
would measure the paths, not the review. So the comparison runs within the low-risk class:
low-risk PRs merged before the switch, all of which were auto-reviewed, against low-risk PRs
merged after it, unreviewed. The same query reports the weekly revert rate.

**Size the expectation.** About 30 low-risk nanoclaw PRs merge in 30 days, so only a large
difference will show; the 30-day read is a first look, not a verdict. XZO's volume, 393 PRs
in the 30 days before its switch, supports a firmer read. A post-merge advisory review of
skipped PRs measures misses directly instead of waiting for production to surface them. It
files what it finds and never blocks — shipped 2026-09-11 as
`.github/workflows/shadow-review.yml`: on every PR merged into `main` that carried neither
`risk:high` nor `review:requested` at merge time, an Opus-tier Claude reviews the merge
commit's diff against `docs/review-policy.md`'s severity bar and either opens one
`shadow-review`-labeled issue (`shadow review: #<n> <title>`, findings marked **P1**/**P2**
inline) or, on no findings, leaves a one-line PR comment. `scripts/review-outcomes.ts`
reads those issues back (`buildShadowReviewIndex`) to count, per bucket, how many skipped
PRs were shadow-reviewed and how many drew a P1.

**Rollback condition, agreed in advance** (corrected 2026-09-11 for the confounded-groups
bug; superseded 2026-09-11 by the direct signal below, once shadow review shipped). The
**primary signal is shadow-review findings on skipped PRs**, not file overlap: a P1 finding
on a skipped PR is direct evidence that PR's *paths*, not just that PR's diff, were
under-covered by the risk list. It moves those paths onto `risk:high` in
`.github/labeler.yml` — a path-level ratchet the labeler list learns from — recorded as one
line in `docs/review-notes.md` describing the rule (see that file). **Secondary signal:**
reverts, before vs. after the switch (the weekly rate above already tracks this). **File
overlap is reported only as an upper bound**, cited but never acted on alone: replayed
against `davekim917/nanoclaw` on 2026-09-11 (`pnpm exec tsx scripts/review-outcomes.ts`),
69.7% (85/122) of low-risk PRs merged in the 30 days *before* the switch — every one of them
reviewed — still show a same-file follow-up within 14 days. A metric that flags most PRs
regardless of whether they were reviewed cannot tell a miss from noise, which is exactly why
shadow review, not file overlap, is the signal this rollback condition acts on.

## Non-goals

- **Copying the 85% coverage floor.** That is a number from someone else's codebase. A
  ratchet scoped to Tier 1 paths gets the protection without the migration.
- **Removing review before Tier 0 lands.** That ships more bugs faster.
- **Building a metrics dashboard.** `dashboard/` is a decision queue by design
  (`dashboard/PRODUCT.md`), and `add-clidash` is available but uninstalled. The gap is not
  missing dashboards — it is two alerts that already compute the right answer and reach nobody.
- **Claiming Duckbill's headline.** This install never had human code review. The true
  statement at the end of this program is narrower and more defensible: *review runs on the
  paths that can hurt us, chosen by a shell script.*

## Status

- [x] Audit: CI gates, review churn, observability (2026-09-10)
- [x] Tier 0.1–0.4 — done 2026-09-10 in #598:
      `mailbox/sqlite/connection.ts` is fork-diverged, and the manifest is still pinned at
      `5c3082a1` with 29 files. The `container/Dockerfile` growth is accepted. `VITEST_LANE`
      splits the suite into correctness and drift lanes, and `ci.yml` runs them as parallel
      `correctness` and `bookkeeping` jobs. Both are blocking.
- [x] Tier 0.5 — done 2026-09-10. The 09-09 `zz-no-dispatch.conf` moved off the alert
      *template* onto the three instances health-sentinel already covers
      (`nanoclaw-v2`, `nanoclaw-workgroups-drive`, `onecli-drift-check`), so the other
      five escalate again; `nanoclaw-spawn-gate-sentinel.service` gained the `OnFailure`
      drop-in its own script had always claimed it carried. Verified per instance via
      `systemctl show … -p ExecStart`, and the alert script live-fired into a scratch
      outbox.
- [x] Tier 1 — live 2026-09-10.
      - **Risk list.** The path list lives in `.github/labeler.yml`, the single source of
        truth that supersedes the table above, and `risk-label.yml` applies `risk:high`
        (#609). The git hooks, the boundary checkers and the allowlist joined in #611.
      - **Review.** It is requested only for `risk:high` or `review:requested` PRs, with a
        round cap of 3. `codex-review.sh merge-check` allows a merge only at the exact head
        with CI green and a matching review (#605). Codex auto-review is off for this
        repository. Merge authority is a standing operator instruction held outside the
        repository (pr-review-loop Step 6).
      - **Direct pushes.** The pre-push hook refuses direct pushes to `main` (#615).
      - **#566.** The breaker is diagnosed. `codex-review.sh gate` derives seams from
        imports, so a finding class whose sites are Markdown or YAML is never gated. Tier 1
        routes around it, because docs-only PRs are not reviewed at all.
- [ ] Measurement — corrected 2026-09-11, then shadow review shipped 2026-09-11. The
      earlier method compared reviewed with unreviewed PRs and assumed its bias fell
      equally on both. It doesn't, because the groups differ by path. The comparison is
      now before-and-after within the low-risk class. Links come from a required
      `Fixes-PR:` line, and revert rate is tracked alongside. First read around
      2026-10-10.
      The query shipped 2026-09-11: `pnpm exec tsx scripts/review-outcomes.ts`
      (`--repo`, `--switch`, `--days`, `--followup-days`, `--json`). It replays
      `.github/labeler.yml`'s `risk:high` globs against every merged PR's own file list
      rather than trusting the stored label, so PRs merged before the labeler existed
      classify too; follow-up counts `Fixes-PR:` links and the fix-title/file-overlap
      fallback separately, and reverts are unbounded in time. A same-day smoke run
      (30/30 days around the switch) found zero `Fixes-PR:`-linked follow-ups on
      low-risk PRs on either side — the trailer isn't used on low-risk PRs in
      practice — so the fallback overlap rate was carrying the signal at first: 75.6%
      before vs. 40.0% after, with only 10 low-risk PRs merged after the switch as of
      that run, under the 30-PR floor this plan sets for a readable difference. Rerun
      2026-09-11 (122 low-risk PRs before, 12 after): 69.7% before vs. 33.3% after —
      still both high and both under the after-switch sample floor, confirming file
      overlap alone can't discriminate a miss from a busy file. That is why shadow
      review (below) is now the primary signal and file overlap is reported only as an
      upper bound, per the corrected rollback condition above.
      `.github/workflows/shadow-review.yml` ships the direct signal:
      post-merge advisory Opus review of every skipped PR, one `shadow-review`-labeled
      issue per PR with findings (or a PR comment on none), never blocking. Selection is
      by the PR's labels *at the `closed` event* (`risk:high` / `review:requested`), not
      a label re-check, so a wrongly-removed label only means more review, never a risky
      PR going unwatched — see the workflow's header comment. `review-outcomes.ts` now
      also reports, per bucket, how many skipped PRs a shadow-review issue exists for and
      how many of those carried a P1 (`buildShadowReviewIndex`, `fetchShadowReviewIssues`).
      A P1 on a skipped PR moves that PR's paths onto `risk:high`
      (`.github/labeler.yml`) by hand — the path-level ratchet the rollback condition
      names — recorded as one line in `docs/review-notes.md`.
- [ ] Revised plan, 2026-09-11, after an independent second opinion and a comparison with
      Augment's Cosmos:
      - **Gate integrity:** merge-check fails closed when `risk:high` was removed by anyone
        but the labeler, and requires `Fixes-PR:` on fix PRs. Substitute reviews of risky
        PRs must come from an Opus- or Fable-tier model, or from another model family.
      - **Reviewer identity:** every gate runs under one GitHub identity, so a self-approval
        can't be told apart from a review. This is an operator decision: a second identity for
        receipts, or a public repo so branch protection applies. A history scan for public
        readiness is under way.
      - **Measurement:** the correction above.
      - **Tests on risky paths:** no coverage tooling is installed yet. Unit tests for the #608
        failure exist (`container/agent-runner/src/poll-loop.test.ts:390` onward). The missing
        piece is a check that runs the real CLI and confirms the hooks still fire.
      - **Memory and decisions:**
        - review-dimension labels such as `risk:guard` and `risk:migration`;
        - a `docs/review-notes.md` that gets a line whenever a finding is deferred or a PR is
          reverted;
        - on XZO, a `Decision:` line plus the existing `needs-product-decision` label.
- [ ] Tier 2 · Tier 3 · Tier 4 — not started
