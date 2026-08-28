import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process so runCodexLoginAuth never spawns a real codex CLI; the
// spawn stand-in plays `codex login` writing auth.json into whatever
// CODEX_HOME it was handed.
const mockSpawn = vi.fn();
const mockSpawnSync = vi.fn();
const mockExecFileSync = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

// Keep the auth flow's structured logging out of logs/setup.log.
vi.mock('../logs.js', () => ({ step: vi.fn(), userInput: vi.fn() }));
vi.mock('../lib/bright-select.js', () => ({ brightSelect: vi.fn() }));
vi.mock('@clack/prompts', async () => {
  const actual = await vi.importActual<typeof import('@clack/prompts')>('@clack/prompts');
  return { ...actual, confirm: vi.fn() };
});

import { confirm } from '@clack/prompts';
import { brightSelect } from '../lib/bright-select.js';
import {
  buildCodexFailurePrompt,
  hasCodexCredentialRoute,
  runCodexAuthStep,
  runCodexLoginAuth,
  verifyCodexInstall,
} from './codex.js';

const mockBrightSelect = vi.mocked(brightSelect);
const mockConfirm = vi.mocked(confirm);

beforeEach(() => {
  mockSpawn.mockReset();
  mockSpawnSync.mockReset();
  mockExecFileSync.mockReset();
  mockBrightSelect.mockReset();
  mockConfirm.mockReset();
});

describe('hasCodexCredentialRoute', () => {
  it.each([
    [
      'a generic secret merely named Codex',
      { name: 'Codex', type: 'generic', hostPattern: 'api.anthropic.com' },
      false,
    ],
    ['an OpenAI-typed secret without a route', { name: 'unrelated', type: 'openai', hostPattern: null }, false],
    ['an endpoint lookalike', { name: 'OpenAI', type: 'openai', hostPattern: 'api.openai.com.evil.example' }, false],
    ['an API-key route', { name: 'Codex', type: 'openai', hostPattern: 'api.openai.com' }, true],
    ['a ChatGPT OAuth route', { name: 'OpenAI', type: 'openai', hostPattern: 'chatgpt.com' }, true],
    ['a generic but correctly routed secret', { name: 'custom', type: 'generic', hostPattern: 'API.OPENAI.COM' }, true],
  ] as const)('%s', (_caseName, fields, expected) => {
    expect(hasCodexCredentialRoute({ id: 'secret-id', ...fields })).toBe(expected);
  });
});

describe('runCodexAuthStep vault detection', () => {
  const listedSecrets = (data: unknown[]) => JSON.stringify({ data });

  it.each([
    ['a generic secret named Codex', { name: 'Codex', type: 'generic', hostPattern: 'api.anthropic.com' }],
    ['an OpenAI-typed secret with no route', { name: 'OpenAI', type: 'openai', hostPattern: null }],
    ['no vault secret', undefined],
  ] as const)('continues setup for %s', async (_caseName, secret) => {
    mockExecFileSync.mockReturnValue(listedSecrets(secret === undefined ? [] : [{ id: 'secret-id', ...secret }]));
    mockBrightSelect.mockResolvedValue('skip');
    mockConfirm.mockResolvedValue(true);

    await runCodexAuthStep();

    expect(mockBrightSelect).toHaveBeenCalledOnce();
  });

  it.each([
    ['an API-key endpoint route', { name: 'Codex', type: 'openai', hostPattern: 'api.openai.com' }],
    ['a ChatGPT OAuth endpoint route', { name: 'OpenAI', type: 'openai', hostPattern: 'chatgpt.com' }],
  ] as const)('skips setup for %s', async (_caseName, secret) => {
    mockExecFileSync.mockReturnValue(listedSecrets([{ id: 'secret-id', ...secret }]));

    await runCodexAuthStep();

    expect(mockBrightSelect).not.toHaveBeenCalled();
  });
});

