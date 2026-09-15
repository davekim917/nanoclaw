/**
 * Read-path health for rate-limit telemetry (`rate_limit_samples`).
 *
 * WHY THIS EXISTS. `rate_limit_samples` is written by two independent paths
 * (`container/agent-runner/src/modules/mailbox/rate-limit-samples.ts:20`):
 *
 *   - `rate_limit_event` — a PUSH. The provider volunteers it mid-turn.
 *   - `usage_pull`       — a PULL. The runner asks, at bind and on a throttle.
 *
 * Both are deliberately fail-open telemetry: a failed pull logs and writes
 * NOTHING. Claude's `samplePlanUsage` only `.catch(log)`s
 * (`container/agent-runner/src/providers/claude.ts:300-301`), its per-slot pick
 * returns `samples: null` on a throw
 * (`container/agent-runner/src/providers/claude.ts:2352-2354`), and Codex's
 * tracker never reaches its `record` call when the read rejects
 * (`container/agent-runner/src/providers/codex-rate-limit-tracker.ts:232`).
 * Container logs then vanish with the container (`--rm`).
 *
 * So a dead read path leaves no error anywhere a human will meet by accident,
 * and the push path keeps the table looking alive. That is exactly what
 * happened on 2026-09-15: the container's codex-cli (0.153.4,
 * `container/Dockerfile:41`) rejected the params map #812 built against the
 * host's 0.154.0 schema, and for two hours the fleet wrote 408 push rows and
 * zero pull rows with nothing surfacing it (#817).
 *
 * THE SIGNAL is that asymmetry, scoped to the unit the credentials belong to:
 * an (agent group, `credential_set`) pair that is PUSHING inside the window
 * but has landed NO pull row in it. `credential_set` is the discriminator the
 * rows already carry — `codex:<home>` for Codex, `global` / `group:<folder>`
 * for Claude (schema.ts:85-88) — so one rule covers both providers without
 * this script knowing anything about provider configuration.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *   - It does not fire on silence. A pair with no push rows in the window is
 *     reported as nothing at all: an idle group, an OpenCode group (which
 *     writes neither kind of row), and a fleet that is merely quiet are
 *     indistinguishable from here, and none of them is a symptom.
 *   - It does not judge the CONTENT of a pull row. A pull that lands but comes
 *     back `unsampled`/`not_applicable` (schema.ts:103-112) counts as the read
 *     path working; the #811 HTTP-429 shape is a different defect with a
 *     different remedy, and rows exist for it to be queried directly.
 *   - It does not read the central DB, `container.json`, or any provider
 *     config, and it never restarts, kills or reconfigures anything.
 *
 * ERRORS ARE NEVER ZEROS — and that covers the FILESYSTEM walk, not just the
 * DB reads. A group directory that cannot be listed, an `outbound.db` path
 * that cannot be stat'd, a DB that cannot be opened, and a query that fails
 * are each counted and listed under their own code, separately from "no rows".
 * None of them may resolve to a silent skip: a swallowed failure reading as
 * health is the whole defect this check exists to catch, and it is just as
 * fatal in the scanner as in the thing scanned. An unlistable sessions ROOT is
 * a hard failure rather than a finding — see `scanRateLimitTelemetry`. A DB
 * with no `rate_limit_samples` table at all is a third state again (`noTable`):
 * every session predating the table has one, and it is evidence of nothing.
 *
 * Opens are `readonly` + `PRAGMA query_only=ON`. A read-only open never
 * replays a rollback journal, so this cannot alter a session DB the way a
 * read-write open could (the class in `docs/review-notes.md`, #735/#761).
 */
/* eslint-disable no-catch-all/no-catch-all -- an unreadable or malformed session DB must become an explicit counted error, never a silent zero; that is the defect this script exists to catch */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { DATA_DIR, TIMEZONE } from '../src/config.js';
import { formatLocalTime } from '../src/timezone.js';

/** Default lookback. One day is the bar the failure class is judged against. */
const DEFAULT_WINDOW_HOURS = 24;

/** Exit codes. 2 is usage; 1 is "the scan could not run"; 0 is "it ran". */
const EXIT_OK = 0;
const EXIT_SCAN_FAILED = 1;
const EXIT_USAGE = 2;

/** Cap on findings embedded in `--gate` data, which is injected into a prompt. */
const GATE_FINDING_LIMIT = 20;

export type PairVerdict =
  /** Push rows in the window, and no pull row has EVER landed for this pair. */
  | 'never'
  /** Push rows in the window, none pulled in it, but pulls landed before it. */
  | 'stale'
  /** Both paths landed rows in the window. */
  | 'ok';

