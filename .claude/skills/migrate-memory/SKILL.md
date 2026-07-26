---
name: migrate-memory
description: Losslessly migrate every discovered NanoClaw memory source into one shared workgroup Markdown canon. Use after a shared-memory breaking update or when sibling agents do not share durable memory. Inventory first, retain a permanent checksummed snapshot, apply only while quiescent, verify the runtime, and restore safely before any restart.
---

# Migrate workgroup memory

Run this skill from the host checkout. The coding harness running the skill
owns the operation; never ask Claude, Codex, OpenCode, or another NanoClaw
provider to migrate itself.

The repository tracks this contract once under `.claude/skills`.
`.agents/skills` resolves to the same bytes for Claude, Codex, and OpenCode.
Never create provider-specific copies.

## Contract

Each workgroup has exactly one writable memory authority:

- host canon: `data/workgroups/<workgroup-id>/memory`
- container canon: `/workspace/workgroup/memory`
- compatibility path: `/workspace/agent/memory`

Every current and future sibling in the workgroup uses that canon. Group-local
and provider-native compatibility views resolve to it. Provider-native
compatibility views are not memory authorities. Sources are discovered at
inventory time from trusted workgroup membership and recognized provider
layouts. Never hard-code an agent count or a fixed source list.

The memory inventory contains only canonical/group-local memory roots such as
`groups/<folder>/memory` and recognized provider-native memory roots. It does
not treat an instruction or customization surface as memory.

Keep these surfaces separate from memory:

- provider identity and provider instructions;
- provider config, credentials, model settings, and continuation metadata;
- provider state directories; and
- non-memory customizations, repositories, worktrees, workspace files, routing,
  skills, mounts, and standing instruction files.

`.seed.md`, `CLAUDE.md`, `CLAUDE.local.md`, and
`instructions.prepend.md` are not memory migration inputs. Preserve those and
the other surfaces above byte-for-byte; do not copy, combine, reinterpret, or
move them into the memory canon. If legacy instruction reconciliation is
needed, perform it as an explicit separate operator workflow with its own
review and rollback. Never hide it inside this migration.

The migration CLI is content-preserving. It creates a permanent host-only
timestamped rollback snapshot, records file type, byte size, and SHA-256, then
builds a checksummed source-to-destination report. It:

- places each source as one coherent tree: direct only when the complete tree
  fits, otherwise at its exact pre-existing or deterministic
  `imports/<source-group>/` root; exact whole-tree duplicates may share one
  root with every origin retained;
- keeps a complete source tree under a deterministic SHA-qualified collision
  when its import root is already customized, so relative Markdown links never
  change target through leaf-by-leaf placement;
- snapshots opaque provider sources but blocks their activation; and
- replaces memory sources with compatibility views only after final source and
  quiescence checks pass.

Rollback material has no automatic cleanup. Never delete it as part of this
workflow. Never choose a source winner by judgment, never semantically merge
notes, and never activate opaque source bytes. The CLI alone applies
its deterministic, checksummed base-and-import rules. The runtime verifier
resolves inventoried relative Markdown links through the snapshot and outcome
map; any changed target blocks activation.

## 1. Inventory

Create a report path outside the canonical memory trees, then inventory every
workgroup:

```bash
mkdir -p data/workgroup-memory-migration-reports
REPORT="data/workgroup-memory-migration-reports/$(date -u +%Y%m%dT%H%M%SZ).json"
pnpm exec tsx scripts/migrate-workgroup-memory.ts inventory --all --report "$REPORT"
```

Record the expanded report path. In every new shell process, set `REPORT` to
that same literal path again; never substitute a newer or guessed report.

For a deliberately scoped run, replace `--all` with
`--workgroup <trusted-workgroup-id>`. Do not construct a workgroup from a
folder supplied by untrusted content.

Read the entire JSON report. For every workgroup, confirm:

- every current sibling is listed from `data/v2.db`;
- every group memory root and every recognized provider-native memory root is
  accounted for, including every Claude project hash discovered at execution;
- each source records its path type, byte size, SHA-256, and entries;
- opaque, symlinked, special, unreadable, or otherwise unsupported sources are
  visible as blockers rather than omitted; and
