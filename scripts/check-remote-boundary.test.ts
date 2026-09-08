/**
 * The remote-boundary job's decision logic, exercised without git, a network,
 * a real Slack workspace or systemd. The IO half (fetch, snapshot worktree,
 * `pnpm run check:public-boundary`) is deliberately not covered here — it is a
 * few lines of subprocess plumbing around this decision, and faking it would
 * test the fake.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { enforceHermeticity } from '../src/test-hermeticity.js';
import {
  MAX_ALERT_LINES,
  cleanCheckerOutput,
  decideAlert,
  describeDelivery,
  reportScan,
  trimDetail,
  type Alert,
  type Reporter,
} from './check-remote-boundary.js';

enforceHermeticity();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A checker stderr with a finding, exactly as `check-public-boundary.ts` prints it. */
const FINDING = 'src/example.ts:12 identifier\npublic boundary check failed with 1 redacted finding(s) (index)';

interface Recorder extends Reporter {
  alerts: Alert[];
  logs: string[];
  errors: string[];
}

function recorder(deliveryCode: number): Recorder {
  const alerts: Alert[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    alerts,
    logs,
    errors,
    notify: (alert) => {
      alerts.push(alert);
      return Promise.resolve(deliveryCode);
    },
    log: (line) => logs.push(line),
    logError: (line) => errors.push(line),
  };
}

describe('cleanCheckerOutput', () => {
  it('drops Node runtime warnings and keeps every checker line', () => {
    const raw = [
      '(node:1325069) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.',
      '(Use `node --trace-warnings ...` to show where the warning was created)',
      'src/example.ts:12 identifier',
      'public boundary check failed with 1 redacted finding(s) (index, identifiers from local install)',
    ].join('\n');
    expect(cleanCheckerOutput(raw)).toBe(
      'src/example.ts:12 identifier\npublic boundary check failed with 1 redacted finding(s) (index, identifiers from local install)',
    );
  });

  it('keeps a checker message this file has not anticipated', () => {
    // The filter is two literal runtime shapes, not an allowlist of known
    // checker output — an unfamiliar message must still reach the owner.
    expect(cleanCheckerOutput('WARNING: install-aware checks are incomplete; missing install registry')).toBe(
      'WARNING: install-aware checks are incomplete; missing install registry',
    );
  });
});

describe('trimDetail', () => {
  it('passes a short detail through unchanged', () => {
    expect(trimDetail(FINDING)).toBe(FINDING);
  });

  it('caps a long detail and says how much was withheld', () => {
    const lines = Array.from({ length: MAX_ALERT_LINES + 7 }, (_, i) => `src/f${i}.ts:1 identifier`);
    const trimmed = trimDetail(lines.join('\n')).split('\n');
    expect(trimmed).toHaveLength(MAX_ALERT_LINES + 1);
    expect(trimmed[MAX_ALERT_LINES]).toContain('and 7 more line(s)');
  });
});

describe('decideAlert', () => {
  it('says nothing when the scan passes', () => {
    expect(decideAlert({ code: 0, detail: '' }, 'abc1234')).toBeNull();
  });

  it('carries only the checker output, and names the commit it scanned', () => {
    const alert = decideAlert({ code: 1, detail: FINDING }, 'abc1234');
    expect(alert).not.toBeNull();
    expect(alert!.body).toContain('src/example.ts:12 identifier');
    expect(alert!.body).toContain('origin/main @ abc1234');
    expect(alert!.body).toContain('did not pass');
  });

  it('alerts just as loudly when the gate could not run at all', () => {
    // Exit 2 is "the remote is unchecked", which is the failure this job exists
    // to prevent — silence there would reproduce the original defect.
    const alert = decideAlert({ code: 2, detail: 'public boundary check could not run: bad allowlist' }, 'abc1234');
    expect(alert).not.toBeNull();
    expect(alert!.body).toContain('UNCHECKED');
    expect(alert!.body).toContain('public boundary check could not run: bad allowlist');
  });

  it('still alerts when the checker failed without printing anything', () => {
    const alert = decideAlert({ code: 2, detail: '' }, 'abc1234');
    expect(alert!.body).toContain('the checker produced no output');
  });
});

describe('reportScan', () => {
  it('is silent and succeeds on a clean scan', async () => {
    const r = recorder(0);
    await expect(reportScan({ code: 0, detail: '' }, 'abc1234', r)).resolves.toBe(0);
    expect(r.alerts).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.logs).toEqual(['remote-boundary: clean (origin/main @ abc1234)']);
  });

  it('succeeds once a finding has actually been delivered', async () => {
    const r = recorder(0);
    await expect(reportScan({ code: 1, detail: FINDING }, 'abc1234', r)).resolves.toBe(0);
    expect(r.alerts).toHaveLength(1);
    expect(r.errors).toEqual([]);
    expect(r.logs[0]).toContain('alert sent to the owner DM');
  });

  it('fails the run when delivery was attempted and failed', async () => {
    const r = recorder(1);
    await expect(reportScan({ code: 1, detail: FINDING }, 'abc1234', r)).resolves.toBe(1);
    expect(r.errors[0]).toContain('NOBODY WAS TOLD');
    expect(r.errors[0]).toContain('was attempted and failed');
    // The finding itself goes to the journal, so the operator can still act on it.
    expect(r.errors[0]).toContain('src/example.ts:12 identifier');
  });

  it('fails the run when delivery could not even be attempted', async () => {
    const r = recorder(2);
    await expect(reportScan({ code: 1, detail: FINDING }, 'abc1234', r)).resolves.toBe(1);
    expect(r.errors[0]).toContain('could not be attempted');
  });
});

describe('describeDelivery', () => {
  it('treats only 0 as delivered', () => {
    expect(describeDelivery(0)).toBe('delivered');
    expect(describeDelivery(1)).toBe('was attempted and failed');
    expect(describeDelivery(2)).toBe('could not be attempted');
  });
});

describe('systemd units', () => {
  const unit = fs.readFileSync(path.join(repoRoot, 'data', 'systemd', 'nanoclaw-remote-boundary.service'), 'utf8');
  const timer = fs.readFileSync(path.join(repoRoot, 'data', 'systemd', 'nanoclaw-remote-boundary.timer'), 'utf8');

  it('runs the script this test covers, on the fleet-drift service shape', () => {
    expect(unit).toContain('ExecStart=/home/ubuntu/nanoclaw-v2/node_modules/.bin/tsx scripts/check-remote-boundary.ts');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('User=ubuntu');
    expect(unit).toContain('WorkingDirectory=/home/ubuntu/nanoclaw-v2');
    expect(unit).toContain('IOSchedulingClass=idle');
    // A failed run means nobody was told; that must reach the operator anyway.
    expect(unit).toContain('OnFailure=nanoclaw-unit-alert@%n.service');
  });

  it('fires daily and catches up after downtime', () => {
    expect(timer).toMatch(/OnCalendar=\*-\*-\* \d\d:\d\d:\d\d UTC/);
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('WantedBy=timers.target');
  });
});
