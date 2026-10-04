import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { claudeUserConfigPath, ensureClaudeUserConfig } from './claude-user-config.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-user-config-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ensureClaudeUserConfig', () => {
  it('seeds an empty JSON object when the file is missing', () => {
    const file = path.join(tempDir(), '.claude.json');
    const lines: string[] = [];
    ensureClaudeUserConfig((m) => lines.push(m), file);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({});
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(lines).toHaveLength(1);
  });

  it('never touches a config the CLI already wrote', () => {
    const file = path.join(tempDir(), '.claude.json');
    fs.writeFileSync(file, '{"numStartups":7}');
    const lines: string[] = [];
    ensureClaudeUserConfig((m) => lines.push(m), file);
    expect(fs.readFileSync(file, 'utf-8')).toBe('{"numStartups":7}');
    expect(lines).toEqual([]);
  });

  it('logs and returns when the home is not writable', () => {
    const file = path.join(tempDir(), 'missing-dir', '.claude.json');
    const lines: string[] = [];
    expect(() => ensureClaudeUserConfig((m) => lines.push(m), file)).not.toThrow();
    expect(lines[0]).toContain('Could not seed');
  });
});

describe('claudeUserConfigPath', () => {
  it('follows CLAUDE_CONFIG_DIR, then HOME, the way the CLI resolves its global config', () => {
    expect(claudeUserConfigPath({ CLAUDE_CONFIG_DIR: '/cfg', HOME: '/home/node' })).toBe('/cfg/.claude.json');
    expect(claudeUserConfigPath({ HOME: '/home/node' })).toBe('/home/node/.claude.json');
  });
});
