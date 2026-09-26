# Plan: Verified Delivery

> Started 2026-09-26. Status: PROPOSED — awaiting operator approval; build may not start.
> Prompted by Lauren Tan's talk on shipping ~2,500 agent-authored PRs a month to production
> with agents merging their own work, and by her MIT-licensed `pstack` plugin
> (`cursor/plugins`, notably `create-verification-skill`, `maintain-verification-skill`
> and the Benny issue-triage/reproduce automation). Deliberately not a copy of either;
> see [Non-goals](#non-goals).

## The problem, stated precisely

Agent throughput is not the constraint. Agents already author, review and merge their own
PRs here behind risk-tiered gates. What the gates cannot tell us is whether a merged change
actually behaves correctly in the running system. Today that question is answered after the
fact: by fix-forward PRs, by a QA role that exercises builds long after the author has moved
on, or by the operator noticing.

The talk's thesis, which this plan adopts: **trust is what limits autonomous delivery, and
trust comes from three things.**

1. **Agents prove behavior against a running system.** A reproducible run tool that lives
   with the code, plus a map of what the product does and how a user reaches it, so the
   author (not a later reviewer) can show the change works.
2. **Structure makes bad patterns impossible.** The codebase is the agents' memory: they
   extend whatever pattern they find, so one workaround spreads. Prefer designs where the
   mistake cannot be written, then lint or CI, and only then instructions.
3. **Every correction is routed to the strongest level that works**, in this order:
   code/structure → static analysis (lint, compiler, CI) → rules and skills → style guide.
   An instruction is the weakest form; a correction that stays prose will be repeated.

## Two layers

- **The harness's own development.** NanoClaw and the bootstrap plugins dogfood this first.
  NanoClaw is instance #1: we control it end to end, and building it first keeps the shared
  format from bending toward any one product.
- **A capability the harness gives every project it builds.** Each project repo a workgroup
  works on gets its own instance of the same format, installed by the same generator and
  checked by the same gates.

## The invariant this program protects

> A change is merged only with evidence, produced on the exact head being merged, that the
> behavior it claims works in a running copy of the system — and that evidence never doubles
> as the independent check.

## The shared per-repo format

Every repo answers the same four questions, in the same places:

| Question | Artifact |
|---|---|
| How does an agent run it safely, away from production? | A run tool committed in the repo with fixed verbs: `launch`, `doctor`, `drive`, `prove`, `cleanup` |
| What does correct look like? | A behavior map: one file per feature (what exists, how a user reaches it, how to drive it, gotchas) **plus its consumers** — the endpoints, tables, migrations or models that feed it |
| What proves a change? | A receipt produced by the run tool and bound to the head SHA: scenarios run, results, where the evidence lives |
| Where do failures come in? | The repo's signal sources: CI red, error tracking, data-test failures, user bug reports |

Rules for the run tool, carried over from `pstack`'s `create-verification-skill`:

- The tool is invoked, never rewritten per session. Agents stop improvising throwaway scripts.
- `doctor` answers "is this instance worth driving?" and runs first whenever anything looks off.
- Proof exercises the real user path and records the trigger, the stable end state and side
  effects (rows written, messages sent, files changed), not just a final screenshot.
- `cleanup` removes what the run started and never deletes the evidence.
- A generated run tool that has never been executed end to end is a draft, not a deliverable.

**The verifier must test itself.** Before any receipt counts, the run tool must demonstrably:
refuse a wrong or production instance, detect a stale build, fail on a deliberately injected
bug, and keep its evidence after cleanup. Otherwise we automate convincing false passes.

## Adapters by repo type

The format is fixed; how each question is answered depends on what the repo is.

| Repo type | Run it | Map | Make bad patterns impossible | Failures come in from |
|---|---|---|---|---|
| Web app + API | Drive the PR preview in a browser, call its API | Feature files + consumers (endpoints, tables, migrations) | App lint rules, import boundaries | User bug reports, error tracking |
| Native mobile | Manual test packet tied to the exact app artifact, when no device automation is approved | Same feature files | Same | Same |
| dbt / analytics | Slim build of changed models into a per-PR schema, **plus a comparison against production** for changed models | dbt lineage is the generated map; exposures add the downstream consumers | Model contracts, enforced tests, project rules | Production test and freshness failures |
| Data pipeline | Run against a dev target; assert row counts, schema, grain | Source and pipeline inventory | Schema checks, tests | Failed runs, alerts |
| Static site / wiki | Build, link check, rendered screenshot | Page inventory | Build and link checks | Build failures |
| The harness itself | Shadow host from a separate checkout, CLI channel only | Feature files (routing, scheduled tasks, restarts, approvals, delivery) | Lint, ratchets, branded types | Nightly-red CI, drift issues |

The harness adapter rests on isolation premises that look right in source but are unproven:
`DATA_DIR` resolves under the working directory and the CLI sockets live beneath it
(`src/config.ts`, `src/cli/socket-client.ts`), and container adoption filters on an install
label derived from the checkout path (`INSTALL_SLUG`, `CONTAINER_INSTALL_LABEL` in
`src/config.ts`). A spike must confirm fixed ports, OneCLI agent identity, running with no
chat-platform tokens, and the memory budget on a shared production host before anything is
built on them.

## Cross-repo consumer map

The costliest miss is a change with no visible diff where the user sees it: a backend
migration or an analytics model that changes what a screen shows while no frontend file
moves. A per-repo map cannot catch that. Joining the maps can:

    analytics model  →  backend endpoint  →  screen

When dbt exposures name the endpoints that read each model, and the app's feature files name
the endpoints each screen calls, any change to a model, migration or endpoint lists its
affected screens at intake, before testing is scoped. Scope follows consumers, not folders.

## Who verifies what

- **The builder proves before the PR.** The author runs the relevant scenarios with the run
  tool and the receipt goes on the PR head.
- **The builder's proof never counts as the independent verification.** Any existing QA or
  challenger role keeps its independence, but consumes the same run tool and map instead of
  re-deriving how to reach each feature per run.
- **The merge gate checks the receipt**, reusing the existing exact-head receipt pattern
  (`CI (host)` in `codex-review.sh merge-check`). Free-text "tested it" lines never count:
  an agent can write one without running anything.

## Distribution

How a workgroup, current or future, gets this:

1. **Fleet-wide plugin.** A bootstrap plugin enabled on every group via `enable-agent-plugins`,
   with Claude / Codex / OpenCode parity. It carries the generator (interviews a repo, picks
   the adapter, scaffolds run tool + map + receipt), the maintenance skill, the receipt tool,
   and the same-mistake-twice check.
2. **Per-repo instance, committed in the project repo.** The run tool and map live with the
   code so they are maintained in the same PR as the behavior they describe, and any agent,
   on any runtime, finds them. Where a repo has other owners and the instance cannot be
   committed there, the fallback is the workgroup's private data pool. That fallback rots
   faster and should be the exception.
3. **A `verified-delivery` template** in the plugin format of [docs/templates.md](../../templates.md)
   that stamps standing instructions and recurring tasks into a group: map maintenance per
   repo (drift fixes the map; broken behavior files an issue, never a doc edit), bug triage →
   reproduce, and a weekly trust-metric report. New workgroups get it at creation.

## Correction routing, harness layer

Runs throughout, not as a phase. Each item is a correction being moved up the ladder.

| Work | Done when |
|---|---|
| Require a `Fixes-PR:` line on every PR (`none` allowed) so the fix-forward share is measured over all PRs, not a self-selected subset | `merge-check` refuses a PR without the line |
| Pin `eslint-disable` directives by file, the way `src/db/raw-db-ratchet.test.ts` pins raw-DB paths — not by total count, which lets a risky new exemption hide behind a removal | a new suppression in an unlisted file fails the per-PR lane |
| Turn the mechanizable CLAUDE.md bans into lint rules. `no-require-imports` is already on via typescript-eslint recommended; `datetime('now')` in SQL strings is not | each converted ban fails lint on a fixture, and its prose is deleted |
| Lint changed files in the pre-push hook and host-CI (no Actions minutes) | a lint error blocks the push |
| Band-aid comments (workaround, temporary, TODO) must carry an owner and a removal condition; do not ban the vocabulary, which only teaches agents to hide constraints | the hygiene comment check fails a bare workaround comment |
| Extend "the same mistake twice becomes a check" (`scripts/review-notes.test.ts`) beyond PR review findings to operator corrections, and to each project repo | a second occurrence of a recorded class without a structural fix fails that repo's CI |

Already in place, not work: the hygiene checks block in PR CI, and Codex sessions carry the
destructive-command, file-protection and email guards through `bootstrap-workflow-agents`.

## Sequence

| # | Work | Done when |
|---|---|---|
| 0 | Baseline the trust metric per repo: tagged fix-forward share, suppression growth, escaped defects (issues opened by people after merge) | the weekly report prints for the harness and one product repo |
| 1 | Define the shared format (run-tool verbs, map schema, receipt, gate hook) and prove it on NanoClaw, starting with the isolation spike | the harness run tool refuses a production target and a stale build, an injected bug fails, and an agent reproduces a real recent bug from its issue text alone |
| 2 | First product instance: a web app with PR previews | one real changed feature goes builder proof → independent challenge → merge on the same run tool |
| 3 | Cross-repo consumer map | a backend-only or model-only change lists its affected screens at intake |
| 4 | Analytics instance: add a production-vs-PR comparison to the existing slim build | the PR shows which numbers changed and whether that was intended |
| 5 | Roll out by repo type through the generator and template | each new instance proves one mapped feature end to end before it counts |
| 6 | Outer loop per project: signal → triage → reproduce twice with the run tool → fix PR → independent re-verification. Never deploys; existing restart and deploy approvals are unchanged | a real reported defect reaches a merged, independently re-verified fix with no operator prompt |

The outer loop is last on purpose: without a run tool and map, automated triage produces
confident, unverifiable PRs.

## Non-goals

- **Formal methods.** Out of reach and not the bottleneck.
- **A framework rewrite.** The talk's locked-down framework was a greenfield choice. Here the
  same effect comes incrementally: boundaries and lint rules added where a pattern has
  actually bitten.
- **Wholesale `pstack` adoption.** It overlaps the bootstrap workflow and orchestrate skills.
  Borrow the verification generator, its maintenance loop and the triage/reproduce shape;
  leave the rest.
- **Dropping risk tiers.** The talk's agents merge with no review. Our blast radius (a
  long-running host holding secrets, the guard and message delivery) justifies keeping
  risk-tiered review; the goal is to shrink what counts as high-risk as verification earns
  trust, not to remove the tier.
- **Banning comments outright.** Hazard comments that stop an agent breaking an invariant are
  load-bearing. Target band-aid comments specifically (above).

## Open questions for the operator

1. Where a project repo has other owners, may the run tool and map be committed there, or
   does that project use the private-data-pool fallback?
2. Which product repo is instance #2? The criterion proposed: agent PR volume × cost of an
   escaped defect.
3. Should the receipt gate apply to all PRs in a repo from day one, or only to PRs touching
   mapped features until coverage grows?
4. For repos whose native app has no approved device automation, is a recorded manual test
   packet acceptable as the receipt for native-only changes?

## Status

- 2026-09-26: plan proposed. Not approved; no build started.
