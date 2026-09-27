/**
 * Read-path health for rate-limit telemetry (`rate_limit_samples`). Rows come from a PUSH
 * (`rate_limit_event`, volunteered mid-turn) and a READING (`usage_pull` for Codex,
 * `rate_limit_headers` for Claude). Both readings are fail-open, so a dead read path leaves no
 * error anywhere while push rows keep the table looking alive.
 *
 * THE SIGNAL: an (agent group, `credential_set`) pair that is PUSHING inside the window but
 * has landed NO reading row in it. It does not fire on silence (idle, OpenCode and quiet
 * pairs are indistinguishable), and a pull row counts whatever its `status`.
 *
 * ERRORS ARE NEVER ZEROS, in the filesystem walk as much as the DB reads: every unlistable
 * directory, unstattable path, unopenable DB and failed query is counted under its own code.
 * A DB with no `rate_limit_samples` table (`noTable`) predates it and is evidence of nothing.
 *
 * Opens are `readonly` + `PRAGMA query_only=ON`: a read-only open never replays a rollback
 * journal, so this cannot alter a session DB.
 */
/* eslint-disable no-catch-all/no-catch-all -- an unreadable or malformed session DB must become an explicit counted error, never a silent zero; that is the defect this script exists to catch */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { DATA_DIR, TIMEZONE } from '../src/config.js';
import { formatLocalTime } from '../src/timezone.js';

const DEFAULT_WINDOW_HOURS = 24;

const EXIT_OK = 0;
const EXIT_SCAN_FAILED = 1;
const EXIT_USAGE = 2;

/** Cap on findings embedded in `--gate` data, which is injected into a prompt. */
const GATE_FINDING_LIMIT = 20;

/** How long a quiet `--gate` result may stand: daily, with two hours' slack. */
const GATE_BOUND = '26h';

type PairVerdict =
  /** Push rows in the window, and no pull row has EVER landed for this pair. */
  | 'never'
  /** Push rows in the window, none pulled in it, but pulls landed before it. */
  | 'stale'
  | 'ok';

interface TelemetryPair {
  agentGroup: string;
  credentialSet: string | null;
  verdict: PairVerdict;
  pushRows: number;
  pullRows: number;
  lastPullEver: string | null;
  lastPushInWindow: string | null;
  pushingSessions: number;
}

type ScanErrorCode =
  /** A group directory could not be listed — every session under it is invisible. */
  | 'group_unlistable'
  /** An `outbound.db` path could not be stat'd for a reason other than ENOENT. */
  | 'db_unstattable'
  | 'unreadable'
  | 'query_failed'
  /** Rows whose `ts` SQLite cannot parse, dropped from both counts. */
  | 'unparsable_timestamps';

interface TelemetryScanError {
  /** `<agent group>` or `<agent group>/<session>`, relative to the sessions root. */
  path: string;
  code: ScanErrorCode;
  detail: string;
}

export interface TelemetryHealthReport {
  generatedAt: string;
  sessionsRoot: string;
  windowHours: number;
  sinceIso: string;
  minPushes: number;
  counts: {
    agentGroups: number;
    sessionDbs: number;
    withTable: number;
    /** Predating the table: not an error, not a symptom. */
    noTable: number;
    /** DB paths that failed to stat, open or query. Never folded into a zero. */
    errored: number;
    /** Group directories that could not be listed — a blind spot, not an absence. */
    unlistableDirs: number;
  };
  pairs: TelemetryPair[];
  findings: TelemetryPair[];
  errors: TelemetryScanError[];
}

type OpenSessionDb = (file: string) => Database.Database;

const openReadOnly: OpenSessionDb = (file) => {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  return db;
};

export interface ScanOptions {
  sessionsRoot: string;
  /** Inclusive lower bound, ISO-8601 UTC. */
  sinceIso: string;
  windowHours: number;
  /** Push rows a pair needs in the window before it can be judged at all. */
  minPushes: number;
  now?: Date;
  openDb?: OpenSessionDb;
}

