/**
 * Fleet-wide scheduled-task inventory.
 *
 * Scheduled tasks live as recurring rows in each session's inbound.db
 * (messages_in WHERE recurrence IS NOT NULL). This sweeps every session,
 * joins agent group + channel from the central DB, and prints one block per
 * active series: who runs it, where output lands, the cron (rendered in the
 * service timezone), next fire, and the prompt/script it carries.
 *
 * The report goes to stdout; sweep progress and warnings go to stderr, so
 * `> report.txt` keeps the report clean while a stuck run still narrates
 * where it stopped. Run with `--help` for the flag list.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import Database from 'better-sqlite3';

import { DATA_DIR, TIMEZONE as CONFIG_TIMEZONE } from '../src/config.js';
import { resolveGroupTimezone } from '../src/container-config.js';
import { initDb } from '../src/db/connection.js';

/**
 * Wall-clock ceiling for the whole sweep. The fleet sweep is ~30s over ~1200
 * session DBs on a warm cache, so this is ~10x headroom — it exists because an
 * unbounded sweep of this shape once burned 28 hours of CPU on the production
 * host before anyone noticed. `--timeout 0` opts out.
 */
export const DEFAULT_BUDGET_MS = 300_000;

/** A single session DB slower than this gets named on stderr. */
const SLOW_DB_MS = 2_000;

/** Heartbeat cadence, in session DBs. */
const PROGRESS_EVERY = 100;

export const EXIT_USAGE = 2;
export const EXIT_BUDGET = 3;

export const USAGE = `Fleet-wide scheduled-task inventory.

Usage:
  pnpm exec tsx scripts/list-scheduled-tasks.ts [options]

Options:
  --all             also list cancelled/expired series (default: pending only)
  --full            print whole prompt/script bodies instead of clipping to 160 chars
  --timeout <sec>   abort the sweep after <sec> seconds (default ${DEFAULT_BUDGET_MS / 1000}; 0 = no limit)
  -h, --help        print this and exit

The report goes to stdout; progress and warnings go to stderr.

Exit codes:
  0  swept the whole fleet
  ${EXIT_USAGE}  bad usage
  ${EXIT_BUDGET}  sweep aborted at the --timeout ceiling (partial report on stdout)
`;

/** Thrown for anything the caller typed wrong; the CLI turns it into exit ${EXIT_USAGE}. */
export class UsageError extends Error {}

export interface Options {
  help: boolean;
  showAll: boolean;
  full: boolean;
  /** Sweep ceiling in ms; 0 means no ceiling. */
  budgetMs: number;
}

/**
 * Parse argv, rejecting anything unrecognized.
 *
 * The rejection is the point. This used to be two `process.argv.includes()`
 * calls, so `--help` — and any typo — fell through as "no flags" and silently
 * started a 1,200-database fleet sweep. A destructive-feeling amount of work
 * must not be what a mistyped flag does.
 */
export function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { help: false, showAll: false, full: false, budgetMs: DEFAULT_BUDGET_MS };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '--all') {
      opts.showAll = true;
    } else if (arg === '--full') {
      opts.full = true;
    } else if (arg === '--timeout' || arg.startsWith('--timeout=')) {
      const raw = arg.startsWith('--timeout=') ? arg.slice('--timeout='.length) : argv[++i];
      const seconds = Number(raw);
      if (raw === undefined || raw.trim() === '' || !Number.isFinite(seconds) || seconds < 0) {
        throw new UsageError(`--timeout wants a non-negative number of seconds, got ${JSON.stringify(raw ?? null)}`);
      }
      opts.budgetMs = seconds * 1000;
    } else {
      throw new UsageError(`unknown option ${JSON.stringify(arg)}`);
    }
  }

  return opts;
}

/**
 * Cron expressions are interpreted by the HOST process (recurrence.ts), whose
 * timezone comes from its own environment — on Linux that's the systemd
 * unit's Environment=TZ=..., which an ad-hoc shell doesn't inherit. Read it
 * from the unit so this report matches what the service actually does;
 * fall back to the local config resolution.
 */
