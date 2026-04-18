# Cutover Runbook (Phase 0 + Phase 4)

Single-event runbook for flipping from v1 to v2 in-place. Phase 0
(data import) folds into the Phase 4 freeze window so there's no
stale-data drift between export and use.

## Pre-checks (run the day before)

Verify everything's green before committing to a cutover window:

1. **v2 service is healthy** under systemd:
   ```bash
   sudo systemctl is-active nanoclaw-v2
   sudo journalctl -u nanoclaw-v2 --since "1 hour ago" | grep -i error
   ```
2. **v2 image has latest SDK + all 5.x changes baked in**:
   ```bash
   docker inspect nanoclaw-agent:v2 --format '{{.Created}}'
   # Should be after the last `./container/build.sh v2` run
   ```
3. **Phase 3 parity checklist** — at minimum, the pre-cutover sections
   should all be green (`docs/MIGRATION_FROM_V1.md` → Parity Checklist).
4. **Backup v1 data**:
   ```bash
   cp /home/ubuntu/nanoclaw/store/messages.db \
      /home/ubuntu/nanoclaw/store/messages.db.pre-cutover.$(date -u +%Y%m%d)
   cp -r /home/ubuntu/nanoclaw/groups \
      /home/ubuntu/nanoclaw/groups.pre-cutover.$(date -u +%Y%m%d)
   ```
5. **Dry-run the memory import** so the plan is known:
   ```bash
   cd /home/ubuntu/nanoclaw-v2
   npx tsx scripts/import-v1-memories.ts
   ```
   Note which v1 folders don't yet have a v2 agent group — either wire
   them now (step 4 below) or decide to retire them.

## Cutover sequence

Expect ~10 minutes of downtime if everything goes right.

### 1. Set up missing v2 agent groups (skipped if you did this already)

For each v1 folder you want to keep, ensure a v2 `agent_groups` row
exists with the matching folder. Either:
- Use `/init-first-agent` per group from within v2 once it's primary,
  OR
- Create directly via `scripts/wire-main-v2.ts`-style script ahead
  of time (preferred — creates the row + CLAUDE.md scaffolding).

Current gap, per the dry-run: `illysium`, `personal`, `sunday`,
`axis-labs`, `axie-dev`, `madison-reed`, `number-drinks`. Skip any
that are retired.

### 2. Rename `illysium-v2` → `illysium` (and `main` stays `main`)

The v2-side agent group named `illysium-v2` was a migration-window
identity. At cutover it takes over from v1's `illysium`.

```bash
# In v2 DB:
sqlite3 /home/ubuntu/nanoclaw-v2/data/v2.db "
  UPDATE agent_groups SET folder='illysium', name='illie' WHERE folder='illysium-v2';
"
# On disk:
mv /home/ubuntu/nanoclaw-v2/groups/illysium-v2 /home/ubuntu/nanoclaw-v2/groups/illysium
# Per-session overlays (keep same agent_group_id):
# (no filesystem move needed — session dirs are keyed by agent_group.id not folder)
```

