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

**After bumping CLASSIFIER_VERSION / PROMPT_VERSION:**

The chat-stream sweep advances `scan_cursor` past each successfully-classified pair's `sent_at` timestamp. On subsequent sweeps it only reads rows AFTER the cursor — so when `CLASSIFIER_VERSION` or `PROMPT_VERSION` is bumped (e.g., to roll out a smarter grounding prompt), already-classified pairs stay under the OLD version and never get re-extracted. Reset watermarks to force re-classification of historical chat pairs.

**Required runbook (in order):**

```bash
# 1. Stop the daemon FIRST. An in-flight sweep can re-INSERT a watermark
#    row at the in-flight pair's lastSentAt mid-cleanup, silently undoing
#    the replay (ultrareview bug_012).
sudo systemctl stop nanoclaw-memory-daemon

# 2. Dry-run (default): preview which groups would be reset
pnpm exec tsx scripts/reset-classifier-watermarks.ts

# 3. Apply: actually delete watermarks for all groups (triggers re-classify)
pnpm exec tsx scripts/reset-classifier-watermarks.ts --apply

# 4. Restart the daemon so the next sweep picks up cleared watermarks
sudo systemctl start nanoclaw-memory-daemon
```

Single-group variants:

```bash
pnpm exec tsx scripts/reset-classifier-watermarks.ts <agentGroupId>          # dry-run
pnpm exec tsx scripts/reset-classifier-watermarks.ts <agentGroupId> --apply  # execute
```

**`--include-poisoned`** (ultrareview bug_013): without this flag, `dead_letters` rows are preserved. By design, `classifier.ts` short-circuits any pair with `poisoned_at IS NOT NULL` — so a pair that got poisoned under the OLD prompt (e.g., 3 strikes from `validateFactsAgainstSource` dropping all confabulated facts) will NOT retry under the new prompt, defeating the watermark reset for that pair. When the goal is "reclassify EVERYTHING under the new prompt", add `--include-poisoned` to also clear poisoned rows:

```bash
pnpm exec tsx scripts/reset-classifier-watermarks.ts --apply --include-poisoned
```

The script preserves `processed_pairs` (the PK includes both versions, so v1 and v2 rows coexist). The next 60s sweep after restart replays the archive end-to-end for affected groups. Expect a one-time spike in Anthropic/Codex API calls proportional to historical chat volume — plan cost before running on busy groups. Old-version facts in `~/.mnemon/data/<agentGroupId>/` are NOT deleted; if the old prompt produced confabulations (e.g. "WG → William Grant" before the grounding-discipline bump), use `mnemon forget <fact-id>` to remove specific facts after the new sweep adds correct versions.

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
- `scripts/reset-classifier-watermarks.ts` — re-classify historical pairs after a CLASSIFIER_VERSION/PROMPT_VERSION bump
- `data/memory-health.json` — per-group health snapshot
- `data/mnemon-ingest.db` — watermarks + dead_letters
- `logs/memory-daemon.log` — daemon stdout
- `logs/memory-daemon.error.log` — daemon stderr
- `data/systemd/nanoclaw-memory-daemon.service` — systemd unit (copy to `/etc/systemd/system/` to install)
- `data/systemd/templates/ollama-keep-alive.conf` — drop-in pinning Ollama embed model (operator-installed; see Operator Configuration below)
- `data/systemd/templates/memory-daemon-backend.conf.example` — drop-in for switching classifier backend (operator-customized; see Operator Configuration below)

## Operator Configuration

Two systemd drop-ins live as templates in `data/systemd/templates/`. They're operator-installed because they hold per-host operational choices, not feature defaults.

### Pin the Ollama embed model (recommended)

Without this, Ollama unloads `nomic-embed-text` after 5 minutes of idle and the next mnemon recall catches a 3-5s cold load that times out the recall path. Pinning is essentially free (~565MB RAM):

```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo cp data/systemd/templates/ollama-keep-alive.conf \
  /etc/systemd/system/ollama.service.d/keep-alive.conf
sudo systemctl daemon-reload && sudo systemctl restart ollama

# Optional one-time warmup
curl -s http://127.0.0.1:11434/api/embeddings \
  -d '{"model":"nomic-embed-text","prompt":"warmup"}' >/dev/null

# Verify (expires_at year 2318 = "never" sentinel)
curl -s http://127.0.0.1:11434/api/ps | python3 -m json.tool
```

### Switch the classifier backend (optional)

Default (no drop-in) is Anthropic Haiku 4.5. To switch to a smarter Anthropic model, an entirely different provider, or a different effort level:

```bash
sudo mkdir -p /etc/systemd/system/nanoclaw-memory-daemon.service.d
sudo cp data/systemd/templates/memory-daemon-backend.conf.example \
  /etc/systemd/system/nanoclaw-memory-daemon.service.d/backend.conf

# Edit /etc/.../backend.conf to your chosen backend, e.g.:
#   anthropic:sonnet-4-6:high   (paid per-token, extended thinking)
#   codex:gpt-5.5:medium        (codex subscription, uncorrelated failure mode vs. claude synth)
#   anthropic:haiku-4-5:default (the default)

sudo systemctl daemon-reload
sudo systemctl restart nanoclaw-memory-daemon

# Verify env loaded
systemctl show nanoclaw-memory-daemon -p Environment --no-pager
```

The format is `<provider>:<model>:<effort>`:
- `provider`: `anthropic` | `codex`
- `model`: short alias mapped per-backend (`haiku-4-5`, `sonnet-4-6`, `opus-4-7` for Anthropic; `gpt-5.5`, `gpt-5-codex`, etc. for Codex)
- `effort`: `default` | `low` | `medium` | `high`

If using `codex` and the binary isn't on the daemon's narrow PATH (`/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin`), set `CODEX_BIN=/absolute/path/to/codex` in the same drop-in. The example file shows both env vars.

To revert to default:

```bash
sudo rm /etc/systemd/system/nanoclaw-memory-daemon.service.d/backend.conf
sudo systemctl daemon-reload && sudo systemctl restart nanoclaw-memory-daemon
```
