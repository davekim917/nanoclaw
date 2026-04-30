# Memory Integration — Operator Manual

The memory system gives NanoClaw agent groups a persistent fact store and synthesised wiki knowledge base.

---

## Architecture

Three-layer pipeline:

```
Raw sources (inbox/, articles/, docs/, transcripts/, clips/, media/)
    ↓ extraction (source-ingestor worker)
mnemon graph (~/.mnemon/data/<agentGroupId>/)
    ↓ synthesise task (daily 03:00 UTC)
Wiki pages (groups/<g>/wiki/)
```

**Three core ops:**

| Op | When | Effect |
|---|---|---|
| **extract** | On file drop into sources/ or chat-stream classifier match | Facts written to mnemon store |
| **synthesise** | Daily cron (03:00 UTC) via scheduled task | Wiki pages updated from current fact graph |
| **recall** | On agent turn (via MCP tool) | Ranked facts injected into context |

**Host daemon** (`nanoclaw-memory-daemon`, `dist/memory-daemon/index.js`): runs as a systemd service alongside `nanoclaw-v2`. Watches enabled groups' `sources/inbox/` directories via inotify and classifies chat-stream turns. Reads `container.json`'s `memory.enabled` field per group on each 60s sweep.

**MemoryConfig interface** (from `src/container-config.ts`): `{ enabled: boolean }`. Set by `scripts/enable-memory.ts`, cleared by `scripts/disable-memory.ts`. Host reads this at container spawn time to apply mnemon mounts and env vars.

---

## Enable Runbook

Enable memory for a group:

```bash
pnpm exec tsx scripts/enable-memory.ts <group-folder>
# e.g.
pnpm exec tsx scripts/enable-memory.ts illysium
```

What happens:
1. `groups/<g>/container.json` gets `memory.enabled = true` (atomic write via `.tmp` + rename).
2. Seven `groups/<g>/sources/` subdirs created: `inbox/`, `articles/`, `docs/`, `transcripts/`, `clips/`, `media/`, `processed/`. Existing dirs are preserved.
3. `mnemon store create <agentGroupId>` runs — "already exists" errors are silently swallowed.
4. A daily synthesise task is scheduled (cron `0 3 * * *`, seriesId `memory-synth-<agentGroupId>`). Idempotent — re-running updates the existing row instead of inserting a duplicate.

No service restart needed. The daemon picks up newly enabled groups on its next 60s sweep.

**Prerequisites:** run `bash scripts/verify-memory-prereqs.sh` first to confirm Ollama is active, nomic-embed-text is pulled, mnemon binary is present, disk space is sufficient, inotify watches are configured, and sqlite3 is in PATH.

---

## Disable Runbook

Disable memory for a group:

```bash
pnpm exec tsx scripts/disable-memory.ts <group-folder>
# e.g.
pnpm exec tsx scripts/disable-memory.ts illysium
```

What happens:
1. `memory` block removed from `groups/<g>/container.json` (atomic write).
2. Active synthesise task cancelled from the group's session `inbound.db`.
3. `watermarks` rows for this `agentGroupId` removed from `data/mnemon-ingest.db`.
4. `dead_letters` rows in `data/mnemon-ingest.db` are **preserved** for operator review.
5. `~/.mnemon/data/<agentGroupId>/` is **preserved** for operator audit.

No service restart needed. The daemon stops watching this group on its next 60s sweep.

Idempotent: running twice on an already-disabled group exits cleanly.

---

## Daily / Weekly / Monthly Operator Runbook

**Daily (~30 sec):**

```bash
# Check memory-health.json for any alarm conditions
cat data/memory-health.json | jq '.groups | to_entries[] | select(.value.recallEmptyRate24h > 0.5 or .value.classifierFails24h > 10)'
# Should return empty. Any hits need investigation.

# Scan daemon error log for unexpected failures
tail -20 logs/memory-daemon.error.log
```

**Weekly (~5 min):**

