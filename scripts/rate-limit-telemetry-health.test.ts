/**
 * The fixture tree is built from the PRODUCTION DDL text
 * (`RATE_LIMIT_SAMPLES_DDL`, read out of the runner's schema.ts rather than
 * transcribed), so a column rename on the writing side fails these tests
 * instead of passing against a hand-copied schema that agrees with the
 * scanner's own assumptions. That is the shape #817 slipped through: a fixture
 * mirroring the code's own belief proves only that the code agrees with
 * itself.
 */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  formatHumanReport,
  gateResult,
  main,
  parseArgs,
  scanRateLimitTelemetry,
  windowStart,
  type TelemetryHealthReport,
} from './rate-limit-telemetry-health.js';

const RUNNER_SCHEMA = path.resolve(
  import.meta.dirname,
  '../container/agent-runner/src/modules/mailbox/schema.ts',
);

/**
 * Extract the production DDL. A failure here is loud on purpose: silently
 * falling back to a transcribed CREATE TABLE would reintroduce exactly the
 * self-agreeing fixture this file exists to avoid.
 */
function productionDdl(): string {
  const source = fs.readFileSync(RUNNER_SCHEMA, 'utf8');
  const match = /export const RATE_LIMIT_SAMPLES_DDL = `([\s\S]*?)`;/.exec(source);
  if (!match) throw new Error(`RATE_LIMIT_SAMPLES_DDL not found in ${RUNNER_SCHEMA}`);
  return match[1];
}

const DDL = productionDdl();

/** Fixed clock so window arithmetic in the tests is exact, not "about now". */
const NOW = new Date('2026-09-15T04:00:00.000Z');
const WINDOW_HOURS = 24;
const SINCE = windowStart(WINDOW_HOURS, NOW); // 2026-09-14T04:00:00.000Z

const TEMP_ROOTS: string[] = [];

