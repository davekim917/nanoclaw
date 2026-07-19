import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import { getGraphifySystemdUnit, renderGraphifySystemdUnit } from './service.js';

const userUnit = (): string =>
  renderGraphifySystemdUnit({
    projectRoot: '/srv/nanoclaw',
    nodePath: '/usr/bin/node',
    homeDir: '/home/alice',
    installTarget: 'default.target',
  });

describe('Graphify systemd service', () => {
  it('test_graphify_service_has_background_cpu_io_priority', () => {
    const unit = userUnit();

    expect(unit).toContain('Nice=10');
    expect(unit).toContain('CPUWeight=10');
    expect(unit).toContain('IOWeight=10');
    expect(unit).toContain('OOMScoreAdjust=500');
  });

  it('test_graphify_service_has_3g_hard_memory_cap', () => {
    const unit = userUnit();

    expect(unit).toContain('MemoryHigh=1536M');
    expect(unit).toContain('MemoryMax=3072M');
  });

  it('test_graphify_service_kills_child_jobs_on_stop', () => {
    const unit = userUnit();

    expect(unit).toContain('KillMode=control-group');
    expect(unit).toContain('TimeoutStopSec=30s');
    expect(unit).toContain('Restart=on-failure');
  });

  it('test_graphify_service_writes_only_required_paths', () => {
    const unit = userUnit();
    const writable = unit.split('\n').filter((line) => line.startsWith('ReadWritePaths='));

    expect(unit).toContain('ProtectSystem=strict');
    expect(unit).toContain('ProtectHome=read-only');
    expect(unit).toContain('PrivateTmp=yes');
    expect(writable).toEqual([
      'ReadWritePaths=/srv/nanoclaw/data',
      'ReadWritePaths=/srv/nanoclaw/logs',
      'ReadWritePaths=-/run/docker.sock',
      'ReadWritePaths=-/var/run/docker.sock',
    ]);
    expect(unit).toContain('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6');
  });

  it('test_graphify_service_uses_no_plaintext_credentials', () => {
    const unit = userUnit();
    const environment = unit.split('\n').filter((line) => line.startsWith('Environment='));

    expect(environment).toEqual([
      'Environment=HOME=/home/alice',
      'Environment=PATH=/usr/local/bin:/usr/bin:/bin:/home/alice/.local/bin:/home/alice/.npm-global/bin',
    ]);
    expect(unit).not.toMatch(/(API[_-]?KEY|ACCESS[_-]?TOKEN|PASSWORD|SECRET)=/i);
  });

  it('derives a sibling unit name from the slug-scoped host unit', () => {
    expect(getGraphifySystemdUnit('nanoclaw-v2-ab12cd34')).toBe('nanoclaw-v2-ab12cd34-graphify');
  });

  it('uses the configured runtime paths and install target', () => {
    const unit = renderGraphifySystemdUnit({
      projectRoot: '/srv/nanoclaw',
      nodePath: '/opt/node/bin/node',
      homeDir: '/home/alice',
      installTarget: 'multi-user.target',
      user: 'alice',
      group: 'staff',
    });

    expect(unit).toContain('ExecStart=/opt/node/bin/node /srv/nanoclaw/dist/graphify-daemon/index.js');
    expect(unit).toContain('WorkingDirectory=/srv/nanoclaw');
    expect(unit).toContain('StandardOutput=append:/srv/nanoclaw/logs/graphify-daemon.log');
    expect(unit).toContain('StandardError=append:/srv/nanoclaw/logs/graphify-daemon.error.log');
    expect(unit).toContain('User=alice');
    expect(unit).toContain('Group=staff');
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('keeps the tracked live-install unit aligned with the generator', () => {
    const trackedUnit = fs.readFileSync(
      path.join(process.cwd(), 'data', 'systemd', 'nanoclaw-graphify-daemon.service'),
      'utf8',
    );
    const generatedUnit = renderGraphifySystemdUnit({
      projectRoot: '/home/ubuntu/nanoclaw-v2',
      nodePath: '/usr/bin/node',
      homeDir: '/home/ubuntu',
      installTarget: 'multi-user.target',
      user: 'ubuntu',
      group: 'ubuntu',
    });

    expect(trackedUnit.trim()).toBe(generatedUnit);
  });
});
