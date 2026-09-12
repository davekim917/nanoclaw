import fs from 'fs';
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
    const wait = script.indexOf('while drain_in_flight');
    expect(wait).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(script.indexOf('write_status "ok" "done"'));
    expect(wait).toBeLessThan(script.indexOf('sudo systemctl restart nanoclaw-v2'));
    expect(script).toContain('[ "$drain_waited" -lt "$DRAIN_WAIT_SECONDS" ]');
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
});