afterEach(() => {
  for (const root of TEMP_ROOTS.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = globalThis.uniqueTmpRoot('rate-limit-telemetry-health');
  fs.mkdirSync(root, { recursive: true });
  TEMP_ROOTS.push(root);
  return root;
}

interface SampleRow {
  ts: string;
  source: 'usage_pull' | 'rate_limit_event';
  credentialSet?: string | null;
  limitType?: string | null;
  status?: string | null;
}

function sessionDir(root: string, group: string, session: string): string {
  const dir = path.join(root, group, session);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A session DB carrying the production table and the given rows. */
function writeSessionDb(root: string, group: string, session: string, rows: SampleRow[]): string {
  const file = path.join(sessionDir(root, group, session), 'outbound.db');
  const db = new Database(file);
  db.exec(DDL);
  const stmt = db.prepare(
    `INSERT INTO rate_limit_samples (ts, source, account, credential_set, lane, subscription_type, available, limit_type, utilization, resets_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(
      r.ts,
      r.source,
      'CLAUDE_CODE_OAUTH_TOKEN',
      r.credentialSet === undefined ? 'codex:.codex' : r.credentialSet,
      null,
      null,
      r.limitType ?? 'seven_day',
      0.5,
      '2026-09-22T01:30:07.000Z',
      r.status ?? null,
    );
  }
  db.close();
  return file;
}

/** A session DB that predates the table — the third state, not an error. */
function writeTablelessSessionDb(root: string, group: string, session: string): string {
  const file = path.join(sessionDir(root, group, session), 'outbound.db');
  const db = new Database(file);
  db.exec('CREATE TABLE session_state (key TEXT PRIMARY KEY, value TEXT)');
  db.close();
  return file;
}

function scan(root: string, overrides: Partial<Parameters<typeof scanRateLimitTelemetry>[0]> = {}): TelemetryHealthReport {
  return scanRateLimitTelemetry({
    sessionsRoot: root,
    sinceIso: SINCE,
    windowHours: WINDOW_HOURS,
    minPushes: 1,
    now: NOW,
    ...overrides,
  });
}

function pairFor(report: TelemetryHealthReport, group: string): TelemetryHealthReport['pairs'][number] | undefined {
  return report.pairs.find((p) => p.agentGroup === group);
}

describe('scanRateLimitTelemetry — the asymmetry', () => {
  it('fires on the broken shape: push rows inside the window, no pull row ever', () => {
    const root = makeRoot();
    writeSessionDb(root, 'group-broken', 'sess-1', [
      { ts: '2026-09-15T01:40:00.000Z', source: 'rate_limit_event' },
      { ts: '2026-09-15T02:10:00.000Z', source: 'rate_limit_event' },
      { ts: '2026-09-15T03:20:00.000Z', source: 'rate_limit_event' },
    ]);

    const report = scan(root);

    expect(report.findings).toHaveLength(1);
    const [finding] = report.findings;
    expect(finding.agentGroup).toBe('group-broken');
    expect(finding.verdict).toBe('never');
    expect(finding.pushRows).toBe(3);
    expect(finding.pullRows).toBe(0);
    expect(finding.lastPullEver).toBeNull();
    expect(finding.pushingSessions).toBe(1);
    expect(report.errors).toEqual([]);
  });

  it('stays silent on the healthy shape: both paths landed rows in the window', () => {
    const root = makeRoot();
    writeSessionDb(root, 'group-healthy', 'sess-1', [
      { ts: '2026-09-15T01:30:00.000Z', source: 'usage_pull' },
      { ts: '2026-09-15T01:40:00.000Z', source: 'rate_limit_event' },
      { ts: '2026-09-15T03:20:00.000Z', source: 'rate_limit_event' },
    ]);

    const report = scan(root);

    expect(report.findings).toEqual([]);
    expect(pairFor(report, 'group-healthy')?.verdict).toBe('ok');
  });

  it('counts a pull that came back unsampled as the read path working', () => {
    // A usage_pull row with a non-null status is a real landed sample that
    // carries no reading (schema.ts:103-112). The read path is alive; whether
    // the READING is usable is a different defect, deliberately out of scope.
    const root = makeRoot();
    writeSessionDb(root, 'group-unsampled', 'sess-1', [
      { ts: '2026-09-15T01:30:00.000Z', source: 'usage_pull', limitType: null, status: 'not_applicable' },
      { ts: '2026-09-15T01:40:00.000Z', source: 'rate_limit_event' },
    ]);

    expect(scan(root).findings).toEqual([]);
  });

  it('does NOT fire on a group with neither kind of row — silence is not a symptom', () => {
    const root = makeRoot();
    writeSessionDb(root, 'group-idle', 'sess-1', []);
    writeSessionDb(root, 'group-opencode', 'sess-1', []);

    const report = scan(root);

    expect(report.pairs).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(report.counts.withTable).toBe(2);
  });

  it('does NOT fire on pull-only activity — nothing is pushing to be asymmetric with', () => {
    const root = makeRoot();
    writeSessionDb(root, 'group-pull-only', 'sess-1', [{ ts: '2026-09-15T01:30:00.000Z', source: 'usage_pull' }]);

    expect(scan(root).pairs).toEqual([]);
  });

  it('separates STALE (pulls exist, none in the window) from NEVER', () => {
    const root = makeRoot();
    writeSessionDb(root, 'group-stale', 'sess-1', [
      { ts: '2026-09-12T09:00:00.000Z', source: 'usage_pull' },
      { ts: '2026-09-15T01:40:00.000Z', source: 'rate_limit_event' },
    ]);
    writeSessionDb(root, 'group-never', 'sess-1', [{ ts: '2026-09-15T01:40:00.000Z', source: 'rate_limit_event' }]);

    const report = scan(root);

    expect(pairFor(report, 'group-stale')?.verdict).toBe('stale');
    expect(pairFor(report, 'group-stale')?.lastPullEver).toBe('2026-09-12T09:00:00.000Z');
    expect(pairFor(report, 'group-never')?.verdict).toBe('never');
    // NEVER outranks STALE in the report ordering.
    expect(report.findings.map((f) => f.agentGroup)).toEqual(['group-never', 'group-stale']);
  });

  it('judges each credential set separately inside one agent group', () => {
    // The live shape of a fallback group: Claude healthy, Codex read-path dead.
    const root = makeRoot();
    writeSessionDb(root, 'group-mixed', 'sess-claude', [
      { ts: '2026-09-15T01:00:00.000Z', source: 'usage_pull', credentialSet: 'global' },
      { ts: '2026-09-15T01:10:00.000Z', source: 'rate_limit_event', credentialSet: 'global' },
    ]);
    writeSessionDb(root, 'group-mixed', 'sess-codex', [
      { ts: '2026-09-15T02:00:00.000Z', source: 'rate_limit_event', credentialSet: 'codex:.codex' },
    ]);

    const report = scan(root);

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].credentialSet).toBe('codex:.codex');
    expect(report.pairs.find((p) => p.credentialSet === 'global')?.verdict).toBe('ok');
  });

  it('aggregates sessions within a pair: one session that pulled clears the pair', () => {
    // A pull happens at bind, a push on every turn, so a still-running session
    // legitimately pushes without pulling again. The pair is the unit.
    const root = makeRoot();
    writeSessionDb(root, 'group-multi', 'sess-long-running', [
      { ts: '2026-09-15T01:00:00.000Z', source: 'rate_limit_event' },
      { ts: '2026-09-15T02:00:00.000Z', source: 'rate_limit_event' },
    ]);
    writeSessionDb(root, 'group-multi', 'sess-fresh', [
      { ts: '2026-09-15T03:00:00.000Z', source: 'usage_pull' },
      { ts: '2026-09-15T03:05:00.000Z', source: 'rate_limit_event' },
    ]);

    const report = scan(root);

    expect(report.findings).toEqual([]);
    const pair = pairFor(report, 'group-multi');
    expect(pair?.pushRows).toBe(3);
    expect(pair?.pullRows).toBe(1);
    expect(pair?.pushingSessions).toBe(2);
  });

  it('honours --min-pushes as a floor on judging a pair at all', () => {
    const root = makeRoot();
    writeSessionDb(root, 'group-quiet', 'sess-1', [{ ts: '2026-09-15T01:40:00.000Z', source: 'rate_limit_event' }]);

    expect(scan(root, { minPushes: 1 }).findings).toHaveLength(1);
    expect(scan(root, { minPushes: 2 }).findings).toEqual([]);
    expect(scan(root, { minPushes: 2 }).pairs).toEqual([]);
  });
});

describe('scanRateLimitTelemetry — the window boundary', () => {
  it('includes a row exactly at the boundary and excludes the one before it', () => {
    const root = makeRoot();
    writeSessionDb(root, 'group-at-edge', 'sess-1', [
      { ts: SINCE, source: 'rate_limit_event' },
      { ts: '2026-09-14T03:59:59.000Z', source: 'rate_limit_event' },
    ]);

    const pair = pairFor(scan(root), 'group-at-edge');

    expect(pair?.pushRows).toBe(1);
    expect(pair?.lastPushInWindow).toBe(SINCE);
  });

  it('a pull one second before the window does not clear a pair pushing inside it', () => {
    const root = makeRoot();
    writeSessionDb(root, 'group-edge-pull', 'sess-1', [
      { ts: '2026-09-14T03:59:59.000Z', source: 'usage_pull' },
      { ts: '2026-09-15T01:00:00.000Z', source: 'rate_limit_event' },
    ]);

    const report = scan(root);

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].verdict).toBe('stale');
  });

  it('a pull exactly at the boundary DOES clear it', () => {
    const root = makeRoot();
    writeSessionDb(root, 'group-edge-pull-ok', 'sess-1', [
      { ts: SINCE, source: 'usage_pull' },
      { ts: '2026-09-15T01:00:00.000Z', source: 'rate_limit_event' },
    ]);

    expect(scan(root).findings).toEqual([]);
  });

  it('a wider window re-admits push rows the default window excluded', () => {
    const root = makeRoot();
    writeSessionDb(root, 'group-old', 'sess-1', [{ ts: '2026-09-13T12:00:00.000Z', source: 'rate_limit_event' }]);

    expect(scan(root).pairs).toEqual([]);
    expect(scan(root, { sinceIso: windowStart(72, NOW), windowHours: 72 }).findings).toHaveLength(1);
  });
});

describe('scanRateLimitTelemetry — a failure is never a zero', () => {
  it('reports a corrupt session DB as an error, not as "no rows"', () => {
    const root = makeRoot();
    writeSessionDb(root, 'group-corrupt', 'sess-good', [
      { ts: '2026-09-15T01:00:00.000Z', source: 'usage_pull' },
      { ts: '2026-09-15T01:05:00.000Z', source: 'rate_limit_event' },
    ]);
    const corrupt = path.join(sessionDir(root, 'group-corrupt', 'sess-bad'), 'outbound.db');
    fs.writeFileSync(corrupt, 'this is not a sqlite database at all');

    const report = scan(root);

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({ session: 'group-corrupt/sess-bad', code: 'query_failed' });
    expect(report.counts.errored).toBe(1);
    // The unreadable DB is NOT folded into the healthy count…
    expect(report.counts.withTable).toBe(1);
    expect(report.counts.sessionDbs).toBe(2);
    // …and it does not silently turn the readable pair's verdict into anything.
    expect(report.findings).toEqual([]);
  });

  it('reports an open failure separately from a query failure', () => {
    const root = makeRoot();
    writeSessionDb(root, 'group-open-fail', 'sess-1', [{ ts: '2026-09-15T01:00:00.000Z', source: 'rate_limit_event' }]);

    const report = scan(root, {
      openDb: () => {
        throw new Error('EACCES: permission denied');
      },
    });

    expect(report.errors).toEqual([
      { session: 'group-open-fail/sess-1', code: 'unreadable', detail: 'Error: EACCES: permission denied' },
    ]);
    expect(report.counts.errored).toBe(1);
    expect(report.counts.withTable).toBe(0);
    // The push rows were never read, so nothing is asserted about the pair —
    // an unreadable DB must not manufacture a finding either.
    expect(report.findings).toEqual([]);
  });

  it('counts a session DB predating the table as its own state, not an error', () => {
    const root = makeRoot();
    writeTablelessSessionDb(root, 'group-old-schema', 'sess-1');

    const report = scan(root);

    expect(report.counts.noTable).toBe(1);
    expect(report.counts.withTable).toBe(0);
    expect(report.counts.errored).toBe(0);
    expect(report.errors).toEqual([]);
    expect(report.findings).toEqual([]);
  });

  it('reports rows whose ts SQLite cannot parse instead of dropping them silently', () => {
    const root = makeRoot();
    writeSessionDb(root, 'group-bad-ts', 'sess-1', [
      { ts: 'not-a-timestamp', source: 'usage_pull' },
      { ts: '2026-09-15T01:00:00.000Z', source: 'rate_limit_event' },
    ]);

    const report = scan(root);

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].code).toBe('unparsable_timestamps');
    expect(report.errors[0].session).toBe('group-bad-ts/sess-1');
    // The unparsable pull row is excluded from the counts, so the pair still
    // reads as broken — but the operator is told the row was dropped.
    expect(report.findings).toHaveLength(1);
  });

  it('ignores a session directory with no outbound.db at all', () => {
    const root = makeRoot();
    sessionDir(root, 'group-empty', 'sess-1');

    const report = scan(root);

    expect(report.counts.sessionDbs).toBe(0);
    expect(report.counts.agentGroups).toBe(1);
    expect(report.errors).toEqual([]);
  });
});

describe('gateResult — the host-gated task-script contract', () => {
  it('wakes on a finding and carries it in data', () => {
    const root = makeRoot();
    writeSessionDb(root, 'group-broken', 'sess-1', [{ ts: '2026-09-15T01:00:00.000Z', source: 'rate_limit_event' }]);

    const gate = gateResult(scan(root));

    expect(gate.wakeAgent).toBe(true);
    expect(JSON.parse(JSON.stringify(gate)).data.findings[0]).toMatchObject({
      agentGroup: 'group-broken',
      verdict: 'never',
    });
  });

  it('does not wake on a healthy fleet', () => {
    const root = makeRoot();
    writeSessionDb(root, 'group-healthy', 'sess-1', [
      { ts: '2026-09-15T01:00:00.000Z', source: 'usage_pull' },
      { ts: '2026-09-15T01:05:00.000Z', source: 'rate_limit_event' },
    ]);

    expect(gateResult(scan(root)).wakeAgent).toBe(false);
  });

  it('wakes on scan errors even when no pair is broken', () => {
    const root = makeRoot();
    writeSessionDb(root, 'group-healthy', 'sess-1', [
      { ts: '2026-09-15T01:00:00.000Z', source: 'usage_pull' },
      { ts: '2026-09-15T01:05:00.000Z', source: 'rate_limit_event' },
    ]);
    fs.writeFileSync(path.join(sessionDir(root, 'group-healthy', 'sess-bad'), 'outbound.db'), 'garbage');

    const gate = gateResult(scan(root));

    expect(gate.wakeAgent).toBe(true);
    expect(JSON.parse(JSON.stringify(gate)).data.errors).toHaveLength(1);
  });
});

describe('CLI', () => {
  function capture(fn: () => number): { code: number; out: string; err: string } {
    const outChunks: string[] = [];
    const errChunks: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => outChunks.push(args.map(String).join(' '));
    console.error = (...args: unknown[]) => errChunks.push(args.map(String).join(' '));
    try {
      return { code: fn(), out: outChunks.join('\n'), err: errChunks.join('\n') };
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  }

  it('--gate prints exactly one JSON line carrying a boolean wakeAgent', () => {
    const root = makeRoot();
    writeSessionDb(root, 'group-broken', 'sess-1', [{ ts: new Date().toISOString(), source: 'rate_limit_event' }]);

    const { code, out } = capture(() => main(['--sessions-root', root, '--gate']));

    expect(code).toBe(0);
    const lines = out.trim().split('\n');
    const parsed = JSON.parse(lines[lines.length - 1]);
    expect(typeof parsed.wakeAgent).toBe('boolean');
    expect(parsed.wakeAgent).toBe(true);
  });

  it('--gate on a broken scan still exits 0 and still wakes', () => {
    // A non-zero exit makes the host discard the fire (host-script.ts:386-389),
    // which is the same silence this check exists to end.
    const { code, out } = capture(() => main(['--sessions-root', '/nonexistent/sessions/root', '--gate']));

    expect(code).toBe(0);
    const parsed = JSON.parse(out.trim().split('\n').pop() as string);
    expect(parsed.wakeAgent).toBe(true);
    expect(parsed.data.scanError).toMatch(/nonexistent/);
  });

  it('a missing sessions root without --gate exits 1, not 0', () => {
    const { code, err } = capture(() => main(['--sessions-root', '/nonexistent/sessions/root']));

    expect(code).toBe(1);
    expect(err).toMatch(/scan failed/);
  });

  it('--json emits the report with ISO timestamps', () => {
    const root = makeRoot();
    writeSessionDb(root, 'group-broken', 'sess-1', [{ ts: new Date().toISOString(), source: 'rate_limit_event' }]);

    const { code, out } = capture(() => main(['--sessions-root', root, '--json']));

    expect(code).toBe(0);
    const report = JSON.parse(out) as TelemetryHealthReport;
    expect(report.findings[0].agentGroup).toBe('group-broken');
    expect(report.sinceIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(report.generatedAt).toMatch(/Z$/);
  });

  it('a bad invocation exits 2, the usage code — never 1', () => {
    for (const argv of [
      ['--window-hours'],
      ['--window-hours', '0'],
      ['--window-hours', 'soon'],
      ['--window-hours', '--json'],
      ['--min-pushes', '-1'],
      ['--sessions-root'],
      ['--nope'],
    ]) {
      const { code } = capture(() => main(argv));
      expect(code, `argv ${JSON.stringify(argv)}`).toBe(2);
    }
  });

  it('parses the documented flags', () => {
    expect(parseArgs(['--window-hours', '72', '--min-pushes', '5', '--sessions-root', '/tmp/x', '--json'])).toEqual({
      sessionsRoot: '/tmp/x',
      windowHours: 72,
      minPushes: 5,
      format: 'json',
    });
  });

  it('--help exits 0', () => {
    expect(capture(() => main(['--help'])).code).toBe(0);
  });
});

describe('formatHumanReport', () => {
  it('names the findings and reports scan errors in their own section', () => {
    const root = makeRoot();
    writeSessionDb(root, 'group-broken', 'sess-1', [{ ts: '2026-09-15T01:00:00.000Z', source: 'rate_limit_event' }]);
    fs.writeFileSync(path.join(sessionDir(root, 'group-broken', 'sess-bad'), 'outbound.db'), 'garbage');

    const text = formatHumanReport(scan(root), 'UTC');

    expect(text).toContain('NEVER');
    expect(text).toContain('group-broken');
    expect(text).toContain('1 finding(s)');
    expect(text).toContain('1 scan error(s)');
    expect(text).toContain('query_failed');
  });

  it('says plainly that nothing is asserted when no pair pushed', () => {
    const root = makeRoot();
    writeSessionDb(root, 'group-idle', 'sess-1', []);

    const text = formatHumanReport(scan(root), 'UTC');

    expect(text).toContain('silence is not a symptom');
    expect(text).not.toContain('finding(s)');
  });
});
