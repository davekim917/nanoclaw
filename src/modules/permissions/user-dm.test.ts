/**
 * ensureUserDm privacy-safe logging (T4 PR 4, ported from upstream 1ecb952f4).
 *
 * Re-derived for the fork's shape: `ensureUserDm`'s log calls carry extra
 * `instance`/`cachedInstance` fields upstream's don't have (the fork's
 * multi-instance support), so the privacy-safe assertions check the fork's
 * ACTUAL shapes rather than upstream's plainer ones — `instance` is an
 * adapter identifier, not user identity, so it stays in both branches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import type { ChannelAdapter } from '../../channels/adapter.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { closeDb, getDb, initMigratedTestDb } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { createUser } from './db/users.js';
import { upsertUserDm } from './db/user-dms.js';
import { ensureUserDm } from './user-dm.js';

function now(): string {
  return new Date().toISOString();
}

async function seedUser(id: string, kind: string): Promise<void> {
  await createUser({ id, kind, display_name: null, created_at: now() });
}

function registerTestAdapter(channelType: string, openDM?: (handle: string) => Promise<string>): void {
  const adapter: ChannelAdapter = {
    name: channelType,
    channelType,
    supportsThreads: false,
    async setup() {},
    async teardown() {},
    isConnected: () => true,
    async deliver() {
      return undefined;
    },
  };
  if (openDM) adapter.openDM = openDM;
  registerChannelAdapter(channelType, { factory: () => adapter });
}

async function startRegisteredAdapters(): Promise<void> {
  await initChannelAdapters(() => ({
    conversations: [],
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

beforeEach(async () => {
  vi.clearAllMocks();
  await initMigratedTestDb();
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
});

describe('ensureUserDm privacy-safe logging', () => {
  it('preserves the existing detailed log shape by default', async () => {
    const failure = new Error('default-sdk-error-sentinel');
    registerTestAdapter('legacy-default', async () => {
      throw failure;
    });
    await startRegisteredAdapters();
    await seedUser('legacy-default:default-handle-sentinel', 'legacy-default');

    await expect(ensureUserDm('legacy-default:default-handle-sentinel')).resolves.toBeNull();

    expect(log.error).toHaveBeenCalledWith('ensureUserDm: adapter.openDM failed', {
      channelType: 'legacy-default',
      handle: 'default-handle-sentinel',
      err: failure,
    });
  });

  it('omits identities, messaging-group ids and platform errors when requested', async () => {
    registerTestAdapter('privacy-error', async () => {
      throw new Error('private-sdk-error-sentinel');
    });
    registerTestAdapter('privacy-direct');
    await startRegisteredAdapters();

    await seedUser('privacy-error:private-handle-sentinel', 'privacy-error');
    await seedUser('privacy-direct:stale-handle-sentinel', 'privacy-direct');
    await seedUser('invalid-user-private-sentinel', 'invalid-kind');

    await createMessagingGroup({
      id: 'messaging-group-private-sentinel',
      channel_type: 'privacy-direct',
      platform_id: 'old-platform-private-sentinel',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await upsertUserDm({
      user_id: 'privacy-direct:stale-handle-sentinel',
      channel_type: 'privacy-direct',
      messaging_group_id: 'messaging-group-private-sentinel',
      resolved_at: now(),
    });
    // Orphan the cache row (bypassing FK) to exercise the "cached row
    // references missing messaging_group" re-resolve path.
    const db = getDb();
    await db.exec('PRAGMA foreign_keys = OFF');
    await db.run("DELETE FROM messaging_groups WHERE id = 'messaging-group-private-sentinel'");
    await db.exec('PRAGMA foreign_keys = ON');

    const options = { privacySafeLogs: true };
    await expect(ensureUserDm('unknown-user-private-sentinel', options)).resolves.toBeNull();
    await expect(ensureUserDm('invalid-user-private-sentinel', options)).resolves.toBeNull();
    await expect(ensureUserDm('privacy-error:private-handle-sentinel', options)).resolves.toBeNull();
    await expect(ensureUserDm('privacy-direct:stale-handle-sentinel', options)).resolves.toBeDefined();

    expect(log.error).toHaveBeenCalledWith('ensureUserDm: adapter.openDM failed', {
      channelType: 'privacy-error',
    });
    expect(log.warn).toHaveBeenCalledWith('ensureUserDm: user not found', undefined);
    expect(log.warn).toHaveBeenCalledWith('ensureUserDm: user id not namespaced', undefined);
    expect(log.warn).toHaveBeenCalledWith('ensureUserDm: cached row references missing messaging_group, re-resolving', {
      channelType: 'privacy-direct',
    });
    // Fork-specific: `instance` stays in the privacy-safe shape too — it
    // names an adapter, not a user, and unaddressed creates fall back to
    // channel_type.
    expect(log.info).toHaveBeenCalledWith('ensureUserDm: created DM messaging_group', {
      channelType: 'privacy-direct',
      instance: 'privacy-direct',
    });

    const serializedLogs = JSON.stringify({
      info: vi.mocked(log.info).mock.calls,
      warn: vi.mocked(log.warn).mock.calls,
      error: vi.mocked(log.error).mock.calls,
    });
    for (const sentinel of [
      'unknown-user-private-sentinel',
      'invalid-user-private-sentinel',
      'private-handle-sentinel',
      'stale-handle-sentinel',
      'messaging-group-private-sentinel',
      'old-platform-private-sentinel',
      'private-sdk-error-sentinel',
    ]) {
      expect(serializedLogs).not.toContain(sentinel);
    }
  });

  // T4 PR4 (§5 case 10): privacySafeLogs is a real observability trade — the
  // recommendation was to request it only where a resolution failure would
  // otherwise leak a stranger-facing platform handle: approval delivery
  // (pickApprovalDelivery, both branches) and the dashboard-token-issue DM.
  // Every other caller keeps the default detailed shape.
  it('privacy-safe logs are requested only at approval delivery and the dashboard token issue', async () => {
    const fs2 = await import('node:fs');
    const path = await import('node:path');
    const repoRoot = path.resolve(__dirname, '..', '..', '..');

    function walk(dir: string, out: string[]): void {
      for (const entry of fs2.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        // Non-test source only — a test file asserting `privacySafeLogs:
        // true` in an expectation is not a call site.
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
      }
    }
    const files: string[] = [];
    walk(path.join(repoRoot, 'src'), files);

    const callSites = new Set<string>();
    for (const file of files) {
      const content = fs2.readFileSync(file, 'utf8');
      if (content.includes('privacySafeLogs: true')) {
        callSites.add(path.relative(repoRoot, file).split(path.sep).join('/'));
      }
    }
    expect(callSites).toEqual(
      new Set(['src/modules/approvals/primitive.ts', 'src/dashboard/auth/dashboard-token-issue.ts']),
    );
  });

  it('the failure branches next to each privacy-safe call stay handle-free (#480 round 2)', async () => {
    const fs2 = await import('node:fs');
    const path = await import('node:path');
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const dashboard = fs2.readFileSync(path.join(repoRoot, 'src/dashboard/auth/dashboard-token-issue.ts'), 'utf8');
    const onecli = fs2.readFileSync(path.join(repoRoot, 'src/modules/approvals/onecli-approvals.ts'), 'utf8');
    // The warn that follows a null ensureUserDm must not log the invoker.
    expect(/refusing to mint'[\s\S]{0,300}?\}\);/.exec(dashboard)?.[0]).not.toMatch(/userId/);
    // The OneCLI auto-deny must log a count, never the approver handles.
    expect(/no DM channel for any approver'[\s\S]{0,300}?\}\);/.exec(onecli)?.[0]).not.toMatch(/\bapprovers,/);
  });
});
