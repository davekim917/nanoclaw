import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getInboundDb } from './mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from './modules/mailbox/testing.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import type { MessageInRow } from './db/messages-in.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';
import { _setUploadTraceSeamsForTest, isUploadTraceCommand, uploadTrace } from './upload-trace.js';
import { clearHermeticityAttempts, hermeticityAttempts } from './test-hermeticity.js';

// Every test here runs against a temp HOME holding one fixture transcript and a
// fake curl: nothing may read the operator's real transcripts or reach Hugging
// Face (#1070). The fake records each call so the tests can assert the URLs.
const FIXTURE = '{"type":"user","message":"fixture transcript"}\n';
let home = '';
let calls: Array<{ args: string[]; input?: string }> = [];
let responses: Array<{ ok: boolean; out: string }> = [];

beforeEach(() => {
  initTestSessionDb();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-trace-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'projects', 'proj'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'projects', 'proj', 'fixture-session.jsonl'), FIXTURE);
  calls = [];
  responses = [];
  _setUploadTraceSeamsForTest({
    homedir: () => home,
    curl: (args, input) => {
      calls.push({ args, input });
      return responses.shift() ?? { ok: false, out: '\n000' };
    },
  });
  clearHermeticityAttempts();
});

afterEach(() => {
  _setUploadTraceSeamsForTest(null);
  closeSessionDb();
  fs.rmSync(home, { recursive: true, force: true });
});

const urls = (): string[] => calls.map((c) => c.args.find((a) => a.startsWith('https://')) ?? '');

describe('uploadTrace (hermetic)', () => {
  it('stops at whoami when not signed in, and never reads past it', () => {
    responses = [{ ok: true, out: '{"error":"Invalid credentials"}\n401' }];
    const text = uploadTrace();
    expect(urls()).toEqual(['https://huggingface.co/api/whoami-v2']);
    expect(text).not.toContain('Uploaded');
    expect(hermeticityAttempts()).toEqual([]);
  });

  it('when signed in, creates the private dataset and commits the fixture transcript', () => {
    responses = [
      { ok: true, out: '{"name":"test-user"}\n200' },
      { ok: true, out: '' },
      { ok: true, out: '' },
    ];
    const text = uploadTrace();
    expect(urls()).toEqual([
      'https://huggingface.co/api/whoami-v2',
      'https://huggingface.co/api/repos/create',
      'https://huggingface.co/api/datasets/test-user/nanoclaw-traces/commit/main',
    ]);
    expect(calls[2]!.input).toContain(Buffer.from(FIXTURE).toString('base64'));
    expect(text).toBe(
      'Uploaded → https://huggingface.co/datasets/test-user/nanoclaw-traces/blob/main/sessions/fixture-session.jsonl',
    );
    expect(hermeticityAttempts()).toEqual([]);
  });

  it('reports no transcript under an empty home, without calling curl', () => {
    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
    expect(uploadTrace()).toBe('No transcript to upload for this session yet.');
    expect(calls).toEqual([]);
  });
});

describe('isUploadTraceCommand', () => {
  const make = (text: unknown) => ({ content: JSON.stringify({ text }) }) as MessageInRow;

  it('matches /upload-trace (case-insensitive, with args)', () => {
    expect(isUploadTraceCommand(make('/upload-trace'))).toBe(true);
    expect(isUploadTraceCommand(make('/UPLOAD-TRACE'))).toBe(true);
    expect(isUploadTraceCommand(make('  /upload-trace now '))).toBe(true);
  });

  it('does not match other text or commands', () => {
    expect(isUploadTraceCommand(make('hello'))).toBe(false);
    expect(isUploadTraceCommand(make('/upload'))).toBe(false);
    expect(isUploadTraceCommand(make('/clear'))).toBe(false);
    expect(isUploadTraceCommand({ content: 'not json' } as MessageInRow)).toBe(false);
  });
});

describe('poll loop — /upload-trace command', () => {
  it('handles the command in the runner, writes a status, skips query', async () => {
    responses = [{ ok: true, out: '{"error":"Invalid credentials"}\n401' }];
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('m-upload-trace', 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ text: '/upload-trace' }));

    // If the provider were ever queried it would emit this — asserting its
    // absence proves the runner intercepted /upload-trace instead of the LLM.
    const provider = new MockProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 5000);

    // Wait for the ack, not just the status row: writeMessageOut is awaited
    // now (upstream's mailbox contract), so the outbound row lands one tick
    // before markCompleted rather than in the same synchronous block.
    await waitFor(() => getUndeliveredMessages().length > 0 && getPendingMessages().length === 0, 5000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    // A status line from uploadTrace() — never the provider's reply.
    const text = JSON.parse(out[0].content).text as string;
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toBe('should not run');

    // Command message was completed (not left pending).
    expect(getPendingMessages()).toHaveLength(0);
    // It went through the fake curl, not the network.
    expect(urls()).toEqual(['https://huggingface.co/api/whoami-v2']);
    expect(hermeticityAttempts()).toEqual([]);

    await loopPromise.catch(() => {});
  });
});

async function runPollLoopWithTimeout(provider: MockProvider, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return Promise.race([
    // The signal must reach the LOOP, not just the race below — without it the
    // loop survives the test as a zombie poller on the shared connection and
    // steals other files' pending rows (found 2026-08-17: it deterministically
    // starved poll-loop.test.ts's merge-scenario tests 30s each).
    runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal }),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
