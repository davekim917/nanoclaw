# Remove migrate-from-openclaw

This skill copies a small, fixed set of files into the project tree. Removal
deletes exactly those. It does **not** undo the migration itself — the agents,
messaging groups, wirings, roles, `.env` channel tokens, and OneCLI vault
secrets the migration created are your live NanoClaw install, not skill files.
Undoing those is a separate decision (see the last section).

Idempotent: every step skips cleanly if the file is already gone.

## 1. Remove the copied transform module and its test

These are the only files the skill installs into the project's source tree (the
validate step in Phase 8 copies them into `scripts/` so vitest runs them):

```bash
rm -f scripts/openclaw-transform.ts scripts/openclaw-transform.test.ts
```

## 2. Remove the migration state file

```bash
rm -f migration-state.md
```

## 3. Remove deferred-task notes (if Phase 5 deferred any)

When a task couldn't be scheduled yet, the skill records it per group:

```bash
rm -f groups/*/openclaw-migration-tasks.md
```

## 4. Migrated content files (review before deleting)

These are content you chose to bring over. Removing the skill must not delete
them. Review the recorded migration report and permanent snapshots before any
separate content-removal decision.

- Identity / personality: the byte-preserved group instruction files recorded
  by the migration, kept outside memory
- User context and memories: the destination files recorded in the migration's
  source-to-destination report under
  `data/workgroups/<workgroup-id>/memory/`
- Copied OpenClaw skills: directories you added under `container/skills/`
  (compare against the stock set before removing — do not delete
  `onecli-gateway`, `welcome`, `self-customize`, `agent-browser`,
  `slack-formatting`, or other shipped container skills).

Per-group standing instructions live in `groups/<folder>/instructions.prepend.md`;
durable facts live in the one workgroup canon at
`data/workgroups/<workgroup-id>/memory/`. Every provider sibling reaches that
canon through workgroup membership. `/workspace/agent/memory` is only a
compatibility link. Never delete the permanent pre-import or migrator rollback
snapshots automatically.

## 5. Rebuild if you removed copied skills

If step 4 deleted any `container/skills/` directories:

```bash
./container/build.sh
```

Then restart the service from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)
# Linux
systemctl --user restart $(systemd_unit)
```

## 6. Undo the migration itself (optional, destructive)

This reverses the live install state the migration produced — only do it to
fully back out. Use `ncl` to inspect first:

```bash
ncl wirings list
ncl messaging-groups list
ncl groups list
ncl roles list
```

Memory rollback is report-driven, checksummed, and separate from removing the
entities below. For an applied report whose runtime verification failed, follow
the exact rollback and pre-import restoration procedure in `SKILL.md`; keep the
failed canon and both permanent snapshots for audit. For a blocked report,
never run generic rollback.

Then delete only non-memory entities you recognize as migration output with the
matching `ncl ... delete` / `ncl roles revoke` / `ncl members remove` verbs.
Remove migrated channel tokens from `.env`, and remove vault secrets with
`onecli secrets delete` (list them with `onecli secrets list`).
