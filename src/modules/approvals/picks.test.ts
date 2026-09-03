/**
 * Tests for pickApprover + pickApprovalDelivery — the approver-selection
 * half of what used to live in src/access.ts. Moved here in PR #7 alongside
 * the approvals re-tier.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import type { ChannelAdapter, OutboundMessage } from '../../channels/adapter.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { pickApprovalDelivery, pickApprover } from './primitive.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(async () => {
  await teardownChannelAdapters();
  closeDb();
});

async function mountMockAdapter(
  channelType: string,
  openDM?: (handle: string) => Promise<string>,
): Promise<{ delivered: OutboundMessage[]; openDMCalls: string[] }> {
  const delivered: OutboundMessage[] = [];
  const openDMCalls: string[] = [];
  const adapter: ChannelAdapter = {
    name: channelType,
    channelType,
    supportsThreads: false,
    async setup() {},
    async teardown() {},
    isConnected() {
      return true;
    },
    async deliver(_platformId, _threadId, message) {
      delivered.push(message);
      return undefined;
    },
    async setTyping() {},
  };
  if (openDM) {
    adapter.openDM = async (handle: string) => {
      openDMCalls.push(handle);
      return openDM(handle);
    };
  }
  registerChannelAdapter(channelType, { factory: () => adapter });
  await initChannelAdapters(() => ({
    conversations: [],
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  return { delivered, openDMCalls };
}

function seedAgentGroup(id: string): void {
  createAgentGroup({
    id,
    name: id.toUpperCase(),
    folder: id,
    agent_provider: null,
    created_at: now(),
  });
}

function seedUser(id: string, kind: string): void {
  createUser({ id, kind, display_name: null, created_at: now() });
}

describe('pickApprover', () => {
  beforeEach(() => {
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
  });

  it('prefers scoped admins, then globals, then owners — deduplicated', () => {
    seedUser('u-owner', 'telegram');
    seedUser('u-ga', 'telegram');
    seedUser('u-sa', 'telegram');
    grantRole({ user_id: 'u-owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    grantRole({ user_id: 'u-ga', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
    grantRole({ user_id: 'u-sa', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });

    expect(pickApprover('ag-1')).toEqual(['u-sa', 'u-ga', 'u-owner']);
    expect(pickApprover('ag-2')).toEqual(['u-ga', 'u-owner']);
    expect(pickApprover(null)).toEqual(['u-ga', 'u-owner']);
  });

  it('returns empty list when nobody is privileged', () => {
    expect(pickApprover('ag-1')).toEqual([]);
  });
});

describe('pickApprovalDelivery', () => {
  beforeEach(() => {
    seedAgentGroup('ag-1');
  });

  it('returns the first reachable approver', async () => {
    await mountMockAdapter('telegram');
    seedUser('telegram:111', 'telegram');
    seedUser('telegram:222', 'telegram');

    const result = await pickApprovalDelivery(['telegram:111', 'telegram:222'], 'telegram');
    expect(result?.userId).toBe('telegram:111');
    expect(result?.messagingGroup.platform_id).toBe('111');
  });

  it('prefers same-channel-kind approver on tie-break', async () => {
    await mountMockAdapter('telegram');
    await mountMockAdapter('discord', async (h) => `dm-${h}`);
    seedUser('telegram:111', 'telegram');
    seedUser('discord:222', 'discord');

    const result = await pickApprovalDelivery(['telegram:111', 'discord:222'], 'discord');
    expect(result?.userId).toBe('discord:222');
  });

  it('falls through to any reachable approver when none match origin', async () => {
    await mountMockAdapter('telegram');
    seedUser('telegram:111', 'telegram');

    const result = await pickApprovalDelivery(['telegram:111'], 'discord');
    expect(result?.userId).toBe('telegram:111');
  });

  it('returns null when nobody is reachable', async () => {
    seedUser('telegram:111', 'telegram');
    expect(await pickApprovalDelivery(['telegram:111'], 'telegram')).toBeNull();
  });

  it('sameChannelTypeOnly=true: refuses cross-channel-type fallback', async () => {
    // Approver registered on telegram only; origin is discord. Default
    // behavior falls back to telegram; strict mode returns null instead.
    await mountMockAdapter('telegram');
    seedUser('telegram:111', 'telegram');

    const defaultResult = await pickApprovalDelivery(['telegram:111'], 'discord');
    expect(defaultResult?.userId).toBe('telegram:111');

    const strictResult = await pickApprovalDelivery(['telegram:111'], 'discord', {
      sameChannelTypeOnly: true,
    });
    expect(strictResult).toBeNull();
  });

  it('resolves the approver\'s channel kind, not the raw id prefix (Teams `29:`)', async () => {
    // Teams user ids carry a Bot Framework `29:` prefix, not `teams:`.
    // Splitting the id on the first `:` reads `29`, which never equals a
    // `teams` origin channel_type, so the only reachable owner was skipped
    // before ensureUserDm was called — and with sameChannelTypeOnly the whole
    // function returned null.
    const { openDMCalls } = await mountMockAdapter('teams', async (h) => `dm-${h}`);
    seedUser('29:aad-owner-guid', 'teams');

    const result = await pickApprovalDelivery(['29:aad-owner-guid'], 'teams', {
      sameChannelTypeOnly: true,
    });

    expect(result?.userId).toBe('29:aad-owner-guid');
    expect(result?.messagingGroup.channel_type).toBe('teams');
    // parseUserId hands the FULL id to openDM for this shape — the `29:` is
    // part of the handle, not a namespace to strip.
    expect(openDMCalls).toEqual(['29:aad-owner-guid']);
  });

  it('keeps a prefix-shaped approver off a foreign origin under sameChannelTypeOnly', async () => {
    // The kind fallback must not become "any registered user matches any
    // origin": a telegram approver stays unreachable from a teams origin.
    await mountMockAdapter('teams', async (h) => `dm-${h}`);
    await mountMockAdapter('telegram');
    seedUser('telegram:111', 'telegram');

    expect(await pickApprovalDelivery(['telegram:111'], 'teams', { sameChannelTypeOnly: true })).toBeNull();
  });

  it('sameChannelTypeOnly=true: still returns in-workspace approver when one exists', async () => {
    await mountMockAdapter('discord', async (h) => `dm-${h}`);
    await mountMockAdapter('telegram');
    seedUser('discord:222', 'discord');
    seedUser('telegram:111', 'telegram');

    const result = await pickApprovalDelivery(['telegram:111', 'discord:222'], 'discord', {
      sameChannelTypeOnly: true,
    });
    expect(result?.userId).toBe('discord:222');
  });
});
