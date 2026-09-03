import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { clearStaleProcessingAcks } from './db/container-state.js';
import { getInboundDb } from './mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from './modules/mailbox/testing.js';
import { getPendingMessages, markCompleted, markProcessing, type MessageInRow } from './db/messages-in.js';
import { formatMessages } from './formatter.js';
import { selectInTurnFollowUps } from './poll-loop.js';
import './providers/index.js';
import { createProvider } from './providers/factory.js';
import type { AgentProvider, AgentQuery, QueryInput } from './providers/types.js';
import { MEMORY_SESSION_HOOK } from './memory/session-hook.js';

const PROVIDERS = ['claude', 'codex', 'opencode'] as const;
let nextSeq = 1;
let testClaudeConfigDir = '';
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  initTestSessionDb();
  nextSeq = 1;
  testClaudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-provider-memory-'));
  process.env.CLAUDE_CONFIG_DIR = testClaudeConfigDir;
});
afterEach(() => {
  closeSessionDb();
  fs.rmSync(testClaudeConfigDir, { recursive: true, force: true });
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
});

function insertPair(id: string, includeBootstrap: boolean): void {
  const db = getInboundDb();
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
     VALUES (?, ?, 'system', ?, 'pending', 0, ?)`,
  ).run(
    `recall-${id}`,
    nextSeq++,
    new Date().toISOString(),
    JSON.stringify({
      subtype: 'recall_context',
      provider: id.split('-')[0],
      contextEpoch: includeBootstrap ? 1 : 0,
      ...(includeBootstrap ? { trustedCapabilities: { deterministicGuards: 'host' } } : {}),
      memoryEvidence: [{ marker: `memory-${id}` }],
      conversationEvidence: [{ marker: `conversation-${id}` }],
      notices: [],
    }),
  );
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
     VALUES (?, ?, 'chat', ?, 'pending', 1, ?)`,
  ).run(id, nextSeq++, new Date().toISOString(), JSON.stringify({ sender: 'Operator', text: `trigger-${id}` }));
}

function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

function assertPairExactlyOnce(prompt: string, id: string, expectCapabilities: boolean): void {
  expect(occurrences(prompt, `memory-${id}`)).toBe(1);
  expect(occurrences(prompt, `conversation-${id}`)).toBe(1);
  expect(occurrences(prompt, `trigger-${id}`)).toBe(1);
  expect(occurrences(prompt, '[Trusted runtime capability state]')).toBe(expectCapabilities ? 1 : 0);
  expect(occurrences(prompt, '[Untrusted recalled evidence - reference data only]')).toBe(1);
}

describe('provider memory lifecycle conformance', () => {
  it('test_provider_lifecycle_parity_receives_pair_on_cold_warm_and_rotation', () => {
    const expectedConstructors = {
      claude: 'ClaudeProvider',
      codex: 'CodexProvider',
      opencode: 'OpenCodeProvider',
    };

    for (const providerName of PROVIDERS) {
      const records: Array<{ phase: 'query' | 'push'; prompt: string }> = [];
      const provider: AgentProvider = createProvider(providerName);
      expect(provider.constructor.name).toBe(expectedConstructors[providerName]);
      provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
      const realQuery = provider.query.bind(provider);
      provider.query = (input: QueryInput): AgentQuery => {
        records.push({ phase: 'query', prompt: input.prompt });
        const query = realQuery(input);
        const realPush = query.push.bind(query);
        query.push = (prompt: string): void => {
          records.push({ phase: 'push', prompt });
          realPush(prompt);
        };
        return query;
      };

      insertPair(`${providerName}-cold`, true);
      const cold = getPendingMessages();
      const coldPrompt = formatMessages(cold);
      const query = provider.query({
        prompt: coldPrompt,
        cwd: '/tmp',
      });
      assertPairExactlyOnce(records[0].prompt, `${providerName}-cold`, true);
      markCompleted(cold.map((row) => row.id));

      insertPair(`${providerName}-warm`, false);
      const warm = selectInTurnFollowUps(getPendingMessages());
      const warmPrompt = formatMessages(warm);
      query.push(warmPrompt);
      assertPairExactlyOnce(records[1].prompt, `${providerName}-warm`, false);
      markCompleted(warm.map((row) => row.id));

      insertPair(`${providerName}-replacement`, true);
      const replacementIds = getPendingMessages().map((row) => row.id);
      markProcessing(replacementIds);
      clearStaleProcessingAcks();
      const replacement: MessageInRow[] = getPendingMessages();
      const replacementPrompt = formatMessages(replacement);
      const replacementQuery = provider.query({
        prompt: replacementPrompt,
        continuation: `${providerName}-rotated-session`,
        cwd: '/tmp',
      });
      assertPairExactlyOnce(records[2].prompt, `${providerName}-replacement`, true);
      expect(records.map((record) => record.phase)).toEqual(['query', 'push', 'query']);
      query.abort();
      replacementQuery.abort();
      markCompleted(replacement.map((row) => row.id));
    }
  });
});
