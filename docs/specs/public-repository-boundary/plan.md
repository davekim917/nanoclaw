# Public repository boundary

Status: approved
Approval: approved by operator for current-tree cleanup and prevention; published history excluded
Owner: operator
Implementation workflow: `/team-build` after explicit approval

## Outcome

The public NanoClaw repository contains product behavior, generic extension
points, synthetic fixtures, and public project metadata only. Private
workgroup configuration and operator workflows remain fully functional but
live in private per-install state or the existing private groups repository.

This has two inseparable deliverables:

1. Clean the current tracked tree across every private workgroup, not only the
   workgroups that first exposed the problem.
2. Add a deterministic prevention gate that blocks the same classes of
   installation-specific material from being committed again.

## Scope

### In scope

- Every text file tracked by the public NanoClaw repository.
- Every active workgroup, agent group, messaging group, and stale platform
  registration discoverable from the local central database.
- Private names, emails, tenant URLs, account labels, platform identifiers,
  generated database identifiers, customer references, bot names, channel
  names, and one-off operational behavior.
- The operator's personal name when it appears in runtime prompts, behavior,
  examples, comments, or workflow instructions. This is distinct from public
  author metadata in licenses, package metadata, repository coordinates, and
  commit attribution.
- Active customizations that currently depend on private values embedded in
  public source.
- Historical planning and QA artifacts tracked in the current tree.
- A portable CI check and a stronger local check derived from the live
  install registry.
- Migration of still-useful operator-only assets to the existing private
  groups repository.

### Out of scope

- Runtime data under `data/`, live workgroup files under `groups/`, secrets,
  and OneCLI vault contents. They are inputs to the audit, not cleanup
  targets.
- Removing public author identity, public repository coordinates, licenses,
  or intentionally public project contact information.
- Changing product behavior unrelated to removing installation-specific
  assumptions.
- Rewriting published Git history unless the operator separately approves
  that destructive operation.

## Requirements

### R1: Complete current-tree cleanup

The final tracked tree must contain no exact value from the live private
registry unless it is separately proven to be intentionally public metadata.
There is no allowlist for a value merely because a test, comment, plan, or
captured transcript currently uses it.

### R2: Preserve active customizations

Cleanup must not remove a capability, credential route, support workflow,
dashboard link, scheduled operation, or sibling-agent behavior that an active
workgroup depends on. Before a private literal is removed from an active code
path, the equivalent value must exist in private configuration and the
generic public path must read it from there.

### R3: Delete one-off mechanisms

Completed migration, repair, live-probe, and scheduling scripts that encode
one install are deleted from the public tree. They are not generalized unless
there is a current repeatable product use case. Still-useful operator
automation moves to the private groups repository.

### R4: Generic public examples

Tests, docs, comments, skills, templates, and fixtures use synthetic,
obviously non-live values. Examples use reserved domains and unmistakable
placeholder identifiers rather than copied production values.

### R5: Two-layer prevention

The prevention gate has two modes:

- Portable mode runs in CI without local runtime data. It rejects realistic
  personal email addresses, platform identifiers, generated install
  identifiers, forbidden tracked paths, and known unsafe artifact classes.
- Install-aware mode runs locally and additionally derives exact private
  identifiers from the live central database and a required ignored local
  tenant-identifier file. It scans the Git index so a clean working-tree copy
  cannot hide a staged private value.

The gate reports file, line, and finding category without printing the
private literal itself.

### R6: Small explicit allowlist

A checked-in allowlist may contain only reviewed public project metadata.
Allowlist entries must be exact, documented, and covered by tests. It cannot
contain workgroup, customer, tenant, channel, bot, account, or personal
workflow identifiers.

### R7: No private inventory artifact

The exact audit inventory is generated under an ignored scratch path and is
never committed. Public plan, run, CI, and test output contain categories and
counts, not the private identifier set.

### R8: Direct-publish coverage

The repository's normal direct-to-main publish path must run the
install-aware gate before network publication. Pull-request CI also runs the
portable mode, and push CI provides a post-publish alarm, but neither is a
substitute for the local pre-push boundary.

## Current architecture and evidence

- The NanoClaw origin is a public GitHub repository. The sibling groups
  origin is private and already uses an allowlist-style `.gitignore`.
- `groups/*` and runtime `data/*` are excluded from the public repository.
- Per-group `container.json`, per-group standing instructions, the ignored
  install `.env`, and the workgroup database already provide private
  configuration surfaces.
- Active public code still contains installation-specific assumptions:
  - `src/capabilities.ts` includes tenant-specific capability descriptions,
    scope labels, and an organization identifier.
  - `src/container-runner.ts` includes a tenant-specific service URL.
  - `src/modules/support-threads/dispatch.ts` includes a private inbox and
    private ticket-routing policy.
  - `dashboard/src/views/TaskDetail.tsx` includes a private issue-workspace
    URL.
  - `container/spawn-template.md` includes a private organization workflow
    even though private per-group templates already exist.
