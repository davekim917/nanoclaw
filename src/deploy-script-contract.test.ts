import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = fs.readFileSync(path.join(root, 'scripts', 'deploy.sh'), 'utf-8');

describe('deploy rollback shell contract', () => {
  it('snapshots before a fast-forward pull and re-execs the pulled script', () => {
    expect(script.indexOf('snapshot_dir node_modules')).toBeLessThan(script.indexOf('git pull --ff-only origin main'));
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
    expect(script).toContain('trap restore_before_restart EXIT');
    expect(script).toContain('Pre-restart rollback preserved tracked source changes; commit reset skipped');
  });
});