export interface TelemetryPair {
  /** Sessions-root subdirectory — the agent group id, per `sessionDir()`. */
  agentGroup: string;
  /** `credential_set` as stored; null when the host did not say. */
  credentialSet: string | null;
  verdict: PairVerdict;
  /** `rate_limit_event` rows in the window. */
  pushRows: number;
  /** `usage_pull` rows in the window. */
  pullRows: number;
  /** Most recent `usage_pull` row of any age, or null if none exists. */
  lastPullEver: string | null;
  /** Most recent `rate_limit_event` row in the window. */
  lastPushInWindow: string | null;
  /** Session DBs that contributed a push row in the window. */
  pushingSessions: number;
}

export type ScanErrorCode =
  /** A group directory could not be listed — every session under it is invisible. */
  | 'group_unlistable'
  /** An `outbound.db` path could not be stat'd for a reason other than ENOENT. */
  | 'db_unstattable'
  /** The DB exists but could not be opened. */
  | 'unreadable'
  /** The DB opened but a query failed. */
  | 'query_failed'
  /** Rows whose `ts` SQLite cannot parse, dropped from both counts. */
  | 'unparsable_timestamps';

export interface TelemetryScanError {
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
    /** Session directories holding an `outbound.db`. */
    sessionDbs: number;
    /** …of those, ones carrying a `rate_limit_samples` table. */
    withTable: number;
    /** …of those, ones predating the table. Not an error, not a symptom. */
    noTable: number;
    /** DB paths that failed to stat, open or query. Never folded into a zero. */
    errored: number;
    /** Group directories that could not be listed — a blind spot, not an absence. */
    unlistableDirs: number;
  };
  /** Every pair with push activity in the window, `never`/`stale` first. */
  pairs: TelemetryPair[];
  /** The subset with a non-`ok` verdict. */
  findings: TelemetryPair[];
  errors: TelemetryScanError[];
}

/** Injected in tests so an open failure can be provoked deterministically. */
export type OpenSessionDb = (file: string) => Database.Database;

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

/**
 * Both sides of the comparison go through `datetime()` per the house rule
 * (CLAUDE.md, Timestamps). That rule has one sharp edge: `datetime()` answers
 * NULL for a value it cannot parse, and `NULL >= x` is false, so a malformed
 * `ts` would drop out of both counts and read as "no rows". `unparsable` is
 * selected alongside so it becomes an error instead.
 */
const PER_SESSION_SQL = `
  SELECT credential_set,
         SUM(CASE WHEN source = 'rate_limit_event' AND datetime(ts) >= datetime(?) THEN 1 ELSE 0 END) AS push_rows,
         SUM(CASE WHEN source = 'usage_pull'       AND datetime(ts) >= datetime(?) THEN 1 ELSE 0 END) AS pull_rows,
         MAX(CASE WHEN source = 'usage_pull'       THEN ts END)                                       AS last_pull_ever,
         MAX(CASE WHEN source = 'rate_limit_event' AND datetime(ts) >= datetime(?) THEN ts END)       AS last_push_in_window
    FROM rate_limit_samples
   GROUP BY credential_set
`;

const UNPARSABLE_TS_SQL = `SELECT COUNT(*) AS n FROM rate_limit_samples WHERE datetime(ts) IS NULL`;

const TABLE_PRESENT_SQL = `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rate_limit_samples'`;

type DirListing = { names: string[] } | { error: string };

/**
 * THE ONE PLACE A DIRECTORY IS LISTED. Every caller goes through here, so the
 * accounting cannot drift back out to individual call sites.
 *
 * It answers a discriminated union, never a bare array, because `[]` and
 * "could not look" must not be the same value. A `catch { return [] }` here
 * makes an unlistable directory report as an empty one: zero groups, zero
 * errors, no findings, and a gate that says healthy — the precise failure this
 * script exists to catch, one level up. Measured on this host at uid 1001:
 * `readdirSync` on a 0o000 directory throws EACCES.
 *
 * A symlinked entry is kept as a candidate rather than filtered away: if it
 * resolves to a directory it is a real group/session, and if it does not, the
 * listing or stat that follows fails LOUDLY (ENOTDIR) instead of vanishing.
 * A plain file is not a candidate and is not an error — it is structurally not
 * a group or a session directory.
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
 * Does this session hold an `outbound.db`?
 *
 * `statSync`, NOT `fs.existsSync`: existsSync answers `false` for every
 * failure, so an EACCES on a session directory nobody can traverse is
 * indistinguishable from a session that simply has no DB, and the file is
 * skipped before the open handler could ever count it (measured at uid 1001:
 * existsSync → false, statSync → EACCES). ENOENT is the only genuine "no" —
 * plenty of session directories legitimately hold no outbound.db.
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
 * Field separator for the composite pair key, written as an ESCAPE and never
 * as a literal NUL byte. NUL is the right separator — no agent-group id or
 * `credential_set` can contain one, where a space could collide — but a
 * literal one in the source makes this file binary to `grep` and `rg`, which
 * then return nothing over it and look like a clean search. That happened to
 * this very file during development.
 */
