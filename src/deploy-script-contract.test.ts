import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = fs.readFileSync(path.join(root, 'scripts', 'deploy.sh'), 'utf-8');

describe('deploy rollback shell contract', () => {
  it('snapshots before a fast-forward pull and re-execs the pulled script', () => {
    expect(script.indexOf('snapshot_dir node_modules')).toBeLessThan(script.indexOf('git pull --ff-only origin main'));
    expect(script.indexOf('bash -n scripts/deploy.sh')).toBeLessThan(script.indexOf('exec env'));
    expect(script).toContain('NANOCLAW_DEPLOY_POST_PULL=1');
    expect(script).toContain('bash scripts/deploy.sh');
  });

  it('fails closed on rollback snapshot and image-tag failures', () => {
    expect(script).toContain('if ! snapshot_dir node_modules || ! snapshot_dir dist; then');
    expect(script).toContain('if ! docker tag "$SPAWN_IMAGE"');
    expect(script).toContain('could not preserve the current agent image — build not started');
  });

  it('refuses tracked changes before mutation and restores pre-restart failures', () => {
    expect(script.indexOf('if tracked_changes; then')).toBeLessThan(script.indexOf('git checkout main'));
    expect(script.lastIndexOf('if tracked_changes; then')).toBeLessThan(
      script.indexOf('if [ -z "$MIGRATION_CHANGES" ]'),
    );
    expect(script).toContain('trap restore_before_restart EXIT');
    expect(script).toContain('Pre-restart rollback preserved tracked source changes; commit reset skipped');
    expect(script).toContain('rm -rf "${name}.failed-deploy"');
  });

  it('installs dashboard deps before the first SPA-touching build (#309)', () => {
    // `pnpm run build` reaches `build:spa`, which never installs — see
    // scripts/build-dashboard-spa.ts's depsVerified gate. If it ran before
    // `build:dashboard`'s frozen install, a deploy that both bumps a
    // dashboard dependency and imports it would typecheck+build against the
    // PREVIOUS deploy's stale dashboard/node_modules and fail before ever
    // reaching the install that would fix it.
    expect(script.indexOf('rm -rf dist')).toBeLessThan(script.indexOf('pnpm run build:dashboard'));
    expect(script.indexOf('pnpm run build:dashboard')).toBeLessThan(script.indexOf('pnpm run build >>'));
  });

  it('holds the restart for an in-flight repository drain, bounded (#718)', () => {
    const calls = [...script.matchAll(/^\s*wait_for_drain$/gm)].map((match) => match.index!);
    // Once after the build, and again right before the restart for a drain that
    // started during the pre-restart steps.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBeLessThan(script.indexOf('Build complete, restarting'));
    expect(calls[1]).toBeGreaterThan(script.indexOf('Build complete, restarting'));
    expect(calls[1]).toBeLessThan(script.indexOf('if [ -z "$MIGRATION_CHANGES" ]'));
    expect(calls[1]).toBeLessThan(script.indexOf('write_status "ok" "done"'));
    expect(script).toContain('[ "$(date +%s)" -lt "$DRAIN_DEADLINE" ]');
    // Two back-to-back transfer drains at the default quiescence timeout fit.
    expect(script).toContain('NANOCLAW_DEPLOY_DRAIN_WAIT_SECONDS:-1800');
    // A marker left by a host that died mid-drain must not hold the restart.
    expect(script).toContain('systemctl show -p MainPID --value nanoclaw-v2');
    // Both ends name the same file.
    expect(script).toContain('DRAIN_MARKER="data/repository-drain-in-flight.json"');
    const runner = fs.readFileSync(
      path.join(root, 'src', 'modules', 'repository-workspaces', 'job-runner.ts'),
      'utf-8',
    );
    expect(runner).toContain("path.join(DATA_DIR, 'repository-drain-in-flight.json')");
  });

  it('waits only for a marker the running service wrote (#718)', () => {
    const drainInFlight = script.match(/^drain_in_flight\(\) \{\n[\s\S]*?^\}$/m)?.[0];
    expect(drainInFlight).toBeDefined();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-drain-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // Stands in for `systemctl show -p MainPID --value`; no FAKE_MAINPID means it fails.
    fs.writeFileSync(
      path.join(bin, 'systemctl'),
      '#!/bin/sh\n[ -n "$FAKE_MAINPID" ] || exit 1\necho "$FAKE_MAINPID"\n',
      {
        mode: 0o755,
      },
    );
    const probe = path.join(dir, 'probe.sh');
    fs.writeFileSync(
      probe,
      `DRAIN_MARKER="$1"\n${drainInFlight}\nif drain_in_flight; then echo waits; else echo proceeds; fi\n`,
    );
    const marker = path.join(dir, 'repository-drain-in-flight.json');
    const probeWith = (mainPid: string): string =>
      execFileSync('bash', [probe, marker], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_MAINPID: mainPid },
        encoding: 'utf8',
      }).trim();
    try {
      expect(probeWith('4242')).toBe('proceeds');
      // Written the way the job runner writes it (JSON.stringify, no spaces).
      fs.writeFileSync(
        marker,
        `${JSON.stringify({ action: 'repository_publish', requestId: 'r', sessionId: 's', pid: 4242, startedAt: 'x' })}\n`,
      );
      expect(probeWith('4242')).toBe('waits');
      // Left by a host that has since died.
      expect(probeWith('9999')).toBe('proceeds');
      // systemctl cannot say.
      expect(probeWith('')).toBe('proceeds');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('spends one wait budget across both drain checks (#718)', () => {
    const shellFunction = (name: string): string => {
      const body = script.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm'))?.[0];
      expect(body, name).toBeDefined();
      return body!;
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-drain-budget-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // Simulated time: `sleep N` advances the clock and `date +%s` reads it.
    const clock = path.join(dir, 'clock');
    fs.writeFileSync(clock, '1000\n');
    fs.writeFileSync(path.join(bin, 'sleep'), `#!/bin/sh\necho $(( $(cat "${clock}") + $1 )) > "${clock}"\n`, {
      mode: 0o755,
    });
    fs.writeFileSync(
      path.join(bin, 'date'),
      `#!/bin/sh\nif [ "$1" = "+%s" ]; then cat "${clock}"; else exec /bin/date "$@"; fi\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\necho 4242\n', { mode: 0o755 });
    // A drain that never settles, owned by the running service.
    const marker = path.join(dir, 'repository-drain-in-flight.json');
    fs.writeFileSync(
      marker,
      `${JSON.stringify({ action: 'repository_transfer', requestId: 'r', sessionId: 's', pid: 4242, startedAt: 'x' })}\n`,
    );
    const probe = path.join(dir, 'probe.sh');
    fs.writeFileSync(
      probe,
      [
        `DRAIN_MARKER="${marker}"`,
        `LOG="${path.join(dir, 'deploy.log')}"`,
        `STATUS_FILE="${path.join(dir, 'status.json')}"`,
        'DRAIN_WAIT_SECONDS=30',
        'DRAIN_DEADLINE=""',
        shellFunction('write_status'),
        shellFunction('drain_in_flight'),
        shellFunction('wait_for_drain'),
        'wait_for_drain',
        'wait_for_drain',
        `cat "${clock}"`,
        '',
      ].join('\n'),
    );
    try {
      const out = execFileSync('bash', [probe], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: 'utf8',
      }).trim();
      // Three 10 s polls run the 30 s budget out; the second check spends none.
      expect(Number(out)).toBe(1030);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
