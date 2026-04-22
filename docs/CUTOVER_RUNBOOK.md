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
3. **v2 image runs as UID 1001** (matches host `ubuntu` user — prerequisite
   for Claude Code auto-memory + autodream writes to succeed; see the
   `fix(container): remap node UID` commit):
   ```bash
   docker run --rm --entrypoint id nanoclaw-agent:v2
   # Expect: uid=1001(node) gid=1001(node)
   ```
   If this reports `uid=1000`, rebuild: `./container/build.sh v2`.
4. **Phase 3 parity checklist** — at minimum, the pre-cutover sections
   should all be green (`docs/MIGRATION_FROM_V1.md` → Parity Checklist).
5. **Backup v1 data**:
   ```bash
   cp /home/ubuntu/nanoclaw/store/messages.db \
      /home/ubuntu/nanoclaw/store/messages.db.pre-cutover.$(date -u +%Y%m%d)
   cp -r /home/ubuntu/nanoclaw/groups \
      /home/ubuntu/nanoclaw/groups.pre-cutover.$(date -u +%Y%m%d)
   ```
6. **Dry-run both memory imports** so the plan is known:
   ```bash
   cd /home/ubuntu/nanoclaw-v2
   npx tsx scripts/import-v1-memories.ts        # SQLite memories table
   npx tsx scripts/import-v1-claude-memory.ts   # Claude Code auto-memory
   ```
   Note which v1 folders don't yet have a v2 agent group — either wire
   them now (step 4 below) or decide to retire them. Both importers use
   the same `--map` syntax and must be given the same map at commit time.

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

### 4b. Import v1 Claude Code auto-memory

Step 4 above imports the explicit `memories` MCP-tool rows. Claude Code
*also* maintains its own auto-memory (a `MEMORY.md` + per-topic notes)
under each group's `.claude/projects/<cwd-hash>/memory/`. That data is
separate from the SQLite table and needs its own import.

Dry-run first — lists each v1 group that has auto-memory to copy:

```bash
cd /home/ubuntu/nanoclaw-v2
npx tsx scripts/import-v1-claude-memory.ts
```

Then commit with the same `--map` list as step 4 (add any v2-side
folder remaps):

```bash
npx tsx scripts/import-v1-claude-memory.ts \
  --map illysium=illysium \
  --map main=main \
  --map madison-reed=madison-reed \
  --map number-drinks=number-drinks \
  --commit
```

The script:
- Copies v1's `-workspace-group/memory/*` → v2's `-workspace-agent/memory/*`
  (the project-hash differs because v1's SDK cwd was `/workspace/group`
  and v2's is `/workspace/agent` — same content, different filename).
- Backs up any existing v2 file to `<name>.pre-import` before overwrite.
  v2 auto-memory was frozen Apr 17–present due to the UID-remap bug, so
  v2's existing files are essentially empty and overwrite is safe, but
  the backup gives a trivial rollback path.
- `chown -R 1001:1001` the target `.claude-shared/` so the post-UID-remap
  container can write new memories into the dirs. Uses `sudo -n` if not
  already privileged; logs a warning if it can't escalate.

Verify:
```bash
ls -lt /home/ubuntu/nanoclaw-v2/data/v2-sessions/<ag-id>/.claude-shared/projects/-workspace-agent/memory/ | head
```

### 5. Hand off the bot tokens + channel-policy env

The `.env` already has the correct tokens — v1 and v2 share the
same bot identities. Just make sure:

- `DISCORD_BOT_TOKEN` — unchanged; v2 will connect as the same bot.
- `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` (+ `_ILLYSIUM`
  variants) — unchanged.
- Discord slash commands: set `ENABLE_DISCORD_SLASH_COMMANDS=1` in
  `.env` now that v1 isn't competing for the Gateway.

Channel auto-wire defaults (already in `.env` for `slack-illysium`;
add entries for other channel-types as needed):

```bash
# Per channel_type (uppercased, dashes → underscores):
NANOCLAW_DEFAULT_AGENT_GROUP_SLACK_ILLYSIUM=illysium
NANOCLAW_DEFAULT_SESSION_MODE_SLACK_ILLYSIUM=per-thread
NANOCLAW_DEFAULT_SENDER_POLICY_SLACK_ILLYSIUM=public
```

Setting `NANOCLAW_DEFAULT_AGENT_GROUP_<TYPE>` opts that channel type
into auto-wire: new channels the bot joins auto-create a
`messaging_group_agents` row pointing at the configured agent group,
so the first message routes immediately without a `/manage-channels`
pass. `_SENDER_POLICY_<TYPE>=public` matches v1 behavior for channel-
types where the platform's own membership is the gate (Slack
workspace membership for Illysium). Leave unset to preserve v2's
safe `strict` default. See `src/modules/channel-auto-wire/index.ts`.

**NOTE — illysium agent_group folder rename in step 2:** if you ran
step 2's `illysium-v2` → `illysium` rename, update the env value above
from `illysium-v2` to `illysium` to match. The current value (pre-
rename) is whatever folder `illie-v2-test` was wired to.

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

## Post-cutover operational notes

A few fork-specific primitives that change day-to-day operation vs v1:

- **Chat-invokable access grants.** `@illie grant @alice access` grants
  member access to the current agent group (owner/admin-gated —
  caller is derived from the latest inbound message, not from anything
  the agent can fake). Also: `revoke_access`, `list_access`. Eliminates
  SQL-to-grant-access for adding teammates to strict channels. Host
  module: `src/modules/permissions/grant.ts`; container tools:
  `container/agent-runner/src/mcp-tools/permissions.ts`.
- **Auto-wire on bot invite.** New Slack channels in the Illysium
  workspace route immediately after invite — no manual
  `/manage-channels` pass. Controlled by the env block in step 5.
- **Default model + effort.** v2 starts every container with `model=opus`
  (locked to `claude-opus-4-7` via `ANTHROPIC_DEFAULT_OPUS_MODEL`) and
  `CLAUDE_CODE_EFFORT_LEVEL=medium`. Per-group override by editing the
  group's `.claude-shared/settings.json` — the merge in
  `src/group-init.ts` is additive and preserves user-set values.
- **Auto-memory writes.** Claude Code's `MEMORY.md` + per-topic notes
  now persist across sessions of the same agent group (post-UID-remap
  fix). Path: `data/v2-sessions/<ag-id>/.claude-shared/projects/-workspace-agent/memory/`.
  autodream prune runs inside the container on its own schedule.

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
