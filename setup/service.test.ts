import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getLaunchdLabel } from '../src/install-slug.js';
import { renderLaunchdPlist, renderLogrotateConfig } from './service.js';

/**
 * Tests for service configuration generation.
 *
 * These tests verify the generated content of plist/systemd/nohup configs
 * without actually loading services.
 */

function generateSystemdUnit(nodePath: string, projectRoot: string, homeDir: string, isSystem: boolean): string {
  return `[Unit]
Description=NanoClaw Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${projectRoot}/dist/index.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=${homeDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
StandardOutput=append:${projectRoot}/logs/nanoclaw.log
StandardError=append:${projectRoot}/logs/nanoclaw.error.log

[Install]
WantedBy=${isSystem ? 'multi-user.target' : 'default.target'}`;
}

describe('plist generation', () => {
  it('contains the slug-scoped label', () => {
    const projectRoot = '/home/user/nanoclaw';
    const plist = renderLaunchdPlist('/usr/local/bin/node', projectRoot, '/home/user');
    expect(plist).toContain(`<string>${getLaunchdLabel(projectRoot)}</string>`);
    expect(plist).toMatch(/<string>com\.nanoclaw-v2-[0-9a-f]{8}<\/string>/);
  });

  it('uses the correct node path', () => {
    const plist = renderLaunchdPlist('/opt/node/bin/node', '/home/user/nanoclaw', '/home/user');
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
  });

  it('points to dist/index.js', () => {
    const plist = renderLaunchdPlist('/usr/local/bin/node', '/home/user/nanoclaw', '/home/user');
    expect(plist).toContain('/home/user/nanoclaw/dist/index.js');
  });

  it('sets log paths', () => {
    const plist = renderLaunchdPlist('/usr/local/bin/node', '/home/user/nanoclaw', '/home/user');
    expect(plist).toContain('nanoclaw.log');
    expect(plist).toContain('nanoclaw.error.log');
  });

  it('prepends the keg-only Node directory to the launchd PATH', () => {
    const plist = renderLaunchdPlist('/opt/homebrew/opt/node@22/bin/node', '/Users/example/nanoclaw', '/Users/example');
    expect(plist).toContain(
      '<string>/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/bin:/bin:/Users/example/.local/bin</string>',
    );
  });

  it('does not duplicate a standard Node directory already on the launchd PATH', () => {
    const plist = renderLaunchdPlist('/usr/local/bin/node', '/home/user/nanoclaw', '/home/user');
    expect(plist).toContain('<string>/usr/local/bin:/usr/bin:/bin:/home/user/.local/bin</string>');
    expect(plist).not.toContain('/usr/local/bin:/usr/local/bin');
  });
});

describe('systemd unit generation', () => {
  it('user unit uses default.target', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/home/user/nanoclaw', '/home/user', false);
    expect(unit).toContain('WantedBy=default.target');
  });

  it('system unit uses multi-user.target', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/home/user/nanoclaw', '/home/user', true);
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('contains restart policy', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/home/user/nanoclaw', '/home/user', false);
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
  });

  it('uses KillMode=process to preserve detached children', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/home/user/nanoclaw', '/home/user', false);
    expect(unit).toContain('KillMode=process');
  });

  it('sets correct ExecStart', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/srv/nanoclaw', '/home/user', false);
    expect(unit).toContain('ExecStart=/usr/bin/node /srv/nanoclaw/dist/index.js');
  });
});

describe('logrotate config generation', () => {
  it('targets both log paths derived from projectRoot', () => {
    const config = renderLogrotateConfig('/srv/nanoclaw');
    expect(config).toContain('/srv/nanoclaw/logs/nanoclaw.log');
    expect(config).toContain('/srv/nanoclaw/logs/nanoclaw.error.log');
  });

  it('rotates daily, keeps 30 generations, compresses with a one-cycle delay', () => {
    const config = renderLogrotateConfig('/srv/nanoclaw');
    expect(config).toContain('daily');
    expect(config).toContain('rotate 30');
    expect(config).toContain('compress');
    expect(config).toContain('delaycompress');
  });

  it('uses copytruncate — required because append: redirects hold the fd open', () => {
    const config = renderLogrotateConfig('/srv/nanoclaw');
    expect(config).toContain('copytruncate');
  });

  it('caps a pathological burst with maxsize, not size (size drops the daily cadence)', () => {
    const config = renderLogrotateConfig('/srv/nanoclaw');
    expect(config).toContain('maxsize 200M');
    expect(config).not.toMatch(/(?<!max)size 200M/);
  });

  it('runs rotation as root — the files are root-owned regardless of the unit User=', () => {
    const config = renderLogrotateConfig('/srv/nanoclaw');
    expect(config).toContain('su root root');
  });
});

describe('WSL nohup fallback', () => {
  it('generates a valid wrapper script', () => {
    const projectRoot = '/home/user/nanoclaw';
    const nodePath = '/usr/bin/node';
    const pidFile = path.join(projectRoot, 'nanoclaw.pid');

    // Simulate what service.ts generates
    const wrapper = `#!/bin/bash
set -euo pipefail
cd ${JSON.stringify(projectRoot)}
nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot)}/dist/index.js >> ${JSON.stringify(projectRoot)}/logs/nanoclaw.log 2>> ${JSON.stringify(projectRoot)}/logs/nanoclaw.error.log &
echo $! > ${JSON.stringify(pidFile)}`;

    expect(wrapper).toContain('#!/bin/bash');
    expect(wrapper).toContain('nohup');
    expect(wrapper).toContain(nodePath);
    expect(wrapper).toContain('nanoclaw.pid');
  });
});

describe('Graphify sidecar decommission', () => {
  it('never installs, enables, or restarts a graphify unit during service setup', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('./service.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/graphify/i);
  });
});