- Tracked operator scripts include completed one-install migrations, repairs,
  probes, account maps, and scheduled-task definitions.
- Exact-registry audit results and commands are recorded in `run.md` without
  reproducing the literals.

## Design

### 1. Generate the private inventory

A repository checker builds an in-memory identifier set from:

- `workgroups.id` and display names;
- agent-group IDs, names, folders, and workgroup IDs;
- messaging-group IDs, instances, names, platform IDs, and their concrete
  Slack or Discord identifiers;
- a required ignored local identifier file for private values not present in
  the database, such as customer domains, tenant URLs, support inboxes,
  vendor organization IDs, and ticket-team labels.

Generic words are excluded from private-name matching, but their concrete
database and platform identifiers remain covered. Matching is not raw
case-sensitive substring comparison: both source and private identifiers are
case-folded and normalized by removing separators, whitespace, and regex
punctuation. A private `foo-bar` therefore also detects `FooBar`, `foo_bar`,
and a source regex such as `/foo.?bar/i`. The checker never emits a matched
literal.

In an operator install, both the database and ignored tenant-identifier file
are mandatory. Their absence or unreadability is a hard failure, not a
portable-mode downgrade. Only a source clone with no install markers may run
portable-only from a hook.

Portable mode also detects installation-specific shapes without knowing any
private literal, including:

- tenant-qualified Atlassian hosts;
- workspace-qualified Linear issue URLs;
- vendor organization IDs;
- non-reserved email addresses;
- realistic Slack, Discord, and generated install identifiers.

Reserved example domains and unmistakably synthetic identifier conventions
remain permitted.

### 2. Classify each tracked match

Every match receives one of four actions:

| Class | Action |
|---|---|
| Completed one-install repair, migration, probe, or task installer | Delete from public tree |
| Still-useful operator automation | Move to `ops/nanoclaw/` in the private groups repository |
| Reusable product behavior with a private default | Replace the default with generic config and seed the existing private value outside the public repository |
| Test, comment, fixture, skill example, plan, or QA capture | Replace with synthetic content or delete the obsolete artifact |

Public project metadata is retained only after an explicit source-level
review.

### 3. Preserve active behavior through existing private surfaces

Use the smallest existing surface that fits each value:

- Per-group service and capability guidance belongs in private
  `container.json` or standing instructions.
- Tenant endpoints and non-secret organization identifiers use scoped,
  ignored install configuration rather than source literals.
- Workgroup-specific templates remain in the private groups repository; the
  public container template becomes generic.
- Workgroup-specific task definitions and repair tools remain in the private
  groups repository or the central task database.

Where the current public code lacks a generic read seam, add only the narrow
configuration field required by the active behavior. Do not introduce a
general plugin framework for this cleanup.

The migration order is private value first, public literal second. Missing
required configuration fails closed with a targeted warning or omission; it
never silently falls back to the removed private value.

### 4. Clean public artifacts

- Delete completed operator-only scripts and obsolete captured evidence.
- Parameterize genuinely reusable operator CLIs.
- Replace live names and IDs in tests with synthetic fixtures while
  preserving the tested invariant.
- Replace private examples in skills, comments, and docs with neutral
  examples.
- Remove obsolete multi-artifact workflow debris when its durable product
  intent is already documented elsewhere.
- Keep public author, repository, license, and product coordinates.

### 5. Add the prevention gate

Add one TypeScript checker with:

- tracked-tree and staged-index modes;
- optional `--db <path>` install-aware enrichment;
- required ignored local identifier input in install-aware mode;
- binary-file exclusion;
- exact public allowlist handling;
- redacted `file:line category` findings;
- nonzero exit on findings or on a missing explicitly requested database.

Wire the same implementation into:

- a package script for manual and release checks;
- the existing Husky pre-commit hook;
- a Husky pre-push hook that requires install-aware mode for an install;
- pull-request CI in portable mode;
- main-branch push CI in portable mode as a post-publish alarm.

Do not create separate scanners for CI, hooks, and release verification.

## Invariants

- No private literal is copied into a checked-in denylist, fixture, snapshot,
  plan, run log, or test expectation.
- The public checker cannot disclose a matched private literal in normal or
  error output.
- A source-only clone without install markers receives portable protection;
  an install never silently degrades to portable mode.
- An explicitly requested install-aware scan fails if its database is absent
  or unreadable, or if its ignored tenant-identifier file is absent, empty, or
  unreadable.
- Existing private configuration is written and verified before the public
  fallback is removed.
- The cleanup does not modify live database rows, workgroup memory, channel
  wiring, or unrelated dirty state in the private groups working tree.
- Private-repository changes use an isolated worktree based on its remote
  default branch.
- Every moved private asset is proven tracked in the private commit before its
  public copy is deleted. The private repository's fail-safe allowlist is
  widened only for exact required file types or paths, never with a blanket
  `ops/**` inclusion.

