---
name: update-nanoclaw
description: Safely bring upstream NanoClaw updates into a customized install while treating local customization behavior as the release-blocking invariant. Use for preview, full merge, selective cherry-pick, rebase, semantic customization compatibility auditing, validation, and rollback.
---

# About

Your NanoClaw fork drifts from upstream as you customize it. This skill pulls upstream changes into your install without losing or behaviorally regressing local customizations.

**Priority invariant:** local customization intent is more important than accepting any particular upstream change. A clean merge, successful build, and generic passing test suite are necessary but never sufficient evidence that the update is safe.

Run `/update-nanoclaw` in Claude Code or Codex. Use `AskUserQuestion` in Claude Code; in Codex, use its interactive-input tool when available or ask the question directly.

## How it works

**Preflight**: checks for clean working tree (`git status --porcelain`). If `upstream` remote is missing, asks you for the URL (defaults to `https://github.com/nanocoai/nanoclaw.git`) and adds it. Detects the upstream branch name (`main` or `master`).

**Backup**: creates a timestamped backup branch and tag (`backup/pre-update-<hash>-<timestamp>`, `pre-update-<hash>-<timestamp>`) before touching anything. Safe to run multiple times.

**Preview**: runs `git log` and `git diff` against the merge base to show upstream changes since your last sync. Groups changed files into categories:
- **Skills** (`.claude/skills/`): unlikely to conflict unless you edited an upstream skill
- **Host source** (`src/`): may conflict if you modified the same files
- **Container** (`container/`): triggers container rebuild
- **Build/config** (`package.json`, `pnpm-lock.yaml`, `tsconfig*.json`): lockfile changes trigger dep install

**Update paths** (you pick one):
- `merge` (default): `git merge upstream/<branch>`. Resolves all conflicts in one pass.
- `cherry-pick`: `git cherry-pick <hashes>`. Pull in only the commits you want.
- `rebase`: `git rebase upstream/<branch>`. Linear history, but conflicts resolve per-commit.
- `abort`: just view the changelog, change nothing.

**Conflict preview**: before merging, runs a dry-run (`git merge --no-commit --no-ff`) to show which files would conflict. You can still abort at this point.

**Conflict resolution**: resolves textual conflicts against a pre-merge customization contract, then audits clean auto-merges for semantic regressions.

**Validation**: runs `pnpm run build` and `pnpm test`. If container files changed, also runs the container typecheck and `./container/build.sh`.

**Post-merge audit**: six checks that go beyond build + tests (details in `audit.md`):
- **A. Customization preservation and compatibility** — proves each high-risk local customization still has its intended integration path and targeted verification, including clean auto-merges that preserved text but changed behavior.
- **B. Container rebuild requirement** — flags when `container/`, `src/config.ts`, or `src/install-slug.ts` changes mean the built agent-container image is stale; the final restart is gated on this.
- **C. Live migration preflight** — scans pending migrations against the real `data/v2.db` for `ALTER ... NOT NULL`, `DROP`, or destructive `UPDATE` that tests (scratch DB) miss.
- **D. Env var drift** — finds `.env` keys no source file reads anymore and new required keys the user hasn't set.
- **E. Supply-chain policy drift** — hard-fails if upstream silently reintroduces a release-age gate/exclusion or adds `onlyBuiltDependencies` entries.
- **F. Merge ancestry** — proves the captured merge commit has the upstream commit in real two-parent ancestry, even if compatibility fixes add follow-up commits.

**Breaking changes check**: after the audit, reads CHANGELOG.md for any `[BREAKING]` entries introduced by the update. If found, shows each breaking change and offers to run the recommended skill to migrate.

## Rollback

The backup tag is printed at the end of each run:
```
git reset --hard pre-update-<hash>-<timestamp>
```

Backup branch `backup/pre-update-<hash>-<timestamp>` also exists.

## Token usage

