# Post-merge audit

Build + tests catch symbol-level breakage. They do NOT catch the classes of regression below. Run every check. Collect findings into a single report and escalate to the user before proceeding to the next step.

Prerequisites (set once at the top):

```bash
BACKUP=<backup-tag-from-step-1>                            # e.g. pre-update-7374ae7-20260424-013859
BASE=$(git merge-base $BACKUP upstream/$UPSTREAM_BRANCH)
```

Each sub-audit below writes its verdict into one of:

- `PASS` — no finding, continue
- `FLAG` — finding exists, explain to user before proceeding
- `BLOCK` — must be resolved (or explicitly accepted) before Step 9 restart

---

## A. Silent-drop audit

Upstream deletes or rewrites something the user relied on, but git merges clean because the textual contexts didn't overlap. Build/tests pass because the user's callers aren't directly broken (yet). Surface these drops so the user can confirm each one is intentional.

### A.1 — Exports that vanished

```bash
BACKUP_EXPORTS=$(git ls-tree -r --name-only $BACKUP -- 'src/' | grep -E '\.ts$' | grep -v '\.test\.ts$' \
  | xargs -I {} git show "$BACKUP:{}" 2>/dev/null \
  | grep -hoE '^export (function|const|class|interface|type|enum) [A-Za-z_][A-Za-z0-9_]*' | sort -u)
MERGED_EXPORTS=$(git ls-tree -r --name-only HEAD -- 'src/' | grep -E '\.ts$' | grep -v '\.test\.ts$' \
  | xargs -I {} git show "HEAD:{}" 2>/dev/null \
  | grep -hoE '^export (function|const|class|interface|type|enum) [A-Za-z_][A-Za-z0-9_]*' | sort -u)
comm -23 <(echo "$BACKUP_EXPORTS") <(echo "$MERGED_EXPORTS")
```

Empty output → PASS.
Non-empty → for each missing export, check whether upstream renamed it (grep for the new name in recently-added upstream commits). Rename = legitimate; no replacement = silent drop. FLAG any silent drop.

### A.2 — Lines the user had that the merge removed

```bash
DUAL=$(comm -12 <(git diff --name-only $BASE..upstream/$UPSTREAM_BRANCH | sort -u) \
                <(git diff --name-only $BASE..$BACKUP | sort -u))
for f in $DUAL; do
  REMOVED=$(git diff "$BACKUP..HEAD" -- "$f" | grep -c '^-[^-]')
  [ "$REMOVED" -gt 0 ] && echo "$REMOVED  $f"
done | sort -rn
```

For each file with >0 removed lines, inspect:

```bash
git diff $BACKUP..HEAD -- <file> | grep -E '^[-+][^-+]' | head -60
```

Removed + added pair covering the same concept = legitimate upstream refactor.
Removed with no matching addition and the line looks like a user customization = silent drop, FLAG.

### Resolution

If A.1 or A.2 produces silent drops, ask via AskUserQuestion:

- "Accept — legitimate upstream changes" → PASS
- "Abort and rollback" → `git reset --hard $BACKUP`, stop the skill
- "Open <file> to inspect" → open, then re-ask

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
EXPECTED=$(node -p "require('./dist/config.js').CONTAINER_IMAGE" 2>/dev/null)
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
APPLIED=$(sqlite3 data/v2.db "SELECT name FROM schema_version" 2>/dev/null | sort -u)
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
git diff $BACKUP..HEAD -- src/config.ts container/agent-runner/src/**/*.ts 2>/dev/null \
  | grep -E '^[+-][^+-].*process\.env\.[A-Z_]+' | head -30
```

### D.2 — Keys user sets but nothing reads

```bash
if [ -f .env ]; then
  for key in $(grep -oE '^[A-Z_][A-Z0-9_]*=' .env | sed 's/=$//'); do
    if ! grep -rq "process\.env\.$key\b\|env\.$key\b" src/ setup/ container/agent-runner/src/ 2>/dev/null; then
      echo "UNUSED: $key"
    fi
  done
fi
```

List unused keys — FLAG, don't auto-remove (user may have set them intentionally for a skill they'll re-add).

### D.3 — Keys newly-required by merged code

Look in the merged `src/config.ts` for `process.env.X` reads with no fallback (i.e., code that would crash or misbehave if the var is absent):

```bash
git diff $BACKUP..HEAD -- src/config.ts | grep '^+' | grep -E 'process\.env\.[A-Z_]+' | head -10
```

Cross-check each new env ref against `.env`; flag anything required that isn't set.

---

## E. Supply-chain policy drift

Per CLAUDE.md's Supply Chain Security section: `minimumReleaseAgeExclude` and `onlyBuiltDependencies` additions require explicit human sign-off. Merging upstream MUST NOT silently accept new entries.

```bash
git diff $BACKUP..HEAD -- pnpm-workspace.yaml package.json \
  | grep -E '^\+' | grep -E 'minimumReleaseAgeExclude|onlyBuiltDependencies|"[a-z].*@[0-9]' | head -20
```

Any added entry under either key → BLOCK. Ask via AskUserQuestion, one question per added entry:

- "Approve — I reviewed this specific version and accept"
- "Revert this entry" → drop the line via an Edit, amend the merge commit (or add a follow-up commit)
- "Abort and rollback the merge" → `git reset --hard $BACKUP`

---

## Final audit report

After running A–E, present a single report:

```
Audit findings
──────────────
A. Silent drops:               [PASS | FLAG (N items)]
B. Container rebuild required: [no  | YES — see Step 9]
C. Risky pending migrations:   [PASS | FLAG (N migrations)]
D. Env var drift:              [PASS | FLAG (N unused / N new-required)]
E. Supply-chain policy:        [PASS | BLOCK (N entries)]
```

Decision rules:

- Any BLOCK → stop here. Require explicit user resolution (approve / revert / rollback) before continuing.
- Only FLAGs → show the details, ask the user whether to proceed or rollback. Default to proceed if the user accepts each flag.
- All PASS → continue silently to Step 7.

Persist the audit verdict (especially B's REBUILD-NEEDED flag) — Step 9's summary needs it to decide whether `./container/build.sh` must run before `systemctl restart`.
