# Mnemon Integration — Operator Manual

Mnemon is a host-side graph fact store for NanoClaw agent groups. Each agent group gets an isolated store (keyed by `agentGroupId`). The agent writes atomic facts; a scheduled task compiles those facts into wiki pages nightly.

---

## Operator runbooks

These three runbooks cover the full operational surface. Reference material (gates, reindex policy, backup/restore, troubleshooting) lives below.

### Runbook 1 — Add mnemon to a new (or existing) agent group

Replay pattern from the Apr-2026 7-group bulk enable. Works for a single group or many.

**When to run:** new agent group created and you want it on mnemon, or an existing group missing the wiki+mnemon stack.

**Prerequisites (verify on host):**
```bash
mnemon --version              # binary present (~/.local/bin or /usr/local/bin)
ollama list | grep nomic      # nomic-embed-text:latest model pulled
systemctl is-active ollama    # ollama service running
crontab -l | grep mnemon      # cron entries present (autopush + backup + collector)
```
If any fails, fix the prereq first. Ollama install: `curl -fsSL https://ollama.com/install.sh | sh && sudo systemctl enable --now ollama && ollama pull nomic-embed-text`.

**Step-by-step (per group):**

1. **Survey state** — what does this group already have?
    ```bash
    g=<folder>     # e.g. axie-dev
    echo "container.json:"; jq '{agentGroupId, skills, mnemon}' "groups/$g/container.json"
    [ -d "groups/$g/wiki" ]    && echo "wiki/: present" || echo "wiki/: MISSING"
    [ -d "groups/$g/sources" ] && echo "sources/: present" || echo "sources/: MISSING"
    ```