Uses Git-native inventory to keep the review focused. Never truncate or skip a customization-relevant diff, file, caller path, test, or provenance source to save tokens. Do not scan or refactor unrelated code.

---

# Goal
Help a user with a customized NanoClaw install safely incorporate upstream changes without a fresh reinstall and without blowing tokens.

# Operating principles
- Never proceed with a dirty working tree.
- Always create a rollback point (backup branch + tag) before touching anything.
- Preserve verified local customization intent ahead of upstream behavior.
- Prefer git-native operations (fetch, merge, cherry-pick). Permit only the minimal compatibility edits and regression tests required to preserve a proven customization contract; do not refactor unrelated code.
- Default to MERGE (one-pass conflict resolution). Offer REBASE as an explicit option.
- Use `git status`, `git log`, and `git diff` for inventory, then read every customization-relevant diff and dependency path end-to-end.

# Step 0: Preflight (stop early if unsafe)
Run:
- `git status --porcelain`
If output is non-empty:
- Tell the user to commit or stash first, then stop.

Confirm remotes:
- `git remote -v`
If `upstream` is missing:
- Ask the user for the upstream repo URL (default: `https://github.com/nanocoai/nanoclaw.git`).
- Add it: `git remote add upstream <user-provided-url>`
- Then: `git fetch upstream --prune`

Determine the upstream branch name:
- `git branch -r | grep upstream/`
- If `upstream/main` exists, use `main`.
- If only `upstream/master` exists, use `master`.
- Otherwise, ask the user which branch to use.
- Store this as UPSTREAM_BRANCH for all subsequent commands. Every command below that references `upstream/main` should use `upstream/$UPSTREAM_BRANCH` instead.

Fetch:
- `git fetch upstream --prune`

# Step 1: Create a safety net
Capture current state:
- `HASH=$(git rev-parse --short HEAD)`
- `TIMESTAMP=$(date +%Y%m%d-%H%M%S)`

Create backup branch and tag (using timestamp to avoid collisions on retry):
- `git branch backup/pre-update-$HASH-$TIMESTAMP`
- `git tag pre-update-$HASH-$TIMESTAMP`

Save the tag name for later reference in the summary and rollback instructions.

# Step 2: Preview what upstream changed (no edits yet)
Compute common base:
- `BASE=$(git merge-base HEAD upstream/$UPSTREAM_BRANCH)`

Show upstream commits since BASE:
- `git log --oneline $BASE..upstream/$UPSTREAM_BRANCH`

Show local commits since BASE (custom drift):
- `git log --oneline $BASE..HEAD`

Show file-level impact from upstream:
- `git diff --name-only $BASE..upstream/$UPSTREAM_BRANCH`

Bucket the upstream changed files:
- **Skills** (`.claude/skills/`): unlikely to conflict unless the user edited an upstream skill
- **Host source** (`src/`): may conflict if user modified the same files
- **Container** (`container/`): triggers container rebuild (+ typecheck if `agent-runner/src/` changed)
- **Build/config** (`package.json`, `pnpm-lock.yaml`, `tsconfig*.json`): lockfile changes trigger dep install
- **Other**: docs, tests, setup scripts, misc

**Large drift check:** If the upstream commit count and age suggest the user has a lot of catching up to do, mention that `/migrate-nanoclaw` might be a better fit — it extracts customizations and reapplies them on clean upstream instead of merging. Offer it as an option but don't push.

Present these buckets to the user and ask them to choose one path using AskUserQuestion:
- A) **Full update**: merge all upstream changes
- B) **Selective update**: cherry-pick specific upstream commits
- C) **Abort**: they only wanted the preview
- D) **Rebase mode**: advanced, linear history (warn: resolves conflicts per-commit)

If Abort: stop here.

# Step 2.5: Capture the customization contract

Before any apply path except Abort, read Section A of `.claude/skills/update-nanoclaw/audit.md` and complete its pre-merge baseline against `BASE`, the backup tag, and the upstream changes being applied. For cherry-pick, scope `UPSTREAM_FILES` to the selected commits.