// Structural guard for the codex payload wiring: provider files, both barrel
// imports, and the pinned Dockerfile install. Goes red if any of them is
// removed without going through the /add-codex (or its REMOVE.md) path.
describe('verifyCodexInstall', () => {
  it('passes on a tree with the codex payload wired', () => {
    const { ok, problems } = verifyCodexInstall();
    expect(problems).toEqual([]);
    expect(ok).toBe(true);
  });

  it('accepts any exact numeric Codex pin consumed by the global install', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-exact-pin-'));
    try {
      for (const file of [
        'src/providers/codex.ts',
        'container/agent-runner/src/providers/codex.ts',
        'container/agent-runner/src/providers/codex-app-server.ts',
      ]) {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, '');
      }
      for (const barrel of [
        'src/providers/index.ts',
        'container/agent-runner/src/providers/index.ts',
        'setup/providers/index.ts',
      ]) {
        const target = path.join(root, barrel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "import './codex.js';\n");
      }
      fs.mkdirSync(path.join(root, 'container'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'container/Dockerfile'),
        'FROM node:22\nARG CODEX_VERSION=0.151.0\nRUN pnpm add -g "@openai/codex@${CODEX_VERSION}"\n',
      );

      expect(verifyCodexInstall(root)).toEqual({ ok: true, problems: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the last Codex pin declared before the consuming install', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-effective-pin-'));
    try {
      for (const file of [
        'src/providers/codex.ts',
        'container/agent-runner/src/providers/codex.ts',
        'container/agent-runner/src/providers/codex-app-server.ts',
      ]) {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, '// present\n');
      }
      for (const barrel of [
        'src/providers/index.ts',
        'container/agent-runner/src/providers/index.ts',
        'setup/providers/index.ts',
      ]) {
        const target = path.join(root, barrel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "import './codex.js';\n");
      }
      fs.mkdirSync(path.join(root, 'container'), { recursive: true });
      const dockerfile = path.join(root, 'container/Dockerfile');

      fs.writeFileSync(
        dockerfile,
        'FROM node:22\nARG CODEX_VERSION=0.150.1\nARG CODEX_VERSION=latest\nRUN pnpm add -g "@openai/codex@${CODEX_VERSION}"\n',
      );
      expect(verifyCodexInstall(root).problems).toEqual([
        'container/Dockerfile missing an exact numeric ARG CODEX_VERSION pin',
      ]);

      fs.writeFileSync(
        dockerfile,
        'FROM node:22\nARG CODEX_VERSION=latest\nARG CODEX_VERSION=0.150.1\nRUN pnpm add -g "@openai/codex@${CODEX_VERSION}"\n',
      );
      expect(verifyCodexInstall(root)).toEqual({ ok: true, problems: [] });

      fs.writeFileSync(
        dockerfile,
        [
          'FROM node:22',
          'ARG CODEX_VERSION=0.150.1',
          'RUN pnpm add -g "@openai/codex@${CODEX_VERSION}"',
          'ARG CODEX_VERSION=latest',
          'RUN pnpm add -g "@openai/codex@${CODEX_VERSION}"',
          '',
        ].join('\n'),
      );
      expect(verifyCodexInstall(root).problems).toEqual([
        'container/Dockerfile missing an exact numeric ARG CODEX_VERSION pin',
      ]);

      fs.writeFileSync(
        dockerfile,
        [
          'FROM node:22',
          'ARG CODEX_VERSION=0.150.1',
          'ARG CODEX_VERSION=latest',
          'RUN pnpm add -g "@openai/codex@${CODEX_VERSION}"',
          'ARG CODEX_VERSION=0.150.1',
          '# documentation only: "@openai/codex@${CODEX_VERSION}"',
          '',
        ].join('\n'),
      );
      expect(verifyCodexInstall(root).problems).toEqual([
        'container/Dockerfile missing an exact numeric ARG CODEX_VERSION pin',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when only a global ARG precedes the consuming stage', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-global-arg-'));
    try {
      for (const file of [
        'src/providers/codex.ts',
        'container/agent-runner/src/providers/codex.ts',
        'container/agent-runner/src/providers/codex-app-server.ts',
      ]) {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, '');
      }
      for (const barrel of [
        'src/providers/index.ts',
        'container/agent-runner/src/providers/index.ts',
        'setup/providers/index.ts',
      ]) {
        const target = path.join(root, barrel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "import './codex.js';\n");
      }
      fs.mkdirSync(path.join(root, 'container'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'container/Dockerfile'),
        'ARG CODEX_VERSION=0.151.0\nFROM node:22\nRUN pnpm add -g "@openai/codex@${CODEX_VERSION}"\n',
      );

      expect(verifyCodexInstall(root).problems).toEqual([
        'container/Dockerfile missing an exact numeric ARG CODEX_VERSION pin',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when only a CLI manifest claims Codex is installed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-verify-'));
    try {
      for (const file of [
        'src/providers/codex.ts',
        'container/agent-runner/src/providers/codex.ts',
        'container/agent-runner/src/providers/codex-app-server.ts',
      ]) {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, '');
      }
      for (const barrel of [
        'src/providers/index.ts',
        'container/agent-runner/src/providers/index.ts',
        'setup/providers/index.ts',
      ]) {
        const target = path.join(root, barrel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "import './codex.js';\n");
      }
      fs.mkdirSync(path.join(root, 'container'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'container', 'cli-tools.json'),
        '[{"name":"@openai/codex","version":"0.145.0"}]\n',
      );
      fs.writeFileSync(path.join(root, 'container', 'Dockerfile'), 'FROM debian:stable\n');

      const { ok, problems } = verifyCodexInstall(root);
      expect(ok).toBe(false);
      expect(problems).toContain('container/Dockerfile missing an exact numeric ARG CODEX_VERSION pin');
      expect(problems).toContain('container/Dockerfile missing the pinned @openai/codex install');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['latest', '^0.150.1', '0.150'])('fails closed when the Codex pin is not an exact release (%s)', (pin) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-pin-'));
    try {
      for (const file of [
        'src/providers/codex.ts',
        'container/agent-runner/src/providers/codex.ts',
        'container/agent-runner/src/providers/codex-app-server.ts',
      ]) {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, '');
      }
      for (const barrel of [
        'src/providers/index.ts',
        'container/agent-runner/src/providers/index.ts',
        'setup/providers/index.ts',
      ]) {
        const target = path.join(root, barrel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "import './codex.js';\n");
      }
      fs.mkdirSync(path.join(root, 'container'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'container', 'Dockerfile'),
        `FROM node:22\nARG CODEX_VERSION=${pin}\nRUN pnpm add -g "@openai/codex@\${CODEX_VERSION}"\n`,
      );

      const { ok, problems } = verifyCodexInstall(root);
      expect(ok).toBe(false);
      expect(problems).toEqual(['container/Dockerfile missing an exact numeric ARG CODEX_VERSION pin']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when an exact Codex pin is not consumed by the global install', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-unconsumed-'));
    try {
      for (const file of [
        'src/providers/codex.ts',
        'container/agent-runner/src/providers/codex.ts',
        'container/agent-runner/src/providers/codex-app-server.ts',
      ]) {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, '');
      }
      for (const barrel of [
        'src/providers/index.ts',
        'container/agent-runner/src/providers/index.ts',
        'setup/providers/index.ts',
      ]) {
        const target = path.join(root, barrel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "import './codex.js';\n");
      }
      fs.mkdirSync(path.join(root, 'container'), { recursive: true });
      fs.writeFileSync(path.join(root, 'container/Dockerfile'), 'FROM node:22\nARG CODEX_VERSION=0.150.1\n');

      expect(verifyCodexInstall(root).problems).toEqual([
        'container/Dockerfile missing the pinned @openai/codex install',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// Pure prompt builder for the failure-assist hook — no spawning involved.
describe('buildCodexFailurePrompt', () => {
  it('carries the failure context and the de-duped reference list', () => {
    const projectRoot = '/repo';
    const prompt = buildCodexFailurePrompt(
      {
        stepName: 'verify',
        msg: 'first-chat ping timed out',
        hint: 'check the container logs',
        rawLogPath: '/repo/logs/setup-steps/verify.log',
      },
      projectRoot,
    );

    expect(prompt).toContain('Failed step: verify');
    expect(prompt).toContain('Error: first-chat ping timed out');
    expect(prompt).toContain('Hint: check the container logs');
    expect(prompt).toContain('README.md'); // BIG_PICTURE_FILES
    expect(prompt).toContain('setup/verify.ts'); // STEP_FILES['verify']
    expect(prompt).toContain('logs/setup.log');
    expect(prompt).toContain('logs/setup-steps/verify.log'); // relativized rawLogPath
  });

  it('falls back to the step-log directory when no raw log path is given', () => {
    const prompt = buildCodexFailurePrompt({ stepName: 'verify', msg: 'boom' }, '/repo');
    expect(prompt).toContain('logs/setup-steps/');
    expect(prompt).not.toContain('Hint:');
  });
});

// Session-isolation invariant: the ChatGPT session vaulted for the gateway
// must never be the user's personal ~/.codex session — sharing one OAuth
// session across two consumers gets the whole family invalidated server-side
// when refresh tokens rotate (see the header of codex.ts).
describe('runCodexLoginAuth', () => {
  it('logs in under an isolated CODEX_HOME, vaults from it, and deletes it', async () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    mockExecFileSync.mockReturnValue('');

    let loginEnv: NodeJS.ProcessEnv | undefined;
    mockSpawn.mockImplementation((...args: unknown[]) => {
      const opts = args[2] as { env?: NodeJS.ProcessEnv };
      loginEnv = opts.env;
      fs.writeFileSync(path.join(opts.env!.CODEX_HOME!, 'auth.json'), '{"tokens":{}}');
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });

    await runCodexLoginAuth('browser');

    // The login spawn ran under a CODEX_HOME that is not the personal one.
    const codexHome = loginEnv?.CODEX_HOME;
    expect(codexHome).toBeDefined();
    expect(codexHome).not.toBe(path.join(os.homedir(), '.codex'));

    // The vault snapshot was read from the isolated dir, not ~/.codex.
    const vaultCall = mockExecFileSync.mock.calls.find((c) => c[0] === 'onecli');
    expect(vaultCall).toBeDefined();
    const vaultArgs = vaultCall![1] as string[];
    expect(vaultArgs[vaultArgs.indexOf('--file') + 1]).toBe(path.join(codexHome!, 'auth.json'));

    // The isolated dir holds a live credential — gone once vaulted.
    expect(fs.existsSync(codexHome!)).toBe(false);
  });
});
