# Cutover Runbook — Superseded

> **Do not execute the historical commands from older revisions of this file.**
> They imported into provider-native stores, overwrote live files, and depended
> on scripts that no longer exist. Git history retains that record for
> provenance; it is not a supported recovery path.

The supported v1-to-v2 cutover is:

1. Run `bash migrate-v2.sh` from an interactive shell.
2. Complete `.claude/skills/migrate-from-v1/SKILL.md`.
3. Migrate durable memory through `.claude/skills/migrate-memory/SKILL.md`.

The memory workflow is deliberately separate and lossless:

- inventory every recognized group-local and provider-native source;
- stop the NanoClaw host service and prove affected containers
  are absent;
- retain a permanent checksummed host-only snapshot;
- preserve collisions without overwriting either version;
- activate one canonical tree at
  `data/workgroups/<workgroup-id>/memory`;
- replace sibling and provider-native paths with compatibility views only after
  verification;
- verify every sibling link, migration outcome, snapshot, and live recall pair;
- use the exact applied report for rollback if post-cutover verification fails.

`CLAUDE.md`, `CLAUDE.local.md`, `instructions.prepend.md`, provider
configuration, credentials, session transcripts, repositories, and worktrees
are customization or provider-state surfaces—not memory inputs. They remain
separate throughout migration.

For the active runtime contract, see [memory.md](memory.md). For provider
switching, see [provider-migration.md](provider-migration.md).