interface PairAccumulator {
  pushRows: number;
  pullRows: number;
  lastPullEver: string | null;
  lastPushInWindow: string | null;
  pushingSessions: number;
}

interface PerSessionRow {
  credential_set: string | null;
  push_rows: number;
  pull_rows: number;
  last_pull_ever: string | null;
  last_push_in_window: string | null;
}

/** Either reading source landing counts as the read path working. */
const READING_SOURCES = ['usage_pull', 'rate_limit_headers'] as const;
const READING_SOURCES_SQL = READING_SOURCES.map((s) => `'${s}'`).join(', ');

/**
 * A push that can be judged: an API-key, Bedrock or Vertex Claude session has no credential
 * set and never carries header windows, so it has no reading to be missing.
 */
const JUDGED_PUSH_SQL = `source = 'rate_limit_event' AND NOT (account IS NULL AND credential_set IS NULL)`;

/**
 * `datetime()` answers NULL for a value it cannot parse, and `NULL >= x` is false, so a
 * malformed `ts` would silently drop out of both counts; `UNPARSABLE_TS_SQL` makes it an error.
 */
const PER_SESSION_SQL = `
  SELECT credential_set,
         SUM(CASE WHEN ${JUDGED_PUSH_SQL} AND datetime(ts) >= datetime(?) THEN 1 ELSE 0 END)                    AS push_rows,
         SUM(CASE WHEN source IN (${READING_SOURCES_SQL}) AND datetime(ts) >= datetime(?) THEN 1 ELSE 0 END) AS pull_rows,
         MAX(CASE WHEN source IN (${READING_SOURCES_SQL}) THEN ts END)                                         AS last_pull_ever,
         MAX(CASE WHEN ${JUDGED_PUSH_SQL} AND datetime(ts) >= datetime(?) THEN ts END)                          AS last_push_in_window
    FROM rate_limit_samples
   GROUP BY credential_set
`;

const UNPARSABLE_TS_SQL = `SELECT COUNT(*) AS n FROM rate_limit_samples WHERE datetime(ts) IS NULL`;

const TABLE_PRESENT_SQL = `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rate_limit_samples'`;

type DirListing = { names: string[] } | { error: string };

/**
 * THE ONE PLACE A DIRECTORY IS LISTED. Returns a union, never a bare array: `[]` and "could not
 * look" must differ, or an unlistable directory reads as empty and healthy. A symlinked entry
 * stays a candidate so a non-directory target fails loudly later instead of vanishing.
 */
function listSubdirectories(dir: string): DirListing {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { error: errorDetail(err) };
  }
  return {
    names: entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
      .sort(),
  };
}

type DbProbe = { present: boolean } | { error: string };

/**
 * `statSync`, NOT `fs.existsSync`: existsSync answers `false` for EACCES too, hiding an
 * untraversable session. ENOENT is the only genuine "no".
 */