Build a contract row for every high-risk customization:

```
ID | intent + provenance | integration point | upstream overlap/dependency | preservation requirement | verification
```

Do not infer intent from the final file alone. Read the complete local diff, relevant non-merge commit history, adjacent tests/specs, and direct callers. If intent remains ambiguous, ask the user before merging.

Do not proceed until every high-risk customization has:
- a concrete preservation requirement, and
- a targeted test or non-destructive smoke that exercises the real integration point.

Missing evidence is a `BLOCK`, not an assumed pass. Generic build/typecheck/full-suite success does not replace this contract.

# Step 3: Conflict preview (before committing anything)
If Full update or Rebase:
- Dry-run merge to preview conflicts. Run these as a single chained command so the abort always executes:
  ```
  git merge --no-commit --no-ff upstream/$UPSTREAM_BRANCH; git diff --name-only --diff-filter=U; git merge --abort
  ```
- If conflicts were listed: show them and ask user if they want to proceed.
- If no conflicts: tell user it is clean and proceed.

# Step 4A: Full update (MERGE, default)

Capture the upstream SHA being merged (used by the safety guards below):
- `UPSTREAM_SHA=$(git rev-parse upstream/$UPSTREAM_BRANCH)`

Run:
- `git merge --no-ff upstream/$UPSTREAM_BRANCH --no-edit`

**Critical — do NOT run `git stash`, `git reset`, or `git checkout` while in merge state** (i.e. while `.git/MERGE_HEAD` exists). All three discard `MERGE_HEAD` silently, after which the next `git commit` produces a single-parent commit instead of a merge. The upstream commits then remain orphaned from your ancestry: GitHub's compare API and any `git rev-list origin..upstream` check will keep reporting the fork as "behind upstream" even though the file content was integrated.

If conflicts occur:
- Run `git status` and identify conflicted files.
- For each conflicted file:
  - Open the complete base, backup, upstream, and conflicted diff relevant to the file.
  - Resolve the conflict markers against the customization contract.
  - Preserve the behavior and integration path of intentional local customizations.
  - Incorporate upstream fixes/improvements.
  - Do not refactor surrounding code.
  - `git add <file>`
- When all resolved:
  - **Pre-commit guard** — verify Git's resolved `MERGE_HEAD` path still exists. If something cleared it during conflict resolution, restore it from the SHA captured above so the next commit becomes a proper merge:
    ```bash
    MERGE_HEAD_PATH=$(git rev-parse --git-path MERGE_HEAD)
    if [ ! -f "$MERGE_HEAD_PATH" ]; then
      printf '%s\n' "$UPSTREAM_SHA" > "$MERGE_HEAD_PATH"
    fi
    ```
  - If merge did not auto-commit: `git commit --no-edit`

Immediately capture the merge commit before any compatibility follow-up:

```bash
MERGE_COMMIT=$(git rev-parse HEAD)
```

Persist `MERGE_COMMIT` and `UPSTREAM_SHA` for audit F.

**Post-commit verification** — confirm the captured merge commit has 2 parents and contains the upstream SHA:
```bash
PARENT_COUNT=$(git rev-list --parents -1 "$MERGE_COMMIT" | awk '{print NF-1}')
if [ "$PARENT_COUNT" != "2" ]; then
  echo "ERROR: merge produced a $PARENT_COUNT-parent commit (expected 2)."
  echo "Upstream commits are NOT in your ancestry — the fork will keep reporting 'behind upstream'."
  echo "Recover with: git reset --hard <backup-tag-from-step-1> and re-run /update-nanoclaw."
  echo "Avoid 'git stash', 'git reset', 'git checkout' during conflict resolution."
  exit 1
fi
git merge-base --is-ancestor "$UPSTREAM_SHA" "$MERGE_COMMIT" || {
  echo "ERROR: upstream SHA is not in the captured merge commit ancestry."
  exit 1
}
```
If this fails, abort the skill — do not proceed to Step 5. The user must reset to the backup tag and retry.