function resolveServiceTimezone(): string {
  try {
    const env = execFileSync('systemctl', ['show', 'nanoclaw-v2', '-p', 'Environment', '--value'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const m = env.match(/(?:^|\s)TZ=(\S+)/);
    if (m) return m[1];
  } catch {
    /* not Linux/systemd or unit absent — fall through */
  }
  return CONFIG_TIMEZONE;
}

interface TaskRow {
  id: string;
  series_id: string | null;
  recurrence: string;
  process_after: string | null;
  status: string;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

function fmtWhen(iso: string | null, tz: string): string {
  if (!iso) return '-';
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  return `${d.toISOString().slice(0, 16)}Z (${d.toLocaleString('en-US', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' })} ${tz})`;
}

function clip(s: string, n: number, full: boolean): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return full || oneLine.length <= n ? s.trim() : `${oneLine.slice(0, n)}…`;
}

async function run(opts: Options): Promise<void> {
  const startedAt = Date.now();
  const elapsed = () => ((Date.now() - startedAt) / 1000).toFixed(1);
  /**
   * Progress is unconditional and goes to stderr because the failure this
   * script actually produced was an invisible one: no output, no indication of
   * which of ~1,200 databases it was on. A synchronous spin also blocks the
   * event loop, so a timer-based watchdog would never fire — the only thing
   * that survives is an eager write before each step.
   */
  const note = (msg: string) => process.stderr.write(`[list-scheduled-tasks +${elapsed()}s] ${msg}\n`);

  const TIMEZONE = resolveServiceTimezone();
  note(`service timezone ${TIMEZONE}`);

  const central = new Database(path.join(DATA_DIR, 'v2.db'), { readonly: true });
  const agentGroups = new Map(
    (
      central.prepare('SELECT id, name, folder, agent_provider FROM agent_groups').all() as Array<{
        id: string;
        name: string;
        folder: string;
        agent_provider: string | null;
      }>
    ).map((g) => [g.id, g]),
  );
  const messagingGroups = new Map(
    (
      central.prepare('SELECT id, name, channel_type, platform_id FROM messaging_groups').all() as Array<{
        id: string;
        name: string | null;
        channel_type: string;
        platform_id: string;
      }>
    ).map((m) => [m.id, m]),
  );
  const sessions = new Map(
    (
      central.prepare('SELECT id, agent_group_id, messaging_group_id, thread_id FROM sessions').all() as Array<{
        id: string;
        agent_group_id: string;
        messaging_group_id: string;
        thread_id: string | null;
      }>
    ).map((s) => [s.id, s]),
  );
  // Channel destination → messaging group name, for rows whose output target
  // differs from the session's own messaging group.
  const mgByDestination = new Map([...messagingGroups.values()].map((m) => [`${m.channel_type}\0${m.platform_id}`, m]));
  central.close();
  // Reopened through the shared connection so this report resolves a group's
  // timezone the same way the firing path does, instead of re-reading
  // container_configs itself. `readonly` is load-bearing, not decoration: this
  // is a report, and it runs against the live central DB of a running host, so
  // it must not take a write handle or touch the journal mode.
  await initDb(path.join(DATA_DIR, 'v2.db'), { role: 'tool', readonly: true });

  const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
  let count = 0;
  let scanned = 0;
  let lastOpened = '(none)';
  let aborted = false;

  const groupDirs = fs.readdirSync(sessionsRoot).sort();
  note(`sweeping ${groupDirs.length} agent-group dirs under ${sessionsRoot}`);

  outer: for (const groupDir of groupDirs) {
    const groupPath = path.join(sessionsRoot, groupDir);
    if (!fs.statSync(groupPath).isDirectory()) continue;
    // The directory name IS the agent group id (storage-activity.ts:319). A
    // group with a timezone override runs its whole series on that grid, so both
    // the cron interpretation and the rendered fire time report it — every line
    // already names the zone it is in, so nothing here reads ambiguously.
    const groupTz = await resolveGroupTimezone(groupDir, TIMEZONE);
    for (const sessDir of fs.readdirSync(groupPath).sort()) {
      const inboundPath = path.join(groupPath, sessDir, 'inbound.db');
      if (!fs.existsSync(inboundPath)) continue;

      // Checked between databases, so it bounds the sweep as a whole. A spin
      // inside one database is not bounded here — that is what `lastOpened`
      // below is for: the last stderr line names the database to look at.
      if (opts.budgetMs > 0 && Date.now() - startedAt > opts.budgetMs) {
        aborted = true;
        note(
          `ABORT: --timeout ceiling of ${opts.budgetMs / 1000}s exceeded after ${scanned} session DBs ` +
            `(last opened: ${lastOpened}). Re-run with --timeout 0 to sweep without a ceiling.`,
        );
        break outer;
      }

      lastOpened = `${groupDir}/${sessDir}`;
      scanned++;
      const openedAt = Date.now();

      const db = new Database(inboundPath, { readonly: true });
      let rows: TaskRow[];
      try {
        // Latest row per series tells the series' current state; older rows of
        // the same series are history (recurrence cleared on completion).
        rows = db
          .prepare(
            `SELECT id, series_id, recurrence, process_after, status, kind,
                    platform_id, channel_type, thread_id, content
             FROM messages_in
             WHERE recurrence IS NOT NULL
               AND seq = (SELECT MAX(m2.seq) FROM messages_in m2 WHERE m2.series_id = messages_in.series_id)
             ORDER BY process_after`,
          )
          .all() as TaskRow[];
      } finally {
        db.close();
      }

      const queryMs = Date.now() - openedAt;
      if (queryMs > SLOW_DB_MS) note(`slow: ${lastOpened} took ${queryMs}ms for ${rows.length} rows`);
      if (scanned % PROGRESS_EVERY === 0) {
        note(`${scanned} session DBs scanned, ${count} series so far (last: ${lastOpened})`);
      }

      for (const row of rows) {
        if (!opts.showAll && row.status !== 'pending') continue;

        const session = sessions.get(sessDir);
        const ag = agentGroups.get(session?.agent_group_id ?? groupDir);
        const sessionMg = session ? messagingGroups.get(session.messaging_group_id) : undefined;
        const destMg =
          row.channel_type && row.platform_id
            ? mgByDestination.get(`${row.channel_type}\0${row.platform_id}`)
            : undefined;

        let content: Record<string, unknown> = {};
        try {
          content = JSON.parse(row.content);
        } catch {
          /* show raw below */
        }
        const prompt = typeof content.prompt === 'string' ? content.prompt : row.content;
        const script = typeof content.script === 'string' ? (content.script as string) : null;

        count++;
        console.log(
          `\n━━━ ${row.series_id ?? row.id} ${row.status !== 'pending' ? `[${row.status.toUpperCase()}]` : ''}`,
        );
        console.log(
          `  agent group : ${ag ? `${ag.name} (${ag.folder}${ag.agent_provider ? `, ${ag.agent_provider}` : ''})` : groupDir}`,
        );
        console.log(
          `  channel     : ${destMg?.name ?? sessionMg?.name ?? '?'} [${row.channel_type ?? sessionMg?.channel_type ?? '?'}] ${row.thread_id ? `thread ${row.thread_id}` : 'channel root'}`,
        );
        console.log(`  session     : ${groupDir}/${sessDir}`);
        console.log(`  cron        : ${row.recurrence}  (interpreted in ${groupTz})`);
        console.log(`  next fire   : ${fmtWhen(row.process_after, groupTz)}`);
        if (content.quietStatus) console.log(`  quietStatus : true`);
        if (content.flagIntent) console.log(`  flagIntent  : ${JSON.stringify(content.flagIntent)}`);
        console.log(`  prompt      : ${clip(prompt, 160, opts.full)}`);
        if (script) console.log(`  pre-script  : ${clip(script, 160, opts.full)}`);
      }
    }
  }

  console.log(
    `\n${count} ${opts.showAll ? 'series' : 'active series'} total${aborted ? ' — PARTIAL, sweep hit the --timeout ceiling' : ''}.` +
      ` (--all includes non-pending, --full prints whole prompts/scripts)`,
  );
  note(`${aborted ? 'aborted' : 'done'} after ${scanned} session DBs`);
  if (aborted) process.exitCode = EXIT_BUDGET;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`list-scheduled-tasks: ${err.message}\n\n${USAGE}`);
    process.exit(EXIT_USAGE);
  }
  if (opts.help) {
    process.stdout.write(USAGE);
  } else {
    await run(opts);
  }
}
