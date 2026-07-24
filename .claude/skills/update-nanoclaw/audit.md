# Post-merge audit

Build + tests catch symbol-level breakage. They do NOT prove that customized behavior still has the same integration path after a clean merge. Run every check. Treat local customization intent as the release-blocking invariant.

## Contents

- A. Customization preservation and compatibility
- B. Container rebuild requirement
- C. Live migration preflight
- D. Env var drift
- E. Supply-chain policy drift
- F. Merge ancestry check
- Final audit report

Prerequisites (set once at the top):

```bash
BACKUP=<backup-tag-from-step-1>                            # e.g. pre-update-7374ae7-20260424-013859
BASE=$(git merge-base $BACKUP upstream/$UPSTREAM_BRANCH)
MERGE_COMMIT=<merge-sha-captured-in-step-4A>               # full merge only
UPSTREAM_SHA=<upstream-sha-captured-in-step-4A>            # full merge only
```

Each sub-audit below writes its verdict into one of:

- `PASS` — no finding, continue
- `FLAG` — finding exists, explain to user before proceeding
- `BLOCK` — must be resolved (or explicitly accepted) before Step 9 restart

---

## A. Customization preservation and compatibility

This is the highest-priority audit. It covers both textual silent drops and semantic regressions where customized lines survive but upstream changes a caller, lifecycle, schema, provider contract, config surface, or runtime assumption.

Do not award PASS because Git merged cleanly, because the customized line still exists, or because the full suite passes. PASS requires a reviewed customization contract and targeted evidence for every high-risk row.

### A.0 — Pre-merge customization baseline

Run before Step 3, using the backup tag created for this update:

```bash
CUSTOM_FILES=$(git diff --name-only "$BASE..$BACKUP" | sort -u)
UPSTREAM_FILES=$(git diff --name-only "$BASE..upstream/$UPSTREAM_BRANCH" | sort -u)
DUAL=$(comm -12 <(printf '%s\n' "$CUSTOM_FILES") <(printf '%s\n' "$UPSTREAM_FILES"))
```

Classify as **high-risk** any local customization with a functional consequence, including:

- a file in `src/`, `container/agent-runner/src/`, `setup/`, executable `scripts/`, container build/runtime files, package manifests, or DB migrations;
- a channel/provider barrel, config/env surface, CLI or approval contract, message/session DB contract, mount, scheduling path, or setup/install path;
- any file changed by both local and upstream history;
- any locally customized file whose imports, callers, data shape, or runtime boundary changed upstream.

Tests, docs, and instruction-only skills are contract evidence rather than runtime rows unless they themselves install or change functional behavior.

For each high-risk row, record:

```
ID | intent + provenance | integration point | upstream overlap/dependency | preservation requirement | verification
```

Determine intent from all relevant evidence, in this order:

1. Read the complete `git diff "$BASE..$BACKUP" -- <file>`.
2. Read `git log --no-merges --reverse --format='%H %s' "$BASE..$BACKUP" -- <file>` and inspect the relevant commits.
3. Read adjacent regression tests, specs, and operational docs end-to-end.
4. Trace direct imports, callers, registrations, schema consumers, and runtime handoffs with `rg`.
5. If intent is still ambiguous, ask the user. Do not guess.

Do not truncate relevant diffs with `head`, `tail`, or output limits that hide hunks. Split the read into complete chunks if necessary.

Every high-risk row must have a targeted verification before merge. Prefer, in order:

1. A behavior test that drives the real integration point.
2. A structural/AST test for non-invocable boot or wiring points.
3. A container/build probe for image, mount, or installed-binary contracts.
4. A non-destructive live smoke for behavior that cannot be exercised in-tree.

A unit test that imports only the customization helper and bypasses its core wiring does not count. If a functional row has no adequate verification, mark A as BLOCK before merging.

### A.1 — Exports that vanished

```bash
git ls-tree -r --name-only "$BACKUP" -- src/ container/agent-runner/src/ setup/ scripts/ \
  | rg '\.ts$' | rg -v '\.test\.ts$' \
  | while IFS= read -r f; do
      BACKUP_EXPORTS=$(git show "$BACKUP:$f" 2>/dev/null \
        | rg -o '^export (function|const|class|interface|type|enum) [A-Za-z_][A-Za-z0-9_]*' \
        | sort -u)
      MERGED_EXPORTS=$(git show "HEAD:$f" 2>/dev/null \
        | rg -o '^export (function|const|class|interface|type|enum) [A-Za-z_][A-Za-z0-9_]*' \
        | sort -u)
      comm -23 \
        <(printf '%s\n' "$BACKUP_EXPORTS") \
        <(printf '%s\n' "$MERGED_EXPORTS") \
        | sed "s#^#$f: #"
    done
```

Empty output → PASS.
Non-empty → for each missing export, check whether upstream renamed it and inspect every customized caller. A proven compatible replacement is legitimate; an unresolved high-risk missing export is BLOCK.

### A.2 — Lines the user had that the merge removed