function probeSessionDb(file: string): DbProbe {
  try {
    fs.statSync(file);
    return { present: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { present: false };
    return { error: errorDetail(err) };
  }
}

/**
 * Written as an escape, never a literal NUL byte: a literal one makes this file binary to
 * `grep` and `rg`, which then silently return nothing over it.
 */
const KEY_SEP = '\u0000';

/** A literal 'null' credential_set and a SQL NULL must not collapse together. */
function pairKey(agentGroup: string, credentialSet: string | null): string {
  return `${agentGroup}${KEY_SEP}${credentialSet === null ? 'n' : `s:${credentialSet}`}`;
}

const VERDICT_ORDER: Record<PairVerdict, number> = { never: 0, stale: 1, ok: 2 };

/** Walks `<sessionsRoot>/<agent group>/<session>/outbound.db`, the two levels `sessionDir()` writes. */
export function scanRateLimitTelemetry(options: ScanOptions): TelemetryHealthReport {
  const { sessionsRoot, sinceIso, windowHours, minPushes } = options;
  const openDb = options.openDb ?? openReadOnly;
  const generatedAt = (options.now ?? new Date()).toISOString();

  const errors: TelemetryScanError[] = [];
  const pairs = new Map<string, { credentialSet: string | null; agentGroup: string; acc: PairAccumulator }>();
  const counts = { agentGroups: 0, sessionDbs: 0, withTable: 0, noTable: 0, errored: 0, unlistableDirs: 0 };

  // An unlistable ROOT leaves no coverage at all, so it throws rather than reporting
  // "0 groups, 0 findings"; under `--gate` that still wakes someone.
  const rootListing = listSubdirectories(sessionsRoot);
  if ('error' in rootListing) {
    throw new Error(`sessions root is not listable: ${sessionsRoot} — ${rootListing.error}`);
  }

  for (const agentGroup of rootListing.names) {
    counts.agentGroups += 1;
    const groupDir = path.join(sessionsRoot, agentGroup);

    const groupListing = listSubdirectories(groupDir);
    if ('error' in groupListing) {
      counts.unlistableDirs += 1;
      errors.push({ path: agentGroup, code: 'group_unlistable', detail: groupListing.error });
      continue;
    }

    for (const session of groupListing.names) {
      const file = path.join(groupDir, session, 'outbound.db');
      const label = `${agentGroup}/${session}`;

      const probe = probeSessionDb(file);
      if ('error' in probe) {
        counts.errored += 1;
        errors.push({ path: label, code: 'db_unstattable', detail: probe.error });
        continue;
      }
      if (!probe.present) continue;
      counts.sessionDbs += 1;

      let db: Database.Database;
      try {
        db = openDb(file);
      } catch (err) {
        counts.errored += 1;
        errors.push({ path: label, code: 'unreadable', detail: errorDetail(err) });
        continue;
      }

      try {
        const present = db.prepare(TABLE_PRESENT_SQL).get();
        if (!present) {
          counts.noTable += 1;
          continue;
        }

        const unparsable = db.prepare(UNPARSABLE_TS_SQL).get() as { n: number };
        const rows = db.prepare(PER_SESSION_SQL).all(sinceIso, sinceIso, sinceIso) as PerSessionRow[];
        // Counted only after every read succeeded, so a half-read DB lands in `errored`, never `withTable`.
        counts.withTable += 1;

        if (unparsable.n > 0) {
          errors.push({
            path: label,
            code: 'unparsable_timestamps',
            detail: `${unparsable.n} row(s) with a ts SQLite cannot parse — excluded from both counts`,
          });
        }

        for (const row of rows) {
          const key = pairKey(agentGroup, row.credential_set);
          const entry = pairs.get(key) ?? {
            agentGroup,
            credentialSet: row.credential_set,
            acc: { pushRows: 0, pullRows: 0, lastPullEver: null, lastPushInWindow: null, pushingSessions: 0 },
          };
          entry.acc.pushRows += row.push_rows;
          entry.acc.pullRows += row.pull_rows;
          if (row.push_rows > 0) entry.acc.pushingSessions += 1;
          entry.acc.lastPullEver = maxIso(entry.acc.lastPullEver, row.last_pull_ever);
          entry.acc.lastPushInWindow = maxIso(entry.acc.lastPushInWindow, row.last_push_in_window);
          pairs.set(key, entry);
        }
      } catch (err) {
        counts.errored += 1;
        errors.push({ path: label, code: 'query_failed', detail: errorDetail(err) });
      } finally {
        try {
          db.close();
        } catch {
          /* a close failure has no bearing on what was already read */
        }
      }
    }
  }

  const judged: TelemetryPair[] = [];
  for (const { agentGroup, credentialSet, acc } of pairs.values()) {
    if (acc.pushRows < minPushes) continue;
    const verdict: PairVerdict = acc.pullRows > 0 ? 'ok' : acc.lastPullEver ? 'stale' : 'never';
    judged.push({ agentGroup, credentialSet, verdict, ...acc });
  }
  judged.sort(
    (a, b) =>
      VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] ||
      b.pushRows - a.pushRows ||
      a.agentGroup.localeCompare(b.agentGroup) ||
      (a.credentialSet ?? '').localeCompare(b.credentialSet ?? ''),
  );

  return {
    generatedAt,
    sessionsRoot,
    windowHours,
    sinceIso,
    minPushes,
    counts,
    pairs: judged,
    findings: judged.filter((p) => p.verdict !== 'ok'),
    errors,
  };
}

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export function windowStart(hours: number, now: Date = new Date()): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

