import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getSession } from '../../db/sessions.js';
import { initSessionFolder, openInboundDb } from '../../session-manager.js';
import { getDeliveryAction } from '../../delivery.js';
import './index.js';

const mocks = vi.hoisted(() => ({
  deliver: vi.fn(),
  wakeContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-bash-gate' };
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer: mocks.wakeContainer,
}));

vi.mock('../../delivery.js', async () => {
  const actual = await vi.importActual<typeof import('../../delivery.js')>('../../delivery.js');
  return {
    ...actual,
    getDeliveryAdapter: () => ({
      deliver: mocks.deliver,
    }),
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-bash-gate';

function now(): string {
  return new Date().toISOString();
}

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function seedSession(): void {
  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'slack-illysium',
    platform_id: 'slack:C123',
    instance: 'slack-illysium',
    name: '#support',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: 'slack:C123:1781317853.356239',
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now(),
    created_at: now(),
  });
  initSessionFolder('ag-1', 'sess-1');
}

async function runDestructiveGate(label: string, requestId: string): Promise<void> {
  const handler = getDeliveryAction('request_destructive_gate');
  const session = getSession('sess-1');
  expect(handler).toBeDefined();
  expect(session).toBeDefined();
  const inDb = openInboundDb('ag-1', 'sess-1');
  try {
    await handler!(
      {
        requestId,
        label,
        summary: 'The agent wants to run a destructive command.',
        command:
          'CREATE OR REPLACE PROCEDURE XZO_PLATFORM.MASTER._LONG_TEST_SP() RETURNS STRING LANGUAGE SQL AS $$ SELECT 1; $$',
      },
      session!,
      inDb,
    );
  } finally {
    inDb.close();
  }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  seedSession();
  mocks.deliver.mockReset();
  mocks.wakeContainer.mockReset();
  mocks.wakeContainer.mockResolvedValue(undefined);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('bash destructive gate delivery', () => {
  it('caps long destructive gate titles before Slack Block Kit delivery', async () => {
    mocks.deliver.mockResolvedValue('slack-msg-1');

    await runDestructiveGate(
      'Destructive Snowflake SQL detected (CREATE OR REPLACE) — CREATE OR REPLACE PROCEDURE XZO_PLATFORM.MASTER._VERY_LONG_PROCEDURE_NAME_FOR_APPROVAL_CARD_LIMIT_REGRESSION() RETURNS STRING LANGUAGE SQL AS $$',
      'gate-long-title',
    );

    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    const content = JSON.parse(mocks.deliver.mock.calls[0][4] as string) as { title: string };
    expect(Array.from(content.title).length).toBeLessThanOrEqual(140);
    expect(content.title).toMatch(/…$/);

    const pending = getDb()
      .prepare('SELECT title, platform_message_id FROM pending_approvals WHERE request_id = ?')
      .get('gate-long-title') as { title: string; platform_message_id: string } | undefined;
    expect(pending?.title).toBe(content.title);
    expect(pending?.platform_message_id).toBe('slack-msg-1');
  });

  it('caps destructive gate titles without splitting emoji code points', async () => {
    mocks.deliver.mockResolvedValue('slack-msg-emoji');

    await runDestructiveGate(`${'A'.repeat(135)}🚨 tail`, 'gate-emoji-title');

    const content = JSON.parse(mocks.deliver.mock.calls[0][4] as string) as { title: string };
    const codePoints = Array.from(content.title);
    expect(codePoints.length).toBeLessThanOrEqual(140);
    expect(codePoints.at(-2)).toBe('🚨');
    expect(codePoints.at(-1)).toBe('…');
    expect(hasLoneSurrogate(content.title)).toBe(false);
  });

  it('fails the gate ack immediately when approval-card delivery throws', async () => {
    mocks.deliver.mockRejectedValue(new Error('An API error occurred: invalid_blocks'));

    await runDestructiveGate(
      'Destructive Snowflake SQL detected (CREATE OR REPLACE) — CREATE OR REPLACE PROCEDURE XZO_PLATFORM.MASTER._VERY_LONG_PROCEDURE_NAME_FOR_APPROVAL_CARD_LIMIT_REGRESSION() RETURNS STRING LANGUAGE SQL AS $$',
      'gate-delivery-fail',
    );

    const pendingCount = (
      getDb()
        .prepare('SELECT COUNT(*) AS count FROM pending_approvals WHERE request_id = ?')
        .get('gate-delivery-fail') as { count: number }
    ).count;
    expect(pendingCount).toBe(0);

    const inDb = openInboundDb('ag-1', 'sess-1');
    try {
      const ack = inDb
        .prepare('SELECT status, error FROM delivered WHERE message_out_id = ?')
        .get('gate-delivery-fail') as { status: string; error: string } | undefined;
      expect(ack).toEqual({
        status: 'failed',
        error: 'destructive-gate delivery failed: approval request could not be posted.',
      });
    } finally {
      inDb.close();
    }
  });
});