After this guard passes, make only the minimal compatibility edits or regression-test additions required by the customization contract. Commit them separately so the merge commit remains auditable.

# Step 4B: Selective update (CHERRY-PICK)
If user chose Selective:
- Recompute BASE if needed: `BASE=$(git merge-base HEAD upstream/$UPSTREAM_BRANCH)`
- Show commit list again: `git log --oneline $BASE..upstream/$UPSTREAM_BRANCH`
- Ask user which commit hashes they want.
- Apply: `git cherry-pick <hash1> <hash2> ...`

If conflicts during cherry-pick:
- Resolve conflict markers against the customization contract, then:
  - `git add <file>`
  - `git cherry-pick --continue`
If user wants to stop:
  - `git cherry-pick --abort`

# Step 4C: Rebase (only if user explicitly chose option D)
Run:
- `git rebase upstream/$UPSTREAM_BRANCH`

If conflicts:
- Resolve conflict markers against the customization contract, then:
  - `git add <file>`
  - `git rebase --continue`
If it gets messy (more than 3 rounds of conflicts):
  - `git rebase --abort`
  - Recommend merge instead.

# Step 4.5: Install dependencies (if lockfiles changed)
Check if the merge changed any lockfiles or package manifests:
- `git diff <backup-tag-from-step-1>..HEAD --name-only | grep -E '^(pnpm-lock\.yaml|package\.json)$'`
  - If matched: `pnpm install`
- `git diff <backup-tag-from-step-1>..HEAD --name-only | grep -E '^container/agent-runner/(bun\.lock|package\.json)$'`
  - If matched AND `command -v bun` succeeds: `cd container/agent-runner && bun install`
  - If bun is not installed on the host, skip — container deps will be installed during `./container/build.sh`

Skip this step if neither lockfile changed.

# Step 5: Validation
Check which areas changed to determine what to validate:
- `CHANGED_FILES=$(git diff --name-only <backup-tag-from-step-1>..HEAD)`

**Customization contract verification** (always):
- Run every targeted command recorded in Step 2.5.
- Confirm each test drives the real integration point; directly unit-testing only the customization's internal helper does not count.
- For runtime-only behavior, run the recorded non-destructive smoke against the built artifact.
- Any missing, skipped, flaky, or failed required verification → BLOCK. Fix the merge-caused regression or roll back; do not accept generic suite success as a substitute.

**Host build** (always):
- `pnpm run build`
- `pnpm test` (do not fail the flow if tests are not configured)

**Container typecheck** (only if `container/agent-runner/src/` files are in CHANGED_FILES AND bun types are available):
- Check: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
- If this fails because bun types are missing (`Cannot find type definition file for 'bun'`), skip with a note — type errors will surface at container runtime instead

**Container image rebuild** (only if any `container/` files are in CHANGED_FILES):
- `./container/build.sh`

If build fails:
- Show the error.
- Only fix issues clearly caused by the merge (missing imports, type mismatches from merged code).
- Do not refactor unrelated code.
- If unclear, ask the user before making changes.

# Step 6: Post-merge audit

After validation passes, run the full audit defined in `.claude/skills/update-nanoclaw/audit.md`:

1. Read `.claude/skills/update-nanoclaw/audit.md` with the Read tool.
2. Follow every sub-audit (A–F) in order, passing `BACKUP=<backup-tag-from-step-1>`. For a full merge, also pass `MERGE_COMMIT=<captured-merge-sha>` and `UPSTREAM_SHA=<captured-upstream-sha>`; skip F for cherry-pick or rebase.
3. Collect findings into the consolidated report format at the end of `audit.md`.
4. Apply the decision rules:
   - Any `BLOCK` → stop here; require user resolution before continuing.
   - `FLAG` items → show the details, ask the user whether to accept them or rollback. Default to proceed on acceptance.
   - All `PASS` → continue silently.
