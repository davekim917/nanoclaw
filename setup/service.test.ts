import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { getLaunchdLabel } from '../src/install-slug.js';
import {
  ensureHostFlock,
  renderLogrotateConfig,
  renderNohupWrapper,
  renderSystemdUnit,
  runtimePath,
  type FlockCommandOverrides,
} from './service.js';

/**
 * Tests for service configuration generation.
 *
 * These tests verify the generated content of plist/systemd/nohup configs
 * without actually loading services.
 */

// Helper: generate a plist string the same way service.ts does
function generatePlist(nodePath: string, projectRoot: string, homeDir: string): string {
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

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeMacPrefix(): { prefix: string; flockPath: string } {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-flock-test-'));
  tempDirs.push(prefix);
  return { prefix, flockPath: path.join(prefix, 'bin', 'flock') };
}

function macCommands(
  prefix: string,
  spawnResult = { status: 0, stderr: '' },
): FlockCommandOverrides & { brew: ReturnType<typeof vi.fn> } {
  const brew = vi.fn((_command: string, _args: string[]) => prefix);
  return {
    commandExists: (command) => command === 'brew',
    execFileSync: brew,
    spawnSync: vi.fn(() => spawnResult),
    brew,
  };
}

describe('plist generation', () => {
  it('contains the slug-scoped label', () => {
    const projectRoot = '/home/user/nanoclaw';
    const plist = generatePlist('/usr/local/bin/node', projectRoot, '/home/user');
    expect(plist).toContain(`<string>${getLaunchdLabel(projectRoot)}</string>`);
    expect(plist).toMatch(/<string>com\.nanoclaw-v2-[0-9a-f]{8}<\/string>/);
  });

  it('uses the correct node path', () => {
    const plist = generatePlist('/opt/node/bin/node', '/home/user/nanoclaw', '/home/user');
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
  });

  it('points to dist/index.js', () => {
    const plist = generatePlist('/usr/local/bin/node', '/home/user/nanoclaw', '/home/user');
    expect(plist).toContain('/home/user/nanoclaw/dist/index.js');
  });

  it('sets log paths', () => {
    const plist = generatePlist('/usr/local/bin/node', '/home/user/nanoclaw', '/home/user');
    expect(plist).toContain('nanoclaw.log');
    expect(plist).toContain('nanoclaw.error.log');
  });

  it('includes the Homebrew flock directory in launchd PATH on Apple Silicon', () => {
    expect(runtimePath('/Users/test', '/opt/homebrew/opt/flock/bin/flock')).toContain('/opt/homebrew/opt/flock/bin');
  });

  it('renders launchd PATH from the provisioned flock location', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('./service.ts', import.meta.url)), 'utf8');
    expect(source).toContain('<string>${runtimePath(homeDir, flockPath)}</string>');
  });

  it('installs the Homebrew formula when its prefix has no executable, then probes inherited fd 3', () => {
    const { prefix, flockPath } = makeMacPrefix();
    const commands = macCommands(prefix);
    commands.brew.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'install') {
        fs.mkdirSync(path.dirname(flockPath), { recursive: true });
        fs.writeFileSync(flockPath, '', { mode: 0o755 });
      }
      return prefix;
    });

    expect(ensureHostFlock('macos', commands)).toBe(flockPath);
    expect(commands.brew).toHaveBeenCalledWith('brew', ['install', 'flock'], { stdio: 'inherit' });
    expect(commands.spawnSync).toHaveBeenCalledWith(
      flockPath,
      ['-n', '3'],
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe', expect.any(Number)] }),
    );
  });

  it('skips Homebrew installation when the formula executable already exists', () => {
    const { prefix, flockPath } = makeMacPrefix();
    fs.mkdirSync(path.dirname(flockPath), { recursive: true });
    fs.writeFileSync(flockPath, '', { mode: 0o755 });
    const commands = macCommands(prefix);

    expect(ensureHostFlock('macos', commands)).toBe(flockPath);
    expect(commands.brew).not.toHaveBeenCalledWith('brew', ['install', 'flock'], { stdio: 'inherit' });
  });

  it('rejects an invalid inherited-fd flock before service build setup', () => {
    const { prefix, flockPath } = makeMacPrefix();
    fs.mkdirSync(path.dirname(flockPath), { recursive: true });
    fs.writeFileSync(flockPath, '', { mode: 0o755 });
    const commands = macCommands(prefix, { status: 1, stderr: 'invalid fd' });

    expect(() => ensureHostFlock('macos', commands)).toThrow(/inherited-fd preflight failed: invalid fd/);
    expect(commands.brew).not.toHaveBeenCalledWith('brew', ['install', 'flock'], { stdio: 'inherit' });
    const source = fs.readFileSync(fileURLToPath(new URL('./service.ts', import.meta.url)), 'utf8');
    expect(source.indexOf('const flockPath = ensureHostFlock(platform)')).toBeLessThan(
      source.indexOf("execSync('pnpm run build'"),
    );
  });
});

describe('systemd unit generation', () => {
  it('user unit uses default.target', () => {
    const unit = renderSystemdUnit('/usr/bin/node', '/home/user/nanoclaw', '/home/user', false, '/usr/bin/flock');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('system unit uses multi-user.target', () => {
    const unit = renderSystemdUnit('/usr/bin/node', '/home/user/nanoclaw', '/home/user', true, '/usr/bin/flock');
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('contains restart policy', () => {
    const unit = renderSystemdUnit('/usr/bin/node', '/home/user/nanoclaw', '/home/user', false, '/usr/bin/flock');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
  });

  it('uses KillMode=process to preserve detached children', () => {
    const unit = renderSystemdUnit('/usr/bin/node', '/home/user/nanoclaw', '/home/user', false, '/usr/bin/flock');
    expect(unit).toContain('KillMode=process');
  });

  it('sets correct ExecStart', () => {
    const unit = renderSystemdUnit('/usr/bin/node', '/srv/nanoclaw', '/home/user', false, '/usr/bin/flock');
    expect(unit).toContain('ExecStart=/usr/bin/node /srv/nanoclaw/dist/index.js');
  });

  it('keeps a custom flock directory in the generated Linux service PATH', () => {
    const flockPath = '/nix/store/synthetic-flock/bin/flock';
    const unit = renderSystemdUnit('/usr/bin/node', '/srv/nanoclaw', '/home/user', false, flockPath);

    expect(unit).toContain(
      'Environment=PATH=/nix/store/synthetic-flock/bin:/usr/local/bin:/usr/bin:/bin:/home/user/.local/bin',
    );
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
  it('generates a valid wrapper script with the resolved flock directory on PATH', () => {
    const wrapper = renderNohupWrapper(
      '/home/user/nanoclaw',
      '/usr/bin/node',
      '/home/user',
      '/nix/store/synthetic-flock/bin/flock',
    );

    expect(wrapper).toContain('#!/bin/bash');
    expect(wrapper).toContain('nohup');
    expect(wrapper).toContain('/usr/bin/node');
    expect(wrapper).toContain('nanoclaw.pid');
    expect(wrapper).toContain(
      'export PATH="/nix/store/synthetic-flock/bin:/usr/local/bin:/usr/bin:/bin:/home/user/.local/bin"',
    );
  });
});

describe('Graphify sidecar decommission', () => {
  it('never installs, enables, or restarts a graphify unit during service setup', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('./service.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/graphify/i);
  });
});