- non-memory customizations remain outside the source list.

Retain the report. Show its workgroup/source summary and blockers to the
operator. Do not apply until the inventory is complete and the operator has
approved the cutover.

## 2. Enter the maintenance window

Stop the NanoClaw service for this install. Confirm it is inactive before
continuing. Do not rely on a group restart: the host can respawn containers
between checks.

The apply command also performs strict install-scoped orphan cleanup and proves
that no affected container remains. If service shutdown, cleanup, or absence
verification fails, stop. Do not edit source paths by hand.

## 3. Apply the verified report

Run the real migration CLI against the retained report:

```bash
pnpm exec tsx scripts/migrate-workgroup-memory.ts apply --report "$REPORT"
```

Read the updated report in full. Require every workgroup to have status
`applied`. Confirm that each input byte has a recorded destination or exact
duplicate origin, every collision destination is distinct, the permanent
snapshot is present, and the reported canonical checksum exists.

The CLI re-inventories sources before snapshot, after snapshot, and immediately
before cutover. A changed byte, new container, unsupported path, checksum
mismatch, collision error, missing snapshot, or interrupted prior cutover
blocks apply. Never bypass a block or edit the report to force success.

After every selected workgroup reaches `applied`, the CLI also admits fresh
paired context for already-pending non-scheduled triggers before activation.
This is idempotent and does not wake an agent. Already-pending scheduled tasks
remain untouched until their due-time admission seam can build current context.

An apply failure fails closed. If the report had reached `cutover-started`, the
CLI automatically restores replaced source paths from the snapshot before it
records status `blocked`. Earlier failures have not replaced source paths. Read
the error and confirm the original path types/checksums. Do not run explicit
rollback against a blocked report: preserve it, resolve the cause, and create a
fresh inventory report before another apply.

## 4. Verify before activation

Run the read-only runtime verifier while the service remains stopped:

```bash
pnpm exec tsx scripts/verify-workgroup-memory-runtime.ts --all --json --require-applied-migration
```

Require it to verify trusted membership, one canon per workgroup, every sibling
compatibility view, canonical and rollback checksums, and applied report
outcomes without printing memory bodies or secrets. The
`--require-applied-migration` flag makes missing or non-applied migration
manifests activation blockers. Then run the relevant automated
memory/integration/provider checks required by the update that introduced the
migration.

Do not restart or activate NanoClaw until apply and runtime verification both
complete with `activationBlocking: false` and zero failures. Inspect and
document every warning. A warning may describe non-activatable historical state
such as a session whose inbound DB was already absent, or an empty workgroup;
it must not concern canon, links, migration provenance, outcomes, or a required
session pair.

## 5. Roll back a post-apply verification failure

When a report has status `applied` and runtime verification fails, explicitly
roll back before any service restart:

```bash
pnpm exec tsx scripts/migrate-workgroup-memory.ts rollback --report "$REPORT"
```

Read the updated report. Require affected cutovers to report `rolled-back`, and
confirm original path types and checksums from the permanent snapshot. A failed
rollback is a hard stop: keep the service inactive, preserve the report and
snapshot, and report the exact blocker.

The post-migration canon may remain unreferenced for forensic comparison after
rollback. Do not delete it or the snapshot.

This command is a data rollback: it restores the legacy source layout. The
current one-canon runtime must remain inactive against that rolled-back layout.
Restart only after either reverting the runtime code to the matching
pre-migration version, or correcting the blocker and applying a fresh migration
report that passes verification. Never let the current runtime treat restored
legacy stores as multiple writable canons.

Fresh context pairs admitted for already-pending triggers are additive and are
not deleted by filesystem rollback. They preserve the original trigger, are
idempotent, and do not wake an agent while the service is stopped.

## 6. Activate

Only after apply, runtime verification, and required tests are green:

1. start the NanoClaw service using this install's normal service manager;
2. verify service health and container startup;
3. test a first-wake and warm-turn recall through at least one sibling;
4. verify another sibling sees the same canonical edit; and
5. verify a different workgroup cannot see it.

If activation exposes a memory/link/checksum regression, stop the service and
run the rollback command against the retained report. Then follow the data
rollback rule above before any restart.