Also update `groups/illysium/container.json` if `githubTokenEnv` is
set to a migration-window alias (kept it as `GITHUB_TOKEN_ILLYSIUM` —
that's still correct post-rename).

### 3. Stop v1

```bash
sudo systemctl stop nanoclaw         # systemd (Linux)
# or: launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist  (macOS)
```

Verify stopped:
```bash
sudo systemctl is-active nanoclaw   # expect: inactive
docker ps --filter name=nanoclaw-   | grep -v nanoclaw-v2-   # no v1 agent containers
```

### 4. Run the memory import

```bash
cd /home/ubuntu/nanoclaw-v2
# Example — adjust the --map list based on your dry-run output:
npx tsx scripts/import-v1-memories.ts \
  --map illysium=illysium \
  --map main=main \
  --map personal=personal \
  --map sunday=sunday \
  --map axis-labs=axis-labs \
  --map axie-dev=axie-dev \
  --map madison-reed=madison-reed \
  --map number-drinks=number-drinks \
  --commit
```

Verify:
```bash
sqlite3 data/v2.db "SELECT agent_group_id, COUNT(*) FROM memories GROUP BY agent_group_id"
```

### 5. Hand off the bot tokens

The `.env` already has the correct tokens — v1 and v2 share the
same bot identities. Just make sure:

- `DISCORD_BOT_TOKEN` — unchanged; v2 will connect as the same bot.
- `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` (+ `_ILLYSIUM`
  variants) — unchanged.
- Discord slash commands: set `ENABLE_DISCORD_SLASH_COMMANDS=1` in
  `.env` now that v1 isn't competing for the Gateway.

### 6. Point the Slack webhook URL at v2

Slack webhook URLs are workspace-configured in the Slack app admin.
v1 and v2 both listen on port 3000 path `/webhook/slack-<suffix>`,
so:
- If they're on the same host (typical), the URL doesn't change —
  just make sure v2 is the one listening on 3000. (v1 stopped in
  step 3 above releases the port.)
- If you use Cloudflare Tunnel (per session history), the tunnel
  config is already pointed at localhost:3000. No change.

### 7. Start (or restart) v2

```bash
sudo systemctl restart nanoclaw-v2
sleep 5
sudo systemctl is-active nanoclaw-v2   # expect: active
tail -30 /home/ubuntu/nanoclaw-v2/logs/nanoclaw.log
```

Expect to see: channel adapters started (discord + slack-<suffix>),
Discord slash commands registered (`ENABLE_DISCORD_SLASH_COMMANDS=1`),
NanoClaw v2 running.

### 8. Smoke test

From Slack (Illysium): `@illie are you alive?`
From Discord (main): `@illie (or Axie) are you alive?`

Agent should respond in each channel. Then run one deeper test:
`@illie what can you do?` — should call `get_capabilities` and return
an accurate list of plugins/credentials/channels.

### 9. Monitor for 48 hours

Leave v1 completely stopped but do NOT delete anything. If something
breaks, rollback is:
```bash
sudo systemctl stop nanoclaw-v2
sudo systemctl start nanoclaw
# v1 comes back up with its original data intact
```

### 10. After 2 weeks without rollback, clean up

```bash
# Disable v1 service so it can't accidentally start
sudo systemctl disable nanoclaw
# Rename v1 dir so it's obvious the directory is retired
mv /home/ubuntu/nanoclaw /home/ubuntu/nanoclaw.retired-<date>
# Optionally nuke v1 containers image:
docker rmi nanoclaw-agent:latest
```

## What to NOT migrate

Per `docs/MIGRATION_FROM_V1.md` "What does NOT migrate":
- v1 message history (`messages` table) — v2 uses per-session inbound/outbound DBs, different schema
- v1 sessions table (v2 has its own)
- v1 thread_metadata (v2 session model replaces)
- v1 ship_log (v2 uses archive + memories for retrospective lookup)
- v1 backlog (see `docs/DAILY_DIGEST.md` — not ported)

v1 data stays where it is for audit / rollback. Nothing cleans it up.

## Rollback decision tree

| Symptom | Action |
|---|---|
| v2 doesn't start | `systemctl start nanoclaw`, debug v2 offline |
| v2 starts but agents don't respond | Check OneCLI secret assignments for agent groups; check `/home/ubuntu/nanoclaw-v2/logs/nanoclaw.error.log` |
| Agent responds but tools fail | Check `get_capabilities` — likely missing credential mount; re-run `sudo systemctl restart nanoclaw-v2` after fixing env |
| Multi-hour outage with no clear fix | Roll back: `sudo systemctl stop nanoclaw-v2 && sudo systemctl start nanoclaw`; file bug, retry next window |

## Post-cutover cleanup tasks

Not time-sensitive; do over the following week:

- [ ] Delete v2 `illysium-v2` bot token / Slack app if you made a
      second one for side-by-side testing.
- [ ] Delete the v2-side `Axie-2` Discord bot if applicable (the real
      Axie identity takes over).
- [ ] Per-group `container.json` — audit `githubTokenEnv` overrides;
      drop any that are no longer needed now that folder names match
      the `GITHUB_TOKEN_<FOLDER>` convention directly.
- [ ] Archive the migration docs: `docs/PHASE_5_0_INFRA_AUDIT.md`,
      `docs/PHASE_2_11_GIT_WORKTREES.md` can move to `docs/archive/`
      once their subjects are no longer active work.