const KEY_SEP = '\u0000';

/** A literal 'null' credential_set and a SQL NULL must not collapse together. */
function pairKey(agentGroup: string, credentialSet: string | null): string {
  return `${agentGroup}${KEY_SEP}${credentialSet === null ? 'n' : `s:${credentialSet}`}`;
}

/** Newest-first within a verdict; `never` before `stale` before `ok`. */
const VERDICT_ORDER: Record<PairVerdict, number> = { never: 0, stale: 1, ok: 2 };

/**
 * Walk `<sessionsRoot>/<agent group>/<session>/outbound.db`, exactly the two
 * levels `sessionDir()` writes (`src/session-manager.ts:64-66`).
 */
export function scanRateLimitTelemetry(options: ScanOptions): TelemetryHealthReport {
  const { sessionsRoot, sinceIso, windowHours, minPushes } = options;
  const openDb = options.openDb ?? openReadOnly;
  const generatedAt = (options.now ?? new Date()).toISOString();

  const errors: TelemetryScanError[] = [];
  const pairs = new Map<string, { credentialSet: string | null; agentGroup: string; acc: PairAccumulator }>();
  const counts = { agentGroups: 0, sessionDbs: 0, withTable: 0, noTable: 0, errored: 0, unlistableDirs: 0 };

  // A ROOT THAT CANNOT BE LISTED IS A HARD FAILURE, not a finding. Every other
  // failure here costs coverage of one group or one session and leaves a real
  // report around it; an unlistable root leaves NO coverage at all, so every
  // statement the report could make is vacuous. Rendering that as "0 groups
  // scanned, 0 findings, 1 error" invites exactly the misreading this script
  // exists to end, so it throws and `main` routes it to a non-zero exit — or,
  // under `--gate`, to wakeAgent:true, because a checker that breaks must still
  // wake someone.
  const rootListing = listSubdirectories(sessionsRoot);
  if ('error' in rootListing) {
    throw new Error(`sessions root is not listable: ${sessionsRoot} — ${rootListing.error}`);
  }

  for (const agentGroup of rootListing.names) {
    counts.agentGroups += 1;
    const groupDir = path.join(sessionsRoot, agentGroup);

    const groupListing = listSubdirectories(groupDir);
    if ('error' in groupListing) {
      // One unlistable group hides every session DB beneath it. Counted and
      // named, never passed off as a group with no sessions.
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
        // Counted only once every read this session owes has succeeded, so a
        // half-read DB lands in `errored` and never in `withTable`.
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
    // Silence is not a symptom: a pair the window never saw push is dropped.
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

/** ISO-8601 UTC lower bound for a window of `hours` ending at `now`. */
export function windowStart(hours: number, now: Date = new Date()): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

// ── Output ──────────────────────────────────────────────────────────────────

/**
 * The host-gated task-script contract: the LAST stdout line is
 * `{wakeAgent, data}` (`src/modules/scheduling/host-script.ts:392-404`).
 *
 * A failed scan wakes too. A telemetry checker that goes quiet when it breaks
 * would reproduce, one level up, the exact failure it was built to catch.
 */
export function gateResult(report: TelemetryHealthReport): { wakeAgent: boolean; data: unknown } {
  const wakeAgent = report.findings.length > 0 || report.errors.length > 0;
  return {
    wakeAgent,
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

/** Human report. Timestamps render in the install timezone (CLAUDE.md). */
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
    out.push(`${report.findings.length} finding(s): the pull path landed no sample while the push path kept writing.`);
    out.push('  NEVER = no usage_pull row has ever existed for that pair (the #817 shape).');
    out.push('  STALE = pulls landed before the window but none inside it.');
  }

  if (report.errors.length > 0) {
    out.push('');
    out.push(`${report.errors.length} scan error(s) — these are NOT zero rows:`);
    for (const e of report.errors) out.push(`  ${e.code}  ${e.path}  ${e.detail}`);
  }

  return out.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────

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
    // A value that is absent or is itself the next flag is NOT a value: it
    // must surface as a usage error rather than swallowing the next argument.
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
      // A flag whose value is missing or not a positive number is a USAGE
      // error, never a silent default — the `usage exit code` class.
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
    // In gate mode a broken checker must still wake someone, and must still
    // exit 0 — a non-zero exit makes the host discard the fire entirely
    // (host-script.ts:386-389), which is silence again.
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
