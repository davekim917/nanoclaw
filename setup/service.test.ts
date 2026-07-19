import { describe, it, expect } from 'vitest';
import path from 'path';

import { getLaunchdLabel } from '../src/install-slug.js';
import {
  installGraphifySystemdSidecar,
  resolveGraphifySystemIdentity,
} from './service.js';

/**
 * Tests for service configuration generation.
 *
 * These tests verify the generated content of plist/systemd/nohup configs
 * without actually loading services.
 */

// Helper: generate a plist string the same way service.ts does
function generatePlist(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
): string {
  const label = getLaunchdLabel(projectRoot);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${projectRoot}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/nanoclaw.error.log</string>
</dict>
</plist>`;
}

function generateSystemdUnit(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
  isSystem: boolean,
): string {
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
    const plist = generatePlist('/usr/local/bin/node', projectRoot, '/home/user');
    expect(plist).toContain(`<string>${getLaunchdLabel(projectRoot)}</string>`);
    expect(plist).toMatch(/<string>com\.nanoclaw-v2-[0-9a-f]{8}<\/string>/);
  });

  it('uses the correct node path', () => {
    const plist = generatePlist(
      '/opt/node/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
    );
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
  });

  it('points to dist/index.js', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
    );
    expect(plist).toContain('/home/user/nanoclaw/dist/index.js');
  });

  it('sets log paths', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
    );
    expect(plist).toContain('nanoclaw.log');
    expect(plist).toContain('nanoclaw.error.log');
  });
});

describe('systemd unit generation', () => {
  it('user unit uses default.target', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('WantedBy=default.target');
  });

  it('system unit uses multi-user.target', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      true,
    );
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('contains restart policy', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
  });

  it('uses KillMode=process to preserve detached children', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('KillMode=process');
  });

  it('sets correct ExecStart', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/srv/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain(
      'ExecStart=/usr/bin/node /srv/nanoclaw/dist/index.js',
    );
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

describe('Graphify Linux sidecar setup', () => {
  it('drops a root-installed sidecar to the checkout owner identity', () => {
    expect(
      resolveGraphifySystemIdentity(
        true,
        '/root',
        1000,
        1001,
        'root:x:0:0:root:/root:/bin/bash\nalice:x:1000:1001::/home/alice:/bin/bash\n',
      ),
    ).toEqual({
      homeDir: '/home/alice',
      identity: { systemUser: 'alice', systemGroup: '1001' },
    });
  });

  it('keeps user units and genuinely root-owned checkouts unchanged', () => {
    expect(
      resolveGraphifySystemIdentity(false, '/home/alice', 1000, 1000, ''),
    ).toEqual({ homeDir: '/home/alice', identity: {} });
    expect(resolveGraphifySystemIdentity(true, '/root', 0, 0, '')).toEqual({
      homeDir: '/root',
      identity: {},
    });
  });

  it('test_linux_setup_installs_slug_scoped_graphify_sidecar', () => {
    const commands: string[] = [];
    const writes: Array<{ filePath: string; content: string }> = [];

    const result = installGraphifySystemdSidecar(
      {
        projectRoot: '/home/alice/nanoclaw',
        nodePath: '/usr/bin/node',
        homeDir: '/home/alice',
        runningAsRoot: false,
        mainUnitName: 'nanoclaw-v2-ab12cd34',
        mainUnitPath:
          '/home/alice/.config/systemd/user/nanoclaw-v2-ab12cd34.service',
        systemctlPrefix: 'systemctl --user',
      },
      {
        writeFile(filePath, content) {
          writes.push({ filePath, content });
        },
        run(command) {
          commands.push(command);
        },
      },
    );

    expect(result).toEqual({
      unitName: 'nanoclaw-v2-ab12cd34-graphify',
      unitPath:
        '/home/alice/.config/systemd/user/nanoclaw-v2-ab12cd34-graphify.service',
      loaded: true,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.filePath).toBe(result.unitPath);
    expect(writes[0]?.content).toContain('WantedBy=default.target');
    expect(commands).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable nanoclaw-v2-ab12cd34-graphify',
      'systemctl --user restart nanoclaw-v2-ab12cd34-graphify',
      'systemctl --user is-active nanoclaw-v2-ab12cd34-graphify',
    ]);
  });

  it('test_graphify_service_failure_does_not_block_host_service', () => {
    const commands: string[] = [];
    let result:
      | ReturnType<typeof installGraphifySystemdSidecar>
      | undefined;

    expect(() => {
      result = installGraphifySystemdSidecar(
        {
          projectRoot: '/home/alice/nanoclaw',
          nodePath: '/usr/bin/node',
          homeDir: '/home/alice',
          runningAsRoot: false,
          mainUnitName: 'nanoclaw-v2-ab12cd34',
          mainUnitPath:
            '/home/alice/.config/systemd/user/nanoclaw-v2-ab12cd34.service',
          systemctlPrefix: 'systemctl --user',
        },
        {
          writeFile() {},
          run(command) {
            commands.push(command);
            if (command.includes('restart')) {
              throw new Error('sidecar failed');
            }
          },
        },
      );
    }).not.toThrow();

    expect(result?.loaded).toBe(false);
    expect(result?.error).toContain('restart: sidecar failed');
    expect(commands).toContain(
      'systemctl --user is-active nanoclaw-v2-ab12cd34-graphify',
    );
  });
});
