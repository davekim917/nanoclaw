/**
 * The remote-boundary job's logic, run without git, a network, Slack or systemd.
 * `node:child_process` and `notifyOwner` are mocked file-wide: the checker never
 * runs (faking its verdict would test the fake), but its argv and `main()`'s
 * git/worktree sequence are pinned against those mocks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enforceHermeticity } from '../src/test-hermeticity.js';
import {
  MAX_ALERT_LINES,
  cleanCheckerOutput,
  cleanupSnapshot,
  decideAlert,
  describeDelivery,
  main,
  reportCleanup,
  reportOutcome,
  reportScan,
  scanSnapshot,
  trimDetail,
  type Alert,
  type Reporter,
} from './check-remote-boundary.js';

const childProcess = vi.hoisted(() => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:child_process', () => childProcess);
const notifyOwner = vi.hoisted(() => vi.fn());
vi.mock('../src/notify-owner.js', () => ({ notifyOwner }));

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

describe('scanSnapshot', () => {
  it('scans the snapshot root and leaves the allowlist to the checker', () => {
    const calls: string[] = [];
    const result = scanSnapshot('/tmp/snapshot', (root) => {
      calls.push(root);
      return { status: 0, stderr: '' };
    });
    expect(calls).toEqual(['/tmp/snapshot']);
    expect(result).toEqual({ code: 0, detail: '' });
  });

  it('maps a findings exit code and stderr into a BoundaryScan', () => {
    const result = scanSnapshot('/tmp/snapshot', () => ({
      status: 1,
      stderr: 'src/example.ts:12 identifier\npublic boundary check failed with 1 redacted finding(s) (index)',
    }));
    expect(result.code).toBe(1);
    expect(result.detail).toContain('src/example.ts:12 identifier');
  });

  it('throws when the checker invocation itself fails to spawn', () => {
    expect(() =>
      scanSnapshot('/tmp/snapshot', () => ({ status: null, stderr: '', error: new Error('spawn failed') })),
    ).toThrow('spawn failed');
  });

  describe('with the default checker runner', () => {
    afterEach(() => childProcess.spawnSync.mockReset());

    it('runs an index scan of the snapshot from the install root, with no --allowlist', () => {
      // An --allowlist into the install checkout would exempt edits never committed to the snapshot.
      childProcess.spawnSync.mockReturnValue({ status: 0, stderr: '' });
      expect(scanSnapshot('/tmp/snapshot')).toEqual({ code: 0, detail: '' });
      expect(childProcess.spawnSync).toHaveBeenCalledTimes(1);
      const [command, args, options] = childProcess.spawnSync.mock.calls[0];
      expect(command).toBe('pnpm');
      expect(args).toEqual(['run', 'check:public-boundary', '--', '--root', '/tmp/snapshot', '--index']);
      expect(options).toMatchObject({ cwd: repoRoot });
    });

    it('reads a signal-killed checker (no status, no stderr) as could-not-run', () => {
      childProcess.spawnSync.mockReturnValue({ status: null, stderr: null, signal: 'SIGKILL' });
      expect(scanSnapshot('/tmp/snapshot')).toEqual({ code: 2, detail: '' });
    });
  });
});

describe('cleanupSnapshot', () => {
  function ops(failures: { worktree?: boolean; directory?: boolean } = {}) {
    const calls: string[] = [];
    return {
      calls,
      removeWorktree: () => {
        calls.push('worktree');
        if (failures.worktree) throw new Error('device busy');
      },
      removeDirectory: () => {
        calls.push('directory');
        if (failures.directory) throw new Error('permission denied');
      },
    };
  }

  it('reports nothing when both steps succeed', () => {
    const o = ops();
    expect(cleanupSnapshot('/tmp/parent', '/tmp/parent/tree', o)).toBeNull();
    expect(o.calls).toEqual(['worktree', 'directory']);
  });

  it('still removes the directory when the worktree removal failed', () => {
    // Attempt everything, then report. Bailing on the first failure would trade
    // a stale registration for a stale registration AND a leaked directory.
    const o = ops({ worktree: true });
    const failure = cleanupSnapshot('/tmp/parent', '/tmp/parent/tree', o);
    expect(o.calls).toEqual(['worktree', 'directory']);
    expect(failure).toContain('could not remove the snapshot worktree');
    expect(failure).toContain('device busy');
  });

  it('reports a directory removal failure on its own', () => {
    const failure = cleanupSnapshot('/tmp/parent', '/tmp/parent/tree', ops({ directory: true }));
    expect(failure).toContain('could not remove the snapshot directory');
    expect(failure).toContain('permission denied');
  });

  it('reports both failures rather than only the first', () => {
    const failure = cleanupSnapshot('/tmp/parent', '/tmp/parent/tree', ops({ worktree: true, directory: true }));
    expect(failure).toContain('device busy');
    expect(failure).toContain('permission denied');
  });
});

describe('reportCleanup', () => {
  const CLEANUP_FAIL = 'could not remove the snapshot worktree /tmp/x/tree: device busy';

  it('is invisible when cleanup succeeded', () => {
    const r = recorder(0);
    expect(reportCleanup(null, 0, r)).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it('fails the run when cleanup failed, even though the scan itself passed', () => {
    // The defect: `worktree remove` fails, the error is logged and swallowed,
    // the job exits 0 and OnFailure never fires — while the directory is gone
    // and the registration is left in the shared git metadata of a live
    // checkout. Daily. A cleanup failure that reports success is the same
    // defect as a hook that never runs.
    const r = recorder(0);
    expect(reportCleanup(CLEANUP_FAIL, 0, r)).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('device busy');
    expect(r.errors[0]).toContain('git worktree prune');
  });

  it('does not mask a scan failure that already stood', () => {
    const r = recorder(0);
    expect(reportCleanup(null, 1, r)).toBe(1);
    expect(reportCleanup(CLEANUP_FAIL, 1, r)).toBe(1);
  });

  it('reports both when the scan found something AND cleanup failed', async () => {
    // Neither result may hide the other: the owner still gets the finding, the
    // journal still gets the cleanup failure, and the unit still fails.
    const r = recorder(1); // delivery also fails, the worst case
    const scanExit = await reportScan({ code: 1, detail: FINDING }, 'abc1234', r);
    expect(reportCleanup(CLEANUP_FAIL, scanExit, r)).toBe(1);

    const journal = r.errors.join('\n');
    expect(journal).toContain('src/example.ts:12 identifier');
    expect(journal).toContain('device busy');
  });

  it('still delivers the finding when cleanup fails after a successful send', async () => {
    const r = recorder(0);
    const scanExit = await reportScan({ code: 1, detail: FINDING }, 'abc1234', r);
    expect(scanExit).toBe(0);
    expect(r.alerts).toHaveLength(1);
    // The alert went out; the run still fails so the operator hears about the
    // leaked registration too.
    expect(reportCleanup(CLEANUP_FAIL, scanExit, r)).toBe(1);
  });
});

describe('reportOutcome', () => {
  const CLEANUP_FAIL = 'could not remove the snapshot worktree /tmp/x/tree: device busy';

  it('is what main() calls, so removing either half cannot pass unnoticed', async () => {
    const r = recorder(0);
    await expect(reportOutcome({ code: 0, detail: '' }, 'abc1234', null, r)).resolves.toBe(0);
    expect(r.errors).toEqual([]);
  });

  it('reports the finding BEFORE the cleanup failure, and fails the run', async () => {
    // Order is the guarantee: a cleanup failure must never stop a finding
    // reaching the owner, so the alert goes out first and only then does the
    // cleanup problem raise the exit code.
    const r = recorder(0);
    await expect(reportOutcome({ code: 1, detail: FINDING }, 'abc1234', CLEANUP_FAIL, r)).resolves.toBe(1);
    expect(r.alerts).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('git worktree prune');
  });

  it('fails a clean scan whose snapshot could not be cleaned up', async () => {
    const r = recorder(0);
    await expect(reportOutcome({ code: 0, detail: '' }, 'abc1234', CLEANUP_FAIL, r)).resolves.toBe(1);
    expect(r.alerts).toEqual([]);
    expect(r.logs[0]).toContain('clean');
    expect(r.errors[0]).toContain('device busy');
  });
});

describe('main', () => {
  const REF = 'refs/remotes/origin/main';
  let gitCalls: { args: string[]; cwd: unknown }[];
  let logs: string[];
  let errors: string[];
  let fetchError: Error | null;

  function addedSnapshot(): string {
    const add = gitCalls.find((c) => c.args.includes('add'));
    if (!add) throw new Error('no worktree add');
    return add.args[add.args.length - 2];
  }

  beforeEach(() => {
    gitCalls = [];
    logs = [];
    errors = [];
    fetchError = null;
    childProcess.execFileSync.mockImplementation((file: string, args: string[], options: { cwd?: unknown }) => {
      expect(file).toBe('git');
      gitCalls.push({ args, cwd: options.cwd });
      if (args[0] === 'fetch' && fetchError) throw fetchError;
      if (args[0] === 'rev-parse') return 'abc1234\n';
      if (args.includes('add')) fs.mkdirSync(args[args.length - 2]);
      if (args[1] === 'remove') fs.rmSync(args[3], { recursive: true, force: true });
      return '';
    });
    vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line));
    vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
  });

  afterEach(() => {
    childProcess.execFileSync.mockReset();
    childProcess.spawnSync.mockReset();
    notifyOwner.mockReset();
    vi.restoreAllMocks();
  });

  it('scans the fetched origin/main commit in a hook-free detached worktree, then removes it', async () => {
    childProcess.spawnSync.mockReturnValue({ status: 0, stderr: '' });

    await expect(main()).resolves.toBe(0);

    const snapshot = addedSnapshot();
    expect(gitCalls.map((c) => c.args)).toEqual([
      ['fetch', '--quiet', 'origin', 'main'],
      ['rev-parse', '--short', REF],
      ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', '--quiet', snapshot, 'abc1234'],
      ['worktree', 'remove', '--force', snapshot],
    ]);
    expect(gitCalls.every((c) => c.cwd === repoRoot)).toBe(true);
    expect(childProcess.spawnSync.mock.calls[0][1]).toContain(snapshot);
    expect(fs.existsSync(path.dirname(snapshot))).toBe(false);
    expect(notifyOwner).not.toHaveBeenCalled();
    expect(logs).toEqual(['remote-boundary: clean (origin/main @ abc1234)']);
  });

  it('sends the finding to the owner and fails the run when that DM fails', async () => {
    childProcess.spawnSync.mockReturnValue({ status: 1, stderr: FINDING });
    notifyOwner.mockResolvedValue({ code: 1, message: 'no owner DM wired' });

    await expect(main()).resolves.toBe(1);

    expect(notifyOwner).toHaveBeenCalledTimes(1);
    const sent = notifyOwner.mock.calls[0][0] as Alert;
    expect(sent.title).toBe('Public boundary scan of the origin/main tree');
    expect(sent.body).toContain('src/example.ts:12 identifier');
    expect(sent.body).toContain('origin/main @ abc1234');
    expect(errors.join('\n')).toContain('owner DM failed: no owner DM wired');
    expect(errors.join('\n')).toContain('NOBODY WAS TOLD');
  });

  it('fails without creating a snapshot when origin cannot be fetched', async () => {
    fetchError = new Error('could not resolve host');

    await expect(main()).resolves.toBe(1);

    expect(gitCalls.map((c) => c.args[0])).toEqual(['fetch']);
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
    expect(errors).toEqual(['remote-boundary: could not scan origin/main: could not resolve host']);
  });

  it('still removes the snapshot when the checker cannot be spawned', async () => {
    childProcess.spawnSync.mockReturnValue({ status: null, stderr: null, error: new Error('spawn pnpm ENOENT') });

    await expect(main()).resolves.toBe(1);

    const snapshot = addedSnapshot();
    expect(gitCalls.at(-1)?.args).toEqual(['worktree', 'remove', '--force', snapshot]);
    expect(fs.existsSync(path.dirname(snapshot))).toBe(false);
    expect(errors).toEqual(['remote-boundary: could not scan origin/main: spawn pnpm ENOENT']);
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
  const systemdDir = path.join(repoRoot, 'data', 'systemd');
  const unit = fs.readFileSync(path.join(systemdDir, 'nanoclaw-remote-boundary.service'), 'utf8');
  const timer = fs.readFileSync(path.join(systemdDir, 'nanoclaw-remote-boundary.timer'), 'utf8');

  /** Which `[Section]` each `Key=` line sits under. Comments and blanks ignored. */
  function sectionOf(text: string, key: string): string | null {
    let section: string | null = null;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) section = trimmed.slice(1, -1);
      else if (trimmed.startsWith(`${key}=`)) return section;
    }
    return null;
  }

  it('runs the script this test covers, on the fleet-drift service shape', () => {
    expect(unit).toContain('ExecStart=/home/ubuntu/nanoclaw-v2/node_modules/.bin/tsx scripts/check-remote-boundary.ts');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('User=ubuntu');
    expect(unit).toContain('WorkingDirectory=/home/ubuntu/nanoclaw-v2');
    expect(unit).toContain('IOSchedulingClass=idle');
  });

  // Asserting the SECTION, not just the line. `OnFailure=` is a [Unit]
  // directive; in [Service] systemd ignores it and says so only once at load
  // ("Unknown key name 'OnFailure' in section 'Service', ignoring"), so the
  // handler silently never fires. A `toContain('OnFailure=…')` check passes on
  // the broken file — which is how the installed nanoclaw-fleet-drift.service
  // sat with `systemctl show -p OnFailure` reporting empty.
  it.each(['nanoclaw-remote-boundary.service', 'nanoclaw-fleet-drift.service'])(
    'declares OnFailure in [Unit] so the alert actually fires: %s',
    (name) => {
      const text = fs.readFileSync(path.join(systemdDir, name), 'utf8');
      expect(text).toContain('OnFailure=nanoclaw-unit-alert@%n.service');
      expect(sectionOf(text, 'OnFailure')).toBe('Unit');
    },
  );

  // systemd's default PATH carries no ~/.local/bin, so an install whose pnpm
  // lives there would fail `scanSnapshot`'s lookup on every run. Same approach
  // as data/systemd/nanoclaw-v2.service:22-23.
  it('gives the run a HOME and a PATH that can find the package manager', () => {
    expect(unit).toContain('Environment=HOME=/home/ubuntu');
    const pathLine = unit.split('\n').find((line) => line.startsWith('Environment=PATH='));
    expect(pathLine).toBeDefined();
    expect(pathLine).toContain('/home/ubuntu/.local/bin');
    expect(sectionOf(unit, 'Environment')).toBe('Service');
  });

  it('fires daily and catches up after downtime', () => {
    expect(timer).toMatch(/OnCalendar=\*-\*-\* \d\d:\d\d:\d\d UTC/);
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('WantedBy=timers.target');
  });
});