2. **Fix prereqs in `container.json` if needed.** The agent group must have `agentGroupId` set and `skills: "all"` (otherwise `mnemon-companion/SKILL.md` won't auto-mount). If either is missing:
    ```bash
    g=<folder>
    cfg="groups/$g/container.json"
    agentId=$(sqlite3 data/v2.db "SELECT id FROM agent_groups WHERE folder='$g';")
    jq --arg id "$agentId" '. + {agentGroupId: $id, skills: "all"}' "$cfg" > "$cfg.tmp" && mv "$cfg.tmp" "$cfg"
    ```

3. **Scaffold wiki + sources** (skip if `wiki/` already exists from a prior `/add-karpathy-llm-wiki` run):
    ```bash
    g=<folder>
    mkdir -p "groups/$g/wiki/entities" "groups/$g/wiki/concepts" "groups/$g/wiki/timelines"
    mkdir -p "groups/$g/sources/articles" "groups/$g/sources/docs" "groups/$g/sources/threads"
    ```
    Then write `groups/$g/wiki/index.md` and `groups/$g/wiki/log.md` (templates: copy any existing group's wiki/index.md and adapt the scope description). And append the wiki+mnemon section to `groups/$g/CLAUDE.local.md` — copy from any other enabled group (e.g. `groups/illysium/CLAUDE.local.md`'s "## Wiki + mnemon — persistent memory layer" block).

4. **Enable mnemon** (writes container.json mnemon block, creates store, schedules synth/gc/reconcile tasks, writes rollout JSON in shadow phase):
    ```bash
    pnpm exec tsx scripts/enable-mnemon.ts <folder>
    ```
    No service restart needed for the new group's first container spawn — `applyMnemonMounts` and `applyMnemonEnv` read `container.json` per spawn.

5. **Create wiki sync repo** (private GitHub repo for Obsidian/teammate access):
    ```bash
    g=<folder>
    gh repo create "davekim917/$g-wiki" --private --description "$g knowledge base — synced from NanoClaw"
    cd "groups/$g/wiki"
    git init -b main
    git remote add origin "https://github.com/davekim917/$g-wiki.git"
    cat > .gitignore <<'EOF'
    .obsidian/workspace*
    .obsidian/cache
    .obsidian/workspaces.json
    .trash/
    EOF
    git add -A
    git -c user.email='YOUR_EMAIL' -c user.name='YOUR_NAME' commit -m "init: empty $g wiki scaffold"
    git push -u origin main
    cd /home/ubuntu/nanoclaw-v2
    ```
    The cron-installed `wiki-autopush.sh` iterates `groups/*/wiki/.git` automatically — no script edit needed.

    For groups under a different org (e.g. `Illysium-ai/illysium-wiki` was used for the Illysium consulting workspace), substitute the org in `gh repo create` and the remote URL.

6. **Verify everything wired up:**
    ```bash
    g=<folder>
    agentId=$(jq -r '.agentGroupId' "groups/$g/container.json")
    echo "rollout entry:"; jq ".[\"$agentId\"]" data/mnemon-rollout.json
    echo "store created:"; mnemon store list | grep "$agentId"
    echo "scheduled tasks:" 
    session=$(sqlite3 data/v2.db "SELECT id FROM sessions WHERE agent_group_id='$agentId' AND status='active' ORDER BY created_at DESC LIMIT 1;")
    sqlite3 "data/v2-sessions/$agentId/$session/inbound.db" "SELECT series_id, status, datetime(process_after) FROM messages_in WHERE kind='task' AND series_id LIKE 'mnemon%';"
    ```
    Expected: rollout entry with `phase: "shadow"` + `enabled_at`; mnemon store ID listed; 3 pending mnemon tasks (synth/gc/reconcile).

7. **(Optional) Clone wiki on Mac for Obsidian access:**
    ```bash
    cd ~/Documents/Vaults/all-wikis
    git clone "https://github.com/davekim917/<folder>-wiki.git" <folder>
    ```
    Reload Obsidian — the new group appears as a top-level folder in the unified vault.

**Bulk enable (multiple groups in one shot):** wrap steps 1-6 in a `for g in main number-drinks ...; do ... done` loop. The 5-group bulk on 2026-04-27 took ~5 minutes total.

---

### Runbook 2 — Graduate a group from Phase 1 (shadow) to Phase 2 (live)

**When to run:** at least 7 days after the group's `enabled_at` timestamp in `data/mnemon-rollout.json`. Phase 2 turns recall on — the agent's responses start being shaped by stored facts.

**Pre-graduation review (always do this first):**

1. **Check telemetry health for the group:**
    ```bash
    g=<folder>
    agentId=$(jq -r '.agentGroupId' "groups/$g/container.json")
    echo "Health record:"; jq ".[\"$agentId\"]" data/mnemon-health.json
    echo "Recent unhealthy events:"; tail -20 "groups/$g/.mnemon-metrics.jsonl" | grep '"event_type":"unhealthy"' || echo "(none — good)"
    echo "Total turns observed:"; grep -c '"event_type":"turn"' "groups/$g/.mnemon-metrics.jsonl"
    echo "Insights stored so far:"; mnemon embed --status --store "$agentId" 2>&1 | grep -E "embedded|total"
    ```

2. **Inspect what the agent has remembered.** Open the wiki (in Obsidian or `cat groups/$g/wiki/log.md`) and scan recent entries. Browse mnemon directly:
    ```bash
    g=<folder>
    agentId=$(jq -r '.agentGroupId' "groups/$g/container.json")
    mnemon recall "" --store "$agentId" --limit 20  # shows recent insights ranked by importance
    ```
    Spot-check: are the facts atomic? Coherent? Free of garbage? If many facts look hallucinated or off-topic, do NOT graduate — investigate why the agent is over-storing.

3. **Run the graduation gate script.** It evaluates 6 gates: hook failure rate < 1%, p95 latency < 200ms, DB growth < 10MB, recall spot-check (manual), visual wiki review (manual), store health = ok. **Fail-closed on missing telemetry** — graduation is refused if data sources are empty/missing.
    ```bash
    pnpm exec tsx scripts/mnemon-phase2.ts <folder>
    ```
    Two manual prompts will appear: "Did the recall spot-check pass?" and "Did the visual wiki review pass?" Answer based on step 2's review.

4. **Outcomes:**
    - **All gates pass** → script writes `phase: "live"` + `graduated_at` to `data/mnemon-rollout.json`. Recall starts injecting on the next container spawn for this group. No service restart needed; `rollout-reader.ts` re-reads on every hook invocation.
    - **One or more gates fail** → script exits non-zero with a list of failing gates. Address the failures, then re-run after another observation window.
    - **`telemetry unavailable —` errors** → metrics pipeline is broken. Check the cron's `logs/mnemon-metrics.log` and `groups/<folder>/.mnemon-metrics.jsonl` first. Don't graduate until telemetry is real.

5. **(Optional) Bulk graduate** if you've reviewed multiple groups together:
    ```bash
    for g in illysium madison-reed main number-drinks axie-dev axis-labs dirt-market; do
      echo "=== $g ==="
      pnpm exec tsx scripts/mnemon-phase2.ts "$g" --skip-visual  # bypass manual prompts (use only if you've pre-reviewed)
    done
    ```

**Kill switch (any phase):** if a group misbehaves after graduation:
```bash
pnpm exec tsx scripts/disable-mnemon.ts <folder>
sudo systemctl restart nanoclaw-v2
```
Removes the mnemon block from container.json, removes the rollout entry, cancels the 3 scheduled tasks. **Store data is preserved** at `~/.mnemon/data/<store>/` — re-enabling later resumes from the same fact graph.

---

### Runbook 3 — Routine health checks

**Daily (~30 sec):**
```bash
# Any unhealthy events in the last hour?
jq 'to_entries[] | select(.value.phase == "unhealthy") | {store: .key, events: .value.recent_unhealthy_events}' data/mnemon-health.json
# Should be empty. If anything shows up, drill in: tail -50 "groups/<group-with-issue>/.mnemon-metrics.jsonl"
```

**Weekly (~5 min):**
```bash
# Backup ran nightly?
ls -lt ~/backups/.mnemon-* | head -7
# Latest should be from today/yesterday; total count under 11 (7 daily + 4 weekly retention)

# Wiki autopush working?
tail -20 logs/wiki-autopush.log

# Storage growth trends per group
for s in $(mnemon store list 2>&1 | awk '/^  ag-/ {print $1}'); do
  size_mb=$(du -sm ~/.mnemon/data/"$s"/ 2>/dev/null | awk '{print $1}')
  insights=$(mnemon embed --status --store "$s" 2>&1 | jq -r '.total_insights // 0')
  echo "  $s: ${size_mb}MB, $insights insights"
done

# Phase 2 candidates (groups in shadow > 7 days)
jq -r 'to_entries[] | select(.value.phase == "shadow") | "\(.key): enabled \(.value.enabled_at)"' data/mnemon-rollout.json
```

**Monthly (~10 min):**
- Spot-check 3-5 wiki pages in Obsidian per active group. Look for: contradictions, stale entries, orphan pages, gaps.
- Review `crontab -l` and `logs/mnemon-*.log` for silent failures.
- Verify `mnemon` binary version against `MNEMON_VERSION` ARG in `container/Dockerfile`. If upstream has a new release, decide whether to bump (see "## Embedding model reindex" and "## Schema migration" reference sections below for migration discipline).

**Failure modes to watch for** (see "## Troubleshooting" reference section below for full diagnostics):
- `event_type: "unhealthy"` events with `reason: "ollama-unavailable"` → Ollama service stopped; recall degrades to keyword-only
- `event_type: "unhealthy"` with `reason: "schema-mismatch"` → mnemon binary version diverged from store schema; do NOT bump binary without running the migration drill
- `event_type: "unhealthy"` with `reason: "flock-timeout"` → stale write lock; check for crashed containers or remove `~/.mnemon/data/<store>/.write.lock` manually after confirming no live writers
- Wiki autopush log shows repeated push failures → likely auth issue; check `gh auth status`

---



### Step 1: Enable

```bash
pnpm exec tsx scripts/enable-mnemon.ts <group-folder>
```

This script:
- Verifies `mnemon` binary is on host PATH
- Creates the store on disk via `mnemon store create --store <agentGroupId>`
- Writes `data/mnemon-rollout.json` with `phase: "shadow"` for the store
- Updates `groups/<folder>/container.json` with `"mnemon": { "enabled": true, "embeddings": true }`
- Schedules three recurring tasks in the central DB:
  - `mnemon-synth-<store>` — daily 03:00 UTC: synthesise wiki pages from mnemon facts
  - `mnemon-gc-<store>` — weekly Sunday 04:00 UTC: garbage-collect stale facts
  - `mnemon-reconcile-<store>` — weekly Sunday 05:00 UTC: cross-check mnemon entity graph vs wiki pages

### Step 2: Restart

```bash
sudo systemctl restart nanoclaw-v2
```

The host re-reads `container.json` on the next container spawn. The running Illysium container (if any) is respawned on its next wake.

### Step 3: Phase 1 — Shadow

During Phase 1 the mnemon wrapper at `/usr/local/bin/mnemon` inside the container:
- Passes `remember` writes through to the real mnemon binary (facts accumulate)
- Returns `{"results":[]}` for all `recall` calls (no read-path impact on agent responses)

This phase runs for at least one week to build initial fact density before enabling recall.

Monitor with:

```bash
pnpm exec tsx scripts/mnemon-metrics.ts --store <agentGroupId> --summary
```

### Step 4: Graduate to Phase 2

Once shadow-phase fact density looks healthy:

```bash
pnpm exec tsx scripts/mnemon-phase2.ts <group-folder>
```

This writes `phase: "live"` into `data/mnemon-rollout.json` for the store. The wrapper in the running container picks up the change on the next turn (the rollout file is mounted RO at `/workspace/agent/.mnemon-rollout.json` — no container restart needed).

## Phase 2 graduation gates

Before running `mnemon-phase2.ts`, verify:

| Gate | Check |
|---|---|
| Shadow recall returns empty | `docker exec <container> mnemon recall "test" --store $STORE` → `{"results":[]}` |
| Facts accumulating | `mnemon status --store <id>` shows non-zero `fact_count` |
| No write errors in logs | `grep mnemon logs/nanoclaw.error.log` — no repeated failures |
| Ollama embed endpoint reachable | `curl -s http://localhost:11434/api/version` returns version JSON |
| Metrics collector producing rows | `ls -la data/mnemon-metrics/stores/<store>.jsonl` — file exists, non-zero |

---

## Embedding model reindex

Embeddings are generated by `nomic-embed-text` via Ollama at `localhost:11434`. When the model digest changes (e.g. after `ollama pull nomic-embed-text` brings a new version):

1. Verify the new digest:
   ```bash
   ollama show nomic-embed-text --modelfile | grep FROM
   ```

2. For each enabled store, reindex:
   ```bash
   mnemon embed --store <agentGroupId> --reindex
   ```

3. Verify recall quality with spot-checks:
   ```bash
   mnemon recall "XZO tenant isolation" --store <agentGroupId>
   ```
   Expect ranked results matching known facts. If results are empty or nonsensical, the reindex may have failed — check `mnemon status --store <id>` for error details.

4. Run the metrics collector after reindex to capture the updated status:
   ```bash
   pnpm exec tsx scripts/mnemon-metrics-collector.ts
   ```

Note: embedding quality degrades silently if the model changes without reindex. Schedule reindex checks when pulling model updates.

---

## Deletion and reconciliation workflow

### Deleting a fact

When a fact in mnemon is wrong or stale:

```bash
# Find the fact ID
mnemon recall "wrong fact keywords" --store <agentGroupId>

# Soft-delete by ID
mnemon forget <fact-id> --store <agentGroupId>
```

`mnemon forget` is a soft-delete — the fact is marked deleted and excluded from recall, but remains in the DB for audit purposes.

### Wiki pages referencing deleted facts

After deletion, wiki pages may still reference the removed entity. The weekly reconcile task (`task-mnemon-wiki-reconcile`) cross-checks the entity graph and flags affected pages. Timing:

- Deletion: immediate (next `recall` excludes the fact)
- Wiki flags: next Sunday reconcile pass (05:00 UTC)
- Operator decision: required before any wiki page is removed

To trigger an immediate reconcile (out of band):

1. Open a session with the agent group.
2. Ask the agent: "Run an immediate mnemon-wiki reconcile."
3. Agent runs the reconcile prompt and reports flagged pages.

Do not delete wiki pages without a reconcile pass — a page may reference multiple entities, only one of which was deleted.

---

## Backup and restore

### Nightly backup (automated)

Configured as a host cron job. The script:

```bash
bash scripts/mnemon-backup.sh
```

Backs up each store's `~/.mnemon/data/<store>/mnemon.db` using `sqlite3 .backup` (online, consistent). Retention: 7 daily + 4 weekly (Sunday) snapshots.

To add the cron entry:

```
0 2 * * * cd /home/ubuntu/nanoclaw-v2 && bash scripts/mnemon-backup.sh >> logs/mnemon-backup.log 2>&1
```

### Manual backup

```bash
bash scripts/mnemon-backup.sh
# Output: ~/backups/.mnemon-YYYY-MM-DD/<store>.db
```

### Restore drill

Run this drill after initial rollout and after any significant data event to verify the restore path works.

**Day-1 restore drill steps:**

1. Identify a recent backup:
   ```bash
   ls ~/backups/ | grep .mnemon | sort | tail -3
   ```

2. Stop the agent container (prevents writes during restore):
   ```bash
   docker stop nanoclaw-<session-id>   # or let it idle-timeout naturally
   ```

3. Restore a specific store from a dated backup:
   ```bash
   bash scripts/mnemon-restore.sh <YYYY-MM-DD> <agentGroupId>
   ```
   The script moves the live DB aside to `mnemon.db.pre-restore-<epoch>` before copying in the backup.

4. Verify the restore:
   ```bash
   mnemon status --store <agentGroupId>
   mnemon recall "smoke test" --store <agentGroupId>
   ```

5. Restart the service so the next container spawn uses the restored DB:
   ```bash
   sudo systemctl restart nanoclaw-v2
   ```

6. Confirm recall works in the live container on next wake.

---

## Troubleshooting

### Wrapper bypass detection

The mnemon binary inside the container should be the Phase 1/2 wrapper, not the real binary:

```bash
docker exec <container> which mnemon
# Expected: /usr/local/bin/mnemon (the wrapper)

docker exec <container> mnemon --version
# Should return the pinned wrapper version, not the real mnemon version
```

If `/usr/local/bin/mnemon` is the real binary (wrapper not installed), recall will run in Phase 1 groups — rebuild the image:

```bash
./container/build.sh
sudo systemctl restart nanoclaw-v2
```

### Lock contention

Mnemon uses a host-side flock for write serialization (workaround for missing `busy_timeout` in mnemon's DSN). If you see slow writes or lock errors:

```bash
# Check if a stale lockfile is present
ls -la ~/.mnemon/data/<store>/.write.lock

# If the container that held the lock is gone, remove the stale lock
rm ~/.mnemon/data/<store>/.write.lock
```

High host system load can also cause lock timeouts — check `top` / `uptime`.

### Ollama down

When the Ollama embedding endpoint is unreachable:
- `mnemon remember` still succeeds (text stored, embedding queued or skipped)
- `mnemon recall` degrades to keyword-only search (no vector similarity ranking)
- The container hook classifies the failure as `recoverable` (not `blocking`) and emits a `console.warn` line with prefix `[mnemon] <hook> recoverable: ollama-unavailable` (visible in container logs)
- The host-side metrics collector classifies a store as `unhealthy` only on `event_type: "unhealthy"` rows in the per-group turn metrics file. Recoverable WARN events are NOT promoted to unhealthy. Operator monitors the warn-rate signal via container logs, not via `data/mnemon-health.json`.

Ollama being down is non-blocking per design (W1/SF6). Restart Ollama:

```bash
systemctl --user start ollama
# or
ollama serve &
```

Verify:

```bash
curl -s http://localhost:11434/api/version
```

### Schema migration

When `MNEMON_VERSION` bumps in the Dockerfile, the wrapper may detect a schema mismatch on startup. The `/update-container` audit handles migration during the next container rebuild. To force:

```bash
./container/build.sh
sudo systemctl restart nanoclaw-v2
```

Check the agent logs for migration output:

```bash
journalctl --user -u nanoclaw-v2 -n 100 | grep mnemon
```

### Metrics collector shows no rows

If `data/mnemon-metrics/stores/<store>.jsonl` is empty after a collector run:
1. Verify `mnemon` binary is on host PATH: `which mnemon`
2. Verify the store exists: `mnemon status --store <agentGroupId>`
3. Check `data/mnemon-rollout.json` — the store should appear with `"enabled_at"` set
4. Run collector with verbose output:
   ```bash
   pnpm exec tsx scripts/mnemon-metrics-collector.ts
   ```

---

## Upstream issues (tracked)

These are known gaps in mnemon itself that NanoClaw works around:

| Issue | Workaround | Status |
|---|---|---|
| `busy_timeout` not settable via DSN | Host-side flock (`~/.mnemon/data/<store>/.write.lock`) serializes writes | Requested upstream; not yet in mnemon |
| No real `PreCompact` handler | Dropped from scope — compaction hook would synthesise wiki pages before context window truncates, but mnemon has no stable hook point for this yet | Tracking upstream issue |