```bash
# Review dead_letters for poisoned items
sqlite3 data/mnemon-ingest.db "SELECT agent_group_id, item_type, failure_count, last_error FROM dead_letters WHERE poisoned_at IS NOT NULL ORDER BY poisoned_at DESC LIMIT 20;"

# Check wiki autopush status
tail -20 logs/wiki-autopush.log  # should show recent pushes with exit 0

# Verify daemon log has no repeated errors
grep -c "ERROR" logs/memory-daemon.log || true
```

**Monthly (~10 min):**

```bash
# Spot-check mnemon store sizes
for store in $(ls ~/.mnemon/data/ 2>/dev/null); do
  echo "$store: $(du -sh ~/.mnemon/data/$store/ 2>/dev/null | awk '{print $1}')"
done

# Verify mnemon binary version matches Dockerfile
mnemon --version
grep 'MNEMON_VERSION' container/Dockerfile

# Review wiki pages in Obsidian or via cat for any enabled group
# Look for: contradictions, stale facts, orphan pages

# Check daemon log for silent failures
grep "ERROR\|WARN" logs/memory-daemon.log | tail -50
```

---

## Troubleshooting

**`recallEmptyRate24h` spikes in `data/memory-health.json`:**

High empty-recall rate usually means the classifier extraction pipeline isn't writing facts to the mnemon store. Check:
1. `data/memory-health.json` — look at `classifierFails24h` for the affected group.
2. `logs/memory-daemon.log` — search for `classifier` errors near the spike time.
3. Verify mnemon store is reachable: `mnemon store list | grep <agentGroupId>`.
4. Check inotify watcher is active for this group: `inotifywait -m groups/<g>/sources/inbox/` (Ctrl-C to exit; if it hangs immediately the watcher path doesn't exist).

**Classifier failures (`classifierFails24h` elevated):**

```bash
# Check data/memory-health.json for per-group classifier stats
cat data/memory-health.json | jq '.groups["<agentGroupId>"]'

# Tail daemon log for classifier error context
grep -A3 "classifier" logs/memory-daemon.error.log | tail -40
```

Common causes: Ollama is down (recall degrades to keyword-only — non-blocking), mnemon store write lock stale, or schema mismatch after mnemon binary upgrade.

**Inotify watcher debugging:**

```bash
# Verify watch limit
cat /proc/sys/fs/inotify/max_user_watches

# Test watcher on a specific group's inbox
inotifywait -m groups/<g>/sources/inbox/
# Drop a file in another terminal: touch groups/<g>/sources/inbox/test.txt
# Should see: groups/<g>/sources/inbox/ CREATE test.txt

# Increase watch limit if exhausted
echo 65536 | sudo tee /proc/sys/fs/inotify/max_user_watches
```

**Daemon not starting:**

```bash
# Check systemd status
sudo systemctl status nanoclaw-memory-daemon

# View recent logs
sudo journalctl -u nanoclaw-memory-daemon -n 50

# Verify compiled artefact exists
ls dist/memory-daemon/index.js  # must exist — run pnpm run build if missing
```

---

## Rollback

**Per-group:** disable memory for a specific group without affecting others:

```bash
pnpm exec tsx scripts/disable-memory.ts <group-folder>
```

Data at `~/.mnemon/data/<agentGroupId>/` is preserved. Re-enabling later resumes from the same fact graph.

**Full-system removal:** stop and disable the daemon entirely:

```bash
sudo systemctl disable --now nanoclaw-memory-daemon
```

Then disable per-group if needed:

```bash
for g in groups/*/; do
  folder=$(basename "$g")
  pnpm exec tsx scripts/disable-memory.ts "$folder" 2>/dev/null || true
done
```

Manual cleanup of mnemon stores (irreversible — do only if you want to wipe all stored facts):

```bash
rm -rf ~/.mnemon/data/
```

Relevant paths:
- `scripts/enable-memory.ts` — enable per group
- `scripts/disable-memory.ts` — disable per group
- `scripts/verify-memory-prereqs.sh` — check prereqs before enabling
- `data/memory-health.json` — per-group health snapshot
- `data/mnemon-ingest.db` — watermarks + dead_letters
- `logs/memory-daemon.log` — daemon stdout
- `logs/memory-daemon.error.log` — daemon stderr
- `data/systemd/nanoclaw-memory-daemon.service` — systemd unit (copy to `/etc/systemd/system/` to install)