/**
 * The host-gated task-script contract: the LAST stdout line is `{wakeAgent, data}`, and a
 * quiet line declares an `empty` observation. A failed scan wakes too.
 */
export function gateResult(report: TelemetryHealthReport): {
  wakeAgent: boolean;
  observation?: { kind: 'empty'; evidence: string; bound: string };
  data: unknown;
} {
  const wakeAgent = report.findings.length > 0 || report.errors.length > 0;
  return {
    wakeAgent,
    ...(wakeAgent
      ? {}
      : {
          observation: {
            kind: 'empty' as const,
            evidence: `${report.counts.sessionDbs} session DBs in ${report.counts.agentGroups} agent groups scanned over ${report.windowHours}h: 0 findings, 0 errors`,
            bound: GATE_BOUND,
          },
        }),
    data: {
      check: 'rate-limit-telemetry-health',
      windowHours: report.windowHours,
      sinceIso: report.sinceIso,
      scanned: report.counts,
      findings: report.findings.slice(0, GATE_FINDING_LIMIT).map((p) => ({
        agentGroup: p.agentGroup,
        credentialSet: p.credentialSet,
        verdict: p.verdict,
        pushRows: p.pushRows,
        pullRows: p.pullRows,
        lastPullEver: p.lastPullEver,
      })),
      findingsTruncated: Math.max(0, report.findings.length - GATE_FINDING_LIMIT),
      errors: report.errors.slice(0, GATE_FINDING_LIMIT),
      errorsTruncated: Math.max(0, report.errors.length - GATE_FINDING_LIMIT),
    },
  };
}

export function formatHumanReport(report: TelemetryHealthReport, timezone: string): string {
  const out: string[] = [];
  const at = (iso: string | null): string => (iso ? formatLocalTime(iso, timezone) : 'never');

  out.push(`rate-limit telemetry read-path health — window ${report.windowHours}h`);
  out.push(`  root      ${report.sessionsRoot}`);
  out.push(`  window    ${at(report.sinceIso)} → ${at(report.generatedAt)} (${timezone})`);
  out.push(
    `  scanned   ${report.counts.sessionDbs} session db(s) in ${report.counts.agentGroups} group(s): ` +
      `${report.counts.withTable} with the table, ${report.counts.noTable} predating it, ${report.counts.errored} unreadable, ` +
      `${report.counts.unlistableDirs} group dir(s) unlistable`,
  );
  out.push('');

  if (report.pairs.length === 0) {
    out.push('No (agent group, credential set) pair pushed rate-limit telemetry in the window.');
    out.push('Nothing is asserted about the read path: silence is not a symptom.');
  } else {
    out.push('pairs with push activity in the window:');
    for (const p of report.pairs) {
      const mark = p.verdict === 'ok' ? '  ok  ' : p.verdict === 'never' ? ' NEVER' : ' STALE';
      out.push(
        `${mark}  ${p.agentGroup}  credential_set=${p.credentialSet ?? '(null)'}  ` +
          `push=${p.pushRows} pull=${p.pullRows} sessions=${p.pushingSessions}  last pull ${at(p.lastPullEver)}`,
      );
    }
  }

  if (report.findings.length > 0) {
    out.push('');
    out.push(
      `${report.findings.length} finding(s): the reading path landed no sample while the push path kept writing.`,
    );
    out.push('  NEVER = no usage_pull / rate_limit_headers row has ever existed for that pair (the #817 shape).');
    out.push('  STALE = readings landed before the window but none inside it.');
  }

  if (report.errors.length > 0) {
    out.push('');
    out.push(`${report.errors.length} scan error(s) — these are NOT zero rows:`);
    for (const e of report.errors) out.push(`  ${e.code}  ${e.path}  ${e.detail}`);
  }

  return out.join('\n');
}