5. Persist the audit verdict. Step 9 needs:
   - `REBUILD_REQUIRED` (from sub-audit B) — whether the final restart must be gated on `./container/build.sh`.
   - `DB_BACKUP_RECOMMENDED` (from sub-audit C) — whether the user should back up `data/v2.db` before restart.
   - `UNRESOLVED_MIGRATIONS` — any skipped, failed, or incomplete breaking-change migration skills.

Rollback recipe (for BLOCK or user-rejected FLAG):

```bash
git reset --hard <backup-tag-from-step-1>
```

# Step 7: Breaking changes check
After the audit clears, check if the update introduced any breaking changes.

Determine which CHANGELOG entries are new by diffing against the backup tag:
- `git diff <backup-tag-from-step-1>..HEAD -- CHANGELOG.md`

Parse the diff output for lines that contain `[BREAKING]` anywhere in the line. Each such line is one breaking change entry. The format is:
```
[BREAKING] <description>. Run `/<skill-name>` to <action>.
```

If no `[BREAKING]` lines are found:
- Skip this step silently. Proceed to Step 8 (skill updates check).

If one or more `[BREAKING]` lines are found:
- Display a warning header to the user: "This update includes breaking changes that may require action:"
- For each breaking change, display the full description.
- Collect all skill names referenced in the breaking change entries (the `/<skill-name>` part).
- Initialize an unresolved-migrations list with every referenced skill. Remove a
  skill only after it completes successfully.
- Use AskUserQuestion to ask the user which migration skills they want to run now. Options:
  - One recommended option per referenced skill (e.g., "Run /add-whatsapp (Recommended)")
  - "Skip — I'll handle these manually"
- Set `multiSelect: true` so the user can pick multiple skills if there are several breaking changes.
- For each skill the user selects, invoke it using the Skill tool.
- Remove a skill from the unresolved list only after it completes successfully.
  Keep every skipped, failed, or incomplete skill unresolved, then proceed to
  Step 8.

# Step 8: Skill updates (part of updating NanoClaw)

Updating your installed skills is **part of** updating NanoClaw, not an optional
extra. Channel and provider code ships on long-lived branches (`channels`,
`providers`) that the host merge above doesn't touch — so stopping here leaves
that code on whatever version you installed, which is how an important upstream
fix gets silently left behind. The default is to continue into `/update-skills`,
which re-applies your installed channels/providers to pull their latest code.

Detect whether anything is installed: read `src/channels/index.ts` and
`src/providers/index.ts`, collecting `import './<name>.js';` lines (excluding
`cli`).

- If nothing is installed: skip silently and proceed to Step 9.
- If one or more are installed: continue into skill updates.

**Hand-off — default in, minimal opt-out.** Use AskUserQuestion (single-select).
Name the installed skills in the question so the choice is concrete:
- Question: "Skill updates are part of this NanoClaw update — your installed
  channels/providers (<list the detected ones>) ride separate branches the host
  update didn't touch. Continue into `/update-skills` to bring them up to date?"
- Option 1 (Recommended): "Continue into skill updates" — description: "Runs
  `/update-skills`, which re-applies your installed channels/providers to pull
  their latest upstream code. You pick which ones there."
- Option 2: "Skip — I'll run `/update-skills` myself later" — description: "Your
  installed skill code stays as-is and may be behind upstream."

Keep it to these two options — the per-skill selection lives inside
`/update-skills`, not here.

- On "Continue": invoke `/update-skills` using the Skill tool. (If the re-apply
  touches container code, `/update-skills` rebuilds the agent image itself — see
  its Step 4 — so nothing container-related is owed back here.)
- On "Skip": note that `/update-skills` can be run anytime, then proceed.

## Known behavior changes when channel adapters update

Channel adapters now declare per-channel wiring defaults (engage mode, threading,
sender policy). Updating trunk alone changes nothing for existing rows, but once
`/update-skills` pulls current adapter copies, two deliberate behavior changes
land. If the user's install has Slack, Discord, or WhatsApp, tell them:

1. **Slack/Discord DM replies move top-level.** Both adapters now declare
   `threads: false` for DMs, so DM replies stop chasing per-message sub-threads
   and land in the main DM view, matching the DM session (which was already
   flat). Group/channel threading is unchanged. To keep the old in-thread DM
   behavior for a specific wiring, override it per wiring:
   `ncl wirings update <wiring-id> --threads true`.
2. **Shared-identity channels stop raising stranger approval cards.** On
   channels where the linked account is the operator's personal identity, the
   mechanics differ by channel: WhatsApp personal-number mode suppresses the
   mention signal entirely (no auto-created messaging groups, no cards);
   iMessage and WeChat still emit DM mention signals — stranger DMs still
   auto-create `messaging_groups` rows — but their declared `strict` policy
   makes those rows drop unknown senders silently instead of raising
   channel-registration cards to the admin.

**WhatsApp installs on a shared/personal number should re-run `/add-whatsapp`**
after the skill update: it now asks the dedicated-vs-personal question
explicitly (writing `ASSISTANT_HAS_OWN_NUMBER` to `.env`), audits for legacy
mis-wired group rows from spam-era approval cards, and shows how to clear
stale pending approvals.

Proceed to Step 9.

# Step 9: Summary + rollback instructions
Show:
- Backup tag: the tag name created in Step 1
- New HEAD: `git rev-parse --short HEAD`
- Upstream HEAD: `git rev-parse --short upstream/$UPSTREAM_BRANCH`
- Conflicts resolved (list files, if any)
- Customization contract: total rows, high-risk rows, verification commands run, and any compatibility fixes
- Audit findings (A–F verdicts from Step 6)
- Breaking changes applied (list skills run, if any)
- Unresolved breaking migrations (list skipped, failed, or incomplete skills)
- Remaining local diff vs upstream: `git diff --name-only upstream/$UPSTREAM_BRANCH..HEAD`

Apply audit-driven gating before suggesting the restart:

- If `REBUILD_REQUIRED=yes` (from audit sub-B): the restart command MUST be preceded by `./container/build.sh`. State this as a required pre-step, not optional. If sub-B also noted buildx cache staleness, add `docker buildx prune -f` before the build.
- If `DB_BACKUP_RECOMMENDED=yes` (from audit sub-C): suggest `cp data/v2.db data/v2.db.pre-update-$(date +%s)` before restart.

If unresolved migrations remain, explain that the code merge succeeded but the
affected features may ignore old state until those migrations run. Before
showing restart commands, ask whether to:

- **Run unresolved migrations (Recommended):** invoke each unresolved skill
  and remove it only after successful completion.
- **Restart anyway:** continue only with explicit confirmation and repeat the
  unresolved skill names in the final warning.

If a retried migration remains unresolved, ask again. Do not show restart
commands until the list is empty or the user explicitly accepts restarting
anyway.

Tell the user:
- To rollback: `git reset --hard <backup-tag-from-step-1>`
- Backup branch also exists: `backup/pre-update-<HASH>-<TIMESTAMP>`
- Restart the service to apply changes (after rebuild/backup if flagged above). Detect platform with `uname -s`:
  - **macOS (Darwin)**: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (or derive the slug: `source setup/lib/install-slug.sh && launchctl kickstart -k gui/$(id -u)/$(launchd_label)`)
  - **Linux (systemd user)**: detect the service name with `systemctl --user list-units --type=service | grep nanoclaw | awk '{print $1}'`, then `systemctl --user restart <detected-name>` (or `source setup/lib/install-slug.sh && systemctl --user restart $(systemd_unit)`)
  - **Linux (systemd system)**: `sudo systemctl restart nanoclaw-v2`
  - **Manual** (no service found): restart `pnpm run dev`


## Diagnostics

1. Use the Read tool to read `.claude/skills/update-nanoclaw/diagnostics.md`.
2. Follow every step in that file before finishing.