```bash
DUAL=$(comm -12 <(git diff --name-only "$BASE..upstream/$UPSTREAM_BRANCH" | sort -u) \
                <(git diff --name-only "$BASE..$BACKUP" | sort -u))
while IFS= read -r f; do
  [ -z "$f" ] && continue
  REMOVED=$(git diff "$BACKUP..HEAD" -- "$f" | grep -c '^-[^-]')
  [ "$REMOVED" -gt 0 ] && echo "$REMOVED  $f"
done <<< "$DUAL" | sort -rn
```

For each file with >0 removed lines, inspect the complete diff:

```bash
git diff "$BACKUP..HEAD" -- <file>
```

Removed + added pair covering the same concept = legitimate upstream refactor.
Removed with no matching addition and the line is part of a customization contract = BLOCK.

### A.3 — Four-way semantic replay

For every high-risk contract row, inspect all four views:

```bash
git diff "$BASE..$BACKUP" -- <file>                         # local intent before merge
git diff "$BASE..upstream/$UPSTREAM_BRANCH" -- <file>      # upstream change
git diff "$BACKUP..HEAD" -- <file>                         # effect of the merge
git diff "upstream/$UPSTREAM_BRANCH..HEAD" -- <file>       # surviving local delta
```

Detect customized files that existed before the update but vanished from the merged tree:

```bash
DELETED_CUSTOM=$(comm -12 \
  <(printf '%s\n' "$CUSTOM_FILES") \
  <(comm -23 \
    <(git ls-tree -r --name-only "$BACKUP" | sort -u) \
    <(git ls-tree -r --name-only HEAD | sort -u)))
printf '%s\n' "$DELETED_CUSTOM"
```

Any high-risk deleted customization without a proven replacement is BLOCK.

Read the merged implementation and its direct callers end-to-end. Confirm that the preservation requirement still holds at the real integration point, not merely that similar text remains.

Explicitly inspect customized files that upstream did not touch when they depend on an upstream-changed import, schema, config field, CLI shape, provider event, container path, or lifecycle hook. These dependency-path regressions are the main class a textual silent-drop check misses.

If upstream intentionally replaces a customization, prove the replacement meets the same requirement and update the contract row with that evidence. Similar naming or a passing generic test is not proof.

### A.4 — Targeted regression verification

Run every verification command from the pre-merge contract after merge and after any compatibility fix.

For each row, record:

```
ID | verification command | result | evidence
```

Rules:

- Passing build/typecheck and the full suite remain required but do not replace targeted verification.
- A skipped, flaky, unavailable, or inconclusive required test is not PASS.
- If the merge exposes a testable customization with no adequate regression test, add the narrow integration test and run it.
- Make only minimal compatibility changes required to preserve the documented intent. Commit them separately from the merge commit.
- For runtime-only checks that require restart, keep A blocked until the post-restart smoke succeeds; do not claim the update complete earlier.

### Resolution

Verdict rules:

- `PASS` — every high-risk row preserves its requirement and has passing targeted evidence.
- `BLOCK` — any row is missing, ambiguous, behaviorally regressed, deleted without a proven replacement, or lacks conclusive verification.

Resolve a BLOCK by adapting the merge with a narrowly scoped fix plus regression evidence, explicitly retiring the customization with the user's informed approval, or rolling back with `git reset --hard $BACKUP`. Never downgrade an unresolved customization risk to FLAG.

---

## B. Container rebuild requirement

The built agent-container image is stale any time these files change. If the user restarts the host without rebuilding, every session spawn fails with "image not found" (silently — only visible in logs).

### B.1 — Files that invalidate the image

```bash
git diff --name-only $BACKUP..HEAD -- container/ src/config.ts src/install-slug.ts 2>/dev/null
```

Any output → REBUILD-NEEDED flag ON.

### B.2 — Verify the expected image actually exists on disk

```bash
EXPECTED=$(node --input-type=module -e "import('./dist/config.js').then(m => console.log(m.CONTAINER_IMAGE))" 2>/dev/null)
echo "Expected: $EXPECTED"
docker image inspect "$EXPECTED" >/dev/null 2>&1 && echo "PRESENT" || echo "MISSING"
```

`MISSING` → BLOCK. Step 9 must show `./container/build.sh` as a required pre-restart step.

Also check for buildx cache staleness if `container/agent-runner/` changed (the builder volume retains stale COPY sources per CLAUDE.md):

```bash
git diff --name-only $BACKUP..HEAD -- container/agent-runner/ 2>/dev/null | head -5
```

If non-empty, recommend `docker buildx prune -f` before `./container/build.sh`.

---

## C. Live migration preflight

`pnpm test` runs migrations against a scratch DB. The real `data/v2.db` has rows — `ALTER TABLE ... NOT NULL` without a `DEFAULT`, `DROP COLUMN`, and destructive `UPDATE`s behave differently on populated data.

### C.1 — List pending migrations against the live DB

```bash
APPLIED=$(pnpm exec tsx scripts/q.ts data/v2.db "SELECT name FROM schema_version" 2>/dev/null | sort -u)
DEFINED=$(grep -hoE "name: '[^']+'" src/db/migrations/*.ts | sed "s/name: '\(.*\)'/\1/" | sort -u)
PENDING=$(comm -23 <(echo "$DEFINED") <(echo "$APPLIED"))
echo "$PENDING"
```

