/**
 * Migrate V1 scheduled tasks to V2.
 *
 * V2 stores tasks as rows in per-session inbound.db (messages_in, kind='task').
 * Tasks are scoped to a specific agent group + messaging group. Each task needs:
 *   - A session in central v2.db that matches the agent_group + Discord main channel
 *   - The task row inserted into that session's inbound.db
 *
 * For groups with no Discord main session yet, we create one (the session will
 * be created on demand when the first task fires via host-sweep → wake).
 *
 * System tasks (__daily_summary, __commit_digest, __plugin_updater) are skipped —
 * v2 handles these natively.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { initDb, getDb } from '../src/db/connection.js';
import { createSession } from '../src/db/sessions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'v2-sessions');

function now(): string {
  return new Date().toISOString();
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// Agent group → Discord main messaging group mapping
const DISCORD_MAIN_MG = 'mg-1776404343731-7041k0';
const DISCORD_MAIN_PLATFORM_ID = 'discord:1479489865702703155:1479489866193571902';

interface V1Task {
  id: string;
  groupFolder: string;
  agentGroupId: string;
  platformId: string;
  channelType: string;
  prompt: string;
  script?: string;
  cron: string;
  processAfter: string;
  seriesId: string;
}

// The V1 user tasks we want to migrate. System tasks skipped.
const TASKS: V1Task[] = [
  {
    id: 'task-email-recap-personal',
    groupFolder: 'main',
    agentGroupId: 'ag-1776402507183-cf39lq', // Axie-2 → Discord main
    platformId: DISCORD_MAIN_PLATFORM_ID,
    channelType: 'discord',
    cron: '0 12 * * *',
    processAfter: '2026-04-21T16:00:00.000Z',
    seriesId: 'task-email-recap-personal',
    prompt: `Daily Email Recap — Personal

Scan these inboxes for emails from the last 24h:
- david.kim6@gmail.com — account: primary
- dave.kim917@gmail.com — account: personal2

Use gws gmail to search and read emails:
  GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/primary.json gws gmail +triage --query "newer_than:1d" --max 50
Then read each with:
  GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/primary.json gws gmail +read --id <ID> --headers

PRIORITY RULE: Family/kids emails are ALWAYS 🔴 and listed first.

Dave's kids:
- Chloe Kim (11, 6th grade, born 6/2/14) and Theodore "Teddy" Kim (10, 4th grade, born 1/16/16)
- School: Gwyn-Nor Elementary, North Penn School District, PA
- Sports: MonU Soccer, AOC Track Club
- Qustodio = parental monitoring reports
- Match on: Gwyn-Nor, North Penn, NPSD, MonU, AOC Track, Qustodio, TeamSnap, any school/coach/pediatrician
- If UNCERTAIN about a sender, use Exa MCP to research before categorizing

FORMAT — follow exactly:
- Each email = ONE line: priority emoji + **sender** + subject + → action
- Priority emojis: 🔴 urgent/today, 🟡 this week, ⚪ FYI
- Group by priority (🔴 first), not by time
- NO sub-bullets, no multi-line descriptions — one line per email max
- Example: 🔴 **North Penn SD** — Field trip permission slip due 3/12 → sign and return
- Newsletters: just sender + recommendation: ❌ unsub | 🏷️ filter | ✅ keep
- Cleanup: one-liner filter rule suggestions only
- Omit sections entirely if empty
- If no emails, say so in one line

Sections (in order):
**Family & Kids**
**Action Required**
**Newsletters**
**Cleanup**`,
  },
  {
    id: 'task-email-recap-illysium',
    groupFolder: 'illysium',
    agentGroupId: 'ag-1776402507183-cf39lq', // Axie-2 → Discord main
    platformId: DISCORD_MAIN_PLATFORM_ID,
    channelType: 'discord',
    cron: '0 12 * * *',
    processAfter: '2026-04-21T16:00:00.000Z',
    seriesId: 'task-email-recap-illysium',
    prompt: `Daily Email Recap — Illysium

Scan dave@illysium.ai for emails from the last 24h.

Use gws gmail to search and read emails:
  GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/illysium.json gws gmail +triage --query "newer_than:1d" --max 50
Then read each with:
  GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/illysium.json gws gmail +read --id <ID> --headers

FORMAT — follow exactly:
- Each email = ONE line: priority emoji + **sender** + subject + → action
- Priority emojis: 🔴 urgent/today, 🟡 this week, ⚪ FYI
- Group by priority (🔴 first), not by time
- NO sub-bullets, no multi-line descriptions — one line per email max
- Example: 🔴 **GitHub** — PR #42 review requested → review and approve
- Newsletters: just sender + recommendation: ❌ unsub | 🏷️ filter | ✅ keep
- Cleanup: one-liner filter rule suggestions only
- Omit sections entirely if empty
- If no emails, say so in one line

Sections (in order):
**Action Required**
**Newsletters**
**Cleanup**`,
  },
  {
    id: 'task-email-recap-numberdrinks',
    groupFolder: 'number-drinks',
    agentGroupId: 'ag-1776377699463-2axxhg', // illie-v2 → Discord main
    platformId: DISCORD_MAIN_PLATFORM_ID,
    channelType: 'discord',
    cron: '0 12 * * *',
    processAfter: '2026-04-21T16:00:00.000Z',
    seriesId: 'task-email-recap-numberdrinks',
    prompt: `Daily Email Recap — Number Drinks

Scan dave@numberdrinks.com for emails from the last 24h.

Use gws gmail to search and read emails:
  GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/numberdrinks.json gws gmail +triage --query "newer_than:1d" --max 50
Then read each with:
  GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/numberdrinks.json gws gmail +read --id <ID> --headers

FORMAT — follow exactly:
- Each email = ONE line: priority emoji + **sender** + subject + → action
- Priority emojis: 🔴 urgent/today, 🟡 this week, ⚪ FYI
- Group by priority (🔴 first), not by time
- NO sub-bullets, no multi-line descriptions — one line per email max
- Newsletters: just sender + recommendation: ❌ unsub | 🏷️ filter | ✅ keep
- Cleanup: one-liner filter rule suggestions only
- Omit sections entirely if empty
- If no emails, say so in one line

Sections (in order):
**Action Required**
**Newsletters**
**Cleanup**`,
  },
  {
    id: 'task-email-recap-madison-reed',
    groupFolder: 'madison-reed',
    agentGroupId: 'ag-1776402507183-cf39lq', // Axie-2 → Discord main
    platformId: DISCORD_MAIN_PLATFORM_ID,
    channelType: 'discord',
    cron: '0 12 * * *',
    processAfter: '2026-04-21T16:00:00.000Z',
    seriesId: 'task-email-recap-madison-reed',
    prompt: `Daily Email Recap — Madison Reed

Scan dave.kim@madison-reed.com for emails from the last 24h.

Use gws gmail to search and read emails:
  GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/madison-reed.json gws gmail +triage --query "newer_than:1d" --max 50
Then read each with:
  GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/madison-reed.json gws gmail +read --id <ID> --headers

FORMAT — follow exactly:
- Each email = ONE line: priority emoji + **sender** + subject + → action
- Priority emojis: 🔴 urgent/today, 🟡 this week, ⚪ FYI
- Group by priority (🔴 first), not by time
- NO sub-bullets, no multi-line descriptions — one line per email max
- Example: 🔴 **Hiring Manager** — Onboarding docs due Friday → complete and return
- Newsletters: just sender + recommendation: ❌ unsub | 🏷️ filter | ✅ keep
- Cleanup: one-liner filter rule suggestions only
- Omit sections entirely if empty
- If no emails, say so in one line

Sections (in order):
**Action Required**
**Newsletters**
**Cleanup**`,
  },
  {
    id: 'task-morning-briefing',
    groupFolder: 'main',
    agentGroupId: 'ag-1776402507183-cf39lq', // Axie-2 → Discord main
    platformId: DISCORD_MAIN_PLATFORM_ID,
    channelType: 'discord',
    cron: '0 12 * * *',
    processAfter: '2026-04-21T16:00:00.000Z',
    seriesId: 'task-morning-briefing',
    prompt: `You are running a daily morning briefing. Do the following:

1. *Calendar* — Check today's meetings and upcoming events using the gws CLI:
   GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/primary.json gws calendar +agenda --today
   Note any meetings that need prep.

2. *Action Items* — Check Granola for recent meeting notes and outstanding action items.

3. *Quick Recap* — Briefly summarize any important threads or conversations from yesterday across Discord channels.

Note: Email recaps are handled by separate dedicated tasks per inbox — do NOT duplicate email triage here.

Format as a clean, scannable daily briefing. Use bullet points. Group by priority (urgent / today / FYI). Keep it concise.`,
  },
  {
    id: 'task-meeting-digest',
    groupFolder: 'main',
    agentGroupId: 'ag-1776402507183-cf39lq', // Axie-2 → Discord main
    platformId: DISCORD_MAIN_PLATFORM_ID,
    channelType: 'discord',
    cron: '0 22 * * *',
    processAfter: '2026-04-21T02:00:00.000Z',
    seriesId: 'task-meeting-digest',
    prompt: `You are Dave's daily meeting digest assistant. Dave uses Granola to capture meeting notes throughout the day.

At the end of each day, do the following:
1. Query Granola for all meetings that occurred today
2. For each meeting, extract: key decisions made, action items (with owners if mentioned), and important discussion points
3. Send Dave a clean, scannable digest summarizing today's meetings — grouped by meeting, with bullet points for decisions and action items

Keep the tone concise and professional. If there are no meetings today, send a brief "No meetings today" message.`,
  },
  {
    id: 'task-container-updates',
    groupFolder: 'main',
    agentGroupId: 'ag-1776402507183-cf39lq', // Axie-2 → Discord main
    platformId: DISCORD_MAIN_PLATFORM_ID,
    channelType: 'discord',
    cron: '0 14 * * 1',
    processAfter: '2026-04-27T18:00:00.000Z',
    seriesId: 'task-container-updates',
    prompt: `Check for container package updates and upstream-synced file drift.

## Part 1 — Dockerfile package versions

Read /workspace/project/container/Dockerfile and extract every pinned version. Do NOT hardcode package names — parse them dynamically so new packages are automatically included.

For each pinned package:
- npm: lines like package@x.y.z in npm install -g
- pip: lines like package==x.y.z in pip install
- ARG: lines like ARG PACKAGE_VERSION=x.y.z (Render, Railway, Supabase, etc.)
- Snowflake .deb: SNOW_VERSION ARG

Check the latest available version:
- npm packages: run "npm view <package> version"
- pip packages: check PyPI via "curl -s https://pypi.org/pypi/<package>/json | jq -r .info.version"
- GitHub release ARGs: use "gh release view --repo <owner>/<repo> --json tagName -q .tagName" for:
  - RENDER_VERSION → render-oss/cli
  - RAILWAY_VERSION → railwayapp/cli
  - SUPABASE_VERSION → supabase/cli
- SNOW_VERSION: check https://sfc-repo.snowflakecomputing.com/snowflake-cli/linux_aarch64/index.html for the latest version listed

## Part 2 — Upstream-synced file drift (verbatim copies in bootstrap-workflow)

Read /workspace/plugins/bootstrap/plugins/workflow/skills/team-qa/references/CODEX-SOURCES.md and find the "Pinned upstream SHAs" table. It lists files that are verbatim copies from openai/codex-plugin-cc with their pinned commit SHAs.

For each row in that table, check the latest upstream SHA touching that path:
  gh api "repos/openai/codex-plugin-cc/commits?path=<upstream-path>&per_page=1" --jq ".[0].sha[0:7]"

Compare against the pinned SHA in the table. If different, the file has drifted.

## Reporting

Combine findings from both parts into ONE message:
- If ANY package is outdated OR ANY file has drifted, send a message listing everything that needs attention. For packages: current → latest. For drifted files: pinned SHA → latest SHA. Tell Dave to run /update-container in the chat to apply the fixes.
- If everything is up to date, say so in one line.`,
  },
  {
    id: 'task-axie-briefing',
    groupFolder: 'main',
    agentGroupId: 'ag-1776402507183-cf39lq', // Axie-2 → Discord main
    platformId: DISCORD_MAIN_PLATFORM_ID,
    channelType: 'discord',
    cron: '0 12 * * *',
    processAfter: '2026-04-21T16:00:00.000Z',
    seriesId: 'task-axie-briefing',
    prompt: `You are Axie, Dave Kim's AI assistant. Your job is to send Dave a morning briefing with two sections: yesterday's shipped items and the current open backlog.

Steps:
1. Use \`list_ship_log\` to fetch recent ship log entries (limit 20)
2. Use \`list_backlog\` to fetch all open and in_progress backlog items
3. Filter ship log entries to only those shipped in the prior calendar day (UTC)
4. Group backlog items by priority (high, medium, low)
5. Send a single message to Dave using \`send_message\` with the full briefing

Format the message like this:

🚀 **Shipped Yesterday**
- [title] — [description]
...
_(or "Nothing shipped yesterday." if empty)_

📋 **Open Backlog**

**High Priority**
- [title] — [short description]
...

**Medium Priority**
- [title] — [short description]
...

**Low Priority**
- [title] — [short description]
...

_N total open items_

_(or "No open backlog items. All clear! ✅" if empty)_

Use Discord markdown (** for bold, - for bullets). Do NOT use --- dividers or [text](url) link syntax.`,
  },
  {
    id: 'task-upstream-check',
    groupFolder: 'main',
    agentGroupId: 'ag-1776402507183-cf39lq', // Axie-2 → Discord main
    platformId: DISCORD_MAIN_PLATFORM_ID,
    channelType: 'discord',
    cron: '0 9 * * *',
    processAfter: '2026-04-21T13:00:00.000Z',
    seriesId: 'task-upstream-check',
    script: [
      '#!/bin/bash',
      'set -euo pipefail',
      '',
      'FORK="davekim917/nanoclaw"',
      'UPSTREAM="qwibitai/nanoclaw"',
      '',
      'FORK_SHA=$(gh api "repos/$FORK/branches/main" --jq \'.commit.sha\' 2>/dev/null || echo "")',
      'UPSTREAM_SHA=$(gh api "repos/$UPSTREAM/branches/main" --jq \'.commit.sha\' 2>/dev/null || echo "")',
      '',
      'if [ -z "$FORK_SHA" ] || [ -z "$UPSTREAM_SHA" ]; then',
      '  printf \'{"wakeAgent": true, "data": {"error": "GitHub API query failed"}}\n\'',
      '  exit 0',
      'fi',
      '',
      'FORK_SHORT="${FORK_SHA:0:7}"',
      'UPSTREAM_SHORT="${UPSTREAM_SHA:0:7}"',
      '',
      'COMPARE=$(gh api "repos/$UPSTREAM/compare/${FORK_SHA}...${UPSTREAM_SHA}" --jq \'{status: .status, ahead_by: .ahead_by}\' 2>/dev/null || echo "")',
      '',
      'if [ -z "$COMPARE" ]; then',
      '  printf \'{"wakeAgent": true, "data": {"error": "GitHub compare API failed"}}\n\'',
      '  exit 0',
      'fi',
      '',
      'COUNT=$(echo "$COMPARE" | jq -r \'.ahead_by // 0\')',
      '',
      'if [ "$COUNT" = "0" ] || [ "$(echo "$COMPARE" | jq -r \'.status\')" = "identical" ]; then',
      '  printf \'{"wakeAgent": true, "data": {"count": 0, "forkSha": "%s", "upstreamSha": "%s"}}\n\' "$FORK_SHORT" "$UPSTREAM_SHORT"',
      '  exit 0',
      'fi',
      '',
      'COMMITS=$(gh api "repos/$UPSTREAM/compare/${FORK_SHA}...${UPSTREAM_SHA}"',
      '  --jq \'[.commits | reverse | .[:15][] | "\\(.sha[0:7])|\\(.commit.message | split("\\n")[0])|\\(.commit.author.name)|\\(.commit.author.date[0:10])"]\' 2>/dev/null || echo "[]")',
      '',
      'printf \'{"wakeAgent": true, "data": {"count": %s, "forkSha": "%s", "upstreamSha": "%s", "commits": %s}}\n\'',
      '  "$COUNT" "$FORK_SHORT" "$UPSTREAM_SHORT" "$COMMITS"',
    ].join('\n'),
    prompt: `You are running a daily upstream sync check for the NanoClaw fork.

The pre-check script compared the fork against upstream via GitHub API.
Script data contains: count (commits behind), forkSha, upstreamSha, and commits (list of "hash|subject|author|date" strings).

**If count is 0 (no drift):**
Send a brief confirmation: "Fork is up to date with upstream (synced at FORK_SHA)." — one line, nothing more.

**If there is an error field:**
Send a brief warning: "Upstream check failed: ERROR_MESSAGE" — one line.

**If count > 0 (drift detected):**

1. Parse the commits. Each string is "hash|subject|author|date".

2. For each commit, classify it:
   - **feat** — new feature
   - **fix** — bug fix
   - **security** — security-related (security, injection, CVE, auth bypass)
   - **refactor** — internal restructuring
   - **docs/chore** — documentation, CI, deps

3. Make a recommendation:
   - **Run /update-nanoclaw** if: any security fix, any useful feat, or 5+ commits behind
   - **Watch but wait** if: only refactor/docs/chore, or 1-4 minor commits

4. Format the message:

📦 **Upstream Check — qwibitai/nanoclaw**

Fork is **N commits behind** upstream (last synced around XXXX).

**Notable commits (most recent first):**
- [type] short description (date)
- ...

**Recommendation:** [Run /update-nanoclaw | Watch but wait]
**Reason:** one sentence.

Use **bold** with double asterisks, bullet points with -. Keep it concise.`,
  },
  {
    id: 'task-parental-monitoring',
    groupFolder: 'main',
    agentGroupId: 'ag-1776402507183-cf39lq', // Axie-2 → Discord main
    platformId: DISCORD_MAIN_PLATFORM_ID,
    channelType: 'discord',
    cron: '0 14 * * *',
    processAfter: '2026-04-21T18:00:00.000Z',
    seriesId: 'task-parental-monitoring',
    prompt: `You are a parental monitoring assistant for Dave. Your job is to check his Qustodio daily summary emails for his two kids — Chloe Kim and Theodore Kim — and alert him only if there is anything questionable or concerning.

Steps:
1. Search for Qustodio emails received today using the gws CLI:
   GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/primary.json gws gmail +triage --query "from:Qustodio newer_than:1d" --max 20

2. For each email found, read the full content:
   GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/primary.json gws gmail +read --id <ID> --head

3. Extract from each email: child's name, top categories, top apps/websites, and any safety ratings (Safe/Unsafe flags)

4. Flag anything concerning, including but not limited to:
   - Any category labeled "Mature and Explicit", "Adult Content", "Violence", "Gambling", or similar
   - Any app/website flagged as "Unsafe"
   - Any social media platform rated for older ages (e.g., Instagram, TikTok, Snapchat)
   - "Unsafe AI Tools" or unmoderated AI chat platforms
   - Any unusual spikes in non-educational content

5. If there IS something concerning: Send Dave a clear, concise message summarizing what was found and which child it's for. Be specific about what was flagged and why it might warrant attention.
6. If everything looks clean and normal (only education, safe apps, standard school tools): Send a brief "All clear" message so Dave knows it was reviewed.
7. If no Qustodio emails were found today: Note that in your message.

Always send a message with the result so Dave knows the review happened.`,
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function openInboundDb(sessDir: string): Database.Database {
  const db = new Database(path.join(sessDir, 'inbound.db'));
  db.pragma('journal_mode = DELETE');
  return db;
}

function nextEvenSeq(db: Database.Database): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) as maxSeq FROM messages_in').get() as { maxSeq: number };
  let seq = row.maxSeq + 2;
  // Ensure even
  if (seq % 2 !== 0) seq++;
  return seq;
}

function insertTask(
  db: Database.Database,
  task: V1Task,
  sessionId: string,
): void {
  db.prepare(
    `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content, series_id)
     VALUES (?, ?, datetime('now'), 'pending', 0, ?, ?, 'task', ?, ?, NULL, ?, ?)`,
  ).run(
    task.id,
    nextEvenSeq(db),
    task.processAfter,
    task.cron,
    task.platformId,
    task.channelType,
    JSON.stringify({ prompt: task.prompt, script: task.script ?? null }),
    task.seriesId,
  );
}

function createSessionRow(agentGroupId: string, sessionId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
     VALUES (?, ?, ?, NULL, NULL, 'active', 'stopped', ?, ?)`,
  ).run(sessionId, agentGroupId, DISCORD_MAIN_MG, now(), now());
}

function createSessionDir(agentGroupId: string, sessionId: string): string {
  const sessDir = path.join(SESSIONS_DIR, agentGroupId, sessionId);
  fs.mkdirSync(sessDir, { recursive: true });

  // Create inbound.db with schema
  const inboundDb = openInboundDb(sessDir);
  inboundDb.exec(`
    CREATE TABLE IF NOT EXISTS messages_in (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      kind           TEXT NOT NULL,
      timestamp      TEXT NOT NULL,
      status         TEXT NOT NULL,
      status_changed TEXT,
      process_after  TEXT,
      recurrence     TEXT,
      tries          INTEGER NOT NULL DEFAULT 0,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL,
      series_id      TEXT
    );
    CREATE TABLE IF NOT EXISTS session_routing (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      channel_type TEXT,
      platform_id  TEXT,
      thread_id    TEXT
    );
  `);
  inboundDb.close();

  // Write session routing for this Discord main channel
  const routingDb = new Database(path.join(sessDir, 'routing.db'));
  routingDb.pragma('journal_mode = DELETE');
  routingDb.exec(`
    CREATE TABLE IF NOT EXISTS routing (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      channel_type TEXT,
      platform_id  TEXT,
      thread_id    TEXT
    );
    INSERT OR REPLACE INTO routing (id, channel_type, platform_id, thread_id) VALUES (1, 'discord', '${DISCORD_MAIN_PLATFORM_ID}', NULL);
  `);
  routingDb.close();

  // Create empty outbound.db
  const outboundDb = new Database(path.join(sessDir, 'outbound.db'));
  outboundDb.pragma('journal_mode = DELETE');
  outboundDb.exec(`
    CREATE TABLE IF NOT EXISTS messages_out (
      id             TEXT PRIMARY KEY,
      in_reply_to    TEXT,
      timestamp      TEXT NOT NULL,
      delivered      INTEGER NOT NULL DEFAULT 0,
      deliver_after  TEXT,
      recurrence     TEXT,
      kind           TEXT NOT NULL,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL
    );
  `);
  outboundDb.close();

  console.log(`  [session] created: ${sessDir}`);
  return sessDir;
}

function findExistingSession(agentGroupId: string): string | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT id FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND status = 'active' LIMIT 1"
  ).get(agentGroupId, DISCORD_MAIN_MG) as { id: string } | undefined;
  return row?.id ?? null;
}

function sessionDirExists(agentGroupId: string, sessionId: string): boolean {
  return fs.existsSync(path.join(SESSIONS_DIR, agentGroupId, sessionId, 'inbound.db'));
}

import fs from 'fs';

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== V1 → V2 Scheduled Tasks Migration ===\n');

  const dbPath = path.join(PROJECT_ROOT, 'data', 'v2.db');
  initDb(dbPath);
  console.log('[db] central initialized\n');

  // Group tasks by agent group
  const byAgent = new Map<string, V1Task[]>();
  for (const task of TASKS) {
    const existing = byAgent.get(task.agentGroupId) ?? [];
    existing.push(task);
    byAgent.set(task.agentGroupId, existing);
  }

  for (const [agentGroupId, tasks] of byAgent) {
    console.log(`--- Agent group: ${agentGroupId} (${tasks.length} tasks) ---`);

    // Find or create a Discord main session
    let sessionId = findExistingSession(agentGroupId);
    let sessDir: string;

    if (sessionId && sessionDirExists(agentGroupId, sessionId)) {
      console.log(`  [session] using existing: ${sessionId}`);
      sessDir = path.join(SESSIONS_DIR, agentGroupId, sessionId);
    } else {
      sessionId = generateId('sess');
      createSessionRow(agentGroupId, sessionId);
      sessDir = createSessionDir(agentGroupId, sessionId);
    }

    const inboundDb = openInboundDb(sessDir);

    // Check for existing tasks with same series_id to avoid duplicates
    const existingSeries = new Set(
      (inboundDb.prepare("SELECT series_id FROM messages_in WHERE kind = 'task'").all() as { series_id: string }[]).map(r => r.series_id)
    );

    let inserted = 0;
    for (const task of tasks) {
      if (existingSeries.has(task.seriesId)) {
        console.log(`  [task] already exists: ${task.seriesId} — skipping`);
        continue;
      }
      insertTask(inboundDb, task, sessionId!);
      console.log(`  [task] inserted: ${task.id} (cron: ${task.cron})`);
      inserted++;
    }

    inboundDb.close();
    console.log(`  [done] ${inserted}/${tasks.length} tasks inserted\n`);
  }

  console.log('=== Migration Complete ===\n');
  console.log('Note: processAfter dates are set to today (2026-04-21).');
  console.log('The host sweep will fire these at the next cron interval.\n');
}

main().catch(console.error);