interface CliOptions {
  sessionsRoot: string;
  windowHours: number;
  minPushes: number;
  format: 'human' | 'json' | 'gate';
}

const USAGE = `Usage: pnpm exec tsx scripts/rate-limit-telemetry-health.ts [options]

  --window-hours <n>   Lookback for push/pull activity (default ${DEFAULT_WINDOW_HOURS}).
  --min-pushes <n>     Push rows a pair needs before it is judged (default 1).
  --sessions-root <p>  Sessions root (default <DATA_DIR>/v2-sessions).
  --json               Machine-readable report, ISO timestamps.
  --gate               Emit the host-gated task-script line {wakeAgent, data}.
  --help

Exit: ${EXIT_OK} the scan ran, ${EXIT_SCAN_FAILED} it could not run, ${EXIT_USAGE} bad invocation.`;

export function parseArgs(argv: string[]): CliOptions | { usageError: string } | { help: true } {
  const opts: CliOptions = {
    sessionsRoot: path.join(DATA_DIR, 'v2-sessions'),
    windowHours: DEFAULT_WINDOW_HOURS,
    minPushes: 1,
    format: 'human',
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    i += 1;
    const needValue = (): string | null => {
      const v = argv[i];
      if (v === undefined || v.startsWith('--')) return null;
      i += 1;
      return v;
    };
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--json') {
      opts.format = 'json';
    } else if (arg === '--gate') {
      opts.format = 'gate';
    } else if (arg === '--window-hours' || arg === '--min-pushes') {
      const raw = needValue();
      if (raw === null || !/^\d+$/.test(raw) || Number(raw) <= 0) {
        return { usageError: `${arg} requires a positive integer` };
      }
      if (arg === '--window-hours') opts.windowHours = Number(raw);
      else opts.minPushes = Number(raw);
    } else if (arg === '--sessions-root') {
      const raw = needValue();
      if (raw === null || raw === '') return { usageError: '--sessions-root requires a path' };
      opts.sessionsRoot = raw;
    } else {
      return { usageError: `unknown argument: ${arg}` };
    }
  }
  return opts;
}

export function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  if ('help' in parsed) {
    console.log(USAGE);
    return EXIT_OK;
  }
  if ('usageError' in parsed) {
    console.error(`${parsed.usageError}\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  const now = new Date();
  let report: TelemetryHealthReport;
  try {
    if (!fs.statSync(parsed.sessionsRoot).isDirectory()) {
      throw new Error(`not a directory: ${parsed.sessionsRoot}`);
    }
    report = scanRateLimitTelemetry({
      sessionsRoot: parsed.sessionsRoot,
      sinceIso: windowStart(parsed.windowHours, now),
      windowHours: parsed.windowHours,
      minPushes: parsed.minPushes,
      now,
    });
  } catch (err) {
    // A broken checker must still wake someone and exit 0: a non-zero exit makes the host
    // discard the fire entirely, which is silence again.
    if (parsed.format === 'gate') {
      console.log(
        JSON.stringify({
          wakeAgent: true,
          data: { check: 'rate-limit-telemetry-health', scanError: errorDetail(err) },
        }),
      );
      return EXIT_OK;
    }
    console.error(`rate-limit telemetry scan failed: ${errorDetail(err)}`);
    return EXIT_SCAN_FAILED;
  }

  if (parsed.format === 'json') console.log(JSON.stringify(report, null, 2));
  else if (parsed.format === 'gate') console.log(JSON.stringify(gateResult(report)));
  else console.log(formatHumanReport(report, TIMEZONE));
  return EXIT_OK;
}

if (process.argv[1] && new URL(process.argv[1], 'file:').href === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
