# Switching an agent group between providers

An operator can move an agent group between Claude, Codex, OpenCode, or another
installed provider without moving its durable memory. Run the switch from the
host.

## Preconditions

1. Install or reapply the target provider's `/add-<provider>` skill.
2. Configure its authentication and supported model settings.
3. Rebuild the container image when the provider skill or container code
   requires it.
4. If this installation has not completed the shared-workgroup cutover, run
   `/migrate-memory` first. Do not switch or restart while its inventory,
   checksummed apply, runtime verification, or rollback is unresolved.

## Switch

```bash
ncl groups config update --id <group-id> --provider codex
ncl groups restart --id <group-id>
```

Sessions resolve their provider at container spawn. An unpinned session uses
the new provider on its next wake.

## Shared across siblings and providers

The workgroup's durable memory canon is
`data/workgroups/<workgroup-id>/memory`. It is mounted at
`/workspace/workgroup/memory`; `/workspace/agent/memory` is a compatibility
view. Recognized provider-native memory paths are also compatibility views, not
authorities. Treat raw provider-native projections as read-only.

Use `write_memory_file` for Markdown edits. Pass the current expected SHA-256
when replacing a file, or `expected_sha256: null` for create-only. This guarded
write reaches the same canon from every sibling.

Before every admissible turn, the host pushes actual session capabilities,
canonical memory, same-thread context, workgroup-wide archive recall, exact
Slack/Discord permalink provenance, and any explicit degraded notice. This
works on first wake, warm continuation, compaction, rotation, and replacement;
it does not depend on provider-native history or an optional tool call.
Graphify is optional and advisory for deeper retrieval.

## Kept separate

The following remain outside the memory canon:

- provider identity and provider instructions;
- provider config, authentication, model, and effort;
- provider state and continuations such as `.claude-shared/` and
  `.codex-shared/`;
- group wiring, roles, destinations, skills, packages, mounts, and CLI scope;
  and
- repositories, worktrees, workspace files, standing instructions, and all
  other non-memory customizations.

These surfaces are not migrated into the memory canon. They are not copied or
merged with one another. Switching providers selects another runtime around the
same workgroup data; it does not collapse sibling bot identity or continuation
state. The prior provider's continuation remains available if you switch back,
subject to its normal rotation policy.

## Roll back the provider choice

```bash
ncl groups config update --id <group-id> --provider claude
ncl groups restart --id <group-id>
```

No reverse memory migration is needed after a completed shared-memory cutover.
If the original cutover itself is unresolved, stop the service and use the
retained `/migrate-memory` report and permanent snapshot rollback before any
restart.