### C.2 — Risk-scan each pending migration

```bash
for m in $PENDING; do
  f=$(grep -l "name: '$m'" src/db/migrations/*.ts | head -1)
  echo "=== $m ($f) ==="
  grep -niE 'ALTER TABLE|DROP COLUMN|DROP TABLE|UPDATE .* SET|NOT NULL' "$f"
done
```

Any hit on `DROP COLUMN`, `DROP TABLE`, `UPDATE ... SET` (other than trivial backfills), or `ALTER TABLE ... NOT NULL` without a visible `DEFAULT` → FLAG with a recommendation:

```bash
cp data/v2.db "data/v2.db.pre-update-$(date +%s)"
```

Offer to run this backup before the restart. For per-session DBs (if the agent-runner's migration system changed), same principle applies but host cannot migrate session DBs (one-writer rule) — flag for awareness only.

---

## D. Env var drift

Upstream may rename or drop env vars the user's `.env` still sets. Stale keys = silent no-op. Missing new required keys = startup crash or silent misconfig.

### D.1 — Env reads that changed

```bash
git diff "$BACKUP..HEAD" -- src/config.ts container/agent-runner/src/ 2>/dev/null \
  | grep -E '^[+-][^+-].*process\.env\.[A-Z_]+'
```

### D.2 — Keys user sets but nothing reads

```bash
if [ -f .env ]; then
  for key in $(grep -oE '^[A-Z_][A-Z0-9_]*=' .env | sed 's/=$//'); do
    if ! rg -q "process\\.env\\.$key\\b|env\\.$key\\b|\\b$key\\b" src/ setup/ scripts/ container/ 2>/dev/null; then
      echo "UNUSED: $key"
    fi
  done
fi
```

List unused keys — FLAG, don't auto-remove (user may have set them intentionally for a skill they'll re-add).

### D.3 — Keys newly-required by merged code

Look in the merged `src/config.ts` for `process.env.X` reads with no fallback (i.e., code that would crash or misbehave if the var is absent):

```bash
git diff $BACKUP..HEAD -- src/config.ts | grep '^+' | grep -E 'process\.env\.[A-Z_]+'
```

Cross-check each new env ref against `.env`; flag anything required that isn't set.

---

## E. Supply-chain policy drift

Per CLAUDE.md's Supply Chain Security section, release-age gates are retired. `onlyBuiltDependencies` additions still require explicit human sign-off, and upstream must not silently reintroduce an age delay or exclusion mechanism.

```bash
git diff $BACKUP..HEAD -- pnpm-workspace.yaml package.json \
  | grep -E '^\+' | grep -E 'minimumReleaseAge|minimumReleaseAgeExclude|onlyBuiltDependencies|"[a-z].*@[0-9]'
```

Any added age-policy key or build-script allowlist entry → BLOCK. Ask via AskUserQuestion, one question per entry:

- "Approve — I reviewed this specific version and accept"
- "Revert this entry" → drop the line via an Edit, amend the merge commit (or add a follow-up commit)
- "Abort and rollback the merge" → `git reset --hard $BACKUP`

---

## F. Merge ancestry check

Only relevant when the user picked path A (Full update). Verify the captured merge commit, not necessarily HEAD: customization compatibility fixes may add legitimate single-parent follow-up commits after the merge.

The merge commit must have two parents and contain the exact captured upstream SHA in its ancestry:

```bash
PARENT_COUNT=$(git rev-list --parents -1 "$MERGE_COMMIT" | awk '{print NF-1}')
test "$PARENT_COUNT" -eq 2
git merge-base --is-ancestor "$UPSTREAM_SHA" "$MERGE_COMMIT"
git merge-base --is-ancestor "$MERGE_COMMIT" HEAD
```

- All three checks succeed → PASS.
- Any check fails → BLOCK. Recovery: `git reset --hard $BACKUP` and re-run `/update-nanoclaw`. Avoid `git stash`, `git reset`, or `git checkout` during conflict resolution.

---

## Final audit report

After running A–F, present a single report:

```
Audit findings
──────────────
A. Customization compatibility:[PASS (N/N verified) | BLOCK (N items)]
B. Container rebuild required: [no  | YES — see Step 9]
C. Risky pending migrations:   [PASS | FLAG (N migrations)]
D. Env var drift:              [PASS | FLAG (N unused / N new-required)]
E. Supply-chain policy:        [PASS | BLOCK (N entries)]
F. Merge ancestry:             [PASS | BLOCK]
```

Decision rules:

- Any BLOCK → stop here. Customization BLOCKs require a compatibility fix with evidence, explicit retirement by the user, or rollback; absence of evidence cannot be accepted as PASS.
- Only FLAGs → show the details, ask the user whether to proceed or rollback. Default to proceed if the user accepts each flag.
- All PASS → continue silently to Step 7.

Persist the audit verdict (especially B's REBUILD-NEEDED flag) — Step 9's summary needs it to decide whether `./container/build.sh` must run before `systemctl restart`.
