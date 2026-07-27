# Spawn worker template

Use this template for implementation work that should produce a branch and a
reviewable change. Per-install organization names, repository rules, ticket
teams, deployment environments, and reporting conventions belong in the
agent group's private `spawn-template.md`, which overrides this generic base.

Skip this workflow for read-only investigation or administrative work that
does not change a repository.

## Brief contract

The orchestrator supplies:

```md
## Goal
Resolve <ticket or objective> — <one-sentence outcome>.

## Inputs
- Repository: <repository>
- Scope: <files, directories, or objects allowed to change>
- Dependencies: <required prior work or "none">
- Non-goals: <explicit exclusions>

## Acceptance
- <verifiable outcome>
- <required tests or queries>
- <required review or publication state>
```

Pause before implementation when a missing field changes the contract.

## Worker process

### 1. Setup

1. Create or select the isolated worktree requested by the brief.
2. Verify the current branch matches that worktree and is not an unrelated
   feature branch.
3. Read every in-scope file and relevant repository instruction before
   editing.
4. Call `spawn_progress` with the worktree, branch, and files inspected.

### 2. Implement

1. Make the smallest change that satisfies the brief.
2. Preserve repository-local conventions and tenant boundaries.
3. Do not expand scope merely because adjacent work is visible.
4. Call `spawn_progress` with the files changed and the invariant each change
   satisfies.

### 3. Verify

1. Run the repository's canonical focused tests.
2. Run broader checks proportional to the affected surface.
3. Verify the acceptance assertions directly; do not infer them from a green
   build.
4. Call `spawn_progress` with exact commands and outcomes, including anything
   skipped.

### 4. Hand off

1. Review the complete diff for scope and regressions.
2. Commit, push, or open a pull request only when the brief authorizes that
   publication boundary.
3. When applicable, record the shipped change with `add_ship_log` and update
   the referenced backlog item using the available NanoClaw tools.
4. Call `spawn_complete` with the objective, changes, verification, publication
   state, and any remaining risk.

If a required architectural, schema, deployment, or output-contract decision
is unresolved, call `spawn_request_steer` and stop. A low-risk presentation or
naming preference may use `ask_question` while continuing with a reasonable
documented default.

If a phase cannot proceed because of a terminal blocker, call `spawn_failed`
with the phase, concrete evidence, and failure category, then stop.

## Non-negotiable boundaries

- Never fabricate test or query results.
- Never publish from an unrelated or contaminated branch.
- Never deploy to a production target unless the brief explicitly authorizes
  it.
- Never embed installation-specific organization, customer, tenant, channel,
  bot, account, or ticket-routing values in this public template.
