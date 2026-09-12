import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({ TEST_ROOT: uniqueTmpRoot('claude-subagent-discovery-test') }));

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: `${TEST_ROOT}/data`,
}));

// NOT spread: log.ts installs process-wide handlers at module scope.
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

import { discoverClaudeSubagents } from './claude-subagent-discovery.js';

const HOME = path.join(TEST_ROOT, 'home');

function pluginAgent(plugin: string, name: string): void {
  const dir = path.join(HOME, 'plugins', plugin, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: Test agent ${name}.\n---\n\nYou are ${name}.\n`,
  );
}

let homedirSpy: MockInstance<typeof os.homedir>;

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(HOME);
  pluginAgent('client-plugin', 'client-agent');
  pluginAgent('shared-plugin', 'shared-agent');
});

afterEach(() => {
  homedirSpy.mockRestore();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('discoverClaudeSubagents with workgroup-scoped plugins (src/plugin-scopes.ts)', () => {
  it('finds every plugin agent when nothing is scoped', () => {
    expect(
      discoverClaudeSubagents()
        .map((agent) => agent.name)
        .sort(),
    ).toEqual(['client-agent', 'shared-agent']);
  });

  it('never offers a scoped plugin agent to the Codex and OpenCode mirrors', () => {
    fs.mkdirSync(path.join(TEST_ROOT, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(TEST_ROOT, 'data', 'plugin-scopes.json'),
      JSON.stringify({ version: 1, plugins: { 'client-plugin': ['client-wg'] } }),
    );
    expect(discoverClaudeSubagents().map((agent) => agent.name)).toEqual(['shared-agent']);
  });
});