## Implementation path

1. Freeze a redacted baseline:
   - verify public/private repository visibility;
   - generate the ignored exact inventory;
   - record counts by artifact class.
2. In an isolated worktree of the private groups repository:
   - add an `ops/nanoclaw/` home for still-useful operator assets;
   - add private config/instructions required to preserve active behavior;
   - extend the private allowlist only for exact moved asset types that are
     not already tracked;
   - verify every moved asset with `git ls-files` and `git check-ignore`;
   - verify the destination remote remains private.
3. Add the generic public configuration reads needed by active paths and
   tests for configured, missing, and cross-workgroup cases.
4. Remove public one-install scripts and captured evidence; genericize the
   retained source, docs, skills, templates, comments, and fixtures.
5. Add the single repository-boundary checker, redaction tests, package
   script, pre-commit and pre-push invocations, pull-request CI step, and
   main-push CI alarm.
6. Run the full install-aware scan against the Git index. Resolve every
   finding; do not add private exceptions.
7. Verify behavior and regression coverage.
8. Run `/team-review --implementation` on this approved plan plus the raw
   diff.
9. Present the reviewed public and private commits for explicit ship
   approval. Activation remains a separate verified step.

## Verification

Required commands, adjusted only for the final script name:

```sh
pnpm run check:public-boundary
pnpm run check:public-boundary -- --db data/v2.db
pnpm exec vitest run
pnpm exec tsc --noEmit
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm run build
cd container/agent-runner && bun test
```

Additional checks:

- Scanner unit tests prove detection, synthetic-value acceptance, allowlist
  limits, staged-index behavior, missing-database failure, binary exclusion,
  normalized spelling variants, missing-local-inventory failure,
  install-marker fail-closed behavior, and output redaction.
- Focused tests cover every active path that changed from a private literal
  to configuration.
- For each affected active workgroup, render or call the session capability
  snapshot and verify the same service remains available without a public
  private literal.
- Verify the issue link, support routing, tenant MCP configuration, and
  private per-group templates from their configured paths.
- Verify `git ls-files groups` remains empty in the public repository.
- Verify every migrated operator asset appears in the private commit and none
  is ignored before deleting its public source.
- Verify the public origin commit and the private groups-origin commit
  independently; do not conflate publication with live service activation.

## Failure modes and rollback

| Failure | Prevention or rollback |
|---|---|
| Cleanup removes an active customization | Seed and verify private config before removal; revert the public commit while private assets remain intact |
| Scanner creates noisy false positives | Permit only synthetic conventions or reviewed public metadata; never allowlist a private live value |
| Scanner misses a private business name | Install-aware DB scan plus ignored local identifier input; add the category locally without committing the literal |
| Private spelling uses different separators or regex syntax | Compare normalized case-folded alphanumeric forms and test separator-free and regex-literal variants |
| Pre-commit inspects the wrong content | Read staged Git blobs in hook mode; test staged/worktree divergence |
| CI lacks local DB | Run portable mode in CI; install-aware mode is mandatory before local ship |
| Installed hook cannot read its DB or local tenant inventory | Fail the commit/push; never downgrade an install to portable-only |
| Private groups working tree has unrelated changes | Use an isolated worktree from the private remote; do not stage or modify the live dirty tree |
| Private destination ignores a moved asset | Verify the complete moved set with `git ls-files` and `git check-ignore` before public deletion |
| Config is absent after cleanup | Fail closed with a clear warning; restore the prior public commit or add the missing private config |

## Acceptance criteria

- Both cleanup and prevention ship together.
- Install-aware scan reports zero matches across all seven current
  workgroups, all current sibling agent groups, all current messaging groups,
  and stale private registrations.
- Portable scan reports zero non-allowlisted realistic private identifiers in
  the tracked tree.
- Every deleted active literal has a verified private replacement; agent
  capability awareness and affected workflows do not regress.
- One-off operator scripts and captured private evidence are absent from the
  public tracked tree.
- Retained tests use synthetic fixtures and preserve prior behavioral
  coverage.
- The same checker passes manually, from the pre-commit hook, and in CI.
- The install-aware checker passes from pre-push before direct publication;
  portable mode also runs for pull requests and main pushes.
- Full host and container verification passes.
- Public and private repository diffs are separately reviewed and published.
- Git history treatment is explicitly decided before final ship.

## Unresolved operator decision

The current default branch can be cleaned without rewriting history. The
already-published commits and other remote refs will still contain prior
versions. Purging those requires a separate destructive history rewrite that
changes commit hashes, invalidates existing branches/worktrees, and requires
force-pushing affected refs.

Before final ship, the operator must choose:

1. Clean the current tree and prevent recurrence, leaving historical commits
   intact; or
2. After current-tree cleanup is verified, run a separately reviewed history
   purge across the public remote.
