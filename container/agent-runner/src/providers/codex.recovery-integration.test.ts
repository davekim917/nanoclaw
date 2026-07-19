import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, initTestSessionDb } from '../db/connection.js';
import { CodexProvider } from './codex.js';

const ORIGINAL_ENV = {
  PATH: process.env.PATH,
  CODEX_HOME: process.env.CODEX_HOME,
  CODEX_HEALTH_PROBE_QUIET_MS: process.env.CODEX_HEALTH_PROBE_QUIET_MS,
  CODEX_HEALTH_PROBE_INTERVAL_MS: process.env.CODEX_HEALTH_PROBE_INTERVAL_MS,
  CODEX_HEALTH_PROBE_TIMEOUT_MS: process.env.CODEX_HEALTH_PROBE_TIMEOUT_MS,
  CODEX_HEALTH_PROBE_FAILURE_LIMIT: process.env.CODEX_HEALTH_PROBE_FAILURE_LIMIT,
  CODEX_INACTIVE_SNAPSHOT_LIMIT: process.env.CODEX_INACTIVE_SNAPSHOT_LIMIT,
  CODEX_HEALTH_STILL_WORKING_NOTICE_MS: process.env.CODEX_HEALTH_STILL_WORKING_NOTICE_MS,
  FAKE_CODEX_STATE: process.env.FAKE_CODEX_STATE,
  FAKE_CODEX_LOG: process.env.FAKE_CODEX_LOG,
  FAKE_CODEX_FAILURE_MODE: process.env.FAKE_CODEX_FAILURE_MODE,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

let tmpDir = '';

beforeEach(() => {
  initTestSessionDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-recovery-'));
});

afterEach(() => {
  closeSessionDb();
  restoreEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CodexProvider app-server-only recovery', () => {
  for (const scenario of [
    {
      failureMode: 'unresponsive',
      title:
        'replaces an unresponsive app-server, resumes the same thread, and continues without duplicating the prompt',
    },
    {
      failureMode: 'unfinished-command',
      title:
        'replaces an app-server that completes with an unfinished command and resumes without duplicating the prompt',
    },
  ] as const) {
    it(
      scenario.title,
      async () => {
        const binDir = path.join(tmpDir, 'bin');
        const codexHome = path.join(tmpDir, 'codex-home');
        const statePath = path.join(tmpDir, 'spawn-count');
        const logPath = path.join(tmpDir, 'requests.jsonl');
        fs.mkdirSync(binDir, { recursive: true });
        fs.mkdirSync(codexHome, { recursive: true });

        const fakeCodexPath = path.join(binDir, 'codex');
        fs.writeFileSync(
          fakeCodexPath,
          `#!/usr/bin/env bun
import fs from 'fs';
import readline from 'readline';

const statePath = process.env.FAKE_CODEX_STATE;
const logPath = process.env.FAKE_CODEX_LOG;
const failureMode = process.env.FAKE_CODEX_FAILURE_MODE;
const previous = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, 'utf8')) : 0;
const instance = previous + 1;
fs.writeFileSync(statePath, String(instance));

const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const log = (value) => fs.appendFileSync(logPath, JSON.stringify({ instance, ...value }) + '\\n');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  log({ method: request.method, params: request.params });
  if (request.method === 'initialize') {
    send({ id: request.id, result: { userAgent: 'fake-codex' } });
    return;
  }
  if (request.method === 'thread/start') {
    send({ id: request.id, result: { thread: { id: 'thread-1', status: { type: 'idle' } } } });
    return;
  }
  if (request.method === 'thread/resume') {
    send({ id: request.id, result: { thread: { id: 'thread-1', status: { type: 'idle' } } } });
    return;
  }
  if (request.method === 'turn/start') {
    send({ id: request.id, result: { turn: { id: 'turn-' + instance } } });
    send({ method: 'turn/started', params: { turnId: 'turn-' + instance } });
    if (instance === 1 && failureMode === 'unfinished-command') {
      setTimeout(() => {
        send({ method: 'item/started', params: { item: { id: 'command-1', type: 'commandExecution' } } });
        send({ method: 'turn/completed', params: { status: 'completed' } });
      }, 5);
    }
    if (instance > 1) {
      setTimeout(() => {
        send({ method: 'item/agentMessage/delta', params: { delta: 'recovered result' } });
        send({ method: 'turn/completed', params: { status: 'completed' } });
      }, 5);
    }
    return;
  }
  if (request.method === 'thread/read') {
    if (instance > 1) send({ id: request.id, result: { thread: { status: { type: 'active' } } } });
    return;
  }
  if (request.method === 'thread/list') {
    send({ id: request.id, result: { data: [] } });
    return;
  }
  if (request.method === 'turn/interrupt') {
    send({ id: request.id, result: {} });
  }
});
`,
          { mode: 0o755 },
        );

        process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
        process.env.CODEX_HOME = codexHome;
        process.env.FAKE_CODEX_STATE = statePath;
        process.env.FAKE_CODEX_LOG = logPath;
        process.env.FAKE_CODEX_FAILURE_MODE = scenario.failureMode;
        process.env.CODEX_HEALTH_PROBE_QUIET_MS = '5';
        process.env.CODEX_HEALTH_PROBE_INTERVAL_MS = '5';
        process.env.CODEX_HEALTH_PROBE_TIMEOUT_MS = '5';
        process.env.CODEX_HEALTH_PROBE_FAILURE_LIMIT = '2';
        process.env.CODEX_INACTIVE_SNAPSHOT_LIMIT = '2';
        process.env.CODEX_HEALTH_STILL_WORKING_NOTICE_MS = '1000';

        const provider = new CodexProvider({ providerConfig: { reasoning_effort: 'ultra' } });
        const query = provider.query({ prompt: 'perform the original task once', cwd: tmpDir });
        const events: Array<{ type: string; text?: string | null; message?: string }> = [];
        for await (const event of query.events) {
          events.push(event);
          if (event.type === 'result') query.end();
        }

        expect(fs.readFileSync(statePath, 'utf8')).toBe('2');
        expect(
          events.some((event) => event.type === 'progress' && event.message?.includes('restarting app-server')),
        ).toBe(true);
        expect(events.find((event) => event.type === 'result')).toMatchObject({
          type: 'result',
          text: 'recovered result',
        });
        expect(events.some((event) => event.type === 'error')).toBe(false);

        const requests = fs
          .readFileSync(logPath, 'utf8')
          .trim()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as { instance: number; method: string; params?: { input?: Array<{ text?: string }> } },
          );
        const starts = requests.filter((request) => request.method === 'turn/start');
        expect(starts).toHaveLength(2);
        expect(starts[0]?.params?.input?.[0]?.text).toBe('perform the original task once');
        expect(starts[1]?.params?.input?.[0]?.text).toContain(
          'Continue the same user request from the persisted thread state',
        );
        expect(starts[1]?.params?.input?.[0]?.text).not.toContain('perform the original task once');
        expect(requests.some((request) => request.instance === 2 && request.method === 'thread/resume')).toBe(true);
      },
      5_000,
    );
  }
});
