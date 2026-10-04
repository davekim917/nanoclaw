/**
 * A crashed local CLI process, driven through the real poll loop with a fallback provider declared.
 *
 * Measured 2026-10-03 13:45Z: a group's Claude CLI died with SIGABRT (reported as exit 134), the loop
 * reported `provider_unavailable`, and the host moved the session to its codex fallback for the next 26 hours
 * while Claude itself was healthy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { _resetConfig, _setConfigForTest } from './config.js';
import { getInboundDb } from './mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from './modules/mailbox/testing.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import type { AgentProvider, AgentQuery, QueryInput } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';

const CRASH = 'Claude Code process exited with code 134. stderr: Claude configuration file not found';

beforeEach(() => {
  initTestSessionDb();
  _setConfigForTest({ provider: 'claude', providerFallback: { provider: 'codex' } });
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-1', 'discord', 'thread-1', ?)`,
    )
    .run(JSON.stringify({ sender: 'Operator', text: 'go' }));
});

afterEach(() => {
  _resetConfig();
  closeSessionDb();
});

/** Crashes on the first `crashes` queries, then answers. */
class CrashingProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  readonly prompts: string[] = [];

  constructor(private readonly crashes: number) {}

  registerMemorySessionHook(): void {}
  isSessionInvalid(): boolean {
    return false;
  }
  isLocalProcessCrash(err: unknown): boolean {
    return err instanceof Error && err.message === CRASH;
  }

  query(input: QueryInput): AgentQuery {
    this.prompts.push(input.prompt);
    const crash = this.prompts.length <= this.crashes;
    const events = {
      async *[Symbol.asyncIterator]() {
        if (crash) throw new Error(CRASH);
        yield { type: 'init', continuation: 'mock-session-1' } as const;
        yield { type: 'result', text: '<message to="discord-test">answered</message>' } as const;
      },
    };
    return { resolvedModel: 'mock', push() {}, end() {}, events, abort() {} } as AgentQuery;
  }
}

function outRows(): Array<{ kind: string; content: string }> {
  return getUndeliveredMessages().map((m) => ({ kind: m.kind, content: m.content }));
}

function actions(): Array<string | undefined> {
  return outRows()
    .filter((r) => r.kind === 'system')
    .map((r) => (JSON.parse(r.content) as { action?: string }).action);
}

async function runUntil(provider: AgentProvider, predicate: () => boolean): Promise<void> {
  const controller = new AbortController();
  const loop = Promise.race([
    runPollLoop({ provider, providerName: 'claude', cwd: '/tmp', signal: controller.signal }),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out; rows were ${JSON.stringify(outRows())}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  controller.abort();
  await loop.catch(() => {});
}

describe('a crashed provider process does not spend the provider', () => {
  it('replays the batch once on a fresh process with retry provenance and answers', async () => {
    const provider = new CrashingProvider(1);
    await runUntil(provider, () => outRows().some((r) => r.content.includes('answered')));

    expect(provider.prompts).toHaveLength(2);
    expect(provider.prompts[1]).toContain('<runner-retry-provenance>');
    expect(actions()).not.toContain('provider_unavailable');
  });

  it('surfaces a crash that survives the replay as an error, never as a provider outage', async () => {
    const provider = new CrashingProvider(2);
    await runUntil(provider, () => outRows().some((r) => r.kind === 'chat' && r.content.includes('exited with code 134')));

    expect(provider.prompts).toHaveLength(2);
    expect(actions()).not.toContain('provider_unavailable');
  });
});
